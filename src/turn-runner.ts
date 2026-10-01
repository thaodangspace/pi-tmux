import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_ERROR_BYTES,
  DEFAULT_MAX_SUMMARY_BYTES,
  completionDirFor,
} from "./subagent-reporter.ts";
import {
  type SubagentSessionV1,
  type SubagentTurnStatus,
  type SubagentTurnV1,
  SubagentSessionRegistry,
  isTerminalTurnStatus,
} from "./subagent-sessions.ts";
import { validateTask } from "./subagent-controller.ts";
import { TmuxError, errorMessage } from "./tmux.ts";

/**
 * Generic packaged turn runner (issue #11).
 *
 * One runner process runs exactly one turn of a non-Pi agent (Claude Code,
 * OpenCode, ...). It sits inside the tmux execution boundary owned by the
 * generic `SubagentController`:
 *
 *   tmux server
 *     └─ subagent tmux session   (a `SubagentSessionV1` execution boundary)
 *          └─ runner             (this module, one process per turn)
 *               └─ agent process (claude/opencode, spawned with shell:false)
 *
 * The runner contains no agent-specific CLI construction. An adapter provides a
 * finite, validated {@link RunnerSpecV1} (executable, fixed argv, environment,
 * output format, prompt transport, declarative field extraction). Nothing that
 * crosses the process boundary is a callback; the spec is a bounded data shape
 * the runner validates again before it does anything.
 *
 * Safety contract:
 * - the prompt is never interpolated into a shell: it travels as a bounded
 *   environment value and is handed to the child as one argv element or on
 *   stdin, never joined into a command string;
 * - the child is spawned with `shell: false`;
 * - the runner re-validates the durable session/turn/pane binding and the tmux
 *   server identity before it mutates anything, and fails closed on a mismatch;
 * - stdout/stderr and the persisted summary/error are bounded; the full
 *   transcript and pane contents are never stored or inspected;
 * - completion is derived only from the child's exit code and its structured
 *   output, never from pane text;
 * - the durable turn transition is atomic, so a racing cancellation or a
 *   duplicate runner never overwrites a terminal outcome.
 */

export const TURN_COMPLETION_VERSION = 1 as const;
export const DEFAULT_MAX_STDOUT_BYTES = 262_144;
export const DEFAULT_MAX_STDERR_BYTES = 65_536;
export const MAX_RUNNER_SPEC_BYTES = 16_384;
export const MAX_RUNNER_ARGS = 64;
export const MAX_RUNNER_ARG_BYTES = 4_096;
export const MAX_RUNNER_ENV_ENTRIES = 64;
export const MAX_RUNNER_ENV_VALUE_BYTES = 8_192;
export const MAX_AGENT_SESSION_ID_BYTES = 512;

/** Environment contract between the launching adapter and the packaged runner. */
export const RUNNER_ENV = {
  /** Required. Bounded JSON `RunnerSpecV1` for this agent. */
  spec: "PI_TMUX_RUNNER_SPEC",
  /** Required. The bounded task/prompt, delivered verbatim. */
  task: "PI_TMUX_RUNNER_TASK",
  /** Required. Absolute path of the `SubagentSessionV1` registry file. */
  state: "PI_TMUX_RUNNER_STATE",
  /** Required. Durable logical session ID this turn belongs to. */
  session: "PI_TMUX_RUNNER_SESSION",
  /** Required. Durable turn ID this runner must complete. */
  turn: "PI_TMUX_RUNNER_TURN",
  /** Required. Owning Pi conversation; the runner refuses another owner's turn. */
  owner: "PI_TMUX_RUNNER_OWNER",
  /** Resolved Node executable that launches the packaged runner (used by the constant command). */
  bin: "PI_TMUX_RUNNER_BIN",
  /** Absolute path of this packaged runner module (used by the constant command). */
  module: "PI_TMUX_RUNNER_MODULE",
} as const;

/** Declarative extraction of the small bounded fields a runner records. */
export interface RunnerParseSpec {
  /** Dot-path of the agent-native session ID (e.g. `session_id`). */
  sessionId?: string;
  /** Dot-path of the assistant's final text, stored bounded as `summary`. */
  text?: string;
  /** Dot-path of an explicit error message. */
  error?: string;
  /** Dot-path of a boolean error flag. */
  isError?: string;
}

/**
 * Finite, validated launch/parse strategy. It is ordinary data so an adapter can
 * hand it to the packaged runner across the process boundary without serializing
 * any callback. The runner never hard-codes an agent's CLI flags.
 */
export interface RunnerSpecV1 {
  version: 1;
  /** Absolute, executable path (the adapter resolves a PATH command first). */
  executable: string;
  /** Fixed arguments, never caller text. */
  args: readonly string[];
  /** Extra environment for the child; the runner strips its own `PI_TMUX_*`. */
  env: Readonly<Record<string, string>>;
  /** How stdout is framed. */
  output: "json" | "ndjson";
  /** Safe, non-shell prompt transport. */
  prompt: "stdin" | "argv";
  /** Optional declarative result extraction. */
  parse?: RunnerParseSpec;
}

/** Immutable, bounded per-attempt completion payload. */
export interface SubagentTurnCompletionV1 {
  version: 1;
  sessionId: string;
  turnId: string;
  agent: string;
  status: "completed" | "failed";
  finishedAt: string;
  agentSessionId?: string;
  exitCode?: number;
  summary?: string;
  error?: string;
}

/** Explicit target identity the runner must re-verify before mutating state. */
export interface TurnRunnerIdentity {
  sessionId: string;
  turnId: string;
  /** Stable tmux pane ID (`%N`) this runner is expected to run in. */
  paneId: string;
  owner?: string;
  /** tmux server PID derived from `TMUX`; compared with the recorded identity. */
  serverPid?: string;
}

export interface RunnerInvocation {
  spec: RunnerSpecV1;
  task: string;
  statePath: string;
  identity: TurnRunnerIdentity;
}

export interface TurnRunnerOptions {
  registry: SubagentSessionRegistry;
  spec: RunnerSpecV1;
  task: string;
  identity: TurnRunnerIdentity;
  /** Child working directory; defaults to the session's recorded cwd. */
  cwd?: string;
  now?: () => Date;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxSummaryBytes?: number;
  maxErrorBytes?: number;
  /** Override the derived completion-payload directory (tests). */
  completionDir?: string;
  report?: (level: "info" | "warning" | "error", message: string) => void;
  /** Inject a spawn implementation; defaults to `node:child_process.spawn`. */
  spawnProcess?: typeof spawn;
  signal?: AbortSignal;
}

export interface TurnRunnerResult {
  status: SubagentTurnStatus;
  /** True when a racing terminal write (for example a cancellation) won. */
  passive: boolean;
  /** Set when the runner did not launch or record for a reason other than winning. */
  reason?: string;
  sessionId: string;
  turnId: string;
  agentSessionId?: string;
  exitCode?: number;
  resultPath?: string;
  error?: string;
}

const PANE_ID = /^%\d+$/;

/** Absolute path of this packaged runner, used by the adapter's constant command. */
export function defaultRunnerPath(): string {
  return fileURLToPath(new URL("./turn-runner.ts", import.meta.url));
}

/** Parses and validates a `RunnerSpecV1` from its JSON serialization. */
export function parseRunnerSpec(raw: unknown): RunnerSpecV1 {
  if (typeof raw !== "string" || !raw) {
    throw new TmuxError(`Missing or empty ${RUNNER_ENV.spec}.`, "invalid_option");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_RUNNER_SPEC_BYTES) {
    throw new TmuxError(`${RUNNER_ENV.spec} is longer than ${MAX_RUNNER_SPEC_BYTES} bytes.`, "invalid_option");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TmuxError(`${RUNNER_ENV.spec} is not valid JSON; refusing to launch.`, "invalid_option");
  }
  return validateRunnerSpec(parsed);
}

/** Validates the finite runner strategy data shape. Throws a `TmuxError` when invalid. */
export function validateRunnerSpec(value: unknown, options: { requireAbsoluteExecutable?: boolean } = {}): RunnerSpecV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TmuxError("The runner spec must be an object.", "invalid_option");
  }
  const requireAbsolute = options.requireAbsoluteExecutable ?? true;
  const spec = value as Record<string, unknown>;
  if (spec.version !== 1) throw new TmuxError("The runner spec version must be 1.", "invalid_option");

  const executable = requireExecutable(spec.executable, requireAbsolute);

  if (!Array.isArray(spec.args) || spec.args.length > MAX_RUNNER_ARGS) {
    throw new TmuxError(`The runner spec args must be an array of at most ${MAX_RUNNER_ARGS} strings.`, "invalid_option");
  }
  const args: string[] = [];
  for (const arg of spec.args) {
    if (typeof arg !== "string" || Buffer.byteLength(arg, "utf8") > MAX_RUNNER_ARG_BYTES || arg.includes("\0")) {
      throw new TmuxError(`Each runner spec arg must be a string of at most ${MAX_RUNNER_ARG_BYTES} bytes without NUL.`, "invalid_option");
    }
    args.push(arg);
  }

  const env: Record<string, string> = {};
  if (spec.env !== undefined) {
    if (spec.env === null || typeof spec.env !== "object" || Array.isArray(spec.env)) {
      throw new TmuxError("The runner spec env must be an object of string values.", "invalid_option");
    }
    const entries = Object.entries(spec.env as Record<string, unknown>);
    if (entries.length > MAX_RUNNER_ENV_ENTRIES) {
      throw new TmuxError(`The runner spec env has more than ${MAX_RUNNER_ENV_ENTRIES} entries.`, "invalid_option");
    }
    for (const [key, value] of entries) {
      if (!key || key.includes("=") || key.includes("\0")) throw new TmuxError(`Invalid runner spec env key ${JSON.stringify(key)}.`, "invalid_option");
      if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_RUNNER_ENV_VALUE_BYTES || value.includes("\0")) {
        throw new TmuxError(`Runner spec env ${JSON.stringify(key)} must be a string of at most ${MAX_RUNNER_ENV_VALUE_BYTES} bytes without NUL.`, "invalid_option");
      }
      env[key] = value;
    }
  }

  if (spec.output !== "json" && spec.output !== "ndjson") {
    throw new TmuxError('The runner spec output must be "json" or "ndjson".', "invalid_option");
  }
  if (spec.prompt !== "stdin" && spec.prompt !== "argv") {
    throw new TmuxError('The runner spec prompt must be "stdin" or "argv".', "invalid_option");
  }

  let parse: RunnerParseSpec | undefined;
  if (spec.parse !== undefined) {
    if (spec.parse === null || typeof spec.parse !== "object" || Array.isArray(spec.parse)) {
      throw new TmuxError("The runner spec parse must be an object of dot-paths.", "invalid_option");
    }
    const raw = spec.parse as Record<string, unknown>;
    parse = {};
    for (const field of ["sessionId", "text", "error", "isError"] as const) {
      const value = raw[field];
      if (value === undefined) continue;
      if (typeof value !== "string" || !isParsePath(value)) {
        throw new TmuxError(`The runner spec parse.${field} must be a dot-path of identifiers and indices.`, "invalid_option");
      }
      parse[field] = value;
    }
  }

  return { version: 1, executable, args, env, output: spec.output, prompt: spec.prompt, ...(parse ? { parse } : {}) };
}

/** Validates and normalizes the runner's own environment into an invocation. */
export function parseRunnerInvocation(env: NodeJS.ProcessEnv = process.env): RunnerInvocation {
  const spec = parseRunnerSpec(env[RUNNER_ENV.spec]);
  const task = env[RUNNER_ENV.task];
  const taskError = validateTask(task);
  if (taskError) throw new TmuxError(`${RUNNER_ENV.task}: ${taskError}`, "invalid_option");

  const statePath = requireAbsolutePath(env[RUNNER_ENV.state], RUNNER_ENV.state);
  const sessionId = requireToken(env[RUNNER_ENV.session], RUNNER_ENV.session, 256);
  const turnId = requireToken(env[RUNNER_ENV.turn], RUNNER_ENV.turn, 256);
  const ownerRaw = env[RUNNER_ENV.owner];
  const owner = ownerRaw === undefined ? undefined : requireToken(ownerRaw, RUNNER_ENV.owner, 256);

  const paneId = env.TMUX_PANE;
  if (typeof paneId !== "string" || !PANE_ID.test(paneId)) {
    throw new TmuxError(
      `${RUNNER_ENV.session} loaded outside a tmux pane: TMUX_PANE is ${paneId === undefined ? "unset" : JSON.stringify(paneId)}. The runner refuses to report for an unverifiable target.`,
      "invalid_option",
    );
  }

  const serverPid = serverPidFromTmux(env.TMUX);
  return {
    spec,
    task: task as string,
    statePath,
    identity: { sessionId, turnId, paneId, ...(owner !== undefined ? { owner } : {}), ...(serverPid !== undefined ? { serverPid } : {}) },
  };
}

/**
 * Runs exactly one turn: verifies the durable binding, transitions the turn to
 * `running`, spawns the adapter-provided executable with `shell: false`, parses
 * bounded structured output, records an immutable bounded payload, and applies a
 * terminal turn transition. A terminal turn is never overwritten.
 */
export async function runTurn(options: TurnRunnerOptions): Promise<TurnRunnerResult> {
  const registry = options.registry;
  const identity = options.identity;
  const spec = validateRunnerSpec(options.spec);
  const now = options.now ?? (() => new Date());
  const report = options.report ?? (() => undefined);
  const maxStdoutBytes = positiveInteger(options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES, "maxStdoutBytes");
  const maxStderrBytes = positiveInteger(options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES, "maxStderrBytes");
  const maxSummaryBytes = positiveInteger(options.maxSummaryBytes ?? DEFAULT_MAX_SUMMARY_BYTES, "maxSummaryBytes");
  const maxErrorBytes = positiveInteger(options.maxErrorBytes ?? DEFAULT_MAX_ERROR_BYTES, "maxErrorBytes");
  const spawnProcess = options.spawnProcess ?? spawn;

  const taskError = validateTask(options.task);
  if (taskError) throw new TmuxError(taskError, "invalid_option");

  const ownerOptions = identity.owner !== undefined ? { parentPiSessionId: identity.owner } : {};

  const { session, turn } = await verifyBinding(registry, identity);
  if (isTerminalTurnStatus(turn.status)) {
    // A parent cancellation or an earlier runner already settled this turn. Do
    // not spawn and do not overwrite the terminal outcome.
    report("info", `Turn ${turn.turnId} is already terminal (${turn.status}); the runner will not rewrite it.`);
    return passiveResult(turn, "turn is already terminal");
  }

  // Durable compare-and-set for launch ownership: exactly one runner may spawn a
  // child for this turn, even if two are launched concurrently.
  const claim = await registry.claimTurn(turn.turnId, randomUUID(), ownerOptions);
  if (isTerminalTurnStatus(claim.turn.status)) {
    report("info", `Turn ${turn.turnId} became terminal (${claim.turn.status}) before launch; the runner will not rewrite it.`);
    return passiveResult(claim.turn, "turn became terminal before launch");
  }
  if (!claim.claimed) {
    report("warning", `Turn ${turn.turnId} is already owned by another runner; refusing to launch a second child.`);
    return passiveResult(claim.turn, "another runner owns this turn's launch");
  }

  if (!(await isExecutableFile(spec.executable))) {
    return await finishTurn(registry, session, turn, identity, {
      status: "failed",
      error: `The runner executable ${spec.executable} is missing or not executable.`,
      maxSummaryBytes,
      maxErrorBytes,
      completionDir: options.completionDir,
      now,
    });
  }

  const advance = await advanceToRunning(registry, turn.turnId, ownerOptions);
  if (advance) {
    report("info", `Turn ${turn.turnId} became terminal (${advance.status}) before launch; the runner will not rewrite it.`);
    return advance;
  }

  const collected = await spawnAgent({
    spec,
    task: options.task,
    cwd: options.cwd ?? session.cwd,
    spawnProcess,
    maxStdoutBytes,
    maxStderrBytes,
    signal: options.signal,
  });

  const outcome = deriveOutcome(collected, spec, maxSummaryBytes, maxErrorBytes, maxStdoutBytes);
  report("info", `Turn ${turn.turnId} (${session.agent}) ${outcome.status}${outcome.exitCode !== undefined ? ` (exit ${outcome.exitCode})` : ""}.`);

  return await finishTurn(registry, session, turn, identity, {
    ...outcome,
    maxSummaryBytes,
    maxErrorBytes,
    completionDir: options.completionDir,
    now,
  });
}

/**
 * Advances the turn to `running`, tolerating a concurrent runner that already
 * advanced it. Returns a passive terminal result when a racing cancellation or
 * terminal write won; otherwise leaves the turn running.
 */
async function advanceToRunning(
  registry: SubagentSessionRegistry,
  turnId: string,
  ownerOptions: { parentPiSessionId?: string },
): Promise<TurnRunnerResult | undefined> {
  for (const target of ["starting", "running"] as const) {
    try {
      await registry.transitionTurn(turnId, target, ownerOptions);
    } catch (error) {
      const latest = await registry.getTurn(turnId).catch(() => undefined);
      if (latest && isTerminalTurnStatus(latest.status)) return passiveResult(latest, "turn became terminal before launch");
      // A concurrent runner already advanced to `target` (or to `running` when
      // this runner tried `starting`); that is not an error.
      if (latest && (latest.status === target || (target === "starting" && latest.status === "running"))) continue;
      throw error;
    }
  }
  return undefined;
}

interface CollectedRun {
  code: number | null;
  aborted: boolean;
  spawnError?: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

async function spawnAgent(input: {
  spec: RunnerSpecV1;
  task: string;
  cwd: string;
  spawnProcess: typeof spawn;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  signal?: AbortSignal;
}): Promise<CollectedRun> {
  const { spec } = input;
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Never leak this runner's own durable binding into the child agent; a
    // nested runner must not inherit another turn's identity.
    if (value === undefined || key.startsWith("PI_TMUX_")) continue;
    childEnv[key] = value;
  }
  Object.assign(childEnv, spec.env);

  const args = spec.prompt === "argv" ? [...spec.args, input.task] : [...spec.args];

  let child: ChildProcess;
  try {
    child = input.spawnProcess(spec.executable, args, { shell: false, cwd: input.cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    return { code: null, aborted: false, spawnError: errorMessage(error), stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
  }

  const stdout = tailBuffer(input.maxStdoutBytes);
  const stderr = tailBuffer(input.maxStderrBytes);

  return await new Promise<CollectedRun>((resolve) => {
    let settled = false;
    let aborted = false;
    let spawnError: string | undefined;
    const settle = (run: CollectedRun) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      resolve(run);
    };
    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();

    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      spawnError = errorMessage(error);
      child.kill("SIGKILL");
    });
    child.on("close", (code) => {
      settle({
        code,
        aborted,
        ...(spawnError ? { spawnError } : {}),
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
      });
    });

    if (child.stdin) {
      if (spec.prompt === "stdin") child.stdin.end(input.task);
      else child.stdin.end();
      child.stdin.on("error", () => undefined); // A child that closes stdin early is not a failure.
    }
  });
}

interface DerivedOutcome {
  status: "completed" | "failed";
  exitCode?: number;
  agentSessionId?: string;
  summary?: string;
  error?: string;
}

function deriveOutcome(run: CollectedRun, spec: RunnerSpecV1, maxSummaryBytes: number, maxErrorBytes: number, maxStdoutBytes: number): DerivedOutcome {
  const exitCode = run.code ?? undefined;
  const withExit = exitCode !== undefined ? { exitCode } : {};

  if (run.spawnError) {
    return { ...withExit, status: "failed", error: truncate(`Could not start ${spec.executable}: ${run.spawnError}`, maxErrorBytes) };
  }
  if (run.aborted) {
    return { ...withExit, status: "failed", error: "The runner was cancelled before the turn completed." };
  }
  // Fail closed on any truncation: the tail buffer keeps the last bytes, so a
  // valid-looking final line cannot be distinguished from a stream whose earlier
  // structured output was silently dropped. Never infer completion from it.
  if (run.stdoutTruncated) {
    return {
      ...withExit,
      status: "failed",
      error: truncate(
        `The agent's structured stdout exceeded the ${maxStdoutBytes}-byte limit and was truncated; refusing to infer completion from an incomplete stream.`,
        maxErrorBytes,
      ),
    };
  }

  const parsed = parseStructured(run.stdout, spec.output);
  const objects = parsed.objects;
  const agentSessionId = boundedAgentSessionId(firstString(objects, spec.parse?.sessionId));
  const base = { ...withExit, ...(agentSessionId !== undefined ? { agentSessionId } : {}) };

  if (!parsed.ok) {
    return { ...base, status: "failed", error: truncate(parsed.error, maxErrorBytes) };
  }

  const isError = lastBoolean(objects, spec.parse?.isError);
  const fieldError = lastString(objects, spec.parse?.error);
  const text = lastString(objects, spec.parse?.text);

  if (exitCode !== 0 || isError === true) {
    const reason = fieldError
      ?? (exitCode !== undefined && exitCode !== 0 ? `The agent exited with code ${exitCode}.` : "The agent reported an error.");
    return { ...base, status: "failed", error: truncate(reason, maxErrorBytes) };
  }

  // Never infer success from pane text; success is exit 0 plus parseable output.
  return {
    ...base,
    status: "completed",
    ...(text ? { summary: truncate(text, maxSummaryBytes) } : {}),
  };
}

async function finishTurn(
  registry: SubagentSessionRegistry,
  session: SubagentSessionV1,
  turn: SubagentTurnV1,
  identity: TurnRunnerIdentity,
  outcome: {
    status: "completed" | "failed";
    exitCode?: number;
    agentSessionId?: string;
    summary?: string;
    error?: string;
    maxSummaryBytes: number;
    maxErrorBytes: number;
    completionDir?: string;
    now: () => Date;
  },
): Promise<TurnRunnerResult> {
  const ownerOptions = identity.owner !== undefined ? { parentPiSessionId: identity.owner } : {};
  const finishedAt = outcome.now().toISOString();
  const payload: SubagentTurnCompletionV1 = {
    version: TURN_COMPLETION_VERSION,
    sessionId: session.sessionId,
    turnId: turn.turnId,
    agent: session.agent,
    status: outcome.status,
    finishedAt,
    ...(outcome.agentSessionId ? { agentSessionId: outcome.agentSessionId } : {}),
    ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
    ...(outcome.status === "completed" && outcome.summary ? { summary: truncate(outcome.summary, outcome.maxSummaryBytes) } : {}),
    ...(outcome.error ? { error: truncate(outcome.error, outcome.maxErrorBytes) } : {}),
  };

  let resultPath: string | undefined;
  try {
    resultPath = await writeCompletionPayload(payload, outcome.completionDir ?? completionDirFor(registry.file));
  } catch (error) {
    // The durable running state is left untouched so reconciliation can mark the
    // turn lost; we never claim a terminal outcome whose payload cannot be read.
    throw new TmuxError(`Could not persist the subagent turn completion payload: ${errorMessage(error)}`, "command_failed");
  }

  // Record the native id before the terminal transition so a later turn can
  // resume the same conversation. A cancelled/terminal session is left as-is.
  if (outcome.agentSessionId) {
    try {
      await registry.setAgentSessionId(session.sessionId, outcome.agentSessionId, ownerOptions);
    } catch {
      /* The native id is advisory; the durable turn outcome still wins. */
    }
  }

  try {
    const updated = await registry.transitionTurn(turn.turnId, outcome.status, {
      ...ownerOptions,
      at: finishedAt,
      ...(resultPath ? { resultPath } : {}),
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    const winningPath = updated.resultPath;
    await discardPayload(resultPath, winningPath);
    return terminalResult(updated, outcome.agentSessionId);
  } catch (transitionError) {
    const latest = await registry.getTurn(turn.turnId).catch(() => undefined);
    if (latest && isTerminalTurnStatus(latest.status)) {
      await discardPayload(resultPath, latest.resultPath);
      return passiveResult(latest, "a racing terminal write won");
    }
    await discardPayload(resultPath, undefined);
    throw transitionError;
  }
}

function terminalResult(turn: SubagentTurnV1, agentSessionId?: string): TurnRunnerResult {
  return {
    status: turn.status,
    passive: false,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    ...(agentSessionId ? { agentSessionId } : {}),
    ...(turn.exitCode !== undefined ? { exitCode: turn.exitCode } : {}),
    ...(turn.resultPath ? { resultPath: turn.resultPath } : {}),
    ...(turn.error ? { error: turn.error } : {}),
  };
}

function passiveResult(turn: SubagentTurnV1, reason: string): TurnRunnerResult {
  return {
    status: turn.status,
    passive: true,
    reason,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    ...(turn.resultPath ? { resultPath: turn.resultPath } : {}),
    ...(turn.error ? { error: turn.error } : {}),
  };
}

/** Best-effort removal of a payload the registry does not reference. */
async function discardPayload(payloadPath: string | undefined, keep: string | undefined): Promise<void> {
  if (!payloadPath || payloadPath === keep) return;
  await rm(payloadPath, { force: true }).catch(() => undefined);
}

async function writeCompletionPayload(payload: SubagentTurnCompletionV1, directory: string): Promise<string> {
  // Unique, immutable filename per attempt: a duplicate runner or a retry never
  // overwrites another attempt's payload, and the registry names the winner.
  const file = path.join(directory, `${payload.turnId}.${randomUUID()}.json`);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(temporary, "w", 0o600);
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new TmuxError(`Could not write the subagent turn completion payload at ${file}: ${errorMessage(error)}`, "command_failed");
  }
  await handle.close();
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new TmuxError(`Could not replace the subagent turn completion payload at ${file}: ${errorMessage(error)}`, "command_failed");
  }
  return file;
}

/**
 * Verifies the durable session/turn/pane/server binding. Throws before any
 * mutation on a mismatch, so a runner loaded with wrong metadata fails closed
 * without touching unrelated state.
 */
async function verifyBinding(registry: SubagentSessionRegistry, identity: TurnRunnerIdentity): Promise<{ session: SubagentSessionV1; turn: SubagentTurnV1 }> {
  const session = await registry.getSession(identity.sessionId);
  if (!session) throw new TmuxError(`Unknown subagent session ${JSON.stringify(identity.sessionId)}.`, "invalid_target");
  if (identity.owner !== undefined && session.parentPiSessionId !== identity.owner) {
    throw new TmuxError(`Subagent session ${session.sessionId} belongs to another Pi conversation; refusing to report.`, "invalid_target");
  }
  if (session.tmuxSessionId === null) {
    throw new TmuxError(`Subagent session ${session.sessionId} is not bound to a tmux target.`, "invalid_option");
  }
  if (session.serverIdentity !== undefined && identity.serverPid !== undefined && session.serverIdentity.split(":")[0] !== identity.serverPid) {
    throw new TmuxError(
      `Subagent session ${session.sessionId} belongs to tmux server ${session.serverIdentity} but this runner runs on server pid ${identity.serverPid}; refusing to report for a restarted or reused server.`,
      "invalid_target",
    );
  }

  const turn = await registry.getTurn(identity.turnId);
  if (!turn) throw new TmuxError(`Unknown subagent turn ${JSON.stringify(identity.turnId)}.`, "invalid_target");
  if (turn.sessionId !== session.sessionId) {
    throw new TmuxError(`Subagent turn ${turn.turnId} belongs to session ${turn.sessionId}, not ${session.sessionId}; refusing to report.`, "invalid_target");
  }
  if (turn.tmuxPaneId === null) {
    throw new TmuxError(`Subagent turn ${turn.turnId} is not bound to a tmux pane.`, "invalid_option");
  }
  if (turn.tmuxPaneId !== identity.paneId) {
    throw new TmuxError(
      `This runner runs in pane ${identity.paneId} but subagent turn ${turn.turnId} is bound to pane ${turn.tmuxPaneId}; refusing to report for a different pane.`,
      "invalid_target",
    );
  }
  return { session, turn };
}

interface ParsedStructured {
  ok: boolean;
  objects: unknown[];
  error: string;
}

function parseStructured(stdout: string, output: "json" | "ndjson"): ParsedStructured {
  const text = stdout.trim();
  if (!text) return { ok: false, objects: [], error: "The agent produced no structured output; completion cannot be established." };
  if (output === "json") {
    try {
      return { ok: true, objects: [JSON.parse(text)], error: "" };
    } catch {
      return parseLines(text, "The agent produced malformed JSON output.");
    }
  }
  return parseLines(text, "The agent produced no parseable NDJSON output.");
}

function parseLines(text: string, emptyError: string): ParsedStructured {
  const objects: unknown[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      objects.push(JSON.parse(line));
    } catch {
      // A single malformed structured line fails the turn: a partial or
      // ambiguous stream is never treated as a completed result.
      return { ok: false, objects, error: "The agent produced a malformed structured output line." };
    }
  }
  if (objects.length === 0) return { ok: false, objects: [], error: emptyError };
  return { ok: true, objects, error: "" };
}

function extractPath(value: unknown, dotPath: string): unknown {
  let current: unknown = value;
  for (const key of dotPath.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else {
      current = (current as Record<string, unknown>)[key];
    }
  }
  return current;
}

function firstString(objects: unknown[], dotPath: string | undefined): string | undefined {
  if (!dotPath) return undefined;
  for (const object of objects) {
    const value = extractPath(object, dotPath);
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function lastString(objects: unknown[], dotPath: string | undefined): string | undefined {
  if (!dotPath) return undefined;
  for (let index = objects.length - 1; index >= 0; index--) {
    const value = extractPath(objects[index], dotPath);
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function lastBoolean(objects: unknown[], dotPath: string | undefined): boolean | undefined {
  if (!dotPath) return undefined;
  for (let index = objects.length - 1; index >= 0; index--) {
    const value = extractPath(objects[index], dotPath);
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function boundedAgentSessionId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_AGENT_SESSION_ID_BYTES) return undefined;
  return value;
}

/** Bounded tail buffer: keeps at most `maxBytes`, dropping the oldest data first. */
function tailBuffer(maxBytes: number): { push(chunk: Buffer | string): void; text(): string; truncated(): boolean } {
  const chunks: Buffer[] = [];
  let kept = 0;
  let total = 0;
  return {
    push(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      chunks.push(buffer);
      kept += buffer.length;
      while (kept > maxBytes && chunks.length > 0) {
        const head = chunks[0]!;
        if (kept - head.length >= maxBytes) {
          chunks.shift();
          kept -= head.length;
        } else {
          const drop = kept - maxBytes;
          chunks[0] = head.subarray(drop);
          kept -= drop;
        }
      }
    },
    text() {
      return Buffer.concat(chunks).toString("utf8").replace(/^\uFFFD+/, "");
    },
    truncated() {
      return total > maxBytes;
    },
  };
}

function isParsePath(value: string): boolean {
  if (!value || value.length > 128) return false;
  return value.split(".").every((segment) => /^[A-Za-z0-9_-]+$/.test(segment));
}

function serverPidFromTmux(tmux: string | undefined): string | undefined {
  if (typeof tmux !== "string") return undefined;
  const pid = tmux.split(",")[1];
  return pid && /^\d+$/.test(pid) ? pid : undefined;
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function requireAbsolutePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || !path.isAbsolute(value)) {
    throw new TmuxError(`${name} must be an absolute path.`, "invalid_option");
  }
  return value;
}

/**
 * Validates an executable reference. The packaged runner requires an absolute
 * path (the adapter has already resolved it); an adapter validating its own
 * unresolved spec may accept a bare PATH command or absolute path, but never a
 * relative path containing a separator.
 */
function requireExecutable(value: unknown, requireAbsolute: boolean): string {
  if (typeof value !== "string" || !value) throw new TmuxError("executable must be a non-empty string.", "invalid_option");
  if (value.includes("\0")) throw new TmuxError("The runner executable must not contain a NUL byte.", "invalid_option");
  if (Buffer.byteLength(value, "utf8") > 4096) throw new TmuxError("The runner executable is longer than 4096 bytes.", "invalid_option");
  if (requireAbsolute && !path.isAbsolute(value)) throw new TmuxError("executable must be an absolute path.", "invalid_option");
  return value;
}

function requireToken(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new TmuxError(`${name} must be a non-empty string of at most ${maxBytes} bytes without NUL.`, "invalid_option");
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TmuxError(`${name} must be a positive integer.`, "invalid_option");
  return value;
}

/** Bounded, code-point-safe truncation by UTF-8 byte length. */
function truncate(text: string, maxBytes: number): string {
  if (!text) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end--;
  return text.slice(0, end);
}

/**
 * CLI entry point for the packaged runner. Reads the explicit environment
 * contract, runs exactly one turn, and reports a process status. It exits 0
 * whenever the turn's durable outcome was recorded (completed or failed);
 * a binding/validation failure exits non-zero without mutating unrelated state.
 */
export async function runTurnCli(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let invocation: RunnerInvocation;
  try {
    invocation = parseRunnerInvocation(env);
  } catch (error) {
    process.stderr.write(`[pi-tmux runner] ${errorMessage(error)}\n`);
    return 2;
  }

  const registry = new SubagentSessionRegistry(invocation.statePath);
  try {
    const result = await runTurn({
      registry,
      spec: invocation.spec,
      task: invocation.task,
      identity: invocation.identity,
      report: (level, message) => process.stderr.write(`[pi-tmux runner] ${level}: ${message}\n`),
    });
    return result.status === "lost" ? 1 : 0;
  } catch (error) {
    process.stderr.write(`[pi-tmux runner] ${errorMessage(error)}\n`);
    return 1;
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry && entry === fileURLToPath(import.meta.url)) {
  runTurnCli().then((code) => process.exit(code)).catch(() => process.exit(1));
}
