import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CompletionWatchHandle, SubagentCompletionEvent } from "../src/completion-delivery.ts";
import { type SubagentSessionV1, type SubagentTurnV1, SubagentSessionRegistry } from "../src/subagent-sessions.ts";
import { buildTurnCompletionEvent, TurnCompletionDelivery } from "../src/turn-completion-delivery.ts";

let counter = 0;

async function terminalTurn(
  registry: SubagentSessionRegistry,
  owner: string,
  status: "completed" | "failed" | "cancelled" = "completed",
  extra: { resultPath?: string; error?: string } = {},
): Promise<{ session: SubagentSessionV1; turn: SubagentTurnV1; tmuxSessionId: string; pane: string }> {
  const n = ++counter;
  const tmuxSessionId = `$${n}`;
  const pane = `%${n}`;
  const session = await registry.createSession({ agent: "opencode", cwd: "/tmp", parentPiSessionId: owner });
  await registry.bindSession(session.sessionId, { tmuxSessionId, serverIdentity: "100:1" }, { parentPiSessionId: owner });
  const turn = await registry.createTurn(session.sessionId, { parentPiSessionId: owner });
  await registry.bindTurn(turn.turnId, { tmuxPaneId: pane }, { parentPiSessionId: owner });
  await registry.transitionTurn(turn.turnId, "starting", { parentPiSessionId: owner });
  await registry.transitionTurn(turn.turnId, "running", { parentPiSessionId: owner });
  await registry.transitionTurn(turn.turnId, status, {
    parentPiSessionId: owner,
    ...(extra.resultPath ? { resultPath: extra.resultPath } : {}),
    ...(extra.error ? { error: extra.error } : {}),
  });
  return { session: (await registry.getSession(session.sessionId))!, turn: (await registry.getTurn(turn.turnId))!, tmuxSessionId, pane };
}

async function withRegistry(run: (registry: SubagentSessionRegistry, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-turn-delivery-"));
  try {
    await run(new SubagentSessionRegistry(path.join(dir, "sessions.json")), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("buildTurnCompletionEvent carries distinct agent/session/turn identity and bounded fields", async () => {
  await withRegistry(async (registry) => {
    const { session, turn } = await terminalTurn(registry, "pi-parent", "completed", { resultPath: "/state/subagent-reports/t.json" });
    const event = buildTurnCompletionEvent(session, turn);
    assert.equal(event.customType, "pi-tmux:subagent-completed");
    assert.equal(event.details.agent, "opencode");
    assert.equal(event.details.sessionId, session.sessionId);
    assert.equal(event.details.turnId, turn.turnId);
    assert.equal(event.details.jobId, turn.turnId);
    assert.equal(event.details.status, "completed");
    assert.equal(event.details.resultPath, "/state/subagent-reports/t.json");
    assert.equal(typeof event.details.completionSeq, "number");
    assert.ok(!("summary" in event.details));

    const live = await registry.createTurn(session.sessionId, { parentPiSessionId: "pi-parent" });
    assert.throws(() => buildTurnCompletionEvent(session, live), /terminal turn/);
  });
});

test("a terminal turn is delivered once and acknowledged, and is not redelivered", async () => {
  await withRegistry(async (registry) => {
    const { turn } = await terminalTurn(registry, "pi-parent");
    const events: SubagentCompletionEvent[] = [];
    const delivery = new TurnCompletionDelivery({
      ownerPiSessionId: "pi-parent",
      sessions: registry,
      deliver: (event) => { events.push(event); },
      watch: () => undefined,
      pollIntervalMs: 0,
      debounceMs: 0,
    });

    await delivery.refresh();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.details.turnId, turn.turnId);
    assert.ok((await registry.getTurn(turn.turnId))!.notifiedAt, "the delivery was acknowledged durably");

    await delivery.refresh();
    assert.equal(events.length, 1, "an acknowledged turn is not redelivered");
    assert.equal(delivery.observing, false, "observation is released when no work is pending");
  });
});

test("another conversation's turns are never delivered or reconciled", async () => {
  await withRegistry(async (registry) => {
    await terminalTurn(registry, "pi-someone-else");
    const events: SubagentCompletionEvent[] = [];
    const delivery = new TurnCompletionDelivery({
      ownerPiSessionId: "pi-parent",
      sessions: registry,
      deliver: (event) => { events.push(event); },
      watch: () => undefined,
      pollIntervalMs: 0,
      debounceMs: 0,
    });

    await delivery.refresh();
    assert.deepEqual(events, []);
    assert.equal(delivery.observing, false);
  });
});

test("a failed delivery leaves the turn pending for a later retry", async () => {
  await withRegistry(async (registry) => {
    const { turn } = await terminalTurn(registry, "pi-parent");
    let attempts = 0;
    const delivery = new TurnCompletionDelivery({
      ownerPiSessionId: "pi-parent",
      sessions: registry,
      deliver: () => {
        attempts++;
        if (attempts === 1) throw new Error("sink unavailable");
      },
      watch: () => undefined,
      pollIntervalMs: 0,
      debounceMs: 0,
    });

    await delivery.refresh();
    assert.equal(attempts, 1);
    assert.equal((await registry.getTurn(turn.turnId))!.notifiedAt, undefined, "a failed delivery is not acknowledged");

    await delivery.refresh();
    assert.equal(attempts, 2, "the pending turn is retried");
    assert.ok((await registry.getTurn(turn.turnId))!.notifiedAt);
  });
});

test("reconciliation marks a vanished turn lost and delivers the lost outcome", async () => {
  await withRegistry(async (registry) => {
    const n = ++counter;
    const tmuxSessionId = `$${n}`;
    const pane = `%${n}`;
    const session = await registry.createSession({ agent: "opencode", cwd: "/tmp", parentPiSessionId: "pi-parent" });
    await registry.bindSession(session.sessionId, { tmuxSessionId, serverIdentity: "100:1" }, { parentPiSessionId: "pi-parent" });
    const turn = await registry.createTurn(session.sessionId, { parentPiSessionId: "pi-parent" });
    await registry.bindTurn(turn.turnId, { tmuxPaneId: pane }, { parentPiSessionId: "pi-parent" });
    await registry.transitionTurn(turn.turnId, "starting", { parentPiSessionId: "pi-parent" });

    const events: SubagentCompletionEvent[] = [];
    const delivery = new TurnCompletionDelivery({
      ownerPiSessionId: "pi-parent",
      sessions: registry,
      deliver: (event) => { events.push(event); },
      liveTargets: async () => ({ live: new Set([tmuxSessionId]), labels: new Map(), serverIdentity: "100:1" }),
      watch: () => undefined,
      pollIntervalMs: 0,
      debounceMs: 0,
    });

    await delivery.refresh();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.details.status, "lost");
    assert.equal(events[0]!.details.turnId, turn.turnId);
    assert.equal(delivery.observing, false);
  });
});

test("observation is held while a turn is active and released afterwards", async () => {
  await withRegistry(async (registry) => {
    const session = await registry.createSession({ agent: "opencode", cwd: "/tmp", parentPiSessionId: "pi-parent" });
    await registry.bindSession(session.sessionId, { tmuxSessionId: "$90", serverIdentity: "100:1" }, { parentPiSessionId: "pi-parent" });
    const turn = await registry.createTurn(session.sessionId, { parentPiSessionId: "pi-parent" });
    await registry.bindTurn(turn.turnId, { tmuxPaneId: "%90" }, { parentPiSessionId: "pi-parent" });
    await registry.transitionTurn(turn.turnId, "starting", { parentPiSessionId: "pi-parent" });

    const handles: CompletionWatchHandle[] = [];
    const delivery = new TurnCompletionDelivery({
      ownerPiSessionId: "pi-parent",
      sessions: registry,
      deliver: () => undefined,
      liveTargets: async () => ({ live: new Set(["$90", "%90"]), labels: new Map(), serverIdentity: "100:1" }),
      watch: () => { const handle = { close: () => undefined }; handles.push(handle); return handle; },
      pollIntervalMs: 0,
      debounceMs: 0,
    });

    await delivery.refresh();
    assert.equal(delivery.observing, true, "an active turn keeps the watcher open");
    assert.equal(handles.length, 1);

    await registry.transitionTurn(turn.turnId, "running", { parentPiSessionId: "pi-parent" });
    await registry.transitionTurn(turn.turnId, "completed", { parentPiSessionId: "pi-parent" });
    let delivered = 0;
    // Deliver with a fresh instance to avoid double-counting the first pass.
    const second = new TurnCompletionDelivery({
      ownerPiSessionId: "pi-parent",
      sessions: registry,
      deliver: () => { delivered++; },
      watch: () => undefined,
      pollIntervalMs: 0,
      debounceMs: 0,
    });
    await second.refresh();
    assert.equal(delivered, 1);
    assert.equal(second.observing, false);
  });
});
