import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  CHILD_REPORTER_ENV,
  COMPLETION_VERSION,
  DEFAULT_MAX_ERROR_BYTES,
  DEFAULT_MAX_SUMMARY_BYTES,
  completionDirFor,
  parseChildReporterMetadata,
  type ChildReporterAttachInput,
  type ChildReporterOutcome,
  type ChildReporterReport,
  type ChildReporterSettleResult,
  type ChildReporterMetadata,
} from "./subagent-reporter.ts";
import {
  type SubagentSessionV1,
  type SubagentTurnStatus,
  type SubagentTurnV1,
  SubagentSessionRegistry,
  isTerminalTurnStatus,
} from "./subagent-sessions.ts";
import type { SubagentTurnCompletionV1 } from "./turn-runner.ts";
import { TmuxError, errorMessage } from "./tmux.ts";

export interface TurnReporterAttachResult {
  status: SubagentTurnStatus;
  passive: boolean;
}

/**
 * Child-side completion reporter for the generalized session/turn registry
 * (issue #12).
 *
 * This is the session/turn counterpart of `ChildReporter`: it is loaded only
 * inside a delegated child (for example Pi) whose launch set
 * `PI_TMUX_CHILD_REPORTER_MODE=session`, and it reports durable lifecycle state
 * for one logical turn instead of one one-shot job:
 *
 * - on `session_start`, it validates the metadata and the bound turn, then moves
 *   the turn `starting -> running`;
 * - on `agent_settled`, it derives the outcome from Pi's structured lifecycle
 *   events (never pane text), writes a bounded immutable completion payload, and
 *   moves the turn to `completed|failed`, which returns the session to `idle`.
 *
 * Every write goes through the same `SubagentSessionRegistry` durability contract
 * the parent and the generic runner use, so a crash or a racing cancellation can
 * never leave a fabricated terminal outcome.
 */

/** The subset of `SubagentSessionRegistry` this reporter needs (injectable for tests). */
export interface TurnReporterRegistry {
  getSession(sessionId: string): Promise<SubagentSessionV1 | undefined>;
  getTurn(turnId: string): Promise<SubagentTurnV1 | undefined>;
  transitionTurn(turnId: string, status: "running" | "completed" | "failed", options?: { at?: string; exitCode?: number; resultPath?: string; error?: string }): Promise<SubagentTurnV1>;
  setAgentSessionId?(sessionId: string, agentSessionId: string): Promise<SubagentSessionV1>;
}

export interface TurnReporterMetadata {
  sessionId: string;
  turnId: string;
  statePath: string;
  parentSessionId?: string;
  ancestors: string[];
}

export interface TurnReporterOptions {
  env?: NodeJS.ProcessEnv;
  registry?: TurnReporterRegistry;
  now?: () => Date;
  report?: ChildReporterReport;
  maxSummaryBytes?: number;
  maxErrorBytes?: number;
  completionDir?: string;
  enforcePaneBinding?: boolean;
  registryFactory?: (statePath: string) => TurnReporterRegistry;
}

interface ObservedAssistant {
  stopReason?: string;
  errorMessage?: string;
  text?: string;
}

/**
 * Validates the session-mode environment contract. Reuses the shared
 * `parseChildReporterMetadata` validation (jobId/state/parent/ancestors) and adds
 * the session/turn identity, so an invalid contract is rejected before any
 * registry access.
 */
export function parseTurnReporterMetadata(env: NodeJS.ProcessEnv = process.env): TurnReporterMetadata {
  if (env[CHILD_REPORTER_ENV.mode] !== "session") {
    throw new TmuxError(`Missing ${CHILD_REPORTER_ENV.mode}=session; the turn reporter only runs for a session/turn launch.`, "invalid_option");
  }
  const base: ChildReporterMetadata = parseChildReporterMetadata(env);
  const sessionRaw = env[CHILD_REPORTER_ENV.session];
  if (typeof sessionRaw !== "string" || !sessionRaw.trim()) {
    throw new TmuxError(`Missing ${CHILD_REPORTER_ENV.session} for a session/turn launch.`, "invalid_option");
  }
  return {
    sessionId: sessionRaw.trim(),
    turnId: base.jobId,
    statePath: base.statePath,
    ...(base.parentSessionId !== undefined ? { parentSessionId: base.parentSessionId } : {}),
    ancestors: base.ancestors,
  };
}

export class TurnReporter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly reportFn: ChildReporterReport;
  private readonly now: () => Date;
  private readonly maxSummaryBytes: number;
  private readonly maxErrorBytes: number;
  private readonly completionDir: string | undefined;
  private readonly enforcePaneBinding: boolean;
  private readonly registryFactory: (statePath: string) => TurnReporterRegistry;

  private registry: TurnReporterRegistry | undefined;
  private metadata: TurnReporterMetadata | undefined;
  private childSessionId: string | undefined;
  private attached = false;
  private passive = false;
  private settled = false;
  private outcome: ChildReporterOutcome | undefined;
  private lastAssistant: ObservedAssistant | undefined;
  private attachResult: TurnReporterAttachResult | undefined;
  private settleResult: ChildReporterSettleResult | undefined;

  constructor(options: TurnReporterOptions = {}) {
    this.env = options.env ?? process.env;
    this.registry = options.registry;
    this.now = options.now ?? (() => new Date());
    this.reportFn = options.report ?? defaultReport;
    this.maxSummaryBytes = positiveInteger(options.maxSummaryBytes ?? DEFAULT_MAX_SUMMARY_BYTES, "maxSummaryBytes");
    this.maxErrorBytes = positiveInteger(options.maxErrorBytes ?? DEFAULT_MAX_ERROR_BYTES, "maxErrorBytes");
    this.completionDir = options.completionDir;
    this.enforcePaneBinding = options.enforcePaneBinding ?? true;
    this.registryFactory = options.registryFactory ?? ((statePath) => new SubagentSessionRegistry(statePath));
  }

  get turnId(): string | undefined {
    return this.metadata?.turnId;
  }

  /** Validates metadata and the bound turn, then moves the turn `starting -> running`. */
  async attach(input: ChildReporterAttachInput): Promise<TurnReporterAttachResult> {
    if (this.attached) return this.attachResult!;
    if (!input || typeof input.childSessionId !== "string" || input.childSessionId.length === 0) {
      throw new TmuxError("attach requires a non-empty childSessionId.", "invalid_option");
    }
    const metadata = parseTurnReporterMetadata(this.env);
    this.metadata = metadata;

    if (metadata.ancestors.includes(metadata.turnId)) {
      throw new TmuxError(
        `Subagent turn ${metadata.turnId} already appears in this child's ancestor lineage (${metadata.ancestors.join(", ")}); refusing to form a recursive subagent loop.`,
        "invalid_option",
      );
    }

    const registry = this.registry ?? this.registryFactory(metadata.statePath);
    this.registry = registry;

    const session = await registry.getSession(metadata.sessionId);
    if (!session) {
      throw new TmuxError(`Subagent session ${metadata.sessionId} does not exist in ${metadata.statePath}; the parent must create and bind it before launching the child.`, "invalid_target");
    }
    const turn = await registry.getTurn(metadata.turnId);
    if (!turn) {
      throw new TmuxError(`Subagent turn ${metadata.turnId} does not exist in ${metadata.statePath}; the parent must create and bind it before launching the child.`, "invalid_target");
    }
    this.assertMatches(session, turn, metadata, input);

    if (isTerminalTurnStatus(turn.status)) {
      this.attached = true;
      this.passive = true;
      this.attachResult = { status: turn.status, passive: true };
      this.report("info", `Subagent turn ${turn.turnId} is already terminal (${turn.status}); the reporter will not rewrite it.`);
      return this.attachResult;
    }
    if (turn.status !== "starting" && turn.status !== "running") {
      throw new TmuxError(
        `Subagent turn ${turn.turnId} is ${turn.status}; the parent must bind it and transition it to "starting" before launching the child.`,
        "invalid_option",
      );
    }

    let running: SubagentTurnV1;
    try {
      running = await registry.transitionTurn(turn.turnId, "running");
    } catch (error) {
      const latest = await registry.getTurn(turn.turnId).catch(() => undefined);
      if (latest && isTerminalTurnStatus(latest.status)) {
        this.attached = true;
        this.passive = true;
        this.attachResult = { status: latest.status, passive: true };
        this.report("info", `Subagent turn ${turn.turnId} became terminal (${latest.status}) during startup; the reporter will not rewrite it.`);
        return this.attachResult;
      }
      this.fail(`Could not move subagent turn ${turn.turnId} to running: ${errorMessage(error)}`);
    }

    this.childSessionId = input.childSessionId;
    this.attached = true;
    this.passive = false;
    this.attachResult = { status: running.status, passive: false };
    this.env[CHILD_REPORTER_ENV.ancestors] = [...metadata.ancestors, metadata.turnId].join(",");
    this.report("info", `Subagent turn ${turn.turnId} is running (child session ${input.childSessionId}).`);
    return this.attachResult;
  }

  private assertMatches(session: SubagentSessionV1, turn: SubagentTurnV1, metadata: TurnReporterMetadata, input: ChildReporterAttachInput): void {
    if (turn.turnId !== metadata.turnId) {
      throw new TmuxError(`Subagent turn identity mismatch: registry returned ${turn.turnId} for ${metadata.turnId}.`, "invalid_target");
    }
    if (turn.sessionId !== session.sessionId) {
      throw new TmuxError(`Subagent turn ${turn.turnId} belongs to session ${turn.sessionId}, not ${metadata.sessionId}; refusing to report.`, "invalid_target");
    }
    if (session.tmuxSessionId === null || turn.tmuxPaneId === null) {
      throw new TmuxError(`Subagent turn ${turn.turnId} has no bound tmux target; the parent must bind stable session and pane IDs before launch.`, "invalid_option");
    }
    if (session.parentPiSessionId !== null && session.parentPiSessionId === input.childSessionId) {
      throw new TmuxError(
        `Subagent session ${session.sessionId} names this child session (${input.childSessionId}) as its parent; refusing a self-referential delegation loop.`,
        "invalid_option",
      );
    }
    if (metadata.parentSessionId !== undefined) {
      if (session.parentPiSessionId !== metadata.parentSessionId) {
        throw new TmuxError(
          `Parent session mismatch for subagent session ${session.sessionId}: session records ${JSON.stringify(session.parentPiSessionId)} but ${CHILD_REPORTER_ENV.parentSessionId} is ${JSON.stringify(metadata.parentSessionId)}.`,
          "invalid_target",
        );
      }
    } else if (session.parentPiSessionId !== null) {
      throw new TmuxError(
        `Subagent session ${session.sessionId} records a parent session but ${CHILD_REPORTER_ENV.parentSessionId} was not provided; the launch metadata is incomplete.`,
        "invalid_option",
      );
    }
    const ambientPane = input.tmuxPaneId ?? this.env.TMUX_PANE;
    if (this.enforcePaneBinding && ambientPane !== undefined && ambientPane !== turn.tmuxPaneId) {
      throw new TmuxError(
        `This child is running in tmux pane ${ambientPane} but subagent turn ${turn.turnId} is bound to ${turn.tmuxPaneId}; refusing to report for a different pane.`,
        "invalid_target",
      );
    }
  }

  observeOutcome(outcome: ChildReporterOutcome): void {
    if (this.settled) return;
    if (outcome === "completed" || outcome === "aborted" || outcome === "error") this.outcome = outcome;
  }

  observeAgentEnd(messages: unknown): void {
    if (this.settled || !Array.isArray(messages)) return;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index] as Record<string, unknown> | undefined;
      if (!message || message.role !== "assistant") continue;
      const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
      const error = typeof message.errorMessage === "string" && message.errorMessage.trim() ? truncate(message.errorMessage.trim(), this.maxErrorBytes) : undefined;
      const text = truncate(assistantText(message.content), this.maxSummaryBytes);
      this.lastAssistant = { stopReason, errorMessage: error, text: text || undefined };
      if (this.outcome === undefined) {
        this.outcome = stopReason === "aborted" ? "aborted" : stopReason === "error" ? "error" : "completed";
      }
      return;
    }
  }

  observeError(error: string): void {
    if (this.settled || typeof error !== "string" || !error.trim()) return;
    this.lastAssistant = { ...(this.lastAssistant ?? {}), errorMessage: truncate(error.trim(), this.maxErrorBytes) };
    if (this.outcome === undefined) this.outcome = "error";
  }

  /** Derives the terminal turn outcome and transitions it, returning the session to idle. */
  async settle(): Promise<ChildReporterSettleResult> {
    if (this.settled) return this.settleResult!;
    const metadata = this.metadata;
    const registry = this.registry;
    if (!this.attached || !metadata || !registry) {
      throw new TmuxError("Cannot settle before the turn reporter attaches to its turn.", "invalid_option");
    }
    if (this.passive) {
      const latest = await registry.getTurn(metadata.turnId).catch(() => undefined);
      this.settled = true;
      this.settleResult = { status: "ignored", reason: "turn-already-terminal", ...(latest?.resultPath ? { resultPath: latest.resultPath } : {}) };
      return this.settleResult;
    }

    const current = await registry.getTurn(metadata.turnId);
    if (!current) {
      this.fail(`Subagent turn ${metadata.turnId} disappeared before completion; leaving no terminal write.`);
    }
    if (isTerminalTurnStatus(current.status)) {
      this.passive = true;
      this.settled = true;
      this.settleResult = { status: "ignored", reason: "turn-already-terminal", ...(current.resultPath ? { resultPath: current.resultPath } : {}) };
      this.report("info", `Subagent turn ${metadata.turnId} became terminal (${current.status}); the reporter did not overwrite it.`);
      return this.settleResult;
    }

    const { status, error } = this.deriveOutcome();
    const finishedAt = this.now().toISOString();
    const payload: SubagentTurnCompletionV1 = {
      version: COMPLETION_VERSION,
      sessionId: metadata.sessionId,
      turnId: metadata.turnId,
      agent: "pi",
      status,
      finishedAt,
      ...(this.childSessionId ? { agentSessionId: this.childSessionId } : {}),
      ...(status === "completed" && this.lastAssistant?.text ? { summary: this.lastAssistant.text } : {}),
      ...(error ? { error } : {}),
    };

    let resultPath: string | undefined;
    try {
      resultPath = await this.writeCompletion(payload);
    } catch (writeError) {
      this.fail(`Could not persist the subagent turn completion payload for ${metadata.turnId}: ${errorMessage(writeError)}`);
    }

    if (this.childSessionId && registry.setAgentSessionId) {
      try {
        await registry.setAgentSessionId(metadata.sessionId, this.childSessionId);
      } catch { /* Advisory; the durable turn outcome still wins. */ }
    }

    let updated: SubagentTurnV1;
    try {
      updated = await registry.transitionTurn(metadata.turnId, status, {
        at: finishedAt,
        ...(resultPath ? { resultPath } : {}),
        ...(error ? { error } : {}),
      });
    } catch (transitionError) {
      const latest = await registry.getTurn(metadata.turnId).catch(() => undefined);
      if (latest && isTerminalTurnStatus(latest.status)) {
        await this.discardPayload(resultPath, latest.resultPath);
        this.passive = true;
        this.settled = true;
        this.settleResult = { status: "ignored", reason: "turn-already-terminal", ...(latest.resultPath ? { resultPath: latest.resultPath } : {}) };
        this.report("info", `Subagent turn ${metadata.turnId} was already terminal (${latest.status}); completion was not written.`);
        return this.settleResult;
      }
      await this.discardPayload(resultPath, undefined);
      this.fail(`Could not persist the terminal ${status} state for subagent turn ${metadata.turnId}: ${errorMessage(transitionError)}`);
    }

    const winningPath = updated.resultPath;
    await this.discardPayload(resultPath, winningPath);
    this.settled = true;
    this.settleResult = {
      status: updated.status === "failed" ? "failed" : "completed",
      reason: "settled",
      ...(winningPath ? { resultPath: winningPath } : {}),
    };
    return this.settleResult;
  }

  private async discardPayload(payloadPath: string | undefined, keep: string | undefined): Promise<void> {
    if (!payloadPath || payloadPath === keep) return;
    await rm(payloadPath, { force: true }).catch(() => undefined);
  }

  private deriveOutcome(): { status: "completed" | "failed"; error?: string } {
    if (this.outcome === "error") {
      return { status: "failed", error: this.lastAssistant?.errorMessage ?? "Pi reported an error" };
    }
    if (this.outcome === "aborted") {
      return { status: "failed", error: this.lastAssistant?.errorMessage ?? "Pi run was aborted before it settled" };
    }
    if (this.outcome === "completed") {
      return { status: "completed" };
    }
    return { status: "failed", error: "Pi settled without an observed agent outcome" };
  }

  private async writeCompletion(payload: SubagentTurnCompletionV1): Promise<string> {
    const directory = this.completionDir ?? completionDirFor(this.metadata!.statePath);
    const file = path.join(directory, `${this.metadata!.turnId}.${randomUUID()}.json`);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(temporary, "w", 0o600);
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new TmuxError(`Could not write the subagent turn completion payload at ${file}: ${errorMessage(error)}`, "command_failed");
    }
    await handle.close();
    try {
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new TmuxError(`Could not replace the subagent turn completion payload at ${file}: ${errorMessage(error)}`, "command_failed");
    }
    return file;
  }

  private report(level: "info" | "warning" | "error", message: string): void {
    this.reportFn(level, message);
  }

  private fail(message: string): never {
    this.report("error", message);
    throw new TmuxError(message, "command_failed");
  }
}

function defaultReport(level: "info" | "warning" | "error", message: string): void {
  console.error(`[pi-tmux turn reporter] ${level}: ${message}`);
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string") {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join("\n");
}

function truncate(text: string, maxBytes: number): string {
  if (!text) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end--;
  return text.slice(0, end);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TmuxError(`${name} must be a positive integer.`, "invalid_option");
  return value;
}
