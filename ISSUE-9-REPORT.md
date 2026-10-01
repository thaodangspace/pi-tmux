# Issue #9 report — durable `SubagentSession` / `SubagentTurn` architecture

- Issue: https://github.com/thaodangspace/pi-tmux/issues/9
- Branch: `issue-9-sessions-turns`
- Plan: `ISSUE-9-PLAN.md` (followed; scope refined as noted under Decisions)

## Summary

Issue #9 asked to generalize the durable subagent lifecycle from the one-run
`SubagentJobV1` model to a long-lived logical **session** that owns many
executable **turns**, without regressing the existing Pi behaviour.

This change adds a fully durable, owner-isolated, bounded session/turn registry
(`src/subagent-sessions.ts`) built on the same crash/concurrency primitives as
the job registry, which were extracted into a shared module
(`src/durable-state.ts`). It also adds an explicit, atomic, idempotent migration
from legacy `SubagentJobV1` records. The live Pi tools are untouched.

## Design

### Model

```text
SubagentSession  (agent, cwd, stable $N tmux session, serverIdentity, agentSessionId)
  ├─ SubagentTurn #1  (stable %N pane, status, timestamps, exitCode/resultPath/error, completionSeq)
  ├─ SubagentTurn #2
  └─ ...
```

- `SubagentAgent = "pi" | "claude-code" | "opencode"`.
- Session status: `starting -> idle | busy | stopped | lost`; `stopped`/`lost`
  are terminal and immutable.
- Turn status: `queued -> starting -> running -> completed | failed | cancelled | lost`;
  `starting -> completed` and `queued -> running` are illegal; terminal outcomes
  are immutable and duplicate terminal transitions are idempotent no-ops.
- `agentSessionId` stores the native Claude/OpenCode/Pi conversation id after the
  first turn so a later turn can resume the same conversation (immutable once set).
- No prompts, transcripts, or pane output are stored.

### Key invariants enforced

- **A terminal turn never terminates the session.** When the last active turn
  reaches a terminal status the session returns to `idle`, so turn A can complete
  and turn B can run (covered by an explicit A→B test).
- **Only one active turn per session (v1).** `createTurn` rejects a second
  `queued`/`starting`/`running` turn.
- **Execution-safety boundary.** A session binds a stable `$N` tmux session +
  `serverIdentity` exactly once; each turn binds a stable `%N` pane. Binding
  refuses a pane owned by another active turn and a tmux session owned by another
  active session.
- **Completion/ack semantics per turn.** First terminal transition assigns a
  registry-global `completionSeq`; `pendingDeliveries()` returns terminal turns
  without `notifiedAt`, oldest first; `markNotified()` is idempotent and
  terminal-only.
- **Parent ownership isolation.** Every mutating method accepts an optional
  `parentPiSessionId`; a mismatch is refused. `reconcile` is owner-scoped and can
  never rewrite another conversation's session or turn.
- **Lost reconciliation.** Non-terminal turns whose pane vanished (or whose
  server identity changed) become `lost`; non-terminal sessions whose `$N`
  session vanished become `lost`; a session whose own tmux session survives but
  whose pane vanished returns to `idle`. A no-op reconcile does not rewrite the
  file (verified by inode/mtime).
- **Bounded, fail-closed persistence.** Fsynced atomic rewrites, a
  cross-process owner lock (stolen only when the owner is provably dead; a held
  breaker is never stolen), and strict validation. Active/undelivered work is
  never evicted; acknowledged history is capped (default 100 turns / 100
  terminal sessions) and hard bounds (default 1000 turns / 500 sessions) reject
  creation rather than drop live data. Corrupt, unknown-version, dangling, or
  duplicate state is reported and never overwritten.

### Shared durability primitive

`src/durable-state.ts` (`DurableStateFile`) now owns the read/atomic-write/lock
machinery. `SubagentJobRegistry` was refactored onto it with **no public API or
error-message changes**; `SubagentSessionRegistry` reuses the identical
guarantees instead of duplicating ~180 lines. The entire existing suite (including
the cross-process lock tests) passes unchanged.

### Migration / compatibility (strategy 1: explicit atomic migration)

- `migrateSubagentJobs({ jobsFile?, sessionsFile? })` reads the legacy registry
  and atomically imports each job as one session + one turn.
- Status, timestamps, `exitCode`, `resultPath`, `error`, `completionSeq`, and
  `notifiedAt` are preserved; the original `jobId` is stored as the session's
  `legacyJobId`.
- Idempotent: re-running skips already-migrated jobs; the legacy file is never
  mutated or deleted.
- A corrupt legacy file fails closed and writes nothing to the session registry.
- Migrated pending completions remain recoverable via `pendingDeliveries()`
  (including owner scoping).

## Files

- `src/durable-state.ts` (new): shared fsynced atomic write + cross-process lock.
- `src/subagent-sessions.ts` (new): `SubagentSessionV1`, `SubagentTurnV1`,
  `SubagentSessionRegistry`, `legacyJobToSessionAndTurn`, `migrateSubagentJobs`.
- `src/subagent-jobs.ts` (refactor): uses `DurableStateFile`; behavior unchanged.
- `test/subagent-sessions.test.ts` (new): 24 tests.
- `test/subagent-session-worker.ts` (new): cross-process worker helper.
- `README.md`: documents the session/turn model, invariants, and migration.
- `ISSUE-9-REPORT.md` (this file).

## Verification

Run in the worktree after `npm ci`:

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | 0 | clean |
| `npm test` (`tsx --test`) | 0 | 132 tests, 132 pass, 0 fail (108 pre-existing + 24 new) |

New tests cover: session lifecycle and immutability; turn state transitions and
terminal immutability; A→B turn reuse; single active turn enforcement; session
recovery to `idle`; `agentSessionId` resume; ownership isolation; owner-scoped
reconciliation; lost reconciliation (pane-only, server-identity change); no-op
reconcile not rewriting the file; per-turn delivery bookkeeping; re-instantiation
persistence; filters; corrupt/dangling/duplicate fail-closed; retention and hard
bounds; owner-only file mode and failed-write safety; in-process and
cross-process locking; atomic legacy migration (status/seq/ack preservation,
idempotency, pending-delivery recovery, corrupt-file fail-closed); invalid-input
fail-before-write.

## Decisions and limitations

- **Decision — preserve the live Pi contract.** The Pi launcher/child-reporter
  tools and `CompletionDelivery` still use `SubagentJobV1` unchanged. The issue's
  acceptance criteria are about the durable model, and rewiring the live flow in
  the same change would risk the existing public contract. The session registry
  is the forward model; the launcher/child reporter can be migrated onto it in a
  follow-up once Claude Code / OpenCode launch paths are added.
- **Decision — explicit migration, not implicit.** Migration is an explicit
  function so it can never silently rewrite state on startup. It is atomic and
  idempotent, and the legacy file is the source of truth until a caller opts in.
- **Limitation — no live Claude Code / OpenCode launch integration.** This change
  builds the durable model those agents need; it does not add their executors or
  CLI adapters.
- **Limitation — `subagent-sessions.json` is a separate file** from
  `subagent-jobs.json`; until a caller runs the migration and switches delivery,
  the two can diverge. The migration is idempotent and non-destructive, so this
  is recoverable.
- **Limitation — one active turn per session (v1 by design).** Concurrent turns
  on a session are intentionally rejected.

## PR

PR URL: _pending — recorded in a follow-up commit immediately after opening the pull request._
