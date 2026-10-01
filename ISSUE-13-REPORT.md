# Issue #13 report — Claude Code adapter with resumable print-mode turns

- Issue: https://github.com/thaodangspace/pi-tmux/issues/13
- Branch: `issue-13-claude`
- PR: https://github.com/thaodangspace/pi-tmux/pull/20
- Base: `main` (includes #9/#10/#11/#12; the branch was fast-forwarded onto `origin/main` before implementing)

## What was implemented

`SubagentAgent = "claude-code"` is now first-class, running inside the
pi-tmux-owned tmux boundary via the generic turn runner (#11) and exposed through
the generic session/turn tools (#12):

```text
tmux session
  └─ generic runner (src/turn-runner.ts)
       └─ claude -p --output-format json [--model <model>] [--resume <session_id>]
```

- **`src/claude-adapter.ts`** (new): `ClaudeCodeAdapter` resolves `claude`
  without a shell, assembles the finite argv internally, and hands a validated
  `RunnerSpecV1` to the packaged runner (never a raw command/argv from the model).
  - First turn captures Claude's native `session_id`; the runner persists it as
    the logical session's `agentSessionId`. Later turns pass `--resume <exact id>`,
    never `--continue`.
  - A continuation whose logical session has no recorded `agentSessionId` (e.g.
    after a failed first turn) is rejected (fail closed); an unsafe/oversized
    resume id is rejected before it reaches argv.
  - Bounded `--model` (`[A-Za-z0-9._@:/-]+`); `thinking` is rejected rather than
    silently ignored.
  - Never adds `--dangerously-skip-permissions` (or any permission-disabling
    flag) and never mutates project/user config to launch a turn.
  - Preflight detects **presence only** of `ANTHROPIC_API_KEY` and returns
    bounded, non-secret metadata (`claudeAuthRisk`, `claudeBilling`,
    `claudeAuthNote`); the key value is never read beyond presence, logged,
    returned, or persisted. No env var is set, deleted, or replaced.
- **`src/agent-adapter.ts`**: added `AgentTurnContext.agentSessionId` (resume
  input) and optional non-secret `metadata` on a successful preflight.
- **`src/subagent-controller.ts`**: threads `agentSessionId` into the launch
  context and surfaces preflight `metadata` on create/run success. Pi path is
  unchanged (Pi returns no metadata).
- **`src/runner-adapter.ts`**: extracted the shared `runnerLaunchCommand` helper.
- **`src/tools.ts`**: registers `ClaudeCodeAdapter` by default; a deployer
  `agentSpecs` / `PI_TMUX_AGENT_SPECS` entry still overrides a built-in adapter.
- **`README.md`**: documents the adapter, resume semantics, structured
  completion, and auth/billing safety.

## Tests

- `test/claude-adapter.test.ts` (new, 7 tests, fake `claude`, no account):
  option bounds/thinking rejection; preflight resolution + auth-risk metadata
  without the key value; bounded argv incl. exact `--resume` and `--model`;
  rejection of a continuation without an id and of an unsafe resume id; task
  kept out of the constant command/argv; permission-flag absence; runner-backed
  first-turn id capture + second-turn exact `--resume`; JSON error / non-zero
  exit / malformed output all recorded `failed`.
- `test/generic-tools.test.ts`: asserts preflight metadata is surfaced on both
  `tmux_subagent_create` and `tmux_subagent_run`.
- Cancellation, duplicate-runner ownership, wrong-pane/owner/server binding,
  truncation, and lost-target reconciliation remain covered by the existing
  runner and generic-tools suites (unchanged).

### Results

| Command | Exit code | Result |
|---|---|---|
| `npm run typecheck` | 0 | clean |
| `npm test` | 0 | 208 tests, 208 pass, 0 fail (7 new) |

## Acceptance criteria mapping

- `agent: "claude-code"` works through the generic tools (#12): adapter
  registered by default; create/run lifecycle exercised.
- Claude executes inside pi-tmux-owned tmux: generic controller boundary.
- Multiple sequential turns resume the same conversation by native session id:
  first-turn capture + exact `--resume` proven with a fake CLI.
- Completion is structured and durable; no TUI/pane scraping: generic runner
  parses JSON, writes an immutable payload, never inspects pane text.
- Subscription users are not silently switched to API-key auth: pi-tmux never
  injects/removes auth env; presence is only reported as metadata.
- Existing Pi behavior unchanged: full prior suite green.

## Unresolved concerns / caveats

- The fake CLI validates orchestration, not the live Claude CLI. A credentialed
  smoke test (real `claude`, logged-in subscription) is intentionally not part of
  the default suite.
- `--output-format json` is the single-result mode; `stream-json` was not used
  (the runner also supports `ndjson` if a future adapter needs it).
- The `claude` argv uses print mode with the prompt on stdin (`claude -p
  --output-format json` + stdin), which avoids any ambiguity in how the installed
  CLI binds a positional prompt; if a target CLI version requires a positional
  prompt, the adapter's `prompt` field can be switched to `argv` without touching
  the controller or runner.
- Deployer `agentSpecs` for `claude-code` overrides the built-in adapter; this is
  intentional but means a stale override can shadow the first-class behavior.
- No merge or issue close was performed; the parent owns that.
