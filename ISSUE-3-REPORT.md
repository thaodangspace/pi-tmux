# Issue #3 report — first-class Pi subagent start/status/cancel tools

Repo: `thaodangspace/pi-tmux` · Branch: `issue-3-pi-subagent` · Issue: #3 (P0: Add first-class Pi subagent start/status/cancel tools)

## Summary

Added the parent-side launcher for delegated Pi subagents on top of the durable `SubagentJobV1` registry (#1) and the packaged child completion reporter (#2):

- `tmux_subagent_start_pi` — creates a durable job, creates and owns a dedicated detached tmux session, binds stable `$N`/`%N` IDs and `serverIdentity`, launches the child Pi with the packaged reporter, delivers the task without shell interpolation, and returns immediately with `{ jobId, status, tmuxSessionId, tmuxPaneId }`. The session starts inert and Pi is started only after the durable bind + `starting` transition (startup gate).
- `tmux_subagent_status` — returns durable lifecycle state only (never pane text); reconciles an obviously vanished target to `lost` when the tmux server is reachable.
- `tmux_subagent_cancel` — cancels exactly one known job and kills the tmux session only when the exact recorded pane is present in the exact recorded session on the exact recorded server; otherwise it fails closed (no kill) and stays idempotent once terminal.

All three are additive; the generic `tmux_*` tools are unchanged.

## Changed files

| File | Change |
|---|---|
| `src/pi-subagent.ts` | New. `PiSubagentController` (start/status/cancel), safe launch contract, startup gate (inert placeholder + `respawn-pane`), required server identity, completed-aware startup probe, fail-closed cancel verification, PATH resolver, provenance, lineage guard. |
| `src/tools.ts` | Registered the three subagent tools; `registerTmuxTools` gained an optional injection `options` (jobs/targets/controller settings). Moved `detectParentSession` here-to-there; extended `toolError` with `jobId`. Generic tools untouched. |
| `test/pi-subagent.test.ts` | New. 22 controller tests (spawn success, deterministic startup-gate readiness, fast-completed status, required server identity, safe task delivery, missing binary/reporter, early exit, bind failure cleanup, status reconcile/unavailable, cancel verified/fail-closed/idempotence, ownership, lineage/depth, invalid input). |
| `test/subagent-tools.test.ts` | New. 6 tool-wiring tests: registration, backward-compatible generic tools, structured failures, ownership scoping, terminal idempotence. |
| `test/pi-subagent-integration.test.ts` | New. 4 tests on an isolated tmux socket with a fake `pi`: byte-for-byte task delivery with shell metacharacters, first-read startup-gate readiness, cancel by stable ID, early-exit cleanup, missing binary. |
| `test/pi-cli-args.test.ts` | New. 1 test that runs the real `pi` CLI (skipped when absent) and proves `-p -- <task>` treats the task as a message, not an option. |
| `README.md` | New "Pi subagent tools (parent side)" section; updated Tools list and the job-registry/launch-contract notes. |
| `skills/tmux-subagent/SKILL.md` | Pi path now prefers the structured tools; manual `tmux_send_text` flow retained for Claude Code/Codex/OpenCode; verification unchanged. |
| `ISSUE-3-PLAN.md`, `ISSUE-3-REPORT.md` | Plan followed; this report. |

## Safety properties

- **No shell interpolation of the task.** The tmux session runs one constant command, `exec "$PI_TMUX_PI_BIN" --extension "$PI_TMUX_CHILD_REPORTER" --mode json -p -- "$PI_TMUX_SUBAGENT_TASK"`. The task, paths, and metadata travel through `tmux respawn-pane -e NAME=VALUE` and are expanded *inside double quotes*; the shell cannot re-interpret them. The integration test proves a task containing `touch <marker>`, `$(whoami)`, backticks, quotes, `;`, and newlines is delivered byte-for-byte and never executed.
- **Startup gate.** The session starts inert (`exec sleep 3600`) and Pi is launched only by `respawn-pane` after the durable bind + `starting` transition. A fast reporter's `session_start` can never race a `created`/unbound job. Covered by a deterministic unit test (reads the job status at respawn time) and a real-tmux test where the child records its first registry read.
- **Reporter always loaded.** The child command always passes the packaged `extensions/child-reporter.ts`, and the job/parent/ancestor/state env contract is populated by the launcher.
- **Approvals/sandbox preserved.** Only `--extension`, `--mode json`, `-p`, and the safe `--model`/`--thinking` selections are passed. No `--approve`/`--no-approve`, tool allow/deny lists, or sandbox-disabling flags. The real `pi` CLI was verified to accept `-p -- <task>` (task treated as a message, not an option).
- **Stable-ID mutations.** Every tmux mutation addresses the recorded `$N`/`%N` IDs; names are never sufficient.
- **Fail-closed cancel.** Cancel kills the session only when the exact recorded pane is present in the exact recorded session *and* the recorded `serverIdentity` equals the current one. Missing pane, pane in another session, or unknown/changed server identity → the job is still cancelled but no target is killed.
- **Ownership.** Status/cancel refuse a job whose `parentPiSessionId` is not the calling Pi conversation; start always creates its own session and never binds a human-owned pane.
- **Recursive delegation.** The launcher appends this process's own job ID to `PI_TMUX_SUBAGENT_ANCESTORS` (which the reporter refuses to appear in) and refuses a chain deeper than the configured bound (default 8).
- **No leaked sessions.** Missing binary/reporter fails the durable job before tmux; create/bind/start failures and the bounded startup probe kill the just-created session and fail the job.

## Verification (exit status)

```
npm run typecheck   # TYPECHECK_EXIT=0
npm test            # TEST_EXIT=0
# ℹ tests 91  pass 91  fail 0  cancelled 0  skipped 0  (~8s; local machine has pi installed)
npm pack --dry-run  # PACK_EXIT=0
```

The pre-existing 58 tests still pass unchanged (backward-compatible generic tools); 33 new tests were added. The real-Pi CLI test is skipped where `pi` is not installed (CI), giving 90 pass + 1 skipped there.

## Parent review fixes (round 2)

1. **Startup race (child could start before bind/`starting`).** The tmux session is now created running an inert `exec sleep 3600` placeholder; the parent binds the job and moves it `created -> starting`, and only then replaces the pane process with the real launch command via `tmux respawn-pane -k` (same stable `%N` pane ID). Pi therefore cannot start until the durable state is ready. Tests: a unit test captures the job status at respawn time and asserts `starting` + bound IDs, plus a real-tmux test where a Node child reads the registry on its first line and records `starting`.
2. **Cancel could kill reused/unrelated IDs.** Cancel now kills only when it can positively verify the exact recorded pane is present in the exact recorded session *and* the recorded `serverIdentity` equals the current server's. Otherwise the job is marked `cancelled` but the tmux target is left untouched (fail closed). Added mismatch tests: pane in another session, pane missing while the session is live, job without a recorded server identity, changed server identity, and unavailable current server identity.
3. **Real Pi CLI `-p --`.** Verified against the installed `pi` (0.99.2): `pi --offline --model __pi_tmux_none__/__pi_tmux_none__ -p -- "--help"` exits 1 with a model-not-found error and no help text, while the same command without `--` prints the help usage (exit 0). This proves `-p` is boolean and `--` ends option parsing so the task is a message; it performs no model call. Captured as `test/pi-cli-args.test.ts` (skipped when `pi` is absent).

## Parent review fixes (round 3)

1. **Fast successful child was reported as a start failure.** After the startup probe sees the pane gone, `start` now re-reads the durable job. A terminal `completed` job is returned as success with `status: "completed"` (not `failed`), and its already-gone session is neither killed nor failed. Any other non-terminal disappearance still fails the job and cleans up. Deterministic test: `start reports the actual completed status when a fast child settles before the probe` (the fake registry transitions `starting -> running -> completed` and removes the session at respawn, then asserts `ok: true`, `status: "completed"`, and zero kills).
2. **`serverIdentity` is now required before launch.** Because cancel can only kill a target it can positively identify, start derives the server identity after creating the session and, if it is unavailable, kills the just-created session and fails the job `unavailable` instead of launching an unkillable job. Test: `start fails (and cleans up) when the tmux server identity is unavailable`.

## Non-goals (per issue)

- No parent wakeup/notification when the child completes.
- No synchronous wait for completion (start returns after a short bounded startup probe only).
- No Claude/Codex/OpenCode structured support (manual skill flow remains).
- No workflow DAG/fan-in/fan-out semantics.

## Unresolved issues / follow-ups

1. `start` performs a bounded startup liveness probe (default 3 × 150 ms) so an immediate crash is caught; this is a short startup check, not a wait for completion, but it is the only synchronous delay in `start`.
2. Status reconciliation marks `lost` only when the target is gone or the server identity changed; a still-alive pane that will never settle stays `running` until a parent-side timeout policy exists (same as #2's note).
3. The optional CLI surface is intentionally limited to `model`/`thinking`; no free-form Pi arguments are accepted, so no additional approval/sandbox flags can be injected.
4. `SubagentJobV1` was left unchanged (no `name` field); the readable name is used for the tmux session name and recorded in the provenance registry.

## PR

URL: https://github.com/thaodangspace/pi-tmux/pull/7 (base `main`, head `issue-3-pi-subagent`). References #3 without a closing keyword. Not merged; issue #3 left open for review.
