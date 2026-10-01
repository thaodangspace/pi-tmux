import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PiSubagentController, defaultChildReporterPath } from "../src/pi-subagent.ts";
import { Registry } from "../src/registry.ts";
import { SubagentJobRegistry } from "../src/subagent-jobs.ts";
import { Targets } from "../src/targets.ts";
import { Tmux } from "../src/tmux.ts";

const available = await new Promise<boolean>((resolve) => {
  const child = spawn("tmux", ["-V"], { stdio: "ignore" });
  child.on("error", () => resolve(false));
  child.on("close", (code) => resolve(code === 0));
});

/** A fake Pi CLI that records exactly what it received, then stays alive. */
async function writeFakePi(file: string, body: string): Promise<string> {
  await writeFile(file, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(file, 0o755);
  return file;
}

async function waitForFile(file: string, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test("a Pi subagent launches in an isolated tmux server, receives the task verbatim, and is cancelled by stable ID", { skip: !available }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-int-"));
  const socket = path.join(directory, "s");
  const taskFile = path.join(directory, "task.bin");
  const metaFile = path.join(directory, "meta.txt");
  const argvFile = path.join(directory, "argv.txt");
  const marker = path.join(directory, "pwned");
  const tmux = new Tmux({ socket });
  try {
    await runTmux(socket, ["-f", "/dev/null", "new-session", "-d", "-s", "bootstrap"]);
    await runTmux(socket, ["set-option", "-g", "default-shell", "/bin/sh"]);
    await runTmux(socket, ["set-option", "-s", "exit-empty", "off"]);
    await runTmux(socket, ["kill-session", "-t", "bootstrap"]);

    const fakePi = await writeFakePi(path.join(directory, "pi"), [
      `printf '%s' "$PI_TMUX_SUBAGENT_TASK" > '${taskFile}'`,
      `printf 'JOB=%s\\nPARENT=%s\\nSTATE=%s\\nREPORTER=%s\\n' "$PI_TMUX_SUBAGENT_JOB_ID" "$PI_TMUX_PARENT_SESSION_ID" "$PI_TMUX_SUBAGENT_STATE" "$PI_TMUX_CHILD_REPORTER" > '${metaFile}'`,
      `printf '%s' "$*" > '${argvFile}'`,
      "sleep 60",
    ].join("\n"));

    const targets = new Targets(tmux);
    const registry = new Registry(path.join(directory, "registry.json"));
    const jobs = new SubagentJobRegistry(path.join(directory, "jobs.json"));
    const controller = new PiSubagentController({
      tmux, registry, jobs, targets,
      reporterPath: defaultChildReporterPath(),
      resolvePi: async () => fakePi,
      startupProbe: { attempts: 0, intervalMs: 0 },
    });

    // The task contains shell metacharacters; none may be executed.
    const task = `Implement X; touch '${marker}' && echo "$(whoami)" \`id\`\nsecond line`;
    const started = await controller.start({ cwd: directory, task, name: "int" }, "pi-parent");
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    if (!started.ok) return;

    assert.equal(await waitForFile(taskFile), true, "the fake Pi never recorded its task");
    assert.equal(await readFile(taskFile, "utf8"), task, "the task is delivered byte-for-byte");
    assert.equal(existsSync(marker), false, "shell metacharacters in the task are never executed");
    const argv = await readFile(argvFile, "utf8");
    assert.ok(argv.includes(task), "the task arrives as a single option-terminated argument");
    const meta = await readFile(metaFile, "utf8");
    assert.match(meta, new RegExp(`JOB=${started.jobId}`));
    assert.match(meta, /PARENT=pi-parent/);
    assert.match(meta, new RegExp(`STATE=${escapeRegExp(jobs.file)}`));
    assert.match(meta, new RegExp(`REPORTER=${escapeRegExp(defaultChildReporterPath())}`));

    const job = await jobs.get(started.jobId);
    assert.equal(job?.tmuxSessionId, started.tmuxSessionId);
    assert.equal(job?.tmuxPaneId, started.tmuxPaneId);
    const live = await targets.liveTargets();
    assert.equal(live.live.has(started.tmuxPaneId), true);

    const cancelled = await controller.cancel(started.jobId, "pi-parent");
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) return;
    assert.equal(cancelled.targetRemoved, true);
    const after = await targets.liveTargets();
    assert.equal(after.live.has(started.tmuxSessionId), false, "cancel removed exactly the recorded session");
    assert.equal((await jobs.get(started.jobId))?.status, "cancelled");
  } finally {
    try { await tmux.run(["kill-server"]); } catch { /* Server may not have started. */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test("an early-exiting child fails the job and leaves no owned session", { skip: !available }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-int-"));
  const socket = path.join(directory, "s");
  const tmux = new Tmux({ socket });
  try {
    await runTmux(socket, ["-f", "/dev/null", "new-session", "-d", "-s", "bootstrap"]);
    await runTmux(socket, ["set-option", "-g", "default-shell", "/bin/sh"]);
    await runTmux(socket, ["set-option", "-s", "exit-empty", "off"]);
    await runTmux(socket, ["kill-session", "-t", "bootstrap"]);

    const fakePi = await writeFakePi(path.join(directory, "pi"), "exit 7");
    const targets = new Targets(tmux);
    const controller = new PiSubagentController({
      tmux,
      registry: new Registry(path.join(directory, "registry.json")),
      jobs: new SubagentJobRegistry(path.join(directory, "jobs.json")),
      targets,
      reporterPath: defaultChildReporterPath(),
      resolvePi: async () => fakePi,
      startupProbe: { attempts: 4, intervalMs: 100 },
    });

    const started = await controller.start({ cwd: directory, task: "task" }, "pi-parent");
    assert.equal(started.ok, false);
    if (started.ok) return;
    assert.equal(started.status, "failed");
    assert.equal(started.cleanedUp, true);
    const live = await targets.liveTargets();
    assert.equal(live.live.size, 0, "no owned session is leaked after an early exit");
  } finally {
    try { await tmux.run(["kill-server"]); } catch { /* Server may not have started. */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing Pi binary fails without creating a session", { skip: !available }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-int-"));
  const socket = path.join(directory, "s");
  const tmux = new Tmux({ socket });
  try {
    await runTmux(socket, ["-f", "/dev/null", "new-session", "-d", "-s", "bootstrap"]);
    await runTmux(socket, ["set-option", "-s", "exit-empty", "off"]);
    await runTmux(socket, ["kill-session", "-t", "bootstrap"]);

    const targets = new Targets(tmux);
    const controller = new PiSubagentController({
      tmux,
      registry: new Registry(path.join(directory, "registry.json")),
      jobs: new SubagentJobRegistry(path.join(directory, "jobs.json")),
      targets,
      reporterPath: defaultChildReporterPath(),
      resolvePi: async () => undefined,
      startupProbe: { attempts: 0, intervalMs: 0 },
    });
    const started = await controller.start({ cwd: directory, task: "task" }, "pi-parent");
    assert.equal(started.ok, false);
    if (started.ok) return;
    assert.equal(started.code, "unavailable");
    const live = await targets.liveTargets();
    assert.equal(live.live.size, 0, "no tmux session is created");
  } finally {
    try { await tmux.run(["kill-server"]); } catch { /* Server may not have started. */ }
    await rm(directory, { recursive: true, force: true });
  }
});

async function runTmux(socket: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tmux", ["-S", socket, ...args], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`tmux ${args[0]} exited ${code}`)));
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
