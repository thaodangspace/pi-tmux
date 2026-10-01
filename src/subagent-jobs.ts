import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { TmuxError, errorMessage } from "./tmux.ts";

/**
 * Durable registry for delegated Pi subagent jobs (`SubagentJobV1`).
 *
 * This is deliberately separate from the tmux target provenance registry
 * (`src/registry.ts`) so the existing target behaviour stays unchanged. It is a
 * pure persistence/state-machine layer: no child reporter, launch tools, or
 * notifications live here yet, but the API is shaped so both the parent-side
 * extension and the follow-up Pi child reporter can use it.
 *
 * Durability contract:
 * - every lifecycle transition is written with fsync + atomic rename before the
 *   caller can observe it, so a crash cannot expose a half-written file;
 * - read-modify-write is serialized with an owner-only lock file that is stolen
 *   when its owner dies or it goes stale, so parent and child processes cannot
 *   clobber one another;
 * - the file is bounded, and acknowledged terminal history (not active or
 *   undelivered work) is the only thing ever evicted.
 */

export const SUBAGENT_JOB_VERSION = 1 as const;

export const SUBAGENT_JOB_STATUSES = ["created", "starting", "running", "completed", "failed", "cancelled", "lost"] as const;
export type SubagentJobStatus = (typeof SUBAGENT_JOB_STATUSES)[number];
export type TerminalSubagentJobStatus = "completed" | "failed" | "cancelled" | "lost";

const TERMINAL_STATUSES: ReadonlySet<SubagentJobStatus> = new Set<TerminalSubagentJobStatus>(["completed", "failed", "cancelled", "lost"]);

export function isTerminalStatus(status: SubagentJobStatus): status is TerminalSubagentJobStatus {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Legal forward transitions. A transition to the current status is idempotent
 * (including a duplicate terminal transition); every other move out of a
 * terminal status is rejected, which is what makes a terminal outcome
 * immutable. `created -> running` and `starting -> completed` are intentionally
 * illegal: a job must pass through `starting` and `running` in order.
 */
const LEGAL_TRANSITIONS: Record<SubagentJobStatus, readonly SubagentJobStatus[]> = {
  created: ["starting", "failed", "cancelled", "lost"],
  starting: ["running", "failed", "cancelled", "lost"],
  running: ["completed", "failed", "cancelled", "lost"],
  completed: [],
  failed: [],
  cancelled: [],
  lost: [],
};

/**
 * The tmux IDs are `null` until the job is bound. The invariant is:
 * `created` jobs may exist without a tmux target; `starting`/`running` jobs must
 * have both stable IDs. Human-readable names are never sufficient.
 */
export interface SubagentJobV1 {
  version: 1;
  jobId: string;
  agent: "pi";
  status: SubagentJobStatus;
  parentPiSessionId: string | null;
  /** Stable tmux session ID (`$N`), or null until bound. */
  tmuxSessionId: string | null;
  /** Stable tmux pane ID (`%N`), or null until bound. */
  tmuxPaneId: string | null;
  /**
   * tmux server fingerprint (`pid:start_time`) the target belonged to when
   * bound. Optional for forward compatibility, but it is what makes
   * reconciliation safe across server restarts and tmux ID reuse.
   */
  serverIdentity?: string;
  cwd: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  resultPath?: string;
  error?: string;
  /** Registry-global, monotonic sequence assigned when the job first becomes terminal. */
  completionSeq?: number;
  /** Set once the parent has acknowledged the terminal outcome. */
  notifiedAt?: string;
}

interface SubagentJobState {
  version: 1;
  nextCompletionSeq: number;
  jobs: SubagentJobV1[];
}

export interface CreateSubagentJobInput {
  cwd: string;
  parentPiSessionId: string | null;
}

export interface BindSubagentJobInput {
  tmuxSessionId: string;
  tmuxPaneId: string;
  serverIdentity?: string;
}

export interface TransitionSubagentJobOptions {
  /** Override the transition timestamp (tests / reporters with an authoritative clock). */
  at?: string;
  exitCode?: number;
  resultPath?: string;
  error?: string;
}

/** Liveness snapshot a caller derives from tmux (see `Targets.liveTargets`). */
export interface SubagentJobLiveView {
  live: ReadonlySet<string>;
  serverIdentity?: string;
}

export interface SubagentJobRegistryOptions {
  /** Acknowledged terminal jobs retained before the oldest are evicted (default 100). */
  maxAcknowledged?: number;
  /** Absolute hard bound on total jobs; creation fails rather than evicting live data (default 500). */
  maxJobs?: number;
  /** How long to wait for the cross-process lock before failing (default 10s). */
  lockTimeoutMs?: number;
  /** Delay between lock acquisition attempts (default 25ms). */
  lockRetryMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

const DEFAULT_MAX_ACKNOWLEDGED = 100;
const DEFAULT_MAX_JOBS = 500;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const SESSION_ID = /^\$\d+$/;
const PANE_ID = /^%\d+$/;

export function defaultSubagentJobsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_TMUX_SUBAGENT_JOBS) return env.PI_TMUX_SUBAGENT_JOBS;
  const stateHome = env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
  return path.join(stateHome, "pi-tmux", "subagent-jobs.json");
}

export class SubagentJobRegistry {
  private writes: Promise<unknown> = Promise.resolve();
  private lockToken = "";
  private readonly maxAcknowledged: number;
  private readonly maxJobs: number;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly now: () => Date;

  constructor(readonly file: string = defaultSubagentJobsPath(), options: SubagentJobRegistryOptions = {}) {
    this.maxAcknowledged = positiveInteger(options.maxAcknowledged ?? DEFAULT_MAX_ACKNOWLEDGED, "maxAcknowledged");
    this.maxJobs = positiveInteger(options.maxJobs ?? DEFAULT_MAX_JOBS, "maxJobs");
    if (this.maxAcknowledged > this.maxJobs) throw new TmuxError("maxAcknowledged cannot exceed maxJobs.", "invalid_option");
    this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, "lockTimeoutMs");
    this.lockRetryMs = positiveInteger(options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS, "lockRetryMs");
    this.now = options.now ?? (() => new Date());
  }

  /** Creates a `created` job with a generated opaque ID and no tmux target yet. */
  async create(input: CreateSubagentJobInput): Promise<SubagentJobV1> {
    const cwd = requireNonEmptyString(input?.cwd, "cwd");
    const parentPiSessionId = input.parentPiSessionId;
    if (!(parentPiSessionId === null || (typeof parentPiSessionId === "string" && parentPiSessionId.length > 0))) {
      throw new TmuxError("parentPiSessionId must be a non-empty string or null.", "invalid_option");
    }
    return this.mutate((state) => {
      if (state.jobs.length >= this.maxJobs) {
        throw new TmuxError(
          `Cannot create a subagent job: the registry already holds the ${this.maxJobs}-job hard bound and no acknowledged history can be evicted. Acknowledge deliveries or remove jobs before creating more.`,
          "invalid_option",
        );
      }
      let jobId = randomUUID();
      while (state.jobs.some((job) => job.jobId === jobId)) jobId = randomUUID();
      const job: SubagentJobV1 = {
        version: SUBAGENT_JOB_VERSION,
        jobId,
        agent: "pi",
        status: "created",
        parentPiSessionId,
        tmuxSessionId: null,
        tmuxPaneId: null,
        cwd,
        createdAt: this.now().toISOString(),
      };
      state.jobs.push(job);
      return { ...job };
    });
  }

  /**
   * Binds a `created` job to stable tmux IDs exactly once. Idempotent for an
   * identical repeat, rejected for a different target, and rejected when a
   * different non-terminal job already owns the pane (a guard against tmux ID
   * reuse pointing two live jobs at one target).
   */
  async bind(jobId: string, input: BindSubagentJobInput): Promise<SubagentJobV1> {
    assertJobId(jobId);
    const tmuxSessionId = requireStableId(input?.tmuxSessionId, SESSION_ID, "tmuxSessionId");
    const tmuxPaneId = requireStableId(input?.tmuxPaneId, PANE_ID, "tmuxPaneId");
    const serverIdentity = input.serverIdentity;
    if (serverIdentity !== undefined && (typeof serverIdentity !== "string" || serverIdentity.length === 0)) {
      throw new TmuxError("serverIdentity must be a non-empty string when provided.", "invalid_option");
    }
    return this.mutate((state) => {
      const job = findJob(state, jobId);
      if (job.status !== "created") {
        throw new TmuxError(`Job ${jobId} cannot bind a tmux target from status ${job.status}; binding is only allowed while "created".`, "invalid_option");
      }
      if (job.tmuxPaneId !== null) {
        if (job.tmuxPaneId === tmuxPaneId && job.tmuxSessionId === tmuxSessionId) return { ...job };
        throw new TmuxError(`Job ${jobId} is already bound to ${job.tmuxSessionId}/${job.tmuxPaneId}.`, "invalid_option");
      }
      const clash = state.jobs.find((other) => other.jobId !== jobId && !isTerminalStatus(other.status) && other.tmuxPaneId === tmuxPaneId);
      if (clash) {
        throw new TmuxError(`Pane ${tmuxPaneId} is already bound to active job ${clash.jobId}; refusing to reuse a live tmux ID.`, "invalid_option");
      }
      job.tmuxSessionId = tmuxSessionId;
      job.tmuxPaneId = tmuxPaneId;
      if (serverIdentity !== undefined) job.serverIdentity = serverIdentity;
      return { ...job };
    });
  }

  /**
   * Applies a legal lifecycle transition. Same-status calls are idempotent
   * no-ops; terminal outcomes are immutable; `starting`/`running` require a
   * bound target; the first terminal transition assigns `completionSeq`.
   */
  async transition(jobId: string, status: SubagentJobStatus, options: TransitionSubagentJobOptions = {}): Promise<SubagentJobV1> {
    assertJobId(jobId);
    if (!SUBAGENT_JOB_STATUSES.includes(status)) {
      throw new TmuxError(`Unknown subagent job status ${JSON.stringify(status)}.`, "invalid_option");
    }
    const at = options.at === undefined ? this.now().toISOString() : requireTimestamp(options.at, "at");
    if (options.exitCode !== undefined && !Number.isSafeInteger(options.exitCode)) {
      throw new TmuxError("exitCode must be a safe integer.", "invalid_option");
    }
    if (options.resultPath !== undefined) requireNonEmptyString(options.resultPath, "resultPath");
    if (options.error !== undefined && typeof options.error !== "string") throw new TmuxError("error must be a string.", "invalid_option");

    return this.mutate((state) => {
      const job = findJob(state, jobId);
      if (job.status === status) return { ...job };
      if (isTerminalStatus(job.status)) {
        throw new TmuxError(`Job ${jobId} is already terminal (${job.status}); a terminal outcome is immutable.`, "invalid_option");
      }
      if (!LEGAL_TRANSITIONS[job.status].includes(status)) {
        throw new TmuxError(`Illegal transition ${job.status} -> ${status} for job ${jobId}.`, "invalid_option");
      }
      if ((status === "starting" || status === "running") && (job.tmuxSessionId === null || job.tmuxPaneId === null)) {
        throw new TmuxError(`Job ${jobId} must be bound to stable tmux session and pane IDs before it can be ${status}.`, "invalid_option");
      }
      if (status === "starting" && job.startedAt === undefined) job.startedAt = at;
      if (isTerminalStatus(status)) {
        job.finishedAt = at;
        if (job.completionSeq === undefined) job.completionSeq = state.nextCompletionSeq++;
        if (options.exitCode !== undefined) job.exitCode = options.exitCode;
        if (options.resultPath !== undefined) job.resultPath = options.resultPath;
        if (options.error !== undefined) job.error = options.error;
      }
      job.status = status;
      return { ...job };
    });
  }

  async get(jobId: string): Promise<SubagentJobV1 | undefined> {
    assertJobId(jobId);
    await this.writes;
    const state = await this.readState();
    const job = state.jobs.find((item) => item.jobId === jobId);
    return job ? { ...job } : undefined;
  }

  async list(
    filter: { status?: SubagentJobStatus | readonly SubagentJobStatus[]; parentPiSessionId?: string } = {},
  ): Promise<SubagentJobV1[]> {
    await this.writes;
    const state = await this.readState();
    const statuses = filter.status === undefined ? undefined : (Array.isArray(filter.status) ? filter.status : [filter.status]);
    return state.jobs
      .filter((job) => statuses === undefined || statuses.includes(job.status))
      .filter((job) => filter.parentPiSessionId === undefined || job.parentPiSessionId === filter.parentPiSessionId)
      .map((job) => ({ ...job }));
  }

  /** Terminal jobs whose completion has not been acknowledged, oldest completion first. */
  async pendingDeliveries(): Promise<SubagentJobV1[]> {
    await this.writes;
    const state = await this.readState();
    return state.jobs
      .filter((job) => isTerminalStatus(job.status) && job.notifiedAt === undefined)
      .sort((a, b) => (a.completionSeq ?? 0) - (b.completionSeq ?? 0) || a.jobId.localeCompare(b.jobId))
      .map((job) => ({ ...job }));
  }

  /** Records that the parent has observed a terminal outcome. Idempotent. */
  async markNotified(jobId: string, options: { at?: string } = {}): Promise<SubagentJobV1> {
    assertJobId(jobId);
    const at = options.at === undefined ? this.now().toISOString() : requireTimestamp(options.at, "at");
    return this.mutate((state) => {
      const job = findJob(state, jobId);
      if (!isTerminalStatus(job.status)) {
        throw new TmuxError(`Job ${jobId} is ${job.status}; delivery bookkeeping is only valid for terminal jobs.`, "invalid_option");
      }
      if (job.notifiedAt === undefined) job.notifiedAt = at;
      return { ...job };
    });
  }

  /**
   * Marks non-terminal, already-bound jobs whose stable tmux target is missing
   * from `view.live` as `lost` (a terminal outcome). A job bound to a different
   * `serverIdentity` than the live view is also lost, because a live ID on a
   * restarted server is a different target. Callers should only reconcile
   * against a view taken while the server is reachable.
   *
   * `options.parentPiSessionId` scopes reconciliation to one parent's jobs, so a
   * parent-side observer can never rewrite another conversation's jobs. When
   * nothing changes, the registry file is not rewritten: a no-op reconcile must
   * not emit a filesystem event, which is what lets a watcher-driven parent stay
   * quiescent while its job is live.
   */
  async reconcile(view: SubagentJobLiveView, options: { parentPiSessionId?: string } = {}): Promise<SubagentJobV1[]> {
    if (view === null || typeof view !== "object" || !(view.live instanceof Set)) {
      throw new TmuxError("reconcile requires a live view with a Set of tmux IDs.", "invalid_option");
    }
    const owner = options.parentPiSessionId;
    if (owner !== undefined && (typeof owner !== "string" || !owner)) {
      throw new TmuxError("reconcile parentPiSessionId must be a non-empty string when provided.", "invalid_option");
    }
    const at = this.now().toISOString();
    return this.mutateIfChanged((state) => {
      const changed: SubagentJobV1[] = [];
      for (const job of state.jobs) {
        if (isTerminalStatus(job.status)) continue;
        if (owner !== undefined && job.parentPiSessionId !== owner) continue; // Never another parent's job.
        const targetId = job.tmuxPaneId ?? job.tmuxSessionId;
        if (targetId === null) continue; // Never bound; it cannot have been lost on the server.
        const identityLost = view.serverIdentity !== undefined
          && job.serverIdentity !== undefined
          && job.serverIdentity !== view.serverIdentity;
        if (!identityLost && view.live.has(targetId)) continue;
        job.status = "lost";
        job.finishedAt ??= at;
        if (job.completionSeq === undefined) job.completionSeq = state.nextCompletionSeq++;
        changed.push({ ...job });
      }
      return { value: changed, changed: changed.length > 0 };
    });
  }

  private async readState(): Promise<SubagentJobState> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: SUBAGENT_JOB_VERSION, nextCompletionSeq: 1, jobs: [] };
      throw new TmuxError(`Could not read the subagent job registry at ${this.file}: ${errorMessage(error)}`, "command_failed");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TmuxError(`The subagent job registry at ${this.file} is not valid JSON; refusing to overwrite it. Remove or repair the file to continue.`, "command_failed");
    }
    if (parsed === null || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== SUBAGENT_JOB_VERSION) {
      throw new TmuxError(`Unsupported subagent job registry version at ${this.file}; refusing to overwrite it.`, "command_failed");
    }
    const jobs = (parsed as { jobs?: unknown }).jobs;
    if (!Array.isArray(jobs) || !jobs.every(isJob)) {
      throw new TmuxError(`The subagent job registry at ${this.file} has an unexpected shape; refusing to overwrite it.`, "command_failed");
    }
    const ids = new Set<string>();
    for (const job of jobs) {
      if (ids.has(job.jobId)) throw new TmuxError(`The subagent job registry at ${this.file} contains duplicate job ID ${job.jobId}; refusing to overwrite it.`, "command_failed");
      ids.add(job.jobId);
    }
    const storedSeq = (parsed as { nextCompletionSeq?: unknown }).nextCompletionSeq;
    if (!Number.isSafeInteger(storedSeq) || (storedSeq as number) < 1) {
      throw new TmuxError(`The subagent job registry at ${this.file} has an invalid completion sequence; refusing to overwrite it.`, "command_failed");
    }
    const highest = jobs.reduce((max, job) => Math.max(max, job.completionSeq ?? 0), 0);
    return { version: SUBAGENT_JOB_VERSION, nextCompletionSeq: Math.max(storedSeq as number, highest + 1), jobs: jobs.map((job) => ({ ...job })) };
  }

  private async writeState(state: SubagentJobState): Promise<void> {
    const directory = path.dirname(this.file);
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(temporary, "w", 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new TmuxError(`Could not write the subagent job registry at ${this.file}: ${errorMessage(error)}`, "command_failed");
    }
    await handle.close();
    try {
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new TmuxError(`Could not replace the subagent job registry at ${this.file}: ${errorMessage(error)}`, "command_failed");
    }
    // Directory fsync makes the rename itself durable; unsupported on some filesystems.
    try {
      const directoryHandle = await open(directory, "r");
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } catch { /* Best effort. */ }
  }

  private async mutate<T>(change: (state: SubagentJobState) => T): Promise<T> {
    return this.mutateIfChanged((state) => ({ value: change(state), changed: true }));
  }

  /**
   * Like `mutate`, but the change reports whether it actually altered state.
   * When it did not (and nothing was pruned), the registry file is left
   * untouched: a no-op reconcile must not rename the file, because a parent
   * watching that file would otherwise wake itself in a loop.
   */
  private async mutateIfChanged<T>(change: (state: SubagentJobState) => { value: T; changed: boolean }): Promise<T> {
    const run = async (): Promise<T> => {
      await this.acquireLock();
      try {
        const state = await this.readState();
        const pruned = pruneAcknowledged(state, this.maxAcknowledged);
        const { value, changed } = change(state);
        if (changed || pruned > 0) {
          pruneAcknowledged(state, this.maxAcknowledged);
          await this.writeState(state);
        }
        return value;
      } finally {
        await this.releaseLock();
      }
    };
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    return next;
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
      `Timed out after ${this.lockTimeoutMs}ms waiting for the subagent job registry lock at ${lockPath}. If no other Pi process is writing, remove the lock file and retry.`,
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
      throw new TmuxError(`Could not lock the subagent job registry at ${this.file}: ${errorMessage(error)}`, "command_failed");
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
      throw new TmuxError(`Could not lock the subagent job registry at ${this.file}: ${errorMessage(error)}`, "command_failed");
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

/** Drops the oldest acknowledged terminal jobs so history is bounded. */
function pruneAcknowledged(state: SubagentJobState, maxAcknowledged: number): number {
  const acknowledged = state.jobs
    .filter((job) => isTerminalStatus(job.status) && job.notifiedAt !== undefined)
    .sort((a, b) => acknowledgedAt(a) - acknowledgedAt(b) || a.jobId.localeCompare(b.jobId));
  const overflow = acknowledged.length - maxAcknowledged;
  if (overflow <= 0) return 0;
  const dropped = new Set(acknowledged.slice(0, overflow).map((job) => job.jobId));
  state.jobs = state.jobs.filter((job) => !dropped.has(job.jobId));
  return overflow;
}

function acknowledgedAt(job: SubagentJobV1): number {
  const timestamp = Date.parse(job.notifiedAt ?? job.finishedAt ?? job.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function findJob(state: SubagentJobState, jobId: string): SubagentJobV1 {
  const job = state.jobs.find((item) => item.jobId === jobId);
  if (!job) throw new TmuxError(`Unknown subagent job ${JSON.stringify(jobId)}.`, "invalid_target");
  return job;
}

function isJob(value: unknown): value is SubagentJobV1 {
  if (value === null || typeof value !== "object") return false;
  const job = value as Record<string, unknown>;
  if (job.version !== SUBAGENT_JOB_VERSION) return false;
  if (typeof job.jobId !== "string" || !job.jobId) return false;
  if (job.agent !== "pi") return false;
  if (typeof job.status !== "string" || !SUBAGENT_JOB_STATUSES.includes(job.status as SubagentJobStatus)) return false;
  if (!(typeof job.parentPiSessionId === "string" || job.parentPiSessionId === null)) return false;
  if (!(typeof job.tmuxSessionId === "string" || job.tmuxSessionId === null)) return false;
  if (!(typeof job.tmuxPaneId === "string" || job.tmuxPaneId === null)) return false;
  if (job.serverIdentity !== undefined && typeof job.serverIdentity !== "string") return false;
  if (typeof job.cwd !== "string" || !job.cwd) return false;
  if (typeof job.createdAt !== "string" || !Number.isFinite(Date.parse(job.createdAt))) return false;
  for (const field of ["startedAt", "finishedAt", "resultPath", "error", "notifiedAt"] as const) {
    if (job[field] !== undefined && typeof job[field] !== "string") return false;
  }
  for (const field of ["startedAt", "finishedAt", "notifiedAt"] as const) {
    const timestamp = job[field];
    if (timestamp !== undefined && !Number.isFinite(Date.parse(timestamp as string))) return false;
  }
  if (job.exitCode !== undefined && !Number.isSafeInteger(job.exitCode)) return false;
  if (job.completionSeq !== undefined && (!Number.isSafeInteger(job.completionSeq) || (job.completionSeq as number) < 1)) return false;
  return true;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TmuxError(`${name} must be a positive integer.`, "invalid_option");
  return value;
}

function assertJobId(jobId: string): void {
  if (typeof jobId !== "string" || !jobId) throw new TmuxError("A non-empty job ID is required.", "invalid_option");
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new TmuxError(`${name} must be a non-empty string.`, "invalid_option");
  return value;
}

function requireStableId(value: unknown, pattern: RegExp, name: string): string {
  const id = requireNonEmptyString(value, name);
  if (!pattern.test(id)) throw new TmuxError(`${name} must be a stable tmux ID matching ${pattern}.`, "invalid_option");
  return id;
}

function requireTimestamp(value: string, name: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TmuxError(`${name} must be an ISO-8601 timestamp.`, "invalid_option");
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
