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
 * First-class OpenCode adapter (issue #14).
 *
 * OpenCode runs inside a pi-tmux-owned tmux session, but orchestration uses
 * OpenCode's non-interactive JSON run mode instead of TUI scraping:
 *
 *   tmux session
 *     └─ generic runner (src/turn-runner.ts)
 *          └─ opencode run --standalone --format json [--model M] [--session ID] <task>
 *
 * The `--standalone` flag is mandatory and always present: it starts OpenCode's
 * private server inside the owned tmux process tree instead of discovering or
 * starting the shared per-user background service. Killing or losing the owned
 * tmux target therefore tears down the actual agent/tool execution rather than
 * leaving it running in a daemon outside pi-tmux's cancellation boundary.
 *
 * Responsibilities kept here (and nowhere else):
 * - resolve the `opencode` executable without a shell;
 * - assemble the finite argv internally (the model never supplies a command);
 * - capture OpenCode's native `sessionID` on the first turn and resume exactly
 *   that id on later turns, refusing a continuation that has no id;
 * - never pass `--continue` when a known id exists, and never pass `--auto`
 *   (or any other permission-weakening flag) by default;
 * - reject a thinking option rather than silently ignore it;
 * - never inject provider credentials and never mutate global/project OpenCode
 *   config to launch a turn.
 */

/** Environment variables this adapter carries into its runner turn. */
export const OPENCODE_SUBAGENT_ENV = {
  /** Absolute path to the resolved `opencode` executable (constant across turns). */
  bin: "PI_TMUX_OPENCODE_BIN",
} as const;

export const DEFAULT_OPENCODE_COMMAND = "opencode";
export const OPENCODE_PLACEHOLDER_COMMAND = "exec sleep 3600";

/**
 * Flags every managed OpenCode turn must carry. `--standalone` is a hard
 * isolation requirement (private server, owned process tree); `--format json`
 * makes completion structured rather than pane-inferred.
 */
export const OPENCODE_REQUIRED_FLAGS = ["--standalone", "--format", "json"] as const;

/**
 * OpenCode `run --format json` event extraction. Each stdout line is a discrete
 * event (`step_start` / `text` / `tool_use` / `step_finish` / `error`); the
 * native session id is a top-level `sessionID`, the assistant text is
 * `part.text` on the final `text` event, and an error message (when present) is
 * the API error's `error.data.message`. A generic error without that shape is
 * still a failure because the nonzero exit code is authoritative.
 */
export const OPENCODE_PARSE: RunnerParseSpec = {
  sessionId: "sessionID",
  text: "part.text",
  error: "error.data.message",
};

const MODEL_PATTERN = /^[A-Za-z0-9._@:/-]+$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_SESSION_ID_BYTES = 512;

export interface OpenCodeAdapterOptions {
  /** Resolve an `opencode` command to an executable path; defaults to a PATH lookup. */
  resolveOpencode?: (command: string) => Promise<string | undefined>;
  /** The `opencode` command to resolve (default `opencode`). */
  opencodeCommand?: string;
  /** Node executable that launches the packaged runner (default `process.execPath`). */
  runnerBin?: string;
  /** Absolute path of the packaged runner module (default this package's `src/turn-runner.ts`). */
  runnerModule?: string;
  /** Node flags for the runner command (default `--experimental-transform-types`). */
  runnerArgs?: readonly string[];
}

const DEFAULT_RUNNER_ARGS = ["--experimental-transform-types"] as const;

export class OpenCodeAdapter implements AgentAdapter {
  readonly agent: SubagentAgent = "opencode";
  readonly sessionNamePrefix = "opencode-subagent";
  readonly provenanceTool = "tmux_subagent_start_opencode";
  readonly placeholderCommand = OPENCODE_PLACEHOLDER_COMMAND;

  private readonly resolveOpencode: (command: string) => Promise<string | undefined>;
  private readonly opencodeCommand: string;
  private readonly runnerBin: string;
  private readonly runnerModule: string;
  private readonly runnerArgs: readonly string[];

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.resolveOpencode = options.resolveOpencode ?? resolveExecutable;
    this.opencodeCommand = options.opencodeCommand ?? DEFAULT_OPENCODE_COMMAND;
    this.runnerBin = options.runnerBin ?? process.execPath;
    this.runnerModule = options.runnerModule ?? defaultRunnerPath();
    this.runnerArgs = options.runnerArgs ?? DEFAULT_RUNNER_ARGS;
  }

  validateOptions(input: SubagentTurnOptions): string | undefined {
    if (input.model !== undefined && !MODEL_PATTERN.test(input.model)) {
      return "opencode model must match [A-Za-z0-9._@:/-]+ (no spaces or shell characters).";
    }
    if (input.thinking !== undefined) {
      return "opencode does not support a thinking option through this runner; omit it.";
    }
    return undefined;
  }

  async preflight(_input: SubagentTurnOptions): Promise<AgentPreflightResult> {
    if (path.isAbsolute(this.opencodeCommand) && !(await isFile(this.opencodeCommand))) {
      return { ok: false, code: "unavailable", error: `The configured OpenCode executable ${this.opencodeCommand} does not exist.` };
    }

    let executable: string | undefined;
    try {
      executable = await this.resolveOpencode(this.opencodeCommand);
    } catch (error) {
      return { ok: false, code: "command_failed", error: `Could not resolve the OpenCode executable: ${errorMessage(error)}` };
    }
    if (!executable) {
      return { ok: false, code: "unavailable", error: `The OpenCode CLI (${this.opencodeCommand}) was not found on PATH; install it or configure it before starting an opencode subagent.` };
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
        [OPENCODE_SUBAGENT_ENV.bin]: executable,
      },
      metadata: opencodeIsolationMetadata(),
    };
  }

  async prepareTurn(input: SubagentTurnOptions, context: AgentTurnContext): Promise<AgentLaunchSpec> {
    const optionsError = this.validateOptions(input);
    if (optionsError) throw new TmuxError(optionsError, "invalid_option");

    const executable = context.preflight[OPENCODE_SUBAGENT_ENV.bin];
    if (!executable) {
      throw new TmuxError("The OpenCode executable was not resolved during preflight; refusing to launch.", "invalid_option");
    }

    const session = context.agentSessionId;
    if (session !== undefined) {
      const sessionError = validateOpencodeSessionId(session);
      if (sessionError) throw new TmuxError(sessionError, "invalid_option");
    } else if (context.turnIndex > 1) {
      // A continuation must resume exactly the first turn's native session id.
      // Without one, `--continue` would resume "the most recent conversation",
      // which is nondeterministic across concurrent users, so fail closed.
      throw new TmuxError(
        `Refusing to run OpenCode turn ${context.turnIndex}: the logical session has no recorded OpenCode session id to resume. Close it and create a new session.`,
        "invalid_option",
      );
    }

    const spec = this.baseSpec(executable, {
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(session !== undefined ? { session } : {}),
    });
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

  /** The finite OpenCode launch/parse strategy. Caller text never appears here. */
  private baseSpec(executable: string, options: { model?: string; session?: string } = {}): RunnerSpecV1 {
    return {
      version: 1,
      executable,
      args: opencodeTurnArgs(options),
      env: {},
      output: "ndjson",
      prompt: "argv",
      parse: { ...OPENCODE_PARSE },
    };
  }
}

/**
 * The finite OpenCode run argv. It is assembled internally from validated,
 * bounded values; no caller or model text is ever appended here (the runner
 * hands the task to the child as one `argv` element, never shell-interpreted).
 *
 * `--standalone` is always first so a managed turn can never accidentally fall
 * back to the shared background service. `--auto` is never added.
 */
export function opencodeTurnArgs(options: { model?: string; session?: string } = {}): string[] {
  const args = ["run", "--standalone"];
  if (options.model !== undefined) args.push("--model", options.model);
  if (options.session !== undefined) args.push("--session", options.session);
  args.push("--format", "json");
  return args;
}

/** Returns an error message when a native session id is not a safe, bounded argv token. */
export function validateOpencodeSessionId(value: string): string | undefined {
  if (!value || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_SESSION_ID_BYTES || !SESSION_ID_PATTERN.test(value)) {
    return `Refusing to resume OpenCode: the recorded session id is not a safe, bounded token (expected [A-Za-z0-9._-]+, at most ${MAX_SESSION_ID_BYTES} bytes).`;
  }
  return undefined;
}

/**
 * Bounded, non-secret isolation metadata. It describes the execution boundary
 * only: it never reads, returns, or persists any credential value, and it never
 * names an environment variable whose value could be a secret.
 */
export function opencodeIsolationMetadata(): Readonly<Record<string, string>> {
  return {
    opencodeRuntime: "standalone-private-server",
    opencodeIsolationNote:
      "Managed turns always run `opencode run --standalone` inside the pi-tmux-owned tmux session, so the session, permissions, and tool execution live in a private server in the owned process tree instead of the shared background service. pi-tmux injects no provider credentials and passes no --auto or --dangerously-skip-permissions flag.",
  };
}
