import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentTurnContext } from "../src/agent-adapter.ts";
import {
  DEFAULT_OPENCODE_COMMAND,
  OPENCODE_PARSE,
  OPENCODE_REQUIRED_FLAGS,
  OPENCODE_SUBAGENT_ENV,
  OpenCodeAdapter,
  opencodeIsolationMetadata,
  opencodeTurnArgs,
  validateOpencodeSessionId,
} from "../src/opencode-adapter.ts";
import { Registry } from "../src/registry.ts";
import { SessionSubagentLedger } from "../src/subagent-ledgers.ts";
import { type SubagentSessionV1, type SubagentTurnV1, SubagentSessionRegistry } from "../src/subagent-sessions.ts";
import { SubagentController } from "../src/subagent-controller.ts";
import { Targets } from "../src/targets.ts";
import { Tmux } from "../src/tmux.ts";
import { RUNNER_ENV, type RunnerSpecV1, runTurn } from "../src/turn-runner.ts";

/**
 * First-class OpenCode adapter tests (issue #14). They use a fake `opencode`
 * executable and a real on-disk session/turn registry; no OpenCode account,
 * provider credential, or installed CLI is required.
 */

const FAKE_OPENCODE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FAKE_OPENCODE_ARGV_LOG) {
  try { fs.appendFileSync(process.env.FAKE_OPENCODE_ARGV_LOG, JSON.stringify(args) + "\\n"); } catch {}
}
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const mode = process.env.FAKE_OPENCODE_MODE || "success";
// A task markdown marker is used by the tmux end-to-end test to make the turn
// hang; the environment mode is used by the in-process runner tests.
const task = args.length ? args[args.length - 1] : "";
if (mode === "hang" || task.includes("HANG")) {
  emit({ type: "step_start", sessionID: "ses_native_hang", part: { type: "step-start" } });
  setInterval(() => {}, 1000);
  return;
}
if (mode === "malformed") { process.stdout.write("definitely not json\\n"); return; }
if (mode === "exit-nonzero") { emit({ type: "text", sessionID: "ses_native_4", part: { type: "text", text: "partial" } }); process.exitCode = 4; return; }
if (mode === "json-error") {
  emit({ type: "error", sessionID: "ses_native_err", error: { name: "APIError", data: { message: "rate limited" } } });
  process.exitCode = 1;
  return;
}
emit({ type: "step_start", sessionID: "ses_native_1", part: { type: "step-start" } });
emit({ type: "text", sessionID: "ses_native_1", part: { type: "text", text: "done:" + task } });
emit({ type: "step_finish", sessionID: "ses_native_1", part: { type: "step-finish" } });
`;

function context(overrides: Partial<AgentTurnContext> = {}): AgentTurnContext {
  return {
    agent: "opencode",
    owner: "pi-parent",
    statePath: "/state/subagent-sessions.json",
    runId: "turn-1",
    sessionId: "session-1",
    turnIndex: 1,
    ancestors: [],
    preflight: {},
    env: {},
    ...overrides,
  };
}

async function makeExecutable(dir: string, name: string, source = "#!/bin/sh\nexit 0\n"): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, source, "utf8");
  await chmod(file, 0o755);
  return file;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-opencode-adapter-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("opencode options are bounded and a thinking option is rejected rather than ignored", async () => {
  await withTempDir(async (dir) => {
    const adapter = new OpenCodeAdapter({ opencodeCommand: await makeExecutable(dir, "opencode") });
    assert.equal(adapter.validateOptions({ cwd: dir, task: "x" }), undefined);
    assert.equal(adapter.validateOptions({ cwd: dir, task: "x", model: "anthropic/claude-sonnet-4-5" }), undefined);
    assert.equal(adapter.validateOptions({ cwd: dir, task: "x", model: "opencode/big-pickle" }), undefined);
    assert.match(adapter.validateOptions({ cwd: dir, task: "x", model: "bad model" })!, /model/);
    assert.match(adapter.validateOptions({ cwd: dir, task: "x", model: "a;rm -rf /" })!, /model/);
    assert.match(adapter.validateOptions({ cwd: dir, task: "x", thinking: "high" })!, /thinking/);
  });
});

test("opencode preflight resolves the executable and returns bounded isolation metadata without any credential", async () => {
  await withTempDir(async (dir) => {
    const executable = await makeExecutable(dir, "opencode");
    const adapter = new OpenCodeAdapter({ opencodeCommand: executable });
    const ok = await adapter.preflight({ cwd: dir, task: "x" });
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    assert.equal(ok.env[OPENCODE_SUBAGENT_ENV.bin], executable);
    assert.equal(ok.env[RUNNER_ENV.bin], process.execPath);
    assert.equal(ok.metadata?.opencodeRuntime, "standalone-private-server");
    assert.match(ok.metadata?.opencodeIsolationNote ?? "", /--standalone/);
    assert.equal(Object.keys(ok.metadata ?? {}).length, 2, "metadata stays bounded");

    const missingPath = new OpenCodeAdapter({ opencodeCommand: path.join(dir, "missing") });
    const missing = await missingPath.preflight({ cwd: dir, task: "x" });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, "unavailable");
  });
});

test("opencode always passes --standalone, never --auto, and resumes exactly the recorded session id", async () => {
  await withTempDir(async (dir) => {
    const adapter = new OpenCodeAdapter({ opencodeCommand: await makeExecutable(dir, "opencode") });
    const preflight = await adapter.preflight({ cwd: dir, task: "x" });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) return;

    const first = await adapter.prepareTurn({ cwd: dir, task: "do it" }, context({ preflight: preflight.env }));
    const firstSpec = JSON.parse(first.env[RUNNER_ENV.spec]!) as RunnerSpecV1;
    assert.deepEqual([...firstSpec.args], ["run", "--standalone", "--format", "json"]);
    assert.equal(firstSpec.output, "ndjson");
    assert.equal(firstSpec.prompt, "argv");
    assert.deepEqual(firstSpec.parse, { sessionId: "sessionID", text: "part.text", error: "error.data.message" });
    assert.deepEqual(firstSpec.parse, OPENCODE_PARSE);
    assert.equal(first.env[RUNNER_ENV.task], "do it");
    assert.equal(first.completion.strategy, "runner");
    assert.ok(first.command.includes(`"$${RUNNER_ENV.bin}"`));
    assert.ok(first.command.includes(`"$${RUNNER_ENV.module}"`));

    const resumed = await adapter.prepareTurn(
      { cwd: dir, task: "again" },
      context({ preflight: preflight.env, turnIndex: 2, agentSessionId: "ses_abc.1" }),
    );
    const resumedSpec = JSON.parse(resumed.env[RUNNER_ENV.spec]!) as RunnerSpecV1;
    assert.deepEqual([...resumedSpec.args], ["run", "--standalone", "--session", "ses_abc.1", "--format", "json"]);

    const modeled = await adapter.prepareTurn(
      { cwd: dir, task: "again", model: "anthropic/claude-sonnet-4-5" },
      context({ preflight: preflight.env, turnIndex: 2, agentSessionId: "ses_abc.1" }),
    );
    const modeledSpec = JSON.parse(modeled.env[RUNNER_ENV.spec]!) as RunnerSpecV1;
    assert.deepEqual(
      [...modeledSpec.args],
      ["run", "--standalone", "--model", "anthropic/claude-sonnet-4-5", "--session", "ses_abc.1", "--format", "json"],
    );

    await assert.rejects(
      adapter.prepareTurn({ cwd: dir, task: "x" }, context({ preflight: preflight.env, turnIndex: 2 })),
      /no recorded OpenCode session id/,
    );
    await assert.rejects(
      adapter.prepareTurn({ cwd: dir, task: "x" }, context({ preflight: preflight.env, turnIndex: 2, agentSessionId: "bad id" })),
      /safe, bounded token/,
    );
    await assert.rejects(
      adapter.prepareTurn({ cwd: dir, task: "x", model: "bad model" }, context({ preflight: preflight.env })),
      /model/,
    );

    for (const spec of [firstSpec, resumedSpec, modeledSpec]) {
      const args = [...spec.args];
      assert.ok(args.includes("--standalone"), "--standalone is mandatory");
      assert.equal(args.includes("--auto"), false, "--auto is never passed");
      assert.equal(args.includes("--continue"), false, "--continue is never used when an id is known");
      assert.equal(args.includes("--dangerously-skip-permissions"), false, "permissions are never skipped");
      assert.equal(args.includes("--attach"), false, "a managed turn never attaches to an external server");
    }
    assert.deepEqual([...OPENCODE_REQUIRED_FLAGS], ["--standalone", "--format", "json"]);
    assert.equal(opencodeTurnArgs().includes("--auto"), false);
    assert.equal(DEFAULT_OPENCODE_COMMAND, "opencode");
  });
});

test("opencode keeps the task verbatim out of the constant command and argv while the runner passes it as one argv element", async () => {
  await withTempDir(async (dir) => {
    const adapter = new OpenCodeAdapter({ opencodeCommand: await makeExecutable(dir, "opencode") });
    const preflight = await adapter.preflight({ cwd: dir, task: "x" });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) return;
    const task = `'; touch ${path.join(dir, "pwned")}; echo "$(whoami)" \`id\`\nsecond --line`;
    const launch = await adapter.prepareTurn({ cwd: dir, task }, context({ preflight: preflight.env }));
    assert.equal(launch.env[RUNNER_ENV.task], task);
    const spec = JSON.parse(launch.env[RUNNER_ENV.spec]!) as RunnerSpecV1;
    assert.equal([...spec.args].includes(task), false, "the task is never baked into the adapter spec args");
    for (const fragment of ["pwned", "whoami", "touch", "second"]) {
      assert.equal(launch.command.includes(fragment), false, launch.command);
    }
    assert.equal(JSON.stringify(spec).includes("pwned"), false);
  });
});

test("opencode isolation metadata and session-id validation are bounded and non-secret", () => {
  const metadata = opencodeIsolationMetadata();
  assert.equal(metadata.opencodeRuntime, "standalone-private-server");
  assert.equal(JSON.stringify(metadata).length < 1024, true);
  assert.equal(validateOpencodeSessionId("ses_abc.1"), undefined);
  assert.match(validateOpencodeSessionId("ses abc")!, /safe, bounded token/);
  assert.match(validateOpencodeSessionId("")!, /safe, bounded token/);
  assert.match(validateOpencodeSessionId("x".repeat(600))!, /safe, bounded token/);
});

interface BoundSession {
  session: SubagentSessionV1;
  tmuxSessionId: string;
}

interface BoundTurn {
  session: SubagentSessionV1;
  turn: SubagentTurnV1;
  tmuxSessionId: string;
  pane: string;
}

let counter = 0;

async function bindSession(registry: SubagentSessionRegistry, cwd: string, owner = "pi-parent"): Promise<BoundSession> {
  const tmuxSessionId = `$${++counter}`;
  const created = await registry.createSession({ agent: "opencode", cwd, parentPiSessionId: owner });
  await registry.bindSession(created.sessionId, { tmuxSessionId, serverIdentity: "100:1" }, { parentPiSessionId: owner });
  return { session: (await registry.getSession(created.sessionId))!, tmuxSessionId };
}

async function bindTurn(registry: SubagentSessionRegistry, sessionId: string, owner = "pi-parent"): Promise<{ turn: SubagentTurnV1; pane: string }> {
  const pane = `%${++counter}`;
  const created = await registry.createTurn(sessionId, { parentPiSessionId: owner });
  await registry.bindTurn(created.turnId, { tmuxPaneId: pane }, { parentPiSessionId: owner });
  await registry.transitionTurn(created.turnId, "starting", { parentPiSessionId: owner });
  return { turn: (await registry.getTurn(created.turnId))!, pane };
}

function identityFor(session: BoundSession, turn: { turn: SubagentTurnV1; pane: string }) {
  return { sessionId: session.session.sessionId, turnId: turn.turn.turnId, paneId: turn.pane, owner: "pi-parent", serverPid: "100" };
}

test("a fake opencode first turn captures the native sessionID and the next turn resumes exactly that id", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const log = path.join(dir, "argv.log");
    const executable = await makeExecutable(dir, "opencode", FAKE_OPENCODE);
    const adapter = new OpenCodeAdapter({ opencodeCommand: executable });
    const preflight = await adapter.preflight({ cwd: dir, task: "x" });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) return;

    const savedLog = process.env.FAKE_OPENCODE_ARGV_LOG;
    process.env.FAKE_OPENCODE_ARGV_LOG = log;
    try {
      const session = await bindSession(registry, dir);
      const firstTurn = await bindTurn(registry, session.session.sessionId);
      const firstLaunch = await adapter.prepareTurn(
        { cwd: dir, task: "first" },
        context({ preflight: preflight.env, runId: firstTurn.turn.turnId, sessionId: session.session.sessionId, turnIndex: 1 }),
      );
      const firstSpec = JSON.parse(firstLaunch.env[RUNNER_ENV.spec]!) as RunnerSpecV1;
      const firstResult = await runTurn({ registry, spec: firstSpec, task: "first", identity: identityFor(session, firstTurn) });
      assert.equal(firstResult.status, "completed");
      assert.equal(firstResult.agentSessionId, "ses_native_1");
      const stored = await registry.getSession(session.session.sessionId);
      assert.equal(stored?.agentSessionId, "ses_native_1");
      assert.equal(stored?.status, "idle", "the logical session survives and is reusable");

      const secondTurn = await bindTurn(registry, session.session.sessionId);
      const secondLaunch = await adapter.prepareTurn(
        { cwd: dir, task: "second" },
        context({
          preflight: preflight.env,
          runId: secondTurn.turn.turnId,
          sessionId: session.session.sessionId,
          turnIndex: 2,
          agentSessionId: stored!.agentSessionId,
        }),
      );
      const secondSpec = JSON.parse(secondLaunch.env[RUNNER_ENV.spec]!) as RunnerSpecV1;
      const secondResult = await runTurn({ registry, spec: secondSpec, task: "second", identity: identityFor(session, secondTurn) });
      assert.equal(secondResult.status, "completed");

      const invocations = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
      assert.deepEqual(invocations[0], ["run", "--standalone", "--format", "json", "first"], "the first turn does not resume");
      assert.deepEqual(
        invocations[1],
        ["run", "--standalone", "--session", "ses_native_1", "--format", "json", "second"],
        "the second turn resumes the exact native id and keeps --standalone",
      );
      for (const args of invocations) {
        assert.ok(args.includes("--standalone"));
        assert.equal(args.includes("--auto"), false);
        assert.equal(args.includes("--continue"), false);
      }
    } finally {
      if (savedLog === undefined) delete process.env.FAKE_OPENCODE_ARGV_LOG;
      else process.env.FAKE_OPENCODE_ARGV_LOG = savedLog;
    }
  });
});

test("opencode never infers success from a reported error, non-zero exit, malformed or truncated output", async () => {
  await withTempDir(async (dir) => {
    const executable = await makeExecutable(dir, "opencode", FAKE_OPENCODE);
    const adapter = new OpenCodeAdapter({ opencodeCommand: executable });
    const preflight = await adapter.preflight({ cwd: dir, task: "x" });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) return;

    const savedMode = process.env.FAKE_OPENCODE_MODE;
    try {
      for (const mode of ["json-error", "exit-nonzero", "malformed"]) {
        process.env.FAKE_OPENCODE_MODE = mode;
        const registry = new SubagentSessionRegistry(path.join(dir, `${mode}.json`));
        const session = await bindSession(registry, dir);
        const turn = await bindTurn(registry, session.session.sessionId);
        const launch = await adapter.prepareTurn(
          { cwd: dir, task: "x" },
          context({ preflight: preflight.env, runId: turn.turn.turnId, sessionId: session.session.sessionId }),
        );
        const spec = JSON.parse(launch.env[RUNNER_ENV.spec]!) as RunnerSpecV1;
        const result = await runTurn({ registry, spec, task: "x", identity: identityFor(session, turn) });
        assert.equal(result.status, "failed", `mode ${mode} must not be recorded as completed`);
        assert.ok(result.error, `mode ${mode} records a bounded error`);
        assert.equal((await registry.getSession(session.session.sessionId))?.status, "idle");
      }

      // A stream whose tail buffer dropped earlier events is never trusted.
      delete process.env.FAKE_OPENCODE_MODE;
      const registry = new SubagentSessionRegistry(path.join(dir, "truncated.json"));
      const session = await bindSession(registry, dir);
      const turn = await bindTurn(registry, session.session.sessionId);
      const launch = await adapter.prepareTurn(
        { cwd: dir, task: "x" },
        context({ preflight: preflight.env, runId: turn.turn.turnId, sessionId: session.session.sessionId }),
      );
      const spec = JSON.parse(launch.env[RUNNER_ENV.spec]!) as RunnerSpecV1;
      const result = await runTurn({ registry, spec, task: "x", identity: identityFor(session, turn), maxStdoutBytes: 8 });
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /truncated|incomplete/);
    } finally {
      if (savedMode === undefined) delete process.env.FAKE_OPENCODE_MODE;
      else process.env.FAKE_OPENCODE_MODE = savedMode;
    }
  });
});

// --- isolated tmux end-to-end: cancellation and lost-target ownership --------

const tmuxAvailable = await new Promise<boolean>((resolve) => {
  const child = spawn("tmux", ["-V"], { stdio: "ignore" });
  child.on("error", () => resolve(false));
  child.on("close", (code) => resolve(code === 0));
});

test("opencode runs in an owned tmux server, resumes, and reconciles cancellation and a lost target", { skip: !tmuxAvailable }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-opencode-e2e-"));
  const socket = path.join(directory, "s");
  const tmux = new Tmux({ socket });
  const sessions = new SubagentSessionRegistry(path.join(directory, "sessions.json"));
  const agent = path.join(directory, "opencode.cjs");
  const log = path.join(directory, "argv.log");
  await writeFile(agent, FAKE_OPENCODE, "utf8");
  await chmod(agent, 0o755);

  const savedLog = process.env.FAKE_OPENCODE_ARGV_LOG;
  process.env.FAKE_OPENCODE_ARGV_LOG = log;
  try {
    // The isolated server inherits this process's environment, so the fake
    // executable sees the log path without pi-tmux ever setting it.
    await runTmux(socket, ["-f", "/dev/null", "new-session", "-d", "-s", "bootstrap"]);
    await runTmux(socket, ["set-option", "-g", "default-shell", "/bin/sh"]);
    await runTmux(socket, ["set-option", "-s", "exit-empty", "off"]);
    await runTmux(socket, ["kill-session", "-t", "bootstrap"]);

    const controller = new SubagentController({
      tmux,
      registry: new Registry(path.join(directory, "registry.json")),
      targets: new Targets(tmux),
      adapter: new OpenCodeAdapter({ opencodeCommand: agent }),
      ledger: new SessionSubagentLedger(sessions, "opencode"),
      startupProbe: { attempts: 1, intervalMs: 50 },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });

    const first = await controller.start({ cwd: directory, task: "first turn" }, "pi-parent");
    assert.equal(first.ok, true, JSON.stringify(first));
    if (!first.ok) return;
    const turn1 = await waitForTerminal(sessions, first.runId);
    assert.equal(turn1.status, "completed");
    assert.equal((await sessions.getSession(first.sessionId))!.agentSessionId, "ses_native_1");

    const second = await controller.runTurn(first.sessionId, { cwd: directory, task: "second turn" }, "pi-parent");
    assert.equal(second.ok, true, JSON.stringify(second));
    if (!second.ok) return;
    const turn2 = await waitForTerminal(sessions, second.runId);
    assert.equal(turn2.status, "completed");

    const invocations = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(invocations[0], ["run", "--standalone", "--format", "json", "first turn"]);
    assert.deepEqual(
      invocations[1],
      ["run", "--standalone", "--session", "ses_native_1", "--format", "json", "second turn"],
    );

    // Cancelling a hanging turn tears down its verified pane and leaves the
    // logical session reusable.
    const hanging = await controller.runTurn(first.sessionId, { cwd: directory, task: "HANG" }, "pi-parent");
    assert.equal(hanging.ok, true, JSON.stringify(hanging));
    if (!hanging.ok) return;
    await waitForActive(sessions, hanging.runId);
    const cancelled = await controller.cancelTurn(first.sessionId, "pi-parent");
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    if (!cancelled.ok) return;
    assert.equal(cancelled.targetRemoved, true, "the verified hanging pane was removed");
    assert.equal((await sessions.getTurn(hanging.runId))!.status, "cancelled");
    assert.equal((await sessions.getSession(first.sessionId))!.status, "idle", "the session stays reusable");

    // Losing the whole owned tmux session mid-turn reconciles the turn to lost.
    const doomed = await controller.runTurn(first.sessionId, { cwd: directory, task: "HANG" }, "pi-parent");
    assert.equal(doomed.ok, true, JSON.stringify(doomed));
    if (!doomed.ok) return;
    await waitForActive(sessions, doomed.runId);
    const session = await sessions.getSession(first.sessionId);
    await runTmux(socket, ["kill-session", "-t", session!.tmuxSessionId!]);
    const reconciled = await controller.statusSession(first.sessionId, "pi-parent");
    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
    if (!reconciled.ok) return;
    assert.equal(reconciled.reconciled, true);
    assert.equal(reconciled.session.status, "lost");
    assert.equal((await sessions.getTurn(doomed.runId))!.status, "lost");
  } finally {
    if (savedLog === undefined) delete process.env.FAKE_OPENCODE_ARGV_LOG;
    else process.env.FAKE_OPENCODE_ARGV_LOG = savedLog;
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForTerminal(registry: SubagentSessionRegistry, turnId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const turn = await registry.getTurn(turnId);
    if (turn && ["completed", "failed", "cancelled", "lost"].includes(turn.status)) return turn;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for turn ${turnId}; last status ${turn?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForActive(registry: SubagentSessionRegistry, turnId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const turn = await registry.getTurn(turnId);
    if (turn && turn.status === "running") return turn;
    if (turn && ["completed", "failed", "cancelled", "lost"].includes(turn.status)) {
      throw new Error(`Turn ${turnId} settled as ${turn.status} before it could be cancelled`);
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for turn ${turnId} to run; last status ${turn?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function runTmux(socket: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("tmux", ["-S", socket, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `tmux exited ${code}`)));
  });
}
