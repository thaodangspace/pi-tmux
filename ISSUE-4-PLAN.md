# Issue #4 implementation plan

Source: https://github.com/thaodangspace/pi-tmux/issues/4 (dependencies #1–#3 closed).

1. Inspect durable job registry, parent session identity, start/status/cancel tools and extension lifecycle. Read Pi extension documentation completely (including relevant cross-references) to select system/tool-originated custom messaging and follow-up-turn API.
2. Implement parent-owned reconciliation: reload validated persisted jobs; reconcile nonterminal tmux jobs; detect terminal undelivered jobs; send bounded machine-readable `pi-tmux:subagent-completed` event with stable jobId and status; persist acknowledgement only after delivery attempt. Ensure event replay after restart and idempotent logical handling across duplicate notifications/crash-before-ack.
3. Observe active jobs without permanent idle polling; debounce watcher signals, fall back to reconciliation on startup/session reentry, release resources when no active jobs. Route only to current owning parent; queue safely when parent busy, wake when idle.
4. Add focused tests for offline recovery, duplicate signal, idle and busy delivery, crash-before-ack, owner isolation, and resource cleanup; run typecheck/full test suite. Document behavior and any unavoidable delivery limitations.
5. Commit changes on `issue-4-completion-delivery`, push, open GitHub PR referencing `Fixes #4`; report PR URL, changed files, test commands/status and caveats. Do not merge or close issue yourself.

Constraints: work only in this worktree; do not touch the dirty main checkout or other worktrees. Do not implement workflow/GitHub automation or unrelated agent support. Do not include unbounded transcript or raw pane capture in events. Keep this plan tracked in the PR only if useful; otherwise remove before commit.
