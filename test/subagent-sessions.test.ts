import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SubagentJobRegistry } from "../src/subagent-jobs.ts";
import {
  SubagentSessionRegistry,
  defaultSubagentSessionsPath,
  isTerminalSessionStatus,
  isTerminalTurnStatus,
  migrateSubagentJobs,
} from "../src/subagent-sessions.ts";
import { TmuxError } from "../src/tmux.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tsxAvailable = existsSync(path.join(repoRoot, "node_modules", "tsx", "package.json"));

async function withSessions(
  run: (registry: SubagentSessionRegistry, file: string, directory: string) => Promise<void>,
  relative = path.join("nested", "subagent-sessions.json"),
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-tmux-sessions-"));
  try {
    const file = path.join(directory, relative);
    await run(new SubagentSessionRegistry(file), file, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

interface SessionHarness {
  sessionId: string;
  turnId?: string;
}

/** Creates a session, binds a stable target, and (optionally) a bound queued turn. */
async function newSession(
  registry: SubagentSessionRegistry,
  options: { parent?: string | null; agent?: "pi" | "claude-code" | "opencode"; tmuxSessionId?: string; serverIdentity?: string } = {},
): Promise<SessionHarness> {
  const session = await registry.createSession({ agent: options.agent ?? "pi", cwd: "/work", parentPiSessionId: options.parent ?? null });
  await registry.bindSession(session.sessionId, { tmuxSessionId: options.tmuxSessionId ?? "$1", ...(options.serverIdentity ? { serverIdentity: options.serverIdentity } : {}) });
  return { sessionId: session.sessionId };
}

/** Drives a session's turn A to terminal, leaving the session idle. */
async function runTurn(
  registry: SubagentSessionRegistry,
  sessionId: string,
  status: "completed" | "failed" | "cancelled" | "lost",
  options: { pane?: string; at?: string } = {},
): Promise<string> {
  const turn = await registry.createTurn(sessionId);
  await registry.bindTurn(turn.turnId, { tmuxPaneId: options.pane ?? "%1" });
  await registry.transitionTurn(turn.turnId, "starting", options.at ? { at: options.at } : {});
  if (status === "cancelled" || status === "lost") {
    await registry.transitionTurn(turn.turnId, status, options.at ? { at: options.at } : {});
    return turn.turnId;
  }
  await registry.transitionTurn(turn.turnId, "running", options.at ? { at: options.at } : {});
  await registry.transitionTurn(turn.turnId, status, { exitCode: status === "completed" ? 0 : 1, ...(options.at ? { at: options.at } : {}) });
  return turn.turnId;
}

test("default sessions path honours PI_TMUX_SUBAGENT_SESSIONS and XDG_STATE_HOME with a documented fallback", () => {
  assert.equal(defaultSubagentSessionsPath({ PI_TMUX_SUBAGENT_SESSIONS: "/custom/sessions.json", XDG_STATE_HOME: "/state" } as NodeJS.ProcessEnv), "/custom/sessions.json");
  assert.equal(defaultSubagentSessionsPath({ XDG_STATE_HOME: "/state" } as NodeJS.ProcessEnv), path.join("/state", "pi-tmux", "subagent-sessions.json"));
  assert.equal(defaultSubagentSessionsPath({} as NodeJS.ProcessEnv), path.join(os.homedir(), ".local", "state", "pi-tmux", "subagent-sessions.json"));
});

test("sessions support every agent and follow the legal starting -> idle lifecycle", async () => {
  await withSessions(async (registry) => {
    assert.deepEqual(await registry.listSessions(), []);
    for (const agent of ["pi", "claude-code", "opencode"] as const) {
      const session = await registry.createSession({ agent, cwd: "/work", parentPiSessionId: "pi-parent" });
      assert.equal(session.agent, agent);
      assert.equal(session.version, 1);
      assert.equal(session.status, "starting");
      assert.equal(session.tmuxSessionId, null);
      assert.deepEqual(await registry.getSession(session.sessionId), session);
      await registry.transitionSession(session.sessionId, "idle");
      assert.equal((await registry.getSession(session.sessionId))!.status, "idle");
    }
    await assert.rejects(() => registry.createSession({ agent: "codex" as never, cwd: "/work", parentPiSessionId: "p" }), /agent must be one of/);
    await assert.rejects(() => registry.createSession({ agent: "pi", cwd: "/work", parentPiSessionId: "" }), /non-empty string or null/);
    assert.equal(await registry.getSession("missing"), undefined);
    await assert.rejects(() => registry.transitionSession("missing", "idle"), /Unknown subagent session/);
  });
});

test("sessions bind one stable tmux session and reject live reuse and illegal transitions", async () => {
  await withSessions(async (registry) => {
    const first = await newSession(registry, { tmuxSessionId: "$1", serverIdentity: "100:5" });
    await registry.bindSession(first.sessionId, { tmuxSessionId: "$1" }); // idempotent repeat
    await assert.rejects(() => registry.bindSession(first.sessionId, { tmuxSessionId: "$2" }), /already bound/);
    await assert.rejects(() => registry.bindSession(first.sessionId, { tmuxSessionId: "named", }), /stable tmux ID/);

    const second = await registry.createSession({ agent: "pi", cwd: "/work", parentPiSessionId: null });
    await assert.rejects(() => registry.bindSession(second.sessionId, { tmuxSessionId: "$1" }), /already bound to active session/);
    await registry.transitionSession(first.sessionId, "stopped");
    await registry.bindSession(second.sessionId, { tmuxSessionId: "$1" });

    await assert.rejects(() => registry.transitionSession(first.sessionId, "idle"), /immutable/);
    await assert.rejects(() => registry.transitionSession(second.sessionId, "busy"), /starting a turn/);
    await registry.transitionSession(second.sessionId, "idle");
    await assert.rejects(() => registry.transitionSession(second.sessionId, "starting"), /Illegal transition/);
    await assert.rejects(() => registry.transitionSession(second.sessionId, "nonsense" as never), /Unknown subagent session status/);
  });
});

test("turns transition independently and terminal turn outcomes are immutable", async () => {
  await withSessions(async (registry) => {
    const { sessionId } = await newSession(registry);
    const turn = await registry.createTurn(sessionId);
    assert.equal(turn.status, "queued");
    assert.equal(turn.tmuxPaneId, null);

    // starting/running require a bound pane; the rejection must not persist.
    await assert.rejects(() => registry.transitionTurn(turn.turnId, "starting"), /must be bound/);
    assert.equal((await registry.getTurn(turn.turnId))!.status, "queued");
    await assert.rejects(() => registry.transitionTurn(turn.turnId, "completed"), /Illegal transition/);

    await registry.bindTurn(turn.turnId, { tmuxPaneId: "%1" });
    await registry.bindTurn(turn.turnId, { tmuxPaneId: "%1" }); // idempotent repeat
    await assert.rejects(() => registry.bindTurn(turn.turnId, { tmuxPaneId: "%2" }), /already bound/);

    const starting = await registry.transitionTurn(turn.turnId, "starting");
    assert.equal(starting.status, "starting");
    assert.ok(starting.startedAt);
    const running = await registry.transitionTurn(turn.turnId, "running");
    assert.deepEqual(await registry.transitionTurn(turn.turnId, "running"), running, "duplicate non-terminal transitions are idempotent");

    const completed = await registry.transitionTurn(turn.turnId, "completed", { exitCode: 0, resultPath: "/work/out.txt" });
    assert.equal(completed.exitCode, 0);
    assert.equal(completed.resultPath, "/work/out.txt");
    assert.equal(completed.completionSeq, 1);
    assert.ok(completed.finishedAt);

    await assert.rejects(() => registry.transitionTurn(turn.turnId, "failed"), /immutable/);
    await assert.rejects(() => registry.transitionTurn(turn.turnId, "running"), /immutable/);
    assert.deepEqual(await registry.transitionTurn(turn.turnId, "completed"), completed, "a duplicate terminal transition is a no-op");
    assert.equal(isTerminalTurnStatus((await registry.getTurn(turn.turnId))!.status), true);
  });
});

test("a completed turn returns the session to idle and a second turn can run", async () => {
  await withSessions(async (registry) => {
    const { sessionId } = await newSession(registry);
    const first = await runTurn(registry, sessionId, "completed", { pane: "%1" });
    const afterFirst = (await registry.getSession(sessionId))!;
    assert.equal(afterFirst.status, "idle", "a terminal turn never terminates the session");
    assert.equal(isTerminalSessionStatus(afterFirst.status), false);

    const second = await runTurn(registry, sessionId, "completed", { pane: "%2" });
    assert.notEqual(first, second);
    const turns = await registry.listTurns({ sessionId });
    assert.deepEqual(turns.map((turn) => turn.turnId), [first, second]);
    assert.equal(turns[0]!.completionSeq, 1);
    assert.equal(turns[1]!.completionSeq, 2);
    assert.equal(turns[0]!.status, "completed");
    assert.equal(turns[1]!.status, "completed");
    assert.equal((await registry.getSession(sessionId))!.status, "idle");
  });
});

test("only one active turn per session is allowed; failed turns do not stop the session", async () => {
  await withSessions(async (registry) => {
    const { sessionId } = await newSession(registry);
    const first = await registry.createTurn(sessionId);
    await registry.bindTurn(first.turnId, { tmuxPaneId: "%1" });
    await registry.transitionTurn(first.turnId, "starting");
    await assert.rejects(() => registry.createTurn(sessionId), /only one active turn/);
    await assert.rejects(() => registry.transitionSession(sessionId, "stopped"), /active turn/);

    await registry.transitionTurn(first.turnId, "running");
    await assert.rejects(() => registry.createTurn(sessionId), /only one active turn/);
    await registry.transitionTurn(first.turnId, "failed", { error: "boom" });
    assert.equal((await registry.getSession(sessionId))!.status, "idle");

    const second = await registry.createTurn(sessionId);
    assert.equal(second.status, "queued");
  });
});

test("turn binding refuses to reuse a pane owned by another active turn", async () => {
  await withSessions(async (registry) => {
    const first = await newSession(registry, { tmuxSessionId: "$1" });
    const firstTurn = await registry.createTurn(first.sessionId);
    await registry.bindTurn(firstTurn.turnId, { tmuxPaneId: "%1" });
    await registry.transitionTurn(firstTurn.turnId, "starting");

    const second = await newSession(registry, { tmuxSessionId: "$2" });
    const secondTurn = await registry.createTurn(second.sessionId);
    await assert.rejects(() => registry.bindTurn(secondTurn.turnId, { tmuxPaneId: "%1" }), /already bound to active turn/);

    await registry.transitionTurn(firstTurn.turnId, "running");
    await registry.transitionTurn(firstTurn.turnId, "completed");
    await registry.bindTurn(secondTurn.turnId, { tmuxPaneId: "%1" });
  });
});

test("agentSessionId is stored for resume and is immutable once set", async () => {
  await withSessions(async (registry) => {
    const { sessionId } = await newSession(registry, { agent: "claude-code" });
    await runTurn(registry, sessionId, "completed");
    const stored = await registry.setAgentSessionId(sessionId, "claude-conversation-1");
    assert.equal(stored.agentSessionId, "claude-conversation-1");
    assert.deepEqual(await registry.setAgentSessionId(sessionId, "claude-conversation-1"), stored, "setting the same id is idempotent");
    await assert.rejects(() => registry.setAgentSessionId(sessionId, "different"), /immutable/);
    await assert.rejects(() => registry.setAgentSessionId(sessionId, "x".repeat(600)), /longer than/);
    await runTurn(registry, sessionId, "completed", { pane: "%2" });
    assert.equal((await registry.getSession(sessionId))!.agentSessionId, "claude-conversation-1", "the native id survives the next turn");
  });
});

test("parent ownership isolation refuses cross-parent mutations and deliveries", async () => {
  await withSessions(async (registry) => {
    const mine = await newSession(registry, { parent: "pi-a", tmuxSessionId: "$1", serverIdentity: "1:1" });
    const theirs = await newSession(registry, { parent: "pi-b", tmuxSessionId: "$2", serverIdentity: "1:1" });
    const mineTurn = await registry.createTurn(mine.sessionId);
    await registry.bindTurn(mineTurn.turnId, { tmuxPaneId: "%1" });
    const theirsTurn = await registry.createTurn(theirs.sessionId);
    await registry.bindTurn(theirsTurn.turnId, { tmuxPaneId: "%2" });

    await assert.rejects(() => registry.transitionSession(theirs.sessionId, "idle", { parentPiSessionId: "pi-a" }), /another Pi conversation/);
    await assert.rejects(() => registry.createTurn(theirs.sessionId, { parentPiSessionId: "pi-a" }), /another Pi conversation/);
    await assert.rejects(() => registry.bindTurn(theirsTurn.turnId, { tmuxPaneId: "%9" }, { parentPiSessionId: "pi-a" }), /another Pi conversation/);
    await assert.rejects(() => registry.transitionTurn(theirsTurn.turnId, "starting", { parentPiSessionId: "pi-a" }), /another Pi conversation/);

    // Reconcile scoped to pi-a can never touch pi-b's session or turn.
    const result = await registry.reconcile({ live: new Set<string>(), serverIdentity: "1:1" }, { parentPiSessionId: "pi-a" });
    assert.deepEqual(result.sessions.map((session) => session.sessionId), [mine.sessionId]);
    assert.deepEqual(result.turns.map((turn) => turn.turnId), [mineTurn.turnId]);
    assert.equal((await registry.getSession(theirs.sessionId))!.status, "starting");
    assert.equal((await registry.getTurn(theirsTurn.turnId))!.status, "queued");
    await assert.rejects(() => registry.reconcile({ live: new Set<string>() }, { parentPiSessionId: "" }), /non-empty string/);
  });
});

test("reconcile marks vanished targets lost, scoped to an owner, without rewriting on a no-op", async () => {
  await withSessions(async (registry, file) => {
    const live = await newSession(registry, { parent: "pi-a", tmuxSessionId: "$1", serverIdentity: "1:1" });
    const liveTurn = await registry.createTurn(live.sessionId);
    await registry.bindTurn(liveTurn.turnId, { tmuxPaneId: "%1" });
    await registry.transitionTurn(liveTurn.turnId, "starting");
    await registry.transitionTurn(liveTurn.turnId, "running");

    const gone = await newSession(registry, { parent: "pi-a", tmuxSessionId: "$2", serverIdentity: "1:1" });
    const goneTurn = await registry.createTurn(gone.sessionId);
    await registry.bindTurn(goneTurn.turnId, { tmuxPaneId: "%2" });
    await registry.transitionTurn(goneTurn.turnId, "starting");
    await registry.transitionTurn(goneTurn.turnId, "running");

    const foreign = await newSession(registry, { parent: "pi-b", tmuxSessionId: "$3", serverIdentity: "1:1" });

    const before = await stat(file);
    const noop = await registry.reconcile({ live: new Set(["$1", "%1", "$2", "%2"]), serverIdentity: "1:1" }, { parentPiSessionId: "pi-a" });
    assert.deepEqual(noop, { sessions: [], turns: [] });
    const after = await stat(file);
    assert.equal(after.ino, before.ino, "a no-op reconcile must not rename the registry file");
    assert.equal(after.mtimeMs, before.mtimeMs, "a no-op reconcile must not write the registry file");

    const lost = await registry.reconcile({ live: new Set(["$1", "%1"]), serverIdentity: "1:1" }, { parentPiSessionId: "pi-a" });
    assert.deepEqual(lost.turns.map((turn) => turn.turnId), [goneTurn.turnId]);
    assert.deepEqual(lost.sessions.map((session) => session.sessionId), [gone.sessionId]);
    assert.equal(lost.turns[0]!.status, "lost");
    assert.ok(lost.turns[0]!.completionSeq);
    assert.equal((await registry.getTurn(goneTurn.turnId))!.status, "lost");
    assert.equal((await registry.getSession(gone.sessionId))!.status, "lost");
    assert.equal((await registry.getTurn(liveTurn.turnId))!.status, "running", "a live target is untouched");
    assert.equal((await registry.getSession(foreign.sessionId))!.status, "starting", "another parent is never reconciled");
  });
});

test("reconcile returns a session with a live target to idle when only its pane vanished", async () => {
  await withSessions(async (registry) => {
    const { sessionId } = await newSession(registry, { tmuxSessionId: "$1", serverIdentity: "1:1" });
    const turn = await registry.createTurn(sessionId);
    await registry.bindTurn(turn.turnId, { tmuxPaneId: "%7" });
    await registry.transitionTurn(turn.turnId, "starting");
    await registry.transitionTurn(turn.turnId, "running");
    assert.equal((await registry.getSession(sessionId))!.status, "busy");

    const result = await registry.reconcile({ live: new Set(["$1"]), serverIdentity: "1:1" });
    assert.deepEqual(result.turns.map((item) => item.turnId), [turn.turnId]);
    assert.deepEqual(result.sessions.map((item) => item.sessionId), [sessionId]);
    assert.equal((await registry.getTurn(turn.turnId))!.status, "lost");
    assert.equal((await registry.getSession(sessionId))!.status, "idle", "the surviving tmux session can run another turn");
  });
});

test("reconcile treats a changed tmux server identity as loss", async () => {
  await withSessions(async (registry) => {
    const { sessionId } = await newSession(registry, { tmuxSessionId: "$1", serverIdentity: "1:1" });
    const turn = await registry.createTurn(sessionId);
    await registry.bindTurn(turn.turnId, { tmuxPaneId: "%1" });
    await registry.transitionTurn(turn.turnId, "starting");
    await registry.transitionTurn(turn.turnId, "running");

    await registry.reconcile({ live: new Set(["$1", "%1"]), serverIdentity: "2:2" });
    assert.equal((await registry.getTurn(turn.turnId))!.status, "lost");
    assert.equal((await registry.getSession(sessionId))!.status, "lost");
  });
});

test("delivery bookkeeping is ordered, idempotent, terminal-only, and owner-scoped", async () => {
  await withSessions(async (registry) => {
    const first = await newSession(registry, { parent: "pi-a", tmuxSessionId: "$1" });
    const firstTurn = await runTurn(registry, first.sessionId, "cancelled", { pane: "%1" });
    const second = await newSession(registry, { parent: "pi-a", tmuxSessionId: "$2" });
    const secondTurn = await runTurn(registry, second.sessionId, "failed", { pane: "%2" });
    const theirs = await newSession(registry, { parent: "pi-b", tmuxSessionId: "$3" });
    const theirsTurn = await runTurn(registry, theirs.sessionId, "completed", { pane: "%3" });
    const active = await newSession(registry, { parent: "pi-a", tmuxSessionId: "$4" });
    const activeTurn = await registry.createTurn(active.sessionId);
    await registry.bindTurn(activeTurn.turnId, { tmuxPaneId: "%4" });

    const pending = await registry.pendingDeliveries();
    assert.deepEqual(pending.map((turn) => turn.turnId), [firstTurn, secondTurn, theirsTurn]);
    assert.ok(pending[0]!.completionSeq! < pending[1]!.completionSeq!);
    assert.deepEqual((await registry.pendingDeliveries({ parentPiSessionId: "pi-a" })).map((turn) => turn.turnId), [firstTurn, secondTurn]);
    await assert.rejects(() => registry.markNotified(activeTurn.turnId), /terminal/);

    const notified = await registry.markNotified(firstTurn, { parentPiSessionId: "pi-a" });
    assert.ok(notified.notifiedAt);
    assert.deepEqual(await registry.markNotified(firstTurn), notified, "marking twice is idempotent");
    await assert.rejects(() => registry.markNotified(theirsTurn, { parentPiSessionId: "pi-a" }), /another Pi conversation/);
    assert.deepEqual((await registry.pendingDeliveries()).map((turn) => turn.turnId), [secondTurn, theirsTurn]);
  });
});

test("sessions and turns survive registry re-instantiation", async () => {
  await withSessions(async (registry, file) => {
    const { sessionId } = await newSession(registry, { parent: "pi-a", tmuxSessionId: "$1", serverIdentity: "1:1" });
    const completed = await runTurn(registry, sessionId, "completed", { pane: "%1" });
    const active = await registry.createTurn(sessionId);
    await registry.bindTurn(active.turnId, { tmuxPaneId: "%2" });
    await registry.transitionTurn(active.turnId, "starting");
    await registry.transitionTurn(active.turnId, "running");
    await registry.setAgentSessionId(sessionId, "native-1");

    const restarted = new SubagentSessionRegistry(file);
    const session = (await restarted.getSession(sessionId))!;
    assert.equal(session.agentSessionId, "native-1");
    assert.equal(session.status, "busy");
    assert.equal((await restarted.getTurn(completed))!.status, "completed");
    assert.equal((await restarted.getTurn(active.turnId))!.status, "running");
    await restarted.transitionTurn(active.turnId, "completed", { exitCode: 0 });
    const again = new SubagentSessionRegistry(file);
    assert.equal((await again.getSession(sessionId))!.status, "idle");
    assert.deepEqual((await again.listSessions({ status: ["starting", "busy"] })), []);
  });
});

test("filters narrow sessions and turns by status, agent, owner, and session", async () => {
  await withSessions(async (registry) => {
    const piSession = await newSession(registry, { parent: "pi-a", agent: "pi", tmuxSessionId: "$1" });
    await registry.transitionSession(piSession.sessionId, "idle");
    const claude = await newSession(registry, { parent: "pi-a", agent: "claude-code", tmuxSessionId: "$2" });
    const other = await newSession(registry, { parent: "pi-b", agent: "opencode", tmuxSessionId: "$3" });

    await registry.createTurn(claude.sessionId);

    assert.deepEqual((await registry.listSessions({ agent: "claude-code" })).map((session) => session.sessionId), [claude.sessionId]);
    assert.deepEqual((await registry.listSessions({ parentPiSessionId: "pi-b" })).map((session) => session.sessionId), [other.sessionId]);
    assert.deepEqual((await registry.listSessions({ status: "starting" })).map((session) => session.sessionId).sort(), [claude.sessionId, other.sessionId].sort());
    assert.deepEqual((await registry.listTurns({ parentPiSessionId: "pi-b" })), []);
    assert.equal((await registry.listTurns({ status: "queued" })).length, 1);
    assert.equal((await registry.listTurns({ sessionId: piSession.sessionId })).length, 0);
  });
});

test("corrupt, unknown, dangling, or duplicate state is reported and never overwritten", async () => {
  await withSessions(async (registry) => {
    await mkdir(path.dirname(registry.file), { recursive: true });
    const now = new Date(0).toISOString();
    const goodSession = { version: 1, sessionId: "s1", agent: "pi", parentPiSessionId: null, cwd: "/w", status: "idle", tmuxSessionId: "$1", createdAt: now, updatedAt: now };
    const goodTurn = { version: 1, turnId: "t1", sessionId: "s1", status: "completed", tmuxPaneId: "%1", createdAt: now, finishedAt: now, completionSeq: 1 };
    const cases = [
      "{ not json",
      JSON.stringify({ version: 2, nextCompletionSeq: 1, sessions: [], turns: [] }),
      JSON.stringify({ version: 1, sessions: [], turns: [] }),
      JSON.stringify({ version: 1, nextCompletionSeq: 1, sessions: [{ ...goodSession, agent: "codex" }], turns: [] }),
      JSON.stringify({ version: 1, nextCompletionSeq: 1, sessions: [goodSession], turns: [{ ...goodTurn, sessionId: "missing" }] }),
      JSON.stringify({ version: 1, nextCompletionSeq: 1, sessions: [goodSession], turns: [goodTurn, { ...goodTurn }] }),
      JSON.stringify({ version: 1, nextCompletionSeq: 1, sessions: [goodSession, { ...goodSession }], turns: [] }),
      JSON.stringify({ version: 1, nextCompletionSeq: 1, sessions: [{ ...goodSession, updatedAt: "not-a-date" }], turns: [] }),
    ];
    for (const content of cases) {
      await writeFile(registry.file, content, "utf8");
      await assert.rejects(() => registry.listSessions(), (error: unknown) => error instanceof TmuxError);
      await assert.rejects(() => registry.createSession({ agent: "pi", cwd: "/work", parentPiSessionId: null }), (error: unknown) => error instanceof TmuxError);
      assert.equal(await readFile(registry.file, "utf8"), content, "the original file must survive untouched");
    }
  });
});

test("retention keeps active and undelivered work and caps acknowledged history", async () => {
  await withSessions(async (registry) => {
    const bounded = new SubagentSessionRegistry(registry.file, {
      maxAcknowledgedTurns: 1,
      maxTurns: 20,
      maxAcknowledgedSessions: 1,
      maxSessions: 20,
    });
    const sessions: string[] = [];
    for (let index = 0; index < 3; index++) {
      const { sessionId } = await newSession(bounded, { tmuxSessionId: `$${index + 1}` });
      const turnId = await runTurn(bounded, sessionId, "completed", { pane: `%${index + 1}` });
      await bounded.markNotified(turnId);
      await bounded.transitionSession(sessionId, "stopped");
      sessions.push(sessionId);
    }
    // Acknowledged history is bounded; the newest acknowledged turn/session survive.
    const finalTurns = await bounded.listTurns();
    assert.equal(finalTurns.length, 1);
    assert.equal(finalTurns[0]!.completionSeq, 3);
    const finalSessions = (await bounded.listSessions({ status: "stopped" })).map((session) => session.sessionId);
    assert.equal(finalSessions.length, 2);
    assert.ok(finalSessions.includes(sessions[2]!));

    // Active and undelivered work is never evicted, even past the acknowledged bound.
    const busy = await newSession(bounded, { tmuxSessionId: "$90" });
    const busyTurn = await bounded.createTurn(busy.sessionId);
    await bounded.bindTurn(busyTurn.turnId, { tmuxPaneId: "%90" });
    await bounded.transitionTurn(busyTurn.turnId, "starting");
    await bounded.transitionTurn(busyTurn.turnId, "running");

    const undeliveredSession = await newSession(bounded, { tmuxSessionId: "$91" });
    await bounded.transitionSession(undeliveredSession.sessionId, "idle");
    const undeliveredTurn = await bounded.createTurn(undeliveredSession.sessionId);
    await bounded.bindTurn(undeliveredTurn.turnId, { tmuxPaneId: "%91" });
    await bounded.transitionTurn(undeliveredTurn.turnId, "starting");
    await bounded.transitionTurn(undeliveredTurn.turnId, "cancelled");

    assert.equal((await bounded.getSession(busy.sessionId))!.status, "busy");
    assert.equal((await bounded.getTurn(busyTurn.turnId))!.status, "running");
    assert.equal((await bounded.getTurn(undeliveredTurn.turnId))!.status, "cancelled");
    assert.deepEqual((await bounded.pendingDeliveries()).map((turn) => turn.turnId), [undeliveredTurn.turnId]);
  });
});

test("hard bounds reject new sessions and turns without evicting live data", async () => {
  await withSessions(async (registry) => {
    const bounded = new SubagentSessionRegistry(registry.file, { maxSessions: 2, maxAcknowledgedSessions: 1, maxTurns: 2, maxAcknowledgedTurns: 1 });
    const first = await bounded.createSession({ agent: "pi", cwd: "/work", parentPiSessionId: null });
    await bounded.createSession({ agent: "pi", cwd: "/work", parentPiSessionId: null });
    await assert.rejects(() => bounded.createSession({ agent: "pi", cwd: "/work", parentPiSessionId: null }), /hard bound/);
    assert.equal((await bounded.listSessions()).length, 2);

    await bounded.bindSession(first.sessionId, { tmuxSessionId: "$1" });
    const turnA = await bounded.createTurn(first.sessionId);
    await bounded.bindTurn(turnA.turnId, { tmuxPaneId: "%1" });
    await bounded.transitionTurn(turnA.turnId, "starting");
    await bounded.transitionTurn(turnA.turnId, "running");
    await bounded.transitionTurn(turnA.turnId, "completed");
    const turnB = await bounded.createTurn(first.sessionId);
    assert.ok(turnB.turnId);
    await assert.rejects(() => bounded.createTurn(first.sessionId), /only one active turn/);
    await bounded.bindTurn(turnB.turnId, { tmuxPaneId: "%2" });
    await bounded.transitionTurn(turnB.turnId, "starting");
    await bounded.transitionTurn(turnB.turnId, "running");
    await bounded.transitionTurn(turnB.turnId, "completed");
    await assert.rejects(() => bounded.createTurn(first.sessionId), /hard bound/);
    assert.equal((await bounded.listTurns()).length, 2, "the previous state is intact after a rejected create");
  });
});

test("the session file is owner-only and a failed write leaves the previous state intact", { skip: process.getuid?.() === 0 ? "running as root bypasses directory permissions" : false }, async () => {
  await withSessions(async (registry, file, directory) => {
    await registry.createSession({ agent: "pi", cwd: "/work", parentPiSessionId: null });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, "nested"))).mode & 0o777, 0o700);

    const before = await readFile(file, "utf8");
    await chmod(path.dirname(file), 0o500);
    try {
      await assert.rejects(() => registry.createSession({ agent: "pi", cwd: "/work", parentPiSessionId: null }), (error: unknown) => error instanceof TmuxError);
      assert.equal(await readFile(file, "utf8"), before, "a failed write must not clobber the previous state");
    } finally {
      await chmod(path.dirname(file), 0o700);
    }
    assert.deepEqual((await readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp")), [], "temporary files are cleaned up");
  });
});

test("two session registries sharing a file serialize read-modify-write", async () => {
  await withSessions(async (registry, file) => {
    const a = new SubagentSessionRegistry(file, { lockRetryMs: 1 });
    const b = new SubagentSessionRegistry(file, { lockRetryMs: 1 });
    const created = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? a : b).createSession({ agent: "pi", cwd: "/work", parentPiSessionId: null })));
    assert.equal(new Set(created.map((session) => session.sessionId)).size, 12, "every concurrent create is persisted");
    assert.equal((await a.listSessions()).length, 12);
    assert.equal((await registry.listSessions()).length, 12);
  });
});

test("concurrent processes cannot clobber each other's session updates", { skip: tsxAvailable ? false : "tsx is not installed" }, async () => {
  await withSessions(async (registry, file) => {
    const workers = 3;
    const perWorker = 6;
    const workerPath = path.join(import.meta.dirname, "subagent-session-worker.ts");
    const results = await Promise.all(Array.from({ length: workers }, (_, worker) => runSessionWorker(workerPath, file, worker, perWorker)));
    const ids = results.flat();
    assert.equal(new Set(ids).size, workers * perWorker);
    const sessions = await registry.listSessions();
    const turns = await registry.listTurns();
    assert.equal(sessions.length, workers * perWorker, "no create was lost to a concurrent write");
    assert.equal(turns.length, workers * perWorker);
    assert.equal(turns.filter((turn) => turn.status === "completed").length, turns.length, "every turn lifecycle finished");
    assert.equal(new Set(turns.map((turn) => turn.turnId)).size, turns.length);
  });
});

test("legacy V1 Pi jobs migrate atomically into sessions and turns, preserving delivery state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-tmux-migrate-"));
  try {
    const jobsFile = path.join(directory, "jobs.json");
    const sessionsFile = path.join(directory, "sessions.json");
    const jobs = new SubagentJobRegistry(jobsFile);

    // completed + already acknowledged
    const completed = await jobs.create({ cwd: "/work", parentPiSessionId: "pi-a" });
    await jobs.bind(completed.jobId, { tmuxSessionId: "$1", tmuxPaneId: "%1", serverIdentity: "1:1" });
    await jobs.transition(completed.jobId, "starting");
    await jobs.transition(completed.jobId, "running");
    await jobs.transition(completed.jobId, "completed", { exitCode: 0, resultPath: "/work/out.txt" });
    await jobs.markNotified(completed.jobId, { at: new Date(10_000).toISOString() });
    // running active
    const running = await jobs.create({ cwd: "/work", parentPiSessionId: "pi-a" });
    await jobs.bind(running.jobId, { tmuxSessionId: "$2", tmuxPaneId: "%2", serverIdentity: "1:1" });
    await jobs.transition(running.jobId, "starting");
    await jobs.transition(running.jobId, "running");
    // cancelled and still undelivered, with a completion sequence
    const cancelled = await jobs.create({ cwd: "/work", parentPiSessionId: "pi-b" });
    await jobs.bind(cancelled.jobId, { tmuxSessionId: "$3", tmuxPaneId: "%3", serverIdentity: "1:1" });
    await jobs.transition(cancelled.jobId, "starting");
    await jobs.transition(cancelled.jobId, "cancelled", { error: "user cancelled" });
    // lost
    const lost = await jobs.create({ cwd: "/work", parentPiSessionId: null });
    await jobs.bind(lost.jobId, { tmuxSessionId: "$4", tmuxPaneId: "%4", serverIdentity: "1:1" });
    await jobs.transition(lost.jobId, "starting");
    await jobs.transition(lost.jobId, "lost", { error: "target vanished" });

    const legacy = await jobs.list();
    assert.equal(legacy.length, 4);

    const sessions = new SubagentSessionRegistry(sessionsFile);
    const result = await migrateSubagentJobs({ jobs, sessions });
    assert.deepEqual(result, { imported: 4, skipped: 0 });

    const migrated = await sessions.listSessions();
    assert.equal(migrated.length, 4);
    const byLegacy = new Map(migrated.map((session) => [session.legacyJobId, session]));
    assert.equal(byLegacy.get(completed.jobId)!.status, "idle");
    assert.equal(byLegacy.get(running.jobId)!.status, "busy");
    assert.equal(byLegacy.get(cancelled.jobId)!.status, "stopped");
    assert.equal(byLegacy.get(lost.jobId)!.status, "lost");
    assert.equal(byLegacy.get(completed.jobId)!.agent, "pi");
    assert.equal(byLegacy.get(completed.jobId)!.serverIdentity, "1:1");

    const turns = await sessions.listTurns();
    const turnBySession = new Map(turns.map((turn) => [turn.sessionId, turn]));
    const completedTurn = turnBySession.get(byLegacy.get(completed.jobId)!.sessionId)!;
    assert.equal(completedTurn.status, "completed");
    assert.equal(completedTurn.exitCode, 0);
    assert.equal(completedTurn.resultPath, "/work/out.txt");
    assert.ok(completedTurn.notifiedAt, "the acknowledgement is preserved");
    assert.equal(turnBySession.get(byLegacy.get(running.jobId)!.sessionId)!.status, "running");
    assert.equal(turnBySession.get(byLegacy.get(cancelled.jobId)!.sessionId)!.status, "cancelled");
    assert.equal(turnBySession.get(byLegacy.get(lost.jobId)!.sessionId)!.status, "lost");

    // Pending deliveries remain recoverable and scoped to their owner.
    const pending = await sessions.pendingDeliveries();
    assert.deepEqual(pending.map((turn) => turn.status).sort(), ["cancelled", "lost"]);
    assert.deepEqual((await sessions.pendingDeliveries({ parentPiSessionId: "pi-b" })).map((turn) => turn.status), ["cancelled"]);

    // Re-running the migration is a no-op, and a post-migration turn continues the sequence.
    assert.deepEqual(await migrateSubagentJobs({ jobs, sessions }), { imported: 0, skipped: 4 });
    assert.equal((await sessions.listSessions()).length, 4);
    const nextTurn = await sessions.createTurn(byLegacy.get(completed.jobId)!.sessionId);
    await sessions.bindTurn(nextTurn.turnId, { tmuxPaneId: "%99" });
    await sessions.transitionTurn(nextTurn.turnId, "starting");
    await sessions.transitionTurn(nextTurn.turnId, "running");
    await sessions.transitionTurn(nextTurn.turnId, "completed");
    assert.ok((await sessions.getTurn(nextTurn.turnId))!.completionSeq! > (completedTurn.completionSeq ?? 0));

    // The legacy file is never destroyed.
    assert.equal((await jobs.list()).length, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration fails closed on a corrupt legacy file and leaves the session registry untouched", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-tmux-migrate-bad-"));
  try {
    const jobsFile = path.join(directory, "jobs.json");
    const sessionsFile = path.join(directory, "sessions.json");
    await writeFile(jobsFile, "{ not valid json", "utf8");
    await assert.rejects(() => migrateSubagentJobs({ jobsFile, sessionsFile }), (error: unknown) => error instanceof TmuxError);
    await assert.rejects(() => readFile(sessionsFile, "utf8"), /ENOENT/, "no session state is written for a failed migration");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid mutation inputs fail before any write", async () => {
  await withSessions(async (registry) => {
    await assert.rejects(() => registry.createSession({ agent: "pi", cwd: "", parentPiSessionId: null }), /cwd must be a non-empty string/);
    const { sessionId } = await newSession(registry);
    const turn = await registry.createTurn(sessionId);
    await assert.rejects(() => registry.transitionTurn(turn.turnId, "completed" as never, { exitCode: 1.5 }), /exitCode must be a safe integer/);
    await assert.rejects(() => registry.transitionTurn("missing", "starting"), /Unknown subagent turn/);
    await assert.rejects(() => registry.bindTurn(turn.turnId, { tmuxPaneId: "pane-name" }), /stable tmux ID/);
    await assert.rejects(() => registry.transitionTurn(turn.turnId, "starting", { at: "not-a-date" }), /ISO-8601/);
    assert.throws(() => new SubagentSessionRegistry(registry.file, { maxAcknowledgedTurns: 5, maxTurns: 2 }), /cannot exceed/);
  });
});

async function runSessionWorker(workerPath: string, file: string, worker: number, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, file, String(worker), String(count)], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`worker ${worker} exited ${code}: ${stderr || stdout}`));
        return;
      }
      try { resolve(JSON.parse(stdout) as string[]); } catch (error) { reject(new Error(`worker ${worker} returned invalid JSON: ${String(error)}`)); }
    });
  });
}
