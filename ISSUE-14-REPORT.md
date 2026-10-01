# Issue #14 report — OpenCode adapter with resumable isolated turns

- Issue: https://github.com/thaodangspace/pi-tmux/issues/14
- Branch: `issue-14-opencode`
- PR: _pending_
- Base: `main` (includes #9/#10/#11/#12/#13; the branch was verified even with `origin/main` before implementing)

## What was implemented

`SubagentAgent = "opencode"` is now first-class, running inside the pi-tmux-owned
tmux boundary via the generic turn runner (#11) and exposed through the generic
session/turn tools (#12):

```text
tmux session
  └─ generic runner (src/turn-runner.ts)
       └─ opencode run --standalone --format json [--model <provider/model>] [--session <id>] <task>
```

- **`src/opencode-adapter.ts`** (new): `OpenCodeAdapter` resolves `opencode`
  without a shell, assembles the finite argv internally, and hands a validated
  `RunnerSpecV1` to the packaged runner (never a raw command/argv from the model).
  - **Mandatory isolation.** Every managed turn always carries `--standalone`, so
    OpenCode runs a private server inside the owned tmux process tree rather than
    the shared per-user background service. `--attach` is never passed. Killing or
    losing the owned tmux target therefore tears down the real execution.
  - **Deterministic resume.** First turn runs `opencode run --standalone --format
    json`; the runner captures the native `sessionID` from the structured events
    into the logical session's `agentSessionId`. Later turns run `opencode run
    --standalone --session <exact id> --format json`. `--continue` is never used
    when a known id exists. A continuation without a recorded id is rejected
    (fail closed); an unsafe/oversized id is rejected before it reaches argv.
  - **Structured completion only.** Uses `--format json` NDJSON events
    (`step_start`/`text`/`tool_use`/`step_finish`/`error`) with declarative
    extraction (`sessionID`, `part.text`, `error.data.message`). Success requires
    exit 0 plus parseable output; a reported error, non-zero exit, malformed line,
    or truncated stream is recorded `failed`. Pane text is never inspected.
  - **Bounded options / no permission weakening.** `model` is validated against
    `[A-Za-z0-9._@:/-]+` and passed as `--model`; a `thinking` option is rejected
    rather than ignored. `--auto`, `--yolo`, and `--dangerously-skip-permissions`
    are never passed, and no OpenCode config is mutated to launch a turn.
  - **Credential safety.** pi-tmux never injects provider credentials, never
    reads/returns/logs/persists a credential value, and passes the inherited
    environment unchanged so OpenCode keeps its normal provider/account
    selection. Preflight returns bounded, non-secret isolation metadata
    (`opencodeRuntime: "standalone-private-server"` + note).
- **`src/tools.ts`**: registers `OpenCodeAdapter` in the default adapter registry
  (Pi + Claude Code + OpenCode); a deployer `agentSpecs` / `PI_TMUX_AGENT_SPECS`
  entry still overrides a built-in adapter. The `tmux_subagent_create`
  description now names `pi`, `claude-code`, or `opencode`.
- **`README.md`**: new "OpenCode adapter (`opencode`)" section documenting
  isolation, resume semantics, structured completion, bounded options, credential
  handling, and testing.

Existing Pi and Claude Code adapters, the generic runner, the durable
session/turn lifecycle, and all security boundaries are unchanged.

## Tests

New credential-free tests use a fake `opencode` executable; no account,
credential, or installed CLI is required.

- `test/opencode-adapter.test.ts` (new, 8 tests):
  option bounds + thinking rejection; preflight resolution + bounded isolation
  metadata; mandatory `--standalone` and exact `--session` resume with `--auto`,
  `--continue`, `--attach`, and `--dangerously-skip-permissions` absent; task kept
  out of the constant command/argv; fake-CLI first-turn `sessionID` capture +
  second-turn exact resume; JSON error / non-zero exit / malformed / truncated
  output all recorded `failed`; and an isolated-tmux end-to-end test proving
  resumable turns, cancellation tearing down the verified pane while leaving the
  session reusable, and a vanished owned tmux target reconciling to `lost`.
- `test/generic-tools-integration.test.ts` (extended): drives `agent: "opencode"`
  through the real `tmux_subagent_create`/`run`/`status`/`close` tool surface
  (metadata surfaced, `agentSessionId` captured and resumed, session closed).

### Results

| Command | Exit code | Result |
|---|---|---|
| `npm run typecheck` | 0 | clean |
| `npx tsx --test --test-reporter=spec test/opencode-adapter.test.ts` | 0 | 8 tests, 8 pass, 0 fail |
| `npx tsx --test --test-reporter=spec test/generic-tools-integration.test.ts` | 0 | 3 tests, 3 pass, 0 fail |
| `npm test` | 0 | 217 tests, 217 pass, 0 fail (9 new) |

## Acceptance criteria mapping

- `agent: "opencode"` works through the generic tools from #12: adapter
  registered by default; create/run/status/close exercised end to end.
- Managed turns run inside pi-tmux-owned tmux with private/standalone runtime
  semantics: `--standalone` is mandatory and asserted on every turn.
- Multiple turns resume the same native OpenCode session: first-turn `sessionID`
  capture + exact `--session` proven with a fake CLI and through the tools.
- Killing/cancelling the managed tmux target cannot delegate to the shared
  service: no `--attach`; cancellation removes the verified owned pane and the
  lost path reconciles the turn/session to `lost`.
- Completion is structured/durable, never inferred from terminal text: NDJSON
  parsing + immutable payload + atomic terminal transition.
- Existing Pi/Claude adapter behavior remains unchanged: full prior suite green.

## Unresolved concerns / caveats

- **Installed CLI version.** The issue references the OpenCode v2 docs, and the
  adapter targets that CLI contract. The CLI installed in this environment is
  `opencode 1.16.2` (v1), whose `run` help has no `--standalone` flag and exits 1
  when it is passed (probed with an isolated HOME/XDG and no credentials). A live
  managed turn therefore requires an OpenCode build that supports the documented
  v2 `--standalone`/`--format json` interface. The fake-CLI tests enforce the
  contract; a real credentialed smoke test is intentionally not part of the
  default suite.
- The runner's NDJSON parser fails closed on any malformed stdout line. OpenCode's
  `--format json` writes only events to stdout, but a stray non-event line (for
  example a share-URL notice if sharing were enabled) would fail the turn rather
  than be silently ignored. This is deliberate fail-closed behavior.
- A failed turn may still record a `sessionID` if OpenCode emitted one before
  failing; this is the shared generic runner behavior (identical to Claude Code)
  and allows resuming the errored session. "First successful turn establishes the
  id" holds for the success path.
- Deployer `agentSpecs` for `opencode` overrides the built-in adapter; a stale
  override can shadow the first-class behavior (same as Claude Code).
- No merge or issue close was performed; the reviewer/parent owns that.
