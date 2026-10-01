import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Registry } from "./registry.ts";
import type { LiveTargets, PaneTarget, SessionTarget } from "./targets.ts";
import { Tmux, TmuxError, errorMessage } from "./tmux.ts";
import {
  type SubagentJobStatus,
  type SubagentJobV1,
  SubagentJobRegistry,
  isTerminalStatus,
} from "./subagent-jobs.ts";
import { CHILD_REPORTER_ENV } from "./subagent-reporter.ts";

/**
 * Parent-side controller for first-class Pi subagent jobs (issue #3).
 *
 * This is the launching half of the `SubagentJobV1` registry. It deliberately
 * contains no Pi-extension surface so it can be unit-tested directly:
 *
 * - `start` creates a durable job, creates a dedicated detached tmux session it
 *   owns, binds the stable session/pane IDs, launches the packaged child
 *   reporter with explicit job metadata, and returns immediately;
 * - `status` returns the durable lifecycle state and, only when the tmux server
 *   is reachable, reconciles an obviously vanished target to `lost`;
 * - `cancel` transitions exactly one known job to `cancelled` and kills only the
 *   stable tmux target recorded on that job, never a reused or unrelated one.
 *
 * The task text is never interpolated into a shell command. It travels through
 * a tmux session environment variable and is expanded *quoted* by a constant
 * command string, so shell metacharacters in the task cannot be interpreted.
 */

/** Environment variables used to carry launch data into the child pane. */
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

/**
 * The one constant command tmux runs for a Pi subagent. Every substituted value
 * is either a constant path we wrote or an environment variable expanded
 * *inside double quotes*, which the shell cannot re-interpret. The task is not
 * in this string; it is only referenced as `"$PI_TMUX_SUBAGENT_TASK"`.
 */
export const PI_SUBAGENT_LAUNCH_COMMAND = 'exec "$PI_TMUX_PI_BIN" --extension "$PI_TMUX_CHILD_REPORTER" --mode json -p -- "$PI_TMUX_SUBAGENT_TASK"';

export const PI_SUBAGENT_TOOL = "tmux_subagent_start_pi";
export const DEFAULT_PI_COMMAND = "pi";
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_STARTUP_PROBE = { attempts: 3, intervalMs: 150 } as const;
const MAX_TASK_BYTES = 20_000;
const MAX_NAME_LENGTH = 40;
const MODEL_PATTERN = /^[A-Za-z0-9._/@:-]+$/;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const STABLE_SESSION = /^\$\d+$/;
const STABLE_PANE = /^%\d+$/;

export interface DetectParentSessionEnv {
  TMUX?: string;
  TMUX_PANE?: string;
}

/** The subset of `Targets` the controller needs (structural, so tests can stub it). */
export interface PiSubagentTargets {
  session(selector: string, signal?: AbortSignal): Promise<SessionTarget>;
  panes(signal?: AbortSignal): Promise<PaneTarget[]>;
  liveTargets(signal?: AbortSignal): Promise<LiveTargets>;
  serverIdentity(signal?: AbortSignal): Promise<string | undefined>;
}

export interface PiSubagentControllerOptions {
  tmux: Tmux;
  registry: Registry;
  jobs: SubagentJobRegistry;
  targets: PiSubagentTargets;
  /** Resolve a `pi` command to an executable path; defaults to a PATH lookup. */
  resolvePi?: (command: string) => Promise<string | undefined>;
  /** The `pi` command to resolve (default `pi`). */
  piCommand?: string;
  /** Absolute path to the packaged child reporter; defaults to the package path. */
  reporterPath?: string;
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

export interface StartPiSubagentInput {
  cwd: string;
  task: string;
  name?: string;
  /** Optional tmux session the child is being delegated for (provenance only). */
  parent?: string;
  model?: string;
  thinking?: string;
}

export type PiSubagentFailureCode = TmuxError["code"];

export interface PiSubagentFailure {
  ok: false;
  code: PiSubagentFailureCode;
  error: string;
  jobId?: string;
  status?: SubagentJobStatus;
  cleanedUp?: boolean;
}

export interface PiSubagentStartSuccess {
  ok: true;
  jobId: string;
  status: SubagentJobStatus;
  tmuxSessionId: string;
  tmuxPaneId: string;
  name: string;
  cwd: string;
  parentPiSessionId: string;
  serverIdentity?: string;
}

export type PiSubagentStartResult = PiSubagentStartSuccess | PiSubagentFailure;

export type PiSubagentStatusResult =
  | { ok: true; job: SubagentJobV1; targetLive?: boolean; reconciled: boolean; tmuxUnavailable?: boolean }
  | PiSubagentFailure;

export type PiSubagentCancelResult =
  | { ok: true; jobId: string; status: SubagentJobStatus; alreadyTerminal: boolean; targetRemoved: boolean; reason: string }
  | PiSubagentFailure;

export class PiSubagentController {
  private readonly tmux: Tmux;
  private readonly registry: Registry;
  private readonly jobs: SubagentJobRegistry;
  private readonly targets: PiSubagentTargets;
  private readonly resolvePi: (command: string) => Promise<string | undefined>;
  private readonly piCommand: string;
  private readonly reporterPath: string;
  private readonly now: () => Date;
  private readonly startupProbe: { attempts: number; intervalMs: number };
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly maxDepth: number;

  constructor(options: PiSubagentControllerOptions) {
    this.tmux = options.tmux;
    this.registry = options.registry;
    this.jobs = options.jobs;
    this.targets = options.targets;
    this.resolvePi = options.resolvePi ?? resolveExecutable;
    this.piCommand = options.piCommand ?? DEFAULT_PI_COMMAND;
    this.reporterPath = options.reporterPath ?? defaultChildReporterPath();
    this.now = options.now ?? (() => new Date());
    this.startupProbe = options.startupProbe ?? DEFAULT_STARTUP_PROBE;
    this.sleep = options.sleep ?? delay;
    this.env = options.env ?? process.env;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  /**
   * Creates and launches a Pi subagent. Returns as soon as the child is bound to
   * its tmux target (after a short, bounded startup liveness probe); it never
   * waits for the child to finish.
   */
  async start(input: StartPiSubagentInput, parentPiSessionId: string, signal?: AbortSignal): Promise<PiSubagentStartResult> {
    if (typeof parentPiSessionId !== "string" || !parentPiSessionId) {
      return fail("invalid_option", "A non-empty parent Pi session id is required.");
    }

    let cwd: string;
    try {
      cwd = await validateCwd(input?.cwd);
    } catch (error) {
      return fail(codeOf(error), errorMessage(error));
    }
    const taskError = validateTask(input?.task);
    if (taskError) return fail("invalid_option", taskError);
    const task = input.task;
    if (input.name !== undefined) {
      const nameError = validateSubagentName(input.name);
      if (nameError) return fail("invalid_option", nameError);
    }
    if (input.model !== undefined && !MODEL_PATTERN.test(input.model)) {
      return fail("invalid_option", "model must match [A-Za-z0-9._/@:-]+.");
    }
    if (input.thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(input.thinking)) {
      return fail("invalid_option", `thinking must be one of ${THINKING_LEVELS.join(", ")}.`);
    }

    // Recursive-delegation guard: carry this process's own lineage into the child.
    const ancestors = parseAncestorList(this.env[CHILD_REPORTER_ENV.ancestors]);
    const ownJobId = this.env[CHILD_REPORTER_ENV.jobId];
    if (ownJobId && !ancestors.includes(ownJobId)) ancestors.push(ownJobId);
    if (ancestors.length > this.maxDepth) {
      return fail("invalid_option", `Refusing to delegate: the subagent chain already has ${ancestors.length} jobs (max ${this.maxDepth}).`);
    }

    let job: SubagentJobV1;
    try {
      job = await this.jobs.create({ cwd, parentPiSessionId });
    } catch (error) {
      return fail(codeOf(error), errorMessage(error));
    }

    // Preflight the launch contract before any tmux side effect. A failure is
    // recorded on the durable job so the caller has a stable failed outcome.
    if (!(await isFile(this.reporterPath))) {
      return this.startFailure(job.jobId, "unavailable", `The packaged Pi child reporter was not found at ${this.reporterPath}.`);
    }
    if (path.isAbsolute(this.piCommand) && !(await isFile(this.piCommand))) {
      return this.startFailure(job.jobId, "unavailable", `The configured Pi executable ${this.piCommand} does not exist.`);
    }
    let piBin: string | undefined;
    try {
      piBin = await this.resolvePi(this.piCommand);
    } catch (error) {
      return this.startFailure(job.jobId, codeOf(error), `Could not resolve the Pi binary: ${errorMessage(error)}`);
    }
    if (!piBin) {
      return this.startFailure(job.jobId, "unavailable", `The Pi CLI (${this.piCommand}) was not found on PATH; install it or configure it before starting a subagent.`);
    }

    let parentSessionId: string | null = null;
    try {
      parentSessionId = input.parent ? (await this.targets.session(input.parent, signal)).id : await detectParentSession(this.tmux, this.env, signal);
    } catch (error) {
      return this.startFailure(job.jobId, codeOf(error), `Could not resolve the parent tmux session: ${errorMessage(error)}`);
    }

    const name = sessionName(input.name, job.jobId);
    let sessionId: string;
    let paneId: string;
    const createArgs = [
      "new-session", "-d", "-P", "-F", "#{session_id}\t#{pane_id}",
      "-s", name,
      "-c", cwd,
      "-e", `${PI_SUBAGENT_ENV.piBin}=${piBin}`,
      "-e", `${PI_SUBAGENT_ENV.reporter}=${this.reporterPath}`,
      "-e", `${CHILD_REPORTER_ENV.jobId}=${job.jobId}`,
      "-e", `${CHILD_REPORTER_ENV.state}=${this.jobs.file}`,
      "-e", `${CHILD_REPORTER_ENV.parentSessionId}=${parentPiSessionId}`,
      ...(ancestors.length ? ["-e", `${CHILD_REPORTER_ENV.ancestors}=${ancestors.join(",")}`] : []),
      "-e", `${PI_SUBAGENT_ENV.task}=${task}`,
      ...(input.model ? ["-e", `${PI_SUBAGENT_ENV.model}=${input.model}`] : []),
      ...(input.thinking ? ["-e", `${PI_SUBAGENT_ENV.thinking}=${input.thinking}`] : []),
      launchCommand(Boolean(input.model), Boolean(input.thinking)),
    ];
    try {
      const [createdSession, createdPane] = singleRow(await this.tmux.run(createArgs, { signal }), 2);
      if (!createdSession || !STABLE_SESSION.test(createdSession) || !createdPane || !STABLE_PANE.test(createdPane)) {
        throw new TmuxError("tmux created a session but returned an invalid stable ID.", "command_failed");
      }
      sessionId = createdSession;
      paneId = createdPane;
    } catch (error) {
      await this.failJob(job.jobId, `Could not create the subagent tmux session: ${errorMessage(error)}`);
      return { ok: false, code: codeOf(error), error: `Could not create the subagent tmux session: ${errorMessage(error)}`, jobId: job.jobId, status: "failed", cleanedUp: true };
    }

    let serverIdentity: string | undefined;
    try {
      serverIdentity = await this.targets.serverIdentity(signal);
    } catch {
      serverIdentity = undefined; // Provenance/identity is best-effort; the job IDs below are authoritative.
    }

    // Provenance is best-effort: a registry write failure must not hide a session we created.
    try {
      await this.recordSession(sessionId, parentSessionId, name, cwd, parentPiSessionId, serverIdentity);
    } catch { /* The durable job below is the authoritative record. */ }
    try {
      await this.jobs.bind(job.jobId, { tmuxSessionId: sessionId, tmuxPaneId: paneId, ...(serverIdentity ? { serverIdentity } : {}) });
      await this.jobs.transition(job.jobId, "starting");
    } catch (error) {
      const cleanedUp = await this.cleanupSession(sessionId, signal);
      const message = `Could not bind the subagent job to its tmux target: ${errorMessage(error)}`;
      await this.failJob(job.jobId, message);
      return { ok: false, code: codeOf(error), error: message, jobId: job.jobId, status: "failed", cleanedUp };
    }

    // Bounded startup probe: if the child process dies immediately (bad flag,
    // crash), the pane vanishes and we fail the job instead of leaving it
    // "starting" with no live target.
    const alive = await this.probeStartup(paneId, signal);
    if (!alive) {
      await this.cleanupSession(sessionId, signal);
      const message = "The child Pi process exited during startup; the tmux session was cleaned up.";
      await this.failJob(job.jobId, message);
      return { ok: false, code: "command_failed", error: message, jobId: job.jobId, status: "failed", cleanedUp: true };
    }

    return {
      ok: true,
      jobId: job.jobId,
      status: "starting",
      tmuxSessionId: sessionId,
      tmuxPaneId: paneId,
      name,
      cwd,
      parentPiSessionId,
      ...(serverIdentity ? { serverIdentity } : {}),
    };
  }

  /**
   * Returns durable job state. When the tmux server is reachable and a bound,
   * non-terminal job's target is missing (or belongs to a restarted server), the
   * job is reconciled to `lost`. No pane text is ever inspected.
   */
  async status(jobId: string, parentPiSessionId: string, signal?: AbortSignal): Promise<PiSubagentStatusResult> {
    const job = await this.lookup(jobId, parentPiSessionId);
    if ("ok" in job) return job;
    // A terminal outcome is immutable and requires no tmux reconciliation.
    if (isTerminalStatus(job.status)) return { ok: true, job, reconciled: false };

    let view: LiveTargets | undefined;
    try {
      view = await this.targets.liveTargets(signal);
    } catch {
      return { ok: true, job, reconciled: false, tmuxUnavailable: true };
    }

    if (!isTerminalStatus(job.status) && job.tmuxPaneId !== null && view) {
      const identityLost = job.serverIdentity !== undefined
        && view.serverIdentity !== undefined
        && job.serverIdentity !== view.serverIdentity;
      const targetGone = !view.live.has(job.tmuxPaneId)
        && (job.tmuxSessionId === null || !view.live.has(job.tmuxSessionId));
      if (identityLost || targetGone) {
        const reason = identityLost
          ? "The tmux server identity changed; the recorded target no longer exists."
          : "The recorded tmux target no longer exists.";
        const lost = await this.jobs.transition(job.jobId, "lost", { error: reason });
        return { ok: true, job: lost, targetLive: false, reconciled: true };
      }
      return { ok: true, job, targetLive: view.live.has(job.tmuxPaneId), reconciled: false };
    }

    return {
      ok: true,
      job,
      ...(job.tmuxPaneId !== null && view ? { targetLive: view.live.has(job.tmuxPaneId) } : {}),
      reconciled: false,
    };
  }

  /**
   * Cancels exactly one job. The job is moved to `cancelled`, then only the
   * stable tmux session recorded on that job is killed after verifying the
   * server identity and that the recorded pane still belongs to it. A terminal
   * job (including one already cancelled or completed by the child) is returned
   * unchanged, so repeated cancellation is idempotent.
   */
  async cancel(jobId: string, parentPiSessionId: string, signal?: AbortSignal): Promise<PiSubagentCancelResult> {
    const found = await this.lookup(jobId, parentPiSessionId);
    if ("ok" in found) return found;
    const job = found;

    if (isTerminalStatus(job.status)) {
      return { ok: true, jobId: job.jobId, status: job.status, alreadyTerminal: true, targetRemoved: false, reason: `Job is already ${job.status}.` };
    }
    if (job.tmuxSessionId === null || job.tmuxPaneId === null) {
      const cancelled = await this.jobs.transition(job.jobId, "cancelled", { error: "Cancelled before a tmux target was bound." });
      return { ok: true, jobId: job.jobId, status: cancelled.status, alreadyTerminal: false, targetRemoved: false, reason: "No tmux target was bound." };
    }

    let view: LiveTargets | undefined;
    let panes: PaneTarget[];
    try {
      view = await this.targets.liveTargets(signal);
      panes = await this.targets.panes(signal);
    } catch (error) {
      // The server is unreachable: record the user's intent without killing.
      const cancelled = await this.jobs.transition(job.jobId, "cancelled", { error: `Cancelled while the tmux server was unavailable (${errorMessage(error)}); the recorded target was not terminated.` });
      return { ok: true, jobId: job.jobId, status: cancelled.status, alreadyTerminal: false, targetRemoved: false, reason: "tmux server unavailable; recorded target left untouched." };
    }

    if (job.serverIdentity !== undefined && view.serverIdentity !== undefined && job.serverIdentity !== view.serverIdentity) {
      return fail("invalid_target", `Refusing to cancel job ${job.jobId}: its target belonged to tmux server ${job.serverIdentity} but the current server is ${view.serverIdentity}.`, job.jobId);
    }
    const pane = panes.find((item) => item.id === job.tmuxPaneId);
    if (pane && pane.sessionId !== job.tmuxSessionId) {
      return fail("invalid_target", `Refusing to cancel job ${job.jobId}: pane ${job.tmuxPaneId} now belongs to session ${pane.sessionId}, not the recorded ${job.tmuxSessionId}.`, job.jobId);
    }

    const cancelled = await this.jobs.transition(job.jobId, "cancelled");
    const sessionLive = view.live.has(job.tmuxSessionId);
    if (!pane && !sessionLive) {
      return { ok: true, jobId: job.jobId, status: cancelled.status, alreadyTerminal: false, targetRemoved: false, reason: "The recorded tmux target was already gone." };
    }
    await this.tmux.run(["kill-session", "-t", job.tmuxSessionId], { signal });
    await this.registry.forget("session", job.tmuxSessionId).catch(() => 0);
    return { ok: true, jobId: job.jobId, status: cancelled.status, alreadyTerminal: false, targetRemoved: true, reason: "Killed the recorded tmux session." };
  }

  private async lookup(jobId: string, parentPiSessionId: string): Promise<SubagentJobV1 | PiSubagentFailure> {
    if (typeof jobId !== "string" || !jobId) return fail("invalid_option", "A non-empty jobId is required.");
    let job: SubagentJobV1 | undefined;
    try {
      job = await this.jobs.get(jobId);
    } catch (error) {
      return fail(codeOf(error), errorMessage(error));
    }
    if (!job) return fail("invalid_target", `Unknown subagent job ${JSON.stringify(jobId)}.`, jobId);
    if (job.parentPiSessionId !== parentPiSessionId) {
      return fail("invalid_target", `Subagent job ${jobId} belongs to another Pi conversation; refusing to control it.`, jobId);
    }
    return job;
  }

  private async recordSession(sessionId: string, parentSessionId: string | null, name: string, cwd: string, piSessionId: string, serverIdentity: string | undefined): Promise<void> {
    await this.registry.record({
      kind: "session",
      id: sessionId,
      sessionId,
      parentSessionId,
      piSessionId,
      name,
      cwd,
      tool: PI_SUBAGENT_TOOL,
      createdAt: this.now().toISOString(),
      ...(serverIdentity ? { serverIdentity } : {}),
    });
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

  /** Marks the job failed and returns a structured start failure carrying its ID. */
  private async startFailure(jobId: string, code: PiSubagentFailureCode, error: string): Promise<PiSubagentFailure> {
    await this.failJob(jobId, error);
    return { ok: false, code, error, jobId, status: "failed" };
  }

  private async failJob(jobId: string, error: string): Promise<void> {
    try {
      const job = await this.jobs.get(jobId);
      if (job && !isTerminalStatus(job.status)) await this.jobs.transition(jobId, "failed", { error });
    } catch {
      /* Best effort: the job may already be terminal. */
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

/** Resolves the packaged child reporter path relative to this module. */
export function defaultChildReporterPath(): string {
  return fileURLToPath(new URL("../extensions/child-reporter.ts", import.meta.url));
}

/** Detects the tmux session the calling agent runs inside, when tmux reports it. */
export async function detectParentSession(tmux: Tmux, env: DetectParentSessionEnv = process.env, signal?: AbortSignal): Promise<string | null> {
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
 * PATH lookup used by default. Returns an executable path, or `undefined` when
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

function launchCommand(withModel: boolean, withThinking: boolean): string {
  const parts = ['exec "$PI_TMUX_PI_BIN"', '--extension "$PI_TMUX_CHILD_REPORTER"', '--mode json'];
  if (withModel) parts.push('--model "$PI_TMUX_SUBAGENT_MODEL"');
  if (withThinking) parts.push('--thinking "$PI_TMUX_SUBAGENT_THINKING"');
  parts.push('-p -- "$PI_TMUX_SUBAGENT_TASK"');
  return parts.join(" ");
}

function sessionName(name: string | undefined, jobId: string): string {
  const base = (name ?? "").trim().replace(/[\s.:]+/g, "-").replace(/[^A-Za-z0-9_-]/g, "").replace(/^-+|-+$/g, "").slice(0, MAX_NAME_LENGTH);
  return `${base || "pi-subagent"}-${jobId.slice(0, 8)}`;
}

function validateSubagentName(name: unknown): string | undefined {
  if (typeof name !== "string" || !name.trim() || name !== name.trim() || /[\x00-\x1f\x7f]/.test(name)) {
    return "name must be a non-empty trimmed string without control characters.";
  }
  if (name.length > 64) return "name must be at most 64 characters.";
  return undefined;
}

function validateTask(task: unknown): string | undefined {
  if (typeof task !== "string" || !task.trim()) return "task must be a non-empty string.";
  if (task.includes("\0")) return "task must not contain NUL bytes.";
  if (Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES) return `task must be at most ${MAX_TASK_BYTES} bytes.`;
  return undefined;
}

async function validateCwd(value: unknown): Promise<string> {
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

function parseAncestorList(raw: string | undefined): string[] {
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

async function isFile(file: string): Promise<boolean> {
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

function fail(code: PiSubagentFailureCode, error: string, jobId?: string): PiSubagentFailure {
  return { ok: false, code, error, ...(jobId ? { jobId } : {}) };
}

function codeOf(error: unknown): PiSubagentFailureCode {
  return error instanceof TmuxError ? error.code : "command_failed";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
