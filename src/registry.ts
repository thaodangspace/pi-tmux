import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { TmuxError, errorMessage } from "./tmux.ts";
import type { LiveTargets } from "./targets.ts";

export function isTrackedLive(entry: RegistryEntry, view: LiveTargets): boolean {
  return !!entry.serverIdentity && entry.serverIdentity === view.serverIdentity && view.live.has(entry.id);
}

export type RegistryKind = "session" | "window" | "pane";

/**
 * Provenance record for one tmux target created through this extension.
 * tmux itself has no "created from" metadata, so ownership is tracked here and
 * keyed by stable IDs (`$N` session, `@N` window, `%N` pane).
 */
export interface RegistryEntry {
  kind: RegistryKind;
  /** Stable tmux ID of the created target. */
  id: string;
  /** Owning session ID; identical to `id` for sessions. */
  sessionId: string;
  /** Owning window ID, when the target is a pane. */
  windowId?: string;
  /** Session the creating agent ran in, if it could be determined. */
  parentSessionId: string | null;
  name: string;
  cwd?: string;
  /** Tool that created the target. */
  tool: string;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** Server fingerprint; legacy entries without it are never trusted as live. */
  serverIdentity?: string;
}

interface RegistryData {
  version: 1;
  targets: RegistryEntry[];
}

const REGISTRY_VERSION = 1;
/** Oldest entries are dropped past this bound so the file cannot grow without limit. */
const MAX_ENTRIES = 2_000;

export function defaultRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_TMUX_REGISTRY) return env.PI_TMUX_REGISTRY;
  const stateHome = env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
  return path.join(stateHome, "pi-tmux", "registry.json");
}

export class Registry {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string = defaultRegistryPath()) {}

  async list(): Promise<RegistryEntry[]> {
    await this.writes;
    return (await this.read()).targets;
  }

  async record(entry: RegistryEntry): Promise<void> {
    await this.mutate((data) => {
      const others = data.targets.filter((target) => !(target.kind === entry.kind && target.id === entry.id));
      const targets = [...others, entry];
      data.targets = targets.length > MAX_ENTRIES ? targets.slice(targets.length - MAX_ENTRIES) : targets;
    });
  }

  /** Removes every entry matching the predicate and reports how many were dropped. */
  async remove(predicate: (entry: RegistryEntry) => boolean): Promise<number> {
    let removed = 0;
    await this.mutate((data) => {
      const kept = data.targets.filter((entry) => !predicate(entry));
      removed = data.targets.length - kept.length;
      data.targets = kept;
    });
    return removed;
  }

  /** Drops a session and every window/pane recorded under it. */
  async removeSession(sessionId: string): Promise<number> {
    return this.remove((entry) => entry.id === sessionId || entry.sessionId === sessionId);
  }

  /** Drops a window and every pane recorded under it. */
  async removeWindow(sessionId: string, windowId: string): Promise<number> {
    return this.remove((entry) => entry.id === windowId || ((entry.kind === "pane" || entry.kind === "window") && entry.windowId === windowId && entry.sessionId === sessionId));
  }

  async removePane(paneId: string): Promise<number> {
    return this.remove((entry) => entry.kind === "pane" && entry.id === paneId);
  }

  /**
   * Drops a target and everything recorded underneath it: a session takes its
   * windows and panes, a window takes its panes.
   */
  async forget(kind: RegistryKind, id: string, context: { sessionId?: string } = {}): Promise<number> {
    if (kind === "session") return this.removeSession(id);
    if (kind === "window") {
      return this.remove((entry) => entry.id === id
        || ((entry.kind === "window" || entry.kind === "pane") && entry.windowId === id
          && (context.sessionId === undefined || entry.sessionId === context.sessionId)));
    }
    return this.removePane(id);
  }

  private async read(): Promise<RegistryData> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: REGISTRY_VERSION, targets: [] };
      throw new TmuxError(`Could not read the tmux registry at ${this.file}: ${errorMessage(error)}`, "command_failed");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TmuxError(`The tmux registry at ${this.file} is not valid JSON; refusing to overwrite it. Remove or repair the file to continue.`, "command_failed");
    }
    if (parsed === null || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== REGISTRY_VERSION) {
      throw new TmuxError(`Unsupported tmux registry version at ${this.file}; refusing to overwrite it.`, "command_failed");
    }
    const targets = (parsed as { targets?: unknown }).targets;
    if (!Array.isArray(targets)) {
      throw new TmuxError(`The tmux registry at ${this.file} has an unexpected shape; refusing to overwrite it.`, "command_failed");
    }
    if (!targets.every(isEntry)) throw new TmuxError(`Invalid tmux registry entry at ${this.file}; refusing to overwrite it.`, "command_failed");
    return { version: REGISTRY_VERSION, targets };
  }

  private async mutate(change: (data: RegistryData) => void): Promise<void> {
    const run = async () => {
      const data = await this.read();
      change(data);
      await this.write(data);
    };
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    return next;
  }

  private async write(data: RegistryData): Promise<void> {
    const directory = path.dirname(this.file);
    const temporary = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new TmuxError(`Could not write the tmux registry at ${this.file}: ${errorMessage(error)}`, "command_failed");
    }
  }
}

function isEntry(value: unknown): value is RegistryEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (entry.kind === "session" || entry.kind === "window" || entry.kind === "pane")
    && typeof entry.id === "string" && typeof entry.sessionId === "string"
    && (typeof entry.parentSessionId === "string" || entry.parentSessionId === null)
    && typeof entry.name === "string" && typeof entry.tool === "string" && typeof entry.createdAt === "string"
    && (entry.serverIdentity === undefined || typeof entry.serverIdentity === "string");
}
