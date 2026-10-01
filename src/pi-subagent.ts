import type { Registry } from "./registry.ts";
import { PiAdapter, PI_SUBAGENT_TOOL, defaultChildReporterPath, type PiAdapterOptions } from "./pi-adapter.ts";
import {
  type SubagentCancelResult,
  type SubagentFailureCode,
  type SubagentRunStatus,
  type SubagentStartResult,
  type SubagentStatusResult,
  type SubagentTargets,
  SubagentController,
} from "./subagent-controller.ts";
import { JobSubagentLedger } from "./subagent-ledgers.ts";
import { type SubagentJobStatus, type SubagentJobV1, SubagentJobRegistry } from "./subagent-jobs.ts";
import { Tmux } from "./tmux.ts";

/**
 * Pi subagent façade over the generic controller (issues #3/#10).
 *
 * The public tool contract is unchanged (`tmux_subagent_start_pi` /
 * `tmux_subagent_status` / `tmux_subagent_cancel`, durable `SubagentJobV1`
 * records, the packaged child reporter contract), but every tmux and lifecycle
 * behavior now lives in `SubagentController` and every Pi-specific decision in
 * `PiAdapter`. This module only maps the agent-neutral controller results back to
 * the job-shaped shape the existing tools and tests consume.
 */

export {
  PI_SUBAGENT_ENV,
  PI_SUBAGENT_LAUNCH_COMMAND,
  PI_SUBAGENT_PLACEHOLDER_COMMAND,
  PI_SUBAGENT_TOOL,
  DEFAULT_PI_COMMAND,
  PI_SUBAGENT_TOOL as PI_SUBAGENT_PROVENANCE_TOOL,
  defaultChildReporterPath,
} from "./pi-adapter.ts";
export { detectParentSession, resolveExecutable } from "./subagent-controller.ts";
export type { PiAdapterOptions };

/** The subset of `Targets` the controller needs (structural, so tests can stub it). */
export type PiSubagentTargets = SubagentTargets;

export interface DetectParentSessionEnv {
  TMUX?: string;
  TMUX_PANE?: string;
}

export interface PiSubagentControllerOptions extends PiAdapterOptions {
  tmux: Tmux;
  registry: Registry;
  jobs: SubagentJobRegistry;
  targets: PiSubagentTargets;
  /** Injectable clock. */
  now?: () => Date;
  /** Bounded startup liveness probe; `attempts: 0` disables it. */
  startupProbe?: { attempts: number; intervalMs: number };
  /** Injectable delay. */
  sleep?: (ms: number) => Promise<void>;
  /** Environment to read this process's own subagent lineage from. */
  env?: NodeJS.ProcessEnv;
  /** Refuse to nest deeper than this many ancestors (default 8). */
  maxDepth?: number;
}

export interface StartPiSubagentInput {
  cwd: string;
  task: string;
  name?: string;
  /** Optional tmux session the child is being delegated for (provenance only). */
  parent?: string;
  model?: string;
  thinking?: string;
}

export type PiSubagentFailureCode = SubagentFailureCode;

export interface PiSubagentFailure {
  ok: false;
  code: PiSubagentFailureCode;
  error: string;
  jobId?: string;
  status?: SubagentJobStatus;
  cleanedUp?: boolean;
}

export interface PiSubagentStartSuccess {
  ok: true;
  jobId: string;
  status: SubagentJobStatus;
  tmuxSessionId: string;
  tmuxPaneId: string;
  name: string;
  cwd: string;
  parentPiSessionId: string;
  serverIdentity?: string;
}

export type PiSubagentStartResult = PiSubagentStartSuccess | PiSubagentFailure;

export type PiSubagentStatusResult =
  | { ok: true; job: SubagentJobV1; targetLive?: boolean; reconciled: boolean; tmuxUnavailable?: boolean }
  | PiSubagentFailure;

export type PiSubagentCancelResult =
  | { ok: true; jobId: string; status: SubagentJobStatus; alreadyTerminal: boolean; targetRemoved: boolean; reason: string }
  | PiSubagentFailure;

export class PiSubagentController {
  private readonly jobs: SubagentJobRegistry;
  private readonly controller: SubagentController;

  constructor(options: PiSubagentControllerOptions) {
    this.jobs = options.jobs;
    this.controller = new SubagentController({
      tmux: options.tmux,
      registry: options.registry,
      targets: options.targets,
      adapter: new PiAdapter(options),
      ledger: new JobSubagentLedger(options.jobs),
      ...(options.now ? { now: options.now } : {}),
      ...(options.startupProbe ? { startupProbe: options.startupProbe } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
    });
  }

  async start(input: StartPiSubagentInput, parentPiSessionId: string, signal?: AbortSignal): Promise<PiSubagentStartResult> {
    return this.toStartResult(await this.controller.start(input, parentPiSessionId, signal));
  }

  async status(jobId: string, parentPiSessionId: string, signal?: AbortSignal): Promise<PiSubagentStatusResult> {
    const outcome = await this.controller.status(jobId, parentPiSessionId, signal);
    if (!outcome.ok) return toFailure(outcome);
    const job = await this.jobs.get(outcome.run.runId);
    if (!job) return { ok: false, code: "invalid_target", error: `Unknown subagent job ${JSON.stringify(jobId)}.`, jobId };
    return {
      ok: true,
      job,
      ...(outcome.targetLive !== undefined ? { targetLive: outcome.targetLive } : {}),
      reconciled: outcome.reconciled,
      ...(outcome.tmuxUnavailable ? { tmuxUnavailable: true } : {}),
    };
  }

  async cancel(jobId: string, parentPiSessionId: string, signal?: AbortSignal): Promise<PiSubagentCancelResult> {
    const outcome = await this.controller.cancel(jobId, parentPiSessionId, signal);
    if (!outcome.ok) return toFailure(outcome);
    return {
      ok: true,
      jobId: outcome.runId,
      status: outcome.status as SubagentJobStatus,
      alreadyTerminal: outcome.alreadyTerminal,
      targetRemoved: outcome.targetRemoved,
      reason: outcome.reason,
    };
  }

  private toStartResult(outcome: SubagentStartResult): PiSubagentStartResult {
    if (!outcome.ok) return toFailure(outcome);
    return {
      ok: true,
      jobId: outcome.runId,
      status: outcome.status as SubagentJobStatus,
      tmuxSessionId: outcome.tmuxSessionId,
      tmuxPaneId: outcome.tmuxPaneId,
      name: outcome.name,
      cwd: outcome.cwd,
      parentPiSessionId: outcome.owner,
      ...(outcome.serverIdentity ? { serverIdentity: outcome.serverIdentity } : {}),
    };
  }
}

function toFailure(outcome: Exclude<SubagentStatusResult, { ok: true }> | Exclude<SubagentStartResult, { ok: true }> | Exclude<SubagentCancelResult, { ok: true }>): PiSubagentFailure {
  return {
    ok: false,
    code: outcome.code,
    error: outcome.error,
    ...(outcome.runId ? { jobId: outcome.runId } : {}),
    ...(outcome.status ? { status: outcome.status as SubagentJobStatus } : {}),
    ...(outcome.cleanedUp !== undefined ? { cleanedUp: outcome.cleanedUp } : {}),
  };
}

export { PI_SUBAGENT_TOOL as PI_SUBAGENT_TMUX_TOOL };
export type { SubagentRunStatus };
