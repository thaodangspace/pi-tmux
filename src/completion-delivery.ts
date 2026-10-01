import { watch as fsWatch, type FSWatcher } from "node:fs";
import path from "node:path";
import {
  type SubagentJobV1,
  type TerminalSubagentJobStatus,
  SubagentJobRegistry,
  isTerminalStatus,
} from "./subagent-jobs.ts";
import type { LiveTargets } from "./targets.ts";
import { TmuxError, errorMessage } from "./tmux.ts";

/**
 * Parent-side completion delivery for delegated Pi subagent jobs (issue #4).
 *
 * The parent must learn about a terminal child without synchronously waiting on
 * tmux. The durable `SubagentJobV1` registry is the single source of truth:
 *
 * - a terminal job is persisted by the child reporter (or by parent
 *   reconciliation as `lost`) before anything is delivered;
 * - this module detects terminal jobs that the owning parent has not
 *   acknowledged and, only after the delivery attempt, records the
 *   acknowledgement in the registry (`markNotified`);
 * - a crash between the attempt and the acknowledgement is therefore safe:
 *   the job stays pending and is redelivered, and the event carries a stable
 *   `jobId` plus registry-global `completionSeq` that consumers can deduplicate.
 *
 * Observation is bounded: a directory watcher and an optional low-frequency
 * poll run only while this parent owns an active (non-terminal) job or has an
 * undelivered terminal one, and are released as soon as neither is true. A
 * watcher notification is only a hint to re-read durable state; it is never
 * treated as completion state itself.
 */

/** Custom message type the parent receives when one of its subagents settles. */
export const SUBAGENT_COMPLETION_CUSTOM_TYPE = "pi-tmux:subagent-completed";
/** Schema version of the machine-readable `details` payload. */
export const SUBAGENT_COMPLETION_VERSION = 1 as const;
/** Default debounce applied to filesystem/poll signals. */
export const DEFAULT_COMPLETION_DEBOUNCE_MS = 150;
/** Default fallback poll while observation is active; 0 disables it. */
export const DEFAULT_COMPLETION_POLL_MS = 2_000;

/**
 * Bounded, machine-readable completion event. It carries no child transcript,
 * prompt, or pane capture: only the durable job identity/status and the small
 * fields already stored on the job.
 */
export interface SubagentCompletionDetails {
  version: 1;
  jobId: string;
  status: TerminalSubagentJobStatus;
  /** Registry-global, monotonic sequence assigned at the first terminal write. Stable across redelivery. */
  completionSeq: number;
  finishedAt: string;
  resultPath?: string;
  error?: string;
  /**
   * Agent/session/turn identity, agent-neutral and additive (issue #10). One-run
   * job records report the same id for all three; a future session/turn adapter
   * fills them distinctly so consumers keep one event family.
   */
  agent?: string;
  sessionId?: string;
  turnId?: string;
}

export interface SubagentCompletionEvent {
  customType: string;
  content: string;
  display: boolean;
  details: SubagentCompletionDetails;
}

/** Delivers one completion event to the parent. A rejection means "not delivered". */
export type CompletionDeliverySink = (event: SubagentCompletionEvent) => Promise<void> | void;

/** Watches the registry location for external writes. Returning undefined means the watcher is unavailable. */
export interface CompletionWatchHandle {
  close(): void;
}
export type CompletionWatchFactory = (file: string, onChange: () => void) => CompletionWatchHandle | undefined;

/** The registry operations the delivery loop needs (injectable for tests). */
export type CompletionDeliveryRegistry = Pick<SubagentJobRegistry, "file" | "list" | "pendingDeliveries" | "markNotified" | "reconcile">;

export interface CompletionDeliveryOptions {
  /** Only jobs owned by this Pi conversation are ever delivered. */
  ownerPiSessionId: string;
  jobs: CompletionDeliveryRegistry;
  deliver: CompletionDeliverySink;
  /** Live tmux view used to reconcile non-terminal jobs; omit to skip reconciliation. */
  liveTargets?: () => Promise<LiveTargets>;
  /** Debounce in milliseconds applied to watcher/poll signals (default 150). */
  debounceMs?: number;
  /** Fallback poll interval while observation is active; 0 disables (default 2000). */
  pollIntervalMs?: number;
  /** Watcher factory; defaults to a directory watcher over the registry file. */
  watch?: CompletionWatchFactory;
  /** Failure sink; defaults to a no-op so a UI-less runtime is never polluted. */
  log?: (level: "info" | "warning" | "error", message: string) => void;
}

const NOOP_LOG = (_level: "info" | "warning" | "error", _message: string): void => undefined;

/**
 * A filesystem watcher over the registry directory. Watching the directory (not
 * the file inode) survives the atomic rename used for every write. Only events
 * naming the registry file count; `.lock` and temp writes are ignored.
 */
export function defaultCompletionWatchFactory(file: string, onChange: () => void): CompletionWatchHandle | undefined {
  const directory = path.dirname(file);
  const target = path.basename(file);
  let watcher: FSWatcher;
  try {
    watcher = fsWatch(directory, { persistent: false }, (_eventType, filename) => {
      if (filename === null || filename === undefined || filename.toString() === target) onChange();
    });
  } catch {
    return undefined; // The directory may not exist yet; reconciliation will retry later.
  }
  watcher.on("error", () => {
    /* A watcher error is not completion state; reconciliation remains authoritative. */
  });
  return {
    close() {
      try { watcher.close(); } catch { /* Already closed. */ }
    },
  };
}

/** Builds the bounded event for a terminal job. Never accepts a non-terminal job. */
export function buildSubagentCompletionEvent(job: SubagentJobV1): SubagentCompletionEvent {
  if (!isTerminalStatus(job.status)) {
    throw new TmuxError(`Job ${job.jobId} is ${job.status}; a completion event requires a terminal job.`, "invalid_option");
  }
  const details: SubagentCompletionDetails = {
    version: SUBAGENT_COMPLETION_VERSION,
    jobId: job.jobId,
    status: job.status,
    // Terminal transitions always assign a sequence; the fallback keeps an
    // unexpected older file deliverable without a hard failure.
    completionSeq: job.completionSeq ?? 0,
    finishedAt: job.finishedAt ?? job.createdAt,
    ...(job.resultPath ? { resultPath: job.resultPath } : {}),
    ...(job.error ? { error: job.error } : {}),
    // One durable run == one job today, so session/turn identity coincide.
    agent: "pi",
    sessionId: job.jobId,
    turnId: job.jobId,
  };
  return {
    customType: SUBAGENT_COMPLETION_CUSTOM_TYPE,
    content: `Pi subagent ${job.jobId} ${job.status}`,
    display: true,
    details,
  };
}

/** Sender shape of Pi's `sendMessage`; kept structural so tests need no Pi runtime. */
export interface CompletionMessageSender {
  (
    message: { customType: string; content: string; display: boolean; details: SubagentCompletionDetails },
    options: { triggerTurn: true; deliverAs: "followUp" },
  ): void;
}

/**
 * Adapts Pi's `sendMessage` into a delivery sink.
 *
 * `triggerTurn: true` with `deliverAs: "followUp"` is the one shape that is safe
 * in both parent states: idle, Pi appends the message and starts a new turn;
 * streaming, Pi queues it as a follow-up instead of interrupting the active
 * turn. `deliverAs` is ignored when idle, so it is always set to close the
 * check-then-send race.
 */
export function createCompletionSink(sendMessage: CompletionMessageSender): CompletionDeliverySink {
  return async (event) => {
    sendMessage(
      { customType: event.customType, content: event.content, display: event.display, details: event.details },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };
}

export class CompletionDelivery {
  private readonly owner: string;
  private readonly jobs: CompletionDeliveryRegistry;
  private readonly deliver: CompletionDeliverySink;
  private readonly liveTargets: (() => Promise<LiveTargets>) | undefined;
  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;
  private readonly watchFactory: CompletionWatchFactory;
  private readonly log: NonNullable<CompletionDeliveryOptions["log"]>;

  private watchHandle: CompletionWatchHandle | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private pending = false;
  private closed = false;

  constructor(options: CompletionDeliveryOptions) {
    if (typeof options?.ownerPiSessionId !== "string" || !options.ownerPiSessionId) {
      throw new TmuxError("CompletionDelivery requires a non-empty ownerPiSessionId.", "invalid_option");
    }
    this.owner = options.ownerPiSessionId;
    this.jobs = options.jobs;
    this.deliver = options.deliver;
    this.liveTargets = options.liveTargets;
    this.debounceMs = nonNegativeInteger(options.debounceMs ?? DEFAULT_COMPLETION_DEBOUNCE_MS, "debounceMs");
    this.pollIntervalMs = nonNegativeInteger(options.pollIntervalMs ?? DEFAULT_COMPLETION_POLL_MS, "pollIntervalMs");
    this.watchFactory = options.watch ?? defaultCompletionWatchFactory;
    this.log = options.log ?? NOOP_LOG;
  }

  /** True while a watcher or fallback poll is held open. */
  get observing(): boolean {
    return this.watchHandle !== undefined || this.pollTimer !== undefined;
  }

  /**
   * Schedules one reconciliation/delivery pass, debouncing bursts of watcher
   * signals. Safe to call from event handlers; it never blocks the caller.
   */
  notify(): void {
    if (this.closed) return;
    if (this.debounceMs === 0) {
      void this.refresh().catch((error) => this.reportFailure(error));
      return;
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.refresh().catch((error) => this.reportFailure(error));
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  /**
   * Runs reconciliation and delivery to completion, serialized so overlapping
   * signals cannot double-deliver. Requests that arrive while a pass is running
   * are coalesced into one follow-up pass.
   */
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.pending = true;
    if (this.running) return this.running;
    const next = (async () => {
      try {
        while (this.pending && !this.closed) {
          this.pending = false;
          await this.pass();
        }
      } finally {
        this.running = undefined;
      }
    })();
    this.running = next;
    return next;
  }

  /** Releases the watcher, timers, and any in-flight pass. Idempotent. */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    this.watchHandle?.close();
    this.watchHandle = undefined;
    try { await this.running; } catch { /* A failed pass is already reported; shutdown continues. */ }
  }

  private async pass(): Promise<void> {
    const registryFile = this.jobs.file;
    let needsObservation = false;
    try {
      const owned = await this.jobs.list({ parentPiSessionId: this.owner });
      const active = owned.some((job) => !isTerminalStatus(job.status));
      if (active && this.liveTargets) {
        try {
          const view = await this.liveTargets();
          // Scope to this parent: another conversation's jobs are never reconciled
          // here, and a no-op reconcile does not rewrite the file.
          await this.jobs.reconcile(view, { parentPiSessionId: this.owner });
        } catch (error) {
          this.log("warning", `Could not reconcile Pi subagent jobs against tmux: ${errorMessage(error)}`);
        }
      }

      const pending = (await this.jobs.pendingDeliveries()).filter((job) => job.parentPiSessionId === this.owner);
      for (const job of pending) {
        if (this.closed) return;
        await this.deliverJob(job);
      }

      const after = await this.jobs.list({ parentPiSessionId: this.owner });
      const stillActive = after.some((job) => !isTerminalStatus(job.status));
      const stillPending = (await this.jobs.pendingDeliveries()).some((job) => job.parentPiSessionId === this.owner);
      needsObservation = stillActive || stillPending;
    } catch (error) {
      this.log("error", `Pi subagent completion reconciliation failed: ${errorMessage(error)}`);
      needsObservation = true; // Fail open to observation so a transient error can recover.
    }
    if (!this.closed) this.updateObservation(needsObservation, registryFile);
  }

  /**
   * Attempts the parent event first and only then records the durable
   * acknowledgement. A failed delivery leaves the job pending for a later pass.
   */
  private async deliverJob(job: SubagentJobV1): Promise<void> {
    const event = buildSubagentCompletionEvent(job);
    try {
      await this.deliver(event);
    } catch (error) {
      this.log("error", `Could not deliver the Pi subagent completion for ${job.jobId}; it will be retried: ${errorMessage(error)}`);
      return;
    }
    try {
      await this.jobs.markNotified(job.jobId);
    } catch (error) {
      // The event was delivered. A duplicate on the next pass is acceptable and
      // deduplicated by consumers via the stable (jobId, completionSeq) pair.
      this.log("warning", `Delivered the Pi subagent completion for ${job.jobId} but could not record its acknowledgement: ${errorMessage(error)}`);
    }
  }

  private updateObservation(needed: boolean, registryFile: string): void {
    if (needed && !this.watchHandle && registryFile) {
      this.watchHandle = this.watchFactory(registryFile, () => this.notify());
    }
    if (!needed && this.watchHandle) {
      this.watchHandle.close();
      this.watchHandle = undefined;
    }

    const shouldPoll = needed && this.pollIntervalMs > 0;
    if (shouldPoll && !this.pollTimer) {
      this.pollTimer = setInterval(() => this.notify(), this.pollIntervalMs);
      this.pollTimer.unref?.();
    } else if (!shouldPoll && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private reportFailure(error: unknown): void {
    this.log("error", `Pi subagent completion pass failed: ${errorMessage(error)}`);
  }
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TmuxError(`${name} must be a non-negative integer.`, "invalid_option");
  return value;
}
