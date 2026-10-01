import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PiSubagentController,
  type PiSubagentControllerOptions,
  type PiSubagentTargets,
} from "../src/pi-subagent.ts";
import { Registry } from "../src/registry.ts";
import { SubagentJobRegistry, type SubagentJobV1 } from "../src/subagent-jobs.ts";
import type { LiveTargets, PaneTarget, SessionTarget } from "../src/targets.ts";
import { Tmux, TmuxError } from "../src/tmux.ts";

/** In-memory stand-in for one isolated tmux server. */
class FakeState {
  serverIdentity: string | undefined = "1:1";
  serverAvailable = true;
  dieOnRespawn = false;
  nextSession = 1;
  nextPane = 1;
  readonly sessions = new Map<string, { id: string; name: string; panes: Set<string> }>();
  readonly paneSession = new Map<string, string>();
  readonly newSessionArgs: string[][] = [];
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
      this.state.sessions.set(sessionId, { id: sessionId, name, panes: new Set([paneId]) });
      this.state.paneSession.set(paneId, sessionId);
      this.state.cwdBySession.set(sessionId, cwd);
      return `${sessionId}\t${paneId}`;
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

class FakeTargets implements PiSubagentTargets {
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

interface Harness {
  dir: string;
  state: FakeState;
  tmux: FakeTmux;
  registry: Registry;
  jobs: SubagentJobRegistry;
  reporterPath: string;
  controller: PiSubagentController;
  close: () => Promise<void>;
}

async function makeHarness(overrides: Partial<PiSubagentControllerOptions> = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const state = new FakeState();
  const tmux = new FakeTmux(state);
  const targets = new FakeTargets(state);
  const registry = new Registry(path.join(dir, "registry.json"));
  const jobs = overrides.jobs ?? new SubagentJobRegistry(path.join(dir, "jobs.json"));
  const reporterPath = path.join(dir, "child-reporter.ts");
  await writeFile(reporterPath, "// packaged reporter stand-in\n");
  const controller = new PiSubagentController({
    tmux,
    registry,
    jobs,
    targets,
    reporterPath,
    resolvePi: async (command) => `/fake/bin/${command}`,
    startupProbe: { attempts: 0, intervalMs: 0 },
    ...overrides,
  });
  return { dir, state, tmux, registry, jobs, reporterPath, controller, close: () => rm(dir, { recursive: true, force: true }) };
}

test("start creates a durable job, binds stable tmux IDs, and delivers the task outside the shell command", async () => {
  const h = await makeHarness();
  try {
    const cwd = await realpath(h.dir);
    const result = await h.controller.start({ cwd: h.dir, task: "implement the thing", name: "worker" }, "pi-parent");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.status, "starting", "start returns immediately in the starting state");
    assert.match(result.jobId, /^[0-9a-f-]{36}$/);
    assert.equal(result.parentPiSessionId, "pi-parent");
    assert.match(result.tmuxSessionId, /^\$\d+$/);
    assert.match(result.tmuxPaneId, /^%\d+$/);

    const job = await h.jobs.get(result.jobId);
    assert.equal(job?.status, "starting");
    assert.equal(job?.tmuxSessionId, result.tmuxSessionId, "the stable session ID is recorded on the durable job");
    assert.equal(job?.tmuxPaneId, result.tmuxPaneId, "the stable pane ID is recorded on the durable job");
    assert.equal(job?.cwd, cwd);
    assert.equal(job?.parentPiSessionId, "pi-parent");

    const provenance = (await h.registry.list()).find((entry) => entry.id === result.tmuxSessionId);
    assert.equal(provenance?.tool, "tmux_subagent_start_pi");
    assert.equal(provenance?.piSessionId, "pi-parent");
    assert.equal(provenance?.serverIdentity, "1:1");

    const env = h.state.envBySession.get(result.tmuxSessionId)!;
    assert.equal(env.get("PI_TMUX_SUBAGENT_JOB_ID"), result.jobId);
    assert.equal(env.get("PI_TMUX_SUBAGENT_STATE"), h.jobs.file);
    assert.equal(env.get("PI_TMUX_PARENT_SESSION_ID"), "pi-parent");
    assert.equal(env.get("PI_TMUX_SUBAGENT_TASK"), "implement the thing");
    assert.equal(env.get("PI_TMUX_CHILD_REPORTER"), h.reporterPath, "the packaged child reporter is always loaded");

    const command = h.state.commandBySession.get(result.tmuxSessionId)!;
    assert.match(command, /--extension "\$PI_TMUX_CHILD_REPORTER"/);
    assert.match(command, /-p -- "\$PI_TMUX_SUBAGENT_TASK"/, "the task is referenced as a quoted environment variable, not inline");
    assert.ok(!command.includes("implement the thing"), "the task text must never appear in the shell command");
    assert.equal(h.state.cwdBySession.get(result.tmuxSessionId), cwd);
  } finally {
    await h.close();
  }
});

test("Pi cannot start until the job is durably bound and starting", async () => {
  const h = await makeHarness();
  try {
    let observed: SubagentJobV1 | undefined;
    h.state.onRespawn = async (env) => {
      observed = await h.jobs.get(env.get("PI_TMUX_SUBAGENT_JOB_ID")!);
    };
    const result = await h.controller.start({ cwd: h.dir, task: "task" }, "pi-parent");
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.ok(observed, "the launch command ran");
    assert.equal(observed!.status, "starting", "the child only starts after the durable starting transition");
    assert.equal(observed!.tmuxSessionId, result.tmuxSessionId);
    assert.equal(observed!.tmuxPaneId, result.tmuxPaneId);

    const placeholder = h.state.newSessionArgs[0]!;
    assert.equal(placeholder.at(-1), "exec sleep 3600", "the session starts inert");
    assert.ok(!placeholder.some((arg) => arg.startsWith("PI_TMUX_SUBAGENT_TASK=")), "the task is not present before the gate opens");
    assert.equal(h.state.respawnArgs.length, 1, "the real launch is a respawn after the transition");
  } finally {
    await h.close();
  }
});

test("start reports the actual completed status when a fast child settles before the probe", async () => {
  const h = await makeHarness({ startupProbe: { attempts: 2, intervalMs: 1 }, sleep: async () => undefined });
  try {
    h.state.onRespawn = async (env, paneId) => {
      const jobId = env.get("PI_TMUX_SUBAGENT_JOB_ID")!;
      await h.jobs.transition(jobId, "running");
      await h.jobs.transition(jobId, "completed", { exitCode: 0 });
      h.state.removeSession(h.state.paneSession.get(paneId)!); // tmux removes the session when Pi exits
    };
    const result = await h.controller.start({ cwd: h.dir, task: "fast task" }, "pi-parent");
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    if (!result.ok) return;
    assert.equal(result.status, "completed", "a terminal completed job is a success, not an early-exit failure");
    assert.equal((await h.jobs.get(result.jobId))?.status, "completed");
    assert.equal(h.state.killArgs.length, 0, "a completed job's already-gone session is not killed or failed");
  } finally {
    await h.close();
  }
});

test("start fails (and cleans up) when the tmux server identity is unavailable", async () => {
  const h = await makeHarness();
  try {
    h.state.serverIdentity = undefined; // identity cannot be derived, so cancel could never verify a target
    const result = await h.controller.start({ cwd: h.dir, task: "task" }, "pi-parent");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unavailable");
    assert.equal(result.status, "failed");
    assert.equal(h.state.newSessionArgs.length, 1, "the session is created before the identity is derived");
    assert.equal(h.state.respawnArgs.length, 0, "the child is never launched without a verifiable identity");
    assert.equal(h.state.killArgs.length, 1, "the just-created session is cleaned up");
    assert.equal((await h.jobs.get(result.jobId!))?.status, "failed");
    assert.match(result.error, /server identity/);
  } finally {
    await h.close();
  }
});

test("the task is delivered verbatim and is never interpreted by the shell", async () => {
  const h = await makeHarness();
  try {
    const task = `'; rm -rf /tmp/pwned; echo "$(whoami)" \`id\`\nsecond line --verify`;
    const result = await h.controller.start({ cwd: h.dir, task }, "pi-parent");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const env = h.state.envBySession.get(result.tmuxSessionId)!;
    assert.equal(env.get("PI_TMUX_SUBAGENT_TASK"), task);
    const command = h.state.commandBySession.get(result.tmuxSessionId)!;
    for (const fragment of ["rm -rf", "whoami", "second line"]) assert.ok(!command.includes(fragment), command);
  } finally {
    await h.close();
  }
});

test("a missing Pi binary fails the durable job without creating a tmux session", async () => {
  const h = await makeHarness({ resolvePi: async () => undefined });
  try {
    const result = await h.controller.start({ cwd: h.dir, task: "task" }, "pi-parent");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unavailable");
    assert.ok(result.jobId);
    assert.equal(result.status, "failed");
    assert.deepEqual(h.state.newSessionArgs, [], "no tmux session is created when Pi cannot be resolved");
    assert.equal((await h.jobs.get(result.jobId!))?.status, "failed");
    assert.match(result.error, /not found on PATH/);
  } finally {
    await h.close();
  }
});

test("a missing child reporter fails the durable job without launching", async () => {
  const h = await makeHarness({ reporterPath: path.join(os.tmpdir(), "pi-subagent-missing-reporter.ts") });
  try {
    const result = await h.controller.start({ cwd: h.dir, task: "task" }, "pi-parent");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unavailable");
    assert.deepEqual(h.state.newSessionArgs, []);
    assert.equal((await h.jobs.get(result.jobId!))?.status, "failed");
  } finally {
    await h.close();
  }
});

test("a child that exits during startup fails the job and leaves no owned session", async () => {
  const h = await makeHarness({ startupProbe: { attempts: 2, intervalMs: 1 }, sleep: async () => undefined });
  try {
    h.state.dieOnRespawn = true;
    const result = await h.controller.start({ cwd: h.dir, task: "task" }, "pi-parent");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, "failed");
    assert.ok(result.cleanedUp);
    assert.equal(h.state.killArgs.length, 1, "cleanup targets the session we created");
    assert.equal((await h.jobs.get(result.jobId!))?.status, "failed");
    assert.equal((await h.registry.list()).filter((entry) => entry.tool === "tmux_subagent_start_pi").length, 0, "provenance is forgotten");
  } finally {
    await h.close();
  }
});

test("a binding failure cleans up the tmux session it created and fails the job", async () => {
  class FailingBind extends SubagentJobRegistry {
    override async bind(): Promise<never> {
      throw new TmuxError("bind rejected", "invalid_option");
    }
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const jobs = new FailingBind(path.join(dir, "jobs.json"));
  const h = await makeHarness({ jobs });
  try {
    const result = await h.controller.start({ cwd: h.dir, task: "task" }, "pi-parent");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_option");
    assert.equal(result.cleanedUp, true);
    assert.equal(h.state.killArgs.length, 1, "the just-created session is killed, not leaked");
    assert.equal(h.state.respawnArgs.length, 0, "the child is never started when binding fails");
    assert.equal((await jobs.get(result.jobId!))?.status, "failed");
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("status returns durable state and reconciles a vanished target to lost", async () => {
  const h = await makeHarness();
  try {
    const started = await h.controller.start({ cwd: h.dir, task: "task" }, "pi-parent");
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const live = await h.controller.status(started.jobId, "pi-parent");
    assert.equal(live.ok, true);
    if (!live.ok) return;
    assert.equal(live.job.status, "starting");
    assert.equal(live.targetLive, true);
    assert.equal(live.reconciled, false);

    h.state.removeSession(started.tmuxSessionId);
    const gone = await h.controller.status(started.jobId, "pi-parent");
    assert.equal(gone.ok, true);
    if (!gone.ok) return;
    assert.equal(gone.job.status, "lost");
    assert.equal(gone.job.finishedAt !== undefined, true);
    assert.equal(gone.reconciled, true, "obvious tmux disappearance is reconciled without pane-output heuristics");

    const again = await h.controller.status(started.jobId, "pi-parent");
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.job.status, "lost", "a terminal job is never rewritten");
    assert.equal(again.reconciled, false);
  } finally {
    await h.close();
  }
});

test("status leaves state untouched while the tmux server is unreachable", async () => {
  const h = await makeHarness();
  try {
    const started = await h.controller.start({ cwd: h.dir, task: "task" }, "pi-parent");
    assert.equal(started.ok, true);
    if (!started.ok) return;
    h.state.serverAvailable = false;
    const result = await h.controller.status(started.jobId, "pi-parent");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.reconciled, false);
    assert.equal(result.tmuxUnavailable, true);
    assert.equal(result.job.status, "starting");
  } finally {
    await h.close();
  }
});

test("status refuses an unknown job or one owned by another Pi conversation", async () => {
  const h = await makeHarness();
  try {
    const unknown = await h.controller.status("11111111-1111-1111-1111-111111111111", "pi-parent");
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.code, "invalid_target");

    const started = await h.controller.start({ cwd: h.dir, task: "task" }, "other-parent");
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const foreign = await h.controller.status(started.jobId, "pi-parent");
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.equal(foreign.code, "invalid_target");
  } finally {
    await h.close();
  }
});

test("cancel kills only the verified recorded target and is idempotent", async () => {
  const h = await makeHarness();
  try {
    const started = await h.controller.start({ cwd: h.dir, task: "task" }, "pi-parent");
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const cancelled = await h.controller.cancel(started.jobId, "pi-parent");
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.targetRemoved, true);
    assert.deepEqual(h.state.killArgs.at(-1), ["kill-session", "-t", started.tmuxSessionId]);
    assert.equal((await h.jobs.get(started.jobId))?.status, "cancelled");

    const repeat = await h.controller.cancel(started.jobId, "pi-parent");
    assert.equal(repeat.ok, true);
    if (!repeat.ok) return;
    assert.equal(repeat.alreadyTerminal, true);
    assert.equal(repeat.targetRemoved, false);
    assert.equal(h.state.killArgs.length, 1, "a terminal job is never killed again");
  } finally {
    await h.close();
  }
});

test("cancel is a no-op on a job the child already completed", async () => {
  const h = await makeHarness();
  try {
    const started = await h.controller.start({ cwd: h.dir, task: "task" }, "pi-parent");
    assert.equal(started.ok, true);
    if (!started.ok) return;
    await h.jobs.transition(started.jobId, "running");
    await h.jobs.transition(started.jobId, "completed", { exitCode: 0 });

    const cancelled = await h.controller.cancel(started.jobId, "pi-parent");
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.alreadyTerminal, true);
    assert.equal(cancelled.status, "completed");
    assert.equal(h.state.killArgs.length, 0, "a completed job's target is not killed");
  } finally {
    await h.close();
  }
});

test("cancel fails closed (no kill) when the recorded pane belongs to another session", async () => {
  const h = await makeHarness();
  try {
    const started = await h.controller.start({ cwd: h.dir, task: "task" }, "pi-parent");
    assert.equal(started.ok, true);
    if (!started.ok) return;
    // Simulate the recorded pane ID now belonging to a different session.
    h.state.paneSession.set(started.tmuxPaneId, "$999");

    const cancelled = await h.controller.cancel(started.jobId, "pi-parent");
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.targetRemoved, false, "no reused target is killed");
    assert.equal(h.state.killArgs.length, 0);
    assert.match(cancelled.reason, /now belongs to session/);
    assert.equal((await h.jobs.get(started.jobId))?.status, "cancelled");
  } finally {
    await h.close();
  }
});

test("cancel fails closed (no kill) when the recorded pane is missing but the session is live", async () => {
  const h = await makeHarness();
  try {
    const started = await h.controller.start({ cwd: h.dir, task: "task" }, "pi-parent");
    assert.equal(started.ok, true);
    if (!started.ok) return;
    // Keep the session, drop only the pane: the stable pane ID may be reused.
    h.state.sessions.get(started.tmuxSessionId)!.panes.clear();
    h.state.paneSession.delete(started.tmuxPaneId);

    const cancelled = await h.controller.cancel(started.jobId, "pi-parent");
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.targetRemoved, false);
    assert.equal(h.state.killArgs.length, 0);
    assert.match(cancelled.reason, /not present/);
  } finally {
    await h.close();
  }
});

test("cancel fails closed (no kill) when the job has no recorded server identity", async () => {
  const h = await makeHarness();
  try {
    const job = await h.jobs.create({ cwd: h.dir, parentPiSessionId: "pi-parent" });
    await h.jobs.bind(job.jobId, { tmuxSessionId: "$1", tmuxPaneId: "%1" }); // no serverIdentity
    await h.jobs.transition(job.jobId, "starting");
    // The fake server still has a live $1/%1, but without a recorded identity it
    // cannot be proven to be the same server, so cancel must not kill it.
    h.state.sessions.set("$1", { id: "$1", name: "s", panes: new Set(["%1"]) });
    h.state.paneSession.set("%1", "$1");

    const cancelled = await h.controller.cancel(job.jobId, "pi-parent");
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.targetRemoved, false);
    assert.equal(h.state.killArgs.length, 0);
    assert.match(cancelled.reason, /no recorded tmux server identity/);
  } finally {
    await h.close();
  }
});

test("cancel fails closed (no kill) when the server identity changed", async () => {
  const h = await makeHarness();
  try {
    const started = await h.controller.start({ cwd: h.dir, task: "task" }, "pi-parent");
    assert.equal(started.ok, true);
    if (!started.ok) return;
    h.state.serverIdentity = "2:2";
    const cancelled = await h.controller.cancel(started.jobId, "pi-parent");
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.targetRemoved, false);
    assert.equal(h.state.killArgs.length, 0);
    assert.match(cancelled.reason, /current server is 2:2/);
  } finally {
    await h.close();
  }
});

test("cancel fails closed (no kill) when the current server identity is unavailable", async () => {
  const h = await makeHarness();
  try {
    const started = await h.controller.start({ cwd: h.dir, task: "task" }, "pi-parent");
    assert.equal(started.ok, true);
    if (!started.ok) return;
    h.state.serverIdentity = undefined;
    const cancelled = await h.controller.cancel(started.jobId, "pi-parent");
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.targetRemoved, false);
    assert.equal(h.state.killArgs.length, 0);
    assert.match(cancelled.reason, /server identity is unavailable/);
  } finally {
    await h.close();
  }
});

test("cancel refuses another Pi conversation's job", async () => {
  const h = await makeHarness();
  try {
    const started = await h.controller.start({ cwd: h.dir, task: "task" }, "other-parent");
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const cancelled = await h.controller.cancel(started.jobId, "pi-parent");
    assert.equal(cancelled.ok, false);
    if (cancelled.ok) return;
    assert.equal(cancelled.code, "invalid_target");
    assert.equal(h.state.killArgs.length, 0);
  } finally {
    await h.close();
  }
});

test("start carries lineage and refuses to nest past the depth bound", async () => {
  const h = await makeHarness({
    env: { PI_TMUX_SUBAGENT_ANCESTORS: "a,b", PI_TMUX_SUBAGENT_JOB_ID: "self" } as NodeJS.ProcessEnv,
  });
  try {
    const started = await h.controller.start({ cwd: h.dir, task: "task" }, "pi-parent");
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(h.state.envBySession.get(started.tmuxSessionId)?.get("PI_TMUX_SUBAGENT_ANCESTORS"), "a,b,self");
  } finally {
    await h.close();
  }

  const deep = await makeHarness({
    maxDepth: 2,
    env: { PI_TMUX_SUBAGENT_ANCESTORS: "a,b,c" } as NodeJS.ProcessEnv,
  });
  try {
    const result = await deep.controller.start({ cwd: deep.dir, task: "task" }, "pi-parent");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_option");
    assert.deepEqual(await deep.jobs.list(), []);
    assert.deepEqual(deep.state.newSessionArgs, []);
  } finally {
    await deep.close();
  }
});

test("invalid input is rejected before any job or session is created", async () => {
  const h = await makeHarness();
  try {
    const relative = await h.controller.start({ cwd: "relative/path", task: "task" }, "pi-parent");
    assert.equal(relative.ok, false);
    const empty = await h.controller.start({ cwd: h.dir, task: "   " }, "pi-parent");
    assert.equal(empty.ok, false);
    const badThinking = await h.controller.start({ cwd: h.dir, task: "task", thinking: "galaxy" }, "pi-parent");
    assert.equal(badThinking.ok, false);
    const badModel = await h.controller.start({ cwd: h.dir, task: "task", model: "bad model;rm" }, "pi-parent");
    assert.equal(badModel.ok, false);
    assert.deepEqual(await h.jobs.list(), []);
    assert.deepEqual(h.state.newSessionArgs, []);
  } finally {
    await h.close();
  }
});
