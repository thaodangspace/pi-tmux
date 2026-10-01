# Issue #14 implementation plan

1. Inspect the generic runner, Claude adapter, controller, session persistence, tool registration, and existing fake-CLI tests. Confirm OpenCode CLI JSON event/session semantics from documentation or a safe local probe.
2. Implement an OpenCode adapter with internally built argv, mandatory `run --standalone --format json`, validated bounded options, no default `--auto`, and exact persisted native session ID resume via `--session`.
3. Parse bounded structured results robustly; reject malformed/truncated output and nonzero exits without persisting sensitive event streams or credentials. Integrate with generic tools and document isolated-runtime/cancellation guarantees.
4. Add credential-free fake executable tests for first and subsequent turns, safety, error handling, cancellation/lost ownership, and regression behavior. Run typecheck and test suite.
5. Commit on `issue-14-opencode`, push, open PR referencing #14 with verification details. Do not merge or close issue; reviewer handles that.
