import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentAdapterRegistry, type AgentAdapter } from "../src/agent-adapter.ts";
import { GenericSubagentController } from "../src/generic-subagent.ts";
import { Registry } from "../src/registry.ts";
import { SubagentSessionRegistry } from "../src/subagent-sessions.ts";
import type { SubagentTargets } from "../src/subagent-controller.ts";
import type { LiveTargets, PaneTarget, SessionTarget } from "../src/targets.ts";
import { Tmux, TmuxError } from "../src/tmux.ts";

/** In-memory stand-in for one isolated tmux server. */
class FakeState {
  serverIdentity: string | undefined = "1:1";
  serverAvailable = true;
  nextSession = 1;
  nextPane = 1;
  readonly sessions = new Map<string, { id: string; name: string; panes: Set<string>; cwd: string }>();
  readonly paneSession = new Map<string, string>();
  readonly killArgs: string[][] = [];
  readonly envBySession = new Map<string, Map<string, string>>();

  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) for (const pane of session.panes) this.paneSession.delete(pane);
    this.sessions.delete(sessionId);
  }
}

class FakeTmux extends Tmux {
  constructor(readonly state: FakeState) { super(); }

  override async run(args: readonly string[]): Promise<string> {
    const command = args[0];
    if (command === "new-session") {
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
      return `${sessionId}\t${paneId}`;
    }
    if (command === "new-window") {
      let sessionId = "";
      for (let index = 1; index < args.length; index++) if (args[index] === "-t") sessionId = args[++index]!;
      const paneId = `%${this.state.nextPane++}`;
      this.state.sessions.get(sessionId)?.panes.add(paneId);
      this.state.paneSession.set(paneId, sessionId);
      return paneId;
    }
    if (command === "respawn-pane") {
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
      if (sessionId) this.state.envBySession.set(sessionId, env);
      return "";
    }
    if (command === "kill-pane") {
      this.state.killArgs.push([...args]);
      const paneId = args[args.indexOf("-t") + 1]!;
      const sessionId = this.state.paneSession.get(paneId);
      if (sessionId) this.state.sessions.get(sessionId)?.panes.delete(paneId);
      this.state.paneSession.delete(paneId);
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
  async serverIdentity(): Promise<string | undefined> { return this.state.serverIdentity; }
}

function fakeAdapter(agent: "pi" | "claude-code" | "opencode"): AgentAdapter {
  return {
    agent,
    sessionNamePrefix: `${agent}-subagent`,
    provenanceTool: `tmux_subagent_start_${agent}`,
    placeholderCommand: "exec sleep 3600",
    validateOptions: (input) => (input.model === "bad model" ? "model invalid" : undefined),
    async preflight() { return { ok: true, env: { FAKE_BIN: `/fake/${agent}` } }; },
    async prepareTurn(input, context) {
      return {
        command: 'exec "$FAKE_BIN" -p -- "$FAKE_TASK"',
        env: { FAKE_TASK: input.task, FAKE_RUN: context.runId, FAKE_SESSION: context.sessionId, FAKE_OWNER: context.owner },
        completion: { strategy: "native-reporter" },
      };
    },
  };
}

interface Harness {
  dir: string;
  state: FakeState;
  sessions: SubagentSessionRegistry;
  registry: Registry;
  generic: GenericSubagentController;
  close: () => Promise<void>;
}

async function harness(options: { agents?: Array<"pi" | "claude-code" | "opencode"> } = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "generic-subagent-"));
  const state = new FakeState();
  const sessions = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
  const registry = new Registry(path.join(dir, "registry.json"));
  const agents = options.agents ?? ["pi", "claude-code", "opencode"];
  const generic = new GenericSubagentController({
    tmux: new FakeTmux(state),
    registry,
    targets: new FakeTargets(state),
    sessions,
    adapters: new AgentAdapterRegistry(agents.map(fakeAdapter)),
    startupProbe: { attempts: 0, intervalMs: 0 },
  });
  return { dir, state, sessions, registry, generic, close: () => rm(dir, { recursive: true, force: true }) };
}

test("create provisions a reusable session without a turn; run adds a turn and reuses the session", async () => {
  const h = await harness();
  try {
    const created = await h.generic.create({ agent: "claude-code", cwd: h.dir, name: "worker" }, "parent-a");
    assert.equal(created.ok, true, created.ok ? "" : created.error);
    if (!created.ok) return;
    assert.equal(created.status, "idle");
    assert.equal(created.agent, "claude-code");
    assert.match(created.tmuxSessionId, /^\$\d+$/);
    assert.deepEqual(await h.sessions.listTurns({ sessionId: created.sessionId }), [], "create starts no turn");

    const first = await h.generic.run(created.sessionId, { task: "turn A" }, "parent-a");
    assert.equal(first.ok, true, first.ok ? "" : first.error);
    if (!first.ok) return;
    assert.equal(first.sessionId, created.sessionId);
    assert.equal(first.status, "starting");
    assert.equal(first.turnIndex, 1);
    assert.equal(h.state.envBySession.get(created.tmuxSessionId)?.get("FAKE_TASK"), "turn A");
    assert.equal(h.state.envBySession.get(created.tmuxSessionId)?.get("FAKE_SESSION"), created.sessionId);

    // A second concurrent turn is refused while the first is active.
    const concurrent = await h.generic.run(created.sessionId, { task: "turn B" }, "parent-a");
    assert.equal(concurrent.ok, false);
    if (!concurrent.ok) assert.equal(concurrent.code, "invalid_option");

    // Complete turn A; the session returns to idle and turn B can run.
    await h.sessions.transitionTurn(first.runId, "running");
    await h.sessions.transitionTurn(first.runId, "completed", { exitCode: 0 });
    assert.equal((await h.sessions.getSession(created.sessionId))?.status, "idle");

    const second = await h.generic.run(created.sessionId, { task: "turn B" }, "parent-a");
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.turnIndex, 2);
    assert.equal(h.state.envBySession.get(created.tmuxSessionId)?.get("FAKE_TASK"), "turn B");
  } finally {
    await h.close();
  }
});

test("create/run validate the agent, the working directory, and adapter options before tmux", async () => {
  const h = await harness({ agents: ["claude-code"] });
  try {
    const unknown = await h.generic.create({ agent: "opencode", cwd: h.dir }, "parent-a");
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.match(unknown.error, /No adapter is registered/);

    const relative = await h.generic.create({ agent: "claude-code", cwd: "relative" }, "parent-a");
    assert.equal(relative.ok, false);
    if (!relative.ok) assert.equal(relative.code, "invalid_option");

    const badModel = await h.generic.create({ agent: "claude-code", cwd: h.dir, model: "bad model" }, "parent-a");
    assert.equal(badModel.ok, false);
    if (!badModel.ok) assert.match(badModel.error, /model invalid/);
    assert.deepEqual(await h.sessions.listSessions(), [], "no durable session is created on validation failure");
  } finally {
    await h.close();
  }
});

test("every session operation is scoped to the owning Pi conversation", async () => {
  const h = await harness();
  try {
    const created = await h.generic.create({ agent: "opencode", cwd: h.dir }, "parent-a");
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const run = await h.generic.run(created.sessionId, { task: "owned" }, "parent-a");
    assert.equal(run.ok, true);

    for (const call of [
      () => h.generic.run(created.sessionId, { task: "stolen" }, "parent-b"),
      () => h.generic.status(created.sessionId, "parent-b"),
      () => h.generic.cancel(created.sessionId, "parent-b"),
      () => h.generic.close(created.sessionId, "parent-b"),
    ]) {
      const outcome = await call();
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal(outcome.code, "invalid_target");
    }
  } finally {
    await h.close();
  }
});

test("cancel stops the active turn's verified pane but leaves the session reusable", async () => {
  const h = await harness();
  try {
    const created = await h.generic.create({ agent: "claude-code", cwd: h.dir }, "parent-a");
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const run = await h.generic.run(created.sessionId, { task: "long" }, "parent-a");
    assert.equal(run.ok, true);
    if (!run.ok) return;

    const cancelled = await h.generic.cancel(created.sessionId, "parent-a");
    assert.equal(cancelled.ok, true, cancelled.ok ? "" : cancelled.error);
    if (!cancelled.ok) return;
    assert.equal(cancelled.turnId, run.runId);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.targetRemoved, true, "the verified turn pane was removed");
    assert.equal((await h.sessions.getSession(created.sessionId))?.status, "idle", "the session stays reusable");
    assert.ok(h.state.sessions.has(created.tmuxSessionId), "the session boundary was not torn down");

    const none = await h.generic.cancel(created.sessionId, "parent-a");
    assert.equal(none.ok, true);
    if (none.ok) assert.equal(none.alreadyTerminal, true);
  } finally {
    await h.close();
  }
});

test("cancel fails closed on a reused or restarted tmux server but still cancels the turn", async () => {
  const h = await harness();
  try {
    const created = await h.generic.create({ agent: "claude-code", cwd: h.dir }, "parent-a");
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const run = await h.generic.run(created.sessionId, { task: "long" }, "parent-a");
    assert.equal(run.ok, true);

    h.state.serverIdentity = "2:2"; // The tmux server restarted and may have reused IDs.
    const cancelled = await h.generic.cancel(created.sessionId, "parent-a");
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.targetRemoved, false, "an unverified target is never killed");
    assert.ok(h.state.sessions.has(created.tmuxSessionId), "the target is left untouched");
  } finally {
    await h.close();
  }
});

test("status reconciles a vanished tmux session to lost using durable state only", async () => {
  const h = await harness();
  try {
    const created = await h.generic.create({ agent: "opencode", cwd: h.dir }, "parent-a");
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const run = await h.generic.run(created.sessionId, { task: "work" }, "parent-a");
    assert.equal(run.ok, true);
    if (!run.ok) return;
    await h.sessions.transitionTurn(run.runId, "running");

    const before = await h.generic.status(created.sessionId, "parent-a");
    assert.equal(before.ok, true);
    if (before.ok) {
      assert.equal(before.session.status, "busy");
      assert.equal(before.activeTurnId, run.runId);
    }

    h.state.removeSession(created.tmuxSessionId); // The whole session vanished.
    const after = await h.generic.status(created.sessionId, "parent-a");
    assert.equal(after.ok, true);
    if (!after.ok) return;
    assert.equal(after.session.status, "lost");
    assert.equal(after.turn?.status, "lost");
    assert.equal(after.reconciled, true);
  } finally {
    await h.close();
  }
});

test("close cancels an active turn, stops the session, and kills only its verified tmux session", async () => {
  const h = await harness();
  try {
    const created = await h.generic.create({ agent: "opencode", cwd: h.dir }, "parent-a");
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const run = await h.generic.run(created.sessionId, { task: "long" }, "parent-a");
    assert.equal(run.ok, true);
    if (!run.ok) return;

    const closed = await h.generic.close(created.sessionId, "parent-a");
    assert.equal(closed.ok, true, closed.ok ? "" : closed.error);
    if (!closed.ok) return;
    assert.equal(closed.status, "stopped");
    assert.equal(closed.targetRemoved, true);
    assert.equal(h.state.sessions.has(created.tmuxSessionId), false, "the tmux boundary is gone");
    assert.equal((await h.sessions.getTurn(run.runId))?.status, "cancelled", "an active turn is cancelled first");

    const again = await h.generic.close(created.sessionId, "parent-a");
    assert.equal(again.ok, true);
    if (again.ok) assert.equal(again.alreadyClosed, true);
  } finally {
    await h.close();
  }
});
