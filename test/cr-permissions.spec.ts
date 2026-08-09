import { CrStatus } from '../src/change-requests/cr.enums';
import { CrRepo } from '../src/change-requests/cr-repo';
import { CrService } from '../src/change-requests/cr-service';
import { ChangeRequest } from '../src/change-requests/cr.types';
import { ReqUser } from '../src/common/policy';
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

describe('CR permissions and read scope', () => {
	const now = '2026-08-09T12:00:00.000Z';

	it('does not allow a user to read a CR outside their organization', () => {
		const { service, users } = makeService();

		expect(() => service.get(users.bob, 'CR-DRAFT')).toThrow(/not found/i);
		expect(service.list(users.bob).map((cr) => cr.id)).toEqual(['CR-BETA']);
	});

	it('honors user read scope', () => {
		const seed = buildSeed();
		const otherOwnerCr: ChangeRequest = {
			...seed.changeRequests[0],
			id: 'CR-MONA-DRAFT',
			createdBy: 'mona',
			status: CrStatus.DRAFT,
		};
		const { service, users } = makeService([otherOwnerCr]);

		const visibleIds = service.list(users.alice).map((cr) => cr.id);

		expect(visibleIds).toContain('CR-DRAFT');
		expect(visibleIds).not.toContain('CR-MONA-DRAFT');
	});

	it('honors workspace read scope', () => {
		const seed = buildSeed();
		const otherWorkspaceCr: ChangeRequest = {
			...seed.changeRequests[0],
			id: 'CR-WS-2',
			workspaceId: 'ws-2',
			status: CrStatus.DRAFT,
		};
		const workspaceReader: ReqUser = {
			id: 'workspace-reader',
			orgCode: 'org-alpha',
			workspaceIds: ['ws-1'],
			policies: ['cr_r_w'],
		};
		const { service } = makeService([otherWorkspaceCr]);

		const visibleIds = service.list(workspaceReader).map((cr) => cr.id);

		expect(visibleIds).toContain('CR-DRAFT');
		expect(visibleIds).not.toContain('CR-WS-2');
	});

	it('rejects reads when the user has no read policy', () => {
		const noReadUser: ReqUser = {
			id: 'no-read',
			orgCode: 'org-alpha',
			workspaceIds: ['ws-1'],
			policies: [],
		};
		const { service } = makeService();

		expect(() => service.list(noReadUser)).toThrow(/not allowed|cannot read|forbidden/i);
		expect(() => service.get(noReadUser, 'CR-DRAFT')).toThrow(/not allowed|cannot read|forbidden/i);
	});

	it('limits user-scoped update permission to CRs created by the caller', () => {
		const updateOwnOnly: ReqUser = {
			id: 'eve',
			orgCode: 'org-alpha',
			workspaceIds: ['ws-1'],
			policies: ['cr_u_u'],
		};
		const { service } = makeService();

		expect(() => service.submit(updateOwnOnly, 'CR-DRAFT', now)).toThrow(/not allowed|cannot submit|forbidden/i);
	});
});
