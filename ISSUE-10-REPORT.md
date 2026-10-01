# Issue #10 report — generic `AgentAdapter` / `SubagentController`, Pi as first adapter

- Issue: https://github.com/thaodangspace/pi-tmux/issues/10
- Branch: `issue-10-generic-controller`
- Plan: `ISSUE-10-PLAN.md` (followed)

## Summary

Issue #10 asked to stop conflating generic tmux/job lifecycle with Pi launch
behavior in `src/pi-subagent.ts`. The launcher was split into:

1. a generic `SubagentController` that owns every tmux and durable-lifecycle
   behavior, parameterized only by an `AgentAdapter` and a durable
   `SubagentLedger`; and
2. a `PiAdapter` that owns every Pi-specific decision.

`PiSubagentController` is now a thin façade over `SubagentController` +
`PiAdapter` + `JobSubagentLedger`, so the public Pi tools
(`tmux_subagent_start_pi`, `tmux_subagent_status`, `tmux_subagent_cancel`), the
durable `SubagentJobV1` records, and the documented child-reporter environment
contract are unchanged.

## Design

### Generic controller (`src/subagent-controller.ts`)

Owns, with no agent-specific assumptions:

- dedicated detached, inert tmux execution target (the startup gate) before the
  child can start;
- stable `$N`/`%N` binding and the required tmux `serverIdentity`;
- best-effort parent provenance recording;
- `status` reconciliation of a vanished/re-used target against a live tmux view,
  scoped to one owner;
- fail-closed `cancel` that kills only a positively re-verified target;
- bounded startup liveness probing;
- the runtime-generic recursion-depth guard.

Two tmux strategies exist, selected by the ledger, not by the agent name:
`respawn-pane` (one run per tmux session, used by the job ledger) and
`host-window` (a persistent host session with one window per turn, used by the
session ledger).

### Adapter boundary (`src/agent-adapter.ts`, `src/pi-adapter.ts`)

`AgentAdapter` exposes `preflight` (resolve executable/reporter, validate
agent-specific options), `prepareTurn` (constant `command` + environment +
completion strategy), and optional `validateOptions`/`lineage`. `PiAdapter` is
the only place Pi CLI arguments, the packaged child reporter, model/thinking
validation, the reporter environment contract, and the native `agent_settled`
completion strategy live. `AgentAdapterRegistry` is the single dispatch point.

The task is never shell-interpolated: it is set as a tmux environment value and
referenced as a quoted expansion inside a constant command string.

### Durable ledgers (`src/subagent-ledgers.ts`)

- `JobSubagentLedger` wraps `SubagentJobV1` (the live Pi path).
- `SessionSubagentLedger` wraps the issue #9 `SubagentSessionV1` /
  `SubagentTurnV1` registry and backs the controller's `runTurn`, which executes
  a successive turn on one logical session. The registry enforces one active turn
  at a time and a terminal turn returns the session to `idle`.

### Completion event

The single parent event family (`pi-tmux:subagent-completed`) is kept. Its
`details` now also carry optional `agent`/`sessionId`/`turnId` identity; for a
one-run job all three equal the `jobId`, so existing consumers are unchanged.

## Files

- `src/subagent-controller.ts` (new): `SubagentController`, `SubagentLedger`,
  agent-neutral run/session records, `detectParentSession`, `resolveExecutable`.
- `src/agent-adapter.ts` (new): `AgentAdapter`, `AgentLaunchSpec`,
  `AgentAdapterRegistry`, adapter context types.
- `src/pi-adapter.ts` (new): `PiAdapter`, Pi env/commands, reporter path.
- `src/subagent-ledgers.ts` (new): job and session/turn ledger adapters.
- `src/pi-subagent.ts` (refactor): thin compatibility façade; exports preserved.
- `src/completion-delivery.ts`: additive `agent`/`sessionId`/`turnId` details.
- `test/subagent-controller.test.ts` (new): fake-adapter controller tests.
- `test/pi-adapter.test.ts` (new): Pi adapter transmission/reporter tests.
- `test/completion-delivery.test.ts`: one expected-details update.
- `README.md`: documents the controller/adapter boundary.
- `ISSUE-10-REPORT.md` (this file).

## Verification

Run in this worktree after `npm ci`:

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | 0 | clean |
| `npm test` (`tsx --test`) | 0 | 149 tests, 149 pass, 0 fail (132 pre-existing + 17 new) |

New tests cover: fake-adapter launch with a literal-metacharacter task and no Pi
runtime; the startup gate (child only sees a bound, `starting` run); status
reconciliation and owner isolation; unreachable-server status; fail-closed cancel
(identity changed/missing, pane reuse) and cancel idempotency; preflight failure
before any tmux session; invalid input/depth rejection before tmux; fast-terminal
completion; a full A-to-completion-then-B turn sequence on one logical session
with no concurrent turn; one-shot ledgers rejecting `runTurn`; Pi adapter literal
task transmission and reporter env contract; model/thinking validation; preflight
resolution/fail-closed; lineage inheritance; adapter registry dispatch.

## Decisions and limitations

- **Decision — preserve the live Pi contract.** Pi still uses `SubagentJobV1`
  through `JobSubagentLedger`; the generic controller is the only lifecycle path,
  so there is no separate legacy launcher. `SessionSubagentLedger` is wired and
  tested for multi-turn, but no shipped tool exposes it yet.
- **Limitation — no Claude Code / OpenCode adapter.** This change adds the
  boundary and the first adapter; other agents are follow-ups.
- **Limitation — no parent tool for successive turns.** `SubagentController.runTurn`
  and `SessionSubagentLedger` support it (tested), but the Pi tools remain
  one-shot, and completion delivery still observes the job registry.
- **Limitation — `host-window` multi-turn keeps a persistent host pane.** A
  session survives completed turns by keeping its initial inert pane; cancel
  stops the whole session.

## PR

PR URL: https://github.com/thaodangspace/pi-tmux/pull/17
