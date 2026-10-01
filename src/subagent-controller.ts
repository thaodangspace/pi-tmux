import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentAdapter, AgentTurnContext, SubagentTurnOptions } from "./agent-adapter.ts";
import type { Registry } from "./registry.ts";
import type { LiveTargets, PaneTarget, SessionTarget } from "./targets.ts";
import { isTerminalSessionStatus, type SubagentAgent, type SubagentSessionStatus } from "./subagent-sessions.ts";
import { Tmux, TmuxError, errorMessage } from "./tmux.ts";

/**
 * Generic subagent controller (issue #10).
 *
 * This owns the tmux and durable-lifecycle behavior that is identical for every
 * agent, and delegates only launch behavior to an `AgentAdapter`:
 *
 * - a dedicated detached, inert tmux execution target is created before the
 *   child can start (the startup gate);
 * - stable `$N` / `%N` IDs and the required tmux server identity are bound
 *   durably before launch;
 * - parent provenance is best-effort recorded, never authoritative;
 * - `status` reconciles a vanished or re-used target against a live tmux view,
 *   scoped to one owner so another parent's records are never rewritten;
 * - `cancel` kills only a positively re-verified target and otherwise fails
 *   closed.
 *
 * The controller never mentions a concrete agent's executable, arguments,
 * environment, or completion mechanism; those live in the adapter and the
 * ledger declares whether a logical session supports one or many turns.
 * Caller task text is only ever carried as tmux environment values and expanded
 * quoted by a constant command string, so it can never be shell-interpreted.
 */

/** The subset of `Targets` the controller needs (structural, so tests can stub it). */
export interface SubagentTargets {
  session(selector: string, signal?: AbortSignal): Promise<SessionTarget>;
  panes(signal?: AbortSignal): Promise<PaneTarget[]>;
  liveTargets(signal?: AbortSignal): Promise<LiveTargets>;
  serverIdentity(signal?: AbortSignal): Promise<string | undefined>;
}

export type SubagentRunStatus = "created" | "starting" | "running" | "completed" | "failed" | "cancelled" | "lost";

const TERMINAL_RUN_STATUSES: ReadonlySet<SubagentRunStatus> = new Set(["completed", "failed", "cancelled", "lost"]);

export function isTerminalRunStatus(status: SubagentRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/** Agent-neutral view of one durable executable run. */
export interface SubagentRunRecord {
  runId: string;
  sessionId: string;
  agent: SubagentAgent;
  owner: string | null;
  cwd: string;
  status: SubagentRunStatus;
  tmuxSessionId: string | null;
  tmuxPaneId: string | null;
  serverIdentity?: string;
  turnIndex?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  resultPath?: string;
  error?: string;
  completionSeq?: number;
  notifiedAt?: string;
}

/** Agent-neutral view of the long-lived logical subagent a run belongs to. */
export interface SubagentSessionInfo {
  sessionId: string;
  agent: SubagentAgent;
  owner: string | null;
  cwd: string;
  status: SubagentSessionStatus;
  tmuxSessionId: string | null;
  serverIdentity?: string;
  agentSessionId?: string;
}

export interface SubagentLiveView {
  live: ReadonlySet<string>;
  serverIdentity?: string;
}

export interface CreateSubagentRunInput {
  agent: SubagentAgent;
  cwd: string;
  owner: string;
}

export interface BindSubagentRunInput {
  tmuxSessionId: string;
  tmuxPaneId: string;
  serverIdentity?: string;
}

export interface TransitionSubagentRunOptions {
  error?: string;
  exitCode?: number;
  resultPath?: string;
}

/**
 * Durable run/session store the controller drives. Two implementations exist:
 * the legacy `SubagentJobV1` ledger (one run == one job) and the issue #9
 * session/turn ledger (a session that persists across turns). The controller
 * only sees this interface, so adding an agent never requires copying tmux or
 * lifecycle logic.
 */
export interface SubagentLedger {
  readonly kind: "job" | "session";
  /** `respawn-pane` reuses one pane; `host-window` keeps a host session alive and adds a window per turn. */
  readonly tmuxStrategy: "respawn-pane" | "host-window";
  readonly file: string;

  /** One-shot ledgers create the run directly. */
  createRun?(input: CreateSubagentRunInput): Promise<SubagentRunRecord>;
  /** Session ledgers create the logical session, bind it, then create each turn. */
  createSession?(input: CreateSubagentRunInput): Promise<SubagentSessionInfo>;
  bindSession?(sessionId: string, input: { tmuxSessionId: string; serverIdentity?: string }, owner?: string): Promise<void>;
  createTurn?(sessionId: string, owner?: string): Promise<SubagentRunRecord>;
  getSession?(sessionId: string): Promise<SubagentSessionInfo | undefined>;
  stopSession?(sessionId: string, owner?: string): Promise<void>;
  /** Applies a legal session-status transition (session ledgers only). */
  transitionSession?(sessionId: string, status: SubagentSessionStatus, owner?: string): Promise<SubagentSessionInfo>;

  bindRun(runId: string, input: BindSubagentRunInput, owner?: string): Promise<SubagentRunRecord>;
  transitionRun(runId: string, status: SubagentRunStatus, options?: TransitionSubagentRunOptions, owner?: string): Promise<SubagentRunRecord>;
  cancelRun(runId: string, options?: { error?: string }, owner?: string): Promise<SubagentRunRecord>;
  /** Cancel exactly one turn, leaving its logical session reusable. Session ledgers only. */
  cancelTurn?(runId: string, options?: { error?: string }, owner?: string): Promise<SubagentRunRecord>;
  /** All turns of one logical session, oldest first. Session ledgers only. */
  listTurns?(sessionId: string): Promise<SubagentRunRecord[]>;
  getRun(runId: string): Promise<SubagentRunRecord | undefined>;
  reconcileRuns(view: SubagentLiveView, options?: { owner?: string }): Promise<SubagentRunRecord[]>;
}

export interface SubagentControllerOptions {
  tmux: Tmux;
  registry: Registry;
  targets: SubagentTargets;
  adapter: AgentAdapter;
  ledger: SubagentLedger;
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

export type SubagentFailureCode = TmuxError["code"];

export interface SubagentFailure {
  ok: false;
  code: SubagentFailureCode;
  error: string;
  runId?: string;
  sessionId?: string;
  status?: SubagentRunStatus;
  cleanedUp?: boolean;
}

export interface SubagentStartSuccess {
  ok: true;
  runId: string;
  sessionId: string;
  status: SubagentRunStatus;
  tmuxSessionId: string;
  tmuxPaneId: string;
  name: string;
  cwd: string;
  owner: string;
  turnIndex: number;
  serverIdentity?: string;
  /** Bounded, non-secret launch metadata from the adapter preflight (for example auth/billing risk). */
  metadata?: Readonly<Record<string, string>>;
}

export type SubagentStartResult = SubagentStartSuccess | SubagentFailure;

/** Adapter preflight values threaded through a launch: constant pane env plus non-secret metadata. */
type AgentPreflightEnv = { env: Record<string, string>; metadata?: Readonly<Record<string, string>> };

export type SubagentStatusResult =
  | { ok: true; run: SubagentRunRecord; targetLive?: boolean; reconciled: boolean; tmuxUnavailable?: boolean }
  | SubagentFailure;

export type SubagentCancelResult =
  | { ok: true; runId: string; status: SubagentRunStatus; alreadyTerminal: boolean; targetRemoved: boolean; reason: string }
  | SubagentFailure;

export interface SubagentCreateSuccess {
  ok: true;
  sessionId: string;
  agent: SubagentAgent;
  status: SubagentSessionStatus;
  tmuxSessionId: string;
  name: string;
  cwd: string;
  owner: string;
  serverIdentity?: string;
  /** Bounded, non-secret launch metadata from the adapter preflight (for example auth/billing risk). */
  metadata?: Readonly<Record<string, string>>;
}

export type SubagentCreateResult = SubagentCreateSuccess | SubagentFailure;

export type SubagentSessionStatusResult =
  | {
    ok: true;
    session: SubagentSessionInfo;
    turns: SubagentRunRecord[];
    turn?: SubagentRunRecord;
    activeTurnId?: string;
    reconciled: boolean;
    tmuxUnavailable?: boolean;
  }
  | SubagentFailure;

export type SubagentCancelTurnResult =
  | {
    ok: true;
    sessionId: string;
    turnId?: string;
    status: SubagentRunStatus;
    alreadyTerminal: boolean;
    targetRemoved: boolean;
    reason: string;
  }
  | SubagentFailure;

export type SubagentCloseResult =
  | { ok: true; sessionId: string; status: SubagentSessionStatus; alreadyClosed: boolean; targetRemoved: boolean; reason: string }
  | SubagentFailure;

export const DEFAULT_MAX_DEPTH = 8;
export const DEFAULT_STARTUP_PROBE = { attempts: 3, intervalMs: 150 } as const;
export const DEFAULT_PLACEHOLDER_COMMAND = "exec sleep 3600";

const MAX_TASK_BYTES = 20_000;
const MAX_NAME_LENGTH = 40;
const STABLE_SESSION = /^\$\d+$/;
const STABLE_PANE = /^%\d+$/;

export class SubagentController {
  private readonly tmux: Tmux;
  private readonly registry: Registry;
  private readonly targets: SubagentTargets;
  private readonly adapter: AgentAdapter;
  private readonly ledger: SubagentLedger;
  private readonly now: () => Date;
  private readonly startupProbe: { attempts: number; intervalMs: number };
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly maxDepth: number;

  constructor(options: SubagentControllerOptions) {
    this.tmux = options.tmux;
    this.registry = options.registry;
    this.targets = options.targets;
    this.adapter = options.adapter;
    this.ledger = options.ledger;
    this.now = options.now ?? (() => new Date());
    this.startupProbe = options.startupProbe ?? DEFAULT_STARTUP_PROBE;
    this.sleep = options.sleep ?? delay;
    this.env = options.env ?? process.env;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  get agent(): SubagentAgent {
    return this.adapter.agent;
  }

  get file(): string {
    return this.ledger.file;
  }

  /**
   * Creates and launches a subagent run (or one-shot job). Returns as soon as the
   * child is bound to its tmux target (after a short, bounded startup liveness
   * probe); it never waits for the child to finish.
   */
  async start(input: SubagentTurnOptions, owner: string, signal?: AbortSignal): Promise<SubagentStartResult> {
    const pre = await this.validateStart(input, owner);
    if (!pre.ok) return pre.failure;
    const { cwd, ancestors } = pre;

    if (this.ledger.tmuxStrategy === "respawn-pane") {
      return this.startRespawn(input, owner, cwd, ancestors, signal);
    }
    return this.startSession(input, owner, cwd, ancestors, signal);
  }

  /**
   * Executes another turn on an existing logical session (issue #9). Only
   * ledgers that declare the `host-window` strategy keep a session alive across
   * turns; a one-shot ledger rejects this with a structured error. Only one
   * active turn per session is allowed, and the durable registry enforces it.
   */
  async runTurn(sessionId: string, input: SubagentTurnOptions, owner: string, signal?: AbortSignal): Promise<SubagentStartResult> {
    if (this.ledger.tmuxStrategy !== "host-window" || !this.ledger.getSession || !this.ledger.createTurn || !this.ledger.bindRun) {
      return fail("invalid_option", "This agent does not support multiple turns on one session.");
    }
    const session = await this.ledger.getSession(sessionId).catch(() => undefined);
    if (!session) return fail("invalid_target", `Unknown subagent session ${JSON.stringify(sessionId)}.`);
    if (session.owner !== null && session.owner !== owner) {
      return fail("invalid_target", `Subagent session ${sessionId} belongs to another Pi conversation; refusing to control it.`);
    }
    const pre = this.validateCommon(input, owner);
    if (!pre.ok) return pre.failure;
    const { ancestors } = pre;
    // The working directory is the durable session's, never caller-supplied, so a
    // later turn cannot silently retarget the same logical session.
    const cwd = session.cwd;

    if (isTerminalSessionStatus(session.status)) {
      return fail("invalid_option", `Subagent session ${sessionId} is ${session.status}; it cannot start another turn.`);
    }
    if (session.tmuxSessionId === null) {
      return fail("invalid_option", `Subagent session ${sessionId} has no bound tmux target.`);
    }

    // Fail closed if the stable execution target is already gone: never point a
    // new turn at a reused or vanished ID.
    try {
      const view = await this.targets.liveTargets(signal);
      const identityLost = session.serverIdentity !== undefined
        && view.serverIdentity !== undefined
        && session.serverIdentity !== view.serverIdentity;
      if (identityLost || !view.live.has(session.tmuxSessionId)) {
        return fail("invalid_target", `Subagent session ${sessionId}'s tmux target no longer exists.`);
      }
    } catch (error) {
      return fail(codeOf(error), `Could not verify the subagent session target: ${errorMessage(error)}`);
    }

    const preflight = await this.adapter.preflight(input);
    if (!preflight.ok) return { ok: false, code: preflight.code, error: preflight.error, sessionId };

    let run: SubagentRunRecord;
    try {
      run = await this.ledger.createTurn(sessionId, owner);
    } catch (error) {
      return fail(codeOf(error), errorMessage(error), { sessionId });
    }

    const name = sessionName(input.name, sessionId, this.adapter.sessionNamePrefix ?? `${this.adapter.agent}-subagent`);
    return this.launchSessionTurn(run, session.tmuxSessionId, session.serverIdentity, input, owner, cwd, ancestors, preflight, name, session.agentSessionId, signal);
  }

  /**
   * Provisions a reusable logical session and its dedicated tmux execution
   * boundary without starting a turn. `create` and `run` are separate so a caller
   * can create a session once and then run several sequential turns. Only
   * multi-turn (`host-window`) ledgers support this.
   */
  async createSession(input: SubagentTurnOptions & { agent: SubagentAgent }, owner: string, signal?: AbortSignal): Promise<SubagentCreateResult> {
    if (this.ledger.kind !== "session" || this.ledger.tmuxStrategy !== "host-window" || !this.ledger.createSession || !this.ledger.bindSession || !this.ledger.getSession) {
      return fail("invalid_option", "This agent does not support reusable sessions.");
    }
    if (typeof owner !== "string" || !owner) return fail("invalid_option", "A non-empty parent Pi session id is required.");
    let cwd: string;
    try {
      cwd = await validateCwd(input?.cwd);
    } catch (error) {
      return fail(codeOf(error), errorMessage(error));
    }
    if (input.name !== undefined) {
      const nameError = validateSubagentName(input.name);
      if (nameError) return fail("invalid_option", nameError);
    }
    const optionsError = this.adapter.validateOptions?.(input);
    if (optionsError) return fail("invalid_option", optionsError);
    const ancestors = this.lineage();
    if (ancestors.length > this.maxDepth) {
      return fail("invalid_option", `Refusing to delegate: the subagent chain already has ${ancestors.length} jobs (max ${this.maxDepth}).`);
    }

    let created: SubagentSessionInfo;
    try {
      created = await this.ledger.createSession({ agent: input.agent ?? this.adapter.agent, cwd, owner });
    } catch (error) {
      return fail(codeOf(error), errorMessage(error));
    }

    const preflight = await this.adapter.preflight(input);
    if (!preflight.ok) {
      await this.ledger.stopSession?.(created.sessionId, owner).catch(() => undefined);
      return { ok: false, code: preflight.code, error: preflight.error, sessionId: created.sessionId };
    }

    let parentSessionId: string | null;
    try {
      parentSessionId = input.parent ? (await this.targets.session(input.parent, signal)).id : await detectParentSession(this.tmux, this.env, signal);
    } catch (error) {
      await this.ledger.stopSession?.(created.sessionId, owner).catch(() => undefined);
      return { ok: false, code: codeOf(error), error: `Could not resolve the parent tmux session: ${errorMessage(error)}`, sessionId: created.sessionId };
    }

    const name = sessionName(input.name, created.sessionId, this.adapter.sessionNamePrefix ?? `${this.adapter.agent}-subagent`);
    let tmuxSessionId: string;
    try {
      [tmuxSessionId] = await this.createInertSession(name, cwd, signal);
    } catch (error) {
      await this.ledger.stopSession?.(created.sessionId, owner).catch(() => undefined);
      return { ok: false, code: codeOf(error), error: `Could not create the subagent tmux session: ${errorMessage(error)}`, sessionId: created.sessionId, cleanedUp: true };
    }

    const serverIdentity = await this.serverIdentity();
    if (!serverIdentity) {
      const cleanedUp = await this.cleanupSession(tmuxSessionId, signal);
      await this.ledger.stopSession?.(created.sessionId, owner).catch(() => undefined);
      return {
        ok: false, code: "unavailable",
        error: "Could not determine the tmux server identity; refusing to create a subagent session that close could not verify. Check that the tmux server is reachable.",
        sessionId: created.sessionId, cleanedUp,
      };
    }

    await this.recordProvenance(tmuxSessionId, parentSessionId, name, cwd, owner, serverIdentity);

    try {
      await this.ledger.bindSession(created.sessionId, { tmuxSessionId, serverIdentity }, owner);
      await this.ledger.transitionSession?.(created.sessionId, "idle", owner);
    } catch (error) {
      const cleanedUp = await this.cleanupSession(tmuxSessionId, signal);
      await this.ledger.stopSession?.(created.sessionId, owner).catch(() => undefined);
      const message = `Could not bind the subagent session to its tmux target: ${errorMessage(error)}`;
      return { ok: false, code: codeOf(error), error: message, sessionId: created.sessionId, cleanedUp };
    }

    const bound = (await this.ledger.getSession(created.sessionId)) ?? created;
    return {
      ok: true,
      sessionId: created.sessionId,
      agent: bound.agent,
      status: bound.status,
      tmuxSessionId,
      name,
      cwd,
      owner,
      serverIdentity,
      ...(preflight.metadata ? { metadata: preflight.metadata } : {}),
    };
  }

  /**
   * Returns durable status for one logical session and (optionally) one turn.
   * When the tmux server is reachable, a vanished or re-identified target is
   * reconciled to `lost` through the same owner-scoped path as `status`, so pane
   * output is never used to infer lifecycle state.
   */
  async statusSession(sessionId: string, owner: string, options: { turnId?: string } = {}, signal?: AbortSignal): Promise<SubagentSessionStatusResult> {
    if (!this.ledger.getSession || !this.ledger.listTurns) return fail("invalid_option", "This agent does not support reusable sessions.");
    let session: SubagentSessionInfo | undefined;
    try {
      session = await this.ledger.getSession(sessionId);
    } catch (error) {
      return fail(codeOf(error), errorMessage(error), { sessionId });
    }
    if (!session) return fail("invalid_target", `Unknown subagent session ${JSON.stringify(sessionId)}.`, { sessionId });
    if (session.owner !== owner) return fail("invalid_target", `Subagent session ${sessionId} belongs to another Pi conversation; refusing to control it.`, { sessionId });

    let reconciled = false;
    let tmuxUnavailable = false;
    if (!isTerminalSessionStatus(session.status)) {
      try {
        const view = await this.targets.liveTargets(signal);
        await this.ledger.reconcileRuns(view, { owner });
        const refreshed = await this.ledger.getSession(sessionId);
        if (refreshed) {
          reconciled = refreshed.status !== session.status;
          session = refreshed;
        }
      } catch {
        tmuxUnavailable = true;
      }
    }

    const turns = await this.ledger.listTurns(sessionId);
    const active = turns.find((turn) => !isTerminalRunStatus(turn.status));
    let turn: SubagentRunRecord | undefined;
    if (options.turnId !== undefined) {
      turn = turns.find((item) => item.runId === options.turnId);
      if (!turn) return fail("invalid_target", `Unknown subagent turn ${JSON.stringify(options.turnId)} in session ${sessionId}.`, { sessionId });
    } else {
      turn = active ?? turns.at(-1);
    }
    return {
      ok: true,
      session,
      turns,
      ...(turn ? { turn } : {}),
      ...(active ? { activeTurnId: active.runId } : {}),
      reconciled,
      ...(tmuxUnavailable ? { tmuxUnavailable: true } : {}),
    };
  }

  /**
   * Cancels the active turn of a logical session (or one explicitly named turn)
   * without terminating the session. The turn's own pane/window is stopped only
   * when the exact pane is verified inside the exact recorded session on the exact
   * recorded tmux server; otherwise the turn is still cancelled but no target is
   * killed (fail closed). The session stays usable for another turn.
   */
  async cancelTurn(sessionId: string, owner: string, options: { turnId?: string } = {}, signal?: AbortSignal): Promise<SubagentCancelTurnResult> {
    if (!this.ledger.getSession || !this.ledger.listTurns || !this.ledger.cancelTurn) return fail("invalid_option", "This agent does not support reusable sessions.");
    const session = await this.ledger.getSession(sessionId).catch(() => undefined);
    if (!session) return fail("invalid_target", `Unknown subagent session ${JSON.stringify(sessionId)}.`, { sessionId });
    if (session.owner !== owner) return fail("invalid_target", `Subagent session ${sessionId} belongs to another Pi conversation; refusing to control it.`, { sessionId });

    const turns = await this.ledger.listTurns(sessionId);
    let turn: SubagentRunRecord | undefined;
    if (options.turnId !== undefined) {
      turn = turns.find((item) => item.runId === options.turnId);
      if (!turn) return fail("invalid_target", `Unknown subagent turn ${JSON.stringify(options.turnId)} in session ${sessionId}.`, { sessionId });
    } else {
      turn = turns.find((item) => !isTerminalRunStatus(item.status));
    }
    if (!turn) {
      return { ok: true, sessionId, status: "cancelled", alreadyTerminal: true, targetRemoved: false, reason: "No active turn to cancel." };
    }
    if (isTerminalRunStatus(turn.status)) {
      return { ok: true, sessionId, turnId: turn.runId, status: turn.status, alreadyTerminal: true, targetRemoved: false, reason: `Turn is already ${turn.status}.` };
    }

    const cancelled = await this.ledger.cancelTurn(turn.runId, {}, owner);
    const targetRemoved = await this.killVerifiedTurnPane(session, turn, signal);
    return {
      ok: true,
      sessionId,
      turnId: turn.runId,
      status: cancelled.status,
      alreadyTerminal: false,
      targetRemoved,
      reason: targetRemoved
        ? "Cancelled the turn and removed its verified pane."
        : "Cancelled the turn; its pane was not positively verified and was left untouched.",
    };
  }

  /**
   * Stops a logical session and tears down only its verified tmux session. Any
   * active turn is cancelled first. The tmux session is killed only when the
   * recorded server identity still matches and the stable session ID is still
   * live; otherwise the session is marked `stopped` but nothing is killed.
   */
  async closeSession(sessionId: string, owner: string, signal?: AbortSignal): Promise<SubagentCloseResult> {
    if (!this.ledger.getSession || !this.ledger.stopSession || !this.ledger.listTurns) return fail("invalid_option", "This agent does not support reusable sessions.");
    const session = await this.ledger.getSession(sessionId).catch(() => undefined);
    if (!session) return fail("invalid_target", `Unknown subagent session ${JSON.stringify(sessionId)}.`, { sessionId });
    if (session.owner !== owner) return fail("invalid_target", `Subagent session ${sessionId} belongs to another Pi conversation; refusing to control it.`, { sessionId });

    if (isTerminalSessionStatus(session.status)) {
      return { ok: true, sessionId, status: session.status, alreadyClosed: true, targetRemoved: false, reason: `Session is already ${session.status}.` };
    }

    // Cancel whatever turn is active so the session can enter a terminal status.
    const turns = await this.ledger.listTurns(sessionId);
    const active = turns.find((turn) => !isTerminalRunStatus(turn.status));
    if (active) {
      await this.ledger.cancelTurn?.(active.runId, { error: "Session closed by its owner." }, owner).catch(() => undefined);
    }

    await this.ledger.stopSession(sessionId, owner);
    const targetRemoved = await this.killVerifiedSession(session, signal);
    return {
      ok: true,
      sessionId,
      status: "stopped",
      alreadyClosed: false,
      targetRemoved,
      reason: targetRemoved
        ? "Stopped the session and killed its verified tmux session."
        : "Stopped the session; its tmux session was not positively verified and was left untouched.",
    };
  }

  /** Cancels one run's verified pane only, leaving a session-ledger target alive. */
  private async killVerifiedTurnPane(session: SubagentSessionInfo, turn: SubagentRunRecord, signal?: AbortSignal): Promise<boolean> {
    if (turn.tmuxPaneId === null || turn.tmuxSessionId === null || session.tmuxSessionId !== turn.tmuxSessionId) return false;
    let view: LiveTargets;
    let panes: PaneTarget[];
    try {
      view = await this.targets.liveTargets(signal);
      panes = await this.targets.panes(signal);
    } catch {
      return false;
    }
    if (!this.sameServer(session.serverIdentity, view.serverIdentity)) return false;
    const pane = panes.find((item) => item.id === turn.tmuxPaneId);
    if (!pane || pane.sessionId !== turn.tmuxSessionId) return false;
    try {
      await this.tmux.run(["kill-pane", "-t", turn.tmuxPaneId], { signal });
      return true;
    } catch {
      return false;
    }
  }

  /** Kills the whole session target when it is positively verified, else nothing. */
  private async killVerifiedSession(session: SubagentSessionInfo, signal?: AbortSignal): Promise<boolean> {
    if (session.tmuxSessionId === null) return false;
    let view: LiveTargets;
    try {
      view = await this.targets.liveTargets(signal);
    } catch {
      return false;
    }
    if (!this.sameServer(session.serverIdentity, view.serverIdentity) || !view.live.has(session.tmuxSessionId)) return false;
    try {
      await this.tmux.run(["kill-session", "-t", session.tmuxSessionId], { signal });
      await this.registry.forget("session", session.tmuxSessionId).catch(() => 0);
      return true;
    } catch {
      return false;
    }
  }

  private sameServer(recorded: string | undefined, live: string | undefined): boolean {
    return recorded !== undefined && live !== undefined && recorded === live;
  }

  /**
   * Returns durable run state. When the tmux server is reachable, a bound
   * non-terminal run whose target vanished (or belongs to another server) is
   * reconciled to `lost`, scoped to this owner so another parent's records are
   * never touched. No pane text is ever inspected.
   */
  async status(runId: string, owner: string, signal?: AbortSignal): Promise<SubagentStatusResult> {
    const found = await this.lookup(runId, owner);
    if ("ok" in found) return found;
    const run = found;
    if (isTerminalRunStatus(run.status)) return { ok: true, run, reconciled: false };

    let view: LiveTargets | undefined;
    try {
      view = await this.targets.liveTargets(signal);
    } catch {
      return { ok: true, run, reconciled: false, tmuxUnavailable: true };
    }

    try {
      await this.ledger.reconcileRuns(view, { owner });
    } catch {
      /* A reconciliation failure is not a status failure; report the durable state. */
    }
    const updated = (await this.ledger.getRun(runId).catch(() => undefined)) ?? run;
    const targetLive = updated.tmuxPaneId !== null && view.live.has(updated.tmuxPaneId);
    return { ok: true, run: updated, targetLive, reconciled: updated.status !== run.status };
  }

  /**
   * Cancels exactly one run. The run is moved to `cancelled`, and the recorded
   * tmux session is killed **only** when the exact recorded pane is present in
   * the exact recorded session on the exact recorded tmux server. Unknown or
   * mismatched identity fails closed rather than risk killing a reused ID. A
   * terminal run is returned unchanged, so cancellation is idempotent.
   */
  async cancel(runId: string, owner: string, signal?: AbortSignal): Promise<SubagentCancelResult> {
    const found = await this.lookup(runId, owner);
    if ("ok" in found) return found;
    const run = found;

    if (isTerminalRunStatus(run.status)) {
      return { ok: true, runId: run.runId, status: run.status, alreadyTerminal: true, targetRemoved: false, reason: `Run is already ${run.status}.` };
    }
    if (run.tmuxSessionId === null || run.tmuxPaneId === null) {
      const cancelled = await this.ledger.cancelRun(run.runId, { error: "Cancelled before a tmux target was bound." }, owner);
      return { ok: true, runId: run.runId, status: cancelled.status, alreadyTerminal: false, targetRemoved: false, reason: "No tmux target was bound." };
    }

    let view: LiveTargets | undefined;
    let panes: PaneTarget[];
    try {
      view = await this.targets.liveTargets(signal);
      panes = await this.targets.panes(signal);
    } catch (error) {
      const cancelled = await this.ledger.cancelRun(run.runId, { error: `Cancelled while the tmux server was unavailable (${errorMessage(error)}); the recorded target was not terminated.` }, owner);
      return { ok: true, runId: run.runId, status: cancelled.status, alreadyTerminal: false, targetRemoved: false, reason: "tmux server unavailable; recorded target left untouched." };
    }

    const identityVerified = run.serverIdentity !== undefined
      && view.serverIdentity !== undefined
      && run.serverIdentity === view.serverIdentity;
    const pane = panes.find((item) => item.id === run.tmuxPaneId);
    const paneVerified = pane !== undefined && pane.sessionId === run.tmuxSessionId;
    const canKill = identityVerified && paneVerified;

    const cancelled = await this.ledger.cancelRun(run.runId, undefined, owner);
    if (!canKill) {
      const reason = !identityVerified
        ? (run.serverIdentity === undefined
          ? "Refusing to kill: the run has no recorded tmux server identity, so the target cannot be verified."
          : view.serverIdentity === undefined
            ? "Refusing to kill: the current tmux server identity is unavailable, so the target cannot be verified."
            : `Refusing to kill: the run's target belonged to tmux server ${run.serverIdentity} but the current server is ${view.serverIdentity}.`)
        : pane === undefined
          ? `Refusing to kill: the recorded pane ${run.tmuxPaneId} is not present; its stable ID may have been reused.`
          : `Refusing to kill: pane ${run.tmuxPaneId} now belongs to session ${pane.sessionId}, not the recorded ${run.tmuxSessionId}.`;
      return { ok: true, runId: run.runId, status: cancelled.status, alreadyTerminal: false, targetRemoved: false, reason };
    }

    await this.tmux.run(["kill-session", "-t", run.tmuxSessionId], { signal });
    await this.registry.forget("session", run.tmuxSessionId).catch(() => 0);
    return { ok: true, runId: run.runId, status: cancelled.status, alreadyTerminal: false, targetRemoved: true, reason: "Killed the verified recorded tmux session." };
  }

  // --- shared start machinery -------------------------------------------------

  private async validateStart(input: SubagentTurnOptions, owner: string): Promise<
    | { ok: true; cwd: string; ancestors: string[] }
    | { ok: false; failure: SubagentFailure }
  > {
    let cwd: string;
    try {
      cwd = await validateCwd(input?.cwd);
    } catch (error) {
      return { ok: false, failure: fail(codeOf(error), errorMessage(error)) };
    }
    const common = this.validateCommon(input, owner);
    if (!common.ok) return common;
    return { ok: true, cwd, ancestors: common.ancestors };
  }

  /**
   * Validates the agent-neutral turn inputs that are independent of a working
   * directory. Used by `runTurn`, where the cwd comes from the durable session
   * rather than from the caller.
   */
  private validateCommon(input: SubagentTurnOptions, owner: string): { ok: true; ancestors: string[] } | { ok: false; failure: SubagentFailure } {
    if (typeof owner !== "string" || !owner) {
      return { ok: false, failure: fail("invalid_option", "A non-empty parent Pi session id is required.") };
    }
    const taskError = validateTask(input?.task);
    if (taskError) return { ok: false, failure: fail("invalid_option", taskError) };
    if (input.name !== undefined) {
      const nameError = validateSubagentName(input.name);
      if (nameError) return { ok: false, failure: fail("invalid_option", nameError) };
    }
    const optionsError = this.adapter.validateOptions?.(input);
    if (optionsError) return { ok: false, failure: fail("invalid_option", optionsError) };
    const ancestors = this.lineage();
    if (ancestors.length > this.maxDepth) {
      return { ok: false, failure: fail("invalid_option", `Refusing to delegate: the subagent chain already has ${ancestors.length} jobs (max ${this.maxDepth}).`) };
    }
    return { ok: true, ancestors };
  }

  private lineage(): string[] {
    if (!this.adapter.lineage) return [];
    try {
      return this.adapter.lineage(this.env);
    } catch {
      return [];
    }
  }

  private async startRespawn(input: SubagentTurnOptions, owner: string, cwd: string, ancestors: string[], signal?: AbortSignal): Promise<SubagentStartResult> {
    if (!this.ledger.createRun) return fail("invalid_option", "This ledger cannot create a run.");
    let run: SubagentRunRecord;
    try {
      run = await this.ledger.createRun({ agent: this.adapter.agent, cwd, owner });
    } catch (error) {
      return fail(codeOf(error), errorMessage(error));
    }

    const preflight = await this.adapter.preflight(input);
    if (!preflight.ok) return this.startFailure(run.runId, preflight.code, preflight.error);

    let parentSessionId: string | null;
    try {
      parentSessionId = input.parent ? (await this.targets.session(input.parent, signal)).id : await detectParentSession(this.tmux, this.env, signal);
    } catch (error) {
      return this.startFailure(run.runId, codeOf(error), `Could not resolve the parent tmux session: ${errorMessage(error)}`);
    }

    const name = sessionName(input.name, run.runId, this.adapter.sessionNamePrefix ?? `${this.adapter.agent}-subagent`);
    let sessionId: string;
    let paneId: string;
    try {
      [sessionId, paneId] = await this.createInertSession(name, cwd, signal);
    } catch (error) {
      await this.failRun(run.runId, `Could not create the subagent tmux session: ${errorMessage(error)}`);
      return { ok: false, code: codeOf(error), error: `Could not create the subagent tmux session: ${errorMessage(error)}`, runId: run.runId, status: "failed", cleanedUp: true };
    }

    const serverIdentity = await this.serverIdentity();
    if (!serverIdentity) {
      const cleanedUp = await this.cleanupSession(sessionId, signal);
      const message = "Could not determine the tmux server identity; refusing to launch a subagent that cancel could not verify. Check that the tmux server is reachable.";
      await this.failRun(run.runId, message);
      return { ok: false, code: "unavailable", error: message, runId: run.runId, status: "failed", cleanedUp };
    }

    await this.recordProvenance(sessionId, parentSessionId, name, cwd, owner, serverIdentity);
    try {
      await this.ledger.bindRun(run.runId, { tmuxSessionId: sessionId, tmuxPaneId: paneId, serverIdentity }, owner);
      await this.ledger.transitionRun(run.runId, "starting", undefined, owner);
    } catch (error) {
      const cleanedUp = await this.cleanupSession(sessionId, signal);
      const message = `Could not bind the subagent run to its tmux target: ${errorMessage(error)}`;
      await this.failRun(run.runId, message);
      return { ok: false, code: codeOf(error), error: message, runId: run.runId, status: "failed", cleanedUp };
    }

    return this.launchBound(run, sessionId, paneId, input, owner, cwd, ancestors, preflight, name, undefined, serverIdentity, signal);
  }

  private async startSession(input: SubagentTurnOptions, owner: string, cwd: string, ancestors: string[], signal?: AbortSignal): Promise<SubagentStartResult> {
    if (!this.ledger.createSession || !this.ledger.createTurn) return fail("invalid_option", "This ledger cannot create a session.");

    let session: SubagentSessionInfo;
    try {
      session = await this.ledger.createSession({ agent: this.adapter.agent, cwd, owner });
    } catch (error) {
      return fail(codeOf(error), errorMessage(error));
    }

    const preflight = await this.adapter.preflight(input);
    if (!preflight.ok) {
      await this.ledger.stopSession?.(session.sessionId, owner).catch(() => undefined);
      return { ok: false, code: preflight.code, error: preflight.error, sessionId: session.sessionId };
    }

    let parentSessionId: string | null;
    try {
      parentSessionId = input.parent ? (await this.targets.session(input.parent, signal)).id : await detectParentSession(this.tmux, this.env, signal);
    } catch (error) {
      await this.ledger.stopSession?.(session.sessionId, owner).catch(() => undefined);
      return { ok: false, code: codeOf(error), error: `Could not resolve the parent tmux session: ${errorMessage(error)}`, sessionId: session.sessionId };
    }

    const name = sessionName(input.name, session.sessionId, this.adapter.sessionNamePrefix ?? `${this.adapter.agent}-subagent`);
    let tmuxSessionId: string;
    try {
      [tmuxSessionId] = await this.createInertSession(name, cwd, signal);
    } catch (error) {
      await this.ledger.stopSession?.(session.sessionId, owner).catch(() => undefined);
      return { ok: false, code: codeOf(error), error: `Could not create the subagent tmux session: ${errorMessage(error)}`, sessionId: session.sessionId, cleanedUp: true };
    }

    const serverIdentity = await this.serverIdentity();
    if (!serverIdentity) {
      const cleanedUp = await this.cleanupSession(tmuxSessionId, signal);
      await this.ledger.stopSession?.(session.sessionId, owner).catch(() => undefined);
      return {
        ok: false, code: "unavailable",
        error: "Could not determine the tmux server identity; refusing to launch a subagent that cancel could not verify. Check that the tmux server is reachable.",
        sessionId: session.sessionId, cleanedUp,
      };
    }

    await this.recordProvenance(tmuxSessionId, parentSessionId, name, cwd, owner, serverIdentity);

    let run: SubagentRunRecord;
    try {
      await this.ledger.bindSession!(session.sessionId, { tmuxSessionId, serverIdentity }, owner);
      run = await this.ledger.createTurn(session.sessionId, owner);
    } catch (error) {
      const cleanedUp = await this.cleanupSession(tmuxSessionId, signal);
      await this.ledger.stopSession?.(session.sessionId, owner).catch(() => undefined);
      const message = `Could not bind the subagent session to its tmux target: ${errorMessage(error)}`;
      return { ok: false, code: codeOf(error), error: message, sessionId: session.sessionId, cleanedUp };
    }

    return this.launchSessionTurn(run, tmuxSessionId, serverIdentity, input, owner, cwd, ancestors, preflight, name, session.agentSessionId, signal);
  }

  /** Provisions a brand-new window/pane for an already-created turn and launches it. */
  private async launchSessionTurn(
    run: SubagentRunRecord,
    tmuxSessionId: string,
    serverIdentity: string | undefined,
    input: SubagentTurnOptions,
    owner: string,
    cwd: string,
    ancestors: string[],
    preflight: AgentPreflightEnv,
    name: string,
    agentSessionId: string | undefined,
    signal?: AbortSignal,
  ): Promise<SubagentStartResult> {
    let paneId: string;
    try {
      paneId = await this.createTurnWindow(tmuxSessionId, signal);
    } catch (error) {
      const cleanedUp = await this.cleanupSession(tmuxSessionId, signal);
      await this.failRun(run.runId, `Could not open a subagent turn pane: ${errorMessage(error)}`);
      return { ok: false, code: codeOf(error), error: `Could not open a subagent turn pane: ${errorMessage(error)}`, runId: run.runId, status: "failed", cleanedUp };
    }

    try {
      await this.ledger.bindRun(run.runId, { tmuxSessionId, tmuxPaneId: paneId, serverIdentity }, owner);
      await this.ledger.transitionRun(run.runId, "starting", undefined, owner);
    } catch (error) {
      const cleanedUp = await this.cleanupSession(tmuxSessionId, signal);
      const message = `Could not bind the subagent turn to its tmux target: ${errorMessage(error)}`;
      await this.failRun(run.runId, message);
      return { ok: false, code: codeOf(error), error: message, runId: run.runId, status: "failed", cleanedUp };
    }

    return this.launchBound(run, tmuxSessionId, paneId, input, owner, cwd, ancestors, preflight, name, agentSessionId, serverIdentity, signal);
  }

  /** Shared launch + bounded startup probe once a run is durably bound and `starting`. */
  private async launchBound(
    run: SubagentRunRecord,
    tmuxSessionId: string,
    paneId: string,
    input: SubagentTurnOptions,
    owner: string,
    cwd: string,
    ancestors: string[],
    preflight: AgentPreflightEnv,
    name: string,
    agentSessionId: string | undefined,
    serverIdentity: string | undefined,
    signal?: AbortSignal,
  ): Promise<SubagentStartResult> {
    let command: string;
    let env: Record<string, string>;
    try {
      const context: AgentTurnContext = {
        agent: this.adapter.agent,
        owner,
        statePath: this.ledger.file,
        runId: run.runId,
        sessionId: run.sessionId,
        ledgerKind: this.ledger.kind,
        turnIndex: run.turnIndex ?? 1,
        ...(agentSessionId !== undefined ? { agentSessionId } : {}),
        ancestors,
        preflight: preflight.env,
        env: this.env,
        signal,
      };
      const spec = await this.adapter.prepareTurn(input, context);
      command = spec.command;
      env = { ...preflight.env, ...spec.env };
    } catch (error) {
      const cleanedUp = await this.cleanupSession(tmuxSessionId, signal);
      const message = `Could not prepare the child launch: ${errorMessage(error)}`;
      await this.failRun(run.runId, message);
      return { ok: false, code: codeOf(error), error: message, runId: run.runId, status: "failed", cleanedUp };
    }

    const launchArgs = [
      "respawn-pane", "-k", "-t", paneId,
      ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      command,
    ];
    try {
      await this.tmux.run(launchArgs, { signal });
    } catch (error) {
      const cleanedUp = await this.cleanupSession(tmuxSessionId, signal);
      const message = `Could not start the child ${this.adapter.agent} process: ${errorMessage(error)}`;
      await this.failRun(run.runId, message);
      return { ok: false, code: codeOf(error), error: message, runId: run.runId, status: "failed", cleanedUp };
    }

    const alive = await this.probeStartup(paneId, signal);
    if (!alive) {
      const current = await this.ledger.getRun(run.runId).catch(() => undefined);
      if (current && isTerminalRunStatus(current.status)) {
        if (current.status === "completed") {
          return {
            ok: true,
            runId: run.runId,
            sessionId: run.sessionId,
            status: "completed",
            tmuxSessionId,
            tmuxPaneId: paneId,
            name,
            cwd,
            owner,
            turnIndex: run.turnIndex ?? 1,
            serverIdentity,
            ...(preflight.metadata ? { metadata: preflight.metadata } : {}),
          };
        }
        return {
          ok: false,
          code: current.status === "cancelled" ? "cancelled" : "command_failed",
          error: `The subagent run reached ${current.status} during startup.`,
          runId: run.runId,
          sessionId: run.sessionId,
          status: current.status,
        };
      }
      await this.cleanupSession(tmuxSessionId, signal);
      const message = `The child ${this.adapter.agent} process exited during startup; the tmux session was cleaned up.`;
      await this.failRun(run.runId, message);
      return { ok: false, code: "command_failed", error: message, runId: run.runId, sessionId: run.sessionId, status: "failed", cleanedUp: true };
    }

    return {
      ok: true,
      runId: run.runId,
      sessionId: run.sessionId,
      status: "starting",
      tmuxSessionId,
      tmuxPaneId: paneId,
      name,
      cwd,
      owner,
      turnIndex: run.turnIndex ?? 1,
      serverIdentity,
      ...(preflight.metadata ? { metadata: preflight.metadata } : {}),
    };
  }

  private async createInertSession(name: string, cwd: string, signal?: AbortSignal): Promise<[string, string]> {
    const args = [
      "new-session", "-d", "-P", "-F", "#{session_id}\t#{pane_id}",
      "-s", name,
      "-c", cwd,
      this.placeholderCommand,
    ];
    const [sessionId, paneId] = singleRow(await this.tmux.run(args, { signal }), 2);
    if (!sessionId || !STABLE_SESSION.test(sessionId) || !paneId || !STABLE_PANE.test(paneId)) {
      throw new TmuxError("tmux created a session but returned an invalid stable ID.", "command_failed");
    }
    return [sessionId, paneId];
  }

  private async createTurnWindow(sessionId: string, signal?: AbortSignal): Promise<string> {
    const output = await this.tmux.run(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", sessionId, this.placeholderCommand], { signal });
    const paneId = singleRow(output, 1)[0];
    if (!paneId || !STABLE_PANE.test(paneId)) {
      throw new TmuxError("tmux created a window but returned an invalid stable pane ID.", "command_failed");
    }
    return paneId;
  }

  private get placeholderCommand(): string {
    return this.adapter.placeholderCommand ?? DEFAULT_PLACEHOLDER_COMMAND;
  }

  private async serverIdentity(signal?: AbortSignal): Promise<string | undefined> {
    try {
      return await this.targets.serverIdentity(signal);
    } catch {
      return undefined;
    }
  }

  private async lookup(runId: string, owner: string): Promise<SubagentRunRecord | SubagentFailure> {
    if (typeof runId !== "string" || !runId) return fail("invalid_option", "A non-empty runId is required.");
    let run: SubagentRunRecord | undefined;
    try {
      run = await this.ledger.getRun(runId);
    } catch (error) {
      return fail(codeOf(error), errorMessage(error));
    }
    if (!run) return fail("invalid_target", `Unknown subagent run ${JSON.stringify(runId)}.`, { runId });
    if (run.owner !== owner) {
      return fail("invalid_target", `Subagent run ${runId} belongs to another Pi conversation; refusing to control it.`, { runId });
    }
    return run;
  }

  private async recordProvenance(sessionId: string, parentSessionId: string | null, name: string, cwd: string, owner: string, serverIdentity: string | undefined): Promise<void> {
    try {
      await this.registry.record({
        kind: "session",
        id: sessionId,
        sessionId,
        parentSessionId,
        piSessionId: owner,
        name,
        cwd,
        tool: this.adapter.provenanceTool ?? `tmux_subagent_start_${this.adapter.agent}`,
        createdAt: this.now().toISOString(),
        ...(serverIdentity ? { serverIdentity } : {}),
      });
    } catch {
      /* Provenance is best-effort; the durable run below is authoritative. */
    }
  }

  private async cleanupSession(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    let removed = false;
    try {
      await this.tmux.run(["kill-session", "-t", sessionId], { signal });
      removed = true;
    } catch {
      removed = false;
    }
    await this.registry.forget("session", sessionId).catch(() => 0);
    return removed;
  }

  private async startFailure(runId: string, code: SubagentFailureCode, error: string): Promise<SubagentFailure> {
    await this.failRun(runId, error);
    return { ok: false, code, error, runId, status: "failed" };
  }

  private async failRun(runId: string, error: string): Promise<void> {
    try {
      const run = await this.ledger.getRun(runId);
      if (run && !isTerminalRunStatus(run.status)) await this.ledger.transitionRun(runId, "failed", { error }).catch(() => undefined);
    } catch {
      /* Best effort: the run may already be terminal. */
    }
  }

  private async probeStartup(paneId: string, signal?: AbortSignal): Promise<boolean> {
    const { attempts, intervalMs } = this.startupProbe;
    if (!Number.isInteger(attempts) || attempts <= 0) return true;
    for (let count = 0; count < attempts; count++) {
      await this.sleep(intervalMs);
      if (signal?.aborted) return true; // Never tear down a session on a cancelled status check.
      try {
        const view = await this.targets.liveTargets(signal);
        if (view.live.has(paneId)) return true;
      } catch {
        return true; // An unreachable server is not evidence the child died.
      }
    }
    return false;
  }
}

/** Detects the tmux session the calling agent runs inside, when tmux reports it. */
export async function detectParentSession(tmux: Tmux, env: { TMUX?: string; TMUX_PANE?: string } = process.env, signal?: AbortSignal): Promise<string | null> {
  const pane = env.TMUX_PANE;
  if (!pane) return null;
  try {
    const serverPid = singleLine(await tmux.run(["display-message", "-p", "#{pid}"], { signal }));
    if (!env.TMUX || env.TMUX.split(",")[1] !== serverPid) return null;
    const id = singleLine(await tmux.run(["display-message", "-p", "-t", pane, "#{session_id}"], { signal }));
    return /^\$\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * PATH lookup used by adapters. Returns an executable path, or `undefined` when
 * the command cannot be found. Never uses a shell.
 */
export async function resolveExecutable(command: string, pathEnv = process.env.PATH ?? ""): Promise<string | undefined> {
  if (!command || command.includes("\0")) return undefined;
  if (command.includes("/") || command.includes(path.sep)) {
    return (await isExecutable(command)) ? command : undefined;
  }
  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export function sessionName(name: string | undefined, id: string, prefix: string): string {
  const base = (name ?? "").trim().replace(/[\s.:]+/g, "-").replace(/[^A-Za-z0-9_-]/g, "").replace(/^-+|-+$/g, "").slice(0, MAX_NAME_LENGTH);
  return `${base || prefix}-${id.slice(0, 8)}`;
}

export function validateSubagentName(name: unknown): string | undefined {
  if (typeof name !== "string" || !name.trim() || name !== name.trim() || /[\x00-\x1f\x7f]/.test(name)) {
    return "name must be a non-empty trimmed string without control characters.";
  }
  if (name.length > 64) return "name must be at most 64 characters.";
  return undefined;
}

export function validateTask(task: unknown): string | undefined {
  if (typeof task !== "string" || !task.trim()) return "task must be a non-empty string.";
  if (task.includes("\0")) return "task must not contain NUL bytes.";
  if (Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES) return `task must be at most ${MAX_TASK_BYTES} bytes.`;
  return undefined;
}

export async function validateCwd(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new TmuxError("cwd must be a non-empty path.", "invalid_option");
  if (!path.isAbsolute(value)) throw new TmuxError(`cwd must be an absolute path; received ${JSON.stringify(value)}.`, "invalid_option");
  let absolute: string;
  try {
    absolute = await realpath(value);
    if (!(await stat(absolute)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new TmuxError(`cwd ${JSON.stringify(value)} does not exist or is not a directory.`, "invalid_option");
  }
  return absolute;
}

/** Parses a bounded, de-duplicated lineage list, dropping NUL/oversized tokens. */
export function parseAncestorList(raw: string | undefined): string[] {
  if (typeof raw !== "string" || !raw) return [];
  const seen = new Set<string>();
  const ancestors: string[] = [];
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token || token.includes("\0") || Buffer.byteLength(token, "utf8") > 512) continue;
    if (!seen.has(token)) {
      seen.add(token);
      ancestors.push(token);
    }
  }
  return ancestors;
}

export async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function singleLine(output: string): string {
  const lines = output.trim().split(/\r?\n/);
  if (lines.length !== 1 || !lines[0]) throw new TmuxError("tmux returned unexpected output.", "command_failed");
  return lines[0];
}

function singleRow(output: string, columns: number): (string | undefined)[] {
  const fields = singleLine(output).split("\t");
  if (fields.length !== columns) throw new TmuxError("tmux returned unexpected output for a created target.", "command_failed");
  return fields;
}

function fail(code: SubagentFailureCode, error: string, extra: { runId?: string; sessionId?: string } = {}): SubagentFailure {
  return { ok: false, code, error, ...extra };
}

function codeOf(error: unknown): SubagentFailureCode {
  return error instanceof TmuxError ? error.code : "command_failed";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
