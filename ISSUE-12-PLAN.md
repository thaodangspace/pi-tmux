# Issue #12 implementation plan

Goal: expose agent-neutral, parent-scoped logical subagent session/turn tools while retaining the existing Pi job API unchanged.

1. Inspect the existing generic session/turn registry, controller, adapter and completion runner from issues #9–11; reuse their lifecycle and reconciliation rather than adding parallel state.
2. Add bounded schemas and handlers for create, run, status, cancel and close; avoid raw command/shell arguments. Keep session IDs distinct from legacy job IDs. Enforce calling-parent ownership for every mutation and validate adapter-specific options.
3. Wire generic turn completion through the existing durable delivery mechanism with agent/session/turn/status/sequence and bounded metadata; maintain compatibility for `tmux_subagent_start_pi` and existing status/cancel paths.
4. Update packaged skill and user documentation for reusable sessions and structured completion; clarify manual pane operations are an escape hatch.
5. Add tests using Pi and fake Claude/OpenCode adapters for lifecycle, ownership, concurrency, cancel, lost-target reconciliation and completion delivery. Run typecheck and full tests. Open a PR referencing #12; report changed files, test exit status and PR link.

Constraints: only change this worktree; do not merge or close the issue yourself. Do not bypass approvals, introduce arbitrary executable/argv fields, or modify unrelated behavior. If blocked, report the precise blocker rather than claiming completion.
