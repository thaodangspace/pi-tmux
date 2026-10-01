---
name: tmux-subagent
description: Delegate bounded coding work to Claude Code, Codex, Pi, or OpenCode in a reusable tmux subagent session using pi-tmux tools. Prefer the structured, agent-neutral create/run/status/cancel/close tools; use raw tmux pane operations only as a manual escape hatch. Use when asked to run or coordinate another coding agent through tmux.
---

# Coding subagents via pi-tmux

Use the `tmux_*` tools, not `/tmux` (that command is a human-facing picker). This workflow needs a locally installed tmux, the pi-tmux extension, and the chosen agent CLI already installed and authenticated. If any prerequisite is missing, ask for a choice or report the blocker; do not silently switch agents.

## Preferred structured orchestration (any configured agent)

The agent-neutral session/turn tools are the preferred path for Pi, Claude Code, and OpenCode alike. They keep one durable logical session and let you run several sequential turns against it.

```text
tmux_subagent_create        (agent, cwd, name?, parent?, model?)
        ↓  returns sessionId
tmux_subagent_run           (sessionId, task, model?, thinking?)
        ↓  returns turnId; the agent works in its own tmux boundary
durable turn-completed event (agent, sessionId, turnId, status, completionSeq)
        ↓
tmux_subagent_run again on the same sessionId when more work is needed
        ↓
tmux_subagent_close         (sessionId) when finished
```

1. Agree on the agent, task, repository/worktree, file ownership, expected deliverable, and whether the subagent may edit files or run commands. Prefer a separate worktree for parallel work; create it under `~/code/agent-workspace/<origin_folder_name>/<worktree>` (for example, `~/code/agent-workspace/pi-tmux/issues-12`, where `pi-tmux` is the original repository folder name) before launching the subagent. Never let two agents edit the same files concurrently. Review the user's constraints before delegating. Do not give the subagent secrets or unrestricted permission to bypass approvals.

2. Call `tmux_subagent_create` with the chosen `agent`, an absolute existing `cwd` (the agreed worktree), and optionally a readable `name`, a `parent` tmux session, and a safe `model`/`thinking`. It creates a durable logical session owned by this Pi conversation, binds a dedicated detached tmux session, and returns `{ sessionId, agent, status, tmuxSessionId, ... }`. It starts **no** work. If the selected agent has no configured adapter, the tool fails closed with a clear error — report that instead of falling back silently.

3. Call `tmux_subagent_run` with the `sessionId` and a bounded `task` stating scope, constraints, completion criteria, and where to leave a concise report. It creates and launches exactly one turn and returns `{ sessionId, turnId, status, tmuxSessionId, tmuxPaneId, turnIndex }`. The task is delivered without shell interpolation. A second concurrent turn on the same session is rejected. Never pass raw executable, argv, or shell fields — they are not part of the tool surface.

4. Wait for the durable `pi-tmux:subagent-completed` event (or poll `tmux_subagent_status` with the `sessionId`/`turnId`). A terminal turn never ends the session: it returns to `idle`, and you can run another turn on the same `sessionId` to continue the same native conversation (the agent-native session id is recorded on the session). Prefer structured completion over pane text.

5. Independently verify deliverables in the agreed worktree: inspect the diff and file contents, run appropriate tests and check actual exit codes using normal command tools. A subagent's claim, a durable `completed` status, or a tmux snapshot alone is insufficient — still verify the actual work. If the task cannot be verified, describe exactly what is missing. Do not merge or overwrite work without the user's authorization.

6. Report the results and verification. Keep the session available for inspection unless the user asked for cleanup. To stop active work, use `tmux_subagent_cancel` with the `sessionId` (and optionally `turnId`): it cancels the active turn's positively verified pane and leaves the session reusable. To finish entirely, use `tmux_subagent_close`: it cancels any active turn, stops the session, and tears down only the verified tmux session. Never kill an unrelated session or pane.

## Compatibility: one-shot Pi jobs

`tmux_subagent_start_pi` remains supported for callers that want a single durable Pi job rather than a reusable session. It creates a `SubagentJobV1`, owns a dedicated detached tmux session, always loads the packaged Pi child completion reporter, delivers the task without shell interpolation, and returns immediately with `jobId`, `status`, `tmuxSessionId`, and `tmuxPaneId`. Its status/cancel behavior is reached through `tmux_subagent_status`/`tmux_subagent_cancel` with `jobId` (the same tools accept `sessionId` for the generic path). Do not hand-drive `pi` through `tmux_create_session` + `tmux_send_text` when the structured tools are available.

## Manual escape hatch (raw tmux panes)

Only for an interactive agent that has no configured adapter, or for hands-on debugging a pane. This path has **no** durable completion protocol and must never be presented as structured completion:

- Prefer a dedicated new window in the session Pi runs in: call `tmux_create_window` without `session` and with the agreed absolute `cwd`. `tmux_list_sessions` marks that session `current: true`; an attached client may view another session. Outside tmux, ask for an explicit session instead of guessing. Create a detached session with `tmux_create_session` only if the user explicitly requests one.
- Record the returned stable window/session and pane IDs; use `tmux_list_panes` if needed. Do not target an existing human-owned pane. If creation reports `tracked: false`, treat provenance as uncertain and do not assume confirmation-free access.
- Start the CLI (`claude`, `codex`, or `opencode` — examples, not guaranteed flags) via `tmux_send_text` followed by a separate `tmux_send_key` with `Enter`. Send the task text literally, then send `Enter` separately; only send further input after inspecting the pane; never guess what an interactive confirmation means or automatically accept permission prompts. Ask the user when an approval or unexpected action needs authorization.
- Monitor with `tmux_capture_pane` (optionally with recent scrollback). It is a snapshot, **not** proof of completion or success; output may be partial, truncated, or contain secrets. Do not copy sensitive capture content into the final reply. If stuck or timed out, inspect and report rather than blindly repeating keystrokes.

When a target must be stopped, kill only the stable window or session you created and recheck its identity before doing so. Never kill an unrelated session or pane.

## Safety

Never pass flags that disable an agent's approvals or sandboxing, and never place secrets in a delegated task. Prefer a separate worktree per agent, keep file ownership disjoint, and verify every deliverable independently before reporting it as done.
