# Issue #1 implementation plan

Scope: durable Pi-only SubagentJobV1 registry; no child reporter, launch tools, or notifications. Keep existing target registry unchanged.

1. Define validated versioned job schema and explicit legal lifecycle transitions (including idempotent duplicate transitions and immutable terminal outcomes). Resolve creation ordering: allow initial created job with no tmux IDs until binding, then require stable IDs before starting/running. Document the invariant.
2. Implement a separate owner-only bounded state file under XDG_STATE_HOME (fallback documented). Reject corrupt/unknown-version data without overwriting it. Atomic write with temp file, fsync and rename; serialize cross-process read-modify-write using a lock with stale-lock recovery, so child/parent updates cannot clobber one another. Restrict file/directory permissions.
3. API: create, bind target, transition, get/list, reconcile missing stable tmux target to lost for nonterminal jobs, delivery bookkeeping compatible with future issues. Validate job identity and guard against reused tmux IDs. Retain active and undelivered terminal jobs; cap history of acknowledged terminal jobs, with explicit behavior if hard bound is reached.
4. Add focused tests: transitions, restart recovery, terminal immutability, corrupt/unknown state, concurrent update contention, atomic write failure, permissions, retention, stale target reconciliation. Run npm test and npm run build.
5. Commit changes on this worktree branch, push, create a PR referencing #1 (do not auto-close until review/merge). Report PR URL, tests and unresolved limitations. Do not merge or close the issue; parent will independently review and decide.

## Implemented decisions (issue #1)

- `tmuxSessionId`/`tmuxPaneId` are `string | null`: `created` jobs may exist unbound, and binding is required before `starting`/`running`. This resolves the plan's creation-ordering question.
- Added an optional `serverIdentity` (tmux `pid:start_time`) captured at bind time so reconcile can distinguish a live target from a reused tmux ID on a restarted server.
- Delivery bookkeeping uses a registry-global monotonic `completionSeq` assigned on the first terminal transition plus `notifiedAt` acknowledgement, giving retry-safe at-least-once delivery.
- Retention: active + undelivered jobs are never evicted; acknowledged terminal history is capped (default 100) and creation fails with a clear error at the absolute hard bound (default 500) instead of dropping live data.
- The existing tmux target registry (`src/registry.ts`) is untouched.
