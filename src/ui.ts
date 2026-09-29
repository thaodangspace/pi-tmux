import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isTrackedLive, type Registry, type RegistryEntry, type RegistryKind } from "./registry.ts";
import { confirmMutation } from "./confirm.ts";
import { assertSamePlacement, checkOwnership } from "./ownership.ts";
import type { LiveTargets } from "./targets.ts";
import { Targets } from "./targets.ts";
import { Tmux, TmuxError, errorMessage } from "./tmux.ts";
import { sanitizeCapture } from "./tools.ts";

const WIDGET_KEY = "pi-tmux";
/** Widget lines shown before collapsing the rest into a "+N more" hint. */
const WIDGET_LIMIT = 8;
/** Listing lines shown through notifications, which cannot scroll. */
const LIST_LIMIT = 40;
/** Scrollback lines requested when capturing from the picker. */
const CAPTURE_LINES = 30;
const LIVE_MARKER = "●";
const GONE_MARKER = "✗";

export interface TmuxUiOptions {
  tmux: Tmux;
  registry: Registry;
  /** Injectable for tests; defaults to a Targets over the same tmux adapter. */
  targets?: Targets;
}

/**
 * Read-mostly TUI surface for the provenance registry: a widget that shows the
 * targets Pi created, and a /tmux command to inspect, capture, switch to, kill,
 * or prune them. Both are inert outside interactive mode, and both name targets
 * the way a user reads them (`session:window.pane`) rather than by tmux IDs.
 */
export function registerTmuxUi(pi: ExtensionAPI, options: TmuxUiOptions): void {
  const targets = options.targets ?? new Targets(options.tmux);
  const { registry } = options;
  let widgetEnabled = true;

  const refreshWidget = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") return; // Widgets exist only in the interactive UI.
    if (!widgetEnabled) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    try {
      const entries = (await registry.list()).filter((entry) => entry.piSessionId === ctx.sessionManager.getSessionId());
      const lines = formatCreated(entries, entries.length ? await targets.liveTargets() : { live: new Set(), labels: new Map() });
      ctx.ui.setWidget(WIDGET_KEY, lines.length ? lines : undefined, { placement: "belowEditor" });
    } catch (error) {
      ctx.ui.setWidget(WIDGET_KEY, [`pi-tmux: ${errorMessage(error)}`], { placement: "belowEditor" });
    }
  };

  pi.on("session_start", (_event, ctx) => refreshWidget(ctx));
  pi.on("turn_end", (_event, ctx) => refreshWidget(ctx));
  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName.startsWith("tmux_")) return refreshWidget(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => { if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined); });

  pi.registerCommand("tmux", {
    description: "Show, inspect, or manage the tmux targets Pi created (widget: /tmux on|off, cleanup: /tmux prune)",
    handler: async (args, ctx) => handleCommand(args, ctx),
  });

  async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const [subcommand = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
    switch (subcommand.toLowerCase()) {
      case "on":
        widgetEnabled = true;
        await refreshWidget(ctx);
        ctx.ui.notify("pi-tmux: widget enabled.", "info");
        return;
      case "off":
        widgetEnabled = false;
        if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
        ctx.ui.notify("pi-tmux: widget hidden. Use /tmux on to restore it.", "info");
        return;
      case "prune":
        if (rest.length > 1 || (rest.length === 1 && rest[0] !== "all")) break;
        await prune(ctx, rest[0] === "all");
        return;
      case "list":
        if (rest.length) break;
        await list(ctx);
        return;
      default:
        break;
    }
    ctx.ui.notify(`pi-tmux: unknown argument ${JSON.stringify(subcommand)}. Use /tmux [list|on|off|prune [all]].`, "warning");
  }

  async function list(ctx: ExtensionCommandContext): Promise<void> {
    let entries: RegistryEntry[];
    let view: LiveTargets;
    try {
      entries = (await registry.list()).filter((entry) => entry.piSessionId === ctx.sessionManager.getSessionId());
      view = await targets.liveTargets();
    } catch (error) {
      ctx.ui.notify(`pi-tmux: ${errorMessage(error)}`, "error");
      return;
    }
    if (!entries.length) {
      ctx.ui.notify("pi-tmux: no tmux targets have been created by this extension yet.", "info");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(formatCreated(entries, view, LIST_LIMIT).join("\n"), "info");
      return;
    }
    await pick(entries, view, ctx);
  }

  async function pick(entries: RegistryEntry[], view: LiveTargets, ctx: ExtensionCommandContext): Promise<void> {
    const labels = entries.map((entry) => describe(entry, view));
    const choice = await ctx.ui.select("tmux targets created by Pi", labels);
    if (choice === undefined) return;
    const entry = entries[labels.indexOf(choice)];
    if (!entry) return;

    const actions = ["Inspect", "Capture recent output", ...(entry.kind === "session" ? ["Switch attached client"] : []), "Kill", "Cancel"];
    const action = await ctx.ui.select(`${describe(entry, view)} — action`, actions);
    if (action === undefined || action === "Cancel") return;

    try {
      if (action === "Inspect") {
        const target = await resolveLive(entry);
        ctx.ui.notify(`${entry.kind} ${entry.id}\n${JSON.stringify(target, null, 2)}`, "info");
      } else if (action === "Capture recent output") {
        await capture(entry, ctx);
      } else if (action === "Switch attached client") {
        await switchTo(entry, ctx);
      } else if (action === "Kill") {
        await kill(entry, ctx, view);
      }
    } catch (error) {
      ctx.ui.notify(`pi-tmux: ${errorMessage(error)}`, "error");
    }
    await refreshWidget(ctx);
  }

  async function resolveLive(entry: RegistryEntry): Promise<unknown> {
    const view = await targets.liveTargets();
    if (!isTrackedLive(entry, view)) throw new TmuxError(`Refusing ${entry.id}: its provenance does not match this tmux server.`, "invalid_target");
    if (entry.kind === "session") return targets.session(entry.id);
    if (entry.kind === "window") return targets.window(entry.id);
    return targets.pane(entry.id);
  }

  /** Captures from the entry itself, or the active pane inside it. */
  async function capture(entry: RegistryEntry, ctx: ExtensionCommandContext): Promise<void> {
    await resolveLive(entry);
    let paneId = entry.kind === "pane" ? entry.id : undefined;
    if (!paneId) {
      const panes = await targets.panes();
      const inside = panes.filter((pane) => entry.kind === "session" ? pane.sessionId === entry.id : pane.windowId === entry.id);
      paneId = (inside.find((pane) => pane.active) ?? inside[0])?.id;
    }
    if (!paneId) throw new TmuxError(`${entry.kind} ${entry.name} no longer exists on the tmux server.`, "invalid_target");
    const output = sanitizeCapture(await options.tmux.run(["capture-pane", "-p", "-t", paneId, "-S", `-${CAPTURE_LINES}`]));
    const lines = output.replace(/\n$/, "").split("\n").slice(-CAPTURE_LINES);
    ctx.ui.notify(`${entry.name} — snapshot (not a command result):\n${lines.join("\n")}`, "info");
  }

  async function switchTo(entry: RegistryEntry, ctx: ExtensionCommandContext): Promise<void> {
    await resolveLive(entry); // Revalidate provenance before switching.
    const clients = await targets.clients();
    if (!clients.length) throw new TmuxError("No attached tmux client is available; attach a client first.", "invalid_target");
    let client = clients[0]!;
    if (clients.length > 1) {
      const chosen = await ctx.ui.select("Attached tmux clients", clients.map((item) => `${item.name} (${item.tty})`));
      if (chosen === undefined) return;
      client = clients[clients.findIndex((item) => `${item.name} (${item.tty})` === chosen)] ?? client;
    }
    await options.tmux.run(["switch-client", "-c", client.name, "-t", entry.id]);
    ctx.ui.notify(`pi-tmux: switched ${client.name} to ${entry.name}.`, "info");
  }

  async function kill(entry: RegistryEntry, ctx: ExtensionCommandContext, view: LiveTargets): Promise<void> {
    if (entry.piSessionId !== ctx.sessionManager.getSessionId()) throw new TmuxError("Target belongs to another Pi session.", "invalid_target");
    await resolveLive(entry);
    const before = await checkOwnership(targets, registry, entry.kind, entry.id, ctx.sessionManager.getSessionId());
    if (!before.exclusive) await confirmMutation(ctx, `kill ${entry.kind}`, `${describe(entry, view)} (${before.reason})`);
    await resolveLive(entry); // Revalidate immediately before mutating.
    const after = await checkOwnership(targets, registry, entry.kind, entry.id, ctx.sessionManager.getSessionId());
    assertSamePlacement(before, after);
    await options.tmux.run([`kill-${entry.kind}`, "-t", entry.id]);
    const forgotten = await registry.forget(entry.kind, entry.id, { sessionId: entry.sessionId }).catch(() => 0);
    ctx.ui.notify(`pi-tmux: killed ${entry.kind} ${entry.name}; removed ${forgotten} registry entr${forgotten === 1 ? "y" : "ies"}.`, "info");
  }

  /** Drops entries whose target no longer exists, refusing when nothing is visible. */
  async function prune(ctx: ExtensionCommandContext, all = false): Promise<void> {
    let entries: RegistryEntry[];
    let view: LiveTargets;
    try {
      entries = (await registry.list()).filter((entry) => all || entry.piSessionId === ctx.sessionManager.getSessionId());
      view = await targets.liveTargets();
    } catch (error) {
      ctx.ui.notify(`pi-tmux: ${errorMessage(error)}`, "error");
      return;
    }
    if (!view.live.size) {
      ctx.ui.notify("pi-tmux: refusing to prune because no tmux sessions/windows/panes are visible (is the server running?).", "warning");
      return;
    }
    const gone = entries.filter((entry) => (entry.serverIdentity === view.serverIdentity || !entry.serverIdentity) && !isTrackedLive(entry, view));
    if (!gone.length) {
      ctx.ui.notify("pi-tmux: nothing to prune; every recorded target still exists.", "info");
      return;
    }
    const approved = ctx.hasUI
      ? await ctx.ui.confirm("Prune tmux registry", `Remove ${gone.length} recorded target(s) that no longer exist on the server?\n${gone.map((entry) => `  ${entry.kind} ${labelOf(entry, view.labels)}`).join("\n")}`)
      : false;
    if (!approved) {
      ctx.ui.notify("pi-tmux: prune cancelled.", "info");
      return;
    }
    const current = await targets.liveTargets();
    if (!current.live.size || current.serverIdentity !== view.serverIdentity) throw new TmuxError("tmux server changed before prune.", "invalid_target");
    const removed = await registry.remove((entry) => (all || entry.piSessionId === ctx.sessionManager.getSessionId())
      && (entry.serverIdentity === current.serverIdentity || !entry.serverIdentity) && !isTrackedLive(entry, current));
    ctx.ui.notify(`pi-tmux: pruned ${removed} gone entr${removed === 1 ? "y" : "ies"}.`, "info");
  }
}

/** The readable name for a target: its live label, the name recorded at creation, or its parent's path keyed by ID. */
export function labelOf(entry: RegistryEntry, labels: Map<string, string>): string {
  const live = entry.serverIdentity ? labels.get(entry.id) : undefined;
  if (live) return live;
  if (entry.name && entry.name !== entry.id) return entry.name;
  const parent = (entry.windowId ? labels.get(entry.windowId) : undefined) ?? labels.get(entry.sessionId);
  // The plain ID is last-resort disambiguation: alongside the parent path it names which pane this was.
  return parent ? `${parent} (${entry.id})` : `untitled (${entry.id})`;
}

/**
 * Renders registry entries as plain lines, newest live target first, using
 * readable names such as `pi-tmux:opencode.1` instead of tmux IDs.
 */
export function formatCreated(entries: RegistryEntry[], view: LiveTargets, limit = WIDGET_LIMIT, now = Date.now()): string[] {
  if (!entries.length) return [];
  const ordered = [...entries].sort((a, b) => ranked(a, view) - ranked(b, view)
    || Date.parse(b.createdAt) - Date.parse(a.createdAt)
    || a.id.localeCompare(b.id));
  const shown = ordered.slice(0, limit).map((entry) => {
    const marker = isTrackedLive(entry, view) ? LIVE_MARKER : GONE_MARKER;
    // A parent equal to the containing session is already visible in the label path.
    const parent = entry.parentSessionId && entry.parentSessionId !== entry.sessionId
      ? `  ← ${view.labels.get(entry.parentSessionId) ?? entry.parentSessionId}`
      : "";
    return `${marker} ${labelOf(entry, view.labels)}  ${entry.kind}  ${formatAge(entry.createdAt, now)}${parent}`;
  });
  const hidden = ordered.length - shown.length;
  const gone = ordered.filter((entry) => !isTrackedLive(entry, view)).length;
  const summary = `pi-tmux · ${ordered.length} created${gone ? ` · ${gone} gone` : ""}${hidden > 0 ? ` · +${hidden} more (/tmux)` : ""}`;
  return [summary, ...shown];
}

function ranked(entry: RegistryEntry, view: LiveTargets): number {
  const kindOrder: Record<RegistryKind, number> = { session: 0, window: 1, pane: 2 };
  return (isTrackedLive(entry, view) ? 0 : 10) + kindOrder[entry.kind];
}

/** Picker label: readable name first, machine ID last so it stays unambiguous. */
function describe(entry: RegistryEntry, view: LiveTargets): string {
  const marker = isTrackedLive(entry, view) ? LIVE_MARKER : GONE_MARKER;
  return `${marker} ${labelOf(entry, view.labels)} (${entry.kind} ${entry.id}) ${formatAge(entry.createdAt, Date.now())}`;
}

function formatAge(createdAt: string, now: number): string {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return "?";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
