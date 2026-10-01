import type { AgentAdapterRegistry } from "./agent-adapter.ts";
import type { Registry } from "./registry.ts";
import { SessionSubagentLedger } from "./subagent-ledgers.ts";
import type { SubagentAgent, SubagentSessionMode } from "./subagent-sessions.ts";
import { SubagentSessionRegistry } from "./subagent-sessions.ts";
import {
  type SubagentCancelTurnResult,
  type SubagentCloseResult,
  type SubagentCreateResult,
  type SubagentFailure,
  type SubagentSessionStatusResult,
  type SubagentStartResult,
  type SubagentTargets,
  SubagentController,
} from "./subagent-controller.ts";
import type { Tmux } from "./tmux.ts";

/**
 * Agent-neutral, owner-scoped facade over the generic `SubagentController` for
 * reusable logical subagent sessions (issue #12).
 *
 * One `SubagentController` is created per registered agent, all sharing the same
 * durable `SubagentSessionV1`/`SubagentTurnV1` registry and tmux server. An agent
 * is looked up only at dispatch time, so adding a CLI agent is a matter of
 * registering an adapter — never a new tool family.
 */

export interface SubagentCreateInput {
  agent: SubagentAgent;
  cwd: string;
  name?: string;
  parent?: string;
  model?: string;
  thinking?: string;
  /** `turns` (default) creates a reusable structured-turn session; `interactive` launches the agent TUI. */
  mode?: SubagentSessionMode;
}

export interface SubagentRunInput {
  task: string;
  model?: string;
  thinking?: string;
}

export interface GenericSubagentOptions {
  tmux: Tmux;
  registry: Registry;
  targets: SubagentTargets;
  sessions: SubagentSessionRegistry;
  adapters: AgentAdapterRegistry;
  now?: () => Date;
  startupProbe?: { attempts: number; intervalMs: number };
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  maxDepth?: number;
}

export class GenericSubagentController {
  private readonly controllers = new Map<SubagentAgent, SubagentController>();

  constructor(private readonly options: GenericSubagentOptions) {}

  /** Creates a reusable logical session and its tmux boundary, without a turn. */
  async create(input: SubagentCreateInput, owner: string, signal?: AbortSignal): Promise<SubagentCreateResult> {
    const adapter = this.options.adapters.get(input?.agent);
    if (!adapter) return fail("invalid_option", `No adapter is registered for agent ${JSON.stringify(input?.agent)}.`);
    const controller = this.controllerFor(adapter.agent);
    if (!controller) return fail("invalid_option", `No adapter is registered for agent ${JSON.stringify(input?.agent)}.`);
    const mode = input.mode ?? "turns";
    if (mode !== "turns" && mode !== "interactive") {
      return fail("invalid_option", `mode must be "turns" or "interactive".`);
    }
    // `create` has no task; adapters must not require one during preflight.
    const common = { cwd: input.cwd, task: "", name: input.name, parent: input.parent, model: input.model, thinking: input.thinking, agent: adapter.agent };
    if (mode === "interactive") {
      return controller.createInteractiveSession(common, owner, signal);
    }
    return controller.createSession(common, owner, signal);
  }

  /** Runs one turn on an existing reusable session. */
  async run(sessionId: string, input: SubagentRunInput, owner: string, signal?: AbortSignal): Promise<SubagentStartResult> {
    const resolved = await this.resolve(sessionId);
    if (!resolved.ok) return resolved;
    const { session, controller } = resolved;
    return controller.runTurn(
      sessionId,
      {
        cwd: session.cwd,
        task: input?.task,
        ...(input?.model !== undefined ? { model: input.model } : {}),
        ...(input?.thinking !== undefined ? { thinking: input.thinking } : {}),
      },
      owner,
      signal,
    );
  }

  /** Durable session status, optionally narrowed to one turn, with reconciliation. */
  async status(sessionId: string, owner: string, turnId?: string, signal?: AbortSignal): Promise<SubagentSessionStatusResult> {
    const resolved = await this.resolve(sessionId);
    if (!resolved.ok) return resolved;
    return resolved.controller.statusSession(sessionId, owner, turnId === undefined ? {} : { turnId }, signal);
  }

  /** Cancels the active turn (or a named turn) and leaves the session reusable. */
  async cancel(sessionId: string, owner: string, turnId?: string, signal?: AbortSignal): Promise<SubagentCancelTurnResult> {
    const resolved = await this.resolve(sessionId);
    if (!resolved.ok) return resolved;
    return resolved.controller.cancelTurn(sessionId, owner, turnId === undefined ? {} : { turnId }, signal);
  }

  /** Stops a reusable session and tears down only its verified tmux session. */
  async close(sessionId: string, owner: string, signal?: AbortSignal): Promise<SubagentCloseResult> {
    const resolved = await this.resolve(sessionId);
    if (!resolved.ok) return resolved;
    return resolved.controller.closeSession(sessionId, owner, signal);
  }

  /** Resolves the adapter/controller that owns one durable session, fail-closed. */
  private async resolve(sessionId: string): Promise<SubagentFailure | { ok: true; controller: SubagentController; session: { sessionId: string; agent: SubagentAgent; cwd: string } }> {
    if (typeof sessionId !== "string" || !sessionId) return fail("invalid_option", "A non-empty sessionId is required.");
    const session = await this.options.sessions.getSession(sessionId).catch(() => undefined);
    if (!session) return fail("invalid_target", `Unknown subagent session ${JSON.stringify(sessionId)}.`, { sessionId });
    const controller = this.controllerFor(session.agent);
    if (!controller) return fail("invalid_option", `No adapter is registered for agent ${JSON.stringify(session.agent)}.`, { sessionId });
    return { ok: true, controller, session };
  }

  private controllerFor(agent: SubagentAgent): SubagentController | undefined {
    const existing = this.controllers.get(agent);
    if (existing) return existing;
    const adapter = this.options.adapters.get(agent);
    if (!adapter) return undefined;
    const controller = new SubagentController({
      tmux: this.options.tmux,
      registry: this.options.registry,
      targets: this.options.targets,
      adapter,
      ledger: new SessionSubagentLedger(this.options.sessions, agent),
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.startupProbe ? { startupProbe: this.options.startupProbe } : {}),
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
      ...(this.options.maxDepth !== undefined ? { maxDepth: this.options.maxDepth } : {}),
    });
    this.controllers.set(agent, controller);
    return controller;
  }
}

function fail(code: SubagentFailure["code"], error: string, extra: { sessionId?: string } = {}): SubagentFailure {
  return { ok: false, code, error, ...extra };
}
