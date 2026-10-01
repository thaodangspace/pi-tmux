import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentAdapter,
  type AgentLaunchSpec,
  type AgentPreflightResult,
  type AgentTurnContext,
  type SubagentTurnOptions,
} from "./agent-adapter.ts";
import { type SubagentAgent } from "./subagent-sessions.ts";
import { CHILD_REPORTER_ENV } from "./subagent-reporter.ts";
import { isFile, parseAncestorList, resolveExecutable } from "./subagent-controller.ts";
import { errorMessage } from "./tmux.ts";

/**
 * Pi adapter (issue #10).
 *
 * This is the only place Pi-specific launch behavior lives: resolving the `pi`
 * binary, the packaged child reporter, the Pi CLI arguments, optional
 * model/thinking validation, the child reporter environment contract, and the
 * native `agent_settled` completion strategy. The generic controller owns all
 * tmux and durable-lifecycle semantics.
 */

/** Environment variables used to carry Pi launch data into the child pane. */
export const PI_SUBAGENT_ENV = {
  /** Absolute path to the `pi` executable the child runs. */
  piBin: "PI_TMUX_PI_BIN",
  /** Absolute path to the packaged child reporter extension. */
  reporter: "PI_TMUX_CHILD_REPORTER",
  /** The bounded task text, delivered verbatim as one argument. */
  task: "PI_TMUX_SUBAGENT_TASK",
  /** Optional validated model selection. */
  model: "PI_TMUX_SUBAGENT_MODEL",
  /** Optional validated thinking level. */
  thinking: "PI_TMUX_SUBAGENT_THINKING",
} as const;

export const PI_SUBAGENT_TOOL = "tmux_subagent_start_pi";
export const DEFAULT_PI_COMMAND = "pi";
export const PI_SUBAGENT_PLACEHOLDER_COMMAND = "exec sleep 3600";

const MODEL_PATTERN = /^[A-Za-z0-9._/@:-]+$/;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * The one constant command tmux runs for a Pi subagent. Every substituted value
 * is either a constant path we wrote or an environment variable expanded
 * *inside double quotes*, which the shell cannot re-interpret. The task is not
 * in this string; it is only referenced as `"$PI_TMUX_SUBAGENT_TASK"`.
 */
export function piLaunchCommand(withModel: boolean, withThinking: boolean): string {
  const parts = [`exec "$${PI_SUBAGENT_ENV.piBin}"`, `--extension "$${PI_SUBAGENT_ENV.reporter}"`, "--mode json"];
  if (withModel) parts.push(`--model "$${PI_SUBAGENT_ENV.model}"`);
  if (withThinking) parts.push(`--thinking "$${PI_SUBAGENT_ENV.thinking}"`);
  parts.push(`-p -- "$${PI_SUBAGENT_ENV.task}"`);
  return parts.join(" ");
}

export const PI_SUBAGENT_LAUNCH_COMMAND = piLaunchCommand(false, false);

export interface PiAdapterOptions {
  /** Resolve a `pi` command to an executable path; defaults to a PATH lookup. */
  resolvePi?: (command: string) => Promise<string | undefined>;
  /** The `pi` command to resolve (default `pi`). */
  piCommand?: string;
  /** Absolute path to the packaged child reporter; defaults to the package path. */
  reporterPath?: string;
}

export class PiAdapter implements AgentAdapter {
  readonly agent: SubagentAgent = "pi";
  readonly sessionNamePrefix = "pi-subagent";
  readonly provenanceTool = PI_SUBAGENT_TOOL;
  readonly placeholderCommand = PI_SUBAGENT_PLACEHOLDER_COMMAND;

  private readonly resolvePi: (command: string) => Promise<string | undefined>;
  private readonly piCommand: string;
  private readonly reporterPath: string;

  constructor(options: PiAdapterOptions = {}) {
    this.resolvePi = options.resolvePi ?? resolveExecutable;
    this.piCommand = options.piCommand ?? DEFAULT_PI_COMMAND;
    this.reporterPath = options.reporterPath ?? defaultChildReporterPath();
  }

  validateOptions(input: SubagentTurnOptions): string | undefined {
    if (input.model !== undefined && !MODEL_PATTERN.test(input.model)) {
      return "model must match [A-Za-z0-9._/@:-]+.";
    }
    if (input.thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(input.thinking)) {
      return `thinking must be one of ${THINKING_LEVELS.join(", ")}.`;
    }
    return undefined;
  }

  lineage(env: NodeJS.ProcessEnv): string[] {
    const ancestors = parseAncestorList(env[CHILD_REPORTER_ENV.ancestors]);
    const ownJobId = env[CHILD_REPORTER_ENV.jobId];
    if (ownJobId && !ancestors.includes(ownJobId)) ancestors.push(ownJobId);
    return ancestors;
  }

  async preflight(_input: SubagentTurnOptions): Promise<AgentPreflightResult> {
    if (!(await isFile(this.reporterPath))) {
      return { ok: false, code: "unavailable", error: `The packaged Pi child reporter was not found at ${this.reporterPath}.` };
    }
    if (path.isAbsolute(this.piCommand) && !(await isFile(this.piCommand))) {
      return { ok: false, code: "unavailable", error: `The configured Pi executable ${this.piCommand} does not exist.` };
    }
    let piBin: string | undefined;
    try {
      piBin = await this.resolvePi(this.piCommand);
    } catch (error) {
      return { ok: false, code: "command_failed", error: `Could not resolve the Pi binary: ${errorMessage(error)}` };
    }
    if (!piBin) {
      return { ok: false, code: "unavailable", error: `The Pi CLI (${this.piCommand}) was not found on PATH; install it or configure it before starting a subagent.` };
    }
    return { ok: true, env: { [PI_SUBAGENT_ENV.piBin]: piBin, [PI_SUBAGENT_ENV.reporter]: this.reporterPath } };
  }

  async prepareTurn(input: SubagentTurnOptions, context: AgentTurnContext): Promise<AgentLaunchSpec> {
    const withModel = Boolean(input.model);
    const withThinking = Boolean(input.thinking);
    const env: Record<string, string> = {
      [CHILD_REPORTER_ENV.jobId]: context.runId,
      [CHILD_REPORTER_ENV.state]: context.statePath,
      [CHILD_REPORTER_ENV.parentSessionId]: context.owner,
      [PI_SUBAGENT_ENV.task]: input.task,
    };
    if (context.ancestors.length) env[CHILD_REPORTER_ENV.ancestors] = context.ancestors.join(",");
    if (withModel) env[PI_SUBAGENT_ENV.model] = input.model!;
    if (withThinking) env[PI_SUBAGENT_ENV.thinking] = input.thinking!;
    return { command: piLaunchCommand(withModel, withThinking), env, completion: { strategy: "native-reporter" } };
  }
}

/** Resolves the packaged child reporter path relative to this module. */
export function defaultChildReporterPath(): string {
  return fileURLToPath(new URL("../extensions/child-reporter.ts", import.meta.url));
}
