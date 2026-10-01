# Issue #2 implementation plan

1. Add an opt-in packaged child-only Pi reporter extension (not an auto-loaded parent extension). Document explicit env metadata and launch/loading contract; reject absent/partial/invalid metadata without touching other jobs. Ensure nested delegation to the same parent/job is blocked.
2. On child `session_start`, validate the bound existing job and parent identity, transition `starting -> running` using the durable `SubagentJobRegistry`; report startup failures visibly without changing unrelated jobs.
3. On `agent_settled`, derive success/failure from structured lifecycle/session data (not pane text), store a small bounded machine-readable outcome and atomically transition `running -> completed|failed` using registry semantics. Repeated settle and cancellation/terminal races must be harmless. No GitHub workflow or parent wakeup in child.
4. Define failure/recovery semantics: unreadable state, early process exit, duplicate settle, cancellation, failed persistence, crash after durable completion. Parent can recover via pending durable deliveries; no output scraping.
5. Add isolated tests for success, failure, invalid metadata, duplicate event, terminal races, and persistence failure; run typecheck and full suite. Open PR referencing #2, leave summary and test exit status. Do not merge or close issue (parent reviews first).
