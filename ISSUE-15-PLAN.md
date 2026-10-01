# Issue #15 plan

1. Inspect generic session/controller/adapters and tmux ownership paths on origin/main; preserve structured turns as default and Pi compatibility.
2. Add explicit `mode: "turns" | "interactive"` session start handling. Launch Claude's TUI and OpenCode's `--standalone` TUI in owned detached tmux sessions without approval-bypass flags. Persist interactive liveness separately from turn completion; never parse pane text as a completion signal.
3. Reuse generic tmux inspect/select/capture/send/kill paths and stable target/server revalidation for handoff and close. Expose session/pane metadata and fail closed on mismatches.
4. Add tests for both launches, mode defaults, lifecycle/lost/close, security and Pi/turn regressions; update README/API handoff docs.
5. Run typecheck/tests, commit, push branch, create PR referencing #15. Report changed files, test exit statuses, PR URL and any caveats to parent for independent review. Do not merge or close the issue yourself.
