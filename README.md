# pi-tmux

A Pi extension for controlled management of sessions, windows, and panes on the user's **default tmux server**. It can inspect existing sessions as well as create detached structures; it does not require Pi itself to run inside tmux.

## Requirements and installation

- Node.js supported by Pi and a locally installed tmux. The conservative minimum supported version is **tmux 3.5a**, the only version compatibility-checked locally so far; CI also exercises the Ubuntu-packaged version.
- Install this package with `pi install git:<repository-url>` (or install a local checkout with `pi install ./path/to/pi-tmux`). For one-off development, use `pi --extension ./extensions/index.ts`.
- This package uses Pi-provided runtime peer dependencies and has no runtime npm dependencies.

The extension runs with Pi's operating-system permissions. Read operations inspect every session on the default server, including sessions created outside this extension. There is no socket discovery or remote-server support. Tests always use a dedicated socket and never the default server.

## Tools

Read-only tools: `tmux_list_sessions`, `tmux_list_clients`, `tmux_list_windows`, `tmux_list_panes`, `tmux_list_created`, `tmux_inspect_session`, `tmux_inspect_window`, `tmux_inspect_pane`, and `tmux_capture_pane`.

Structural tools: `tmux_create_session`, `tmux_create_window`, `tmux_rename_session`, `tmux_rename_window`, `tmux_select_session`, `tmux_select_window`, `tmux_split_pane`, `tmux_select_pane`, and `tmux_resize_pane`. New sessions/windows are created detached; new windows and split panes are not selected. Session selection switches an already attached client: the sole client is selected automatically, while multiple clients require a name from `tmux_list_clients`; no client is attached or detached. Selecting a session with no attached client fails clearly. Horizontal split means side-by-side panes (`tmux split-window -h`); vertical means stacked panes.

Input tools: `tmux_send_text` and `tmux_send_key` send literal text or one restricted named key to an explicitly targeted pane. Panes in exclusively owned sessions created by the current Pi conversation on the current tmux server (including the default pane) do not require confirmation; linked or grouped sessions and panes in other sessions do. Text is sent as literal bytes and never has Enter appended automatically; sending the `Enter` key is a separate call.

Guarded tools: `tmux_kill_session`, `tmux_kill_window`, and `tmux_kill_pane`.

Use stable IDs from list/inspect results (`$N` session, `@N` window, `%N` pane) as targets. Exact human-readable selectors are accepted only when unambiguous. Mutations always resolve a target first and use its stable ID; there is no fallback to another target. Names are limited to 64 characters and cannot contain control characters. Working directories must already exist. Resize dimensions are 1–500 cells. Named keys are restricted to Enter, Escape, Tab, BTab, Space, Backspace, Delete, arrows, Home, End, PageUp, PageDown, and the documented `C-*` keys in the tool description.

## Coding agents in tmux

The package includes the `tmux-subagent` skill for delegating bounded work to an installed Claude Code, Codex, Pi, or OpenCode CLI in a dedicated tmux session. It guides Pi through isolation, sending input, monitoring, independent verification, and cleanup; it does not install or authenticate those CLIs or add a process-status tool. Ask Pi to use the skill, or invoke `/skill:tmux-subagent` explicitly (reload Pi after updating the package). The skill is packaged alongside the extension; loading only `--extension ./extensions/index.ts` does not load the skill.

## Provenance: which targets did Pi create?

tmux has no built-in "created from" metadata, so the extension records every session, window, and pane it creates in a local registry file. This is the only way to tell Pi-created targets apart from sessions a human or another tool created.

- Registry file: `$XDG_STATE_HOME/pi-tmux/registry.json` (default `~/.local/state/pi-tmux/registry.json`). Set `PI_TMUX_REGISTRY` to an absolute path to override it. The file is written with owner-only permissions (`0600`) and replaced atomically, so it is safe to read while another Pi process writes.
- `name` stores the readable name at creation time (session name, window name, or `session:window.index` for a pane), which is what keeps stale entries identifiable in the TUI after tmux has forgotten them.
- `tmux_list_sessions` marks sessions created by the current Pi conversation with `tracked` and `parentSessionId`, and accepts `tracked: true|false` to filter. `tmux_list_created` lists its recorded targets with `kind`, `id`, `name`, `cwd`, `tool`, `createdAt`, `parentSessionId`, and `live`.
- `parentSessionId` is the session the creating agent ran in, detected from `TMUX_PANE` when Pi itself runs inside tmux. `tmux_create_session` accepts an explicit `parent` target, which takes precedence and is recorded as-is. The value is `null` when the parent cannot be determined.
- Creating a target never fails because of the registry: a write error is returned as `tracked: false` plus `registryError`, because the tmux target already exists.
- Killing through this extension removes the matching entries and reports `forgotten`. Targets killed outside the extension leave stale entries, which `live: false` reveals; the extension never deletes entries it did not create.
- A corrupt or unexpected registry file is reported and left untouched rather than overwritten.

Caveats: the registry is local metadata, not cryptographic proof of ownership. Server PID and start time prevent stale entries from being treated as live after a server restart; older entries without an identity are treated as gone. Sessions created outside Pi are invisible to it. The file is bounded to the 2,000 most recent entries.

## TUI: seeing what Pi created

The extension also renders to the interactive UI; none of this calls the model.

- **Widget**: a `belowEditor` panel lists recorded targets, one per line: `●` live / `✗` gone, then a readable name, kind, age, and — only when it differs from the target's own session — the session it was created from. Refreshed on session start, turn end, and whenever a `tmux_*` tool finishes. It stays hidden while the registry is empty, and only exists in `tui` mode.

  Names are the ones a user already reads in tmux, not tmux IDs: a session by its name (`pi-tmux`), a window by `session:window` (`pi-tmux:node`), a pane by `session:window.index` (`pi-tmux:node.2`). When a target is gone, its recorded creation-time name is used; if that name was never recorded (older entries) the parent path plus the stable ID is shown, e.g. `✗ pi-tmux:node (%32)  pane  16m`, so a stale line is still identifiable without the ID being the whole label.

  ```
  pi-tmux · 4 created · 1 gone
  ● pi-tmux  session  2s
  ● pi-tmux:node  window  1m
  ● pi-tmux:node.2  pane  3m
  ✗ pi-tmux:node (%32)  pane  16m
  ```

- **`/tmux`**: opens a picker over recorded targets, then offers Inspect, Capture recent output (up to 30 scrollback lines from the target's active pane), Switch attached client (sessions only), and Kill. Picker labels lead with the readable name and keep the stable ID in parentheses, so choosing is human-scale while still unambiguous. Kill revalidates ownership and the target; no confirmation is needed for targets in exclusively owned sessions created by this Pi conversation. Every notification states that a capture is a snapshot, not a command result.
- **`/tmux list`**: prints the same listing. Without dialog UI it falls back to a plain notification, so the command is usable in every mode.
- **`/tmux on|off`**: shows or hides the widget. **`/tmux prune`**: removes this conversation's entries whose target no longer exists, after confirmation. **`/tmux prune all`**: also removes stale legacy and other-conversation entries on the current server, after confirmation; entries from other identifiable servers remain untouched. Prune refuses to run while no tmux target is visible at all, so a stopped server can never be mistaken for deleted sessions.

The picker uses Pi's built-in selector dialogs (`ctx.ui.select`/`confirm`), so the extension still has no runtime dependencies and does not need `@earendil-works/pi-tui`.

## Confirmation and data safety

Killing a target in an exclusively owned session created by the current Pi conversation on the current server does not require confirmation; other kills require explicit UI confirmation naming the operation and target. Sending input to a pane outside such a session requires UI confirmation; input inside it does not. Linked windows and grouped sessions always require confirmation, even when one session is Pi-created. Placement is rechecked before acting. Older registry entries without a Pi session ID are not shown in the widget or `/tmux` picker and never grant confirmation-free access. Confirmation warns that killing a last pane also removes its window, and killing a last window also removes its session. If required confirmation is refused, cancelled, unavailable, or fails, the kill does not run. Pi modes without confirmation UI retain read-only and structural tools, and can send input or kill only inside exclusively owned sessions created by the current Pi conversation on the current server. Targets are checked again before every mutation. Never assume a user-provided script or destructive action is safe merely because it is sent as “literal” text: sending input can still execute commands.

Pane capture is a plain-text **snapshot**, not a command result. It cannot prove that a process completed or succeeded. Capture includes the visible screen and optionally up to 5,000 recent scrollback lines, but only the most recent 3,000 lines / 40,000 bytes are returned. Truncation is reported. Alternate-screen content and partial output have the usual tmux capture limitations. Pane content can include credentials or other secrets; captured content is shared with the model. Capture output is never logged by the extension.

## Development and verification

```sh
npm install
npm run typecheck
npm test
```

Integration tests require tmux 3.5a or compatible and create/tear down a private temporary socket. They do not attach clients or touch normal user sessions. To smoke-load in Pi without asking a model to act:

```sh
pi --extension ./extensions/index.ts --list-models
```

The adapter uses argv-only subprocesses (`shell: false`), a 5-second timeout, cancellation, and a 1 MiB stdout/stderr bound (capture uses a 2 MiB subprocess bound before its smaller model-facing limit). It has no persistent background process and provides no raw tmux command tool.
