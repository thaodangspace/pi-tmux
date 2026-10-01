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
import { runnerLaunchCommand } from "./runner-adapter.ts";
import { TmuxError, errorMessage } from "./tmux.ts";
import {
  RUNNER_ENV,
  type RunnerParseSpec,
  type RunnerSpecV1,
  defaultRunnerPath,
  validateRunnerSpec,
} from "./turn-runner.ts";

/**
 * First-class Claude Code adapter (issue #13).
 *
 * Claude Code still runs inside a pi-tmux-owned tmux session, but orchestration
 * uses Claude's structured non-interactive print mode instead of TUI scraping:
 *
 *   tmux session
 *     └─ generic runner (src/turn-runner.ts)
 *          └─ claude -p --output-format json [--model M] [--resume ID]
 *
 * Responsibilities kept here (and nowhere else):
 * - resolve the `claude` executable without a shell;
 * - assemble the finite argv internally (the model never supplies a command);
 * - capture Claude's native `session_id` on the first turn and resume exactly
 *   that id on later turns, refusing a continuation that has no id;
 * - reject a thinking option rather than silently ignore it;
 * - never add `--dangerously-skip-permissions` (or any permission-disabling flag)
 *   and never mutate project/user config to launch a turn;
 * - surface, without ever logging or storing the value, whether an inherited
 *   `ANTHROPIC_API_KEY` may switch the child from subscription to API billing.
 */

/** Environment variables this adapter carries into its runner turn. */
export const CLAUDE_SUBAGENT_ENV = {
  /** Absolute path to the resolved `claude` executable (constant across turns). */
  bin: "PI_TMUX_CLAUDE_BIN",
} as const;

export const DEFAULT_CLAUDE_COMMAND = "claude";
export const CLAUDE_CODE_PLACEHOLDER_COMMAND = "exec sleep 3600";
/** The environment variable whose presence changes Claude Code billing. */
export const CLAUDE_API_KEY_ENV = "ANTHROPIC_API_KEY";

const MODEL_PATTERN = /^[A-Za-z0-9._@:/-]+$/;
const RESUME_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_RESUME_ID_BYTES = 512;

/**
 * Claude Code `--print --output-format json` result fields. `result` carries the
 * assistant text on success and the error message on failure, so it is parsed as
 * both; the runner never uses either unless the exit code and `is_error` agree.
 */
export const CLAUDE_PARSE: RunnerParseSpec = {
  sessionId: "session_id",
  text: "result",
  error: "result",
  isError: "is_error",
};

export interface ClaudeCodeAdapterOptions {
  /** Resolve a `claude` command to an executable path; defaults to a PATH lookup. */
  resolveClaude?: (command: string) => Promise<string | undefined>;
  /** The `claude` command to resolve (default `claude`). */
  claudeCommand?: string;
  /** Node executable that launches the packaged runner (default `process.execPath`). */
  runnerBin?: string;
  /** Absolute path of the packaged runner module (default this package's `src/turn-runner.ts`). */
  runnerModule?: string;
  /** Node flags for the runner command (default `--experimental-transform-types`). */
  runnerArgs?: readonly string[];
  /** Environment inspected for API-key auth risk; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_RUNNER_ARGS = ["--experimental-transform-types"] as const;

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly agent: SubagentAgent = "claude-code";
  readonly sessionNamePrefix = "claude-code-subagent";
  readonly provenanceTool = "tmux_subagent_start_claude-code";
  readonly placeholderCommand = CLAUDE_CODE_PLACEHOLDER_COMMAND;

  private readonly resolveClaude: (command: string) => Promise<string | undefined>;
  private readonly claudeCommand: string;
  private readonly runnerBin: string;
  private readonly runnerModule: string;
  private readonly runnerArgs: readonly string[];
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.resolveClaude = options.resolveClaude ?? resolveExecutable;
    this.claudeCommand = options.claudeCommand ?? DEFAULT_CLAUDE_COMMAND;
    this.runnerBin = options.runnerBin ?? process.execPath;
    this.runnerModule = options.runnerModule ?? defaultRunnerPath();
    this.runnerArgs = options.runnerArgs ?? DEFAULT_RUNNER_ARGS;
    this.env = options.env ?? process.env;
  }

  validateOptions(input: SubagentTurnOptions): string | undefined {
    if (input.model !== undefined && !MODEL_PATTERN.test(input.model)) {
      return "claude-code model must match [A-Za-z0-9._@:/-]+ (no spaces or shell characters).";
    }
    if (input.thinking !== undefined) {
      return "claude-code does not support a thinking option through this runner; omit it.";
    }
    return undefined;
  }

  async preflight(_input: SubagentTurnOptions): Promise<AgentPreflightResult> {
    if (path.isAbsolute(this.claudeCommand) && !(await isFile(this.claudeCommand))) {
      return { ok: false, code: "unavailable", error: `The configured Claude Code executable ${this.claudeCommand} does not exist.` };
    }

    let executable: string | undefined;
    try {
      executable = await this.resolveClaude(this.claudeCommand);
    } catch (error) {
      return { ok: false, code: "command_failed", error: `Could not resolve the Claude Code executable: ${errorMessage(error)}` };
    }
    if (!executable) {
      return { ok: false, code: "unavailable", error: `The Claude Code CLI (${this.claudeCommand}) was not found on PATH; install it or configure it before starting a claude-code subagent.` };
    }

    if (!(await isFile(this.runnerModule))) {
      return { ok: false, code: "unavailable", error: `The packaged turn runner was not found at ${this.runnerModule}.` };
    }
    if (!(await isFile(this.runnerBin))) {
      return { ok: false, code: "unavailable", error: `The Node executable that launches the runner was not found at ${this.runnerBin}.` };
    }

    try {
      validateRunnerSpec(this.baseSpec(executable));
    } catch (error) {
      return { ok: false, code: "invalid_option", error: errorMessage(error) };
    }

    return {
      ok: true,
      env: {
        [RUNNER_ENV.bin]: this.runnerBin,
        [RUNNER_ENV.module]: this.runnerModule,
        [CLAUDE_SUBAGENT_ENV.bin]: executable,
      },
      metadata: claudeAuthMetadata(this.env),
    };
  }

  async prepareTurn(input: SubagentTurnOptions, context: AgentTurnContext): Promise<AgentLaunchSpec> {
    const optionsError = this.validateOptions(input);
    if (optionsError) throw new TmuxError(optionsError, "invalid_option");

    const executable = context.preflight[CLAUDE_SUBAGENT_ENV.bin];
    if (!executable) {
      throw new TmuxError("The Claude Code executable was not resolved during preflight; refusing to launch.", "invalid_option");
    }

    const resume = context.agentSessionId;
    if (resume !== undefined) {
      const resumeError = validateResumeId(resume);
      if (resumeError) throw new TmuxError(resumeError, "invalid_option");
    } else if (context.turnIndex > 1) {
      // A continuation must resume exactly the first turn's native conversation
      // id. Without one, resuming "the most recent conversation" would be
      // nondeterministic, so fail closed instead.
      throw new TmuxError(
        `Refusing to run Claude Code turn ${context.turnIndex}: the logical session has no recorded Claude session id to resume. Close it and create a new session.`,
        "invalid_option",
      );
    }

    const spec = this.baseSpec(executable, { ...(input.model !== undefined ? { model: input.model } : {}), ...(resume !== undefined ? { resume } : {}) });
    return {
      command: runnerLaunchCommand(this.runnerArgs),
      env: {
        [RUNNER_ENV.spec]: JSON.stringify(spec),
        [RUNNER_ENV.task]: input.task,
        [RUNNER_ENV.state]: context.statePath,
        [RUNNER_ENV.session]: context.sessionId,
        [RUNNER_ENV.turn]: context.runId,
        [RUNNER_ENV.owner]: context.owner,
      },
      completion: { strategy: "runner" },
    };
  }

  /** The finite Claude Code launch/parse strategy. Caller text never appears here. */
  private baseSpec(executable: string, options: { model?: string; resume?: string } = {}): RunnerSpecV1 {
    return {
      version: 1,
      executable,
      args: claudeTurnArgs(options),
      env: {},
      output: "json",
      prompt: "stdin",
      parse: { ...CLAUDE_PARSE },
    };
  }
}

/**
 * The finite Claude Code print-mode argv. It is assembled internally from
 * validated, bounded values; no caller or model text is ever appended.
 */
export function claudeTurnArgs(options: { model?: string; resume?: string } = {}): string[] {
  const args = ["-p", "--output-format", "json"];
  if (options.model !== undefined) args.push("--model", options.model);
  if (options.resume !== undefined) args.push("--resume", options.resume);
  return args;
}

/** Returns an error message when a native resume id is not a safe, bounded argv token. */
export function validateResumeId(value: string): string | undefined {
  if (!value || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_RESUME_ID_BYTES || !RESUME_ID_PATTERN.test(value)) {
    return `Refusing to resume Claude Code: the recorded session id is not a safe, bounded token (expected [A-Za-z0-9._-]+, at most ${MAX_RESUME_ID_BYTES} bytes).`;
  }
  return undefined;
}

/**
 * Bounded, non-secret auth/billing metadata. It reports only whether the launch
 * environment carries an `ANTHROPIC_API_KEY`; the value itself is never read
 * beyond a presence check and is never returned, logged, or persisted.
 */
export function claudeAuthMetadata(env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const present = typeof env[CLAUDE_API_KEY_ENV] === "string" && (env[CLAUDE_API_KEY_ENV] as string).length > 0;
  if (present) {
    return {
      claudeAuthRisk: "api-key-present",
      claudeBilling: "api",
      claudeAuthNote:
        "ANTHROPIC_API_KEY is present in the launch environment, so Claude Code will use API billing instead of the logged-in subscription. pi-tmux did not set or change it.",
    };
  }
  return {
    claudeAuthRisk: "none-detected",
    claudeBilling: "subscription-or-unauthenticated",
    claudeAuthNote:
      "No ANTHROPIC_API_KEY was detected in the launch environment; Claude Code will use its own stored authentication (subscription) if the CLI is logged in.",
  };
}
