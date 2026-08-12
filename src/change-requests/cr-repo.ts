import { ChangeRequest } from './cr.types';
import { ReqUser } from '../common/policy';
import { Errors } from '../common/errors';

/**
 * Minimal in-memory repository standing in for the Mongoose data layer. In the full scaffold this
 * is backed by MongoDB and an org-scope helper that auto-injects `{ orgCode }` into every query;
 * here, `scoped()` is that helper's in-memory stand-in.
 */
export class CrRepo {
	private store = new Map<string, ChangeRequest>();

	seed(crs: ChangeRequest[]): void {
		for (const cr of crs) this.store.set(cr.id, this.cloneCr(cr)); // fix shallow copy: { ...cr });
	}

	/** The org-scope choke point: filter a candidate set down to the caller's org. */
	private scoped(user: ReqUser, crs: ChangeRequest[]): ChangeRequest[] {
		return crs.filter((cr) => cr.orgCode === user.orgCode);
	}

	private cloneCr(cr: ChangeRequest): ChangeRequest {
		return JSON.parse(JSON.stringify(cr)) as ChangeRequest;
	}

	list(user: ReqUser): ChangeRequest[] {
		return this.scoped(user, [...this.store.values()]).map((cr) => this.cloneCr(cr));
	}

	findOne(user: ReqUser, id: string): ChangeRequest | undefined {
		const cr = this.scoped(user, [...this.store.values()]).find((cr) => cr.id === id);
		return cr ? this.cloneCr(cr) : undefined;
	}

	save(cr: ChangeRequest): ChangeRequest {
		const existing = this.store.get(cr.id);

		// Reject saving if the version has changed since the caller fetched it, to avoid overwriting concurrent changes.
		if (existing && existing.version !== cr.version) {
			throw Errors.conflict('stale version: cannot save a change request that has been modified since it was fetched');
		}

		// Increment the version and store a new copy of the CR, so that the caller's reference is not mutated.
		const saved = this.cloneCr({
			...cr,
			version: cr.version + 1,
		});

		this.store.set(cr.id, saved);

		return this.cloneCr(saved);
	}
}
