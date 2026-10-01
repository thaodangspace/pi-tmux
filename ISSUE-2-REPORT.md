# Issue #2 report — Pi child completion reporter

Repo: `thaodangspace/pi-tmux` · Branch: `issue-2-child-reporter` · Issue: #2 (P0: Add Pi child completion reporter using `agent_settled`)

## Summary

Added a packaged, opt-in child-only Pi reporter extension that validates explicit job metadata, moves a parent-created job `starting -> running` on `session_start`, and on `agent_settled` derives the outcome from Pi's structured lifecycle data, writes a bounded completion payload, and moves `running -> completed|failed`. It never starts children, notifies the parent, runs GitHub/workflow logic, kills its tmux session, or infers success from pane text. The durable `SubagentJobRegistry` (issue #1) is the single source of truth in every failure mode.

## Changed files

| File | Change |
|---|---|
| `src/subagent-reporter.ts` | New. Env parsing/validation, `ChildReporter` state machine, completion payload writer, recursive-delegation guards. |
| `extensions/child-reporter.ts` | New. Packaged child-only extension; wires `session_start`, `turn_end`, `agent_before_settle`, `agent_end`, `agent_settled`. |
| `test/subagent-reporter.test.ts` | New. 14 tests: success, failure, invalid metadata, duplicate settle, terminal races, persistence failure, loop guards, extension wiring. |
| `package.json` | Announced the reporter as `pi.childReporter`; `pi.extensions` still lists only `extensions/index.ts`, so it is not auto-loaded. |
| `README.md` | New "Pi child completion reporter" section: env/launch contract, lifecycle, bounded payload, failure/recovery semantics. |
| `skills/tmux-subagent/SKILL.md` | Nested-Pi step now points at the reporter and the ancestors guard. |
| `ISSUE-2-PLAN.md` | The plan followed (pre-existing, now committed). |

## Contract implemented

Environment (documented in README):

- `PI_TMUX_SUBAGENT_JOB_ID` (required) — the only job the reporter touches.
- `PI_TMUX_SUBAGENT_STATE` (required) — absolute path to the job registry file.
- `PI_TMUX_PARENT_SESSION_ID` (conditional) — must match the job when the job records a parent.
- `PI_TMUX_SUBAGENT_ANCESTORS` (optional) — lineage guard; the reporter refuses when its own job id appears and appends its id for descendants.

Behavior:

- `session_start`: parse/validate metadata → reject missing/partial/invalid without mutating any job → job must exist, be bound, be `starting`/`running`, and match parent + `TMUX_PANE` identity → transition `starting -> running` (idempotent; a terminal job makes the reporter passive).
- `agent_settled`: derive outcome from `agent_before_settle`/`turn_end` structured outcome (`error`/`aborted` → `failed`; no observed outcome → `failed`), write `PiSubagentCompletionV1` atomically, then transition `running -> completed|failed`.

## Verification (exit status)

```
npm run typecheck   # TYPECHECK_EXIT=0
npm test            # TEST_EXIT=0
# ℹ tests 56  pass 56  fail 0  skipped 0  (6.5s)
```

The 14 new reporter tests cover: env parsing, `starting -> running` + completion payload, repeated settle idempotency, cancellation/terminal races, structured failure derivation, invalid metadata/identity mismatch without mutation, self-parent and ancestor-cycle guards, unbound/corrupt state, registry-write and payload-write failure (fail closed), unrelated-job isolation, explicit size bounds, and end-to-end extension wiring including duplicate `agent_settled`.

## What this does not do (non-goals per issue)

- No parent-side notification/wakeup and no child process launching (future parent-side work).
- No GitHub/workflow logic and no self-kill of the tmux session in the child.
- No pane-output heuristics; completion is `agent_settled` + structured lifecycle outcome only.

## Unresolved issues / follow-ups

1. Parent-side launcher still pending. It must populate the env contract and resolve the reporter path (`pi.childReporter` / `<package>/extensions/child-reporter.ts`), and must honor `PI_TMUX_SUBAGENT_ANCESTORS` by never reusing an ancestor job id.
2. Pane binding is best-effort: when `TMUX_PANE` is absent the reporter cannot confirm the pane and proceeds; documented and covered by an injectable `enforcePaneBinding` option. Tests set `TMUX_PANE` or pass the expected pane.
3. Fail-closed recovery leaves the job `running` when both the payload and the registry write fail. `reconcile()` only marks a job `lost` when its tmux target disappears, so a still-alive pane could remain `running` until a parent-side timeout policy exists.
4. The completion payload is a separate file referenced by `job.resultPath`; the `SubagentJobV1` schema was intentionally left unchanged (no `summary`/`childSessionId` fields added).
5. `pi.childReporter` is an extra manifest field for discovery only. Verified Pi's manifest reader (`dist/core/pi-manifest.js`) reads only `extensions`/`skills`/`prompts`/`themes` and ignores unknown keys, so this does not affect loading.

## PR

URL: https://github.com/thaodangspace/pi-tmux/pull/6 (base `main`, head `issue-2-child-reporter`; not merged; issue #2 left open).
