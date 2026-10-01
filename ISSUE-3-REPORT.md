# Issue #3 report — first-class Pi subagent start/status/cancel tools

Repo: `thaodangspace/pi-tmux` · Branch: `issue-3-pi-subagent` · Issue: #3 (P0: Add first-class Pi subagent start/status/cancel tools)

## Summary

Added the parent-side launcher for delegated Pi subagents on top of the durable `SubagentJobV1` registry (#1) and the packaged child completion reporter (#2):

- `tmux_subagent_start_pi` — creates a durable job, creates and owns a dedicated detached tmux session, binds stable `$N`/`%N` IDs and `serverIdentity`, launches the child Pi with the packaged reporter, delivers the task without shell interpolation, and returns immediately with `{ jobId, status, tmuxSessionId, tmuxPaneId }`.
- `tmux_subagent_status` — returns durable lifecycle state only (never pane text); reconciles an obviously vanished target to `lost` when the tmux server is reachable.
- `tmux_subagent_cancel` — cancels exactly one known job and kills only the stable tmux target recorded on it, refusing reused/unrelated targets and remaining idempotent once terminal.

All three are additive; the generic `tmux_*` tools are unchanged.

## Changed files

| File | Change |
|---|---|
| `src/pi-subagent.ts` | New. `PiSubagentController` (start/status/cancel), safe launch contract, PATH resolver, startup probe, provenance, lineage guard. |
| `src/tools.ts` | Registered the three subagent tools; `registerTmuxTools` gained an optional injection `options` (jobs/targets/controller settings). Moved `detectParentSession` here-to-there; extended `toolError` with `jobId`. Generic tools untouched. |
| `test/pi-subagent.test.ts` | New. 16 controller tests (spawn success, safe task delivery, missing binary/reporter, early exit, bind failure cleanup, status reconcile/unavailable, cancel identity/idempotence, ownership, lineage/depth, invalid input). |
| `test/subagent-tools.test.ts` | New. 6 tool-wiring tests: registration, backward-compatible generic tools, structured failures, ownership scoping, terminal idempotence. |
| `test/pi-subagent-integration.test.ts` | New. 3 tests on an isolated tmux socket with a fake `pi`: byte-for-byte task delivery with shell metacharacters, cancel by stable ID, early-exit cleanup, missing binary. |
| `README.md` | New "Pi subagent tools (parent side)" section; updated Tools list and the job-registry/launch-contract notes. |
| `skills/tmux-subagent/SKILL.md` | Pi path now prefers the structured tools; manual `tmux_send_text` flow retained for Claude Code/Codex/OpenCode; verification unchanged. |
| `ISSUE-3-PLAN.md`, `ISSUE-3-REPORT.md` | Plan followed; this report. |

## Safety properties

- **No shell interpolation of the task.** The tmux session runs one constant command, `exec "$PI_TMUX_PI_BIN" --extension "$PI_TMUX_CHILD_REPORTER" --mode json -p -- "$PI_TMUX_SUBAGENT_TASK"`. The task, paths, and metadata travel through `tmux new-session -e NAME=VALUE` and are expanded *inside double quotes*; the shell cannot re-interpret them. The integration test proves a task containing `touch <marker>`, `$(whoami)`, backticks, quotes, `;`, and newlines is delivered byte-for-byte and never executed.
- **Reporter always loaded.** The child command always passes the packaged `extensions/child-reporter.ts`, and the job/parent/ancestor/state env contract is populated by the launcher.
- **Approvals/sandbox preserved.** Only `--extension`, `--mode json`, `-p`, and the safe `--model`/`--thinking` selections are passed. No `--approve`/`--no-approve`, tool allow/deny lists, or sandbox-disabling flags.
- **Stable-ID mutations.** Every tmux mutation addresses the recorded `$N`/`%N` IDs; names are never sufficient.
- **Cancel identity checks.** Cancel verifies `serverIdentity` and that the recorded pane still belongs to the recorded session; a reused pane or changed server is refused with `invalid_target` and nothing is killed.
- **Ownership.** Status/cancel refuse a job whose `parentPiSessionId` is not the calling Pi conversation; start always creates its own session and never binds a human-owned pane.
- **Recursive delegation.** The launcher appends this process's own job ID to `PI_TMUX_SUBAGENT_ANCESTORS` (which the reporter refuses to appear in) and refuses a chain deeper than the configured bound (default 8).
- **No leaked sessions.** Missing binary/reporter fails the durable job before tmux; create/bind/start failures and the bounded startup probe kill the just-created session and fail the job.

## Verification (exit status)

```
npm run typecheck   # TYPECHECK_EXIT=0
npm test            # TEST_EXIT=0
# ℹ tests 83  pass 83  fail 0  cancelled 0  skipped 0  (~7.7s)
npm pack --dry-run  # PACK_EXIT=0
```

The pre-existing 58 tests still pass unchanged (backward-compatible generic tools); 25 new tests were added.

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
