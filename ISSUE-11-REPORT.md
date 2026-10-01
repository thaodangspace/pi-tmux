# Issue #11 report — generic packaged turn runner with structured completion

- Issue: https://github.com/thaodangspace/pi-tmux/issues/11
- Branch: `issue-11-generic-runner`
- Plan: `ISSUE-11-PLAN.md` (followed; the runner/adapter scope was refined as noted)

## Summary

Issue #11 asked for one packaged, agent-neutral runner that executes a single
turn of a non-Pi CLI agent inside the tmux execution boundary and reports
completion durably, without duplicating process-management logic per adapter.

This change adds:

1. **`src/turn-runner.ts`** — the generic runner (library + CLI). One process per
   turn: verifies the durable session/turn/pane/server binding, transitions the
   turn `starting -> running`, spawns the adapter-provided executable with
   `shell: false`, captures bounded structured JSON/NDJSON output,
   captures the agent-native session id, writes an immutable bounded completion
   payload, and applies the terminal turn transition atomically.
2. **`src/runner-adapter.ts`** — the finite, config-driven adapter boundary
   (`RunnerSpecV1`) that turns an agent launch/parse strategy into the constant
   tmux command and the runner environment contract. No Claude/OpenCode CLI
   construction is hard-coded anywhere.
3. **`src/turn-completion-delivery.ts`** — the session/turn analogue of the
   existing job completion-delivery loop, emitting the same
   `pi-tmux:subagent-completed` event family with distinct
   `agent`/`sessionId`/`turnId` identity.
4. Runner wiring in `extensions/index.ts` so the parent observes and acknowledges
   runner turns when an adapter is used.
5. Fake-executable unit tests plus one isolated-tmux end-to-end test.

Pi behavior is untouched: the Pi tools still use `SubagentJobV1` through
`JobSubagentLedger`, and the whole pre-existing suite passes unchanged.

## Design

### Runner (`src/turn-runner.ts`)

Process topology matches the issue:

```text
tmux server
  └─ subagent tmux session   (SubagentSessionV1 execution boundary)
       └─ runner             (src/turn-runner.ts, one process per turn)
            └─ agent process (claude/opencode, spawned with shell:false)
```

- `RunnerSpecV1` is ordinary, bounded data:
  `{ version, executable, args, env, output: "json"|"ndjson", prompt:
  "stdin"|"argv", parse? }`. The runner validates it again before any mutation;
  nothing that crosses the process boundary is a callback.
- **Verified target identity, fail-closed before mutation.** The runner requires
  `TMUX_PANE`, checks it equals the turn's durably bound `%N` pane, checks the
  turn belongs to the named session and owner, rejects a missing tmux binding,
  and compares the tmux server PID from `TMUX` with the recorded
  `serverIdentity`, so a restarted server that reused `%N` is refused.
- **No shell interpolation.** The task is a bounded environment value
  (`PI_TMUX_RUNNER_TASK`) handed to the child as exactly one argv element
  (`prompt: "argv"`) or on stdin (`prompt: "stdin"`). The child is spawned with
  `shell: false`. The runner strips its own `PI_TMUX_*` variables from the child
  environment so a nested runner cannot inherit another turn's identity.
- **Bounded capture and persistence.** stdout/stderr are tail-bounded
  (256 KiB / 64 KiB by default); the persisted payload bounds `summary`
  (4 KiB) and `error` (2 KiB) and caps the native session id at 512 bytes. Full
  transcripts and pane contents are never stored or inspected.
- **Structured completion only, fail-closed on truncation.** The outcome is
  derived from the child's exit code and its parsed JSON/NDJSON output
  (declarative `parse` dot-paths for `sessionId`/`text`/`error`/`isError`). A
  truncated stdout stream is rejected outright — the tail buffer cannot prove
  that earlier structured output was not dropped — and any malformed structured
  line, a missing executable, or a spawn error is `failed`. Success is never
  inferred from pane text.
- **Atomic launch ownership.** Before spawning, the runner atomically claims the
  turn via `SubagentSessionRegistry.claimTurn` (a durable compare-and-set under
  the registry lock). Two concurrently launched runners cannot both execute the
  same turn: the loser returns without spawning a child or writing a payload.
- **Atomic, immutable terminal transition.** The payload is written under a
  unique per-attempt filename, then `transitionTurn` is applied. A race that
  loses to a cancellation or a duplicate runner discards its own payload and
  returns passively; the winning `resultPath` is never overwritten. The native
  id is stored before the terminal transition, and `transitionTurn` returns the
  session to `idle`.
- **Recoverable failure.** If the runner is killed before recording a terminal
  outcome, the turn stays non-terminal and
  `SubagentSessionRegistry.reconcile` marks it `lost` when the pane is gone or
  the server identity changed.

### Adapter boundary (`src/runner-adapter.ts`)

`RunnerAdapter` implements `AgentAdapter`. `preflight` validates the spec,
resolves the agent executable (absolute path or bare PATH command to an absolute
path) and the packaged runner module, and serializes the resolved spec into the
tmux environment. `prepareTurn` returns the constant launch command
(`exec "$PI_TMUX_RUNNER_BIN" <flags> "$PI_TMUX_RUNNER_MODULE"`) plus the
per-turn session/turn/owner/task environment. Trusted runner flags are
single-quoted; caller text never enters the command.

Concrete Claude Code / OpenCode flag sets are deliberately not shipped: the skill
already documents those CLIs as examples that must not be assumed, so they are
deployer-supplied `RunnerSpecV1` data instead.

### Completion delivery (`src/turn-completion-delivery.ts`)

Mirrors `CompletionDelivery`: owner-scoped, reconciles active turns against a
live tmux view, delivers terminal turns via the shared `CompletionDeliverySink`,
and acknowledges durably after the attempt (redelivery is safe and
deduplicable by `(sessionId, turnId, completionSeq)`). Observation is held only
while a turn is active or undelivered — a long-lived `idle` session does not keep
a watcher open.

## Files

- `src/turn-runner.ts` (new): `RunnerSpecV1`, `validateRunnerSpec`,
  `parseRunnerInvocation`, `runTurn`, `runTurnCli`, `SubagentTurnCompletionV1`,
  bounds and `PI_TMUX_RUNNER_*` contract.
- `src/runner-adapter.ts` (new): `RunnerAdapter`.
- `src/turn-completion-delivery.ts` (new): `TurnCompletionDelivery`,
  `buildTurnCompletionEvent`.
- `extensions/index.ts`: observes/acknowledges runner turns per parent.
- `extensions/child-reporter.ts` / Pi path: unchanged.
- `test/turn-runner.test.ts` (new): 17 fake-executable tests.
- `test/runner-adapter.test.ts` (new): 4 tests.
- `test/turn-completion-delivery.test.ts` (new): 6 tests.
- `test/runner-integration.test.ts` (new): 1 isolated-tmux end-to-end test.
- `README.md`: documents the runner, adapter boundary, bounds, and recovery.
- `ISSUE-11-REPORT.md` (this file).

## Verification

Run in this worktree after `npm ci`:

| Command | Exit | Result |
| --- | --- | --- |
| `npm run build` (`tsc --noEmit`) | 0 | clean |
| `npm test` (`tsx --test`) | 0 | 179 tests, 179 pass, 0 fail (149 pre-existing + 30 new) |

Covered by the new tests:

- successful JSON result, durable bounded payload, native-id capture, session
  returns to `idle`;
- non-zero exit, explicit `is_error`, malformed output, NDJSON final-line parse;
- **truncated stdout fails closed** even when a valid-looking final line
  survives (regression), and oversized stderr is bounded and never persisted;
- prompt containing spaces, quotes, newlines, `;`, `$()`, and backticks,
  delivered verbatim on both transports, with a proven no-side-effect check and
  an executable path containing spaces (`shell: false`);
- runner killed mid-turn, leaving the turn recoverable and reconciling to `lost`;
- cancellation races; **duplicate concurrent runners: exactly one claims launch
  and spawns a child** (verified with a per-spawn log), the other returns
  passively; `claimTurn` compare-and-set semantics (idempotent token, owner
  isolation, terminal refusal);
- wrong pane/session/owner/server metadata failing closed without mutation;
- agent session id captured and resumed by a second turn on the same session;
- tmux server restart / stable-ID reuse protection (identity mismatch to `lost`);
- spec/invocation validation, missing executable, CLI exit codes, and an
  isolated private tmux server end-to-end run (controller -> runner -> fake
  agent -> durable completion -> second turn).

## Decisions and limitations

- **Decision — config-driven, not agent-specific.** The runner contains no
  Claude/OpenCode flags; adapters supply a validated `RunnerSpecV1`. This keeps
  the runner honest and lets future adapters ship as data.
- **Decision — fail closed on ambiguous output.** A truncated stdout stream
  fails the turn outright, and any malformed structured line fails the turn
  rather than guessing.
- **Limitation — no shipped Claude Code / OpenCode adapter or tool.** This adds
  the runner, the adapter boundary, and delivery; a concrete adapter plus a
  parent tool that creates session/turn records for those agents is a follow-up,
  consistent with #10's approach. The CLI/parent tool therefore has no model-facing
  surface yet, and no model-facing `command`/`args` parameter was introduced.
- **Limitation — runner module runs as TypeScript.** The default launch command
  uses `process.execPath` with `--experimental-transform-types` to execute the
  packaged `src/turn-runner.ts` directly (no build step, no new runtime
  dependency). This assumes a Node that supports type transformation; the
  end-to-end test exercises it. A compiled/bundled runner can be swapped in via
  `runnerBin`/`runnerModule`/`runnerArgs`.
- **Limitation — no per-child wall-clock timeout.** A hung agent is bounded by
  parent cancellation (which kills the verified tmux session and thus the runner
  and child) and by reconciliation; there is no independent runner timeout yet.
- **Limitation — a claim has no automatic reclamation.** Because a runner crash
  is recovered by reconciliation marking the turn `lost` (terminal), a stale
  non-terminal claim only matters while the turn is genuinely active; there is no
  separate claim-lease expiry, and a turn with a live pane is never relaunched.

## Review follow-up

Two review findings were addressed before merge:

1. **Truncated structured output now fails closed.** `parseStructured` no longer
   ignores truncation; any stdout that exceeded its bound fails the turn with a
   bounded error and yields no summary or native id. Regression test:
   `a truncated structured stream fails closed even when a valid-looking final
   line survives`.
2. **Atomic launch ownership.** `SubagentSessionRegistry.claimTurn` is a durable
   compare-and-set (executed under the registry lock) that grants exclusive
   launch ownership of a turn. The runner claims before spawning; a second
   concurrently launched runner observes a different token, returns passively,
   and never spawns a child or writes a payload. Tests:
   `duplicate concurrent runners cannot both launch a child for the same turn`
   (a per-spawn log proves exactly one child) and
   `claimTurn is an atomic launch-ownership compare-and-set`.

## PR

PR URL: https://github.com/thaodangspace/pi-tmux/pull/18
