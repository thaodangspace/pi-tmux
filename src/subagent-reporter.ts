import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  type SubagentJobStatus,
  type SubagentJobV1,
  type TransitionSubagentJobOptions,
  SubagentJobRegistry,
  isTerminalStatus,
} from "./subagent-jobs.ts";
import { TmuxError, errorMessage } from "./tmux.ts";

/**
 * Child-side completion reporter for delegated Pi subagent jobs (issue #2).
 *
 * This is the reporting half of the `SubagentJobV1` registry. It is *not* a
 * parent extension and never starts a child, notifies the parent, or runs
 * workflow logic. It is loaded only inside the child Pi process with explicit
 * job metadata in the environment, and:
 *
 * - on `session_start`, validates the metadata and the existing job, then moves
 *   `starting -> running`;
 * - on `agent_settled`, derives the outcome from structured lifecycle data
 *   (never pane text or scrollback), writes a small bounded completion payload,
 *   and moves `running -> completed|failed`.
 *
 * Failure philosophy: the durable registry is the single source of truth. Every
 * failure mode either leaves the job exactly as a parent left it or leaves it in
 * a state a parent can recover from via `reconcile`/`pendingDeliveries`; no code
 * path infers success from terminal output, and no code path rewrites a terminal
 * outcome.
 */

/** Explicit environment contract between the launching parent and this reporter. */
export const CHILD_REPORTER_ENV = {
  /** Required. The `SubagentJobV1.jobId` this child must report on. */
  jobId: "PI_TMUX_SUBAGENT_JOB_ID",
  /** Required. Absolute path to the `SubagentJobV1` registry file. */
  state: "PI_TMUX_SUBAGENT_STATE",
  /** Optional. Parent Pi session id; must match the job when both are known. */
  parentSessionId: "PI_TMUX_PARENT_SESSION_ID",
  /**
   * Optional. Comma-separated job IDs already active in the ancestry of this
   * child. The reporter refuses to run when its own job ID appears here, which
   * is how a nested delegation back into the same job is rejected.
   */
  ancestors: "PI_TMUX_SUBAGENT_ANCESTORS",
} as const;

export const COMPLETION_VERSION = 1 as const;
export const DEFAULT_MAX_SUMMARY_BYTES = 4_096;
export const DEFAULT_MAX_ERROR_BYTES = 2_048;
/** Directory created next to the registry file that holds completion payloads. */
export const COMPLETION_DIR_NAME = "subagent-reports";
const MAX_ID_BYTES = 512;

/** The structured lifecycle outcome Pi reports for a turn / before settling. */
export type ChildReporterOutcome = "completed" | "aborted" | "error";

/**
 * Small, bounded, machine-readable completion payload. Deliberately excludes raw
 * scrollback and complete transcripts.
 */
export interface PiSubagentCompletionV1 {
  version: 1;
  jobId: string;
  status: "completed" | "failed";
  childSessionId?: string;
  finishedAt: string;
  summary?: string;
  resultPath?: string;
  error?: string;
}

/** Validated, normalized reporter metadata parsed from the environment. */
export interface ChildReporterMetadata {
  jobId: string;
  statePath: string;
  parentSessionId?: string;
  ancestors: string[];
}

/** The subset of `SubagentJobRegistry` the reporter needs (injectable for tests). */
export interface ChildReporterRegistry {
  get(jobId: string): Promise<SubagentJobV1 | undefined>;
  transition(jobId: string, status: SubagentJobStatus, options?: TransitionSubagentJobOptions): Promise<SubagentJobV1>;
}

/** Where a reporter reports failures. The default writes to stderr only. */
export type ChildReporterReport = (level: "info" | "warning" | "error", message: string) => void;

export interface ChildReporterOptions {
  /** Environment to read metadata from (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Registry to report into. Required for `attach`/`settle`. */
  registry?: ChildReporterRegistry;
  /** Injectable clock for deterministic payloads. */
  now?: () => Date;
  /** Failure sink; defaults to stderr so JSON/print stdout is never polluted. */
  report?: ChildReporterReport;
  /** Bound on the optional `summary` field. */
  maxSummaryBytes?: number;
  /** Bound on the `error` field. */
  maxErrorBytes?: number;
  /** Override the derived directory for completion payloads (tests). */
  completionDir?: string;
  /** When `TMUX_PANE` is present, require it to equal the job's bound pane. */
  enforcePaneBinding?: boolean;
  /** Builds the registry from the validated state path when `registry` is absent. */
  registryFactory?: (statePath: string) => ChildReporterRegistry;
}

export interface ChildReporterAttachInput {
  /** This child Pi session's id (from `ctx.sessionManager.getSessionId()`). */
  childSessionId: string;
  /** This process's tmux pane (`TMUX_PANE`); falls back to the environment. */
  tmuxPaneId?: string;
}

export interface ChildReporterAttachResult {
  status: SubagentJobStatus;
  /** True when the job was already terminal and will never be rewritten. */
  passive: boolean;
}

export interface ChildReporterSettleResult {
  status: "completed" | "failed" | "ignored";
  reason: string;
  resultPath?: string;
}

/** A single observed assistant message, reduced to bounded structured fields. */
interface ObservedAssistant {
  stopReason?: string;
  errorMessage?: string;
  text?: string;
}

/**
 * Validates the environment contract. Throws a `TmuxError` describing exactly
 * what is absent or invalid before any registry access happens, so invalid
 * metadata can never mutate an unrelated job.
 */
export function parseChildReporterMetadata(env: NodeJS.ProcessEnv = process.env): ChildReporterMetadata {
  const jobIdRaw = env[CHILD_REPORTER_ENV.jobId];
  if (typeof jobIdRaw !== "string" || jobIdRaw.trim().length === 0) {
    throw new TmuxError(
      `Missing ${CHILD_REPORTER_ENV.jobId}. Load the pi-tmux child reporter only for a delegated Pi subagent job, and set ${CHILD_REPORTER_ENV.jobId} to the parent-created job ID.`,
      "invalid_option",
    );
  }
  const jobId = requireBoundedId(jobIdRaw.trim(), CHILD_REPORTER_ENV.jobId);

  const stateRaw = env[CHILD_REPORTER_ENV.state];
  if (typeof stateRaw !== "string" || stateRaw.trim().length === 0) {
    throw new TmuxError(
      `Missing ${CHILD_REPORTER_ENV.state}. Set it to the absolute path of the parent's subagent job registry file.`,
      "invalid_option",
    );
  }
  const statePath = stateRaw.trim();
  if (!path.isAbsolute(statePath)) {
    throw new TmuxError(`${CHILD_REPORTER_ENV.state} must be an absolute path; received ${JSON.stringify(statePath)}.`, "invalid_option");
  }
  if (statePath.includes("\0")) throw new TmuxError(`${CHILD_REPORTER_ENV.state} must not contain a NUL byte.`, "invalid_option");

  let parentSessionId: string | undefined;
  const parentRaw = env[CHILD_REPORTER_ENV.parentSessionId];
  if (parentRaw !== undefined) {
    if (typeof parentRaw !== "string" || parentRaw.trim().length === 0) {
      throw new TmuxError(`${CHILD_REPORTER_ENV.parentSessionId} was set but is empty; omit it or set the parent Pi session id.`, "invalid_option");
    }
    parentSessionId = requireBoundedId(parentRaw.trim(), CHILD_REPORTER_ENV.parentSessionId);
  }

  return { jobId, statePath, parentSessionId, ancestors: parseAncestors(env[CHILD_REPORTER_ENV.ancestors]) };
}

function parseAncestors(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  if (typeof raw !== "string") throw new TmuxError(`${CHILD_REPORTER_ENV.ancestors} must be a comma-separated string.`, "invalid_option");
  const seen = new Set<string>();
  const ancestors: string[] = [];
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const id = requireBoundedId(token, CHILD_REPORTER_ENV.ancestors);
    if (!seen.has(id)) {
      seen.add(id);
      ancestors.push(id);
    }
  }
  return ancestors;
}

function requireBoundedId(value: string, name: string): string {
  if (value.includes("\0")) throw new TmuxError(`${name} must not contain a NUL byte.`, "invalid_option");
  if (Buffer.byteLength(value, "utf8") > MAX_ID_BYTES) throw new TmuxError(`${name} is longer than ${MAX_ID_BYTES} bytes.`, "invalid_option");
  return value;
}

/** Derived completion-payload directory for a registry file. */
export function completionDirFor(statePath: string): string {
  return path.join(path.dirname(statePath), COMPLETION_DIR_NAME);
}

export class ChildReporter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly reportFn: ChildReporterReport;
  private readonly now: () => Date;
  private readonly maxSummaryBytes: number;
  private readonly maxErrorBytes: number;
  private readonly completionDir: string | undefined;
  private readonly enforcePaneBinding: boolean;
  private readonly registryFactory: (statePath: string) => ChildReporterRegistry;

  private registry: ChildReporterRegistry | undefined;
  private metadata: ChildReporterMetadata | undefined;
  private childSessionId: string | undefined;
  private attached = false;
  private passive = false;
  private settled = false;
  private outcome: ChildReporterOutcome | undefined;
  private lastAssistant: ObservedAssistant | undefined;
  private attachResult: ChildReporterAttachResult | undefined;
  private settleResult: ChildReporterSettleResult | undefined;

  constructor(options: ChildReporterOptions = {}) {
    this.env = options.env ?? process.env;
    this.registry = options.registry;
    this.now = options.now ?? (() => new Date());
    this.reportFn = options.report ?? defaultReport;
    this.maxSummaryBytes = positiveInteger(options.maxSummaryBytes ?? DEFAULT_MAX_SUMMARY_BYTES, "maxSummaryBytes");
    this.maxErrorBytes = positiveInteger(options.maxErrorBytes ?? DEFAULT_MAX_ERROR_BYTES, "maxErrorBytes");
    this.completionDir = options.completionDir;
    this.enforcePaneBinding = options.enforcePaneBinding ?? true;
    this.registryFactory = options.registryFactory ?? ((statePath) => new SubagentJobRegistry(statePath));
  }

  /** Exposes validated metadata after `attach` (undefined before validation). */
  get jobId(): string | undefined {
    return this.metadata?.jobId;
  }

  /**
   * Validates metadata and the bound job, then moves `starting -> running`.
   *
   * Idempotent: a repeated call (for example after an extension reload) is a
   * no-op. A terminal job makes the reporter passive rather than an error, so a
   * cancellation race is harmless. Any other rejection happens before any write
   * and therefore never touches another job.
   */
  async attach(input: ChildReporterAttachInput): Promise<ChildReporterAttachResult> {
    if (this.attached) return this.attachResult!;
    if (!input || typeof input.childSessionId !== "string" || input.childSessionId.length === 0) {
      throw new TmuxError("attach requires a non-empty childSessionId.", "invalid_option");
    }
    const metadata = parseChildReporterMetadata(this.env);
    this.metadata = metadata;

    // Recursive-loop guards: never report into a job that is already an ancestor
    // of this same child, and never treat this child session as its own parent.
    if (metadata.ancestors.includes(metadata.jobId)) {
      throw new TmuxError(
        `Subagent job ${metadata.jobId} already appears in this child's ancestor lineage (${metadata.ancestors.join(", ")}); refusing to form a recursive subagent loop.`,
        "invalid_option",
      );
    }

    const registry = this.registry ?? this.registryFactory(metadata.statePath);
    this.registry = registry;

    const job = await registry.get(metadata.jobId);
    if (!job) {
      throw new TmuxError(
        `Subagent job ${metadata.jobId} does not exist in ${metadata.statePath}; the parent must create and bind it before launching the child.`,
        "invalid_target",
      );
    }

    this.assertJobMatches(job, metadata, input);

    // A job cancelled before the child got here is a normal race: stop quietly.
    if (isTerminalStatus(job.status)) {
      this.attached = true;
      this.passive = true;
      this.attachResult = { status: job.status, passive: true };
      this.report("info", `Subagent job ${job.jobId} is already terminal (${job.status}); the child reporter will not rewrite it.`);
      return this.attachResult;
    }
    if (job.status !== "starting" && job.status !== "running") {
      throw new TmuxError(
        `Subagent job ${job.jobId} is ${job.status}; the parent must bind it and transition it to "starting" before launching the child.`,
        "invalid_option",
      );
    }

    let running: SubagentJobV1;
    try {
      running = await registry.transition(job.jobId, "running");
    } catch (error) {
      // The parent may have cancelled the job between our read and our write.
      const latest = await registry.get(job.jobId).catch(() => undefined);
      if (latest && isTerminalStatus(latest.status)) {
        this.attached = true;
        this.passive = true;
        this.attachResult = { status: latest.status, passive: true };
        this.report("info", `Subagent job ${job.jobId} became terminal (${latest.status}) during startup; the child reporter will not rewrite it.`);
        return this.attachResult;
      }
      this.fail(`Could not move subagent job ${job.jobId} to running: ${errorMessage(error)}`);
    }

    this.childSessionId = input.childSessionId;
    this.attached = true;
    this.passive = false;
    this.attachResult = { status: running.status, passive: false };
    // Publish the lineage so any grandchild that reuses this job ID is rejected.
    this.env[CHILD_REPORTER_ENV.ancestors] = [...metadata.ancestors, metadata.jobId].join(",");
    this.report("info", `Subagent job ${job.jobId} is running (child session ${input.childSessionId}).`);
    return this.attachResult;
  }

  private assertJobMatches(job: SubagentJobV1, metadata: ChildReporterMetadata, input: ChildReporterAttachInput): void {
    if (job.jobId !== metadata.jobId) {
      throw new TmuxError(`Subagent job identity mismatch: registry returned ${job.jobId} for ${metadata.jobId}.`, "invalid_target");
    }
    if (job.tmuxSessionId === null || job.tmuxPaneId === null) {
      throw new TmuxError(`Subagent job ${job.jobId} has no bound tmux target; the parent must bind stable session and pane IDs before launch.`, "invalid_option");
    }
    if (job.parentPiSessionId !== null && job.parentPiSessionId === input.childSessionId) {
      throw new TmuxError(
        `Subagent job ${job.jobId} names this child session (${input.childSessionId}) as its parent; refusing a self-referential delegation loop.`,
        "invalid_option",
      );
    }
    if (metadata.parentSessionId !== undefined) {
      if (job.parentPiSessionId !== metadata.parentSessionId) {
        throw new TmuxError(
          `Parent session mismatch for subagent job ${job.jobId}: job records ${JSON.stringify(job.parentPiSessionId)} but ${CHILD_REPORTER_ENV.parentSessionId} is ${JSON.stringify(metadata.parentSessionId)}.`,
          "invalid_target",
        );
      }
    } else if (job.parentPiSessionId !== null) {
      throw new TmuxError(
        `Subagent job ${job.jobId} records a parent session but ${CHILD_REPORTER_ENV.parentSessionId} was not provided; the launch metadata is incomplete.`,
        "invalid_option",
      );
    }
    const ambientPane = input.tmuxPaneId ?? this.env.TMUX_PANE;
    if (this.enforcePaneBinding && ambientPane !== undefined && ambientPane !== job.tmuxPaneId) {
      throw new TmuxError(
        `This child is running in tmux pane ${ambientPane} but subagent job ${job.jobId} is bound to ${job.tmuxPaneId}; refusing to report for a different pane.`,
        "invalid_target",
      );
    }
  }

  /** Records the structured outcome Pi reports for a turn or the settle boundary. */
  observeOutcome(outcome: ChildReporterOutcome): void {
    if (this.settled) return;
    if (outcome === "completed" || outcome === "aborted" || outcome === "error") this.outcome = outcome;
  }

  /**
   * Reduces the final assistant messages to bounded structured fields. Only the
   * last assistant message is inspected, and its text is truncated; raw
   * scrollback and full transcripts are never persisted.
   */
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

  /** Records an explicit free-form error for the next settle (bounded). */
  observeError(error: string): void {
    if (this.settled || typeof error !== "string" || !error.trim()) return;
    this.lastAssistant = { ...(this.lastAssistant ?? {}), errorMessage: truncate(error.trim(), this.maxErrorBytes) };
    if (this.outcome === undefined) this.outcome = "error";
  }

  /**
   * Derives the terminal outcome from structured lifecycle data and transitions
   * the job. Idempotent for repeats, harmless for terminal races, and fail-closed
   * on persistence errors (the job is left for parent recovery, never faked).
   */
  async settle(): Promise<ChildReporterSettleResult> {
    if (this.settled) return this.settleResult!;
    const metadata = this.metadata;
    const registry = this.registry;
    if (!this.attached || !metadata || !registry) {
      throw new TmuxError("Cannot settle before the child reporter attaches to its job.", "invalid_option");
    }
    if (this.passive) {
      const latest = await registry.get(metadata.jobId).catch(() => undefined);
      this.settled = true;
      this.settleResult = { status: "ignored", reason: "job-already-terminal", ...(latest?.resultPath ? { resultPath: latest.resultPath } : {}) };
      return this.settleResult;
    }

    const current = await registry.get(metadata.jobId);
    if (!current) {
      this.fail(`Subagent job ${metadata.jobId} disappeared before completion; leaving no terminal write.`);
    }
    if (isTerminalStatus(current.status)) {
      this.passive = true;
      this.settled = true;
      this.settleResult = { status: "ignored", reason: "job-already-terminal", ...(current.resultPath ? { resultPath: current.resultPath } : {}) };
      this.report("info", `Subagent job ${metadata.jobId} became terminal (${current.status}); the child reporter did not overwrite it.`);
      return this.settleResult;
    }

    const { status, outcome, error } = this.deriveOutcome();
    const finishedAt = this.now().toISOString();
    const payload: PiSubagentCompletionV1 = {
      version: COMPLETION_VERSION,
      jobId: metadata.jobId,
      status,
      ...(this.childSessionId ? { childSessionId: this.childSessionId } : {}),
      finishedAt,
      ...(status === "completed" && this.lastAssistant?.text ? { summary: this.lastAssistant.text } : {}),
      ...(error ? { error } : {}),
    };

    let resultPath: string | undefined;
    try {
      resultPath = await this.writeCompletion(payload);
    } catch (writeError) {
      // The bounded payload could not be persisted. Leave the durable running
      // state untouched (recoverable via reconcile/lost) rather than claiming a
      // terminal outcome the parent cannot fully read.
      this.fail(`Could not persist the subagent completion payload for job ${metadata.jobId}: ${errorMessage(writeError)}`);
    }

    let updated: SubagentJobV1;
    try {
      updated = await registry.transition(metadata.jobId, status, {
        at: finishedAt,
        ...(resultPath ? { resultPath } : {}),
        ...(error ? { error } : {}),
      });
    } catch (transitionError) {
      const latest = await registry.get(metadata.jobId).catch(() => undefined);
      if (latest && isTerminalStatus(latest.status)) {
        // A cancellation/terminal write landed first. Preserve it and drop our
        // now-unreferenced payload.
        await this.discardPayload(resultPath, latest.resultPath);
        this.passive = true;
        this.settled = true;
        this.settleResult = { status: "ignored", reason: "job-already-terminal", ...(latest.resultPath ? { resultPath: latest.resultPath } : {}) };
        this.report("info", `Subagent job ${metadata.jobId} was already terminal (${latest.status}); completion was not written.`);
        return this.settleResult;
      }
      await this.discardPayload(resultPath, undefined);
      this.fail(`Could not persist the terminal ${status} state for subagent job ${metadata.jobId}: ${errorMessage(transitionError)}`);
    }

    // `transition` returns the durable post-transition job. When this attempt
    // won, `resultPath` is ours; when an identical terminal transition already
    // existed, it is the earlier winner's file, so we never report (or keep) a
    // payload the registry does not point at.
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

  /** Best-effort removal of an attempt's payload that the registry does not reference. */
  private async discardPayload(payloadPath: string | undefined, keep: string | undefined): Promise<void> {
    if (!payloadPath || payloadPath === keep) return;
    await rm(payloadPath, { force: true }).catch(() => undefined);
  }

  private deriveOutcome(): { status: "completed" | "failed"; outcome: ChildReporterOutcome; error?: string } {
    if (this.outcome === "error") {
      return { status: "failed", outcome: "error", error: this.lastAssistant?.errorMessage ?? "Pi reported an error" };
    }
    if (this.outcome === "aborted") {
      return { status: "failed", outcome: "aborted", error: this.lastAssistant?.errorMessage ?? "Pi run was aborted before it settled" };
    }
    if (this.outcome === "completed") {
      return { status: "completed", outcome: "completed" };
    }
    // No structured lifecycle signal arrived. Never infer success from output.
    return { status: "failed", outcome: "error", error: "Pi settled without an observed agent outcome" };
  }

  private async writeCompletion(payload: PiSubagentCompletionV1): Promise<string> {
    const directory = this.completionDir ?? completionDirFor(this.metadata!.statePath);
    // A unique, immutable filename per attempt. Concurrent reporters (or a
    // duplicate reporter, or a retry after a failed transition) must never
    // overwrite another attempt's payload: the registry's `resultPath` names
    // exactly the winning file, and losing attempts are discarded best-effort.
    const file = path.join(directory, `${payload.jobId}.${randomUUID()}.json`);
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
      throw new TmuxError(`Could not write the subagent completion payload at ${file}: ${errorMessage(error)}`, "command_failed");
    }
    await handle.close();
    try {
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new TmuxError(`Could not replace the subagent completion payload at ${file}: ${errorMessage(error)}`, "command_failed");
    }
    return file;
  }

  private report(level: "info" | "warning" | "error", message: string): void {
    this.reportFn(level, message);
  }

  /** Reports and throws so Pi records an extension error; never swallows quietly. */
  private fail(message: string): never {
    this.report("error", message);
    throw new TmuxError(message, "command_failed");
  }
}

function defaultReport(level: "info" | "warning" | "error", message: string): void {
  // stderr only: stdout carries protocol output in `--mode json`/`print`.
  console.error(`[pi-tmux child reporter] ${level}: ${message}`);
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
