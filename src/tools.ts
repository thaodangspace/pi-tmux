import { stat, realpath } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { AgentAdapterRegistry } from "./agent-adapter.ts";
import { confirmMutation } from "./confirm.ts";
import { GenericSubagentController } from "./generic-subagent.ts";
import { assertSamePlacement, checkOwnership } from "./ownership.ts";
import { ClaudeCodeAdapter } from "./claude-adapter.ts";
import { OpenCodeAdapter } from "./opencode-adapter.ts";
import { PiAdapter } from "./pi-adapter.ts";
import {
  type PiSubagentControllerOptions,
  type PiSubagentFailure,
  PiSubagentController,
  detectParentSession,
} from "./pi-subagent.ts";
import { Registry, isTrackedLive, type RegistryEntry, type RegistryKind } from "./registry.ts";
import { RunnerAdapter } from "./runner-adapter.ts";
import { SubagentJobRegistry } from "./subagent-jobs.ts";
import { SUBAGENT_AGENTS, SubagentSessionRegistry, type SubagentAgent } from "./subagent-sessions.ts";
import type { SubagentFailure } from "./subagent-controller.ts";
import { Targets, type PaneTarget, type SessionTarget, type WindowTarget } from "./targets.ts";
import { Tmux, TmuxError, errorMessage } from "./tmux.ts";
import { type RunnerSpecV1, validateRunnerSpec } from "./turn-runner.ts";

const Target = Type.String({ minLength: 1, description: "Explicit stable tmux ID from a listing (preferred), or an exact unambiguous name/index selector." });
const SESSION = Type.Object({ target: Target });
const WINDOW = Type.Object({ target: Target });
const PANE = Type.Object({ target: Target });
const KEYS = ["Enter", "Escape", "Tab", "BTab", "Space", "Backspace", "Delete", "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown", "C-c", "C-d", "C-z", "C-\\", "C-a", "C-e", "C-l", "C-r", "C-u", "C-w"] as const;
const SAFE_NAME = Type.String({ minLength: 1, maxLength: 64, description: "Name (no control characters)." });
const JOB_ID = Type.String({ minLength: 1, maxLength: 512, description: "Durable subagent job ID returned by tmux_subagent_start_pi." });
const SESSION_ID = Type.String({ minLength: 1, maxLength: 512, description: "Logical subagent session ID returned by tmux_subagent_create." });
const TURN_ID = Type.String({ minLength: 1, maxLength: 512, description: "Logical subagent turn ID returned by tmux_subagent_run." });
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Injection points for tests; production callers use the defaults. */
export interface TmuxToolOptions {
  /** Reuse a `Targets` (for example over a private tmux socket). */
  targets?: Targets;
  /** Reuse a durable subagent job registry. */
  jobs?: SubagentJobRegistry;
  /** Reuse a durable logical session/turn registry. */
  sessions?: SubagentSessionRegistry;
  /** Override Pi subagent launcher settings (binary, reporter path, probe, clock). */
  piSubagent?: Partial<Omit<PiSubagentControllerOptions, "tmux" | "registry" | "jobs" | "targets">>;
  /**
   * Agent adapters for the generic session/turn tools. Defaults to a Pi adapter
   * plus one `RunnerAdapter` per `agentSpecs` entry. Tests inject fake adapters
   * for Claude Code / OpenCode before their concrete adapters land.
   */
  adapters?: AgentAdapterRegistry;
  /**
   * Config-driven runner specs keyed by agent. Deployer-provided data only: no
   * executable/argv value ever comes from the model.
   */
  agentSpecs?: Partial<Record<SubagentAgent, RunnerSpecV1>>;
}

export function registerTmuxTools(pi: ExtensionAPI, tmux = new Tmux(), registry = new Registry(), options: TmuxToolOptions = {}): void {
  const targets = options.targets ?? new Targets(tmux);
  const jobs = options.jobs ?? new SubagentJobRegistry();
  const sessions = options.sessions ?? new SubagentSessionRegistry();
  const adapters = options.adapters ?? buildDefaultAdapters(options);
  const generic = new GenericSubagentController({
    tmux,
    registry,
    targets,
    sessions,
    adapters,
    ...options.piSubagent,
  });
  const piSubagent = new PiSubagentController({ tmux, registry, jobs, targets, ...options.piSubagent });
  const register = <TParams extends TSchema>(definition: ToolDefinition<TParams>) => {
    const execute = definition.execute;
    return pi.registerTool({
      ...definition,
      async execute(...args: Parameters<typeof execute>) {
        try { return await execute(...args); }
        catch (error) { return toolError(error, definition.name, args[1]); }
      },
    });
  };

  register({ name: "tmux_list_sessions", label: "tmux sessions", description: "List sessions on the default tmux server, including existing sessions. Returns stable IDs. Each session reports whether it was created by this extension (tracked), when known the session the creating agent ran in (parentSessionId), and whether it is the session Pi itself runs in (current). `current` is detected from TMUX_PANE and is the session to create subagent windows in; an attached client's session is not necessarily Pi's own.", promptSnippet: "List tmux sessions", parameters: Type.Object({ tracked: Type.Optional(Type.Boolean({ description: "Only sessions created by this extension (true) or only sessions not created by it (false)." })) }), async execute(_id, p, signal, _update, ctx) {
    const sessions = await targets.sessions(signal);
    const tracked = await trackedSessions(ctx.sessionManager.getSessionId());
    const currentSessionId = await detectParentSession(tmux, process.env, signal);
    const items = sessions
      .map((session) => ({ ...session, tracked: tracked.has(session.id), parentSessionId: tracked.get(session.id) ?? null, current: session.id === currentSessionId }))
      .filter((session) => p.tracked === undefined || session.tracked === p.tracked);
    return result("list sessions", { items, registryFile: registry.file });
  }});
  register({ name: "tmux_list_created", label: "tmux targets created by Pi", description: "List tmux sessions, windows, and panes created through this extension, from the on-disk provenance registry, each marked live when the target still exists on the server. Read-only.", promptSnippet: "List tmux targets created by this extension", parameters: Type.Object({ kind: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("window"), Type.Literal("pane")])) }), async execute(_id, p, signal, _update, ctx) {
    let entries: RegistryEntry[];
    try { entries = (await registry.list()).filter((entry) => entry.piSessionId === ctx.sessionManager.getSessionId()); }
    catch (error) { throw error instanceof TmuxError ? error : new TmuxError(errorMessage(error), "command_failed"); }
    const view = await targets.liveTargets(signal);
    const items = entries
      .filter((entry) => !p.kind || entry.kind === p.kind)
      .map((entry) => ({ ...entry, live: isTrackedLive(entry, view) }));
    return result("list created targets", { items, registryFile: registry.file, caveat: "The registry only records targets created through this extension; targets created outside it are never listed, and entries can remain after the server stops." });
  }});
  register({ name: "tmux_list_clients", label: "tmux clients", description: "List currently attached tmux clients. Useful for selecting a session from Pi when Pi is outside tmux or when multiple clients are attached.", promptSnippet: "List attached tmux clients", parameters: Type.Object({}), async execute(_id, _params, signal) {
    return result("list clients", await targets.clients(signal));
  }});
  register({ name: "tmux_list_windows", label: "tmux windows", description: "List windows across sessions or for an explicit session target. Returns stable IDs.", promptSnippet: "List tmux windows", parameters: Type.Object({ session: Type.Optional(Target) }), async execute(_id, params, signal) {
    const all = await targets.windows(signal);
    const session = params.session ? await targets.session(params.session, signal) : undefined;
    const windows = session ? all.filter((window) => window.sessionId === session.id) : all;
    return result("list windows", windows);
  }});
  register({ name: "tmux_list_panes", label: "tmux panes", description: "List panes across sessions or for an explicit session or window target. Returns stable IDs and pane dimensions/path.", promptSnippet: "List tmux panes", parameters: Type.Object({ session: Type.Optional(Target), window: Type.Optional(Target) }), async execute(_id, params, signal) {
    if (params.session && params.window) throw new TmuxError("Specify either session or window, not both.", "invalid_option");
    let panes = await targets.panes(signal);
    if (params.session) { const session = await targets.session(params.session, signal); panes = panes.filter((pane) => pane.sessionId === session.id); }
    if (params.window) { const window = await targets.window(params.window, signal); panes = panes.filter((pane) => pane.windowId === window.id); }
    return result("list panes", panes);
  }});

  register({ name: "tmux_inspect_session", label: "tmux session details", description: "Inspect an explicit session by stable ID or exact unambiguous name.", promptSnippet: "Inspect a tmux session", parameters: SESSION, async execute(_id, p, signal) { return result("inspect session", await targets.session(p.target, signal)); }});
  register({ name: "tmux_inspect_window", label: "tmux window details", description: "Inspect an explicit window by stable ID or exact unambiguous selector.", promptSnippet: "Inspect a tmux window", parameters: WINDOW, async execute(_id, p, signal) { return result("inspect window", await targets.window(p.target, signal)); }});
  register({ name: "tmux_inspect_pane", label: "tmux pane details", description: "Inspect an explicit pane by stable ID or exact session:window.pane selector.", promptSnippet: "Inspect a tmux pane", parameters: PANE, async execute(_id, p, signal) { return result("inspect pane", await targets.pane(p.target, signal)); }});

  register({ name: "tmux_capture_pane", label: "Capture tmux pane", description: "Capture a bounded plain-text snapshot of a pane's visible screen and optionally recent scrollback. This is not a command result and cannot establish process success or exit status. Pane contents may contain secrets and will be shared with the model.", promptSnippet: "Capture a bounded tmux pane snapshot", parameters: Type.Object({ target: Target, historyLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 5000, description: "Scrollback lines before the visible screen (default 0)." })) }), async execute(_id, p, signal) {
    const count = p.historyLines ?? 0;
    if (!Number.isInteger(count) || count < 0 || count > 5000) throw new TmuxError("Scrollback line count must be an integer from 0 to 5000.", "invalid_option");
    const pane = await targets.pane(p.target, signal);
    const rawOutput = await tmux.run(["capture-pane", "-p", "-t", pane.id, ...(count ? ["-S", `-${count}`] : [])], { signal, maxOutputBytes: 2_000_000 });
    const output = sanitizeCapture(rawOutput);
    const lines = output.split("\n");
    if (lines.at(-1) === "") lines.pop(); // capture-pane commonly terminates output with a newline
    const lineLimit = 3000;
    const selected = lines.length > lineLimit ? lines.slice(-lineLimit).join("\n") : output;
    const buffer = Buffer.from(selected, "utf8");
    const byteLimit = 40_000;
    const notice = `[Snapshot truncated to the most recent ${lineLimit} lines / ${byteLimit} bytes.]\n`;
    const truncated = lines.length > lineLimit || buffer.byteLength > byteLimit;
    const contentLimit = truncated ? byteLimit - Buffer.byteLength(notice) : byteLimit;
    let text = buffer.byteLength > contentLimit
      ? buffer.subarray(buffer.byteLength - contentLimit).toString("utf8").replace(/^\uFFFD+/, "")
      : selected;
    if (truncated) text = `${notice}${text}`;
    return result("capture pane snapshot (not a command result)", { target: pane, snapshot: text, truncated, historyLinesRequested: count, caveat: "Snapshot only; does not indicate process completion or exit status." });
  }});

  register({ name: "tmux_create_session", label: "Create tmux session", description: "Create a detached tmux session, optionally with a name and working directory. Does not attach or replace Pi's terminal. The new session is recorded in the provenance registry so it can later be identified as created by Pi. Provide parent to record which session it was created from; when omitted, the session Pi itself runs in is detected if possible.", promptSnippet: "Create a detached tmux session", parameters: Type.Object({ name: Type.Optional(SAFE_NAME), cwd: Type.Optional(Type.String({ minLength: 1 })), parent: Type.Optional(Target) }), async execute(_id, p, signal, _update, ctx) {
    validateName(p.name);
    const cwd = p.cwd ? await validateDirectory(p.cwd) : undefined;
    const parentSessionId = p.parent ? (await targets.session(p.parent, signal)).id : await detectParentSession(tmux, process.env, signal);
    const args = ["new-session", "-d", "-P", "-F", "#{session_id}\t#{session_name}", ...(p.name ? ["-s", p.name] : []), ...(cwd ? ["-c", cwd] : [])];
    const [id, autoName] = singleRow(await tmux.run(args, { signal }), 2);
    if (!/^\$\d+$/.test(id!)) throw new TmuxError("tmux created a session but returned an invalid stable ID.");
    const name = autoName ?? p.name ?? id!;
    const record = await remember({ kind: "session", id: id!, sessionId: id!, parentSessionId, piSessionId: ctx.sessionManager.getSessionId(), name, cwd, tool: "tmux_create_session" });
    return result("create detached session", { id, name, attached: false, parentSessionId, ...record });
  }});
  register({ name: "tmux_create_window", label: "Create tmux window", description: "Create a detached window, by default in the tmux session Pi itself is running in (detected from TMUX_PANE); pass session to target another session explicitly. Does not switch the current window. The window is recorded in the provenance registry.", promptSnippet: "Create a detached tmux window (defaults to Pi's own session)", parameters: Type.Object({ session: Type.Optional(Target), name: Type.Optional(SAFE_NAME), cwd: Type.Optional(Type.String({ minLength: 1 })) }), async execute(_id, p, signal, _update, ctx) {
    validateName(p.name);
    const cwd = p.cwd ? await validateDirectory(p.cwd) : undefined;
    const sessionId = p.session ? (await targets.session(p.session, signal)).id : await requireOwnSession(tmux, signal);
    const session = await targets.session(sessionId, signal);
    await targets.session(session.id, signal);
    const output = await tmux.run(["new-window", "-d", "-P", "-F", "#{window_id}\t#{window_name}", "-t", session.id, ...(p.name ? ["-n", p.name] : []), ...(cwd ? ["-c", cwd] : [])], { signal });
    const [id, autoName] = singleRow(output, 2);
    if (!/^@\d+$/.test(id!)) throw new TmuxError("tmux created a window but returned an invalid stable ID.");
    const name = autoName ?? p.name ?? id!;
    const parentSessionId = p.session ? await parentOf(session.id, ctx.sessionManager.getSessionId(), signal) : session.id;
    const record = await remember({ kind: "window", id: id!, sessionId: session.id, windowId: id!, parentSessionId, piSessionId: ctx.sessionManager.getSessionId(), name, cwd, tool: "tmux_create_window" });
    return result("create detached window", { id, sessionId: session.id, name, selected: false, parentSessionId, ...record });
  }});

  register({ name: "tmux_rename_session", label: "Rename tmux session", description: "Rename an explicitly targeted session. No confirmation is required for this non-destructive structural change.", promptSnippet: "Rename a tmux session", parameters: Type.Object({ target: Target, name: SAFE_NAME }), async execute(_id, p, signal) {
    validateName(p.name); const session = await targets.session(p.target, signal); await targets.session(session.id, signal);
    await tmux.run(["rename-session", "-t", session.id, "--", p.name], { signal }); return result("rename session", { id: session.id, previousName: session.name, name: p.name });
  }});
  register({ name: "tmux_rename_window", label: "Rename tmux window", description: "Rename an explicitly targeted window.", promptSnippet: "Rename a tmux window", parameters: Type.Object({ target: Target, name: SAFE_NAME }), async execute(_id, p, signal) {
    validateName(p.name); const window = await targets.window(p.target, signal); await targets.window(window.id, signal);
    await tmux.run(["rename-window", "-t", window.id, "--", p.name], { signal }); return result("rename window", { id: window.id, previousName: window.name, name: p.name });
  }});
  register({ name: "tmux_select_session", label: "Select tmux session", description: "Switch an existing attached tmux client to an explicit session. If exactly one client is attached it is selected automatically; with multiple clients, provide a client name from tmux_list_clients. This never attaches a client.", promptSnippet: "Select a tmux session for an attached client", parameters: Type.Object({ target: Target, client: Type.Optional(Type.String({ minLength: 1, description: "Exact attached client name from tmux_list_clients; required when more than one client is attached." })) }), async execute(_id, p, signal) {
    const session = await targets.session(p.target, signal);
    let client;
    if (p.client) client = await targets.client(p.client, signal);
    else {
      const clients = await targets.clients(signal);
      if (clients.length === 0) throw new TmuxError("No attached tmux client is available; session selection requires an existing client. Use tmux_list_clients to inspect attached clients.", "invalid_target");
      if (clients.length > 1) throw new TmuxError("Multiple tmux clients are attached; provide an exact client name from tmux_list_clients.", "invalid_target");
      client = clients[0]!;
    }
    await targets.session(session.id, signal);
    await targets.client(client.name, signal);
    await tmux.run(["switch-client", "-c", client.name, "-t", session.id], { signal });
    return result("select session", { id: session.id, name: session.name, client: client.name });
  }});
  register({ name: "tmux_select_window", label: "Select tmux window", description: "Select a window in its session for an existing tmux client.", promptSnippet: "Select a tmux window", parameters: WINDOW, async execute(_id, p, signal) {
    const window = await targets.window(p.target, signal); await targets.window(window.id, signal);
    await tmux.run(["select-window", "-t", window.id], { signal }); return result("select window", { id: window.id, name: window.name, sessionId: window.sessionId });
  }});
  register({ name: "tmux_split_pane", label: "Split tmux pane", description: "Split an explicitly targeted pane. Horizontal creates side-by-side panes; vertical creates stacked panes. The new pane is not selected and is recorded in the provenance registry.", promptSnippet: "Split a tmux pane", parameters: Type.Object({ target: Target, orientation: Type.Union([Type.Literal("horizontal"), Type.Literal("vertical")]), cwd: Type.Optional(Type.String({ minLength: 1 })) }), async execute(_id, p, signal, _update, ctx) {
    const cwd = p.cwd ? await validateDirectory(p.cwd) : undefined; const pane = await targets.pane(p.target, signal); await targets.pane(pane.id, signal);
    const output = await tmux.run(["split-window", "-d", "-P", "-F", "#{pane_id}\t#{pane_index}\t#{window_name}\t#{session_name}", p.orientation === "horizontal" ? "-h" : "-v", "-t", pane.id, ...(cwd ? ["-c", cwd] : [])], { signal });
    const [id, paneIndex, windowName, sessionName] = singleRow(output, 4);
    if (!/^%\d+$/.test(id!)) throw new TmuxError("tmux split a pane but returned an invalid stable ID.");
    const name = `${sessionName ?? pane.sessionName}:${windowName ?? pane.windowName}.${paneIndex ?? "?"}`;
    const parentSessionId = await parentOf(pane.sessionId, ctx.sessionManager.getSessionId(), signal);
    const record = await remember({ kind: "pane", id: id!, sessionId: pane.sessionId, windowId: pane.windowId, parentSessionId, piSessionId: ctx.sessionManager.getSessionId(), name, cwd, tool: "tmux_split_pane" });
    return result("split pane", { id, parentPaneId: pane.id, orientation: p.orientation, selected: false, name, parentSessionId, ...record });
  }});
  register({ name: "tmux_select_pane", label: "Select tmux pane", description: "Select an explicitly targeted pane.", promptSnippet: "Select a tmux pane", parameters: PANE, async execute(_id, p, signal) {
    const pane = await targets.pane(p.target, signal); await targets.pane(pane.id, signal); await tmux.run(["select-pane", "-t", pane.id], { signal });
    return result("select pane", { id: pane.id, sessionId: pane.sessionId, windowId: pane.windowId });
  }});
  register({ name: "tmux_resize_pane", label: "Resize tmux pane", description: "Resize an explicitly targeted pane by a positive number of cells along one dimension.", promptSnippet: "Resize a tmux pane", parameters: Type.Object({ target: Target, dimension: Type.Union([Type.Literal("width"), Type.Literal("height")]), amount: Type.Integer({ minimum: 1, maximum: 500 }) }), async execute(_id, p, signal) {
    if (!Number.isInteger(p.amount) || p.amount < 1 || p.amount > 500) throw new TmuxError("Resize amount must be an integer from 1 to 500 cells.", "invalid_option");
    const pane = await targets.pane(p.target, signal); await targets.pane(pane.id, signal);
    await tmux.run(["resize-pane", "-t", pane.id, p.dimension === "width" ? "-x" : "-y", String(p.amount)], { signal });
    return result("resize pane", { id: pane.id, dimension: p.dimension, amount: p.amount });
  }});

  register({ name: "tmux_send_text", label: "Send text to tmux pane", description: "Send literal text to an explicitly targeted pane. Panes not owned by this Pi conversation (via their session, window, or pane) require confirmation; text can execute commands.", promptSnippet: "Send literal text to a tmux pane", parameters: Type.Object({ target: Target, text: Type.String({ minLength: 1, maxLength: 10000 }) }), async execute(_id, p, signal, _update, ctx) {
    if (p.text.includes("\0")) throw new TmuxError("Text cannot contain NUL bytes.", "invalid_option");
    const pane = await targets.pane(p.target, signal);
    await requireSafeSend(pane, signal, ctx);
    await tmux.run(["send-keys", "-l", "-t", pane.id, "--", p.text], { signal });
    return result("send literal text (no Enter appended)", { paneId: pane.id, bytes: Buffer.byteLength(p.text), enterAppended: false });
  }});
  register({ name: "tmux_send_key", label: "Send named key to tmux pane", description: `Send one restricted named key to an explicitly targeted pane. Panes not owned by this Pi conversation (via their session, window, or pane) require confirmation. Supported: ${KEYS.join(", ")}.`, promptSnippet: "Send a named key to a tmux pane", parameters: Type.Object({ target: Target, key: Type.Union(KEYS.map((key) => Type.Literal(key))) }), async execute(_id, p, signal, _update, ctx) {
    const pane = await targets.pane(p.target, signal); await requireSafeSend(pane, signal, ctx);
    await tmux.run(["send-keys", "-t", pane.id, p.key], { signal });
    return result("send named key", { paneId: pane.id, key: p.key });
  }});

  register({ name: "tmux_subagent_start_pi", label: "Start Pi subagent", description: "Start a delegated Pi subagent in a dedicated detached tmux session owned by this Pi conversation. Creates a durable subagent job, binds stable tmux IDs, launches the packaged Pi child completion reporter, delivers the bounded task without shell interpolation, and returns immediately. Never waits for the child to finish and never passes flags that disable Pi approvals or sandboxing.", promptSnippet: "Start a delegated Pi subagent in a dedicated tmux session", parameters: Type.Object({ cwd: Type.String({ minLength: 1, description: "Absolute, existing working directory for the child Pi." }), task: Type.String({ minLength: 1, maxLength: 20000, description: "Bounded task/prompt delivered verbatim as a single argument; never interpolated into a shell." }), name: Type.Optional(SAFE_NAME), parent: Type.Optional(Target), model: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Optional Pi model selection (safe: selects a model only)." })), thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)))) }), async execute(_id, p, signal, _update, ctx) {
    const outcome = await piSubagent.start({ cwd: p.cwd, task: p.task, name: p.name, parent: p.parent, model: p.model, thinking: p.thinking }, ctx.sessionManager.getSessionId(), signal);
    if (!outcome.ok) return failure("start Pi subagent", outcome);
    const { ok: _ok, ...value } = outcome;
    return result("start Pi subagent", value);
  }});
  register({ name: "tmux_subagent_status", label: "Pi subagent status", description: "Return durable lifecycle state for one subagent job created by this Pi conversation. Never infers completion from pane text. When the tmux server is reachable, a bound non-terminal job whose recorded target no longer exists is reconciled to `lost`.", promptSnippet: "Show durable state of a Pi subagent job", parameters: Type.Object({ jobId: JOB_ID }), async execute(_id, p, signal, _update, ctx) {
    const outcome = await piSubagent.status(p.jobId, ctx.sessionManager.getSessionId(), signal);
    if (!outcome.ok) return failure("Pi subagent status", outcome);
    const { ok: _ok, ...value } = outcome;
    return result("Pi subagent status", value);
  }});
  register({ name: "tmux_subagent_cancel", label: "Cancel Pi subagent", description: "Cancel exactly one known subagent job owned by this Pi conversation. Marks the job `cancelled` and kills only the stable tmux target recorded on that job, never a reused or unrelated target. Idempotent once the job is terminal (including a child that already completed).", promptSnippet: "Cancel a Pi subagent job and its recorded tmux target", parameters: Type.Object({ jobId: JOB_ID }), async execute(_id, p, signal, _update, ctx) {
    const outcome = await piSubagent.cancel(p.jobId, ctx.sessionManager.getSessionId(), signal);
    if (!outcome.ok) return failure("cancel Pi subagent", outcome);
    const { ok: _ok, ...value } = outcome;
    return result("cancel Pi subagent", value);
  }});

  // --- Generic, agent-neutral session/turn tools (issue #12) ------------------
  // These are the preferred surface: they name no agent and expose no
  // executable/argv/shell field. `tmux_subagent_start_pi` and the `jobId` form of
  // status/cancel remain as the compatibility path for the one-shot Pi job API.
  register({ name: "tmux_subagent_create", label: "Create subagent session", description: "Create a reusable, agent-neutral subagent session owned by this Pi conversation, bound to a dedicated detached tmux session. Starts no turn; use tmux_subagent_run afterwards. The agent must be one whose adapter is configured (pi, claude-code, or opencode by default; a deployer runner spec may override one). No executable or argv is accepted.", promptSnippet: "Create a reusable subagent session", parameters: Type.Object({
    agent: Type.Union(SUBAGENT_AGENTS.map((agent) => Type.Literal(agent))),
    cwd: Type.String({ minLength: 1, description: "Absolute, existing working directory for the child." }),
    name: Type.Optional(SAFE_NAME),
    parent: Type.Optional(Target),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Optional adapter-validated model selection." })),
    thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)))),
  }), async execute(_id, p, signal, _update, ctx) {
    const outcome = await generic.create({ agent: p.agent, cwd: p.cwd, name: p.name, parent: p.parent, model: p.model, thinking: p.thinking }, ctx.sessionManager.getSessionId(), signal);
    if (!outcome.ok) return subagentFailure("create subagent session", outcome);
    const { ok: _ok, ...value } = outcome;
    return result("create subagent session", value);
  }});
  register({ name: "tmux_subagent_run", label: "Run subagent turn", description: "Run one bounded task as a new turn on an existing reusable subagent session owned by this Pi conversation. Rejects a second concurrent turn on the same session. A terminal turn returns the session to idle; run another turn to continue the same logical session. The working directory is the session's, never caller-supplied.", promptSnippet: "Run a turn on a reusable subagent session", parameters: Type.Object({
    sessionId: SESSION_ID,
    task: Type.String({ minLength: 1, maxLength: 20000, description: "Bounded task/prompt delivered verbatim; never interpolated into a shell." }),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Optional adapter-validated model selection." })),
    thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)))),
  }), async execute(_id, p, signal, _update, ctx) {
    const outcome = await generic.run(p.sessionId, { task: p.task, model: p.model, thinking: p.thinking }, ctx.sessionManager.getSessionId(), signal);
    if (!outcome.ok) return subagentFailure("run subagent turn", outcome);
    const { ok: _ok, ...value } = outcome;
    return result("run subagent turn", { ...value, turnId: value.runId });
  }});
  register({ name: "tmux_subagent_status", label: "Subagent status", description: "Return durable lifecycle state owned by this Pi conversation. Pass sessionId (optionally with turnId) for a reusable session, or jobId for a legacy one-shot Pi job. Never infers completion from pane text; a vanished or re-identified target is reconciled to `lost` when tmux is reachable.", promptSnippet: "Show durable state of a subagent session, turn, or Pi job", parameters: Type.Object({ sessionId: Type.Optional(SESSION_ID), turnId: Type.Optional(TURN_ID), jobId: Type.Optional(JOB_ID) }), async execute(_id, p, signal, _update, ctx) {
    const owner = ctx.sessionManager.getSessionId();
    if (p.sessionId !== undefined) {
      if (p.jobId !== undefined) throw new TmuxError("Provide either sessionId or jobId, not both.", "invalid_option");
      const outcome = await generic.status(p.sessionId, owner, p.turnId, signal);
      if (!outcome.ok) return subagentFailure("subagent status", outcome);
      const { ok: _ok, turn, ...value } = outcome;
      return result("subagent status", {
        ...value,
        ...(turn ? { turn: { ...turn, turnId: turn.runId } } : {}),
      });
    }
    if (p.jobId !== undefined) {
      if (p.turnId !== undefined) throw new TmuxError("turnId applies only to a sessionId status.", "invalid_option");
      const outcome = await piSubagent.status(p.jobId, owner, signal);
      if (!outcome.ok) return failure("Pi subagent status", outcome);
      const { ok: _ok, ...value } = outcome;
      return result("Pi subagent status", value);
    }
    throw new TmuxError("Provide sessionId (reusable session) or jobId (legacy Pi job).", "invalid_option");
  }});
  register({ name: "tmux_subagent_cancel", label: "Cancel subagent", description: "Cancel active work owned by this Pi conversation. Pass sessionId (optionally turnId) to cancel a reusable session's active turn, leaving the session reusable; or jobId to cancel a legacy one-shot Pi job and kill its recorded tmux target. Only a positively verified target is ever killed; cancellation is idempotent.", promptSnippet: "Cancel an active subagent turn or a Pi job", parameters: Type.Object({ sessionId: Type.Optional(SESSION_ID), turnId: Type.Optional(TURN_ID), jobId: Type.Optional(JOB_ID) }), async execute(_id, p, signal, _update, ctx) {
    const owner = ctx.sessionManager.getSessionId();
    if (p.sessionId !== undefined) {
      if (p.jobId !== undefined) throw new TmuxError("Provide either sessionId or jobId, not both.", "invalid_option");
      const outcome = await generic.cancel(p.sessionId, owner, p.turnId, signal);
      if (!outcome.ok) return subagentFailure("cancel subagent turn", outcome);
      const { ok: _ok, ...value } = outcome;
      return result("cancel subagent turn", value);
    }
    if (p.jobId !== undefined) {
      if (p.turnId !== undefined) throw new TmuxError("turnId applies only to a sessionId cancel.", "invalid_option");
      const outcome = await piSubagent.cancel(p.jobId, owner, signal);
      if (!outcome.ok) return failure("cancel Pi subagent", outcome);
      const { ok: _ok, ...value } = outcome;
      return result("cancel Pi subagent", value);
    }
    throw new TmuxError("Provide sessionId (reusable session) or jobId (legacy Pi job).", "invalid_option");
  }});
  register({ name: "tmux_subagent_close", label: "Close subagent session", description: "Stop a reusable subagent session owned by this Pi conversation and tear down only its verified tmux session. Any active turn is cancelled first. Idempotent once the session is stopped/lost; never kills a reused or unverified target.", promptSnippet: "Close a reusable subagent session and its tmux boundary", parameters: Type.Object({ sessionId: SESSION_ID }), async execute(_id, p, signal, _update, ctx) {
    const outcome = await generic.close(p.sessionId, ctx.sessionManager.getSessionId(), signal);
    if (!outcome.ok) return subagentFailure("close subagent session", outcome);
    const { ok: _ok, ...value } = outcome;
    return result("close subagent session", value);
  }});

  registerKill("tmux_kill_session", "session", "session", (selector, signal) => targets.session(selector, signal), (t) => t.id, (t) => `${t.name} (${t.id})`);
  registerKill("tmux_kill_window", "window", "window", (selector, signal) => targets.window(selector, signal), (t) => t.id, (t) => `${t.sessionName}:${t.name} (${t.id})`);
  registerKill("tmux_kill_pane", "pane", "pane", (selector, signal) => targets.pane(selector, signal), (t) => t.id, describePane);

  function registerKill<T extends SessionTarget | WindowTarget | PaneTarget>(
    name: string, kind: RegistryKind, noun: string,
    resolveTarget: (selector: string, signal?: AbortSignal) => Promise<T>,
    idOf: (target: T) => string, describe: (target: T) => string,
  ) {
    register({ name, label: `Kill tmux ${noun}`, description: `Permanently kill an explicitly targeted ${noun}. Targets owned by this Pi conversation (via their session, window, or pane) require no confirmation; other targets require confirmation. Revalidates the stable ID before mutation.`, promptSnippet: `Kill a tmux ${noun}`, parameters: Type.Object({ target: Target }), async execute(_id, p, signal, _update, ctx) {
      const target = await resolveTarget(p.target, signal); const stableId = idOf(target);
      let action = `kill ${noun}`;
      if (kind === "pane" && "windowId" in target) {
        const siblings = new Set((await targets.panes(signal)).filter((pane) => pane.windowId === target.windowId).map((pane) => pane.id));
        if (siblings.size === 1) action += " (also removes its window because this is the last pane)";
      } else if (kind === "window" && "sessionId" in target) {
        const siblings = new Set((await targets.windows(signal)).filter((window) => window.sessionId === target.sessionId).map((window) => window.id));
        if (siblings.size === 1) action += " (also removes its session because this is the last window)";
      }
      const before = await checkOwnership(targets, registry, kind, stableId, ctx.sessionManager.getSessionId(), signal);
      if (!before.exclusive) await confirmMutation(ctx, action, `${describe(target)} (${before.reason})`, signal);
      await resolveTarget(stableId, signal);
      const after = await checkOwnership(targets, registry, kind, stableId, ctx.sessionManager.getSessionId(), signal);
      assertSamePlacement(before, after);
      await assertTrackedIdentity(kind, stableId, signal);
      await tmux.run([`kill-${kind}`, "-t", stableId], { signal });
      const forgotten = await forgetTarget(kind, target, stableId);
      return result(`kill ${noun}`, { id: stableId, approved: true, confirmationRequired: !before.exclusive, removed: true, forgotten });
    }});
  }

  async function remember(entry: Omit<RegistryEntry, "createdAt">): Promise<{ tracked: boolean; registryError?: string }> {
    try {
      const serverIdentity = await targets.serverIdentity();
      if (!serverIdentity) throw new TmuxError("Could not identify the tmux server; provenance not saved.");
      await registry.record({ ...entry, serverIdentity, createdAt: new Date().toISOString() });
      return { tracked: true };
    } catch (error) {
      // The tmux target already exists; losing provenance must not hide that.
      return { tracked: false, registryError: errorMessage(error) };
    }
  }

  async function forgetTarget(kind: RegistryKind, target: SessionTarget | WindowTarget | PaneTarget, stableId: string): Promise<number> {
    try {
      return await registry.forget(kind, stableId, { sessionId: "sessionId" in target ? target.sessionId : undefined });
    } catch {
      return 0; // A stale entry is harmless; a failed kill report is not.
    }
  }

  /** Reads the registry without letting a broken file break plain tmux inspection. */
  async function trackedSessions(piSessionId: string): Promise<Map<string, string | null>> {
    const found = new Map<string, string | null>();
    try {
      const identity = await targets.serverIdentity();
      for (const entry of await registry.list()) if (entry.kind === "session" && entry.piSessionId === piSessionId && identity && entry.serverIdentity === identity) found.set(entry.id, entry.parentSessionId);
    } catch { /* Report sessions anyway; provenance is best-effort metadata. */ }
    return found;
  }

  async function assertTrackedIdentity(kind: RegistryKind, id: string, signal?: AbortSignal): Promise<void> {
    const identity = await targets.serverIdentity(signal);
    const entry = (await registry.list()).find((item) => item.kind === kind && item.id === id);
    if (entry && (!identity || !entry.serverIdentity || entry.serverIdentity !== identity)) {
      throw new TmuxError(`Refusing to act on ${id}: its saved provenance belongs to another or unknown tmux server.`, "invalid_target");
    }
  }

  async function requireSafeSend(pane: PaneTarget, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<void> {
    const before = await checkOwnership(targets, registry, "pane", pane.id, ctx.sessionManager.getSessionId(), signal);
    if (!before.exclusive) await confirmMutation(ctx, "send input to a pane not owned by this Pi conversation", `${describePane(pane)} (${before.reason})`, signal);
    await targets.pane(pane.id, signal);
    const after = await checkOwnership(targets, registry, "pane", pane.id, ctx.sessionManager.getSessionId(), signal);
    assertSamePlacement(before, after);
    await assertTrackedIdentity("pane", pane.id, signal);
  }

  /** The session the creating agent ran in, when it could be determined. */
  async function parentOf(sessionId: string, piSessionId: string, signal?: AbortSignal): Promise<string | null> {
    const tracked = await trackedSessions(piSessionId);
    if (tracked.has(sessionId)) return tracked.get(sessionId) ?? null;
    return detectParentSession(tmux, process.env, signal);
  }
}

/** The session Pi itself runs in, or a clear error when Pi is outside tmux. */
async function requireOwnSession(tmux: Tmux, signal?: AbortSignal): Promise<string> {
  const id = await detectParentSession(tmux, process.env, signal);
  if (!id) throw new TmuxError("Cannot determine the session Pi is running in because Pi is not inside tmux (TMUX_PANE is unset). Pass an explicit session target from tmux_list_sessions; do not assume the session an attached client is viewing is Pi's own.", "invalid_target");
  return id;
}

function validateName(name: string | undefined): void {
  if (name !== undefined && (!name.trim() || name !== name.trim() || /[\x00-\x1f\x7f]/.test(name))) {
    throw new TmuxError("Name must be non-empty, trimmed, and contain no control characters.", "invalid_option");
  }
}
async function validateDirectory(path: string): Promise<string> {
  if (!path || path.includes("\0")) throw new TmuxError("Working directory must be a non-empty path.", "invalid_option");
  try {
    const absolute = await realpath(path);
    if (!(await stat(absolute)).isDirectory()) throw new Error("not a directory");
    return absolute;
  } catch {
    throw new TmuxError(`Working directory ${JSON.stringify(path)} does not exist or is not a directory.`, "invalid_option");
  }
}
function singleLine(output: string): string {
  const lines = output.trim().split(/\r?\n/);
  if (lines.length !== 1 || !lines[0]) throw new TmuxError("tmux returned unexpected output for a created target.");
  return lines[0];
}
/** Parses one tab-separated row of a `-P -F` result, e.g. an ID plus its human name. */
function singleRow(output: string, columns: number): (string | undefined)[] {
  const fields = singleLine(output).split("\t");
  if (fields.length !== columns) throw new TmuxError("tmux returned unexpected output for a created target.");
  return fields;
}
function describePane(pane: PaneTarget): string { return `${pane.sessionName}:${pane.windowName}.${pane.index} (${pane.id})`; }
function result(operation: string, value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ operation, ...asObject(value) }, null, 2) }], details: { operation, value } };
}
function asObject(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { items: value }; }

export function sanitizeCapture(text: string): string {
  return text
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])/g, "")
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** Structured `isError` result for a Pi subagent operation that failed. */
export function failure(operation: string, outcome: PiSubagentFailure) {
  const details = {
    operation,
    ...(outcome.jobId ? { jobId: outcome.jobId } : {}),
    ...(outcome.status ? { status: outcome.status } : {}),
    ...(outcome.cleanedUp !== undefined ? { cleanedUp: outcome.cleanedUp } : {}),
    code: outcome.code,
    error: outcome.error,
  };
  return { content: [{ type: "text" as const, text: `tmux error: ${JSON.stringify(details)}` }], isError: true, details };
}

/** Structured `isError` result for a generic subagent operation that failed. */
export function subagentFailure(operation: string, outcome: SubagentFailure) {
  const details = {
    operation,
    ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
    ...(outcome.runId ? { runId: outcome.runId } : {}),
    ...(outcome.status ? { status: outcome.status } : {}),
    ...(outcome.cleanedUp !== undefined ? { cleanedUp: outcome.cleanedUp } : {}),
    code: outcome.code,
    error: outcome.error,
  };
  return { content: [{ type: "text" as const, text: `tmux error: ${JSON.stringify(details)}` }], isError: true, details };
}

/**
 * Builds the default agent adapter registry: a Pi adapter, first-class Claude
 * Code and OpenCode adapters, plus one config-driven runner adapter per
 * `agentSpecs` (or `PI_TMUX_AGENT_SPECS`) entry. A deployer spec for an agent
 * overrides the built-in adapter of the same name. A malformed spec is skipped
 * so a bad deployer configuration cannot break Pi; the agent then simply reports
 * that no adapter is registered.
 */
function buildDefaultAdapters(options: TmuxToolOptions): AgentAdapterRegistry {
  const adapters = new AgentAdapterRegistry([new PiAdapter(options.piSubagent), new ClaudeCodeAdapter(), new OpenCodeAdapter()]);
  const specs = { ...readAgentSpecsFromEnv(), ...(options.agentSpecs ?? {}) };
  for (const [agent, spec] of Object.entries(specs)) {
    if (!spec || !SUBAGENT_AGENTS.includes(agent as SubagentAgent)) continue;
    try {
      const validated = validateRunnerSpec(spec, { requireAbsoluteExecutable: false });
      adapters.register(new RunnerAdapter({ agent: agent as SubagentAgent, spec: validated }));
    } catch {
      /* A malformed deployer spec is ignored; no agent-specific tool is invented. */
    }
  }
  return adapters;
}

/** Deployer-provided runner specs as a JSON object keyed by agent. */
function readAgentSpecsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<Record<SubagentAgent, RunnerSpecV1>> {
  const raw = env.PI_TMUX_AGENT_SPECS;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Partial<Record<SubagentAgent, RunnerSpecV1>>;
  } catch { /* Ignored; surfaced as "no adapter registered" at call time. */ }
  return {};
}

export function toolError(error: unknown, operation?: string, params?: unknown) {
  const message = error instanceof TmuxError ? error.message : errorMessage(error);
  const record = params !== null && typeof params === "object" ? params as Record<string, unknown> : {};
  const target = [record.target, record.session, record.window].find((value) => typeof value === "string");
  const jobId = typeof record.jobId === "string" ? record.jobId : undefined;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
  const turnId = typeof record.turnId === "string" ? record.turnId : undefined;
  const code = error instanceof TmuxError ? error.code : "command_failed";
  const details = {
    ...(operation ? { operation } : {}),
    ...(target ? { target } : {}),
    ...(jobId ? { jobId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {}),
    code,
    error: message,
  };
  return { content: [{ type: "text" as const, text: `tmux error: ${JSON.stringify(details)}` }], isError: true, details };
}
