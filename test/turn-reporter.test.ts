import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CHILD_REPORTER_ENV } from "../src/subagent-reporter.ts";
import { SubagentSessionRegistry } from "../src/subagent-sessions.ts";
import { TurnReporter } from "../src/turn-reporter.ts";

/**
 * Unit tests for the session-mode child reporter (issue #12): a delegated child
 * reports durable `SubagentTurn` state instead of a one-shot job. The reporter is
 * exercised directly with Pi's structured lifecycle events; no Pi runtime or tmux
 * server is needed.
 */

interface Fixture {
  registry: SubagentSessionRegistry;
  sessionId: string;
  turnId: string;
  pane: string;
  statePath: string;
  completionDir: string;
  env: NodeJS.ProcessEnv;
  dir: string;
}

async function fixture(options: { owner?: string; bindPane?: string } = {}): Promise<Fixture> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-turn-reporter-"));
  const owner = options.owner ?? "pi-parent";
  const statePath = path.join(dir, "sessions.json");
  const registry = new SubagentSessionRegistry(statePath);
  const session = await registry.createSession({ agent: "pi", cwd: dir, parentPiSessionId: owner });
  await registry.bindSession(session.sessionId, { tmuxSessionId: "$1", serverIdentity: "1:1" }, { parentPiSessionId: owner });
  const turn = await registry.createTurn(session.sessionId, { parentPiSessionId: owner });
  const pane = options.bindPane ?? "%1";
  await registry.bindTurn(turn.turnId, { tmuxPaneId: pane }, { parentPiSessionId: owner });
  await registry.transitionTurn(turn.turnId, "starting", { parentPiSessionId: owner });
  const env: NodeJS.ProcessEnv = {
    [CHILD_REPORTER_ENV.mode]: "session",
    [CHILD_REPORTER_ENV.jobId]: turn.turnId,
    [CHILD_REPORTER_ENV.state]: statePath,
    [CHILD_REPORTER_ENV.parentSessionId]: owner,
    [CHILD_REPORTER_ENV.session]: session.sessionId,
  };
  return { registry, sessionId: session.sessionId, turnId: turn.turnId, pane, statePath, completionDir: path.join(dir, "reports"), env, dir };
}

test("the turn reporter attaches running, records a bounded completion, and returns the session to idle", async () => {
  const f = await fixture();
  try {
    const reporter = new TurnReporter({ env: f.env, registry: f.registry, completionDir: f.completionDir });
    const attached = await reporter.attach({ childSessionId: "child-1", tmuxPaneId: "%1" });
    assert.equal(attached.status, "running");
    assert.equal(attached.passive, false);
    assert.equal((await f.registry.getTurn(f.turnId))?.status, "running");
    assert.equal((await f.registry.getSession(f.sessionId))?.status, "busy");

    reporter.observeOutcome("completed");
    reporter.observeAgentEnd([{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "did the work" }] }]);
    const settled = await reporter.settle();
    assert.equal(settled.status, "completed");
    assert.ok(settled.resultPath);

    const turn = await f.registry.getTurn(f.turnId);
    assert.equal(turn?.status, "completed");
    assert.equal((await f.registry.getSession(f.sessionId))?.status, "idle", "a terminal turn returns the session to idle");
    assert.equal((await f.registry.getSession(f.sessionId))?.agentSessionId, "child-1");
    const payload = JSON.parse(await readFile(settled.resultPath!, "utf8"));
    assert.equal(payload.sessionId, f.sessionId);
    assert.equal(payload.turnId, f.turnId);
    assert.equal(payload.status, "completed");
    assert.equal(payload.summary, "did the work");
    assert.equal(payload.agentSessionId, "child-1");

    assert.equal((await reporter.settle()).status, "completed", "settle is idempotent");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("the turn reporter fails closed with no observable outcome and never infers from pane text", async () => {
  const f = await fixture();
  try {
    const reporter = new TurnReporter({ env: f.env, registry: f.registry, completionDir: f.completionDir });
    await reporter.attach({ childSessionId: "child-1", tmuxPaneId: "%1" });
    const settled = await reporter.settle();
    assert.equal(settled.status, "failed");
    assert.equal((await f.registry.getTurn(f.turnId))?.status, "failed");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("the turn reporter rejects a wrong pane, a mismatched owner, and missing metadata", async () => {
  const f = await fixture();
  try {
    const wrongPane = new TurnReporter({ env: f.env, registry: f.registry, completionDir: f.completionDir });
    await assert.rejects(() => wrongPane.attach({ childSessionId: "child-1", tmuxPaneId: "%999" }), /bound to %1/);

    const wrongOwner = new TurnReporter({ env: { ...f.env, [CHILD_REPORTER_ENV.parentSessionId]: "someone-else" }, registry: f.registry, completionDir: f.completionDir });
    await assert.rejects(() => wrongOwner.attach({ childSessionId: "child-1", tmuxPaneId: "%1" }), /Parent session mismatch/);

    const noMode = new TurnReporter({ env: { ...f.env, [CHILD_REPORTER_ENV.mode]: undefined }, registry: f.registry, completionDir: f.completionDir });
    await assert.rejects(() => noMode.attach({ childSessionId: "child-1", tmuxPaneId: "%1" }), /MODE=session/);

    assert.equal((await f.registry.getTurn(f.turnId))?.status, "starting", "no failed attach mutated the turn");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("the turn reporter is passive for an already-terminal turn and never overwrites it", async () => {
  const f = await fixture();
  try {
    await f.registry.transitionTurn(f.turnId, "running");
    await f.registry.transitionTurn(f.turnId, "cancelled", { error: "cancelled by parent" });
    const reporter = new TurnReporter({ env: f.env, registry: f.registry, completionDir: f.completionDir });
    const attached = await reporter.attach({ childSessionId: "child-1", tmuxPaneId: "%1" });
    assert.equal(attached.passive, true);
    assert.equal(attached.status, "cancelled");
    const settled = await reporter.settle();
    assert.equal(settled.status, "ignored");
    assert.equal((await f.registry.getTurn(f.turnId))?.status, "cancelled");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("the turn reporter refuses a recursive lineage and a self-referential parent", async () => {
  const f = await fixture();
  try {
    const recursive = new TurnReporter({ env: { ...f.env, [CHILD_REPORTER_ENV.ancestors]: f.turnId }, registry: f.registry, completionDir: f.completionDir });
    await assert.rejects(() => recursive.attach({ childSessionId: "child-1", tmuxPaneId: "%1" }), /recursive subagent loop/);

    const selfParent = new TurnReporter({ env: f.env, registry: f.registry, completionDir: f.completionDir });
    await assert.rejects(() => selfParent.attach({ childSessionId: "pi-parent", tmuxPaneId: "%1" }), /self-referential/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("a cancellation that lands after attach leaves the terminal outcome intact", async () => {
  const f = await fixture();
  try {
    const reporter = new TurnReporter({ env: f.env, registry: f.registry, completionDir: f.completionDir });
    await reporter.attach({ childSessionId: "child-1", tmuxPaneId: "%1" });
    await f.registry.transitionTurn(f.turnId, "cancelled", { error: "parent cancelled" });
    reporter.observeOutcome("completed");
    const settled = await reporter.settle();
    assert.equal(settled.status, "ignored");
    assert.equal((await f.registry.getTurn(f.turnId))?.status, "cancelled");
    assert.equal((await f.registry.getTurn(f.turnId))?.error, "parent cancelled");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
