# Implementation Notes

## 1. What I changed

I completed the Change Request workflow around the existing in-memory repository and service structure, keeping the scaffold's architecture intact.

- Fixed money rounding in `src/common/money.util.ts` by rounding to the nearest cent instead of truncating.
- Completed the legal transition table and tightened `assertTransition` so illegal moves such as `DRAFT -> APPROVED` are rejected.
- Implemented the main CR actions in `src/change-requests/cr-service.ts`: `sendForApproval`, `approve`, `castVote`, `returnToDraft`, `reject`, and `apply`.
- Implemented committee routing for large deltas using `COMMITTEE_DELTA_THRESHOLD`.
- Enforced organization scoping in `CrRepo.findOne` and read/action permissions in `CrService`.
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
| Money values are rounded to cents                       | `round2` uses `Math.round(value * 100) / 100`                               | `src/common/money.util.ts`                |
| Only legal state transitions are allowed                | `assertTransition` checks `LEGAL_TRANSITIONS` and terminal states           | `src/change-requests/cr-state-machine.ts` |
| Terminal states are immutable                           | `assertTransition` rejects moves from terminal statuses                     | `src/change-requests/cr-state-machine.ts` |
| Each state change is audited                            | All state changes use `transition`                                          | `src/change-requests/cr-service.ts`       |
| Large deltas require committee routing                  | `sendForApproval` compares `Math.abs(delta)` to `COMMITTEE_DELTA_THRESHOLD` | `CrService.sendForApproval`               |
| Committee approval requires majority plus head approval | `castVote` counts votes and checks the head vote                            | `CrService.castVote`                      |
| Positive deltas cannot overspend budget                 | `apply` checks `budget.balance` before updating it                          | `CrService.apply`                         |
| CR reads are tenant-scoped                              | `CrRepo.findOne` and `list` filter by `orgCode`                             | `src/change-requests/cr-repo.ts`          |
| Read scope is honored                                   | `list` and `get` apply `cr_r_u`, `cr_r_w`, and `cr_r_o`                     | `CrService.get`, `CrService.list`         |
| Actions require matching policy scope                   | `assertCanAct` checks `cr_u_*`, `cr_a_*`, and `cr_x_*`                      | `src/change-requests/cr-service.ts`       |

## 4. Testing strategy

I kept tests fast and deterministic by using the existing seed fixtures and the in-memory repository.

Test coverage includes:

- Visible starter failures: money rounding and illegal transitions.
- Small CR happy path: submit, send for approval, approve, and apply.
- Committee routing: large CR routing, majority plus head approval, and head rejection.
- Permissions: organization isolation, user/workspace/org read scopes, missing read policy, and user-scoped update limits.
- Invariants: insufficient budget, negative delta budget behavior, terminal-state immutability, and approval reset on return.

I did not add broad randomized/property tests because the scaffold is intentionally small and deterministic. Focused tests around state-machine and permission boundaries gave better signal for the time budget.

## 5. Assumptions and judgment calls

- A large CR is one where `Math.abs(delta) > COMMITTEE_DELTA_THRESHOLD`. Equal to the threshold stays in the single-approver path.
- Returning a CR resets `approvals` and `committee` progress, then moves it back to `DRAFT` for editing.
- A committee member may update their vote before the committee resolves.
- If the committee head rejects, the CR is rejected.
- If all votes are cast and the majority-plus-head approval rule is not satisfied, the CR is rejected.
- Users without read policies receive a forbidden error instead of an empty list, because the lack of read permission is an authorization failure.
- Missing cross-org agreements or budgets are treated as not found to avoid leaking tenant details.

## 6. Where I used AI

I used AI assistance to clarify the brief, reason about the starter test failures, identify useful edge-case tests, draft parts of the report, and summarize the video script. I reviewed the code and final content myself and verified the implementation by running:

```bash
npm test
npm run build
npm run lint
```

## 7. What I would improve with more time

- Extract authorization and committee resolution into smaller dedicated helpers.
- Add version/concurrency checks around repository saves.
- Add a few more edge-case tests around vote changes and repeated actions.
