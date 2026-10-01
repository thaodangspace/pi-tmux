# Issue #13 implementation plan

1. Inspect the generic session/turn controller, adapter contract, runner, tool preflight/start metadata, and Pi compatibility tests. Use issue #13 (`ISSUE-13-CONTEXT.json`) as the acceptance contract.
2. Add a `claude-code` adapter using internally assembled argv and executable resolution without shell execution. Parse bounded structured JSON completion and native `session_id`; persist it on first successful turn and resume exactly that ID on later turns. Reject invalid missing resume IDs. Never disable permissions or mutate auth environment.
3. Detect presence (not value) of `ANTHROPIC_API_KEY` in the launch environment and surface billing risk in preflight/start metadata; avoid logging or persisting the key.
4. Add fake-CLI tests for successful first/resumed turns, JSON errors, nonzero exit, malformed output, argument safety, auth-risk reporting, cancellation/loss and ownership boundaries. Preserve existing Pi behavior.
5. Run typecheck/tests, inspect diff, commit and open a PR referencing #13. Report PR URL, changed files, test exit codes, and caveats. Do not merge or close issues; parent agent reviews and handles that.
