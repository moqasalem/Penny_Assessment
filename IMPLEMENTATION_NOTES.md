# Implementation Notes

## 1. What I changed

I completed the Change Request workflow around the existing in-memory repository and service structure, keeping the scaffold's architecture intact.

- Fixed money rounding in `src/common/money.util.ts` by rounding to the nearest cent instead of truncating.
- Completed the legal transition table and tightened `assertTransition` so illegal moves such as `DRAFT -> APPROVED` are rejected.
- Implemented the main CR actions in `src/change-requests/cr-service.ts`: `sendForApproval`, `approve`, `castVote`, `returnToDraft`, `reject`, and `apply`.
- Implemented committee routing for large deltas using `COMMITTEE_DELTA_THRESHOLD`, including CRs that are already in `PENDING_APPROVAL`.
- Preserved historical committee assignments by snapshotting committee members when routing a CR.
- Moved budget mutation behind state validation in `apply` and handled both positive and negative deltas.
- Enforced organization scoping in `CrRepo.findOne` and read/action permissions in `CrService`.
- Hardened the in-memory repository against accidental mutation by cloning CRs at read/write boundaries and checking `version` on save.
- Added tests for workflow, committee routing, permissions, and core invariants.

Task 6 was skipped because this package is the backend-only variant and does not include a `web/` Angular application.

## 2. Domain model

The domain centers on a `ChangeRequest` that proposes changes to a single active `PurchaseAgreement`. A CR has draft changes, computed totals, approvals, optional committee state, an audit timeline, and a status in a guarded state machine.

The main state flow is:

```txt
DRAFT -> SUBMITTED -> PENDING_APPROVAL -> APPROVED -> APPLIED
                              |
                              -> COMMITTEE_VOTING -> COMMITTEE_DECISION -> APPROVED / REJECTED
```

`RETURNED` allows a CR to go back to `DRAFT` for editing. `APPLIED`, `REJECTED`, and `CANCELLED` are terminal and cannot be changed further. All state changes go through the service's `transition` helper, which calls `assertTransition` and appends an audit entry.

## 3. Invariants I enforce

| Invariant                                               | How it is enforced                                                          | Where                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------- |
| Money values are rounded to cents                       | Money helpers convert values to integer cents before returning 2dp numbers  | `src/common/money.util.ts`                |
| Only legal state transitions are allowed                | `assertTransition` checks `LEGAL_TRANSITIONS` and terminal states           | `src/change-requests/cr-state-machine.ts` |
| Terminal states are immutable                           | `assertTransition` rejects moves from terminal statuses                     | `src/change-requests/cr-state-machine.ts` |
| Each state change is audited                            | All state changes use `transition`                                          | `src/change-requests/cr-service.ts`       |
| Large deltas require committee routing                  | `sendForApproval` compares `Math.abs(delta)` to `COMMITTEE_DELTA_THRESHOLD` | `CrService.sendForApproval`               |
| Committee assignments are historical snapshots          | Routed CRs copy committee member IDs instead of sharing config references   | `CrService.sendForApproval`               |
| Committee approval requires majority plus head approval | `castVote` counts votes and checks the head vote                            | `CrService.castVote`                      |
| Failed apply cannot mutate budget state                 | `apply` validates the `APPLIED` transition before changing budget balance   | `CrService.apply`                         |
| Positive deltas cannot overspend budget                 | `apply` checks `budget.balance` before updating it                          | `CrService.apply`                         |
| Negative deltas release budget                          | `apply` subtracts the signed delta, so negative deltas increase balance     | `CrService.apply`                         |
| Repository reads do not expose mutable stored objects   | `seed`, `findOne`, `list`, and `save` clone CRs at repository boundaries    | `src/change-requests/cr-repo.ts`          |
| Stale saves are rejected                                | `save` compares the caller's `version` with the stored CR version           | `src/change-requests/cr-repo.ts`          |
| CR reads are tenant-scoped                              | `CrRepo.findOne` and `list` filter by `orgCode`                             | `src/change-requests/cr-repo.ts`          |
| Read scope is honored                                   | `list` and `get` apply `cr_r_u`, `cr_r_w`, and `cr_r_o`                     | `CrService.get`, `CrService.list`         |
| Actions require matching policy scope                   | `assertCanAct` checks `cr_u_*`, `cr_a_*`, and `cr_x_*`                      | `src/change-requests/cr-service.ts`       |

## 4. Testing strategy

I kept tests fast and deterministic by using the existing seed fixtures and the in-memory repository.

Test coverage includes:

- Visible starter failures: money rounding and illegal transitions.
- Small CR happy path: submit, send for approval, approve, and apply.
- Committee routing: large CR routing, already-pending large CRs, committee assignment snapshots, majority plus head approval, and head rejection.
- Permissions: organization isolation, user/workspace/org read scopes, missing read policy, and user-scoped update limits.
- Invariants: insufficient budget, failed apply budget integrity, negative delta budget behavior, terminal-state immutability, approval reset on return, and failed-transition mutation safety.
- Repository integrity: cloned reads/lists/seeds, stale version rejection, and save version increments.

I did not add broad randomized/property tests because the scaffold is intentionally small and deterministic. Focused tests around state-machine and permission boundaries gave better signal for the time budget.

## 5. Assumptions and judgment calls

- A large CR is one where `Math.abs(delta) > COMMITTEE_DELTA_THRESHOLD`. Equal to the threshold stays in the single-approver path.
- Monetary values remain exposed as `number` because the scaffold uses number fields, but calculations are rounded through cent-based helpers at money boundaries.
- Positive budget deltas consume budget; negative deltas release budget back to the linked budget.
- `apply` validates that the CR can move to `APPLIED` before changing budget balance, so failed state transitions do not consume or release budget.
- If a large CR is already in `PENDING_APPROVAL`, `sendForApproval` routes it directly to `COMMITTEE_VOTING` instead of trying to re-enter the same state.
- Committee member IDs are copied into the CR at routing time. This preserves the historical assignment even if committee configuration changes later.
- Returning a CR resets `approvals` and `committee` progress, then moves it back to `DRAFT` for editing.
- A committee member may update their vote before the committee resolves.
- If the committee head rejects, the CR is rejected.
- If all votes are cast and the majority-plus-head approval rule is not satisfied, the CR is rejected.
- Repository methods clone CRs when data enters or leaves the in-memory store. This makes the repository boundary explicit and avoids accidental mutation through JavaScript/TypeScript object references.
- `CrRepo.save` uses optimistic version checks to avoid stale writes overwriting newer workflow changes.
- Users without read policies receive a forbidden error instead of an empty list, because the lack of read permission is an authorization failure.
- Missing cross-org agreements or budgets are treated as not found to avoid leaking tenant details.

## 6. Trade-offs

- This assessment uses an in-memory repository, so I used cloning and optimistic version checks instead of database transactions or row-level locks.
- In a production data store, budget updates and CR status changes should be committed atomically in a transaction to avoid double-apply and partial-write scenarios.
- I kept workflow orchestration in `CrService` to stay close to the provided scaffold. With more time, authorization, committee resolution, and budget posting could be extracted into smaller domain helpers.
- The cent-based money helpers improve reliability within the current number-based model. In production, I would store monetary values as integer minor units or use a decimal type end to end.

## 7. Where I used AI

I used AI assistance to clarify the brief, reason about the starter test failures, identify useful edge-case tests, draft parts of the report, and summarize the video script. I reviewed the code and final content myself and verified the implementation by running:

```bash
npm test
npm run build
npm run lint
```

## 8. What I would improve with more time

- Extract authorization and committee resolution into smaller dedicated helpers.
- Replace in-memory persistence with database transactions for state changes that also affect budget.
- Add more edge-case tests around vote changes, repeated actions, and concurrent apply attempts.
