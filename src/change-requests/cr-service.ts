import { CrRepo } from './cr-repo';
import { ChangeRequest, Budget, PurchaseAgreement, COMMITTEE_DELTA_THRESHOLD } from './cr.types';
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

		const nextStatus = Math.abs(cr.totals.delta) >= COMMITTEE_DELTA_THRESHOLD ? CrStatus.COMMITTEE_VOTING : CrStatus.PENDING_APPROVAL;

		this.transition(cr, nextStatus, CrAction.SEND_FOR_APPROVAL, user.id, at);
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

		cr.approvals = [...cr.approvals, { userId: user.id, action: 'APPROVE', at }];
		this.transition(cr, CrStatus.APPROVED, CrAction.APPROVE, user.id, at);
		return this.repo.save(cr);
	}

	castVote(user: ReqUser, id: string, decision: 'APPROVE' | 'REJECT', at: string): ChangeRequest {
		// TODO: only committee members may vote; resolve on majority + head decision.
		throw Errors.validation('castVote not implemented');
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
