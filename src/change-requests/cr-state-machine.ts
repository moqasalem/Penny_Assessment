import { CrStatus, isTerminal } from './cr.enums';
import { Errors } from '../common/errors';

/**
 * Legal transitions for the CR state machine. See README diagram.
 *
 * This table is incomplete — only the first two transitions are filled in. Complete it for
 * the full flow (approve / return / reject / apply / committee branch).
 *
 * `assertTransition` below is also too permissive: it currently allows ANY move out of a
 * non-terminal state instead of only the legal ones declared here, which lets (for example)
 * DRAFT -> APPROVED happen directly. Make it enforce the declared transitions.
 */
export const LEGAL_TRANSITIONS: Partial<Record<CrStatus, CrStatus[]>> = {
	[CrStatus.DRAFT]: [CrStatus.SUBMITTED, CrStatus.REJECTED, CrStatus.CANCELLED],
	[CrStatus.SUBMITTED]: [CrStatus.PENDING_APPROVAL, CrStatus.REJECTED, CrStatus.CANCELLED],
	[CrStatus.PENDING_APPROVAL]: [CrStatus.APPROVED, CrStatus.COMMITTEE_VOTING, CrStatus.RETURNED, CrStatus.REJECTED, CrStatus.CANCELLED],
	[CrStatus.COMMITTEE_VOTING]: [CrStatus.COMMITTEE_DECISION, CrStatus.RETURNED, CrStatus.REJECTED, CrStatus.CANCELLED],
	[CrStatus.COMMITTEE_DECISION]: [CrStatus.APPROVED, CrStatus.REJECTED, CrStatus.CANCELLED],
	[CrStatus.APPROVED]: [CrStatus.APPLIED, CrStatus.CANCELLED],
	[CrStatus.RETURNED]: [CrStatus.DRAFT, CrStatus.REJECTED, CrStatus.CANCELLED],
};

export function canTransition(from: CrStatus, to: CrStatus): boolean {
	return (LEGAL_TRANSITIONS[from] ?? []).includes(to);
}

/** Throw a BusinessError if the transition from->to is not allowed. */
export function assertTransition(from: CrStatus, to: CrStatus): void {
	if (isTerminal(from)) {
		throw Errors.terminal(`Cannot move a ${from} change request to ${to}`);
	}

	if (!canTransition(from, to)) {
		throw Errors.illegalTransition(`Illegal transition: cannot move a ${from} change request to ${to}`);
	}
	return;
}
