import { CrRepo } from './cr-repo';
import { ChangeRequest, Budget, PurchaseAgreement, COMMITTEE_DELTA_THRESHOLD, CommitteeVote } from './cr.types';
import { CrStatus, CrAction } from './cr.enums';
import { assertTransition } from './cr-state-machine';
import { computeTotals } from './cr-totals';
import { Errors } from '../common/errors';
import { ReqUser, crReadScope, hasPolicy } from '../common/policy';
import { round2 } from '../common/money.util';

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

	private canAct(user: ReqUser, cr: ChangeRequest, action: 'u' | 'a' | 'x'): boolean {
		if (hasPolicy(user, `cr_${action}_o`)) return true;
		if (hasPolicy(user, `cr_${action}_w`) && user.workspaceIds.includes(cr.workspaceId)) return true;
		if (hasPolicy(user, `cr_${action}_u`) && cr.createdBy === user.id) return true;
		return false;
	}

	private assertCanAct(user: ReqUser, cr: ChangeRequest, action: 'u' | 'a' | 'x', message: string): void {
		if (!this.canAct(user, cr, action)) throw Errors.forbidden(message);
	}

	private canRead(user: ReqUser, cr: ChangeRequest): boolean {
		const scope = crReadScope(user);
		if (scope === 'o') return true;
		if (scope === 'w') return user.workspaceIds.includes(cr.workspaceId);
		if (scope === 'u') return cr.createdBy === user.id;
		return false;
	}

	private assertCanRead(user: ReqUser, cr: ChangeRequest): void {
		if (!this.canRead(user, cr)) throw Errors.forbidden('Cannot read');
	}

	private getAgreementForCr(cr: ChangeRequest): PurchaseAgreement {
		const agreement = this.agreements.get(cr.agreementId);
		if (!agreement || agreement.orgCode !== cr.orgCode) throw Errors.notFound('Agreement not found');
		return agreement;
	}

	private getBudgetForCr(cr: ChangeRequest, agreement: PurchaseAgreement): Budget {
		const budget = this.budgets.get(agreement.budgetId);
		if (!budget || budget.orgCode !== cr.orgCode) throw Errors.notFound('Budget not found');
		return budget;
	}

	// ---- Actions to implement -------------------------------------------------------------

	submit(user: ReqUser, id: string, at: string): ChangeRequest {
		const cr = this.getOrThrow(user, id);
		this.assertCanAct(user, cr, 'u', 'Cannot submit');
		this.transition(cr, CrStatus.SUBMITTED, CrAction.SUBMIT, user.id, at);
		return this.repo.save(cr);
	}

	sendForApproval(user: ReqUser, id: string, at: string): ChangeRequest {
		const cr = this.getOrThrow(user, id);
		this.assertCanAct(user, cr, 'u', 'Cannot send for approval');

		if (cr.status !== CrStatus.PENDING_APPROVAL) {
			assertTransition(cr.status, CrStatus.PENDING_APPROVAL);
		}

		const agreement = this.getAgreementForCr(cr);
		cr.totals = computeTotals(agreement, cr);

		const requiresCommittee = Math.abs(cr.totals.delta) > COMMITTEE_DELTA_THRESHOLD;
		if (requiresCommittee && !this.committeeConfig) {
			throw Errors.validation('Committee configuration is required for large change requests');
		}

		cr.approvals = [];
		cr.committee = undefined;

		// Avoid re-entering PENDING_APPROVAL for CRs that are already pending.
		if (cr.status !== CrStatus.PENDING_APPROVAL) {
			this.transition(cr, CrStatus.PENDING_APPROVAL, CrAction.SEND_FOR_APPROVAL, user.id, at);
		}

		if (requiresCommittee && this.committeeConfig) {
			cr.committee = {
				members: [...this.committeeConfig.members], // preserve the historical state of the request rather than relying on mutable references
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
		this.assertCanAct(user, cr, 'a', 'Cannot approve');

		if (cr.status === CrStatus.COMMITTEE_VOTING || cr.status === CrStatus.COMMITTEE_DECISION) {
			throw Errors.validation('Committee change requests must be approved by committee resolution');
		}

		if (cr.status !== CrStatus.PENDING_APPROVAL) {
			throw Errors.illegalTransition(`Illegal transition: cannot approve a ${cr.status} change request`);
		}

		const agreement = this.getAgreementForCr(cr);

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
		this.assertCanAct(user, cr, 'a', 'Cannot vote');

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
		this.assertCanAct(user, cr, 'u', 'Cannot return change request');

		cr.approvals = [];
		cr.committee = undefined;

		this.transition(cr, CrStatus.RETURNED, CrAction.RETURN, user.id, at);
		this.transition(cr, CrStatus.DRAFT, CrAction.RETURN, user.id, at);

		return this.repo.save(cr);
	}

	reject(user: ReqUser, id: string, at: string): ChangeRequest {
		const cr = this.getOrThrow(user, id);
		this.assertCanAct(user, cr, 'a', 'Cannot reject');

		this.transition(cr, CrStatus.REJECTED, CrAction.REJECT, user.id, at);
		return this.repo.save(cr);
	}

	apply(user: ReqUser, id: string, at: string): ChangeRequest {
		// TODO: require APPROVED + cr_x_* policy; check budget.balance covers a positive delta else
		//       INSUFFICIENT_BUDGET; update budget, set APPLIED, audit. Recompute totals from the
		//       agreement.
		const cr = this.getOrThrow(user, id);
		this.assertCanAct(user, cr, 'x', 'Cannot apply');

		// Validate state before changing budget
		assertTransition(cr.status, CrStatus.APPLIED);

		const agreement = this.getAgreementForCr(cr);

		const budget = this.getBudgetForCr(cr, agreement);

		cr.totals = computeTotals(agreement, cr);

		if (cr.totals.delta > 0 && budget.balance < cr.totals.delta) {
			throw Errors.insufficientBudget();
		}

		// Positive delta decreases balance.
		// Negative delta increases balance.
		budget.balance = round2(budget.balance - cr.totals.delta);

		this.transition(cr, CrStatus.APPLIED, CrAction.APPLY, user.id, at);
		return this.repo.save(cr);
	}

	/** Read a single CR. */
	get(user: ReqUser, id: string): ChangeRequest {
		const cr = this.getOrThrow(user, id);
		this.assertCanRead(user, cr);
		return cr;
	}

	/** List the CRs this user is allowed to see. Honor the user's read scope (u/w/o). */
	list(user: ReqUser): ChangeRequest[] {
		const scope = crReadScope(user);
		if (!scope) throw Errors.forbidden('Cannot read');

		const crs = this.repo.list(user);
		if (scope === 'o') return crs;
		if (scope === 'w') return crs.filter((cr) => user.workspaceIds.includes(cr.workspaceId));
		return crs.filter((cr) => cr.createdBy === user.id);
	}

	/** Recompute and persist totals for a CR (used by tests and before routing). Provided. */
	recomputeTotals(user: ReqUser, id: string): ChangeRequest {
		const cr = this.getOrThrow(user, id);
		this.assertCanAct(user, cr, 'u', 'Cannot recompute totals');
		const agreement = this.getAgreementForCr(cr);
		cr.totals = computeTotals(agreement, cr);
		return this.repo.save(cr);
	}
}
