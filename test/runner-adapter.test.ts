import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentTurnContext } from "../src/agent-adapter.ts";
import { RunnerAdapter } from "../src/runner-adapter.ts";
import { defaultRunnerPath, RUNNER_ENV, type RunnerSpecV1 } from "../src/turn-runner.ts";

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

function spec(executable: string, overrides: Partial<RunnerSpecV1> = {}): RunnerSpecV1 {
  return {
    version: 1,
    executable,
    args: ["--print"],
    env: { AGENT_FLAG: "1" },
    output: "json",
    prompt: "stdin",
    parse: { sessionId: "session_id", text: "result", isError: "is_error" },
    ...overrides,
  };
}

test("the runner adapter resolves its spec and module, then carries the task only as an environment value", async () => {
  await withTempDir(async (dir) => {
    const executable = path.join(dir, "agent");
    await makeExecutable(executable);
    const adapter = new RunnerAdapter({ agent: "claude-code", spec: spec(executable) });

    const preflight = await adapter.preflight({ cwd: dir, task: "x" });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) return;
    assert.equal(preflight.env[RUNNER_ENV.bin], process.execPath);
    assert.equal(preflight.env[RUNNER_ENV.module], defaultRunnerPath());
    const resolved = JSON.parse(preflight.env[RUNNER_ENV.spec]!) as RunnerSpecV1;
    assert.equal(resolved.executable, executable, "the executable is resolved to an absolute path");

    const task = `'; touch /tmp/pwned; echo "$(whoami)" \`id\`\nsecond --line`;
    const launch = await adapter.prepareTurn({ cwd: dir, task }, context());
    assert.equal(launch.env[RUNNER_ENV.task], task, "the literal task travels through the environment");
    assert.equal(launch.env[RUNNER_ENV.session], "session-1");
    assert.equal(launch.env[RUNNER_ENV.turn], "turn-1");
    assert.equal(launch.env[RUNNER_ENV.owner], "pi-parent");
    assert.equal(launch.env[RUNNER_ENV.state], "/state/subagent-sessions.json");
    assert.equal(launch.completion.strategy, "runner");
    assert.ok(!launch.command.includes(task));
    for (const fragment of ["pwned", "whoami", "second", "id"]) assert.ok(!launch.command.includes(fragment), launch.command);
    assert.ok(launch.command.includes(`"$${RUNNER_ENV.bin}"`), launch.command);
    assert.ok(launch.command.includes(`"$${RUNNER_ENV.module}"`), launch.command);
  });
});

test("the runner adapter shell-quotes trusted runner flags but never caller text", async () => {
  await withTempDir(async (dir) => {
    const executable = path.join(dir, "agent");
    await makeExecutable(executable);
    const adapter = new RunnerAdapter({ agent: "opencode", spec: spec(executable), runnerArgs: ["--experimental-transform-types", "a b", "it's"] });
    assert.equal(adapter.runnerCommand(), `exec "$${RUNNER_ENV.bin}" '--experimental-transform-types' 'a b' 'it'\\''s' "$${RUNNER_ENV.module}"`);
  });
});

test("the runner adapter resolves a bare PATH command to an absolute executable", async () => {
  await withTempDir(async (dir) => {
    const executable = path.join(dir, "fake-agent");
    await makeExecutable(executable);
    const savedPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ""}`;
    try {
      const adapter = new RunnerAdapter({ agent: "opencode", spec: spec("fake-agent") });
      const preflight = await adapter.preflight({ cwd: dir, task: "x" });
      assert.equal(preflight.ok, true);
      if (!preflight.ok) return;
      const resolved = JSON.parse(preflight.env[RUNNER_ENV.spec]!) as RunnerSpecV1;
      assert.equal(resolved.executable, executable);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

test("the runner adapter fails closed when the executable, module, or spec is invalid", async () => {
  await withTempDir(async (dir) => {
    const executable = path.join(dir, "agent");
    await makeExecutable(executable);

    const missingExe = new RunnerAdapter({ agent: "claude-code", spec: spec(path.join(dir, "missing")), resolveExecutable: async () => undefined });
    const exeResult = await missingExe.preflight({ cwd: dir, task: "x" });
    assert.equal(exeResult.ok, false);
    if (!exeResult.ok) assert.equal(exeResult.code, "unavailable");

    const missingModule = new RunnerAdapter({ agent: "claude-code", spec: spec(executable), runnerModule: path.join(dir, "missing-runner.ts") });
    const moduleResult = await missingModule.preflight({ cwd: dir, task: "x" });
    assert.equal(moduleResult.ok, false);
    if (!moduleResult.ok) assert.equal(moduleResult.code, "unavailable");

    const invalidSpec = new RunnerAdapter({ agent: "claude-code", spec: spec("relative/agent") });
    const specResult = await invalidSpec.preflight({ cwd: dir, task: "x" });
    assert.equal(specResult.ok, false);
    if (!specResult.ok) assert.equal(specResult.code, "invalid_option");
  });
});

async function makeExecutable(file: string): Promise<void> {
  await writeFile(file, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(file, 0o755);
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-runner-adapter-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
