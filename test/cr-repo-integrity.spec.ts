import { CrStatus } from '../src/change-requests/cr.enums';
import { CrRepo } from '../src/change-requests/cr-repo';
import { ChangeRequest } from '../src/change-requests/cr.types';
import { buildSeed } from '../src/seed';

function makeRepo() {
	const seed = buildSeed();
	const repo = new CrRepo();
	repo.seed(seed.changeRequests);

	return {
		...seed,
		repo,
	};
}

describe('CrRepo data integrity', () => {
	it('does not expose stored CR references through findOne', () => {
		const { repo, users } = makeRepo();

		const found = repo.findOne(users.mona, 'CR-DRAFT');
		if (!found) throw new Error('Missing CR fixture');
		found.status = CrStatus.APPLIED;
		found.audit.push({ action: 'MUTATED_OUTSIDE_SAVE', byUserId: 'test', at: '2026-08-09T12:00:00.000Z' });

		const stored = repo.findOne(users.mona, 'CR-DRAFT');
		expect(stored?.status).toBe(CrStatus.DRAFT);
		expect(stored?.audit).toEqual([]);
	});

	it('does not expose stored CR references through list', () => {
		const { repo, users } = makeRepo();

		const listed = repo.list(users.mona);
		const draft = listed.find((cr) => cr.id === 'CR-DRAFT');
		if (!draft) throw new Error('Missing CR fixture');
		draft.status = CrStatus.APPLIED;

		expect(repo.findOne(users.mona, 'CR-DRAFT')?.status).toBe(CrStatus.DRAFT);
	});

	it('deep-clones seeded CRs instead of sharing nested fixture references', () => {
		const seed = buildSeed();
		const repo = new CrRepo();
		const draft = seed.changeRequests.find((cr) => cr.id === 'CR-DRAFT');
		if (!draft) throw new Error('Missing CR fixture');

		repo.seed(seed.changeRequests);
		draft.draftChanges.lineItems?.push({ sku: 'Z', quantity: 1, unitPrice: 1 });

		expect(repo.findOne(seed.users.mona, 'CR-DRAFT')?.draftChanges.lineItems?.map((item) => item.sku)).toEqual(['A', 'B']);
	});

	it('rejects saving a stale CR version', () => {
		const { repo, users } = makeRepo();

		const firstCopy = repo.findOne(users.mona, 'CR-DRAFT');
		const secondCopy = repo.findOne(users.mona, 'CR-DRAFT');
		if (!firstCopy || !secondCopy) throw new Error('Missing CR fixture');

		firstCopy.status = CrStatus.SUBMITTED;
		repo.save(firstCopy);

		secondCopy.status = CrStatus.CANCELLED;
		expect(() => repo.save(secondCopy)).toThrow(/CONFLICT|stale version/i);
	});

	it('increments the CR version when saving', () => {
		const { repo, users } = makeRepo();
		const cr = repo.findOne(users.mona, 'CR-DRAFT');
		if (!cr) throw new Error('Missing CR fixture');

		const saved = repo.save(cr);

		expect(saved.version).toBe(cr.version + 1);
		expect(repo.findOne(users.mona, 'CR-DRAFT')?.version).toBe(saved.version);
	});
});
