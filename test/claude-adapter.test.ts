import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentTurnContext } from "../src/agent-adapter.ts";
import { CLAUDE_SUBAGENT_ENV, ClaudeCodeAdapter, claudeAuthMetadata, claudeTurnArgs, validateResumeId } from "../src/claude-adapter.ts";
import { type SubagentSessionV1, type SubagentTurnV1, SubagentSessionRegistry } from "../src/subagent-sessions.ts";
import { RUNNER_ENV, type RunnerSpecV1, runTurn } from "../src/turn-runner.ts";

/**
 * First-class Claude Code adapter tests (issue #13). They use a fake `claude`
 * executable and a real on-disk session/turn registry; no Claude account or
 * installed CLI is required.
 */

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.FAKE_CLAUDE_MODE || "success";
if (process.env.FAKE_CLAUDE_ARGV_LOG) {
  try { fs.appendFileSync(process.env.FAKE_CLAUDE_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n"); } catch {}
}
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  if (mode === "malformed") { process.stdout.write("definitely not json\\n"); return; }
  if (mode === "json-error") { emit({ type: "result", subtype: "error", is_error: true, result: "rate limited", session_id: "claude-native-err" }); return; }
  if (mode === "exit-nonzero") { process.exitCode = 4; emit({ type: "result", subtype: "success", is_error: false, result: "partial", session_id: "claude-native-4" }); return; }
  emit({ type: "result", subtype: "success", is_error: false, result: "done:" + data, session_id: "claude-native-1" });
});
`;

function context(overrides: Partial<AgentTurnContext> = {}): AgentTurnContext {
  return {
    agent: "claude-code",
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-claude-adapter-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("claude-code options are bounded and a thinking option is rejected rather than ignored", async () => {
  await withTempDir(async (dir) => {
    const adapter = new ClaudeCodeAdapter({ claudeCommand: await makeExecutable(dir, "claude") });
    assert.equal(adapter.validateOptions({ cwd: dir, task: "x" }), undefined);
    assert.equal(adapter.validateOptions({ cwd: dir, task: "x", model: "sonnet" }), undefined);
    assert.equal(adapter.validateOptions({ cwd: dir, task: "x", model: "claude-3-5-sonnet-20241022" }), undefined);
    assert.match(adapter.validateOptions({ cwd: dir, task: "x", model: "bad model" })!, /model/);
    assert.match(adapter.validateOptions({ cwd: dir, task: "x", model: "a;rm -rf /" })!, /model/);
    assert.match(adapter.validateOptions({ cwd: dir, task: "x", thinking: "high" })!, /thinking/);
  });
});

test("claude-code preflight resolves the executable and reports API-key billing risk without exposing the key", async () => {
  await withTempDir(async (dir) => {
    const executable = await makeExecutable(dir, "claude");
    const secret = "sk-ant-secret-value-do-not-leak";

    const withKey = new ClaudeCodeAdapter({ claudeCommand: executable, env: { ANTHROPIC_API_KEY: secret } });
    const ok = await withKey.preflight({ cwd: dir, task: "x" });
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    assert.equal(ok.env[CLAUDE_SUBAGENT_ENV.bin], executable);
    assert.equal(ok.env[RUNNER_ENV.bin], process.execPath);
    assert.equal(ok.metadata?.claudeAuthRisk, "api-key-present");
    assert.equal(ok.metadata?.claudeBilling, "api");
    assert.equal(JSON.stringify(ok).includes(secret), false, "the key value is never returned");
    assert.equal(JSON.stringify(ok.metadata).includes("sk-"), false, "no key fragment leaks into metadata");

    const withoutKey = new ClaudeCodeAdapter({ claudeCommand: executable, env: {} });
    const noRisk = await withoutKey.preflight({ cwd: dir, task: "x" });
    assert.equal(noRisk.ok, true);
    if (noRisk.ok) assert.equal(noRisk.metadata?.claudeAuthRisk, "none-detected");

    const missing = new ClaudeCodeAdapter({ claudeCommand: path.join(dir, "missing"), env: {} });
    const failure = await missing.preflight({ cwd: dir, task: "x" });
    assert.equal(failure.ok, false);
    if (!failure.ok) assert.equal(failure.code, "unavailable");
  });
});

test("claude-code builds bounded print-mode argv, resumes exactly, and refuses a continuation without an id", async () => {
  await withTempDir(async (dir) => {
    const adapter = new ClaudeCodeAdapter({ claudeCommand: await makeExecutable(dir, "claude"), env: {} });
    const preflight = await adapter.preflight({ cwd: dir, task: "x" });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) return;

    const first = await adapter.prepareTurn({ cwd: dir, task: "do it" }, context({ preflight: preflight.env }));
    const firstSpec = JSON.parse(first.env[RUNNER_ENV.spec]!) as RunnerSpecV1;
    assert.deepEqual([...firstSpec.args], ["-p", "--output-format", "json"]);
    assert.equal(firstSpec.prompt, "stdin");
    assert.deepEqual(firstSpec.parse, { sessionId: "session_id", text: "result", error: "result", isError: "is_error" });
    assert.equal(first.env[RUNNER_ENV.task], "do it");
    assert.equal(first.completion.strategy, "runner");
    assert.ok(first.command.includes(`"$${RUNNER_ENV.bin}"`));
    assert.ok(first.command.includes(`"$${RUNNER_ENV.module}"`));

    const resumed = await adapter.prepareTurn(
      { cwd: dir, task: "again" },
      context({ preflight: preflight.env, turnIndex: 2, agentSessionId: "native-abc.1" }),
    );
    const resumedSpec = JSON.parse(resumed.env[RUNNER_ENV.spec]!) as RunnerSpecV1;
    assert.deepEqual([...resumedSpec.args], ["-p", "--output-format", "json", "--resume", "native-abc.1"]);

    const modeled = await adapter.prepareTurn(
      { cwd: dir, task: "again", model: "sonnet" },
      context({ preflight: preflight.env, turnIndex: 2, agentSessionId: "native-1" }),
    );
    const modeledSpec = JSON.parse(modeled.env[RUNNER_ENV.spec]!) as RunnerSpecV1;
    assert.deepEqual([...modeledSpec.args], ["-p", "--output-format", "json", "--model", "sonnet", "--resume", "native-1"]);

    await assert.rejects(
      adapter.prepareTurn({ cwd: dir, task: "x" }, context({ preflight: preflight.env, turnIndex: 2 })),
      /no recorded Claude session id/,
    );
    await assert.rejects(
      adapter.prepareTurn({ cwd: dir, task: "x" }, context({ preflight: preflight.env, turnIndex: 2, agentSessionId: "bad id" })),
      /safe, bounded token/,
    );
    await assert.rejects(
      adapter.prepareTurn({ cwd: dir, task: "x", model: "bad model" }, context({ preflight: preflight.env })),
      /model/,
    );

    for (const args of [firstSpec.args, resumedSpec.args, modeledSpec.args]) {
      assert.equal(args.includes("--dangerously-skip-permissions"), false, "permissions are never skipped");
    }
    assert.equal(claudeTurnArgs().includes("--dangerously-skip-permissions"), false);
    assert.equal(validateResumeId("native-1"), undefined);
    assert.match(validateResumeId("native 1")!, /safe, bounded token/);
  });
});

test("claude-code keeps the task verbatim out of the constant command and argv", async () => {
  await withTempDir(async (dir) => {
    const adapter = new ClaudeCodeAdapter({ claudeCommand: await makeExecutable(dir, "claude"), env: {} });
    const preflight = await adapter.preflight({ cwd: dir, task: "x" });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) return;
    const task = `'; touch ${path.join(dir, "pwned")}; echo "$(whoami)" \`id\`\nsecond --line`;
    const launch = await adapter.prepareTurn({ cwd: dir, task }, context({ preflight: preflight.env }));
    assert.equal(launch.env[RUNNER_ENV.task], task);
    const spec = JSON.parse(launch.env[RUNNER_ENV.spec]!) as RunnerSpecV1;
    assert.equal([...spec.args].includes(task), false, "the task is never an argv element");
    for (const fragment of ["pwned", "whoami", "touch", "second"]) {
      assert.equal(launch.command.includes(fragment), false, launch.command);
    }
    assert.equal(JSON.stringify(spec).includes("pwned"), false);
  });
});

test("claudeAuthMetadata reads presence only and never the key value", () => {
  const secret = "sk-ant-super-secret";
  assert.equal(claudeAuthMetadata({ ANTHROPIC_API_KEY: secret }).claudeAuthRisk, "api-key-present");
  assert.equal(claudeAuthMetadata({}).claudeAuthRisk, "none-detected");
  assert.equal(claudeAuthMetadata({ ANTHROPIC_API_KEY: "" }).claudeAuthRisk, "none-detected");
  assert.equal(JSON.stringify(claudeAuthMetadata({ ANTHROPIC_API_KEY: secret })).includes(secret), false);
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
  const created = await registry.createSession({ agent: "claude-code", cwd, parentPiSessionId: owner });
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

test("a fake claude first turn captures the native session id and the next turn resumes exactly that id", async () => {
  await withTempDir(async (dir) => {
    const registry = new SubagentSessionRegistry(path.join(dir, "sessions.json"));
    const log = path.join(dir, "argv.log");
    const executable = await makeExecutable(dir, "claude", FAKE_CLAUDE);
    const adapter = new ClaudeCodeAdapter({ claudeCommand: executable, env: {} });
    const preflight = await adapter.preflight({ cwd: dir, task: "x" });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) return;

    const savedLog = process.env.FAKE_CLAUDE_ARGV_LOG;
    process.env.FAKE_CLAUDE_ARGV_LOG = log;
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
      assert.equal(firstResult.agentSessionId, "claude-native-1");
      const stored = await registry.getSession(session.session.sessionId);
      assert.equal(stored?.agentSessionId, "claude-native-1");
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
      assert.deepEqual(invocations[0], ["-p", "--output-format", "json"], "the first turn does not resume");
      assert.deepEqual(invocations[1], ["-p", "--output-format", "json", "--resume", "claude-native-1"], "the second turn resumes the exact native id");
    } finally {
      if (savedLog === undefined) delete process.env.FAKE_CLAUDE_ARGV_LOG;
      else process.env.FAKE_CLAUDE_ARGV_LOG = savedLog;
    }
  });
});

test("claude-code never infers success from a reported error, non-zero exit, or malformed output", async () => {
  await withTempDir(async (dir) => {
    const executable = await makeExecutable(dir, "claude", FAKE_CLAUDE);
    const adapter = new ClaudeCodeAdapter({ claudeCommand: executable, env: {} });
    const preflight = await adapter.preflight({ cwd: dir, task: "x" });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) return;

    const savedMode = process.env.FAKE_CLAUDE_MODE;
    try {
      for (const mode of ["json-error", "exit-nonzero", "malformed"]) {
        process.env.FAKE_CLAUDE_MODE = mode;
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
    } finally {
      if (savedMode === undefined) delete process.env.FAKE_CLAUDE_MODE;
      else process.env.FAKE_CLAUDE_MODE = savedMode;
    }
  });
});
