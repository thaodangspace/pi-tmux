# Issue #4 report — durable parent-side completion delivery

Repo: `thaodangspace/pi-tmux` · Branch: `issue-4-completion-delivery` · Issue: #4 (P0: Deliver durable Pi subagent completion events back to parent Pi)

## Summary

Added parent-side completion delivery on top of the durable `SubagentJobV1` registry (#1) and the packaged child completion reporter (#2). A delegated Pi child still settles its job entirely on its own; the parent now detects the terminal state and injects a custom Pi message.

- New `src/completion-delivery.ts` — `CompletionDelivery` reconciles the durable registry, observes it while (and only while) work is active, and delivers one bounded `pi-tmux:subagent-completed` custom message per terminal job. It records `notifiedAt` only **after** the delivery attempt, so a crash between send and acknowledgement redelivers (deduplicated by the stable `jobId` + `completionSeq`).
- `extensions/index.ts` wires it per session: `session_start` creates the delivery for that Pi conversation and schedules recovery; `tool_result` on any `tmux_subagent_*` tool re-checks; `session_shutdown` releases it. The shared `SubagentJobRegistry`/`Targets` are now passed to `registerTmuxTools` so the tools and delivery use the same durable state.
- Delivery uses `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`: an idle parent is woken into a new turn, a streaming parent queues the completion as a follow-up and is never interrupted. Only the owning `parentPiSessionId` receives an event.

No new Pi peer-dependency surface; the adapter is structural and unit-tested without a Pi runtime.

## Changed files

| File | Change |
|---|---|
| `src/completion-delivery.ts` | New. `CompletionDelivery` (bounded watcher + fallback poll + reconciliation + at-least-once delivery with post-attempt acknowledgement), `buildSubagentCompletionEvent`, `createCompletionSink`, `defaultCompletionWatchFactory`, event/detail types. |
| `extensions/index.ts` | Creates one `CompletionDelivery` per session; recovers on `session_start`, re-checks after `tmux_subagent_*` results, releases on `session_shutdown`; shares `jobs`/`targets` with the tools. |
| `test/completion-delivery.test.ts` | New. 13 tests: idle delivery + ack, offline recovery, owner isolation, duplicate-signal collapse, no-ack-before-attempt, crash-before-ack redelivery, vanished→`lost` reconcile delivery, watcher lifecycle/release, real-filesystem watcher end-to-end, idle/busy option shape, non-terminal rejection, missing-directory watcher fallback, and the full extension wiring. |
| `README.md` | New "Parent completion delivery" section: event shape, ordering, idle/busy wakeup, restart recovery, bounded observation, and the delivery limitation. |
| `ISSUE-4-PLAN.md`, `ISSUE-4-REPORT.md` | Plan followed; this report. |

## Delivery semantics

Required ordering, implemented literally:

```
child persists terminal job  ->  parent detects/reconciles
      ->  parent sends the completion message  ->  parent records notifiedAt
```

- **Durable source of truth.** The registry is read after every signal; watcher events and lock/temp writes are never treated as state.
- **At-least-once with idempotent handling.** `pendingDeliveries()` lists terminal, unacknowledged jobs; delivery is attempted first and `markNotified` runs only on success. A crash between the two steps stays pending and is redelivered on the next pass or the next `session_start`.
- **Stable dedup key.** Every event carries `details.jobId` and the registry-global `details.completionSeq`, so a duplicate is machine-deduplicable.
- **Owner isolation.** Only jobs whose `parentPiSessionId` equals the current Pi conversation are listed or acknowledged; foreign and parentless jobs are skipped.
- **Idle vs busy.** `{ triggerTurn: true, deliverAs: "followUp" }` is the single shape that wakes an idle parent and queues (never steers) for a streaming one.
- **Bounded observation.** A directory watcher and a 2 s fallback poll run only while this conversation owns a non-terminal job or an undelivered terminal one, and are released as soon as neither is true. Reconcile against a live tmux view converts a vanished target into a terminal `lost` job that is delivered like any other.
- **Bounded payload.** No transcript, prompt, or pane capture; only the durable job identity/status, sequence, finish time, and the already-bounded `resultPath`/`error`.

## Verification (exit status)

```
npm run typecheck   # exit 0
npm test            # exit 0  (108 tests: 91 pre-existing + 17 new, 0 fail, 0 skipped on this machine)
npm pack --dry-run  # exit 0
pi --extension ./extensions/index.ts --list-models   # exit 0, no stderr (extension smoke-loads)
```

`npm test` includes a real-filesystem watcher test that drives a child-side terminal write through `fs.watch` into delivery, and a full-extension test that asserts `sendMessage` is called with `{ triggerTurn: true, deliverAs: "followUp" }` and that the acknowledgement is persisted.

## Acceptance criteria

| Criterion | Covered by |
|---|---|
| Parent does not block after starting a child | `start` already returns immediately (#3); delivery is asynchronous and never awaited by the start tool. |
| `agent_settled` eventually reaches the owning parent | Child reporter persists terminal state (#2); `CompletionDelivery` delivers it (watcher + poll + pass). |
| Idle parent woken into a follow-up turn | `createCompletionSink` + option-shape test (`dispatch(..., false) === "turn"`). |
| Busy parent receives queued/follow-up, not re-entrancy | `deliverAs: "followUp"` asserted; `dispatch(..., true) === "followUp"`. |
| Parent restart after child completion still delivers | "recovers a completion that arrived while the parent was offline"; `session_start` recovery in the extension test. |
| Duplicate notifications do not create duplicate processing | "repeated passes do not re-deliver an acknowledged completion". |
| Completion never delivered to another parent | "never delivers another Pi conversation's completion". |
| Watcher/background resources released when idle | "holds a watcher only while jobs are active or undelivered, then releases it". |
| Tests cover offline recovery, duplicate notification, busy parent, idle parent, crash-before-ack | The named tests above; busy/idle via the option-shape test. |

## Remaining concerns / follow-ups

1. **Attempted, not confirmed, delivery.** `pi.sendMessage` is fire-and-forget by design in the extension API (the built-in runtime swallows send errors into `emitError`). We therefore cannot confirm model consumption; we persist `notifiedAt` after the send attempt, per the issue's required ordering. A crash after acknowledgement but before a *queued* follow-up message is consumed is not redelivered; detection/redelivery is guaranteed, model consumption is best-effort.
2. **No Pi runtime integration in CI.** Idle/busy behavior is asserted against an emulation of Pi's documented `sendCustomMessage` dispatch plus the option shape; a live Pi session is not exercised in tests. This mirrors the existing repo's testing approach.
3. **Reconciliation cadence.** While active, each signal reconciles against a live tmux view. This is one extra tmux read per parent-side signal; it is bounded to active observation and is released when idle.
4. **Non-goals honored.** No synchronous wait, no workflow/DAG, no automatic GitHub/PR actions, no Claude/Codex/OpenCode support.

## Review fix (round 1)

A reviewer found two blocking defects in the first revision:

1. **Perpetual self-trigger while a job is active.** `CompletionDelivery.pass()` called `jobs.reconcile(view)` on every watcher/poll signal, and `SubagentJobRegistry.reconcile` always ran the full read-modify-**write**, so every no-op reconcile renamed the registry file, which the parent's own watcher observed, which triggered another reconcile — an unbounded loop of writes and live tmux reads for as long as any job was active.
2. **Global reconcile touched other parents' jobs.** `reconcile` iterated *all* jobs, so one parent's observer could mark another conversation's vanished jobs `lost` and produce delivery bookkeeping for them.

Fixes:

- `SubagentJobRegistry.reconcile(view, { parentPiSessionId? })` now accepts an optional owner scope; only that parent's non-terminal jobs are considered.
- The registry's write path is now change-aware: `mutateIfChanged` skips the atomic write (and thus the filesystem event) when a change reports that it altered nothing. `reconcile` returns `changed: changed.length > 0`, so a quiescent reconcile is a true no-op with no rename. Every mutating operation (`create`, `bind`, `transition`, `markNotified`) still always writes.
- `CompletionDelivery.pass()` reconciles with `{ parentPiSessionId: this.owner }`.

Regression tests added:

| Test | File | Asserts |
|---|---|---|
| `a no-op reconcile does not rewrite the registry file` | `test/subagent-jobs.test.ts` | inode and mtime are unchanged after a nothing-to-do reconcile (no rename). |
| `reconcile can be scoped to one parent and never mutates another parent's job` | `test/subagent-jobs.test.ts` | the scoped owner's job becomes `lost`; another parent's job stays `running`; empty scope is rejected. |
| `delivery never reconciles or acknowledges another parent's job` | `test/completion-delivery.test.ts` | with both targets missing, only this parent's job is delivered/acked; the other stays `running` and unacknowledged. |
| `a live job keeps observation quiescent without self-triggering registry writes` | `test/completion-delivery.test.ts` | with a real watcher and a live job, a burst of signals leaves the registry file's inode/mtime unchanged and delivers nothing. |

## PR

URL: https://github.com/thaodangspace/pi-tmux/pull/8 (base `main`, head `issue-4-completion-delivery`). Body references `Fixes #4`; not merged and issue #4 left open for review.
