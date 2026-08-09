import { CrStatus } from '../src/change-requests/cr.enums';
import { CrRepo } from '../src/change-requests/cr-repo';
import { CrService } from '../src/change-requests/cr-service';
import { ChangeRequest } from '../src/change-requests/cr.types';
import { buildSeed } from '../src/seed';

function makeServiceWithLargeSubmitted(id = 'CR-SUBMITTED-LARGE') {
	const seed = buildSeed();
	const repo = new CrRepo();
	const largePending = seed.changeRequests.find((cr) => cr.id === 'CR-PENDING-LARGE');
	if (!largePending) throw new Error('Missing large CR fixture');

	const largeSubmitted: ChangeRequest = {
		...largePending,
		id,
		status: CrStatus.SUBMITTED,
		approvals: [],
		committee: undefined,
		audit: [],
	};

	repo.seed([...seed.changeRequests, largeSubmitted]);

	return {
		...seed,
		repo,
		service: new CrService(repo, seed.agreements, seed.budgets, seed.committeeConfig),
		id,
	};
}

describe('committee routing', () => {
	const now = '2026-08-09T12:00:00.000Z';

	it('routes a large delta CR to committee voting', () => {
		const { service, users, id } = makeServiceWithLargeSubmitted();

		const routed = service.sendForApproval(users.mona, id, now);

		expect(routed.status).toBe(CrStatus.COMMITTEE_VOTING);
		expect(routed.committee).toEqual({
			members: ['carl', 'dina'],
			head: 'dina',
			votes: [],
		});
	});

	it('approves after majority approval plus committee head approval', () => {
		const { service, users, id } = makeServiceWithLargeSubmitted();

		service.sendForApproval(users.mona, id, now);

		const afterMemberVote = service.castVote(users.carl, id, 'APPROVE', now);
		expect(afterMemberVote.status).toBe(CrStatus.COMMITTEE_VOTING);

		const afterHeadVote = service.castVote(users.dina, id, 'APPROVE', now);
		expect(afterHeadVote.status).toBe(CrStatus.APPROVED);
		expect(afterHeadVote.committee?.resolvedAt).toBe(now);
		expect(afterHeadVote.approvals).toContainEqual({ userId: 'dina', action: 'APPROVE', at: now });
	});

	it('rejects when the committee head rejects', () => {
		const { service, users, id } = makeServiceWithLargeSubmitted();

		service.sendForApproval(users.mona, id, now);

		const rejected = service.castVote(users.dina, id, 'REJECT', now);

		expect(rejected.status).toBe(CrStatus.REJECTED);
		expect(rejected.committee?.resolvedAt).toBe(now);
	});
});
