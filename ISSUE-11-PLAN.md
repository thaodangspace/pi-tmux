# Issue #11 implementation plan

Goal: packaged, agent-neutral one-turn tmux runner with durable structured completion; no credentials needed for tests. Dependencies #9 and #10 are closed.

1. Inspect existing session/turn registry, Pi reporter, controller, completion delivery, packaging, and reconciliation. Reuse atomic transition and target identity checks rather than creating parallel lifecycle semantics.
2. Define a finite validated runner configuration/adapter strategy (no serialized callbacks, no model-facing executable/argv). Runner validates explicit registry/session/turn/pane binding before mutating state, then transitions starting→running; spawn executable with `shell:false`, deliver prompt safely, bound stdout/stderr, parse structured JSON or NDJSON, capture native session ID.
3. Persist immutable bounded per-attempt completion payload; apply terminal turn transition atomically without overriding cancellation/terminal state, return logical session to idle and deliver parent completion. Ensure missing/crashed runner reconciles to lost and stable ID reuse cannot bind incorrectly.
4. Add fake-executable tests for success/failure/malformed/truncated/oversized output, metacharacter prompt integrity, killed runner, cancellation and duplicate races, incorrect binding, native ID, resumed second turn, and tmux restart/reused IDs. Keep existing Pi behavior intact.
5. Run `npm run build` and `npm test`, inspect diff, commit and push branch, create PR referencing #11 (do not merge). Report PR URL, changed files, test results and limitations. Avoid unrelated changes, credentials, shell interpolation, transcript persistence or terminal scraping.
