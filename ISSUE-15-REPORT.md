# Issue #15 report — optional interactive TUI mode for Claude Code and OpenCode

- Issue: https://github.com/thaodangspace/pi-tmux/issues/15
- Branch: `issue-15-interactive`
- PR: (pending)
- Base: `origin/main` (includes #9/#10/#11/#12/#13/#14)

## What was implemented

`tmux_subagent_create` now accepts an explicit `mode: "turns" | "interactive"`.
Structured turns remain the default and the automated orchestration protocol;
`interactive` is an optional, human-facing execution mode that launches the
agent's own persistent TUI in the owned tmux pane.

```ts
tmux_subagent_create({ agent: "claude-code" | "opencode", cwd, mode: "interactive" })
```

### Adapter boundary (`src/agent-adapter.ts`)

- Added `AgentInteractiveContext`, `AgentInteractiveLaunchSpec`, and optional
  `AgentAdapter.supportsInteractive` / `preflightInteractive` /
  `prepareInteractive`. An adapter that does not declare support is refused
  (`invalid_option`) rather than guessed. `supportsInteractive` is `true` only
  for the first-class `claude-code` and `opencode` adapters; `pi` and any
  deployer `RunnerSpecV1` reject the mode.

### Claude Code (`src/claude-adapter.ts`)

- `preflightInteractive` resolves the `claude` executable without a shell and
  does **not** require the packaged turn runner (an interactive TUI has no
  runner).
- `prepareInteractive` returns the finite constant command
  `exec "$PI_TMUX_CLAUDE_BIN" [--model "$PI_TMUX_CLAUDE_INTERACTIVE_MODEL"]`.
  No caller text is interpolated, no `-p`/`--output-format`, and no
  `--dangerously-skip-permissions` or other permission-disabling flag is ever
  added.
- Surfaces the same bounded, non-secret auth/billing metadata as `preflight`.

### OpenCode (`src/opencode-adapter.ts`)

- `preflightInteractive` resolves `opencode` only and returns the bounded
  isolation metadata.
- `prepareInteractive` returns
  `exec "$PI_TMUX_OPENCODE_BIN" --standalone [--model "$PI_TMUX_OPENCODE_INTERACTIVE_MODEL"]`.
  `--standalone` is mandatory and first, so a managed TUI runs its private server
  inside the owned process tree and never silently attaches to the user's shared
  background daemon. `--attach`, `--auto`, `--yolo`, `--continue`, and
  `--dangerously-skip-permissions` are never passed.

### Durable lifecycle (`src/subagent-sessions.ts`)

- Added `mode` (`turns` default; absent on older records reads as `turns`) and
  `tmuxPaneId` to `SubagentSessionV1`, plus the `interactive` session status.
- Transitions: `starting -> interactive` is allowed; `interactive -> stopped |
  lost` only; an interactive session can never be `idle`/`busy`, and
  `createTurn` on it is rejected.
- `reconcile` treats a vanished **pane** (as well as a vanished session or a
  changed `serverIdentity`) as `lost` for an interactive session, so liveness is
  never inferred from pane text. No turn/completion is ever fabricated.
- Interactive sessions therefore never enter the turn completion-delivery loop.

### Controller and tools

- `SubagentController.createInteractiveSession` reuses the generic inert startup
  gate, stable `$N`/`%N` binding, required `serverIdentity`, provenance, bounded
  startup probe, and fail-closed cleanup. It binds the pane, respawns it into the
  TUI, probes liveness, and only then transitions `starting -> interactive`.
- `runTurn` and `cancelTurn` reject an interactive session with `invalid_option`;
  `closeSession` stops it and kills only a positively verified `$N`
  (identity matching, ID live), else fails closed.
- `tmux_subagent_create` exposes `mode`; its result and `tmux_subagent_status`
  expose `{ mode, tmuxSessionId, tmuxPaneId, ... }`. Handoff reuses the existing
  `tmux_select_session` / `tmux_inspect_pane` / `tmux_capture_pane` /
  `tmux_send_text` / `tmux_send_key` paths and their ownership, confirmation, and
  revalidation rules unchanged.
- `README.md` gained an "Interactive TUI mode" section (topology, OpenCode
  isolation, liveness-vs-completion, metadata, human handoff flow, security,
  testing); the `tmux-subagent` skill gained a short human-handoff subsection.

## Tests

New credential-free tests use fake `claude`/`opencode` executables and an
isolated private tmux server; no account or installed CLI is required.

| Command | Exit code | Result |
|---|---|---|
| `npm run typecheck` | 0 | clean |
| `npx tsx --test --test-reporter=spec test/interactive-mode.test.ts` | 0 | 9 tests pass |
| `npx tsx --test --test-reporter=spec test/subagent-controller.test.ts` | 0 | 15 tests pass (4 new interactive) |
| `npx tsx --test --test-reporter=spec test/generic-tools-integration.test.ts` | 0 | 5 tests pass (2 new interactive e2e) |
| `npm test` | 0 | 232 tests, 232 pass, 0 fail (15 new) |

Coverage highlights:

- Both launches: constant Claude/OpenCode interactive commands; OpenCode always
  `--standalone`; no approval/permission-disabling flags; model via validated env;
  `thinking` rejected.
- Mode default `turns`; interactive lifecycle and pane binding; `run`/`cancel`
  refused; vanished pane reconciles to `lost`; live pane cannot be double-bound.
- Controller: interactive create launches the TUI in the owned pane, close tears
  down only the verified target and is idempotent, an exited TUI cleans up, and
  an adapter without interactive support creates nothing.
- End-to-end over a real isolated tmux server: create(mode interactive) ->
  inspect/capture/send through the generic tools -> status (no fabricated turn)
  -> close; the OpenCode TUI's argv is asserted to be exactly
  `["--standalone", "--model", ...]`.

### Regression

The full pre-existing suite (Pi, Claude, OpenCode structured turns, runner,
reporter, delivery, tmux ownership/confirmation, UI) remains green; the only
existing-test change is the `tmux_subagent_create` parameter-key assertion now
including `mode`.

## Acceptance criteria mapping

- `mode: "turns"` remains the default: `createSession` defaults it and the tools
  document it.
- Claude Code can run as a persistent TUI in a dedicated tmux session:
  `claude` launched in the owned pane.
- OpenCode can run as a persistent TUI without escaping to the shared daemon:
  `opencode --standalone`, asserted end to end.
- Human can inspect/switch/send input with existing safe tmux capabilities: the
  existing generic tools are reused; no agent-specific send/capture tools added.
- Automated completion is never inferred from terminal text: interactive
  liveness is tmux/process liveness; no turn/completion is created.
- No regression to structured turns or Pi: full suite green.

## Unresolved concerns / caveats

- **Installed CLI contract.** As with #14, the OpenCode flag contract
  (`--standalone`, TUI) follows the referenced v2 docs; the locally installed CLI
  is v1. The fake-CLI tests enforce the command contract, and no credentialed
  smoke test is part of the default suite.
- **Interactive mode scope.** Only `claude-code` and `opencode` declare
  interactive support. Pi and deployer runner specs reject the mode rather than
  guessing a TUI contract; adding another agent requires an explicit adapter
  implementation.
- **Resume.** Interactive mode intentionally starts a fresh TUI. It does not
  resume a prior native conversation; that remains a structured-turn feature.
- **No completion.** Interactive sessions produce no `pi-tmux:subagent-completed`
  event; a consumer must treat them as human-in-the-loop, not as work whose
  completion is observable.
- No merge or issue close was performed; the reviewer/parent owns that.
