import {
  type BindSubagentRunInput,
  type CreateSubagentRunInput,
  type SubagentLedger,
  type SubagentLiveView,
  type SubagentRunRecord,
  type SubagentSessionInfo,
  type TransitionSubagentRunOptions,
  isTerminalRunStatus,
} from "./subagent-controller.ts";
import {
  type SubagentJobStatus,
  type SubagentJobV1,
  SubagentJobRegistry,
} from "./subagent-jobs.ts";
import {
  type SubagentAgent,
  type SubagentSessionV1,
  type SubagentSessionStatus,
  type SubagentTurnStatus,
  type SubagentTurnV1,
  SubagentSessionRegistry,
  isTerminalSessionStatus,
  isTerminalTurnStatus,
} from "./subagent-sessions.ts";
import { TmuxError } from "./tmux.ts";

/**
 * Durable ledgers that adapt the two on-disk registries to the generic
 * controller's agent-neutral `SubagentLedger` interface.
 *
 * - `JobSubagentLedger` wraps the legacy one-run `SubagentJobV1` registry used
 *   by the live Pi path, preserving the existing public contract exactly.
 * - `SessionSubagentLedger` wraps the issue #9 `SubagentSessionV1` /
 *   `SubagentTurnV1` registry, where a session survives completed turns and can
 *   run several turns. This is what lets the generic controller execute turn A,
 *   return the session to `idle`, then execute turn B.
 */

export class JobSubagentLedger implements SubagentLedger {
  readonly kind = "job" as const;
  readonly tmuxStrategy = "respawn-pane" as const;

  constructor(private readonly jobs: SubagentJobRegistry) {}

  get file(): string {
    return this.jobs.file;
  }

  async createRun(input: CreateSubagentRunInput): Promise<SubagentRunRecord> {
    return jobToRun(await this.jobs.create({ cwd: input.cwd, parentPiSessionId: input.owner }));
  }

  async bindRun(runId: string, input: BindSubagentRunInput): Promise<SubagentRunRecord> {
    return jobToRun(await this.jobs.bind(runId, { tmuxSessionId: input.tmuxSessionId, tmuxPaneId: input.tmuxPaneId, serverIdentity: input.serverIdentity }));
  }

  async transitionRun(runId: string, status: SubagentRunRecord["status"], options: TransitionSubagentRunOptions = {}): Promise<SubagentRunRecord> {
    return jobToRun(await this.jobs.transition(runId, status as SubagentJobStatus, options));
  }

  async cancelRun(runId: string, options: { error?: string } = {}): Promise<SubagentRunRecord> {
    return jobToRun(await this.jobs.transition(runId, "cancelled", options.error ? { error: options.error } : {}));
  }

  async getRun(runId: string): Promise<SubagentRunRecord | undefined> {
    const job = await this.jobs.get(runId);
    return job ? jobToRun(job) : undefined;
  }

  async reconcileRuns(view: SubagentLiveView, options: { owner?: string } = {}): Promise<SubagentRunRecord[]> {
    const changed = await this.jobs.reconcile(view, options.owner ? { parentPiSessionId: options.owner } : {});
    return changed.map(jobToRun);
  }
}

export function jobToRun(job: SubagentJobV1): SubagentRunRecord {
  return {
    runId: job.jobId,
    sessionId: job.jobId,
    agent: "pi",
    owner: job.parentPiSessionId,
    cwd: job.cwd,
    status: job.status,
    tmuxSessionId: job.tmuxSessionId,
    tmuxPaneId: job.tmuxPaneId,
    ...(job.serverIdentity ? { serverIdentity: job.serverIdentity } : {}),
    turnIndex: 1,
    createdAt: job.createdAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
    ...(job.resultPath ? { resultPath: job.resultPath } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.completionSeq !== undefined ? { completionSeq: job.completionSeq } : {}),
    ...(job.notifiedAt ? { notifiedAt: job.notifiedAt } : {}),
  };
}

export class SessionSubagentLedger implements SubagentLedger {
  readonly kind = "session" as const;
  readonly tmuxStrategy = "host-window" as const;

  constructor(private readonly sessions: SubagentSessionRegistry, private readonly agent: SubagentAgent) {}

  get file(): string {
    return this.sessions.file;
  }

  async createSession(input: CreateSubagentRunInput): Promise<SubagentSessionInfo> {
    return sessionInfo(await this.sessions.createSession({
      agent: input.agent,
      cwd: input.cwd,
      parentPiSessionId: input.owner,
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
    }));
  }

  async bindSession(sessionId: string, input: { tmuxSessionId: string; tmuxPaneId?: string; serverIdentity?: string }, owner?: string): Promise<void> {
    await this.sessions.bindSession(sessionId, {
      tmuxSessionId: input.tmuxSessionId,
      ...(input.tmuxPaneId !== undefined ? { tmuxPaneId: input.tmuxPaneId } : {}),
      ...(input.serverIdentity !== undefined ? { serverIdentity: input.serverIdentity } : {}),
    }, owner ? { parentPiSessionId: owner } : {});
  }

  async createTurn(sessionId: string, owner?: string): Promise<SubagentRunRecord> {
    const turn = await this.sessions.createTurn(sessionId, owner ? { parentPiSessionId: owner } : {});
    return this.toRun(turn);
  }

  async getSession(sessionId: string): Promise<SubagentSessionInfo | undefined> {
    const session = await this.sessions.getSession(sessionId);
    return session ? sessionInfo(session) : undefined;
  }

  async stopSession(sessionId: string, owner?: string): Promise<void> {
    const session = await this.sessions.getSession(sessionId);
    if (!session || isTerminalSessionStatus(session.status)) return;
    await this.sessions.transitionSession(sessionId, "stopped", owner ? { parentPiSessionId: owner } : {});
  }

  async transitionSession(sessionId: string, status: SubagentSessionStatus, owner?: string): Promise<SubagentSessionInfo> {
    const session = await this.sessions.transitionSession(sessionId, status, owner ? { parentPiSessionId: owner } : {});
    return sessionInfo(session);
  }

  async bindRun(runId: string, input: BindSubagentRunInput, owner?: string): Promise<SubagentRunRecord> {
    const turn = await this.sessions.bindTurn(runId, { tmuxPaneId: input.tmuxPaneId }, owner ? { parentPiSessionId: owner } : {});
    return this.toRun(turn);
  }

  async transitionRun(runId: string, status: SubagentRunRecord["status"], options: TransitionSubagentRunOptions = {}, owner?: string): Promise<SubagentRunRecord> {
    const turn = await this.sessions.transitionTurn(runId, runStatusToTurn(status), {
      ...(owner ? { parentPiSessionId: owner } : {}),
      ...options,
    });
    return this.toRun(turn);
  }

  async cancelRun(runId: string, options: { error?: string } = {}, owner?: string): Promise<SubagentRunRecord> {
    const current = await this.sessions.getTurn(runId);
    if (!current) return this.toRun(requireDefined(await this.sessions.getTurn(runId)));
    if (!isTerminalTurnStatus(current.status)) {
      await this.sessions.transitionTurn(runId, "cancelled", { ...(owner ? { parentPiSessionId: owner } : {}), ...(options.error ? { error: options.error } : {}) });
    }
    return this.toRun(requireDefined(await this.sessions.getTurn(runId)));
  }

  /**
   * Cancels exactly one turn without touching the logical session: the turn goes
   * terminal and the session returns to `idle`, so it can run another turn. This
   * is distinct from `stopSession`, which terminates the reusable session.
   */
  async cancelTurn(runId: string, options: { error?: string } = {}, owner?: string): Promise<SubagentRunRecord> {
    const current = await this.sessions.getTurn(runId);
    if (!current) throw new TmuxError(`Unknown subagent turn ${JSON.stringify(runId)}.`, "invalid_target");
    if (!isTerminalTurnStatus(current.status)) {
      await this.sessions.transitionTurn(runId, "cancelled", { ...(owner ? { parentPiSessionId: owner } : {}), ...(options.error ? { error: options.error } : {}) });
    }
    return this.toRun(requireDefined(await this.sessions.getTurn(runId)));
  }

  async listTurns(sessionId: string): Promise<SubagentRunRecord[]> {
    const turns = await this.sessions.listTurns({ sessionId });
    const runs: SubagentRunRecord[] = [];
    for (const turn of turns) runs.push(await this.toRun(turn));
    return runs;
  }

  async getRun(runId: string): Promise<SubagentRunRecord | undefined> {
    const turn = await this.sessions.getTurn(runId);
    if (!turn) return undefined;
    return this.toRun(turn);
  }

  async reconcileRuns(view: SubagentLiveView, options: { owner?: string } = {}): Promise<SubagentRunRecord[]> {
    const result = await this.sessions.reconcile(view, options.owner ? { parentPiSessionId: options.owner } : {});
    const runs: SubagentRunRecord[] = [];
    for (const turn of result.turns) runs.push(await this.toRun(turn));
    return runs;
  }

  private async toRun(turn: SubagentTurnV1): Promise<SubagentRunRecord> {
    const session = await this.sessions.getSession(turn.sessionId);
    const turns = await this.sessions.listTurns({ sessionId: turn.sessionId });
    const index = turns.findIndex((item) => item.turnId === turn.turnId);
    return {
      runId: turn.turnId,
      sessionId: turn.sessionId,
      agent: session?.agent ?? this.agent,
      owner: session?.parentPiSessionId ?? null,
      cwd: session?.cwd ?? "",
      status: turnStatusToRun(turn.status),
      tmuxSessionId: session?.tmuxSessionId ?? null,
      tmuxPaneId: turn.tmuxPaneId,
      ...(session?.serverIdentity ? { serverIdentity: session.serverIdentity } : {}),
      ...(index >= 0 ? { turnIndex: index + 1 } : {}),
      createdAt: turn.createdAt,
      ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
      ...(turn.finishedAt ? { finishedAt: turn.finishedAt } : {}),
      ...(turn.exitCode !== undefined ? { exitCode: turn.exitCode } : {}),
      ...(turn.resultPath ? { resultPath: turn.resultPath } : {}),
      ...(turn.error ? { error: turn.error } : {}),
      ...(turn.completionSeq !== undefined ? { completionSeq: turn.completionSeq } : {}),
      ...(turn.notifiedAt ? { notifiedAt: turn.notifiedAt } : {}),
    };
  }
}

function sessionInfo(session: SubagentSessionV1): SubagentSessionInfo {
  return {
    sessionId: session.sessionId,
    agent: session.agent,
    owner: session.parentPiSessionId,
    cwd: session.cwd,
    status: session.status,
    mode: session.mode ?? "turns",
    tmuxSessionId: session.tmuxSessionId,
    tmuxPaneId: session.tmuxPaneId ?? null,
    ...(session.serverIdentity ? { serverIdentity: session.serverIdentity } : {}),
    ...(session.agentSessionId ? { agentSessionId: session.agentSessionId } : {}),
  };
}

export function turnStatusToRun(status: SubagentTurnStatus): SubagentRunRecord["status"] {
  return status === "queued" ? "created" : status;
}

export function runStatusToTurn(status: SubagentRunRecord["status"]): SubagentTurnStatus {
  return status === "created" ? "queued" : status;
}

function requireDefined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("The session/turn registry lost a record during cancellation.");
  return value;
}

export type { SubagentSessionStatus };
