import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiAdapter, PI_SUBAGENT_ENV, piLaunchCommand } from "../src/pi-adapter.ts";
import { AgentAdapterRegistry } from "../src/agent-adapter.ts";
import { CHILD_REPORTER_ENV } from "../src/subagent-reporter.ts";
import type { AgentTurnContext } from "../src/agent-adapter.ts";

function context(overrides: Partial<AgentTurnContext> = {}): AgentTurnContext {
  return {
    agent: "pi",
    owner: "pi-parent",
    statePath: "/state/subagent-jobs.json",
    runId: "job-1",
    sessionId: "job-1",
    turnIndex: 1,
    ancestors: [],
    preflight: {},
    env: {},
    ...overrides,
  };
}

test("the Pi adapter carries the task only as a quoted environment value, never in the command", async () => {
  const adapter = new PiAdapter({ reporterPath: "/pkg/child-reporter.ts", resolvePi: async () => "/usr/bin/pi" });
  const task = `'; touch /tmp/pwned; echo "$(whoami)" \`id\`\nsecond --line`;
  const spec = await adapter.prepareTurn({ cwd: "/work", task }, context());
  assert.equal(spec.env[PI_SUBAGENT_ENV.task], task, "the literal task is delivered through the environment");
  assert.ok(!spec.command.includes(task));
  for (const fragment of ["pwned", "whoami", "second", "id"]) assert.ok(!spec.command.includes(fragment), spec.command);
  assert.ok(spec.command.includes(`"$${PI_SUBAGENT_ENV.task}"`), "the task is a quoted env expansion");
  assert.equal(spec.completion.strategy, "native-reporter", "Pi keeps structured agent_settled completion");
  assert.equal(piLaunchCommand(false, false), 'exec "$PI_TMUX_PI_BIN" --extension "$PI_TMUX_CHILD_REPORTER" --mode json -p -- "$PI_TMUX_SUBAGENT_TASK"');
});

test("the Pi adapter emits the documented child-reporter environment contract", async () => {
  const adapter = new PiAdapter();
  const spec = await adapter.prepareTurn(
    { cwd: "/work", task: "do work" },
    context({ runId: "job-9", statePath: "/state/jobs.json", owner: "pi-owner", ancestors: ["a", "b"] }),
  );
  assert.equal(spec.env[CHILD_REPORTER_ENV.jobId], "job-9");
  assert.equal(spec.env[CHILD_REPORTER_ENV.state], "/state/jobs.json");
  assert.equal(spec.env[CHILD_REPORTER_ENV.parentSessionId], "pi-owner");
  assert.equal(spec.env[CHILD_REPORTER_ENV.ancestors], "a,b");

  const noLineage = await adapter.prepareTurn({ cwd: "/work", task: "x" }, context());
  assert.equal(noLineage.env[CHILD_REPORTER_ENV.ancestors], undefined, "no empty lineage variable is emitted");
});

test("the Pi adapter adds validated model/thinking selections to the args and environment", async () => {
  const adapter = new PiAdapter();
  const spec = await adapter.prepareTurn({ cwd: "/work", task: "x", model: "openai/gpt-5", thinking: "high" }, context());
  assert.equal(spec.env[PI_SUBAGENT_ENV.model], "openai/gpt-5");
  assert.equal(spec.env[PI_SUBAGENT_ENV.thinking], "high");
  assert.ok(spec.command.includes(`--model "$${PI_SUBAGENT_ENV.model}"`));
  assert.ok(spec.command.includes(`--thinking "$${PI_SUBAGENT_ENV.thinking}"`));
  assert.equal(spec.command, piLaunchCommand(true, true));

  assert.equal(adapter.validateOptions({ cwd: "/work", task: "x", model: "bad model;rm" }), "model must match [A-Za-z0-9._/@:-]+.");
  assert.match(adapter.validateOptions({ cwd: "/work", task: "x", thinking: "galaxy" }) ?? "", /thinking must be one of/);
  assert.equal(adapter.validateOptions({ cwd: "/work", task: "x" }), undefined);
});

test("the Pi adapter preflight resolves the executable and reporter, or fails closed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-adapter-"));
  try {
    const reporterPath = path.join(dir, "child-reporter.ts");
    await writeFile(reporterPath, "// stand-in\n");

    const missingReporter = new PiAdapter({ reporterPath: path.join(dir, "missing.ts"), resolvePi: async () => "/usr/bin/pi" });
    const reporterResult = await missingReporter.preflight({ cwd: dir, task: "x" });
    assert.equal(reporterResult.ok, false);
    if (!reporterResult.ok) assert.equal(reporterResult.code, "unavailable");

    const missingPi = new PiAdapter({ reporterPath, resolvePi: async () => undefined });
    const piResult = await missingPi.preflight({ cwd: dir, task: "x" });
    assert.equal(piResult.ok, false);
    if (!piResult.ok) assert.match(piResult.error, /not found on PATH/);

    const ok = new PiAdapter({ reporterPath, resolvePi: async () => "/usr/bin/pi" });
    const resolved = await ok.preflight({ cwd: dir, task: "x" });
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.env[PI_SUBAGENT_ENV.piBin], "/usr/bin/pi");
      assert.equal(resolved.env[PI_SUBAGENT_ENV.reporter], reporterPath);
    }

    const throws = new PiAdapter({ reporterPath, resolvePi: async () => { throw new Error("boom"); } });
    const thrown = await throws.preflight({ cwd: dir, task: "x" });
    assert.equal(thrown.ok, false);
    if (!thrown.ok) assert.match(thrown.error, /Could not resolve the Pi binary/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the Pi adapter lineage inherits and de-duplicates the child reporter ancestry", () => {
  const adapter = new PiAdapter();
  assert.deepEqual(adapter.lineage({ [CHILD_REPORTER_ENV.ancestors]: "a,b", [CHILD_REPORTER_ENV.jobId]: "self" }), ["a", "b", "self"]);
  assert.deepEqual(adapter.lineage({ [CHILD_REPORTER_ENV.ancestors]: "a,self", [CHILD_REPORTER_ENV.jobId]: "self" }), ["a", "self"]);
  assert.deepEqual(adapter.lineage({}), []);
});

test("the adapter registry dispatches by agent name and rejects an unknown adapter", () => {
  const pi = new PiAdapter();
  const registry = new AgentAdapterRegistry([pi]);
  assert.equal(registry.get("pi"), pi);
  assert.equal(registry.require("pi"), pi);
  assert.equal(registry.get("opencode"), undefined);
  assert.throws(() => registry.require("claude-code"), /No adapter is registered/);
});
