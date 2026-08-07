import { CrRepo } from '../src/change-requests/cr-repo';
import { CrService } from '../src/change-requests/cr-service';
import { CrAction, CrStatus } from '../src/change-requests/cr.enums';
import { buildSeed } from '../src/seed';

function makeService() {
	const seed = buildSeed();
	const repo = new CrRepo();
	repo.seed(seed.changeRequests);
	return {
		service: new CrService(repo, seed.agreements, seed.budgets, seed.committeeConfig),
		users: seed.users,
		budgets: seed.budgets,
	};
}

describe('CrService workflow', () => {
	const now = '2026-08-06T12:00:00.000Z';
	it('submits, sends for approval, approves, and applies a small change request', () => {
		const { service, users, budgets } = makeService();
		const submitted = service.submit(users.alice, 'CR-DRAFT', now);
		expect(submitted.status).toBe(CrStatus.SUBMITTED);
		const pending = service.sendForApproval(users.mona, 'CR-DRAFT', now);
		expect(pending.status).toBe(CrStatus.PENDING_APPROVAL);
		expect(pending.totals).toEqual({ baselineTotal: 8000, newTotal: 8500, delta: 500 });
		const approved = service.approve(users.mona, 'CR-DRAFT', now);
		expect(approved.status).toBe(CrStatus.APPROVED);
		expect(approved.approvals).toContainEqual({ userId: 'mona', action: 'APPROVE', at: now });
		const applied = service.apply(users.mona, 'CR-DRAFT', now);
		expect(applied.status).toBe(CrStatus.APPLIED);
		expect(budgets.get('BUD-1')?.balance).toBe(9500);
		expect(applied.audit.map((entry) => entry.action)).toEqual([
			CrAction.SUBMIT,
			CrAction.SEND_FOR_APPROVAL,
			CrAction.APPROVE,
			CrAction.APPLY,
		]);
	});
	it('does not allow applying a change request before it is approved', () => {
		const { service, users } = makeService();
		expect(() => service.apply(users.mona, 'CR-PENDING-SMALL', now)).toThrow(/ILLEGAL_TRANSITION|illegal|not allowed/i);
	});
});
