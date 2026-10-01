import path from "node:path";
import {
  type AgentAdapter,
  type AgentLaunchSpec,
  type AgentPreflightResult,
  type AgentTurnContext,
  type SubagentTurnOptions,
} from "./agent-adapter.ts";
import { isFile, resolveExecutable } from "./subagent-controller.ts";
import type { SubagentAgent } from "./subagent-sessions.ts";
import { RUNNER_ENV, type RunnerSpecV1, defaultRunnerPath, validateRunnerSpec } from "./turn-runner.ts";
import { errorMessage } from "./tmux.ts";

/**
 * Config-driven adapter for the generic turn runner (issue #11).
 *
 * An adapter for a non-Pi agent only supplies a finite {@link RunnerSpecV1}: the
 * executable to spawn and its fixed argv, the environment, the output framing,
 * the prompt transport, and declarative result extraction. This class turns
 * that spec into the constant tmux command and the runner environment contract.
 *
 * It never hard-codes a Claude Code or OpenCode command line, and it never puts
 * the task in the command string: the task is carried as the bounded
 * `PI_TMUX_RUNNER_TASK` environment value and handed to the child by the runner
 * as one argv element or on stdin.
 */

export interface RunnerAdapterOptions {
  agent: SubagentAgent;
  /** The finite, validated launch/parse strategy for this agent. */
  spec: RunnerSpecV1;
  /** Resolve the spec executable to an absolute path; defaults to a PATH lookup. */
  resolveExecutable?: (command: string) => Promise<string | undefined>;
  /** Node executable that launches the packaged runner (default `process.execPath`). */
  runnerBin?: string;
  /** Absolute path of the packaged runner module (default this package's `src/turn-runner.ts`). */
  runnerModule?: string;
  /** Node flags for the runner command (default `--experimental-transform-types`). */
  runnerArgs?: readonly string[];
  sessionNamePrefix?: string;
  provenanceTool?: string;
  placeholderCommand?: string;
}

const DEFAULT_RUNNER_ARGS = ["--experimental-transform-types"] as const;

export class RunnerAdapter implements AgentAdapter {
  readonly agent: SubagentAgent;
  readonly sessionNamePrefix: string;
  readonly provenanceTool: string;
  readonly placeholderCommand: string;

  private readonly spec: RunnerSpecV1;
  private readonly resolveExe: (command: string) => Promise<string | undefined>;
  private readonly runnerBin: string;
  private readonly runnerModule: string;
  private readonly runnerArgs: readonly string[];

  constructor(options: RunnerAdapterOptions) {
    this.agent = options.agent;
    this.spec = options.spec;
    this.resolveExe = options.resolveExecutable ?? resolveExecutable;
    this.runnerBin = options.runnerBin ?? process.execPath;
    this.runnerModule = options.runnerModule ?? defaultRunnerPath();
    this.runnerArgs = options.runnerArgs ?? DEFAULT_RUNNER_ARGS;
    this.sessionNamePrefix = options.sessionNamePrefix ?? `${options.agent}-subagent`;
    this.provenanceTool = options.provenanceTool ?? `tmux_subagent_start_${options.agent}`;
    this.placeholderCommand = options.placeholderCommand ?? "exec sleep 3600";
  }

  validateOptions(input: SubagentTurnOptions): string | undefined {
    // The config-driven runner has no bounded model/thinking contract yet; reject
    // rather than silently ignore an option the caller believed was applied.
    if (input.model !== undefined) return `The ${this.agent} runner adapter does not support a model option.`;
    if (input.thinking !== undefined) return `The ${this.agent} runner adapter does not support a thinking option.`;
    return undefined;
  }

  async preflight(_input: SubagentTurnOptions): Promise<AgentPreflightResult> {
    let spec: RunnerSpecV1;
    try {
      spec = validateRunnerSpec(this.spec, { requireAbsoluteExecutable: false });
    } catch (error) {
      return { ok: false, code: "invalid_option", error: errorMessage(error) };
    }
    if (spec.executable.includes("/") && !path.isAbsolute(spec.executable)) {
      return { ok: false, code: "invalid_option", error: `The ${this.agent} executable must be an absolute path or a bare command name; received ${JSON.stringify(spec.executable)}.` };
    }

    let executable: string | undefined;
    try {
      executable = await this.resolveExe(spec.executable);
    } catch (error) {
      return { ok: false, code: "command_failed", error: `Could not resolve the runner executable: ${errorMessage(error)}` };
    }
    if (!executable) {
      return { ok: false, code: "unavailable", error: `The ${this.agent} executable (${spec.executable}) was not found or is not executable.` };
    }

    if (!(await isFile(this.runnerModule))) {
      return { ok: false, code: "unavailable", error: `The packaged turn runner was not found at ${this.runnerModule}.` };
    }
    if (!(await isFile(this.runnerBin))) {
      return { ok: false, code: "unavailable", error: `The Node executable that launches the runner was not found at ${this.runnerBin}.` };
    }

    let resolved: RunnerSpecV1;
    try {
      resolved = validateRunnerSpec({ ...spec, executable });
    } catch (error) {
      return { ok: false, code: "invalid_option", error: errorMessage(error) };
    }
    return {
      ok: true,
      env: {
        [RUNNER_ENV.spec]: JSON.stringify(resolved),
        [RUNNER_ENV.bin]: this.runnerBin,
        [RUNNER_ENV.module]: this.runnerModule,
      },
    };
  }

  async prepareTurn(input: SubagentTurnOptions, context: AgentTurnContext): Promise<AgentLaunchSpec> {
    return {
      command: this.runnerCommand(),
      env: {
        [RUNNER_ENV.task]: input.task,
        [RUNNER_ENV.state]: context.statePath,
        [RUNNER_ENV.session]: context.sessionId,
        [RUNNER_ENV.turn]: context.runId,
        [RUNNER_ENV.owner]: context.owner,
      },
      completion: { strategy: "runner" },
    };
  }

  /**
   * The constant command tmux runs. The executable and module are quoted
   * environment expansions; the runner's fixed Node flags are deployer-provided
   * constants that are shell-quoted. No caller-provided text appears here.
   */
  runnerCommand(): string {
    const parts = ["exec", `"$${RUNNER_ENV.bin}"`, ...this.runnerArgs.map(shellQuote), `"$${RUNNER_ENV.module}"`];
    return parts.join(" ");
  }
}

/** Single-quotes one trusted constant so it survives the shell tmux runs. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
