import { CrStatus } from '../src/change-requests/cr.enums';
import { CrRepo } from '../src/change-requests/cr-repo';
import { CrService } from '../src/change-requests/cr-service';
import { ChangeRequest } from '../src/change-requests/cr.types';
import { buildSeed } from '../src/seed';

function makeService(extraCrs: ChangeRequest[] = []) {
	const seed = buildSeed();
	const repo = new CrRepo();
	repo.seed([...seed.changeRequests, ...extraCrs]);

	return {
		...seed,
		repo,
		service: new CrService(repo, seed.agreements, seed.budgets, seed.committeeConfig),
	};
}

describe('CR workflow invariants', () => {
	const now = '2026-08-09T12:00:00.000Z';

	it('blocks apply when the linked budget cannot cover a positive delta', () => {
		const { service, users, agreements, budgets } = makeService();
		const agreement = agreements.get('AGR-1');
		if (!agreement) throw new Error('Missing agreement fixture');

		agreement.budgetId = 'BUD-LOW';

		service.submit(users.alice, 'CR-DRAFT', now);
		service.sendForApproval(users.mona, 'CR-DRAFT', now);
		service.approve(users.mona, 'CR-DRAFT', now);

		expect(() => service.apply(users.mona, 'CR-DRAFT', now)).toThrow(/INSUFFICIENT_BUDGET|budget/i);
		expect(budgets.get('BUD-LOW')?.balance).toBe(100);
		expect(service.get(users.mona, 'CR-DRAFT').status).toBe(CrStatus.APPROVED);
	});

	it('does not consume budget when applying a negative delta', () => {
		const seed = buildSeed();
		const approvedReduction: ChangeRequest = {
			...seed.changeRequests[0],
			id: 'CR-APPROVED-REDUCTION',
			status: CrStatus.APPROVED,
			draftChanges: {
				lineItems: [
					{ sku: 'A', quantity: 8, unitPrice: 500 },
					{ sku: 'B', quantity: 30, unitPrice: 100 },
				],
			},
			totals: { baselineTotal: 8000, newTotal: 7000, delta: -1000 },
			approvals: [{ userId: 'mona', action: 'APPROVE', at: now }],
			audit: [],
		};
		const { service, users, budgets } = makeService([approvedReduction]);

		const applied = service.apply(users.mona, 'CR-APPROVED-REDUCTION', now);

		expect(applied.status).toBe(CrStatus.APPLIED);
		expect(applied.totals.delta).toBe(-1000);
		expect(budgets.get('BUD-1')?.balance).toBe(10000);
	});

	it('keeps terminal states immutable', () => {
		const { service, users } = makeService();

		expect(() => service.submit(users.alice, 'CR-APPLIED', now)).toThrow(/terminal|cannot move/i);
		expect(() => service.reject(users.mona, 'CR-APPLIED', now)).toThrow(/terminal|cannot move/i);
	});

	it('resets approval progress when returning a pending CR to draft', () => {
		const seed = buildSeed();
		const pendingSmall = seed.changeRequests.find((cr) => cr.id === 'CR-PENDING-SMALL');
		if (!pendingSmall) throw new Error('Missing pending CR fixture');

		const pendingWithProgress: ChangeRequest = {
			...pendingSmall,
			id: 'CR-PENDING-WITH-PROGRESS',
			approvals: [{ userId: 'mona', action: 'APPROVE', at: now }],
			committee: { members: ['carl', 'dina'], head: 'dina', votes: [{ userId: 'carl', decision: 'APPROVE', at: now }] },
			audit: [],
		};
		const { service, users } = makeService([pendingWithProgress]);

		const returned = service.returnToDraft(users.mona, 'CR-PENDING-WITH-PROGRESS', now);

		expect(returned.status).toBe(CrStatus.DRAFT);
		expect(returned.approvals).toEqual([]);
		expect(returned.committee).toBeUndefined();
	});
});
