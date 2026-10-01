# Issue #3 implementation plan

1. Inspect existing durable SubagentJob registry/lifecycle (#1), child completion reporter (#2), tmux ownership and tool registration. Preserve low-level tmux APIs.
2. Design Pi-only start/status/cancel tool schemas and structured results, using registry transitions and stable tmux target identity checks. Start must be asynchronous, safely pass prompt (no shell interpolation), load reporter, and handle missing binary/early exit without leaking owned sessions.
3. Add tests for successful start, missing Pi binary, early exit, cancellation/idempotence, and target mismatch; include integration tests where practical.
4. Update skill to prefer structured tools for Pi while preserving manual workflows for other agents and independent verification.
5. Run build/typecheck/tests; inspect diff. Commit on issue-3-pi-subagent, push, create PR to main referencing #3 (do not auto-close until reviewed). Provide concise report with files, test exit codes, PR URL and caveats.

Safety: no skipped approvals/sandbox, no untrusted prompt in shell command, no recursive delegation, no writes outside this worktree except git push/PR. Do not merge or close issue; parent will review and decide.
