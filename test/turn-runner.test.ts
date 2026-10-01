import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { completionDirFor } from "../src/subagent-reporter.ts";
import { type SubagentSessionV1, type SubagentTurnV1, SubagentSessionRegistry } from "../src/subagent-sessions.ts";
import { TmuxError } from "../src/tmux.ts";
import {
  RUNNER_ENV,
  type RunnerSpecV1,
  defaultRunnerPath,
  parseRunnerInvocation,
  runTurn,
  validateRunnerSpec,
} from "../src/turn-runner.ts";

/**
 * Fake-executable tests for the generic turn runner (issue #11). They use real
 * child processes and a real on-disk session/turn registry; no Claude/OpenCode
 * credentials or installed agent are required.
 */

/** A single fake agent, switched by the `FAKE_MODE` environment value. */
const AGENT_SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.env.FAKE_SPAWN_LOG) { try { fs.appendFileSync(process.env.FAKE_SPAWN_LOG, process.pid + "\\n"); } catch {} }
const mode = process.env.FAKE_MODE || "success";
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  const argvTask = process.argv.length > 2 ? process.argv.slice(2).join("\\n") : "";
  const task = argvTask || data;
  const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  switch (mode) {
    case "success": emit({ session_id: "native-1", result: "done:" + task, is_error: false }); break;
    case "fail": process.exitCode = 3; emit({ session_id: "native-2", result: "", is_error: true, error: "boom" }); break;
    case "exit-nonzero": process.exitCode = 5; emit({ ok: true }); break;
    case "malformed": process.stdout.write("definitely not json\\n"); break;
    case "ndjson":
      emit({ type: "start" });
      emit({ session_id: "native-nd", result: "final:" + task, is_error: false });
      break;
    case "huge-stderr": process.stderr.write("E".repeat(200000)); emit({ session_id: "native-3", result: "ok" }); break;
    case "huge-stdout":
      for (let index = 0; index < 20000; index++) emit({ type: "progress", index });
      emit({ session_id: "native-4", result: "tail-ok" });
      break;
    case "sleep": setTimeout(() => undefined, 1500); return;
    default: emit({ session_id: "native", result: task }); break;
  }
});
`;

const PARSE = { sessionId: "session_id", text: "result", error: "error", isError: "is_error" } as const;

async function writeExecutable(dir: string, name: string, source: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, source, "utf8");
  await chmod(file, 0o755);
  return file;
}

function runnerSpec(executable: string, overrides: Partial<RunnerSpecV1> = {}): RunnerSpecV1 {
  return {
    version: 1,
    executable,
    args: [],
    env: { FAKE_MODE: "success" },
    output: "json",
    prompt: "stdin",
    parse: { ...PARSE },
    ...overrides,
  };
}

interface BoundTurn {
  session: SubagentSessionV1;
  turn: SubagentTurnV1;
  tmuxSessionId: string;
  pane: string;
}

let boundCounter = 0;

async function makeBoundTurn(
  registry: SubagentSessionRegistry,
  cwd: string,
  options: { owner?: string; agent?: "pi" | "claude-code" | "opencode"; serverIdentity?: string } = {},
): Promise<BoundTurn> {
  const owner = options.owner ?? "pi-parent";
  const tmuxSessionId = `$${++boundCounter}`;
  const pane = `%${boundCounter}`;
  const session = await registry.createSession({ agent: options.agent ?? "claude-code", cwd, parentPiSessionId: owner });
  await registry.bindSession(session.sessionId, { tmuxSessionId, serverIdentity: options.serverIdentity ?? "100:1" }, { parentPiSessionId: owner });
  const turn = await registry.createTurn(session.sessionId, { parentPiSessionId: owner });
  await registry.bindTurn(turn.turnId, { tmuxPaneId: pane }, { parentPiSessionId: owner });
  await registry.transitionTurn(turn.turnId, "starting", { parentPiSessionId: owner });
  return { session: (await registry.getSession(session.sessionId))!, turn: (await registry.getTurn(turn.turnId))!, tmuxSessionId, pane };
}

function identityFor(bound: BoundTurn, overrides: Record<string, string> = {}) {
  return { sessionId: bound.session.sessionId, turnId: bound.turn.turnId, paneId: bound.pane, owner: "pi-parent", serverPid: "100", ...overrides };
}

async function payloadFiles(statePath: string): Promise<string[]> {
  const dir = completionDirFor(statePath);
  return (await readdir(dir).catch(() => [] as string[])).map((name) => path.join(dir, name));
}

async function readPayload(resultPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
}

async function withTempDir(run: (dir: string) => Promise<void>, prefix = "pi-turn-runner-"): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a runner turn completes from structured JSON, stores a bounded payload, captures the native id, and returns the session to idle", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const agent = await writeExecutable(dir, "agent.cjs", AGENT_SCRIPT);
    const bound = await makeBoundTurn(registry, dir);
    const task = "summarize the repository";

    const result = await runTurn({ registry, spec: runnerSpec(agent), task, identity: identityFor(bound) });

    assert.equal(result.status, "completed");
    assert.equal(result.passive, false);
    assert.equal(result.agentSessionId, "native-1");
    assert.ok(result.resultPath, "a completion payload was recorded");
    const payload = await readPayload(result.resultPath!);
    assert.equal(payload.version, 1);
    assert.equal(payload.status, "completed");
    assert.equal(payload.agent, "claude-code");
    assert.equal(payload.sessionId, bound.session.sessionId);
    assert.equal(payload.turnId, bound.turn.turnId);
    assert.equal(payload.agentSessionId, "native-1");
    assert.equal(payload.summary, "done:summarize the repository");
    assert.equal(payload.exitCode, 0);

    const stored = (await registry.getSession(bound.session.sessionId))!;
    assert.equal(stored.status, "idle", "the logical session survives and is reusable");
    assert.equal(stored.agentSessionId, "native-1", "the native conversation id is durably captured");
    assert.equal((await registry.getTurn(bound.turn.turnId))!.status, "completed");
    assert.equal((await registry.getTurn(bound.turn.turnId))!.resultPath, result.resultPath);
  });
});

test("a runner turn delivers the prompt verbatim on stdin and as one argv element, never through a shell", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const agent = await writeExecutable(dir, "agent.cjs", AGENT_SCRIPT);
    const task = `'; touch ${path.join(dir, "pwned")}; echo "$(whoami)" \`id\`\nsecond --line`;
    const sideEffect = path.join(dir, "pwned");

    const stdinBound = await makeBoundTurn(registry, dir);
    const stdinResult = await runTurn({ registry, spec: runnerSpec(agent), task, identity: identityFor(stdinBound) });
    assert.equal(stdinResult.status, "completed");
    assert.equal((await readPayload(stdinResult.resultPath!)).summary, `done:${task}`);

    const argvBound = await makeBoundTurn(registry, dir);
    const argvResult = await runTurn({
      registry,
      spec: runnerSpec(agent, { prompt: "argv" }),
      task,
      identity: identityFor(argvBound),
    });
    assert.equal(argvResult.status, "completed");
    assert.equal((await readPayload(argvResult.resultPath!)).summary, `done:${task}`);

    await assert.rejects(readFile(sideEffect), /ENOENT/, "shell metacharacters never executed");
  });
});

test("a runner turn supports an executable path containing spaces without a shell", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const agent = await writeExecutable(dir, "agent with space.cjs", AGENT_SCRIPT);
    const bound = await makeBoundTurn(registry, dir);
    const result = await runTurn({ registry, spec: runnerSpec(agent), task: "spaces", identity: identityFor(bound) });
    assert.equal(result.status, "completed");
    assert.equal((await readPayload(result.resultPath!)).summary, "done:spaces");
  });
});

test("a non-zero exit is recorded as failed with the exit code and no success inference", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const agent = await writeExecutable(dir, "agent.cjs", AGENT_SCRIPT);
    const bound = await makeBoundTurn(registry, dir);

    const result = await runTurn({ registry, spec: runnerSpec(agent, { env: { FAKE_MODE: "exit-nonzero" } }), task: "x", identity: identityFor(bound) });

    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 5);
    const payload = await readPayload(result.resultPath!);
    assert.equal(payload.status, "failed");
    assert.match(String(payload.error), /exited with code 5/);
  });
});

test("an explicit is_error result is failed even on a zero exit", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const agent = await writeExecutable(dir, "agent.cjs", AGENT_SCRIPT);
    const bound = await makeBoundTurn(registry, dir);

    const result = await runTurn({ registry, spec: runnerSpec(agent, { env: { FAKE_MODE: "fail" } }), task: "x", identity: identityFor(bound) });

    assert.equal(result.status, "failed");
    assert.match(String((await readPayload(result.resultPath!)).error), /boom/);
  });
});

test("malformed structured output is failed and never treated as completion", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const agent = await writeExecutable(dir, "agent.cjs", AGENT_SCRIPT);
    const bound = await makeBoundTurn(registry, dir);

    const result = await runTurn({ registry, spec: runnerSpec(agent, { env: { FAKE_MODE: "malformed" } }), task: "x", identity: identityFor(bound) });

    assert.equal(result.status, "failed");
    assert.match(String((await readPayload(result.resultPath!)).error), /malformed/);
  });
});

test("NDJSON output is parsed from the final structured line", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const agent = await writeExecutable(dir, "agent.cjs", AGENT_SCRIPT);
    const bound = await makeBoundTurn(registry, dir);

    const result = await runTurn({ registry, spec: runnerSpec(agent, { env: { FAKE_MODE: "ndjson" }, output: "ndjson" }), task: "hi", identity: identityFor(bound) });

    assert.equal(result.status, "completed");
    assert.equal(result.agentSessionId, "native-nd");
    assert.equal((await readPayload(result.resultPath!)).summary, "final:hi");
  });
});

test("a truncated structured stream fails closed even when a valid-looking final line survives", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const agent = await writeExecutable(dir, "agent.cjs", AGENT_SCRIPT);
    const bound = await makeBoundTurn(registry, dir);

    const result = await runTurn({
      registry,
      spec: runnerSpec(agent, { env: { FAKE_MODE: "huge-stdout" }, output: "ndjson" }),
      task: "x",
      identity: identityFor(bound),
      maxStdoutBytes: 512,
      maxErrorBytes: 256,
    });

    assert.equal(result.status, "failed", "truncation is never treated as success");
    assert.equal(result.agentSessionId, undefined, "no native id is trusted from an incomplete stream");
    const payload = await readPayload(result.resultPath!);
    assert.equal(payload.status, "failed");
    assert.match(String(payload.error), /truncated/);
    assert.ok(Buffer.byteLength(String(payload.error), "utf8") <= 256, "the error remains bounded");
    assert.ok(!String(payload.error).includes("tail-ok"), "the dropped final line is not surfaced as a result");
  });
});

test("oversized stderr is bounded and never enters the payload", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const agent = await writeExecutable(dir, "agent.cjs", AGENT_SCRIPT);
    const bound = await makeBoundTurn(registry, dir);

    const result = await runTurn({
      registry,
      spec: runnerSpec(agent, { env: { FAKE_MODE: "huge-stderr" } }),
      task: "x",
      identity: identityFor(bound),
      maxStderrBytes: 256,
    });

    assert.equal(result.status, "completed");
    const payload = await readPayload(result.resultPath!);
    assert.equal(payload.summary, "ok");
    assert.ok(!JSON.stringify(payload).includes("EEEEEEEEEE"), "captured stderr is never persisted");
  });
});

test("a missing executable fails the turn durably instead of throwing", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const bound = await makeBoundTurn(registry, dir);

    const result = await runTurn({ registry, spec: runnerSpec(path.join(dir, "nope")), task: "x", identity: identityFor(bound) });

    assert.equal(result.status, "failed");
    assert.match(String((await readPayload(result.resultPath!)).error), /missing or not executable/);
    assert.equal((await registry.getTurn(bound.turn.turnId))!.status, "failed");
  });
});

test("wrong pane, session, owner, or tmux server metadata fails closed without mutating state", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const agent = await writeExecutable(dir, "agent.cjs", AGENT_SCRIPT);
    const bound = await makeBoundTurn(registry, dir);
    const spec = runnerSpec(agent);

    await assert.rejects(runTurn({ registry, spec, task: "x", identity: identityFor(bound, { paneId: "%999" }) }), /bound to pane/);
    await assert.rejects(runTurn({ registry, spec, task: "x", identity: identityFor(bound, { sessionId: "does-not-exist" }) }), /Unknown subagent session/);
    await assert.rejects(runTurn({ registry, spec, task: "x", identity: identityFor(bound, { owner: "someone-else" }) }), /another Pi conversation/);
    await assert.rejects(runTurn({ registry, spec, task: "x", identity: identityFor(bound, { serverPid: "999" }) }), /restarted or reused server/);

    const after = (await registry.getTurn(bound.turn.turnId))!;
    assert.equal(after.status, "starting", "no failed-closed attempt mutated the turn");
    assert.equal(after.resultPath, undefined);
    assert.deepEqual(await payloadFiles(registry.file), []);
  });
});

test("a cancellation that lands first wins and is never overwritten by the runner", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const agent = await writeExecutable(dir, "agent.cjs", AGENT_SCRIPT);
    const bound = await makeBoundTurn(registry, dir);
    await registry.transitionTurn(bound.turn.turnId, "cancelled", { parentPiSessionId: "pi-parent", error: "cancelled by parent" });

    const result = await runTurn({ registry, spec: runnerSpec(agent), task: "x", identity: identityFor(bound) });

    assert.equal(result.status, "cancelled");
    assert.equal(result.passive, true);
    assert.equal(result.resultPath, undefined);
    const stored = (await registry.getTurn(bound.turn.turnId))!;
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.resultPath, undefined);
    assert.deepEqual(await payloadFiles(registry.file), [], "a losing attempt leaves no payload");
  });
});

test("duplicate concurrent runners cannot both launch a child for the same turn", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const agent = await writeExecutable(dir, "agent.cjs", AGENT_SCRIPT);
    const bound = await makeBoundTurn(registry, dir);
    const spawnLog = path.join(dir, "spawns.log");
    const spec = runnerSpec(agent, { env: { FAKE_MODE: "success", FAKE_SPAWN_LOG: spawnLog } });

    const [first, second] = await Promise.all([
      runTurn({ registry, spec, task: "x", identity: identityFor(bound) }),
      runTurn({ registry, spec, task: "x", identity: identityFor(bound) }),
    ]);

    const winners = [first, second].filter((result) => !result.passive);
    const losers = [first, second].filter((result) => result.passive);
    assert.equal(winners.length, 1, "exactly one runner owns the launch");
    assert.equal(winners[0]!.status, "completed");
    assert.equal(losers.length, 1);
    assert.ok(losers[0]!.reason, "the losing runner reports why it did not launch");

    const spawns = (await readFile(spawnLog, "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(spawns.length, 1, "only one child agent process was spawned");

    const stored = (await registry.getTurn(bound.turn.turnId))!;
    assert.equal(stored.status, "completed");
    assert.equal(stored.resultPath, winners[0]!.resultPath);
    assert.deepEqual(await payloadFiles(registry.file), [stored.resultPath], "exactly one immutable payload survives the race");
  });
});

test("claimTurn is an atomic launch-ownership compare-and-set", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const bound = await makeBoundTurn(registry, dir);
    const owner = { parentPiSessionId: "pi-parent" };

    const first = await registry.claimTurn(bound.turn.turnId, "token-a", owner);
    assert.equal(first.claimed, true);
    assert.equal(first.turn.runnerClaim, "token-a");

    const second = await registry.claimTurn(bound.turn.turnId, "token-b", owner);
    assert.equal(second.claimed, false, "a different token cannot claim a claimed turn");
    assert.equal(second.turn.runnerClaim, "token-a");

    const same = await registry.claimTurn(bound.turn.turnId, "token-a", owner);
    assert.equal(same.claimed, true, "the owning token is idempotent");
    assert.equal((await registry.getTurn(bound.turn.turnId))!.runnerClaim, "token-a");

    await assert.rejects(registry.claimTurn(bound.turn.turnId, "token-c", { parentPiSessionId: "someone-else" }), /another Pi conversation/);

    await registry.transitionTurn(bound.turn.turnId, "running", owner);
    await registry.transitionTurn(bound.turn.turnId, "completed", owner);
    const terminal = await registry.claimTurn(bound.turn.turnId, "token-d", owner);
    assert.equal(terminal.claimed, false);
    assert.equal(terminal.turn.status, "completed");
  });
});

test("a logical session runs a second resumed turn after the first completes", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const agent = await writeExecutable(dir, "agent.cjs", AGENT_SCRIPT);
    const bound = await makeBoundTurn(registry, dir);

    const first = await runTurn({ registry, spec: runnerSpec(agent), task: "turn one", identity: identityFor(bound) });
    assert.equal(first.status, "completed");
    assert.equal((await registry.getSession(bound.session.sessionId))!.status, "idle");

    const turn2 = await registry.createTurn(bound.session.sessionId, { parentPiSessionId: "pi-parent" });
    await registry.bindTurn(turn2.turnId, { tmuxPaneId: bound.pane }, { parentPiSessionId: "pi-parent" });
    await registry.transitionTurn(turn2.turnId, "starting", { parentPiSessionId: "pi-parent" });
    const second = await runTurn({
      registry,
      spec: runnerSpec(agent),
      task: "turn two",
      identity: { sessionId: bound.session.sessionId, turnId: turn2.turnId, paneId: bound.pane, owner: "pi-parent", serverPid: "100" },
    });

    assert.equal(second.status, "completed");
    assert.equal(second.agentSessionId, "native-1");
    assert.equal((await registry.getSession(bound.session.sessionId))!.agentSessionId, "native-1", "the native id is resumed, not replaced");
    assert.equal((await registry.getSession(bound.session.sessionId))!.status, "idle");
    assert.deepEqual((await registry.listTurns({ sessionId: bound.session.sessionId })).map((turn) => turn.status), ["completed", "completed"]);
  });
});

test("a stable tmux ID reused by a restarted server is reconciled to lost, never rebound", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const bound = await makeBoundTurn(registry, dir);

    // The recorded server is 100:1; a restarted server reports 200:2 and still
    // presents a live `$N`/`%N` pair. Identity mismatch wins.
    const changed = await registry.reconcile({ live: new Set([bound.tmuxSessionId, bound.pane]), serverIdentity: "200:2" });
    assert.equal(changed.turns.length, 1);
    assert.equal((await registry.getTurn(bound.turn.turnId))!.status, "lost");
    assert.equal((await registry.getSession(bound.session.sessionId))!.status, "lost");

    const agent = await writeExecutable(dir, "agent.cjs", AGENT_SCRIPT);
    const result = await runTurn({ registry, spec: runnerSpec(agent), task: "x", identity: identityFor(bound) });
    assert.equal(result.passive, true, "a lost turn is terminal and is never re-run");
    assert.equal(result.status, "lost");
  });
});

test("the runner spec and invocation are validated before any state is read", () => {
  const base = { version: 1, executable: "/bin/echo", args: [], env: {}, output: "json", prompt: "stdin" };
  assert.deepEqual(validateRunnerSpec(base).executable, "/bin/echo");
  assert.throws(() => validateRunnerSpec({ ...base, executable: "relative/echo" }), TmuxError);
  assert.throws(() => validateRunnerSpec({ ...base, output: "xml" }), TmuxError);
  assert.throws(() => validateRunnerSpec({ ...base, args: ["a\0b"] }), TmuxError);
  assert.throws(() => validateRunnerSpec({ ...base, parse: { sessionId: "a..b" } }), TmuxError);

  assert.throws(
    () => parseRunnerInvocation({
      [RUNNER_ENV.spec]: JSON.stringify(base),
      [RUNNER_ENV.task]: "hi",
      [RUNNER_ENV.state]: "/state/sessions.json",
      [RUNNER_ENV.session]: "s1",
      [RUNNER_ENV.turn]: "t1",
    }),
    /TMUX_PANE/,
  );
  const parsed = parseRunnerInvocation({
    [RUNNER_ENV.spec]: JSON.stringify(base),
    [RUNNER_ENV.task]: "hi",
    [RUNNER_ENV.state]: "/state/sessions.json",
    [RUNNER_ENV.session]: "s1",
    [RUNNER_ENV.turn]: "t1",
    [RUNNER_ENV.owner]: "pi-parent",
    TMUX_PANE: "%7",
    TMUX: "/tmp/tmux,4242,0",
  });
  assert.equal(parsed.identity.paneId, "%7");
  assert.equal(parsed.identity.serverPid, "4242");
  assert.equal(parsed.task, "hi");
});

test("the packaged runner CLI completes a turn and rejects unverifiable metadata without mutating state", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const agent = await writeExecutable(dir, "agent.cjs", AGENT_SCRIPT);
    const bound = await makeBoundTurn(registry, dir);
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      [RUNNER_ENV.spec]: JSON.stringify(runnerSpec(agent)),
      [RUNNER_ENV.task]: "via cli",
      [RUNNER_ENV.state]: registry.file,
      [RUNNER_ENV.session]: bound.session.sessionId,
      [RUNNER_ENV.turn]: bound.turn.turnId,
      [RUNNER_ENV.owner]: "pi-parent",
      TMUX_PANE: bound.pane,
      TMUX: "/tmp/tmux,100,0",
    };

    const good = await runCli(baseEnv);
    assert.equal(good.code, 0, good.stderr);
    assert.equal((await registry.getTurn(bound.turn.turnId))!.status, "completed");

    const badTurn = await makeBoundTurn(registry, dir);
    const badEnv: NodeJS.ProcessEnv = { ...baseEnv, [RUNNER_ENV.turn]: badTurn.turn.turnId, TMUX_PANE: "%999" };
    const bad = await runCli(badEnv);
    assert.equal(bad.code, 1, "a wrong pane fails closed");
    assert.equal((await registry.getTurn(badTurn.turn.turnId))!.status, "starting", "the mismatched turn is untouched");

    const missingPane = await runCli({ ...baseEnv, TMUX_PANE: "" });
    assert.equal(missingPane.code, 2, "invalid metadata is rejected before running");
  });
});

test("a runner killed mid-turn leaves the turn recoverable for reconciliation", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const agent = await writeExecutable(dir, "agent.cjs", AGENT_SCRIPT);
    const bound = await makeBoundTurn(registry, dir);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [RUNNER_ENV.spec]: JSON.stringify(runnerSpec(agent, { env: { FAKE_MODE: "sleep" } })),
      [RUNNER_ENV.task]: "long",
      [RUNNER_ENV.state]: registry.file,
      [RUNNER_ENV.session]: bound.session.sessionId,
      [RUNNER_ENV.turn]: bound.turn.turnId,
      [RUNNER_ENV.owner]: "pi-parent",
      TMUX_PANE: bound.pane,
      TMUX: "/tmp/tmux,100,0",
    };

    const child = spawn(process.execPath, ["--experimental-transform-types", defaultRunnerPath()], { env, stdio: ["ignore", "ignore", "ignore"] });
    await waitFor(async () => (await registry.getTurn(bound.turn.turnId))?.status === "running");
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    assert.equal((await registry.getTurn(bound.turn.turnId))!.status, "running", "a killed runner leaves no terminal write");
    assert.deepEqual(await payloadFiles(registry.file), []);

    await registry.reconcile({ live: new Set([bound.tmuxSessionId]), serverIdentity: "100:1" });
    assert.equal((await registry.getTurn(bound.turn.turnId))!.status, "lost", "a missing pane reconciles the turn to lost");
  });
});

async function runCli(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-transform-types", defaultRunnerPath()], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the runner to start.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
