import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentAdapterRegistry } from "../src/agent-adapter.ts";
import { OpenCodeAdapter } from "../src/opencode-adapter.ts";
import { PiAdapter } from "../src/pi-adapter.ts";
import { defaultChildReporterPath } from "../src/pi-subagent.ts";
import { Registry } from "../src/registry.ts";
import { RunnerAdapter } from "../src/runner-adapter.ts";
import { SubagentJobRegistry } from "../src/subagent-jobs.ts";
import { SubagentSessionRegistry } from "../src/subagent-sessions.ts";
import { Targets } from "../src/targets.ts";
import { Tmux } from "../src/tmux.ts";
import { registerTmuxTools } from "../src/tools.ts";
import { TurnCompletionDelivery } from "../src/turn-completion-delivery.ts";
import type { SubagentCompletionEvent } from "../src/completion-delivery.ts";

/**
 * End-to-end generic-tools integration (issue #12) over an isolated private tmux
 * server: suspend a fake non-Pi agent behind a config-driven `RunnerAdapter`,
 * drive `tmux_subagent_create/run/status/close` through the real tool surface,
 * and confirm durable structured completion is delivered to the parent with
 * distinct agent/session/turn identity.
 */

const available = await new Promise<boolean>((resolve) => {
  const child = spawn("tmux", ["-V"], { stdio: "ignore" });
  child.on("error", () => resolve(false));
  child.on("close", (code) => resolve(code === 0));
});

const AGENT_SCRIPT = `#!/usr/bin/env node
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ session_id: "native-e2e", result: "ok:" + data, is_error: false }) + "\\n");
});
`;

const OPENCODE_AGENT_SCRIPT = `#!/usr/bin/env node
const args = process.argv.slice(2);
const task = args.length ? args[args.length - 1] : "";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
emit({ type: "step_start", sessionID: "ses_tools_1", part: { type: "step-start" } });
emit({ type: "text", sessionID: "ses_tools_1", part: { type: "text", text: "ok:" + task } });
emit({ type: "step_finish", sessionID: "ses_tools_1", part: { type: "step-finish" } });
`;

test("generic tools drive a fake Claude Code adapter end to end and deliver durable completion", { skip: !available }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "generic-tools-e2e-"));
  const socket = path.join(directory, "s");
  const tmux = new Tmux({ socket });
  const sessions = new SubagentSessionRegistry(path.join(directory, "sessions.json"));
  const agent = path.join(directory, "agent.cjs");
  await writeFile(agent, AGENT_SCRIPT, "utf8");
  await chmod(agent, 0o755);

  try {
    await runTmux(socket, ["-f", "/dev/null", "new-session", "-d", "-s", "bootstrap"]);
    await runTmux(socket, ["set-option", "-g", "default-shell", "/bin/sh"]);
    await runTmux(socket, ["set-option", "-s", "exit-empty", "off"]);
    await runTmux(socket, ["kill-session", "-t", "bootstrap"]);

    const tools: Record<string, any> = {};
    registerTmuxTools(
      { registerTool(tool: any) { tools[tool.name] = tool; } } as unknown as ExtensionAPI,
      tmux,
      new Registry(path.join(directory, "registry.json")),
      {
        targets: new Targets(tmux),
        sessions,
        jobs: new SubagentJobRegistry(path.join(directory, "jobs.json")),
        adapters: new AgentAdapterRegistry([new RunnerAdapter({
          agent: "claude-code",
          spec: {
            version: 1,
            executable: agent,
            args: [],
            env: {},
            output: "json",
            prompt: "stdin",
            parse: { sessionId: "session_id", text: "result", isError: "is_error" },
          },
        })]),
      },
    );

    const owner = "pi-parent";
    const context = { hasUI: false, sessionManager: { getSessionId: () => owner }, ui: {} } as unknown as ExtensionContext;
    const call = (name: string, params: Record<string, unknown>) => tools[name].execute("call", params, undefined, undefined, context);
    const body = (value: any) => JSON.parse(value.content[0].text);

    const created = await call("tmux_subagent_create", { agent: "claude-code", cwd: directory, name: "e2e" });
    assert.equal(created.isError, undefined, created.content[0].text);
    const sessionId = body(created).sessionId as string;
    assert.equal(body(created).status, "idle");

    const running = await call("tmux_subagent_run", { sessionId, task: "first turn" });
    assert.equal(running.isError, undefined, running.content[0].text);
    const firstTurnId = body(running).turnId as string;
    const first = await waitForTerminal(sessions, firstTurnId);
    assert.equal(first.status, "completed");
    assert.equal((await sessions.getSession(sessionId))?.status, "idle");
    assert.equal((await sessions.getSession(sessionId))?.agentSessionId, "native-e2e");
    const payload = JSON.parse(await readFile(first.resultPath!, "utf8")) as Record<string, unknown>;
    assert.equal(payload.sessionId, sessionId);
    assert.equal(payload.turnId, firstTurnId);
    assert.equal(payload.summary, "ok:first turn");

    // A second turn resumes the same logical session.
    const second = await call("tmux_subagent_run", { sessionId, task: "second turn" });
    assert.equal(second.isError, undefined, second.content[0].text);
    const secondTurnId = body(second).turnId as string;
    const secondTurn = await waitForTerminal(sessions, secondTurnId);
    assert.equal(secondTurn.status, "completed");
    assert.notEqual(secondTurnId, firstTurnId);

    // Durable completion delivery emits the shared event family with distinct
    // agent/session/turn identity.
    const events: SubagentCompletionEvent[] = [];
    const delivery = new TurnCompletionDelivery({ ownerPiSessionId: owner, sessions, deliver: (event) => { events.push(event); } });
    await delivery.refresh();
    await delivery.shutdown();
    const deliveredFirst = events.find((event) => event.details.turnId === firstTurnId);
    assert.ok(deliveredFirst, "the first turn completion was delivered");
    assert.equal(deliveredFirst!.details.agent, "claude-code");
    assert.equal(deliveredFirst!.details.sessionId, sessionId);
    assert.equal(deliveredFirst!.details.status, "completed");
    assert.equal(typeof deliveredFirst!.details.completionSeq, "number");

    const status = await call("tmux_subagent_status", { sessionId });
    assert.equal(status.isError, undefined);
    assert.equal(body(status).session.sessionId, sessionId);

    const closed = await call("tmux_subagent_close", { sessionId });
    assert.equal(closed.isError, undefined, closed.content[0].text);
    assert.equal(body(closed).status, "stopped");
    assert.equal(body(closed).targetRemoved, true);
    const live = await targetsLive(tmux);
    assert.equal(live.live.size, 0, "close removed the only owned tmux session");
  } finally {
    try { await tmux.run(["kill-server"]); } catch { /* Server may not have started. */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test("an OpenCode adapter is driven through the generic tools end to end", { skip: !available }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "generic-opencode-e2e-"));
  const socket = path.join(directory, "s");
  const tmux = new Tmux({ socket });
  const sessions = new SubagentSessionRegistry(path.join(directory, "sessions.json"));
  const agent = path.join(directory, "opencode");
  await writeFile(agent, OPENCODE_AGENT_SCRIPT, "utf8");
  await chmod(agent, 0o755);

  try {
    await runTmux(socket, ["-f", "/dev/null", "new-session", "-d", "-s", "bootstrap"]);
    await runTmux(socket, ["set-option", "-g", "default-shell", "/bin/sh"]);
    await runTmux(socket, ["set-option", "-s", "exit-empty", "off"]);
    await runTmux(socket, ["kill-session", "-t", "bootstrap"]);

    const tools: Record<string, any> = {};
    registerTmuxTools(
      { registerTool(tool: any) { tools[tool.name] = tool; } } as unknown as ExtensionAPI,
      tmux,
      new Registry(path.join(directory, "registry.json")),
      {
        targets: new Targets(tmux),
        sessions,
        jobs: new SubagentJobRegistry(path.join(directory, "jobs.json")),
        adapters: new AgentAdapterRegistry([new OpenCodeAdapter({ opencodeCommand: agent })]),
      },
    );

    const owner = "pi-parent";
    const context = { hasUI: false, sessionManager: { getSessionId: () => owner }, ui: {} } as unknown as ExtensionContext;
    const call = (name: string, params: Record<string, unknown>) => tools[name].execute("call", params, undefined, undefined, context);
    const body = (value: any) => JSON.parse(value.content[0].text);

    const created = await call("tmux_subagent_create", { agent: "opencode", cwd: directory, name: "oc-e2e" });
    assert.equal(created.isError, undefined, created.content[0].text);
    const sessionId = body(created).sessionId as string;
    assert.equal(body(created).status, "idle");
    assert.equal(body(created).metadata.opencodeRuntime, "standalone-private-server", "bounded isolation metadata is surfaced");

    const running = await call("tmux_subagent_run", { sessionId, task: "first turn" });
    assert.equal(running.isError, undefined, running.content[0].text);
    const first = await waitForTerminal(sessions, body(running).turnId as string);
    assert.equal(first.status, "completed");
    assert.equal((await sessions.getSession(sessionId))?.agentSessionId, "ses_tools_1");

    const second = await call("tmux_subagent_run", { sessionId, task: "second turn" });
    assert.equal(second.isError, undefined, second.content[0].text);
    const secondTurn = await waitForTerminal(sessions, body(second).turnId as string);
    assert.equal(secondTurn.status, "completed");
    assert.equal((await sessions.getSession(sessionId))?.agentSessionId, "ses_tools_1", "the second turn resumes the same native session");

    const status = await call("tmux_subagent_status", { sessionId });
    assert.equal(status.isError, undefined);
    assert.equal(body(status).session.sessionId, sessionId);

    const closed = await call("tmux_subagent_close", { sessionId });
    assert.equal(closed.isError, undefined, closed.content[0].text);
    assert.equal(body(closed).status, "stopped");
  } finally {
    try { await tmux.run(["kill-server"]); } catch { /* Server may not have started. */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Pi child is driven through the generic tools with the session-mode reporter contract", { skip: !available }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "generic-pi-e2e-"));
  const socket = path.join(directory, "s");
  const tmux = new Tmux({ socket });
  const sessions = new SubagentSessionRegistry(path.join(directory, "sessions.json"));
  const metaFile = path.join(directory, "meta.txt");
  const fakePi = path.join(directory, "pi");
  await writeFile(fakePi, [
    "#!/bin/sh",
    `printf 'MODE=%s\\nSESSION=%s\\nTURN=%s\\nSTATE=%s\\nTASK=%s\\n' "$PI_TMUX_CHILD_REPORTER_MODE" "$PI_TMUX_SUBAGENT_SESSION_ID" "$PI_TMUX_SUBAGENT_JOB_ID" "$PI_TMUX_SUBAGENT_STATE" "$PI_TMUX_SUBAGENT_TASK" > '${metaFile}'`,
    "sleep 60",
  ].join("\n"), "utf8");
  await chmod(fakePi, 0o755);

  try {
    await runTmux(socket, ["-f", "/dev/null", "new-session", "-d", "-s", "bootstrap"]);
    await runTmux(socket, ["set-option", "-g", "default-shell", "/bin/sh"]);
    await runTmux(socket, ["set-option", "-s", "exit-empty", "off"]);
    await runTmux(socket, ["kill-session", "-t", "bootstrap"]);

    const tools: Record<string, any> = {};
    registerTmuxTools(
      { registerTool(tool: any) { tools[tool.name] = tool; } } as unknown as ExtensionAPI,
      tmux,
      new Registry(path.join(directory, "registry.json")),
      {
        targets: new Targets(tmux),
        sessions,
        jobs: new SubagentJobRegistry(path.join(directory, "jobs.json")),
        adapters: new AgentAdapterRegistry([new PiAdapter({ resolvePi: async () => fakePi, reporterPath: defaultChildReporterPath() })]),
        piSubagent: { resolvePi: async () => fakePi, reporterPath: defaultChildReporterPath() },
      },
    );
    const owner = "pi-parent";
    const context = { hasUI: false, sessionManager: { getSessionId: () => owner }, ui: {} } as unknown as ExtensionContext;
    const call = (name: string, params: Record<string, unknown>) => tools[name].execute("call", params, undefined, undefined, context);
    const body = (value: any) => JSON.parse(value.content[0].text);

    const created = await call("tmux_subagent_create", { agent: "pi", cwd: directory });
    assert.equal(created.isError, undefined, created.content[0].text);
    const sessionId = body(created).sessionId as string;

    const running = await call("tmux_subagent_run", { sessionId, task: "pi turn" });
    assert.equal(running.isError, undefined, running.content[0].text);
    const turnId = body(running).turnId as string;

    await waitForFile(metaFile);
    const meta = await readFile(metaFile, "utf8");
    assert.match(meta, /MODE=session/);
    assert.match(meta, new RegExp(`SESSION=${sessionId}`));
    assert.match(meta, new RegExp(`TURN=${turnId}`));
    assert.match(meta, new RegExp(`STATE=${escapeRegExp(sessions.file)}`));
    assert.match(meta, /TASK=pi turn/);
    assert.equal((await sessions.getTurn(turnId))?.status, "starting");

    const cancelled = await call("tmux_subagent_cancel", { sessionId });
    assert.equal(cancelled.isError, undefined, cancelled.content[0].text);
    assert.equal(body(cancelled).status, "cancelled");
    const closed = await call("tmux_subagent_close", { sessionId });
    assert.equal(closed.isError, undefined, closed.content[0].text);
  } finally {
    try { await tmux.run(["kill-server"]); } catch { /* Server may not have started. */ }
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForTerminal(registry: SubagentSessionRegistry, turnId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const turn = await registry.getTurn(turnId);
    if (turn && (turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled" || turn.status === "lost")) return turn;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for turn ${turnId}; last status ${turn?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function targetsLive(tmux: Tmux) {
  return await new Targets(tmux).liveTargets();
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

async function waitForFile(file: string, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await readFile(file, "utf8"); return true; } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
