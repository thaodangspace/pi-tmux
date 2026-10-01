# Issue #2 report — Pi child completion reporter

Repo: `thaodangspace/pi-tmux` · Branch: `issue-2-child-reporter` · Issue: #2 (P0: Add Pi child completion reporter using `agent_settled`)

## Summary

Added a packaged, opt-in child-only Pi reporter extension that validates explicit job metadata, moves a parent-created job `starting -> running` on `session_start`, and on `agent_settled` derives the outcome from Pi's structured lifecycle data, writes a bounded completion payload, and moves `running -> completed|failed`. It never starts children, notifies the parent, runs GitHub/workflow logic, kills its tmux session, or infers success from pane text. The durable `SubagentJobRegistry` (issue #1) is the single source of truth in every failure mode.

## Changed files

| File | Change |
|---|---|
| `src/subagent-reporter.ts` | New. Env parsing/validation, `ChildReporter` state machine, immutable unique completion payloads, recursive-delegation guards. |
| `extensions/child-reporter.ts` | New. Packaged child-only extension; wires `session_start`, `turn_end`, `agent_before_settle`, `agent_end`, `agent_settled`. |
| `test/subagent-reporter.test.ts` | New. 16 tests: success, failure, invalid metadata, duplicate settle, terminal races, persistence failure, payload-overwrite race, loop guards, extension wiring. |
| `src/tmux.ts` | Minimal fix for the pre-existing red CI (see below): stop `unref()`-ing the timeout/force-kill timers. |
| `package.json` | Announced the reporter as `pi.childReporter`; `pi.extensions` still lists only `extensions/index.ts`, so it is not auto-loaded. |
| `README.md` | New "Pi child completion reporter" section: env/launch contract, lifecycle, bounded payload, failure/recovery semantics, payload-winner race rule. |
| `skills/tmux-subagent/SKILL.md` | Nested-Pi step now points at the reporter and the ancestors guard. |
| `ISSUE-2-PLAN.md`, `ISSUE-2-REPORT.md` | Plan followed; this report. |

## Contract implemented

Environment (documented in README):

- `PI_TMUX_SUBAGENT_JOB_ID` (required) — the only job the reporter touches.
- `PI_TMUX_SUBAGENT_STATE` (required) — absolute path to the job registry file.
- `PI_TMUX_PARENT_SESSION_ID` (conditional) — must match the job when the job records a parent.
- `PI_TMUX_SUBAGENT_ANCESTORS` (optional) — lineage guard; the reporter refuses when its own job id appears and appends its id for descendants.

Behavior:

- `session_start`: parse/validate metadata → reject missing/partial/invalid without mutating any job → job must exist, be bound, be `starting`/`running`, and match parent + `TMUX_PANE` identity → transition `starting -> running` (idempotent; a terminal job makes the reporter passive).
- `agent_settled`: derive outcome from `agent_before_settle`/`turn_end` structured outcome (`error`/`aborted` → `failed`; no observed outcome → `failed`), write `PiSubagentCompletionV1` atomically, then transition `running -> completed|failed`.

## Review blocker: completion payload write ordering/races (addressed)

The original `settle()` wrote a deterministic `<jobId>.json` **before** `registry.transition`, so a duplicate/concurrent reporter, a retry, or a cancellation between the pre-check and the transition could overwrite a terminal job's payload even when the transition was rejected, and two attempts with different outcomes could fight over one file.

Fix:

- Every attempt writes its own **immutable unique filename**: `<jobId>.<uuid>.json`.
- The transition carries `resultPath`; `settle()` reads the durable winner back from the `transition()` return value, so `settleResult.resultPath` (and the ignored/passive paths) always names the winning file, never a losing attempt.
- A losing/duplicate attempt discards its own now-unreferenced payload best-effort. It never touches the winner's file.
- Terminal outcomes stay immutable: an identical same-status transition is a registry no-op that returns the earlier winner; a different status is rejected and treated as a terminal race.

Race tests added:

- `a second reporter never overwrites the winning completion payload` — sequential winner then loser with a different outcome; asserts the winner's file is byte-for-byte unchanged, `job.resultPath` still points at it, only one report file remains, and the loser surfaces the durable path.
- `concurrent duplicate reporters converge on exactly one winning payload` — `Promise.all` of two settles with different outcomes; asserts the registry's `resultPath` payload status equals the durable status and exactly one payload file remains.

## CI red: baseline evidence and minimal fix

`main` CI has been **red on every run since the repository's first commit**, unrelated to this branch. Identical failure signature on baseline:

| Run | Branch/commit | Result | Failing tests |
|---|---|---|---|
| 36551534984 | `main` @ `290f5e4` (Initial pi-tmux extension) | failure | `test/tmux.test.ts` "timeout and abort…" + cancelled next test |
| 36552587131 | `main` @ `c65209c` | failure | same |
| 36564997514 | `main` @ `a6654e8` | failure | same |
| 36804390655 | `main` @ `17a2c33` (merge of #1) | failure | same |

Baseline log excerpt (`gh run view 36804390655 --log-failed`): `✖ timeout and abort terminate child processes with actionable errors` → `'Promise resolution is still pending but the event loop has already resolved'`, then `✖ rejects invalid argv before spawning` cancelled. This is the same failure seen on PR #6.

Root cause (pre-existing, not introduced by issue #2): `src/tmux.ts` called `timer.unref?.()` and `forceTimer.unref?.()`. With a fake child that has no live OS handle (as in the unit test), an unref'd 10 ms timeout does not keep the event loop alive, so Node's test runner drains the loop and fails the pending promise before the timeout fires. Local machines happened to have other handles keeping the loop alive past 10 ms, masking it.

Minimal fix: removed the two `unref()` calls. The timers are short and cleared by `cleanup()` on every settle, so this only guarantees an in-flight tmux operation can actually reach its own timeout/cancel; a real tmux child already keeps the loop alive. No test logic or production semantics otherwise change.

Local verification after the fix: `npm run typecheck` exit 0; `npm test` exit 0 with **58 tests pass, 0 fail**; the isolated `test/tmux.test.ts` is stable across 3 consecutive runs.

## Verification (exit status)

```
npm run typecheck   # TYPECHECK_EXIT=0
npm test            # TEST_EXIT=0
# ℹ tests 58  pass 58  fail 0  cancelled 0  skipped 0  (~6.7s)
```

The 16 reporter tests cover: env parsing, `starting -> running` + completion payload, repeated settle idempotency, cancellation/terminal races, structured failure derivation, invalid metadata/identity mismatch without mutation, self-parent and ancestor-cycle guards, unbound/corrupt state, registry-write and payload-write failure (fail closed), unrelated-job isolation, payload-overwrite race (sequential + concurrent), explicit size bounds, and end-to-end extension wiring including duplicate `agent_settled`.

## What this does not do (non-goals per issue)

- No parent-side notification/wakeup and no child process launching (future parent-side work).
- No GitHub/workflow logic and no self-kill of the tmux session in the child.
- No pane-output heuristics; completion is `agent_settled` + structured lifecycle outcome only.

## Unresolved issues / follow-ups

1. Parent-side launcher still pending. It must populate the env contract, resolve the reporter path (`pi.childReporter` / `<package>/extensions/child-reporter.ts`), and honor `PI_TMUX_SUBAGENT_ANCESTORS` by never reusing an ancestor job id.
2. Pane binding is best-effort when `TMUX_PANE` is absent; documented and covered by the injectable `enforcePaneBinding` option.
3. Fail-closed recovery leaves the job `running` when both the payload and the registry write fail. `reconcile()` only marks a job `lost` when its tmux target disappears, so a still-alive pane could remain `running` until a parent-side timeout policy exists.
4. The completion payload is a separate file referenced by `job.resultPath`; the `SubagentJobV1` schema was intentionally left unchanged.
5. `pi.childReporter` is an extra manifest field for discovery only. Verified Pi's manifest reader (`dist/core/pi-manifest.js`) reads only `extensions`/`skills`/`prompts`/`themes` and ignores unknown keys.
6. The CI fix touches pre-existing `src/tmux.ts`. It is a behaviour-preserving robustness fix for a latent no-settle bug; flagging it because it is outside the reporter's own files and reviewers may want to split it.

## PR

URL: https://github.com/thaodangspace/pi-tmux/pull/6 (base `main`, head `issue-2-child-reporter`; not merged; issue #2 left open).

CI on the correction commit `a021595` is **green**: run [36805723859](https://github.com/thaodangspace/pi-tmux/actions/runs/36805723859) (`test` pass, 36s) and the push run `36805719997` (`test` pass, 28s). Baseline `main` remains red for the pre-existing reason documented above; a doc-only follow-up commit re-runs CI on this branch.
