import type { TmuxError } from "./tmux.ts";
import type { SubagentAgent } from "./subagent-sessions.ts";

/**
 * Agent adapter boundary (issue #10).
 *
 * The generic subagent controller owns everything that must behave identically
 * for every agent: the inert startup gate, stable tmux binding, server
 * identity/provenance, durable lifecycle transitions, liveness reconciliation,
 * and fail-closed cancellation. An adapter only describes *how one agent is
 * launched* and *how its completion is observed*.
 *
 * Two rules keep the boundary honest:
 *
 * - The task text is never shell-interpolated. The adapter returns a constant
 *   `command` string that references environment variables inside double quotes;
 *   the task travels only as a tmux environment value.
 * - The controller never branches on the agent name. It looks up one adapter and
 *   dispatches; all agent-specific executable/argument/environment decisions
 *   live in the adapter.
 */

/** Generic, adapter-independent options for one subagent turn. */
export interface SubagentTurnOptions {
  /** Absolute, existing working directory for the child. */
  cwd: string;
  /** Bounded task/prompt delivered verbatim. */
  task: string;
  /** Optional human-readable name used for the dedicated tmux session. */
  name?: string;
  /** Optional tmux session the child is being delegated for (provenance only). */
  parent?: string;
  /** Optional adapter-specific model selection (validated by the adapter). */
  model?: string;
  /** Optional adapter-specific thinking/reasoning level (validated by the adapter). */
  thinking?: string;
}

/** Everything an adapter needs to build a launch spec for one turn. */
export interface AgentTurnContext {
  agent: SubagentAgent;
  /** The owning Pi conversation; never another parent's session. */
  owner: string;
  /** Durable registry file the child reporter must write to (`statePath`). */
  statePath: string;
  /** Durable run/turn identifier for this turn. */
  runId: string;
  /** Durable logical session identifier (equals `runId` for one-shot agents). */
  sessionId: string;
  /**
   * Which durable ledger backs this run. A one-shot `job` run and a multi-turn
   * `session` turn share the launch contract but report completion differently,
   * so an adapter (for example `PiAdapter`) needs to know which it is to emit the
   * matching child-reporter metadata. Absent is treated as `"job"`.
   */
  ledgerKind?: "job" | "session";
  /** 1-based index of this turn within the logical session. */
  turnIndex: number;
  /**
   * Native conversation id the logical session already recorded (for example a
   * Claude Code `session_id`), or `undefined` before the first successful turn.
   * An adapter that resumes a conversation reads it here; it stays out of argv
   * until the adapter validates it.
   */
  agentSessionId?: string;
  /** Comma-free lineage of durable run ids already active above this child. */
  ancestors: string[];
  /** Resolved values from `preflight` (for example a resolved executable path). */
  preflight: Readonly<Record<string, string>>;
  /** This process's environment, for carrying its own lineage forward. */
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/**
 * Result of adapter preflight. `env` holds values that are constant across every
 * turn of a launch (a resolved executable path, a packaged reporter path).
 * A failing preflight is reported as a structured value, never a thrown error,
 * so the controller can record it on the durable record before any tmux effect.
 */
export type AgentPreflightResult =
  | {
      ok: true;
      env: Record<string, string>;
      /**
       * Bounded, non-secret launch metadata a caller may surface (for example an
       * auth/billing risk flag). Never put credentials or their values here.
       */
      metadata?: Readonly<Record<string, string>>;
    }
  | { ok: false; code: TmuxError["code"]; error: string };

/** How the parent learns that a turn reached a terminal outcome. */
export type AgentCompletionStrategy =
  | { strategy: "native-reporter" }
  | { strategy: "runner" };

/**
 * The constant command plus environment tmux applies for one turn. `command`
 * must only reference constants and quoted environment variables; it must never
 * contain the task or any other caller-provided text.
 */
export interface AgentLaunchSpec {
  /** Constant shell command tmux runs; no caller-provided text is interpolated. */
  command: string;
  /** Environment values set on the pane before the command runs. */
  env: Record<string, string>;
  completion: AgentCompletionStrategy;
}

export interface AgentAdapter {
  readonly agent: SubagentAgent;

  /** Prefix for the dedicated tmux session name (default `${agent}-subagent`). */
  readonly sessionNamePrefix?: string;
  /** Provenance registry `tool` recorded for a session this adapter launched. */
  readonly provenanceTool?: string;
  /** Inert command used during the startup gate (default `exec sleep 3600`). */
  readonly placeholderCommand?: string;

  /**
   * Runtime-generic recursion metadata: the lineage of durable run ids already
   * active above this process, read from the environment it inherited. Optional.
   */
  lineage?(env: NodeJS.ProcessEnv): string[];

  /**
   * Adapter-specific option validation that must run before any durable record
   * is created (for example a malformed model selector). Returns an error
   * message, or `undefined` when the options are valid.
   */
  validateOptions?(input: SubagentTurnOptions): string | undefined;

  /**
   * Agent-specific option validation and executable/reporter resolution. Runs
   * before the controller creates any tmux target. Returns a structured failure
   * (never throws) so a bad launch is recorded durably.
   */
  preflight(input: SubagentTurnOptions): Promise<AgentPreflightResult>;

  /**
   * Builds the constant launch command and per-turn environment for one turn.
   * MUST NOT interpolate caller text; carry the task as an environment value.
   */
  prepareTurn(input: SubagentTurnOptions, context: AgentTurnContext): Promise<AgentLaunchSpec>;
}

/**
 * Adapter lookup used by a multi-agent controller. Lookup/dispatch is the only
 * place an agent name may select behavior.
 */
export class AgentAdapterRegistry {
  private readonly adapters = new Map<SubagentAgent, AgentAdapter>();

  constructor(adapters: readonly AgentAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: AgentAdapter): void {
    if (!adapter || typeof adapter.agent !== "string") throw new Error("An agent adapter must declare its agent.");
    this.adapters.set(adapter.agent, adapter);
  }

  get(agent: SubagentAgent): AgentAdapter | undefined {
    return this.adapters.get(agent);
  }

  require(agent: SubagentAgent): AgentAdapter {
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new Error(`No adapter is registered for agent ${JSON.stringify(agent)}.`);
    return adapter;
  }
}
