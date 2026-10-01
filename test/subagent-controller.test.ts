import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentAdapter } from "../src/agent-adapter.ts";
import { Registry } from "../src/registry.ts";
import {
  type CreateSubagentRunInput,
  type SubagentLedger,
  type SubagentLiveView,
  type SubagentRunRecord,
  type SubagentTargets,
  SubagentController,
  isTerminalRunStatus,
  parseAncestorList,
} from "../src/subagent-controller.ts";
import { SessionSubagentLedger } from "../src/subagent-ledgers.ts";
import { SubagentSessionRegistry } from "../src/subagent-sessions.ts";
import type { LiveTargets, PaneTarget, SessionTarget } from "../src/targets.ts";
import { Tmux, TmuxError } from "../src/tmux.ts";

/** In-memory stand-in for one isolated tmux server, supporting both strategies. */
class FakeState {
  serverIdentity: string | undefined = "1:1";
  serverAvailable = true;
  dieOnRespawn = false;
  nextSession = 1;
  nextPane = 1;
  readonly sessions = new Map<string, { id: string; name: string; panes: Set<string>; cwd: string }>();
  readonly paneSession = new Map<string, string>();
  readonly newSessionArgs: string[][] = [];
  readonly newWindowArgs: string[][] = [];
  readonly respawnArgs: string[][] = [];
  readonly killArgs: string[][] = [];
  readonly envBySession = new Map<string, Map<string, string>>();
  readonly commandBySession = new Map<string, string>();
  readonly cwdBySession = new Map<string, string>();
  onRespawn?: (env: Map<string, string>, paneId: string) => void | Promise<void>;

  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) for (const pane of session.panes) this.paneSession.delete(pane);
    this.sessions.delete(sessionId);
  }

  removePane(paneId: string): void {
    const sessionId = this.paneSession.get(paneId);
    if (sessionId) this.sessions.get(sessionId)?.panes.delete(paneId);
    this.paneSession.delete(paneId);
  }
}

class FakeTmux extends Tmux {
  constructor(readonly state: FakeState) {
    super();
  }

  override async run(args: readonly string[]): Promise<string> {
    const command = args[0];
    if (command === "new-session") {
      this.state.newSessionArgs.push([...args]);
      let name = "session";
      let cwd = "/";
      for (let index = 1; index < args.length; index++) {
        if (args[index] === "-s") name = args[++index]!;
        else if (args[index] === "-c") cwd = args[++index]!;
      }
      const sessionId = `$${this.state.nextSession++}`;
      const paneId = `%${this.state.nextPane++}`;
      this.state.sessions.set(sessionId, { id: sessionId, name, panes: new Set([paneId]), cwd });
      this.state.paneSession.set(paneId, sessionId);
      this.state.cwdBySession.set(sessionId, cwd);
      return `${sessionId}\t${paneId}`;
    }
    if (command === "new-window") {
      this.state.newWindowArgs.push([...args]);
      let sessionId = "";
      for (let index = 1; index < args.length; index++) if (args[index] === "-t") sessionId = args[++index]!;
      const paneId = `%${this.state.nextPane++}`;
      this.state.sessions.get(sessionId)?.panes.add(paneId);
      this.state.paneSession.set(paneId, sessionId);
      return paneId;
    }
    if (command === "respawn-pane") {
      this.state.respawnArgs.push([...args]);
      let paneId = "";
      const env = new Map<string, string>();
      for (let index = 1; index < args.length; index++) {
        if (args[index] === "-t") paneId = args[++index]!;
        else if (args[index] === "-e") {
          const pair = args[++index]!;
          const split = pair.indexOf("=");
          env.set(pair.slice(0, split), pair.slice(split + 1));
        }
      }
      const sessionId = this.state.paneSession.get(paneId);
      if (sessionId) {
        this.state.envBySession.set(sessionId, env);
        this.state.commandBySession.set(sessionId, args.at(-1) ?? "");
      }
      if (this.state.onRespawn) await this.state.onRespawn(env, paneId);
      if (this.state.dieOnRespawn && sessionId) this.state.removeSession(sessionId);
      return "";
    }
    if (command === "kill-session") {
      this.state.killArgs.push([...args]);
      this.state.removeSession(args[args.indexOf("-t") + 1]!);
      return "";
    }
    throw new Error(`unexpected tmux command: ${command}`);
  }
}

class FakeTargets implements SubagentTargets {
  constructor(readonly state: FakeState) {}

  async session(selector: string): Promise<SessionTarget> {
    if (selector === "missing") throw new TmuxError(`Target ${selector} was not found.`, "invalid_target");
    return { id: "$50", name: selector, attached: 0, windows: 1 };
  }

  async panes(): Promise<PaneTarget[]> {
    return [...this.state.paneSession].map(([pane, sessionId]) => ({
      id: pane, sessionId, sessionName: "s", windowId: "@1", windowIndex: 0, windowName: "w",
      index: 0, active: true, currentPath: "/tmp", width: 80, height: 24,
    }));
  }

  async liveTargets(): Promise<LiveTargets> {
    if (!this.state.serverAvailable) throw new TmuxError("no server running", "unavailable");
    const live = new Set<string>();
    for (const session of this.state.sessions.values()) {
      live.add(session.id);
      for (const pane of session.panes) live.add(pane);
    }
    return { live, labels: new Map(), serverIdentity: this.state.serverIdentity };
  }

  async serverIdentity(): Promise<string | undefined> {
    return this.state.serverIdentity;
  }
}

/** In-memory one-shot ledger: proves the controller needs no registry or Pi runtime. */
class FakeLedger implements SubagentLedger {
  readonly kind = "job" as const;
  readonly tmuxStrategy = "respawn-pane" as const;
  readonly file = "/fake/ledger.json";
  private readonly runs = new Map<string, SubagentRunRecord>();
  private counter = 0;

  async createRun(input: CreateSubagentRunInput): Promise<SubagentRunRecord> {
    const runId = `run-${++this.counter}`;
    const run: SubagentRunRecord = {
      runId, sessionId: runId, agent: input.agent, owner: input.owner, cwd: input.cwd,
      status: "created", tmuxSessionId: null, tmuxPaneId: null, createdAt: new Date().toISOString(),
    };
    this.runs.set(runId, run);
    return { ...run };
  }

  async bindRun(runId: string, input: { tmuxSessionId: string; tmuxPaneId: string; serverIdentity?: string }): Promise<SubagentRunRecord> {
    const run = this.require(runId);
    run.tmuxSessionId = input.tmuxSessionId;
    run.tmuxPaneId = input.tmuxPaneId;
    if (input.serverIdentity) run.serverIdentity = input.serverIdentity;
    return { ...run };
  }

  async transitionRun(runId: string, status: SubagentRunRecord["status"], options: { error?: string; exitCode?: number; resultPath?: string } = {}): Promise<SubagentRunRecord> {
    const run = this.require(runId);
    if (run.status === status) return { ...run };
    if (isTerminalRunStatus(run.status)) throw new TmuxError(`Run ${runId} is already terminal.`, "invalid_option");
    run.status = status;
    if (options.error) run.error = options.error;
    if (options.exitCode !== undefined) run.exitCode = options.exitCode;
    if (options.resultPath) run.resultPath = options.resultPath;
    if (status === "starting") run.startedAt = new Date().toISOString();
    if (isTerminalRunStatus(status)) run.finishedAt = new Date().toISOString();
    return { ...run };
  }

  async cancelRun(runId: string, options: { error?: string } = {}): Promise<SubagentRunRecord> {
    return this.transitionRun(runId, "cancelled", options);
  }

  async getRun(runId: string): Promise<SubagentRunRecord | undefined> {
    const run = this.runs.get(runId);
    return run ? { ...run } : undefined;
  }

  async reconcileRuns(view: SubagentLiveView, options: { owner?: string } = {}): Promise<SubagentRunRecord[]> {
    const changed: SubagentRunRecord[] = [];
    for (const run of this.runs.values()) {
      if (isTerminalRunStatus(run.status)) continue;
      if (options.owner !== undefined && run.owner !== options.owner) continue;
      const targetId = run.tmuxPaneId ?? run.tmuxSessionId;
      if (targetId === null) continue;
      const identityLost = view.serverIdentity !== undefined && run.serverIdentity !== undefined && run.serverIdentity !== view.serverIdentity;
      if (!identityLost && view.live.has(targetId)) continue;
      run.status = "lost";
      run.finishedAt ??= new Date().toISOString();
      changed.push({ ...run });
    }
    return changed;
  }

  private require(runId: string): SubagentRunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new TmuxError(`Unknown run ${runId}.`, "invalid_target");
    return run;
  }
}

interface FakeAdapterOptions {
  preflight?: { ok: false; code: TmuxError["code"]; error: string };
  supportsInteractive?: boolean;
}

function fakeAdapter(options: FakeAdapterOptions = {}): AgentAdapter {
  return {
    agent: "claude-code",
    sessionNamePrefix: "fake-subagent",
    provenanceTool: "tmux_subagent_start_claude-code",
    placeholderCommand: "exec sleep 3600",
    supportsInteractive: options.supportsInteractive ?? true,
    validateOptions: (input) => (input.model === "bad model" ? "model invalid" : undefined),
    lineage: (env) => parseAncestorList(env.FAKE_ANCESTORS),
    async preflight() {
      return options.preflight ?? { ok: true, env: { FAKE_BIN: "/fake/claude", FAKE_REPORTER: "/fake/reporter" } };
    },
    async preflightInteractive() {
      return options.preflight ?? { ok: true, env: { FAKE_BIN: "/fake/claude" } };
    },
    async prepareInteractive(input) {
      const env: Record<string, string> = {};
      if (input.model !== undefined) env.FAKE_MODEL = input.model;
      return { command: 'exec "$FAKE_BIN" --tui', env };
    },
    async prepareTurn(input, context) {
      return {
        command: 'exec "$FAKE_BIN" --reporter "$FAKE_REPORTER" -p -- "$FAKE_TASK"',
        env: {
          FAKE_TASK: input.task,
          FAKE_RUN: context.runId,
          FAKE_OWNER: context.owner,
          ...(context.ancestors.length ? { FAKE_ANCESTORS: context.ancestors.join(",") } : {}),
        },
        completion: { strategy: "native-reporter" as const },
      };
    },
  };
}

interface Harness {
  dir: string;
  state: FakeState;
  tmux: FakeTmux;
  registry: Registry;
  ledger: FakeLedger;
  controller: SubagentController;
  close: () => Promise<void>;
}

async function makeHarness(overrides: { adapter?: AgentAdapter; maxDepth?: number; env?: NodeJS.ProcessEnv } = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "subagent-controller-"));
  const state = new FakeState();
  const tmux = new FakeTmux(state);
  const registry = new Registry(path.join(dir, "registry.json"));
  const ledger = new FakeLedger();
  const controller = new SubagentController({
    tmux, registry, targets: new FakeTargets(state),
    adapter: overrides.adapter ?? fakeAdapter(),
    ledger,
    startupProbe: { attempts: 0, intervalMs: 0 },
    ...(overrides.maxDepth !== undefined ? { maxDepth: overrides.maxDepth } : {}),
    ...(overrides.env ? { env: overrides.env } : {}),
  });
  return { dir, state, tmux, registry, ledger, controller, close: () => rm(dir, { recursive: true, force: true }) };
}

test("a fake adapter drives the generic controller without any Pi runtime and never interpolates the task", async () => {
  const h = await makeHarness();
  try {
    const cwd = await realpath(h.dir);
    const task = `do it; rm -rf /tmp/pwned && echo "$(whoami)" \`id\`\nsecond line`;
    const result = await h.controller.start({ cwd: h.dir, task, name: "worker" }, "parent-a");
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    if (!result.ok) return;
    assert.equal(result.status, "starting");
    assert.match(result.runId, /^run-\d+$/);
    assert.equal(result.tmuxSessionId, "$1");
    assert.equal(result.tmuxPaneId, "%1");

    const run = await h.ledger.getRun(result.runId);
    assert.equal(run?.status, "starting");
    assert.equal(run?.tmuxSessionId, "$1");
    assert.equal(run?.cwd, cwd);
    assert.equal(run?.owner, "parent-a");

    // the session starts inert
    assert.equal(h.state.newSessionArgs[0]!.at(-1), "exec sleep 3600");
    assert.ok(!h.state.newSessionArgs[0]!.some((arg) => arg.includes("rm -rf")));

    const env = h.state.envBySession.get("$1")!;
    assert.equal(env.get("FAKE_TASK"), task, "the task is delivered verbatim through the environment");
    const command = h.state.commandBySession.get("$1")!;
    for (const fragment of ["rm -rf", "whoami", "second line", "id"]) assert.ok(!command.includes(fragment), command);
    assert.match(command, /"\$FAKE_TASK"/, "the task is referenced as a quoted environment variable");

    const provenance = (await h.registry.list()).find((entry) => entry.id === "$1");
    assert.equal(provenance?.tool, "tmux_subagent_start_claude-code", "the adapter's provenance tool is used");
    assert.equal(provenance?.piSessionId, "parent-a");
  } finally {
    await h.close();
  }
});

test("the child can never observe an unbound run: the launch happens after the durable starting transition", async () => {
  const h = await makeHarness();
  try {
    let observed: SubagentRunRecord | undefined;
    h.state.onRespawn = async (env) => {
      observed = await h.ledger.getRun(env.get("FAKE_RUN")!);
    };
    const result = await h.controller.start({ cwd: h.dir, task: "task" }, "parent-a");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(observed, "the launch command ran");
    assert.equal(observed!.status, "starting", "the child only starts after the durable starting transition");
    assert.equal(observed!.tmuxPaneId, result.tmuxPaneId);
  } finally {
    await h.close();
  }
});

test("status reconciles a vanished target to lost and never rewrites another owner's run", async () => {
  const h = await makeHarness();
  try {
    const started = await h.controller.start({ cwd: h.dir, task: "task" }, "parent-a");
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const live = await h.controller.status(started.runId, "parent-a");
    assert.equal(live.ok, true);
    if (!live.ok) return;
    assert.equal(live.run.status, "starting");
    assert.equal(live.targetLive, true);
    assert.equal(live.reconciled, false);

    // A different parent can neither read nor reconcile this run.
    const foreign = await h.controller.status(started.runId, "parent-b");
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.equal(foreign.code, "invalid_target");
    assert.equal((await h.ledger.getRun(started.runId))?.status, "starting", "another parent cannot mutate the run");

    h.state.removeSession("$1");
    const gone = await h.controller.status(started.runId, "parent-a");
    assert.equal(gone.ok, true);
    if (!gone.ok) return;
    assert.equal(gone.run.status, "lost");
    assert.equal(gone.reconciled, true);
  } finally {
    await h.close();
  }
});

test("status leaves durable state untouched while the tmux server is unreachable", async () => {
  const h = await makeHarness();
  try {
    const started = await h.controller.start({ cwd: h.dir, task: "task" }, "parent-a");
    assert.equal(started.ok, true);
    if (!started.ok) return;
    h.state.serverAvailable = false;
    const result = await h.controller.status(started.runId, "parent-a");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.tmuxUnavailable, true);
    assert.equal(result.run.status, "starting");
  } finally {
    await h.close();
  }
});

test("cancel kills only a positively re-verified target and is idempotent", async () => {
  const h = await makeHarness();
  try {
    const started = await h.controller.start({ cwd: h.dir, task: "task" }, "parent-a");
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const cancelled = await h.controller.cancel(started.runId, "parent-a");
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.targetRemoved, true);
    assert.deepEqual(h.state.killArgs.at(-1), ["kill-session", "-t", "$1"]);

    const repeat = await h.controller.cancel(started.runId, "parent-a");
    assert.equal(repeat.ok, true);
    if (!repeat.ok) return;
    assert.equal(repeat.alreadyTerminal, true);
    assert.equal(h.state.killArgs.length, 1, "a terminal run is never killed again");
  } finally {
    await h.close();
  }
});

test("cancel fails closed when the server identity changed, is missing, or the pane belongs to another session", async () => {
  // Changed identity.
  const changed = await makeHarness();
  try {
    const started = await changed.controller.start({ cwd: changed.dir, task: "task" }, "parent-a");
    assert.equal(started.ok, true);
    if (!started.ok) return;
    changed.state.serverIdentity = "2:2";
    const cancelled = await changed.controller.cancel(started.runId, "parent-a");
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.targetRemoved, false);
    assert.equal(changed.state.killArgs.length, 0);
    assert.match(cancelled.reason, /current server is 2:2/);
  } finally {
    await changed.close();
  }

  // No recorded identity.
  const noIdentity = await makeHarness();
  try {
    const run = await noIdentity.ledger.createRun({ agent: "claude-code", cwd: noIdentity.dir, owner: "parent-a" });
    await noIdentity.ledger.bindRun(run.runId, { tmuxSessionId: "$1", tmuxPaneId: "%1" });
    await noIdentity.ledger.transitionRun(run.runId, "starting");
    noIdentity.state.sessions.set("$1", { id: "$1", name: "s", panes: new Set(["%1"]), cwd: "/" });
    noIdentity.state.paneSession.set("%1", "$1");
    const cancelled = await noIdentity.controller.cancel(run.runId, "parent-a");
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.targetRemoved, false);
    assert.match(cancelled.reason, /no recorded tmux server identity/);
  } finally {
    await noIdentity.close();
  }

  // Pane reused by another session.
  const reused = await makeHarness();
  try {
    const started = await reused.controller.start({ cwd: reused.dir, task: "task" }, "parent-a");
    assert.equal(started.ok, true);
    if (!started.ok) return;
    reused.state.paneSession.set("%1", "$999");
    const cancelled = await reused.controller.cancel(started.runId, "parent-a");
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.targetRemoved, false);
    assert.equal(reused.state.killArgs.length, 0);
    assert.match(cancelled.reason, /now belongs to session/);
  } finally {
    await reused.close();
  }
});

test("a failing adapter preflight fails the run before any tmux session is created", async () => {
  const h = await makeHarness({ adapter: fakeAdapter({ preflight: { ok: false, code: "unavailable", error: "no executor" } }) });
  try {
    const result = await h.controller.start({ cwd: h.dir, task: "task" }, "parent-a");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unavailable");
    assert.ok(result.runId, "the durable run id is reported");
    assert.equal((await h.ledger.getRun(result.runId!))?.status, "failed");
    assert.deepEqual(h.state.newSessionArgs, []);
  } finally {
    await h.close();
  }
});

test("invalid input and an over-deep lineage are rejected before any tmux effect", async () => {
  const h = await makeHarness();
  try {
    const relative = await h.controller.start({ cwd: "relative", task: "task" }, "parent-a");
    assert.equal(relative.ok, false);
    const badModel = await h.controller.start({ cwd: h.dir, task: "task", model: "bad model" }, "parent-a");
    assert.equal(badModel.ok, false);
    assert.deepEqual(h.state.newSessionArgs, []);
  } finally {
    await h.close();
  }

  const deep = await makeHarness({ maxDepth: 1, env: { FAKE_ANCESTORS: "a,b" } as NodeJS.ProcessEnv });
  try {
    const result = await deep.controller.start({ cwd: deep.dir, task: "task" }, "parent-a");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_option");
    assert.deepEqual(deep.state.newSessionArgs, []);
  } finally {
    await deep.close();
  }
});

test("a fast terminal run is reported as completed rather than an early-exit failure", async () => {
  const h = await makeHarness();
  try {
    // Bind, then immediately settle before the probe runs.
    h.state.onRespawn = async (env) => {
      await h.ledger.transitionRun(env.get("FAKE_RUN")!, "running");
      await h.ledger.transitionRun(env.get("FAKE_RUN")!, "completed", { exitCode: 0 });
      h.state.removeSession("$1");
    };
    const controller = new SubagentController({
      tmux: h.tmux, registry: h.registry, targets: new FakeTargets(h.state),
      adapter: fakeAdapter(), ledger: h.ledger,
      startupProbe: { attempts: 2, intervalMs: 1 }, sleep: async () => undefined,
    });
    const result = await controller.start({ cwd: h.dir, task: "fast" }, "parent-a");
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    if (!result.ok) return;
    assert.equal(result.status, "completed");
    assert.equal(h.state.killArgs.length, 0, "an already-gone completed session is not killed");
  } finally {
    await h.close();
  }
});

test("a logical session executes turn A to completion and then turn B without concurrent turns", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "subagent-multiturn-"));
  const state = new FakeState();
  const tmux = new FakeTmux(state);
  const registry = new Registry(path.join(dir, "registry.json"));
  const sessions = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
  const ledger = new SessionSubagentLedger(sessions, "claude-code");
  const controller = new SubagentController({
    tmux, registry, targets: new FakeTargets(state),
    adapter: fakeAdapter(), ledger,
    startupProbe: { attempts: 0, intervalMs: 0 },
  });
  try {
    const first = await controller.start({ cwd: dir, task: "turn A" }, "parent-a");
    assert.equal(first.ok, true, first.ok ? "" : first.error);
    if (!first.ok) return;
    assert.equal(first.status, "starting");
    const sessionId = first.sessionId;
    assert.equal(state.envBySession.get(first.tmuxSessionId)?.get("FAKE_TASK"), "turn A");

    // Turn A reaches a terminal outcome; the session must return to idle.
    await sessions.transitionTurn(first.runId, "running");
    await sessions.transitionTurn(first.runId, "completed", { exitCode: 0 });
    assert.equal((await sessions.getSession(sessionId))?.status, "idle", "a terminal turn returns the session to idle");

    // A second turn on the same logical session, in a new window.
    const second = await controller.runTurn(sessionId, { cwd: dir, task: "turn B" }, "parent-a");
    assert.equal(second.ok, true, second.ok ? "" : second.error);
    if (!second.ok) return;
    assert.equal(second.sessionId, sessionId, "turn B stays in the same logical session");
    assert.equal(second.tmuxSessionId, first.tmuxSessionId, "the stable session boundary is reused");
    assert.notEqual(second.tmuxPaneId, first.tmuxPaneId);
    assert.equal(second.turnIndex, 2);
    assert.equal(state.envBySession.get(first.tmuxSessionId)?.get("FAKE_TASK"), "turn B");

    await sessions.transitionTurn(second.runId, "running");
    const turns = await sessions.listTurns({ sessionId });
    assert.equal(turns.length, 2);
    assert.equal(turns[0]!.status, "completed", "the terminal turn A outcome is immutable");
    assert.equal(turns[1]!.status, "running");
  } finally {
    const all = await sessions.listTurns();
    const active = all.find((turn) => turn.status === "running" || turn.status === "starting" || turn.status === "queued");
    if (active) await controller.cancel(active.turnId, "parent-a").catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("runTurn rejects a concurrent turn and a one-shot ledger", async () => {
  const oneShot = await makeHarness();
  try {
    const started = await oneShot.controller.start({ cwd: oneShot.dir, task: "task" }, "parent-a");
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const rejected = await oneShot.controller.runTurn(started.sessionId, { cwd: oneShot.dir, task: "second" }, "parent-a");
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "invalid_option");
  } finally {
    await oneShot.close();
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "subagent-multiturn-"));
  const state = new FakeState();
  const sessions = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
  const controller = new SubagentController({
    tmux: new FakeTmux(state), registry: new Registry(path.join(dir, "registry.json")),
    targets: new FakeTargets(state), adapter: fakeAdapter(), ledger: new SessionSubagentLedger(sessions, "claude-code"),
    startupProbe: { attempts: 0, intervalMs: 0 },
  });
  try {
    const first = await controller.start({ cwd: dir, task: "turn A" }, "parent-a");
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const concurrent = await controller.runTurn(first.sessionId, { cwd: dir, task: "turn B" }, "parent-a");
    assert.equal(concurrent.ok, false);
    if (!concurrent.ok) assert.equal(concurrent.code, "invalid_option");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Issue #15: interactive TUI mode ----------------------------------------

interface SessionHarness {
  dir: string;
  state: FakeState;
  tmux: FakeTmux;
  sessions: SubagentSessionRegistry;
  controller: SubagentController;
  close: () => Promise<void>;
}

async function makeSessionHarness(overrides: { adapter?: AgentAdapter; startupProbe?: { attempts: number; intervalMs: number } } = {}): Promise<SessionHarness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "subagent-interactive-"));
  const state = new FakeState();
  const tmux = new FakeTmux(state);
  const sessions = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
  const controller = new SubagentController({
    tmux,
    registry: new Registry(path.join(dir, "registry.json")),
    targets: new FakeTargets(state),
    adapter: overrides.adapter ?? fakeAdapter(),
    ledger: new SessionSubagentLedger(sessions, "claude-code"),
    startupProbe: overrides.startupProbe ?? { attempts: 0, intervalMs: 0 },
    sleep: async () => undefined,
  });
  return { dir, state, tmux, sessions, controller, close: () => rm(dir, { recursive: true, force: true }) };
}

test("interactive create launches the TUI in the owned pane, stays interactive, and refuses turns", async () => {
  const h = await makeSessionHarness();
  try {
    const created = await h.controller.createInteractiveSession({ agent: "claude-code", cwd: h.dir, task: "", model: "sonnet" }, "parent-a");
    assert.equal(created.ok, true, created.ok ? "" : created.error);
    if (!created.ok) return;
    assert.equal(created.status, "interactive");
    assert.equal(created.mode, "interactive");
    assert.equal(created.tmuxSessionId, "$1");
    assert.equal(created.tmuxPaneId, "%1");

    // The TUI command is constant and carries only quoted env expansions; the
    // task never appears in it.
    const command = h.state.commandBySession.get("$1")!;
    assert.equal(command, 'exec "$FAKE_BIN" --tui');
    assert.equal(h.state.envBySession.get("$1")?.get("FAKE_MODEL"), "sonnet");
    const inert = h.state.newSessionArgs[0]!;
    assert.equal(inert.at(-1), "exec sleep 3600", "the pane starts inert before the TUI launch");

    // Durable state is interactive with the bound pane; no turn exists.
    const session = await h.sessions.getSession(created.sessionId);
    assert.equal(session?.status, "interactive");
    assert.equal(session?.mode, "interactive");
    assert.equal(session?.tmuxPaneId, "%1");
    assert.deepEqual(await h.sessions.listTurns({ sessionId: created.sessionId }), []);

    // Running turns on an interactive session is refused.
    const run = await h.controller.runTurn(created.sessionId, { cwd: h.dir, task: "x" }, "parent-a");
    assert.equal(run.ok, false);
    if (!run.ok) assert.equal(run.code, "invalid_option");
    const cancel = await h.controller.cancelTurn(created.sessionId, "parent-a");
    assert.equal(cancel.ok, false);
    if (!cancel.ok) assert.equal(cancel.code, "invalid_option");

    // Status reports interactive and reconciles a vanished TUI pane to lost.
    const live = await h.controller.statusSession(created.sessionId, "parent-a");
    assert.equal(live.ok, true);
    if (!live.ok) return;
    assert.equal(live.session.status, "interactive");
    assert.equal(live.session.mode, "interactive");
    assert.equal(live.session.tmuxPaneId, "%1");

    h.state.removePane("%1");
    const gone = await h.controller.statusSession(created.sessionId, "parent-a");
    assert.equal(gone.ok, true);
    if (gone.ok) {
      assert.equal(gone.session.status, "lost", "a vanished interactive pane reconciles to lost");
      assert.equal(gone.reconciled, true);
    }
  } finally {
    await h.close();
  }
});

test("interactive close stops the session and tears down only the verified target", async () => {
  const h = await makeSessionHarness();
  try {
    const created = await h.controller.createInteractiveSession({ agent: "claude-code", cwd: h.dir, task: "" }, "parent-a");
    assert.equal(created.ok, true, created.ok ? "" : created.error);
    if (!created.ok) return;
    const closed = await h.controller.closeSession(created.sessionId, "parent-a");
    assert.equal(closed.ok, true, closed.ok ? "" : closed.error);
    if (!closed.ok) return;
    assert.equal(closed.status, "stopped");
    assert.equal(closed.targetRemoved, true);
    assert.deepEqual(h.state.killArgs.at(-1), ["kill-session", "-t", "$1"]);

    const repeat = await h.controller.closeSession(created.sessionId, "parent-a");
    assert.equal(repeat.ok, true);
    if (repeat.ok) assert.equal(repeat.alreadyClosed, true, "close is idempotent");
    assert.equal(h.state.killArgs.length, 1);
  } finally {
    await h.close();
  }
});

test("interactive create rejects an adapter without interactive support and an exited TUI cleans up", async () => {
  const unsupported = await makeSessionHarness({ adapter: fakeAdapter({ supportsInteractive: false }) });
  try {
    const created = await unsupported.controller.createInteractiveSession({ agent: "claude-code", cwd: unsupported.dir, task: "" }, "parent-a");
    assert.equal(created.ok, false);
    if (!created.ok) assert.equal(created.code, "invalid_option");
    assert.deepEqual(unsupported.state.newSessionArgs, [], "nothing is created for an unsupported adapter");
  } finally {
    await unsupported.close();
  }

  const exited = await makeSessionHarness({ startupProbe: { attempts: 1, intervalMs: 0 } });
  try {
    exited.state.onRespawn = () => { exited.state.removePane("%1"); };
    const created = await exited.controller.createInteractiveSession({ agent: "claude-code", cwd: exited.dir, task: "" }, "parent-a");
    assert.equal(created.ok, false);
    if (!created.ok) assert.equal(created.code, "command_failed");
    assert.deepEqual(exited.state.killArgs.at(-1), ["kill-session", "-t", "$1"], "an exited TUI is cleaned up");
  } finally {
    await exited.close();
  }
});

test("turns remains the default mode and an interactive session never becomes idle", async () => {
  const h = await makeSessionHarness();
  try {
    const created = await h.controller.createSession({ agent: "claude-code", cwd: h.dir, task: "" }, "parent-a");
    assert.equal(created.ok, true, created.ok ? "" : created.error);
    if (!created.ok) return;
    assert.equal(created.mode, "turns");
    assert.equal(created.status, "idle");
    assert.equal(created.tmuxPaneId, undefined);
    assert.equal((await h.sessions.getSession(created.sessionId))?.mode, "turns");

    const interactive = await h.controller.createInteractiveSession({ agent: "claude-code", cwd: h.dir, task: "" }, "parent-a");
    assert.equal(interactive.ok, true, interactive.ok ? "" : interactive.error);
    if (!interactive.ok) return;
    await assert.rejects(h.sessions.transitionSession(interactive.sessionId, "idle", { parentPiSessionId: "parent-a" }), /Illegal transition|never becomes idle/);
  } finally {
    await h.close();
  }
});
