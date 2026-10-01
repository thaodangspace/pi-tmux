# Issue #12 report — generic subagent session/turn tools with Pi compatibility

- Issue: https://github.com/thaodangspace/pi-tmux/issues/12
- Branch: `issue-12-generic-tools`
- Plan: `ISSUE-12-PLAN.md` (followed; the Pi session-mode reporter was added as
  required to let Pi run through the generic surface)

## Summary

Issue #12 asked for a stable, agent-neutral, parent-scoped tool surface over the
session/turn lifecycle (create a logical subagent, run resumable turns, inspect
state, cancel active work, close the session) while keeping the one-shot Pi job
API working.

This change adds:

1. **`tmux_subagent_create` / `run` / `status` / `cancel` / `close`** in the
   packaged extension. They name no agent, expose no executable/argv/shell field,
   and dispatch to a registered `AgentAdapter` by the bounded `agent` enum.
2. **Session-scoped controller operations** (`createSession`, `statusSession`,
   `cancelTurn`, `closeSession`) on the existing generic `SubagentController`,
   reusing its durable binding, provenance, reconciliation, and fail-closed kill
   rules instead of adding parallel state.
3. **`src/generic-subagent.ts`**, an owner-scoped facade that keeps one
   `SubagentController` per agent over the shared `SubagentSessionRegistry`.
4. **Pi session-mode completion** (`src/turn-reporter.ts`) so a reusable Pi
   session reports each turn into the session/turn registry; the packaged
   `extensions/child-reporter.ts` now selects job vs session mode from launch
   metadata.
5. **`PI_TMUX_AGENT_SPECS`** config-driven `RunnerAdapter`s so a deployer can
   enable `claude-code`/`opencode` without a model-facing command; tests inject
   fake adapters through the same tool surface.
6. Tests (unit + isolated real-tmux end-to-end) and updated skill/README docs.

The one-shot Pi contract (`tmux_subagent_start_pi`, `SubagentJobV1`, the child
reporter, `CompletionDelivery`) is unchanged; `tmux_subagent_status`/`cancel`
accept `jobId` (legacy) or `sessionId` (generic), which is explicit rather than a
silent ID reinterpretation.

## Design

### Tools

| Tool | Input | Output |
|---|---|---|
| `tmux_subagent_create` | `{ agent, cwd, name?, parent?, model?, thinking? }` | `{ sessionId, agent, status, tmuxSessionId, name, cwd, owner }` |
| `tmux_subagent_run` | `{ sessionId, task, model?, thinking? }` | `{ sessionId, turnId, status, tmuxSessionId, tmuxPaneId, turnIndex }` |
| `tmux_subagent_status` | `{ sessionId, turnId? }` or `{ jobId }` | durable session + turns (or legacy job) |
| `tmux_subagent_cancel` | `{ sessionId, turnId? }` or `{ jobId }` | turn/ job cancelled, `targetRemoved` |
| `tmux_subagent_close` | `{ sessionId }` | session `stopped`, `targetRemoved` |

`create` provisions the logical session and its dedicated inert tmux session but
starts no turn; `run` adds and launches one turn in a new window of that session.
A terminal turn returns the session to `idle`, and the next `run` resumes the same
native conversation through `agentSessionId`.

### Ownership, cancellation, close

- Every operation resolves the session first and refuses (`invalid_target`) when
  `parentPiSessionId` differs; the registry re-checks ownership on each mutation.
- `run` rejects a second active turn; the durable registry enforces it even under
  concurrency.
- `cancel` transitions the active turn to `cancelled` and removes its pane only
  when the exact pane is verified inside the exact recorded session on the exact
  recorded tmux server. Otherwise it fails closed and kills nothing.
- `close` cancels any active turn, transitions the session to `stopped`, and kills
  only the verified `$N` boundary. Idempotent once terminal.
- `status` reconciles active turns/sessions against a live tmux view, owner-scoped,
  and never inspects pane output.

### Pi through the generic surface

`PiAdapter.prepareTurn` now emits `PI_TMUX_CHILD_REPORTER_MODE=session` plus the
logical `sessionId` when the controller reports `ledgerKind: "session"`.
`TurnReporter` (the session-mode sibling of `ChildReporter`) validates the bound
turn and pane, moves `starting -> running`, and on `agent_settled` writes the
bounded payload and moves the turn to `completed|failed`, returning the session to
`idle`. The existing one-shot job reporter is untouched.

### Completion delivery

`TurnCompletionDelivery` (issue #11) already emits the single
`pi-tmux:subagent-completed` event family with `agent`/`sessionId`/`turnId`,
`status`, `completionSeq`, `finishedAt`, and bounded `resultPath`/`error`. This
change wires the generic tools to the same owner-scoped, at-least-once delivery.

## Files

- `src/generic-subagent.ts` (new): owner-scoped agent-neutral facade.
- `src/turn-reporter.ts` (new): session-mode child completion reporter.
- `src/subagent-controller.ts`: `createSession`/`statusSession`/`cancelTurn`/
  `closeSession`, session ledger hooks, `ledgerKind` in the turn context.
- `src/subagent-ledgers.ts`: `listTurns`, `cancelTurn`, `transitionSession`;
  `cancelRun` no longer stops the session.
- `src/agent-adapter.ts`: optional `ledgerKind` on `AgentTurnContext`.
- `src/pi-adapter.ts`: session-mode reporter metadata.
- `src/subagent-reporter.ts`: `mode`/`session` env keys.
- `src/runner-adapter.ts`: explicit `validateOptions` (rejects unsupported
  model/thinking per the bounded-schema rule).
- `src/tools.ts`: the five generic tools, adapter/spec wiring, dual `jobId`/
  `sessionId` compatibility, structured failure helper.
- `extensions/index.ts`: shares the session registry with tool registration.
- `extensions/child-reporter.ts`: selects job vs session reporter by metadata.
- `test/turn-reporter.test.ts`, `test/generic-subagent.test.ts`,
  `test/generic-tools.test.ts`, `test/generic-tools-integration.test.ts` (new).
- `test/pi-adapter.test.ts`: session-mode contract test.
- `test/pi-subagent-integration.test.ts`: deterministic waits for the existing
  fake-Pi outputs (removes a pre-existing read race exposed by more test files).
- `README.md`, `skills/tmux-subagent/SKILL.md`: preferred orchestration and the
  manual pane escape hatch.

## Verification

Run in this worktree after `npm ci`:

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | 0 | clean |
| `npm test` (`tsx --test`) | 0 | 201 tests, 201 pass, 0 fail (179 pre-existing + 22 new) |

New coverage:

- turn reporter: attach `starting -> running`, bounded completion + payload,
  session returns to `idle`, native id stored, fail-closed with no outcome,
  wrong pane / owner / metadata rejection, passive terminal, recursive lineage,
  self-parent, cancellation-after-attach;
- generic controller: create (no turn) + run (turn), concurrent-turn rejection,
  A→B turn reuse, agent/cwd/adapter-option validation, ownership isolation on
  every operation, verified-pane cancel leaving the session reusable, fail-closed
  cancel on a restarted server, lost reconciliation, close (cancel + stop + only
  verified session killed);
- generic tools: registration and no executable/argv/command schema fields, full
  fake Claude Code and fake OpenCode lifecycles through the real tool surface,
  unconfigured-agent and invalid-option failures, cross-conversation refusal,
  legacy `jobId` routing and mutual-exclusion errors;
- isolated real-tmux end-to-end: a fake Claude Code agent behind a `RunnerAdapter`
  driven through `create/run/status/close`, durable structured completion
  delivered with distinct agent/session/turn identity, second-turn reuse; and a
  fake Pi child launched through the generic tools with the session-mode reporter
  contract verified on the wire.

## Decisions and limitations

- **Decision — reuse the controller, not a parallel stack.** Session operations
  were added to `SubagentController` and the existing session ledger; there is no
  second lifecycle implementation and no duplicate tmux semantics.
- **Decision — explicit compatibility, not ID reuse.** The legacy Pi job tools
  keep their `SubagentJobV1` records and the `jobId` parameter; the generic tools
  use `sessionId`. The two are never conflated.
- **Decision — config-driven external agents.** `claude-code`/`opencode` are
  enabled by a deployer-supplied `RunnerSpecV1` (no shipped flags), so the runner
  never guesses a CLI version; tests inject fake adapters through the same
  surface.
- **Limitation — no concrete Claude Code / OpenCode adapter.** As in #13/#14,
  this change ships the boundary and the config hook, not the CLI flag sets.
- **Limitation — one active turn per session (v1).** Concurrency within one
  logical session is intentionally rejected, matching the registry.
- **Limitation — Pi session mode still uses the child reporter.** A generic Pi
  turn is completed by the packaged reporter (`agent_settled`), so it requires the
  real Pi runtime end to end; the unit/integration tests cover the reporter and
  the launch contract directly.

## PR

PR URL: _see below / recorded after opening._
