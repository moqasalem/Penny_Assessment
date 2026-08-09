import { CrRepo } from './cr-repo';
import { ChangeRequest, Budget, PurchaseAgreement, COMMITTEE_DELTA_THRESHOLD, CommitteeVote } from './cr.types';
import { CrStatus, CrAction } from './cr.enums';
import { assertTransition } from './cr-state-machine';
import { computeTotals } from './cr-totals';
import { Errors } from '../common/errors';
import { ReqUser, hasPolicy } from '../common/policy';

/**
 * Orchestrates CR actions. The transition + audit helper is provided; the action methods are
 * STUBS for you to implement (see `../../CANDIDATE_BRIEF.md`). Make the workflow correct, safe,
 * and complete.
 */
export class CrService {
	constructor(
		private readonly repo: CrRepo,
		private readonly agreements: Map<string, PurchaseAgreement>,
		private readonly budgets: Map<string, Budget>,
		// Committee membership used when routing large changes to a vote (Task 3).
		private readonly committeeConfig?: { members: string[]; head: string },
	) {}

	/** Load a CR for this user or throw NOT_FOUND. */
	private getOrThrow(user: ReqUser, id: string): ChangeRequest {
		const cr = this.repo.findOne(user, id);
		if (!cr) throw Errors.notFound(`CR ${id} not found`);
		return cr;
	}

	/** Apply a legal transition and append an immutable audit entry. Provided helper. */
	private transition(cr: ChangeRequest, to: CrStatus, action: CrAction, byUserId: string, at: string, note?: string): void {
		assertTransition(cr.status, to);
		cr.status = to;
		cr.audit = [...cr.audit, { action, byUserId, at, note }];
	}

	// ---- Actions to implement -------------------------------------------------------------

	submit(user: ReqUser, id: string, at: string): ChangeRequest {
		const cr = this.getOrThrow(user, id);
		if (!hasPolicy(user, 'cr_u_u') && !hasPolicy(user, 'cr_u_o')) throw Errors.forbidden('Cannot submit');
		this.transition(cr, CrStatus.SUBMITTED, CrAction.SUBMIT, user.id, at);
		return this.repo.save(cr);
	}

	sendForApproval(user: ReqUser, id: string, at: string): ChangeRequest {
		const cr = this.getOrThrow(user, id);
		if (!hasPolicy(user, 'cr_u_u') && !hasPolicy(user, 'cr_u_o')) {
			throw Errors.forbidden('Cannot send for approval');
		}

		const agreement = this.agreements.get(cr.agreementId);
		if (!agreement) throw Errors.notFound('Agreement not found');

		cr.totals = computeTotals(agreement, cr);
		const requiresCommittee = Math.abs(cr.totals.delta) > COMMITTEE_DELTA_THRESHOLD;
		if (requiresCommittee && !this.committeeConfig) {
			throw Errors.validation('Committee configuration is required for large change requests');
		}

		cr.approvals = [];
		cr.committee = undefined;

		this.transition(cr, CrStatus.PENDING_APPROVAL, CrAction.SEND_FOR_APPROVAL, user.id, at);

		if (requiresCommittee && this.committeeConfig) {
			cr.committee = {
				members: this.committeeConfig.members,
				head: this.committeeConfig.head,
				votes: [],
			};

			this.transition(cr, CrStatus.COMMITTEE_VOTING, CrAction.SEND_FOR_APPROVAL, user.id, at, 'Routed to committee');
		}

		return this.repo.save(cr);
	}

	approve(user: ReqUser, id: string, at: string): ChangeRequest {
		// TODO: permission check (cr_a_*); legal transition; record approval + audit.
		//       Committee CRs approve only via committee resolution.
		const cr = this.getOrThrow(user, id);
		if (!hasPolicy(user, 'cr_a_u') && !hasPolicy(user, 'cr_a_o')) {
			throw Errors.forbidden('Cannot approve');
		}

		if (cr.status === CrStatus.COMMITTEE_VOTING || cr.status === CrStatus.COMMITTEE_DECISION) {
			throw Errors.validation('Committee change requests must be approved by committee resolution');
		}

		if (cr.status !== CrStatus.PENDING_APPROVAL) {
			throw Errors.illegalTransition(`Illegal transition: cannot approve a ${cr.status} change request`);
		}

		const agreement = this.agreements.get(cr.agreementId);
		if (!agreement) throw Errors.notFound('Agreement not found');

		cr.totals = computeTotals(agreement, cr);

		if (Math.abs(cr.totals.delta) > COMMITTEE_DELTA_THRESHOLD) {
			throw Errors.illegalTransition('Illegal transition: large change requests require committee voting');
		}

		cr.approvals = [...cr.approvals, { userId: user.id, action: 'APPROVE', at }];
		this.transition(cr, CrStatus.APPROVED, CrAction.APPROVE, user.id, at);
		return this.repo.save(cr);
	}

	castVote(user: ReqUser, id: string, decision: 'APPROVE' | 'REJECT', at: string): ChangeRequest {
		const cr = this.getOrThrow(user, id);
		if (!hasPolicy(user, 'cr_a_u') && !hasPolicy(user, 'cr_a_o')) {
			throw Errors.forbidden('Cannot vote');
		}

		if (cr.status !== CrStatus.COMMITTEE_VOTING) {
			throw Errors.illegalTransition(`Illegal transition: cannot vote on a ${cr.status} change request`);
		}

		if (!cr.committee || !cr.committee.members.includes(user.id)) {
			throw Errors.forbidden('Only committee members may vote');
		}

		const votesWithoutCurrentUser = cr.committee.votes.filter((vote) => vote.userId !== user.id);
		const vote: CommitteeVote = { userId: user.id, decision, at };
		cr.committee = { ...cr.committee, votes: [...votesWithoutCurrentUser, vote] };
		cr.audit = [...cr.audit, { action: CrAction.CAST_VOTE, byUserId: user.id, at, note: decision }];

		const memberCount = cr.committee.members.length;
		const majority = Math.floor(memberCount / 2) + 1;
		const approveCount = cr.committee.votes.filter((item) => item.decision === 'APPROVE').length;
		const rejectCount = cr.committee.votes.filter((item) => item.decision === 'REJECT').length;
		const headVote = cr.committee.votes.find((item) => item.userId === cr.committee?.head);
		const allVotesCast = cr.committee.votes.length === memberCount;
		const approved = approveCount >= majority && headVote?.decision === 'APPROVE';
		const rejected = headVote?.decision === 'REJECT' || rejectCount >= majority || (allVotesCast && !approved);

		if (approved || rejected) {
			cr.committee = { ...cr.committee, resolvedAt: at };
			this.transition(cr, CrStatus.COMMITTEE_DECISION, CrAction.RESOLVE_COMMITTEE, user.id, at);

			if (approved) {
				cr.approvals = [...cr.approvals, { userId: user.id, action: 'APPROVE', at }];
				this.transition(cr, CrStatus.APPROVED, CrAction.APPROVE, user.id, at);
			} else {
				this.transition(cr, CrStatus.REJECTED, CrAction.REJECT, user.id, at);
			}
		}

		return this.repo.save(cr);
	}

	returnToDraft(user: ReqUser, id: string, at: string): ChangeRequest {
		const cr = this.getOrThrow(user, id);
		if (!hasPolicy(user, 'cr_u_u') && !hasPolicy(user, 'cr_u_o')) {
			throw Errors.forbidden('Cannot return change request');
		}

		cr.approvals = [];
		cr.committee = undefined;

		this.transition(cr, CrStatus.RETURNED, CrAction.RETURN, user.id, at);
		this.transition(cr, CrStatus.DRAFT, CrAction.RETURN, user.id, at);

		return this.repo.save(cr);
	}

	reject(user: ReqUser, id: string, at: string): ChangeRequest {
		const cr = this.getOrThrow(user, id);
		if (!hasPolicy(user, 'cr_a_u') && !hasPolicy(user, 'cr_a_o')) {
			throw Errors.forbidden('Cannot reject');
		}

		this.transition(cr, CrStatus.REJECTED, CrAction.REJECT, user.id, at);
		return this.repo.save(cr);
	}

	apply(user: ReqUser, id: string, at: string): ChangeRequest {
		// TODO: require APPROVED + cr_x_* policy; check budget.balance covers a positive delta else
		//       INSUFFICIENT_BUDGET; update budget, set APPLIED, audit. Recompute totals from the
		//       agreement.
		const cr = this.getOrThrow(user, id);
		if (!hasPolicy(user, 'cr_x_u') && !hasPolicy(user, 'cr_x_o')) {
			throw Errors.forbidden('Cannot apply');
		}

		const agreement = this.agreements.get(cr.agreementId);
		if (!agreement) throw Errors.notFound('Agreement not found');

		const budget = this.budgets.get(agreement.budgetId);
		if (!budget) throw Errors.notFound('Budget not found');

		cr.totals = computeTotals(agreement, cr);

		if (cr.totals.delta > 0 && budget.balance < cr.totals.delta) {
			throw Errors.insufficientBudget();
		}

		if (cr.totals.delta > 0) {
			budget.balance = budget.balance - cr.totals.delta;
		}

		this.transition(cr, CrStatus.APPLIED, CrAction.APPLY, user.id, at);
		return this.repo.save(cr);
	}

	/** Read a single CR. */
	get(user: ReqUser, id: string): ChangeRequest {
		return this.getOrThrow(user, id);
	}

	/** List the CRs this user is allowed to see. Honor the user's read scope (u/w/o). */
	list(user: ReqUser): ChangeRequest[] {
		// TODO: org scoping happens in the repo; narrow further by the caller's read scope.
		return this.repo.list(user);
	}

	/** Recompute and persist totals for a CR (used by tests and before routing). Provided. */
	recomputeTotals(user: ReqUser, id: string): ChangeRequest {
		const cr = this.getOrThrow(user, id);
		const agreement = this.agreements.get(cr.agreementId);
		if (!agreement) throw Errors.notFound('Agreement not found');
		cr.totals = computeTotals(agreement, cr);
		return this.repo.save(cr);
	}
}
