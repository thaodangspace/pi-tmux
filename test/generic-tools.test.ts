import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentAdapterRegistry, type AgentAdapter } from "../src/agent-adapter.ts";
import { Registry } from "../src/registry.ts";
import { SubagentJobRegistry } from "../src/subagent-jobs.ts";
import { SubagentSessionRegistry } from "../src/subagent-sessions.ts";
import { Targets, type LiveTargets, type PaneTarget, type SessionTarget } from "../src/targets.ts";
import { Tmux, TmuxError } from "../src/tmux.ts";
import { registerTmuxTools } from "../src/tools.ts";

/**
 * Tool-surface tests for the generic session/turn tools (issue #12).
 *
 * Fake Claude Code / OpenCode adapters are registered through the real
 * `registerTmuxTools` surface, so the whole `create -> run -> status -> cancel
 * -> close` lifecycle is exercised without a real agent CLI or tmux server.
 */

class FakeState {
  serverIdentity: string | undefined = "1:1";
  nextSession = 1;
  nextPane = 1;
  readonly sessions = new Map<string, { id: string; panes: Set<string> }>();
  readonly paneSession = new Map<string, string>();

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
      const sessionId = `$${this.state.nextSession++}`;
      const paneId = `%${this.state.nextPane++}`;
      this.state.sessions.set(sessionId, { id: sessionId, panes: new Set([paneId]) });
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
    if (command === "respawn-pane") return "";
    if (command === "kill-pane") {
      const paneId = args[args.indexOf("-t") + 1]!;
      const sessionId = this.state.paneSession.get(paneId);
      if (sessionId) this.state.sessions.get(sessionId)?.panes.delete(paneId);
      this.state.paneSession.delete(paneId);
      return "";
    }
    if (command === "kill-session") {
      this.state.removeSession(args[args.indexOf("-t") + 1]!);
      return "";
    }
    throw new Error(`unexpected tmux command: ${command}`);
  }
}

/** Subclass of the real `Targets` so the tool options accept it, with the durable views faked. */
class FakeTargets extends Targets {
  constructor(readonly fake: FakeState) { super(new Tmux()); }
  override async session(selector: string): Promise<SessionTarget> {
    if (selector === "missing") throw new TmuxError(`Target ${selector} was not found.`, "invalid_target");
    return { id: "$50", name: selector, attached: 0, windows: 1 };
  }
  override async panes(): Promise<PaneTarget[]> {
    return [...this.fake.paneSession].map(([pane, sessionId]) => ({
      id: pane, sessionId, sessionName: "s", windowId: "@1", windowIndex: 0, windowName: "w",
      index: 0, active: true, currentPath: "/tmp", width: 80, height: 24,
    }));
  }
  override async liveTargets(): Promise<LiveTargets> {
    const live = new Set<string>();
    for (const session of this.fake.sessions.values()) {
      live.add(session.id);
      for (const pane of session.panes) live.add(pane);
    }
    return { live, labels: new Map(), serverIdentity: this.fake.serverIdentity };
  }
  override async serverIdentity(): Promise<string | undefined> { return this.fake.serverIdentity; }
}

function fakeAdapter(agent: "claude-code" | "opencode"): AgentAdapter {
  return {
    agent,
    sessionNamePrefix: `${agent}-subagent`,
    provenanceTool: `tmux_subagent_start_${agent}`,
    placeholderCommand: "exec sleep 3600",
    validateOptions: (input) => (input.model === "bad model" ? "model invalid" : undefined),
    async preflight() { return { ok: true, env: { FAKE_BIN: `/fake/${agent}` }, metadata: { fakeAuthRisk: "none-detected" } }; },
    async prepareTurn(input) {
      return {
        command: 'exec "$FAKE_BIN" -p -- "$FAKE_TASK"',
        env: { FAKE_TASK: input.task },
        completion: { strategy: "native-reporter" },
      };
    },
  };
}

async function harness() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "generic-tools-"));
  const state = new FakeState();
  const tmux = new FakeTmux(state);
  const tools: Record<string, any> = {};
  registerTmuxTools(
    { registerTool(tool: any) { tools[tool.name] = tool; } } as unknown as ExtensionAPI,
    tmux,
    new Registry(path.join(dir, "registry.json")),
    {
      sessions: new SubagentSessionRegistry(path.join(dir, "sessions.json")),
      jobs: new SubagentJobRegistry(path.join(dir, "jobs.json")),
      targets: new FakeTargets(state),
      adapters: new AgentAdapterRegistry([fakeAdapter("claude-code"), fakeAdapter("opencode")]),
      // No `pi` adapter is registered here, so the generic tools fail closed for it.
    },
  );
  const context = (owner: string) => ({
    hasUI: false,
    sessionManager: { getSessionId: () => owner },
    ui: {},
  } as unknown as ExtensionContext);
  const call = (name: string, params: Record<string, unknown>, owner = "pi-parent") => tools[name].execute("call", params, undefined, undefined, context(owner));
  const body = (value: any) => JSON.parse(value.content[0].text);
  return { dir, state, tools, call, body, close: () => rm(dir, { recursive: true, force: true }) };
}

test("the generic session/turn tools are registered with bounded schemas and no executable/argv fields", async () => {
  const h = await harness();
  try {
    for (const name of ["tmux_subagent_create", "tmux_subagent_run", "tmux_subagent_status", "tmux_subagent_cancel", "tmux_subagent_close"]) {
      assert.ok(h.tools[name], `missing ${name}`);
      assert.ok(h.tools[name].parameters, `${name} has no parameter schema`);
    }
    const fields = new Set(Object.keys(h.tools.tmux_subagent_create.parameters.properties));
    for (const forbidden of ["executable", "argv", "command", "shell", "args"]) {
      assert.equal(fields.has(forbidden), false, `create must not expose ${forbidden}`);
    }
    assert.deepEqual([...fields].sort(), ["agent", "cwd", "mode", "model", "name", "parent", "thinking"]);
  } finally {
    await h.close();
  }
});

test("a fake Claude Code adapter runs the full reusable lifecycle through the tool surface", async () => {
  const h = await harness();
  try {
    const created = await h.call("tmux_subagent_create", { agent: "claude-code", cwd: h.dir, name: "worker" });
    assert.equal(created.isError, undefined, created.content[0].text);
    const createdBody = h.body(created);
    assert.equal(createdBody.status, "idle");
    assert.equal(createdBody.agent, "claude-code");
    assert.deepEqual(createdBody.metadata, { fakeAuthRisk: "none-detected" }, "preflight metadata is surfaced on create");
    const sessionId = createdBody.sessionId as string;

    const running = await h.call("tmux_subagent_run", { sessionId, task: "do the work" });
    assert.equal(running.isError, undefined, running.content[0].text);
    const runBody = h.body(running);
    assert.equal(runBody.sessionId, sessionId);
    assert.deepEqual(runBody.metadata, { fakeAuthRisk: "none-detected" }, "preflight metadata is surfaced on run");
    const turnId = runBody.turnId as string;
    assert.ok(turnId);

    const concurrent = await h.call("tmux_subagent_run", { sessionId, task: "second" });
    assert.equal(concurrent.isError, true, "a second concurrent turn is rejected");
    assert.equal(concurrent.details.code, "invalid_option");

    const status = await h.call("tmux_subagent_status", { sessionId, turnId });
    assert.equal(status.isError, undefined);
    const statusBody = h.body(status);
    assert.equal(statusBody.session.sessionId, sessionId);
    assert.equal(statusBody.turn.turnId, turnId);

    const cancelled = await h.call("tmux_subagent_cancel", { sessionId });
    assert.equal(cancelled.isError, undefined, cancelled.content[0].text);
    const cancelledBody = h.body(cancelled);
    assert.equal(cancelledBody.turnId, turnId);
    assert.equal(cancelledBody.status, "cancelled");
    assert.equal(cancelledBody.targetRemoved, true);

    const closed = await h.call("tmux_subagent_close", { sessionId });
    assert.equal(closed.isError, undefined, closed.content[0].text);
    assert.equal(h.body(closed).status, "stopped");
    assert.equal(h.state.sessions.has(createdBody.tmuxSessionId), false, "close removed the tmux boundary");
  } finally {
    await h.close();
  }
});

test("a fake OpenCode adapter is exercised through the same surface", async () => {
  const h = await harness();
  try {
    const created = await h.call("tmux_subagent_create", { agent: "opencode", cwd: h.dir });
    assert.equal(created.isError, undefined, created.content[0].text);
    const sessionId = h.body(created).sessionId as string;
    const running = await h.call("tmux_subagent_run", { sessionId, task: "opencode task" });
    assert.equal(running.isError, undefined, running.content[0].text);
    const closed = await h.call("tmux_subagent_close", { sessionId });
    assert.equal(closed.isError, undefined, closed.content[0].text);
  } finally {
    await h.close();
  }
});

test("the generic tools fail closed for an unconfigured agent and reject invalid options", async () => {
  const h = await harness();
  try {
    const unknown = await h.call("tmux_subagent_create", { agent: "pi", cwd: h.dir });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.details.code, "invalid_option");
    assert.match(unknown.details.error, /No adapter is registered/);

    const badModel = await h.call("tmux_subagent_create", { agent: "claude-code", cwd: h.dir, model: "bad model" });
    assert.equal(badModel.isError, true);
    assert.equal(badModel.details.code, "invalid_option");
  } finally {
    await h.close();
  }
});

test("the generic tools refuse another conversation's session", async () => {
  const h = await harness();
  try {
    const created = await h.call("tmux_subagent_create", { agent: "claude-code", cwd: h.dir });
    const sessionId = h.body(created).sessionId as string;
    await h.call("tmux_subagent_run", { sessionId, task: "owned" });

    const stolen = await h.call("tmux_subagent_status", { sessionId }, "other-parent");
    assert.equal(stolen.isError, true);
    assert.equal(stolen.details.code, "invalid_target");
    assert.equal(stolen.details.sessionId, sessionId);

    const stolenClose = await h.call("tmux_subagent_close", { sessionId }, "other-parent");
    assert.equal(stolenClose.isError, true);
    assert.equal(stolenClose.details.code, "invalid_target");
  } finally {
    await h.close();
  }
});

test("status and cancel still accept the legacy jobId form for Pi compatibility", async () => {
  const h = await harness();
  try {
    const jobs = new SubagentJobRegistry(path.join(h.dir, "compat-jobs.json"));
    // The tool surface's own job registry is not exported, so exercise the legacy
    // path via an unknown job ID: the important contract is that jobId is routed
    // to the Pi path rather than the session path.
    const unknownJob = await h.call("tmux_subagent_status", { jobId: "44444444-4444-4444-4444-444444444444" });
    assert.equal(unknownJob.isError, true);
    assert.equal(unknownJob.details.jobId, "44444444-4444-4444-4444-444444444444");
    assert.equal(unknownJob.details.sessionId, undefined);

    const both = await h.call("tmux_subagent_status", { sessionId: "s", jobId: "j" });
    assert.equal(both.isError, true);
    assert.equal(both.details.code, "invalid_option");

    const neither = await h.call("tmux_subagent_status", {});
    assert.equal(neither.isError, true);
    assert.equal(neither.details.code, "invalid_option");
    void jobs;
  } finally {
    await h.close();
  }
});
