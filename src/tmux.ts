import { spawn, type ChildProcess } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

export class TmuxError extends Error {
  constructor(
    message: string,
    readonly code: "unavailable" | "timeout" | "cancelled" | "output_limit" | "command_failed" | "invalid_target" | "invalid_option" = "command_failed",
    readonly operation?: string,
  ) {
    super(message);
    this.name = "TmuxError";
  }
}

export interface TmuxOptions {
  /** Intended for tests only. Normal use always addresses the user's default server. */
  socket?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  spawnProcess?: typeof spawn;
}

export class Tmux {
  constructor(private readonly options: TmuxOptions = {}) {}

  async run(args: readonly string[], options: { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<string> {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
      throw new TmuxError("Invalid tmux argument.", "invalid_option");
    }
    if (options.signal?.aborted) throw new TmuxError("tmux operation cancelled before it started.", "cancelled");

    const argv = [...(this.options.socket ? ["-S", this.options.socket] : []), ...args];
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = options.maxOutputBytes ?? this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new TmuxError("tmux timeout and output limit must be positive finite values.", "invalid_option");
    }
    const spawnProcess = this.options.spawnProcess ?? spawn;

    return await new Promise<string>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawnProcess("tmux", argv, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        reject(new TmuxError(`Could not start tmux: ${errorMessage(error)}`, "unavailable"));
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;
      let failure: TmuxError | undefined;
      let forceTimer: NodeJS.Timeout | undefined;
      const terminate = (reason: TmuxError) => {
        if (failure) return;
        failure = reason;
        child.kill("SIGTERM");
        forceTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      };
      const onAbort = () => terminate(new TmuxError("tmux operation cancelled.", "cancelled"));
      const timer = setTimeout(() => terminate(new TmuxError(`tmux timed out after ${timeoutMs}ms.`, "timeout")), timeoutMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        const remaining = Math.max(0, maxBytes - totalBytes + buffer.length);
        if (remaining) target.push(buffer.subarray(0, remaining));
        if (totalBytes > maxBytes) terminate(new TmuxError(`tmux output exceeded the ${maxBytes}-byte limit.`, "output_limit"));
      };
      child.stdout?.on("data", collect(stdout));
      child.stderr?.on("data", collect(stderr));
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new TmuxError(`Could not run tmux: ${error.message}`, "unavailable"));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (failure) {
          reject(failure);
          return;
        }
        const out = Buffer.concat(stdout).toString("utf8");
        const err = Buffer.concat(stderr).toString("utf8").trim();
        if (code !== 0) {
          const detail = err || `tmux exited with status ${code ?? "unknown"}`;
          const unavailable = /no server running|failed to connect to server|error connecting to|no such file or directory.*socket/i.test(detail);
          reject(new TmuxError(`${detail}${unavailable ? " Start tmux or verify the server socket." : ""}`, unavailable ? "unavailable" : "command_failed"));
          return;
        }
        resolve(out);
      });

      function cleanup() {
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        options.signal?.removeEventListener("abort", onAbort);
      }
    });
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
