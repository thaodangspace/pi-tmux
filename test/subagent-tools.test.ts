import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTmuxTools } from "../src/tools.ts";
import { Registry } from "../src/registry.ts";
import { SubagentJobRegistry } from "../src/subagent-jobs.ts";
import { Tmux } from "../src/tmux.ts";

/** A tmux adapter that fails loudly if a tool unexpectedly reaches tmux. */
class InertTmux extends Tmux {
  override async run(args: readonly string[]): Promise<string> {
    throw new Error(`unexpected tmux command: ${args[0]}`);
  }
}

async function harness(options: { resolvePi?: () => Promise<string | undefined> } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-tools-"));
  const tools: Record<string, any> = {};
  const tmux = new InertTmux();
  const registry = new Registry(path.join(dir, "registry.json"));
  const jobs = new SubagentJobRegistry(path.join(dir, "jobs.json"));
  registerTmuxTools(
    { registerTool(tool: any) { tools[tool.name] = tool; } } as unknown as ExtensionAPI,
    tmux,
    registry,
    { jobs, piSubagent: { resolvePi: options.resolvePi ?? (async () => "/fake/bin/pi") } },
  );
  const context = {
    hasUI: false,
    sessionManager: { getSessionId: () => "pi-parent" },
    ui: {},
  } as unknown as ExtensionContext;
  const call = (name: string, params: Record<string, unknown>) => tools[name].execute("call", params, undefined, undefined, context);
  return { dir, tools, jobs, call, close: () => rm(dir, { recursive: true, force: true }) };
}

test("registerTmuxTools registers the Pi subagent tools and preserves the generic tmux tools", async () => {
  const h = await harness();
  try {
    for (const name of ["tmux_subagent_start_pi", "tmux_subagent_status", "tmux_subagent_cancel"]) {
      assert.ok(h.tools[name], `missing ${name}`);
      assert.equal(typeof h.tools[name].execute, "function");
      assert.ok(h.tools[name].parameters, `${name} has no parameter schema`);
    }
    for (const name of ["tmux_list_sessions", "tmux_create_session", "tmux_send_text", "tmux_kill_session"]) {
      assert.ok(h.tools[name], `existing tool ${name} must remain registered`);
    }
  } finally {
    await h.close();
  }
});

test("tmux_subagent_start_pi formats a missing-Pi failure as a structured error carrying the jobId", async () => {
  const h = await harness({ resolvePi: async () => undefined });
  try {
    const value = await h.call("tmux_subagent_start_pi", { cwd: h.dir, task: "do work" });
    assert.equal(value.isError, true);
    assert.equal(value.details.code, "unavailable");
    assert.match(value.details.jobId, /^[0-9a-f-]{36}$/, "the durable failed job ID is reported");
    assert.equal(value.details.status, "failed");
    assert.equal((await h.jobs.get(value.details.jobId))?.status, "failed");
  } finally {
    await h.close();
  }
});

test("tmux_subagent_start_pi rejects invalid input without creating a job", async () => {
  const h = await harness();
  try {
    const value = await h.call("tmux_subagent_start_pi", { cwd: "relative", task: "do work" });
    assert.equal(value.isError, true);
    assert.equal(value.details.jobId, undefined);
    assert.deepEqual(await h.jobs.list(), []);
  } finally {
    await h.close();
  }
});

test("tmux_subagent_status returns durable terminal state without touching tmux", async () => {
  const h = await harness();
  try {
    const job = await h.jobs.create({ cwd: h.dir, parentPiSessionId: "pi-parent" });
    await h.jobs.transition(job.jobId, "cancelled");

    const value = await h.call("tmux_subagent_status", { jobId: job.jobId });
    assert.equal(value.isError, undefined);
    const body = JSON.parse(value.content[0].text);
    assert.equal(body.job.status, "cancelled");
    assert.equal(body.reconciled, false);

    const unknown = await h.call("tmux_subagent_status", { jobId: "22222222-2222-2222-2222-222222222222" });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.details.code, "invalid_target");
    assert.equal(unknown.details.jobId, "22222222-2222-2222-2222-222222222222");
  } finally {
    await h.close();
  }
});

test("tmux_subagent_cancel is idempotent on a terminal job", async () => {
  const h = await harness();
  try {
    const job = await h.jobs.create({ cwd: h.dir, parentPiSessionId: "pi-parent" });
    await h.jobs.transition(job.jobId, "cancelled");

    const value = await h.call("tmux_subagent_cancel", { jobId: job.jobId });
    assert.equal(value.isError, undefined);
    const body = JSON.parse(value.content[0].text);
    assert.equal(body.alreadyTerminal, true);
    assert.equal(body.targetRemoved, false);

    const unknown = await h.call("tmux_subagent_cancel", { jobId: "33333333-3333-3333-3333-333333333333" });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.details.code, "invalid_target");
  } finally {
    await h.close();
  }
});

test("subagent tools refuse jobs owned by another Pi conversation", async () => {
  const h = await harness();
  try {
    const job = await h.jobs.create({ cwd: h.dir, parentPiSessionId: "other-parent" });
    await h.jobs.transition(job.jobId, "cancelled");
    const status = await h.call("tmux_subagent_status", { jobId: job.jobId });
    assert.equal(status.isError, true);
    assert.equal(status.details.code, "invalid_target");
  } finally {
    await h.close();
  }
});
