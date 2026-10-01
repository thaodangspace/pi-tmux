import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { TmuxError, errorMessage } from "./tmux.ts";

/**
 * Shared durable file primitives for the on-disk registries.
 *
 * Both the legacy `SubagentJobV1` registry and the `SubagentSessionV1` /
 * `SubagentTurnV1` registry need exactly the same crash and concurrency
 * guarantees, so they live here once instead of being duplicated:
 *
 * - every write is fsynced and published with an atomic rename, so a reader can
 *   never observe a half-written file;
 * - read-modify-write is serialized with an owner-only lock file that is stolen
 *   only when its owner is provably dead or the filesystem cannot report
 *   liveness, so parent and child processes cannot clobber one another;
 * - a held "breaker" is never stolen, so two contenders can never remove a
 *   stale lock at the same time.
 */

export interface DurableStateFileOptions {
  /** Human-readable noun used in error messages, e.g. "subagent job registry". */
  label: string;
  /** How long to wait for the cross-process lock before failing. */
  lockTimeoutMs: number;
  /** Delay between lock acquisition attempts. */
  lockRetryMs: number;
  /** Injectable clock for deterministic tests. */
  now: () => Date;
}

export class DurableStateFile {
  readonly file: string;
  private readonly label: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly now: () => Date;
  private lockToken = "";

  constructor(file: string, options: DurableStateFileOptions) {
    this.file = file;
    this.label = options.label;
    this.lockTimeoutMs = options.lockTimeoutMs;
    this.lockRetryMs = options.lockRetryMs;
    this.now = options.now;
  }

  /** Reads the raw file, or `undefined` when it does not exist. Never returns partial content. */
  async readText(): Promise<string | undefined> {
    try {
      return await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new TmuxError(`Could not read the ${this.label} at ${this.file}: ${errorMessage(error)}`, "command_failed");
    }
  }

  /** Atomically replaces the file with `content` using fsync + rename. */
  async writeText(content: string): Promise<void> {
    const directory = path.dirname(this.file);
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(temporary, "w", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new TmuxError(`Could not write the ${this.label} at ${this.file}: ${errorMessage(error)}`, "command_failed");
    }
    await handle.close();
    try {
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new TmuxError(`Could not replace the ${this.label} at ${this.file}: ${errorMessage(error)}`, "command_failed");
    }
    // Directory fsync makes the rename itself durable; unsupported on some filesystems.
    try {
      const directoryHandle = await open(directory, "r");
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } catch { /* Best effort. */ }
  }

  /** Serializes a read-modify-write against every other process using this file. */
  async withLock<T>(run: () => Promise<T>): Promise<T> {
    await this.acquireLock();
    try {
      return await run();
    } finally {
      await this.releaseLock();
    }
  }

  private lockPath(): string {
    return `${this.file}.lock`;
  }

  private async acquireLock(): Promise<void> {
    const lockPath = this.lockPath();
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      this.lockToken = `${process.pid}:${randomUUID()}`;
      if (await this.tryCreateLock(lockPath, this.lockToken)) return;
      const info = await this.readLockInfo(lockPath);
      if (info && !isProcessAlive(info.pid)) {
        // The owner is gone. Recovery is serialized through a separate breaker
        // lock so two contenders can never remove the lock concurrently.
        const broke = await this.breakStaleLock(lockPath, info.token);
        if (!broke) {
          if (Date.now() >= deadline) throw this.lockTimeoutError(lockPath);
          await delay(this.lockRetryMs);
        }
        continue;
      }
      if (Date.now() >= deadline) throw this.lockTimeoutError(lockPath);
      await delay(this.lockRetryMs);
    }
  }

  private lockTimeoutError(lockPath: string): TmuxError {
    return new TmuxError(
      `Timed out after ${this.lockTimeoutMs}ms waiting for the ${this.label} lock at ${lockPath}. If no other Pi process is writing, remove the lock file and retry.`,
      "command_failed",
    );
  }

  /**
   * Atomically creates a lock file with complete content: the payload is
   * written to a unique temp file first and then hard-linked into place, so a
   * crash can never expose an empty or partial lock. `link` fails with EEXIST
   * when the target exists, which is the mutual-exclusion primitive.
   */
  private async tryCreateLock(lockPath: string, token: string): Promise<boolean> {
    const content = JSON.stringify({ pid: process.pid, token, acquiredAt: this.now().toISOString() });
    const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      await link(temporary, lockPath);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      // Filesystems without hard links still get an exclusive create; the only
      // cost is that a crash could leave partial content, which fails closed.
      if (code === "EPERM" || code === "ENOSYS" || code === "EOPNOTSUPP" || code === "ENOTSUP") {
        return this.tryCreateLockExclusive(lockPath, content);
      }
      throw new TmuxError(`Could not lock the ${this.label} at ${this.file}: ${errorMessage(error)}`, "command_failed");
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async tryCreateLockExclusive(lockPath: string, content: string): Promise<boolean> {
    try {
      await writeFile(lockPath, content, { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw new TmuxError(`Could not lock the ${this.label} at ${this.file}: ${errorMessage(error)}`, "command_failed");
    }
  }

  /**
   * Removes a lock whose owner is confirmed dead. The breaker file guarantees
   * at most one remover at a time; while it is held, no other process can
   * create or remove `lockPath`, so the token re-check and unlink are atomic
   * with respect to every other contender. The breaker is never stolen: if a
   * process dies while holding it, waiters fail closed rather than risk two
   * concurrent removers.
   */
  private async breakStaleLock(lockPath: string, staleToken: string): Promise<boolean> {
    const breakPath = `${lockPath}.break`;
    const breakToken = `${process.pid}:${randomUUID()}`;
    if (!(await this.tryCreateLock(breakPath, breakToken))) return false;
    try {
      const current = await this.readLockInfo(lockPath);
      if (current?.token === staleToken) await rm(lockPath, { force: true }).catch(() => undefined);
      return true;
    } finally {
      await this.removeOwnLock(breakPath, breakToken);
    }
  }

  private async readLockInfo(lockPath: string): Promise<{ pid: number; token: string } | undefined> {
    try {
      const parsed = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown; token?: unknown };
      if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0 || typeof parsed.token !== "string" || !parsed.token) return undefined;
      return { pid: parsed.pid as number, token: parsed.token };
    } catch {
      return undefined; // Missing, unreadable, or corrupt: never assume it is safe to break.
    }
  }

  private async removeOwnLock(lockPath: string, token: string): Promise<void> {
    const info = await this.readLockInfo(lockPath);
    if (info?.token === token) await rm(lockPath, { force: true }).catch(() => undefined);
  }

  private async releaseLock(): Promise<void> {
    await this.removeOwnLock(this.lockPath(), this.lockToken);
  }
}

/** A PID is only treated as dead on ESRCH; EPERM and unknown errors fail closed. */
function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
