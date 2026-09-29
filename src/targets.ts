import { Tmux, TmuxError } from "./tmux.ts";

export interface SessionTarget {
  id: string;
  name: string;
  attached: number;
  windows: number;
}
export interface WindowTarget {
  sessionId: string;
  sessionName: string;
  id: string;
  index: number;
  name: string;
  active: boolean;
  panes: number;
}
export interface ClientTarget {
  name: string;
  sessionId: string;
  tty: string;
}
export interface PaneTarget {
  sessionId: string;
  sessionName: string;
  windowId: string;
  windowIndex: number;
  windowName: string;
  id: string;
  index: number;
  active: boolean;
  currentPath: string;
  width: number;
  height: number;
}

/** Liveness of every target, plus a human-readable label per stable ID. */
export interface LiveTargets {
  live: Set<string>;
  labels: Map<string, string>;
}

const SESSION_FORMAT = "#{session_id}\t#{session_name}\t#{session_attached}\t#{session_windows}";
const WINDOW_FORMAT = "#{session_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}";
const PANE_FORMAT = "#{session_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}";
const CLIENT_FORMAT = "#{client_name}\t#{session_id}\t#{client_tty}";

export class Targets {
  constructor(readonly tmux: Tmux) {}

  async sessions(signal?: AbortSignal): Promise<SessionTarget[]> {
    const output = await listOrEmpty(this.tmux, ["list-sessions", "-F", SESSION_FORMAT], signal);
    return parseRows(output, 4).map(([id, name, attached, windows]) => {
      if (!/^\$\d+$/.test(id)) throw malformed("session", id);
      return { id, name, attached: integer(attached), windows: integer(windows) };
    });
  }

  async windows(signal?: AbortSignal): Promise<WindowTarget[]> {
    const output = await listOrEmpty(this.tmux, ["list-windows", "-a", "-F", WINDOW_FORMAT], signal);
    return parseRows(output, 7).map(([sessionId, sessionName, id, index, name, active, panes]) => {
      if (!/^\$\d+$/.test(sessionId) || !/^@\d+$/.test(id)) throw malformed("window", id);
      return { sessionId, sessionName, id, index: integer(index), name, active: active === "1", panes: integer(panes) };
    });
  }

  async clients(signal?: AbortSignal): Promise<ClientTarget[]> {
    const output = await listOrEmpty(this.tmux, ["list-clients", "-F", CLIENT_FORMAT], signal);
    return parseRows(output, 3).map(([name, sessionId, tty]) => {
      if (!name || !/^\$\d+$/.test(sessionId)) throw new TmuxError("tmux returned invalid client listing data.", "command_failed");
      return { name, sessionId, tty };
    });
  }

  async panes(signal?: AbortSignal): Promise<PaneTarget[]> {
    const output = await listOrEmpty(this.tmux, ["list-panes", "-a", "-F", PANE_FORMAT], signal);
    return parseRows(output, 11).map(([sessionId, sessionName, windowId, windowIndex, windowName, id, index, active, currentPath, width, height]) => {
      if (!/^\$\d+$/.test(sessionId) || !/^@\d+$/.test(windowId) || !/^%\d+$/.test(id)) throw malformed("pane", id);
      return {
        sessionId, sessionName, windowId, windowIndex: integer(windowIndex), windowName,
        id, index: integer(index), active: active === "1", currentPath,
        width: integer(width), height: integer(height),
      };
    });
  }

  async session(selector: string, signal?: AbortSignal): Promise<SessionTarget> {
    return resolve(selector, await this.sessions(signal), (t) => t.id, (t) => [t.name]);
  }
  async window(selector: string, signal?: AbortSignal): Promise<WindowTarget> {
    return resolve(selector, await this.windows(signal), (t) => t.id, (t) => [`${t.sessionName}:${t.index}`, `${t.sessionName}:${t.name}`, t.name]);
  }
  async client(selector: string, signal?: AbortSignal): Promise<ClientTarget> {
    return resolve(selector, await this.clients(signal), (client) => client.name, (client) => [client.tty]);
  }
  async pane(selector: string, signal?: AbortSignal): Promise<PaneTarget> {
    return resolve(selector, await this.panes(signal), (t) => t.id, (t) => [`${t.sessionName}:${t.windowIndex}.${t.index}`, `${t.sessionName}:${t.windowName}.${t.index}`]);
  }

  /** Stable IDs of every live session, window, and pane. */
  async liveIds(signal?: AbortSignal): Promise<Set<string>> {
    return (await this.liveTargets(signal)).live;
  }

  /**
   * Liveness plus human-readable labels in a single pass: sessions by name,
   * windows by `session:window`, panes by `session:window.pane`.
   */
  async liveTargets(signal?: AbortSignal): Promise<LiveTargets> {
    const sessions = await this.sessions(signal);
    const windows = await this.windows(signal);
    const panes = await this.panes(signal);
    const live = new Set<string>();
    const labels = new Map<string, string>();
    for (const session of sessions) {
      live.add(session.id);
      labels.set(session.id, session.name);
    }
    for (const window of windows) {
      live.add(window.id);
      labels.set(window.id, `${window.sessionName}:${window.name}`);
    }
    for (const pane of panes) {
      live.add(pane.id);
      labels.set(pane.id, `${pane.sessionName}:${pane.windowName}.${pane.index}`);
    }
    return { live, labels };
  }
}

async function listOrEmpty(tmux: Tmux, args: string[], signal?: AbortSignal): Promise<string> {
  try {
    return await tmux.run(args, { signal });
  } catch (error) {
    if (error instanceof TmuxError && /no server running|no sessions|no clients|no current target/i.test(error.message)) return "";
    throw error;
  }
}

function parseRows(output: string, columns: number): string[][] {
  if (!output.trim()) return [];
  return output.replace(/\n$/, "").split("\n").map((line) => {
    const fields = line.split("\t");
    if (fields.length !== columns) throw new TmuxError("Could not parse tmux listing output; check the installed tmux version.", "command_failed");
    return fields;
  });
}
function integer(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new TmuxError("tmux returned invalid numeric listing data.", "command_failed");
  return result;
}
function malformed(kind: string, id: string): TmuxError {
  return new TmuxError(`tmux returned an invalid ${kind} ID: ${JSON.stringify(id)}`, "command_failed");
}
function resolve<T>(selector: string, items: T[], idOf: (item: T) => string, aliases: (item: T) => string[]): T {
  if (typeof selector !== "string" || !selector.trim()) throw new TmuxError("A non-empty explicit target is required.", "invalid_target");
  const exactId = items.find((item) => idOf(item) === selector);
  if (exactId) return exactId;
  const matches = items.filter((item) => aliases(item).includes(selector));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new TmuxError(`Target ${JSON.stringify(selector)} is ambiguous; use a stable tmux ID.`, "invalid_target");
  throw new TmuxError(`Target ${JSON.stringify(selector)} was not found. List targets and use its stable ID.`, "invalid_target");
}
