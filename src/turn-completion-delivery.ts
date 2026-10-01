import {
  DEFAULT_COMPLETION_DEBOUNCE_MS,
  DEFAULT_COMPLETION_POLL_MS,
  SUBAGENT_COMPLETION_CUSTOM_TYPE,
  SUBAGENT_COMPLETION_VERSION,
  defaultCompletionWatchFactory,
  type CompletionDeliverySink,
  type CompletionWatchFactory,
  type CompletionWatchHandle,
  type SubagentCompletionDetails,
  type SubagentCompletionEvent,
} from "./completion-delivery.ts";
import {
  type SubagentSessionV1,
  type SubagentTurnV1,
  SubagentSessionRegistry,
  isActiveTurnStatus,
  isTerminalTurnStatus,
} from "./subagent-sessions.ts";
import type { LiveTargets } from "./targets.ts";
import { TmuxError, errorMessage } from "./tmux.ts";

/**
 * Parent-side completion delivery for the session/turn registry (issue #11).
 *
 * This is the session/turn analogue of `CompletionDelivery` (issue #4): it lets
 * a parent learn that a runner turn reached a terminal outcome without ever
 * scraping a pane. The durable `SubagentSessionV1`/`SubagentTurnV1` registry is
 * authoritative; a terminal turn is persisted by the runner (or by
 * reconciliation as `lost`) before anything is delivered, and the delivery is
 * acknowledged only after the attempt. A crash between the two is safe: the
 * turn stays pending and is redelivered with a stable `(sessionId, turnId,
 * completionSeq)` identity that consumers can deduplicate.
 *
 * Only turns owned by one Pi conversation are observed, and observation is held
 * only while that conversation owns an active or undelivered turn.
 */

/** The registry operations the delivery loop needs (injectable for tests). */
export type TurnCompletionRegistry = Pick<
  SubagentSessionRegistry,
  "file" | "getSession" | "listTurns" | "pendingDeliveries" | "markNotified" | "reconcile"
>;

export interface TurnCompletionDeliveryOptions {
  /** Only turns owned by this Pi conversation are ever delivered. */
  ownerPiSessionId: string;
  sessions: TurnCompletionRegistry;
  deliver: CompletionDeliverySink;
  /** Live tmux view used to reconcile non-terminal sessions; omit to skip. */
  liveTargets?: () => Promise<LiveTargets>;
  debounceMs?: number;
  pollIntervalMs?: number;
  watch?: CompletionWatchFactory;
  log?: (level: "info" | "warning" | "error", message: string) => void;
}

const NOOP_LOG = (_level: "info" | "warning" | "error", _message: string): void => undefined;

/** Builds the bounded parent event for a terminal turn. Never accepts a live turn. */
export function buildTurnCompletionEvent(session: SubagentSessionV1, turn: SubagentTurnV1): SubagentCompletionEvent {
  if (!isTerminalTurnStatus(turn.status)) {
    throw new TmuxError(`Turn ${turn.turnId} is ${turn.status}; a completion event requires a terminal turn.`, "invalid_option");
  }
  const details: SubagentCompletionDetails = {
    version: SUBAGENT_COMPLETION_VERSION,
    // One event family: the durable run id is the turn id for session/turn records.
    jobId: turn.turnId,
    status: turn.status,
    completionSeq: turn.completionSeq ?? 0,
    finishedAt: turn.finishedAt ?? turn.createdAt,
    ...(turn.resultPath ? { resultPath: turn.resultPath } : {}),
    ...(turn.error ? { error: turn.error } : {}),
    agent: session.agent,
    sessionId: session.sessionId,
    turnId: turn.turnId,
  };
  return {
    customType: SUBAGENT_COMPLETION_CUSTOM_TYPE,
    content: `${session.agent} subagent turn ${turn.turnId} ${turn.status}`,
    display: true,
    details,
  };
}

export class TurnCompletionDelivery {
  private readonly owner: string;
  private readonly sessions: TurnCompletionRegistry;
  private readonly deliver: CompletionDeliverySink;
  private readonly liveTargets: (() => Promise<LiveTargets>) | undefined;
  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;
  private readonly watchFactory: CompletionWatchFactory;
  private readonly log: NonNullable<TurnCompletionDeliveryOptions["log"]>;

  private watchHandle: CompletionWatchHandle | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private pending = false;
  private closed = false;

  constructor(options: TurnCompletionDeliveryOptions) {
    if (typeof options?.ownerPiSessionId !== "string" || !options.ownerPiSessionId) {
      throw new TmuxError("TurnCompletionDelivery requires a non-empty ownerPiSessionId.", "invalid_option");
    }
    this.owner = options.ownerPiSessionId;
    this.sessions = options.sessions;
    this.deliver = options.deliver;
    this.liveTargets = options.liveTargets;
    this.debounceMs = nonNegativeInteger(options.debounceMs ?? DEFAULT_COMPLETION_DEBOUNCE_MS, "debounceMs");
    this.pollIntervalMs = nonNegativeInteger(options.pollIntervalMs ?? DEFAULT_COMPLETION_POLL_MS, "pollIntervalMs");
    this.watchFactory = options.watch ?? defaultCompletionWatchFactory;
    this.log = options.log ?? NOOP_LOG;
  }

  get observing(): boolean {
    return this.watchHandle !== undefined || this.pollTimer !== undefined;
  }

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

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    this.watchHandle?.close();
    this.watchHandle = undefined;
    try { await this.running; } catch { /* Already reported. */ }
  }

  private async pass(): Promise<void> {
    const registryFile = this.sessions.file;
    let needsObservation = false;
    try {
      const turns = await this.sessions.listTurns({ parentPiSessionId: this.owner });
      // A logical session is long-lived and stays non-terminal after a turn, so
      // observation is driven by turns: an active turn must be watched for a
      // vanished target or a late terminal write.
      const active = turns.some((turn) => isActiveTurnStatus(turn.status));
      if (active && this.liveTargets) {
        try {
          const view = await this.liveTargets();
          // Owner-scoped: another conversation's sessions are never rewritten.
          await this.sessions.reconcile(view, { parentPiSessionId: this.owner });
        } catch (error) {
          this.log("warning", `Could not reconcile subagent sessions against tmux: ${errorMessage(error)}`);
        }
      }

      const pending = await this.sessions.pendingDeliveries({ parentPiSessionId: this.owner });
      for (const turn of pending) {
        if (this.closed) return;
        await this.deliverTurn(turn);
      }

      const after = await this.sessions.listTurns({ parentPiSessionId: this.owner });
      const stillActive = after.some((turn) => isActiveTurnStatus(turn.status));
      const stillPending = (await this.sessions.pendingDeliveries({ parentPiSessionId: this.owner })).length > 0;
      needsObservation = stillActive || stillPending;
    } catch (error) {
      this.log("error", `Subagent turn completion reconciliation failed: ${errorMessage(error)}`);
      needsObservation = true;
    }
    if (!this.closed) this.updateObservation(needsObservation, registryFile);
  }

  private async deliverTurn(turn: SubagentTurnV1): Promise<void> {
    const session = await this.sessions.getSession(turn.sessionId);
    if (!session) {
      this.log("warning", `Terminal turn ${turn.turnId} has no readable owning session; skipping delivery.`);
      return;
    }
    const event = buildTurnCompletionEvent(session, turn);
    try {
      await this.deliver(event);
    } catch (error) {
      this.log("error", `Could not deliver the subagent turn completion for ${turn.turnId}; it will be retried: ${errorMessage(error)}`);
      return;
    }
    try {
      await this.sessions.markNotified(turn.turnId, { parentPiSessionId: this.owner });
    } catch (error) {
      this.log("warning", `Delivered the subagent turn completion for ${turn.turnId} but could not record its acknowledgement: ${errorMessage(error)}`);
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
    this.log("error", `Subagent turn completion pass failed: ${errorMessage(error)}`);
  }
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TmuxError(`${name} must be a non-negative integer.`, "invalid_option");
  return value;
}
