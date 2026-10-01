import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { completionDirFor } from "../src/subagent-reporter.ts";
import { Registry } from "../src/registry.ts";
import { RunnerAdapter } from "../src/runner-adapter.ts";
import { SessionSubagentLedger } from "../src/subagent-ledgers.ts";
import { SubagentController } from "../src/subagent-controller.ts";
import { SubagentSessionRegistry } from "../src/subagent-sessions.ts";
import { Targets } from "../src/targets.ts";
import { Tmux } from "../src/tmux.ts";

/**
 * End-to-end runner integration (issue #11) over an isolated private tmux
 * server: the generic controller launches a `RunnerAdapter` turn, the packaged
 * runner executes a fake agent, and the durable session/turn registry records a
 * bounded completion with the logical session reusable for a second turn.
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

test("an isolated tmux server runs a generic runner turn and reuses the session", { skip: !available }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-runner-e2e-"));
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

    const controller = new SubagentController({
      tmux,
      registry: new Registry(path.join(directory, "registry.json")),
      targets: new Targets(tmux),
      adapter: new RunnerAdapter({
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
      }),
      ledger: new SessionSubagentLedger(sessions, "claude-code"),
      startupProbe: { attempts: 1, intervalMs: 50 },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });

    const first = await controller.start({ cwd: directory, task: "first turn" }, "pi-parent");
    assert.equal(first.ok, true, JSON.stringify(first));
    if (!first.ok) return;

    const turn1 = await waitForTerminal(sessions, first.runId);
    assert.equal(turn1.status, "completed");
    assert.ok(turn1.resultPath, "a completion payload was recorded");
    const payload1 = JSON.parse(await readFile(turn1.resultPath!, "utf8")) as Record<string, unknown>;
    assert.equal(payload1.status, "completed");
    assert.equal(payload1.agentSessionId, "native-e2e");
    assert.equal(payload1.summary, "ok:first turn");
    assert.equal((await sessions.getSession(first.sessionId))!.status, "idle");

    const second = await controller.runTurn(first.sessionId, { cwd: directory, task: "second turn" }, "pi-parent");
    assert.equal(second.ok, true, JSON.stringify(second));
    if (!second.ok) return;
    const turn2 = await waitForTerminal(sessions, second.runId);
    assert.equal(turn2.status, "completed");
    assert.equal((await sessions.getSession(first.sessionId))!.agentSessionId, "native-e2e");
    assert.deepEqual((await sessions.listTurns({ sessionId: first.sessionId })).map((turn) => turn.status), ["completed", "completed"]);
    assert.ok(turn1.resultPath !== turn2.resultPath, "each attempt keeps its own immutable payload");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForTerminal(registry: SubagentSessionRegistry, turnId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const turn = await registry.getTurn(turnId);
    if (turn && (turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled" || turn.status === "lost")) return turn;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for turn ${turnId}; last status ${turn?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
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
