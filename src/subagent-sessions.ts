import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { DurableStateFile } from "./durable-state.ts";
import { type SubagentJobV1, SUBAGENT_JOB_STATUSES, SubagentJobRegistry } from "./subagent-jobs.ts";
import { TmuxError } from "./tmux.ts";

/**
 * Durable registry for the generalized subagent lifecycle (issue #9).
 *
 * The legacy `SubagentJobV1` model conflated one long-lived logical subagent
 * with exactly one executable run and hard-coded `agent: "pi"`. This registry
 * separates the two:
 *
 *   SubagentSession  (logical conversation: agent, cwd, tmux boundary, native id)
 *     ├─ SubagentTurn #1  (one executable run in a pane)
 *     ├─ SubagentTurn #2
 *     └─ ...
 *
 * A terminal turn never terminates its session; the session returns to `idle`
 * and can run another turn (resuming the agent-native conversation through
 * `agentSessionId`). The durability contract shared with the job registry lives
 * in `DurableStateFile`: fsynced atomic writes, a cross-process owner lock that
 * is stolen only when its owner is provably dead, and fail-closed reads.
 *
 * No prompts, full transcripts, or raw pane output are ever stored here.
 */

export const SUBAGENT_SESSION_VERSION = 1 as const;
export const SUBAGENT_TURN_VERSION = 1 as const;

export const SUBAGENT_AGENTS = ["pi", "claude-code", "opencode"] as const;
export type SubagentAgent = (typeof SUBAGENT_AGENTS)[number];

export const SUBAGENT_SESSION_STATUSES = ["starting", "idle", "busy", "stopped", "lost"] as const;
export type SubagentSessionStatus = (typeof SUBAGENT_SESSION_STATUSES)[number];
export type TerminalSubagentSessionStatus = "stopped" | "lost";

export const SUBAGENT_TURN_STATUSES = ["queued", "starting", "running", "completed", "failed", "cancelled", "lost"] as const;
export type SubagentTurnStatus = (typeof SUBAGENT_TURN_STATUSES)[number];
export type TerminalSubagentTurnStatus = "completed" | "failed" | "cancelled" | "lost";

const TERMINAL_SESSION_STATUSES: ReadonlySet<SubagentSessionStatus> = new Set<TerminalSubagentSessionStatus>(["stopped", "lost"]);
const TERMINAL_TURN_STATUSES: ReadonlySet<SubagentTurnStatus> = new Set<TerminalSubagentTurnStatus>(["completed", "failed", "cancelled", "lost"]);
const ACTIVE_TURN_STATUSES: ReadonlySet<SubagentTurnStatus> = new Set<SubagentTurnStatus>(["queued", "starting", "running"]);

export function isTerminalSessionStatus(status: SubagentSessionStatus): status is TerminalSubagentSessionStatus {
  return TERMINAL_SESSION_STATUSES.has(status);
}
export function isTerminalTurnStatus(status: SubagentTurnStatus): status is TerminalSubagentTurnStatus {
  return TERMINAL_TURN_STATUSES.has(status);
}
export function isActiveTurnStatus(status: SubagentTurnStatus): boolean {
  return ACTIVE_TURN_STATUSES.has(status);
}

/**
 * Legal forward session transitions. A same-status transition is idempotent;
 * every move out of a terminal status is rejected. `busy`/`idle` are derived
 * from turn state where required (see `transitionSession`).
 */
const SESSION_TRANSITIONS: Record<SubagentSessionStatus, readonly SubagentSessionStatus[]> = {
  starting: ["idle", "busy", "stopped", "lost"],
  idle: ["busy", "stopped", "lost"],
  busy: ["idle", "stopped", "lost"],
  stopped: [],
  lost: [],
};

/**
 * Legal forward turn transitions. A turn must pass through `starting` and
 * `running` in order; terminal outcomes are immutable; duplicate terminal
 * transitions are no-ops that preserve the winning outcome.
 */
const TURN_TRANSITIONS: Record<SubagentTurnStatus, readonly SubagentTurnStatus[]> = {
  queued: ["starting", "failed", "cancelled", "lost"],
  starting: ["running", "failed", "cancelled", "lost"],
  running: ["completed", "failed", "cancelled", "lost"],
  completed: [],
  failed: [],
  cancelled: [],
  lost: [],
};

export interface SubagentSessionV1 {
  version: 1;
  sessionId: string;
  agent: SubagentAgent;
  /** The owning Pi conversation, or null for a migrated legacy job without a recorded parent. */
  parentPiSessionId: string | null;
  cwd: string;
  status: SubagentSessionStatus;
  /** Stable tmux session ID (`$N`) owned by this logical subagent, or null until bound. */
  tmuxSessionId: string | null;
  /** tmux server fingerprint (`pid:start_time`) the target belonged to when bound. */
  serverIdentity?: string;
  /** Native Claude/OpenCode/Pi conversation id, stored after the first turn so later turns resume it. */
  agentSessionId?: string;
  createdAt: string;
  updatedAt: string;
  /** Set when this session was migrated from a legacy `SubagentJobV1`; also makes migration idempotent. */
  legacyJobId?: string;
}

export interface SubagentTurnV1 {
  version: 1;
  turnId: string;
  sessionId: string;
  status: SubagentTurnStatus;
  /** Stable tmux pane ID (`%N`) this turn runs in, or null until bound. */
  tmuxPaneId: string | null;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  resultPath?: string;
  error?: string;
  /** Registry-global, monotonic sequence assigned when the turn first becomes terminal. */
  completionSeq?: number;
  /** Set once the owning parent has acknowledged the terminal outcome. */
  notifiedAt?: string;
}

interface SubagentSessionState {
  version: 1;
  nextCompletionSeq: number;
  sessions: SubagentSessionV1[];
  turns: SubagentTurnV1[];
}

export interface CreateSubagentSessionInput {
  agent: SubagentAgent;
  cwd: string;
  parentPiSessionId: string | null;
}

export interface BindSubagentSessionInput {
  tmuxSessionId: string;
  serverIdentity?: string;
}

export interface InsertLegacyJobsOptions {
  /** Override the migration timestamp (tests / an authoritative clock). */
  at?: string;
}

export interface SubagentSessionRegistryOptions {
  /** Acknowledged terminal turns retained before the oldest are evicted (default 100). */
  maxAcknowledgedTurns?: number;
  /** Fully acknowledged terminal sessions retained before the oldest are evicted (default 100). */
  maxAcknowledgedSessions?: number;
  /** Absolute hard bound on turns; creation fails rather than evicting live data (default 1000). */
  maxTurns?: number;
  /** Absolute hard bound on sessions; creation fails rather than evicting live data (default 500). */
  maxSessions?: number;
  /** How long to wait for the cross-process lock before failing (default 10s). */
  lockTimeoutMs?: number;
  /** Delay between lock acquisition attempts (default 25ms). */
  lockRetryMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export interface SessionMutationOptions {
  /** When provided, the session's owner must match or the mutation is refused. */
  parentPiSessionId?: string;
  /** Override the mutation timestamp. */
  at?: string;
}

export interface TransitionSubagentTurnOptions extends SessionMutationOptions {
  exitCode?: number;
  resultPath?: string;
  error?: string;
}

/** Liveness snapshot a caller derives from tmux (see `Targets.liveTargets`). */
export interface SubagentSessionLiveView {
  live: ReadonlySet<string>;
  serverIdentity?: string;
}

export interface SubagentSessionListFilter {
  status?: SubagentSessionStatus | readonly SubagentSessionStatus[];
  agent?: SubagentAgent;
  parentPiSessionId?: string;
}

export interface SubagentTurnListFilter {
  sessionId?: string;
  status?: SubagentTurnStatus | readonly SubagentTurnStatus[];
  parentPiSessionId?: string;
}

export interface SubagentReconcileResult {
  sessions: SubagentSessionV1[];
  turns: SubagentTurnV1[];
}

export interface LegacyMigrationResult {
  imported: number;
  skipped: number;
}

const DEFAULT_MAX_ACKNOWLEDGED_TURNS = 100;
const DEFAULT_MAX_ACKNOWLEDGED_SESSIONS = 100;
const DEFAULT_MAX_TURNS = 1_000;
const DEFAULT_MAX_SESSIONS = 500;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const MAX_AGENT_SESSION_ID_BYTES = 512;
const SESSION_ID = /^\$\d+$/;
const PANE_ID = /^%\d+$/;

export function defaultSubagentSessionsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_TMUX_SUBAGENT_SESSIONS) return env.PI_TMUX_SUBAGENT_SESSIONS;
  const stateHome = env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
  return path.join(stateHome, "pi-tmux", "subagent-sessions.json");
}

export class SubagentSessionRegistry {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly maxAcknowledgedTurns: number;
  private readonly maxAcknowledgedSessions: number;
  private readonly maxTurns: number;
  private readonly maxSessions: number;
  private readonly now: () => Date;
  private readonly store: DurableStateFile;

  constructor(readonly file: string = defaultSubagentSessionsPath(), options: SubagentSessionRegistryOptions = {}) {
    this.maxAcknowledgedTurns = positiveInteger(options.maxAcknowledgedTurns ?? DEFAULT_MAX_ACKNOWLEDGED_TURNS, "maxAcknowledgedTurns");
    this.maxAcknowledgedSessions = positiveInteger(options.maxAcknowledgedSessions ?? DEFAULT_MAX_ACKNOWLEDGED_SESSIONS, "maxAcknowledgedSessions");
    this.maxTurns = positiveInteger(options.maxTurns ?? DEFAULT_MAX_TURNS, "maxTurns");
    this.maxSessions = positiveInteger(options.maxSessions ?? DEFAULT_MAX_SESSIONS, "maxSessions");
    if (this.maxAcknowledgedTurns > this.maxTurns) throw new TmuxError("maxAcknowledgedTurns cannot exceed maxTurns.", "invalid_option");
    if (this.maxAcknowledgedSessions > this.maxSessions) throw new TmuxError("maxAcknowledgedSessions cannot exceed maxSessions.", "invalid_option");
    this.now = options.now ?? (() => new Date());
    this.store = new DurableStateFile(file, {
      label: "subagent session registry",
      lockTimeoutMs: positiveInteger(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, "lockTimeoutMs"),
      lockRetryMs: positiveInteger(options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS, "lockRetryMs"),
      now: this.now,
    });
  }

  /** Creates an unbound `starting` session owned by one Pi conversation. */
  async createSession(input: CreateSubagentSessionInput): Promise<SubagentSessionV1> {
    const agent = input?.agent;
    if (!SUBAGENT_AGENTS.includes(agent)) {
      throw new TmuxError(`agent must be one of ${SUBAGENT_AGENTS.join(", ")}.`, "invalid_option");
    }
    const cwd = requireNonEmptyString(input?.cwd, "cwd");
    const parentPiSessionId = input.parentPiSessionId;
    if (!(parentPiSessionId === null || (typeof parentPiSessionId === "string" && parentPiSessionId.length > 0))) {
      throw new TmuxError("parentPiSessionId must be a non-empty string or null.", "invalid_option");
    }
    return this.mutate((state) => {
      if (state.sessions.length >= this.maxSessions) {
        throw new TmuxError(
          `Cannot create a subagent session: the registry already holds the ${this.maxSessions}-session hard bound and no acknowledged history can be evicted. Acknowledge or remove sessions before creating more.`,
          "invalid_option",
        );
      }
      const at = this.now().toISOString();
      let sessionId = randomUUID();
      while (state.sessions.some((session) => session.sessionId === sessionId)) sessionId = randomUUID();
      const session: SubagentSessionV1 = {
        version: SUBAGENT_SESSION_VERSION,
        sessionId,
        agent,
        parentPiSessionId,
        cwd,
        status: "starting",
        tmuxSessionId: null,
        createdAt: at,
        updatedAt: at,
      };
      state.sessions.push(session);
      return { ...session };
    });
  }

  /**
   * Binds a session to its stable tmux session exactly once. Idempotent for an
   * identical repeat and rejected for a different target. Only allowed before a
   * turn has started or after the session is idle.
   */
  async bindSession(sessionId: string, input: BindSubagentSessionInput, options: SessionMutationOptions = {}): Promise<SubagentSessionV1> {
    assertSessionId(sessionId);
    const tmuxSessionId = requireStableId(input?.tmuxSessionId, SESSION_ID, "tmuxSessionId");
    const serverIdentity = input.serverIdentity;
    if (serverIdentity !== undefined && (typeof serverIdentity !== "string" || serverIdentity.length === 0)) {
      throw new TmuxError("serverIdentity must be a non-empty string when provided.", "invalid_option");
    }
    const at = this.mutationTime(options.at);
    return this.mutate((state) => {
      const session = findSession(state, sessionId);
      assertOwner(session, options.parentPiSessionId);
      if (isTerminalSessionStatus(session.status)) {
        throw new TmuxError(`Session ${sessionId} is already terminal (${session.status}); it cannot bind a tmux target.`, "invalid_option");
      }
      if (session.tmuxSessionId !== null) {
        if (session.tmuxSessionId === tmuxSessionId) return { ...session };
        throw new TmuxError(`Session ${sessionId} is already bound to ${session.tmuxSessionId}.`, "invalid_option");
      }
      if (session.status !== "starting" && session.status !== "idle") {
        throw new TmuxError(`Session ${sessionId} cannot bind a tmux target from status ${session.status}.`, "invalid_option");
      }
      const clash = state.sessions.find((other) => other.sessionId !== sessionId && !isTerminalSessionStatus(other.status) && other.tmuxSessionId === tmuxSessionId);
      if (clash) {
        throw new TmuxError(`tmux session ${tmuxSessionId} is already bound to active session ${clash.sessionId}; refusing to reuse a live tmux ID.`, "invalid_option");
      }
      session.tmuxSessionId = tmuxSessionId;
      if (serverIdentity !== undefined) session.serverIdentity = serverIdentity;
      session.updatedAt = at;
      return { ...session };
    });
  }

  /**
   * Applies a legal session transition. `busy` is derived from an active turn
   * and `idle` is refused while a turn is active, so the session status can
   * never contradict the turn set. Terminal session statuses are immutable.
   */
  async transitionSession(sessionId: string, status: SubagentSessionStatus, options: SessionMutationOptions = {}): Promise<SubagentSessionV1> {
    assertSessionId(sessionId);
    if (!SUBAGENT_SESSION_STATUSES.includes(status)) {
      throw new TmuxError(`Unknown subagent session status ${JSON.stringify(status)}.`, "invalid_option");
    }
    const at = this.mutationTime(options.at);
    return this.mutate((state) => {
      const session = findSession(state, sessionId);
      assertOwner(session, options.parentPiSessionId);
      if (session.status === status) return { ...session };
      if (isTerminalSessionStatus(session.status)) {
        throw new TmuxError(`Session ${sessionId} is already terminal (${session.status}); a terminal session is immutable.`, "invalid_option");
      }
      if (!SESSION_TRANSITIONS[session.status].includes(status)) {
        throw new TmuxError(`Illegal transition ${session.status} -> ${status} for session ${sessionId}.`, "invalid_option");
      }
      if (status === "busy") {
        throw new TmuxError(`Session ${sessionId} becomes "busy" only by starting a turn, not by an explicit transition.`, "invalid_option");
      }
      if (status === "idle" && hasActiveTurn(state, sessionId)) {
        throw new TmuxError(`Session ${sessionId} has an active turn and cannot be marked idle.`, "invalid_option");
      }
      if ((status === "stopped" || status === "lost") && hasActiveTurn(state, sessionId)) {
        throw new TmuxError(`Session ${sessionId} has an active turn; finish or cancel it before marking the session ${status}.`, "invalid_option");
      }
      session.status = status;
      session.updatedAt = at;
      return { ...session };
    });
  }

  /**
   * Stores the agent-native conversation/session id after the first turn so a
   * later turn can resume the same Claude/OpenCode/Pi conversation. Immutable
   * once set: a mismatch signals a bug rather than a legitimate rename.
   */
  async setAgentSessionId(sessionId: string, agentSessionId: string, options: SessionMutationOptions = {}): Promise<SubagentSessionV1> {
    assertSessionId(sessionId);
    const value = requireBoundedString(agentSessionId, "agentSessionId", MAX_AGENT_SESSION_ID_BYTES);
    const at = this.mutationTime(options.at);
    return this.mutate((state) => {
      const session = findSession(state, sessionId);
      assertOwner(session, options.parentPiSessionId);
      if (session.agentSessionId !== undefined) {
        if (session.agentSessionId === value) return { ...session };
        throw new TmuxError(`Session ${sessionId} already records agent session id ${JSON.stringify(session.agentSessionId)}; it is immutable.`, "invalid_option");
      }
      session.agentSessionId = value;
      session.updatedAt = at;
      return { ...session };
    });
  }

  async getSession(sessionId: string): Promise<SubagentSessionV1 | undefined> {
    assertSessionId(sessionId);
    await this.writes;
    const state = await this.readState();
    const session = state.sessions.find((item) => item.sessionId === sessionId);
    return session ? { ...session } : undefined;
  }

  async listSessions(filter: SubagentSessionListFilter = {}): Promise<SubagentSessionV1[]> {
    await this.writes;
    const state = await this.readState();
    const statuses = filter.status === undefined ? undefined : (Array.isArray(filter.status) ? filter.status : [filter.status]);
    return state.sessions
      .filter((session) => statuses === undefined || statuses.includes(session.status))
      .filter((session) => filter.agent === undefined || session.agent === filter.agent)
      .filter((session) => filter.parentPiSessionId === undefined || session.parentPiSessionId === filter.parentPiSessionId)
      .map((session) => ({ ...session }));
  }

  /**
   * Creates a `queued` turn for a bound, non-terminal session. Rejected when the
   * session already has an active turn: only one active turn per session is
   * allowed for v1.
   */
  async createTurn(sessionId: string, options: SessionMutationOptions = {}): Promise<SubagentTurnV1> {
    assertSessionId(sessionId);
    const at = this.mutationTime(options.at);
    return this.mutate((state) => {
      const session = findSession(state, sessionId);
      assertOwner(session, options.parentPiSessionId);
      if (isTerminalSessionStatus(session.status)) {
        throw new TmuxError(`Session ${sessionId} is ${session.status}; it cannot start another turn.`, "invalid_option");
      }
      if (session.tmuxSessionId === null) {
        throw new TmuxError(`Session ${sessionId} must be bound to a stable tmux session before it can start a turn.`, "invalid_option");
      }
      if (hasActiveTurn(state, sessionId)) {
        throw new TmuxError(`Session ${sessionId} already has an active turn; only one active turn per session is allowed.`, "invalid_option");
      }
      if (state.turns.length >= this.maxTurns) {
        throw new TmuxError(
          `Cannot create a subagent turn: the registry already holds the ${this.maxTurns}-turn hard bound and no acknowledged history can be evicted. Acknowledge or remove turns before creating more.`,
          "invalid_option",
        );
      }
      let turnId = randomUUID();
      while (state.turns.some((turn) => turn.turnId === turnId)) turnId = randomUUID();
      const turn: SubagentTurnV1 = {
        version: SUBAGENT_TURN_VERSION,
        turnId,
        sessionId,
        status: "queued",
        tmuxPaneId: null,
        createdAt: at,
      };
      state.turns.push(turn);
      session.updatedAt = at;
      return { ...turn };
    });
  }

  /**
   * Binds a `queued` turn to its stable tmux pane exactly once, refusing to
   * point a live turn at a pane another active turn already owns.
   */
  async bindTurn(turnId: string, input: { tmuxPaneId: string }, options: SessionMutationOptions = {}): Promise<SubagentTurnV1> {
    assertTurnId(turnId);
    const tmuxPaneId = requireStableId(input?.tmuxPaneId, PANE_ID, "tmuxPaneId");
    const at = this.mutationTime(options.at);
    return this.mutate((state) => {
      const turn = findTurn(state, turnId);
      const session = sessionOfTurn(state, turn);
      assertOwner(session, options.parentPiSessionId);
      if (turn.tmuxPaneId !== null) {
        if (turn.tmuxPaneId === tmuxPaneId) return { ...turn };
        throw new TmuxError(`Turn ${turnId} is already bound to ${turn.tmuxPaneId}.`, "invalid_option");
      }
      if (turn.status !== "queued") {
        throw new TmuxError(`Turn ${turnId} cannot bind a tmux pane from status ${turn.status}; binding is only allowed while "queued".`, "invalid_option");
      }
      const clash = state.turns.find((other) => other.turnId !== turnId && isActiveTurnStatus(other.status) && other.tmuxPaneId === tmuxPaneId);
      if (clash) {
        throw new TmuxError(`Pane ${tmuxPaneId} is already bound to active turn ${clash.turnId}; refusing to reuse a live tmux ID.`, "invalid_option");
      }
      turn.tmuxPaneId = tmuxPaneId;
      session.updatedAt = at;
      return { ...turn };
    });
  }

  /**
   * Applies a legal turn transition. Same-status calls are idempotent; terminal
   * outcomes are immutable; `starting`/`running` require a bound pane; the first
   * terminal transition assigns `completionSeq`. A terminal turn returns its
   * session to `idle` (never to a terminal status) once no active turn remains.
   */
  async transitionTurn(turnId: string, status: SubagentTurnStatus, options: TransitionSubagentTurnOptions = {}): Promise<SubagentTurnV1> {
    assertTurnId(turnId);
    if (!SUBAGENT_TURN_STATUSES.includes(status)) {
      throw new TmuxError(`Unknown subagent turn status ${JSON.stringify(status)}.`, "invalid_option");
    }
    const at = this.mutationTime(options.at);
    if (options.exitCode !== undefined && !Number.isSafeInteger(options.exitCode)) {
      throw new TmuxError("exitCode must be a safe integer.", "invalid_option");
    }
    if (options.resultPath !== undefined) requireNonEmptyString(options.resultPath, "resultPath");
    if (options.error !== undefined && typeof options.error !== "string") throw new TmuxError("error must be a string.", "invalid_option");

    return this.mutate((state) => {
      const turn = findTurn(state, turnId);
      const session = sessionOfTurn(state, turn);
      assertOwner(session, options.parentPiSessionId);
      if (turn.status === status) return { ...turn };
      if (isTerminalTurnStatus(turn.status)) {
        throw new TmuxError(`Turn ${turnId} is already terminal (${turn.status}); a terminal outcome is immutable.`, "invalid_option");
      }
      if (!TURN_TRANSITIONS[turn.status].includes(status)) {
        throw new TmuxError(`Illegal transition ${turn.status} -> ${status} for turn ${turnId}.`, "invalid_option");
      }
      if ((status === "starting" || status === "running") && turn.tmuxPaneId === null) {
        throw new TmuxError(`Turn ${turnId} must be bound to a stable tmux pane before it can be ${status}.`, "invalid_option");
      }
      if (status === "starting" && turn.startedAt === undefined) turn.startedAt = at;
      if (isTerminalTurnStatus(status)) {
        turn.finishedAt ??= at;
        if (turn.completionSeq === undefined) turn.completionSeq = state.nextCompletionSeq++;
        if (options.exitCode !== undefined) turn.exitCode = options.exitCode;
        if (options.resultPath !== undefined) turn.resultPath = options.resultPath;
        if (options.error !== undefined) turn.error = options.error;
      }
      turn.status = status;

      // Couple the session to the turn set without ever terminating it: an
      // active turn makes the session `busy`, and the last terminal turn
      // returns it to `idle` for the next turn.
      if (!isTerminalSessionStatus(session.status)) {
        if (!isTerminalTurnStatus(status)) {
          if (session.status === "idle" || session.status === "starting") session.status = "busy";
        } else if (!hasActiveTurn(state, turn.sessionId) && (session.status === "busy" || session.status === "starting")) {
          session.status = "idle";
        }
        session.updatedAt = at;
      }
      return { ...turn };
    });
  }

  async getTurn(turnId: string): Promise<SubagentTurnV1 | undefined> {
    assertTurnId(turnId);
    await this.writes;
    const state = await this.readState();
    const turn = state.turns.find((item) => item.turnId === turnId);
    return turn ? { ...turn } : undefined;
  }

  async listTurns(filter: SubagentTurnListFilter = {}): Promise<SubagentTurnV1[]> {
    await this.writes;
    const state = await this.readState();
    const statuses = filter.status === undefined ? undefined : (Array.isArray(filter.status) ? filter.status : [filter.status]);
    const owners = new Map(state.sessions.map((session) => [session.sessionId, session.parentPiSessionId]));
    return state.turns
      .filter((turn) => filter.sessionId === undefined || turn.sessionId === filter.sessionId)
      .filter((turn) => statuses === undefined || statuses.includes(turn.status))
      .filter((turn) => filter.parentPiSessionId === undefined || owners.get(turn.sessionId) === filter.parentPiSessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.turnId.localeCompare(b.turnId))
      .map((turn) => ({ ...turn }));
  }

  /** Terminal turns whose completion has not been acknowledged, oldest completion first. */
  async pendingDeliveries(filter: { parentPiSessionId?: string } = {}): Promise<SubagentTurnV1[]> {
    await this.writes;
    const state = await this.readState();
    const owners = new Map(state.sessions.map((session) => [session.sessionId, session.parentPiSessionId]));
    return state.turns
      .filter((turn) => isTerminalTurnStatus(turn.status) && turn.notifiedAt === undefined)
      .filter((turn) => filter.parentPiSessionId === undefined || owners.get(turn.sessionId) === filter.parentPiSessionId)
      .sort((a, b) => (a.completionSeq ?? 0) - (b.completionSeq ?? 0) || a.turnId.localeCompare(b.turnId))
      .map((turn) => ({ ...turn }));
  }

  /** Records that the parent has observed a terminal turn outcome. Idempotent. */
  async markNotified(turnId: string, options: SessionMutationOptions = {}): Promise<SubagentTurnV1> {
    assertTurnId(turnId);
    const at = this.mutationTime(options.at);
    return this.mutate((state) => {
      const turn = findTurn(state, turnId);
      const session = sessionOfTurn(state, turn);
      assertOwner(session, options.parentPiSessionId);
      if (!isTerminalTurnStatus(turn.status)) {
        throw new TmuxError(`Turn ${turnId} is ${turn.status}; delivery bookkeeping is only valid for terminal turns.`, "invalid_option");
      }
      if (turn.notifiedAt === undefined) turn.notifiedAt = at;
      return { ...turn };
    });
  }

  /**
   * Marks non-terminal turns whose stable tmux pane is missing from `view.live`
   * as `lost`, and non-terminal sessions whose stable tmux session is missing
   * (or that belong to a different server identity) as `lost`. A session whose
   * own target survives but whose active turn vanished returns to `idle`, so it
   * can run another turn.
   *
   * `options.parentPiSessionId` scopes reconciliation to one conversation, so a
   * parent-side observer can never rewrite another parent's records. When
   * nothing changes the registry file is not rewritten, which keeps a
   * watcher-driven parent quiescent.
   */
  async reconcile(view: SubagentSessionLiveView, options: { parentPiSessionId?: string } = {}): Promise<SubagentReconcileResult> {
    if (view === null || typeof view !== "object" || !(view.live instanceof Set)) {
      throw new TmuxError("reconcile requires a live view with a Set of tmux IDs.", "invalid_option");
    }
    const owner = options.parentPiSessionId;
    if (owner !== undefined && (typeof owner !== "string" || !owner)) {
      throw new TmuxError("reconcile parentPiSessionId must be a non-empty string when provided.", "invalid_option");
    }
    const at = this.now().toISOString();
    return this.mutateIfChanged((state) => {
      const changedSessions: SubagentSessionV1[] = [];
      const changedTurns: SubagentTurnV1[] = [];
      const sessionsById = new Map(state.sessions.map((session) => [session.sessionId, session]));

      for (const turn of state.turns) {
        if (isTerminalTurnStatus(turn.status)) continue;
        const session = sessionsById.get(turn.sessionId)!;
        if (owner !== undefined && session.parentPiSessionId !== owner) continue;
        const targetId = turn.tmuxPaneId ?? session.tmuxSessionId;
        if (targetId === null) continue;
        const identityLost = view.serverIdentity !== undefined && session.serverIdentity !== undefined && session.serverIdentity !== view.serverIdentity;
        if (!identityLost && view.live.has(targetId)) continue;
        turn.status = "lost";
        turn.finishedAt ??= at;
        if (turn.completionSeq === undefined) turn.completionSeq = state.nextCompletionSeq++;
        changedTurns.push({ ...turn });
      }

      for (const session of state.sessions) {
        if (isTerminalSessionStatus(session.status)) continue;
        if (owner !== undefined && session.parentPiSessionId !== owner) continue;
        const targetId = session.tmuxSessionId;
        if (targetId !== null) {
          const identityLost = view.serverIdentity !== undefined && session.serverIdentity !== undefined && session.serverIdentity !== view.serverIdentity;
          if (identityLost || !view.live.has(targetId)) {
            session.status = "lost";
            session.updatedAt = at;
            changedSessions.push({ ...session });
            continue;
          }
        }
        if (session.status === "busy" && !hasActiveTurn(state, session.sessionId)) {
          session.status = "idle";
          session.updatedAt = at;
          changedSessions.push({ ...session });
        }
      }

      return { value: { sessions: changedSessions, turns: changedTurns }, changed: changedSessions.length > 0 || changedTurns.length > 0 };
    });
  }

  /**
   * Atomically imports legacy `SubagentJobV1` records as one session + one turn
   * each. Idempotent: a job whose `jobId` already appears as a `legacyJobId` is
   * skipped, so re-running the migration never duplicates state. Terminal jobs
   * and their pending completion acknowledgements are preserved (including
   * `completionSeq` and `notifiedAt`), so no delivery is lost.
   */
  async importLegacyJobs(jobs: readonly SubagentJobV1[], options: InsertLegacyJobsOptions = {}): Promise<LegacyMigrationResult> {
    if (!Array.isArray(jobs)) throw new TmuxError("importLegacyJobs requires an array of legacy jobs.", "invalid_option");
    if (options.at !== undefined) requireTimestamp(options.at, "at");
    return this.mutateIfChanged((state) => {
      const known = new Set(state.sessions.map((session) => session.legacyJobId).filter((id): id is string => id !== undefined));
      let imported = 0;
      let skipped = 0;
      for (const job of jobs) {
        if (!isLegacyJob(job)) throw new TmuxError(`Legacy subagent job ${JSON.stringify((job as { jobId?: unknown })?.jobId ?? job)} is malformed; refusing to migrate it.`, "invalid_option");
        if (known.has(job.jobId)) {
          skipped++;
          continue;
        }
        if (state.sessions.length >= this.maxSessions || state.turns.length >= this.maxTurns) {
          throw new TmuxError(
            `Cannot migrate legacy subagent jobs: the session/turn registry is at its hard bound (${this.maxSessions} sessions / ${this.maxTurns} turns). Acknowledge or remove history before migrating more.`,
            "invalid_option",
          );
        }
        const { session, turn } = legacyJobToSessionAndTurn(job);
        state.sessions.push(session);
        state.turns.push(turn);
        known.add(job.jobId);
        if (job.completionSeq !== undefined) state.nextCompletionSeq = Math.max(state.nextCompletionSeq, job.completionSeq + 1);
        imported++;
      }
      return { value: { imported, skipped }, changed: imported > 0 };
    });
  }

  private async readState(): Promise<SubagentSessionState> {
    const raw = await this.store.readText();
    if (raw === undefined) return { version: SUBAGENT_SESSION_VERSION, nextCompletionSeq: 1, sessions: [], turns: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TmuxError(`The subagent session registry at ${this.file} is not valid JSON; refusing to overwrite it. Remove or repair the file to continue.`, "command_failed");
    }
    if (parsed === null || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== SUBAGENT_SESSION_VERSION) {
      throw new TmuxError(`Unsupported subagent session registry version at ${this.file}; refusing to overwrite it.`, "command_failed");
    }
    const sessions = (parsed as { sessions?: unknown }).sessions;
    const turns = (parsed as { turns?: unknown }).turns;
    if (!Array.isArray(sessions) || !sessions.every(isSession) || !Array.isArray(turns) || !turns.every(isTurn)) {
      throw new TmuxError(`The subagent session registry at ${this.file} has an unexpected shape; refusing to overwrite it.`, "command_failed");
    }
    const sessionIds = new Set<string>();
    const legacyIds = new Set<string>();
    for (const session of sessions) {
      if (sessionIds.has(session.sessionId)) throw new TmuxError(`The subagent session registry at ${this.file} contains duplicate session ID ${session.sessionId}; refusing to overwrite it.`, "command_failed");
      sessionIds.add(session.sessionId);
      if (session.legacyJobId !== undefined) {
        if (legacyIds.has(session.legacyJobId)) throw new TmuxError(`The subagent session registry at ${this.file} contains duplicate legacy job ID ${session.legacyJobId}; refusing to overwrite it.`, "command_failed");
        legacyIds.add(session.legacyJobId);
      }
    }
    const turnIds = new Set<string>();
    for (const turn of turns) {
      if (turnIds.has(turn.turnId)) throw new TmuxError(`The subagent session registry at ${this.file} contains duplicate turn ID ${turn.turnId}; refusing to overwrite it.`, "command_failed");
      turnIds.add(turn.turnId);
      if (!sessionIds.has(turn.sessionId)) throw new TmuxError(`The subagent session registry at ${this.file} contains turn ${turn.turnId} with no owning session; refusing to overwrite it.`, "command_failed");
    }
    const storedSeq = (parsed as { nextCompletionSeq?: unknown }).nextCompletionSeq;
    if (!Number.isSafeInteger(storedSeq) || (storedSeq as number) < 1) {
      throw new TmuxError(`The subagent session registry at ${this.file} has an invalid completion sequence; refusing to overwrite it.`, "command_failed");
    }
    const highest = turns.reduce((max, turn) => Math.max(max, turn.completionSeq ?? 0), 0);
    return {
      version: SUBAGENT_SESSION_VERSION,
      nextCompletionSeq: Math.max(storedSeq as number, highest + 1),
      sessions: sessions.map((session) => ({ ...session })),
      turns: turns.map((turn) => ({ ...turn })),
    };
  }

  private async writeState(state: SubagentSessionState): Promise<void> {
    await this.store.writeText(`${JSON.stringify(state, null, 2)}\n`);
  }

  private mutationTime(at: string | undefined): string {
    return at === undefined ? this.now().toISOString() : requireTimestamp(at, "at");
  }

  private async mutate<T>(change: (state: SubagentSessionState) => T): Promise<T> {
    return this.mutateIfChanged((state) => ({ value: change(state), changed: true }));
  }

  private async mutateIfChanged<T>(change: (state: SubagentSessionState) => { value: T; changed: boolean }): Promise<T> {
    const run = async (): Promise<T> => this.store.withLock(async () => {
      const state = await this.readState();
      const pruned = pruneAcknowledged(state, this.maxAcknowledgedTurns, this.maxAcknowledgedSessions);
      const { value, changed } = change(state);
      if (changed || pruned > 0) {
        pruneAcknowledged(state, this.maxAcknowledgedTurns, this.maxAcknowledgedSessions);
        await this.writeState(state);
      }
      return value;
    });
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    return next;
  }
}

/**
 * Pure mapping from a legacy `SubagentJobV1` to one session + one turn. Exposed
 * so callers can migrate in-memory jobs without touching the filesystem.
 */
export function legacyJobToSessionAndTurn(job: SubagentJobV1): { session: SubagentSessionV1; turn: SubagentTurnV1 } {
  const updatedAt = job.finishedAt ?? job.startedAt ?? job.createdAt;
  const session: SubagentSessionV1 = {
    version: SUBAGENT_SESSION_VERSION,
    sessionId: randomUUID(),
    agent: job.agent,
    parentPiSessionId: job.parentPiSessionId,
    cwd: job.cwd,
    status: legacySessionStatus(job),
    tmuxSessionId: job.tmuxSessionId,
    ...(job.serverIdentity ? { serverIdentity: job.serverIdentity } : {}),
    createdAt: job.createdAt,
    updatedAt,
    legacyJobId: job.jobId,
  };
  const turn: SubagentTurnV1 = {
    version: SUBAGENT_TURN_VERSION,
    turnId: randomUUID(),
    sessionId: session.sessionId,
    status: legacyTurnStatus(job),
    tmuxPaneId: job.tmuxPaneId,
    createdAt: job.createdAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
    ...(job.resultPath ? { resultPath: job.resultPath } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.completionSeq !== undefined ? { completionSeq: job.completionSeq } : {}),
    ...(job.notifiedAt ? { notifiedAt: job.notifiedAt } : {}),
  };
  return { session, turn };
}

function legacySessionStatus(job: SubagentJobV1): SubagentSessionStatus {
  switch (job.status) {
    case "created":
      return "starting";
    case "starting":
      return "starting";
    case "running":
      return "busy";
    case "completed":
    case "failed":
      return "idle";
    case "cancelled":
      return "stopped";
    case "lost":
      return "lost";
  }
}

function legacyTurnStatus(job: SubagentJobV1): SubagentTurnStatus {
  switch (job.status) {
    case "created":
      return "queued";
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "lost":
      return "lost";
  }
}

/**
 * Reads the legacy Pi job registry and imports it into the session/turn
 * registry atomically. This is the explicit migration entry point: it never
 * mutates or deletes the legacy file, and re-running it is a no-op.
 */
export interface MigrateSubagentJobsOptions {
  /** Legacy registry file; defaults to `defaultSubagentJobsPath()`. */
  jobsFile?: string;
  /** Session registry file; defaults to `defaultSubagentSessionsPath()`. */
  sessionsFile?: string;
  /** Reuse an existing job registry (overrides `jobsFile`). */
  jobs?: SubagentJobRegistry;
  /** Reuse an existing session registry (overrides `sessionsFile`). */
  sessions?: SubagentSessionRegistry;
  at?: string;
}

export async function migrateSubagentJobs(options: MigrateSubagentJobsOptions = {}): Promise<LegacyMigrationResult> {
  const jobsRegistry = options.jobs ?? new SubagentJobRegistry(options.jobsFile);
  const sessionsRegistry = options.sessions ?? new SubagentSessionRegistry(options.sessionsFile);
  const legacy = await jobsRegistry.list();
  return sessionsRegistry.importLegacyJobs(legacy, { at: options.at });
}

function findSession(state: SubagentSessionState, sessionId: string): SubagentSessionV1 {
  const session = state.sessions.find((item) => item.sessionId === sessionId);
  if (!session) throw new TmuxError(`Unknown subagent session ${JSON.stringify(sessionId)}.`, "invalid_target");
  return session;
}

function findTurn(state: SubagentSessionState, turnId: string): SubagentTurnV1 {
  const turn = state.turns.find((item) => item.turnId === turnId);
  if (!turn) throw new TmuxError(`Unknown subagent turn ${JSON.stringify(turnId)}.`, "invalid_target");
  return turn;
}

function sessionOfTurn(state: SubagentSessionState, turn: SubagentTurnV1): SubagentSessionV1 {
  const session = state.sessions.find((item) => item.sessionId === turn.sessionId);
  if (!session) throw new TmuxError(`Turn ${turn.turnId} has no owning session; the registry is corrupt.`, "command_failed");
  return session;
}

function hasActiveTurn(state: SubagentSessionState, sessionId: string): boolean {
  return state.turns.some((turn) => turn.sessionId === sessionId && isActiveTurnStatus(turn.status));
}

function assertOwner(session: SubagentSessionV1, owner: string | undefined): void {
  if (owner === undefined) return;
  if (typeof owner !== "string" || !owner) throw new TmuxError("parentPiSessionId must be a non-empty string when provided.", "invalid_option");
  if (session.parentPiSessionId !== owner) {
    throw new TmuxError(`Subagent session ${session.sessionId} belongs to another Pi conversation; refusing to mutate it.`, "invalid_target");
  }
}

/** Drops the oldest acknowledged terminal turns, then unacknowledged-free terminal sessions. */
function pruneAcknowledged(state: SubagentSessionState, maxAcknowledgedTurns: number, maxAcknowledgedSessions: number): number {
  let pruned = 0;
  const acknowledged = state.turns
    .filter((turn) => isTerminalTurnStatus(turn.status) && turn.notifiedAt !== undefined)
    .sort((a, b) => acknowledgedTurnAt(a) - acknowledgedTurnAt(b) || a.turnId.localeCompare(b.turnId));
  const turnOverflow = acknowledged.length - maxAcknowledgedTurns;
  if (turnOverflow > 0) {
    const dropped = new Set(acknowledged.slice(0, turnOverflow).map((turn) => turn.turnId));
    state.turns = state.turns.filter((turn) => !dropped.has(turn.turnId));
    pruned += turnOverflow;
  }
  const referenced = new Set(state.turns.map((turn) => turn.sessionId));
  const prunable = state.sessions
    .filter((session) => isTerminalSessionStatus(session.status) && !referenced.has(session.sessionId))
    .sort((a, b) => sessionUpdatedAt(a) - sessionUpdatedAt(b) || a.sessionId.localeCompare(b.sessionId));
  const sessionOverflow = prunable.length - maxAcknowledgedSessions;
  if (sessionOverflow > 0) {
    const dropped = new Set(prunable.slice(0, sessionOverflow).map((session) => session.sessionId));
    state.sessions = state.sessions.filter((session) => !dropped.has(session.sessionId));
    pruned += sessionOverflow;
  }
  return pruned;
}

function acknowledgedTurnAt(turn: SubagentTurnV1): number {
  const timestamp = Date.parse(turn.notifiedAt ?? turn.finishedAt ?? turn.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sessionUpdatedAt(session: SubagentSessionV1): number {
  const timestamp = Date.parse(session.updatedAt ?? session.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isSession(value: unknown): value is SubagentSessionV1 {
  if (value === null || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  if (session.version !== SUBAGENT_SESSION_VERSION) return false;
  if (typeof session.sessionId !== "string" || !session.sessionId) return false;
  if (!SUBAGENT_AGENTS.includes(session.agent as SubagentAgent)) return false;
  if (!(typeof session.parentPiSessionId === "string" || session.parentPiSessionId === null)) return false;
  if (typeof session.cwd !== "string" || !session.cwd) return false;
  if (typeof session.status !== "string" || !SUBAGENT_SESSION_STATUSES.includes(session.status as SubagentSessionStatus)) return false;
  if (!(typeof session.tmuxSessionId === "string" || session.tmuxSessionId === null)) return false;
  if (session.serverIdentity !== undefined && (typeof session.serverIdentity !== "string" || !session.serverIdentity)) return false;
  if (session.agentSessionId !== undefined && (typeof session.agentSessionId !== "string" || !session.agentSessionId)) return false;
  if (typeof session.createdAt !== "string" || !Number.isFinite(Date.parse(session.createdAt))) return false;
  if (typeof session.updatedAt !== "string" || !Number.isFinite(Date.parse(session.updatedAt))) return false;
  if (session.legacyJobId !== undefined && (typeof session.legacyJobId !== "string" || !session.legacyJobId)) return false;
  return true;
}

function isTurn(value: unknown): value is SubagentTurnV1 {
  if (value === null || typeof value !== "object") return false;
  const turn = value as Record<string, unknown>;
  if (turn.version !== SUBAGENT_TURN_VERSION) return false;
  if (typeof turn.turnId !== "string" || !turn.turnId) return false;
  if (typeof turn.sessionId !== "string" || !turn.sessionId) return false;
  if (typeof turn.status !== "string" || !SUBAGENT_TURN_STATUSES.includes(turn.status as SubagentTurnStatus)) return false;
  if (!(typeof turn.tmuxPaneId === "string" || turn.tmuxPaneId === null)) return false;
  if (typeof turn.createdAt !== "string" || !Number.isFinite(Date.parse(turn.createdAt))) return false;
  for (const field of ["startedAt", "finishedAt", "notifiedAt"] as const) {
    const timestamp = turn[field];
    if (timestamp !== undefined && (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp)))) return false;
  }
  for (const field of ["resultPath", "error"] as const) {
    if (turn[field] !== undefined && typeof turn[field] !== "string") return false;
  }
  if (turn.exitCode !== undefined && !Number.isSafeInteger(turn.exitCode)) return false;
  if (turn.completionSeq !== undefined && (!Number.isSafeInteger(turn.completionSeq) || (turn.completionSeq as number) < 1)) return false;
  return true;
}

function isLegacyJob(value: unknown): value is SubagentJobV1 {
  if (value === null || typeof value !== "object") return false;
  const job = value as Record<string, unknown>;
  return job.version === 1
    && typeof job.jobId === "string" && !!job.jobId
    && job.agent === "pi"
    && typeof job.status === "string" && SUBAGENT_JOB_STATUSES.includes(job.status as (typeof SUBAGENT_JOB_STATUSES)[number])
    && (typeof job.parentPiSessionId === "string" || job.parentPiSessionId === null)
    && (typeof job.tmuxSessionId === "string" || job.tmuxSessionId === null)
    && (typeof job.tmuxPaneId === "string" || job.tmuxPaneId === null)
    && typeof job.cwd === "string" && !!job.cwd
    && typeof job.createdAt === "string" && Number.isFinite(Date.parse(job.createdAt));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TmuxError(`${name} must be a positive integer.`, "invalid_option");
  return value;
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || !sessionId) throw new TmuxError("A non-empty session ID is required.", "invalid_option");
}

function assertTurnId(turnId: string): void {
  if (typeof turnId !== "string" || !turnId) throw new TmuxError("A non-empty turn ID is required.", "invalid_option");
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new TmuxError(`${name} must be a non-empty string.`, "invalid_option");
  return value;
}

function requireBoundedString(value: unknown, name: string, maxBytes: number): string {
  const text = requireNonEmptyString(value, name);
  if (text.includes("\0")) throw new TmuxError(`${name} must not contain a NUL byte.`, "invalid_option");
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new TmuxError(`${name} is longer than ${maxBytes} bytes.`, "invalid_option");
  return text;
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
