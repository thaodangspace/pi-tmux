import type { Registry, RegistryKind } from "./registry.ts";
import { Targets } from "./targets.ts";
import { TmuxError } from "./tmux.ts";

export interface Ownership {
  exclusive: boolean;
  fingerprint: string;
  reason: string;
}

/** Fail closed for linked windows and grouped sessions, including links not chosen by target resolution. */
export async function checkOwnership(targets: Targets, registry: Registry, kind: RegistryKind, id: string, piSessionId: string, signal?: AbortSignal): Promise<Ownership> {
  const output = await targets.tmux.run(["list-panes", "-a", "-F", "#{session_id}\t#{window_id}\t#{pane_id}\t#{window_linked}\t#{session_grouped}"], { signal });
  const rows = output.trim().split("\n").map((line) => line.split("\t"));
  if (rows.some((row) => row.length !== 5 || !/^\$\d+$/.test(row[0]!) || !/^@\d+$/.test(row[1]!) || !/^%\d+$/.test(row[2]!) || !/^[01]$/.test(row[3]!) || !/^[01]$/.test(row[4]!))) {
    throw new TmuxError("Could not parse tmux ownership data.", "command_failed");
  }
  const matches = rows.filter((row) => row[kind === "session" ? 0 : kind === "window" ? 1 : 2] === id);
  if (!matches.length) throw new TmuxError(`Target ${id} was not found.`, "invalid_target");
  const sessions = [...new Set(matches.map((row) => row[0]!))];
  const sessionRows = rows.filter((row) => sessions.includes(row[0]!));
  const fingerprint = JSON.stringify({ placements: matches.map((row) => row.join(":" )).sort(), sessionLinks: sessionRows.map((row) => row.join(":" )).sort() });
  if (sessions.length !== 1 || sessionRows.some((row) => row[3] === "1" || row[4] === "1")) {
    return { exclusive: false, fingerprint, reason: "target is linked or grouped with another session" };
  }
  const identity = await targets.serverIdentity(signal);
  const owned = !!identity && (await registry.list()).some((entry) => entry.kind === "session" && entry.id === sessions[0] && entry.piSessionId === piSessionId && entry.serverIdentity === identity);
  return { exclusive: owned, fingerprint, reason: owned ? "" : "session is not owned by this Pi conversation" };
}

export function assertSamePlacement(before: Ownership, after: Ownership): void {
  if (before.fingerprint !== after.fingerprint || (before.exclusive && !after.exclusive)) {
    throw new TmuxError("Target placement or ownership changed before mutation.", "invalid_target");
  }
}
