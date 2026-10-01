import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CLAUDE_INTERACTIVE_ENV,
  CLAUDE_SUBAGENT_ENV,
  ClaudeCodeAdapter,
  claudeInteractiveCommand,
} from "../src/claude-adapter.ts";
import {
  OPENCODE_INTERACTIVE_ENV,
  OPENCODE_SUBAGENT_ENV,
  OpenCodeAdapter,
  opencodeInteractiveCommand,
} from "../src/opencode-adapter.ts";
import { PiAdapter } from "../src/pi-adapter.ts";
import { RunnerAdapter } from "../src/runner-adapter.ts";
import type { AgentAdapter } from "../src/agent-adapter.ts";
import { SubagentSessionRegistry } from "../src/subagent-sessions.ts";

/**
 * Issue #15: optional interactive TUI mode.
 *
 * These tests use fake `claude` / `opencode` executables and a real on-disk
 * session registry; no agent account or installed CLI is required.
 */

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-interactive-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function makeExecutable(dir: string, name: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(file, 0o755);
  return file;
}

test("claude interactive command is constant, references only quoted env, and never weakens permissions", () => {
  const base = claudeInteractiveCommand(false);
  assert.equal(base, `exec "$${CLAUDE_SUBAGENT_ENV.bin}"`);
  assert.equal(base.includes("-p"), false, "interactive mode is not print mode");
  assert.equal(base.includes("--output-format"), false);

  const modeled = claudeInteractiveCommand(true);
  assert.equal(modeled, `exec "$${CLAUDE_SUBAGENT_ENV.bin}" --model "$${CLAUDE_INTERACTIVE_ENV.model}"`);

  for (const command of [base, modeled]) {
    assert.equal(command.includes("--dangerously-skip-permissions"), false);
    assert.equal(command.includes("--permission-mode"), false);
    assert.equal(command.includes("--allow"), false);
  }
});

test("claude prepareInteractive returns the constant command and a validated model env, and rejects thinking", async () => {
  await withTempDir(async (dir) => {
    const executable = await makeExecutable(dir, "claude");
    const adapter = new ClaudeCodeAdapter({ resolveClaude: async () => executable, env: {} });
    const preflight = await adapter.preflightInteractive({ cwd: dir, task: "" });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) return;
    assert.equal(preflight.env[CLAUDE_SUBAGENT_ENV.bin], executable);

    const launch = await adapter.prepareInteractive(
      { cwd: dir, task: "", model: "sonnet" },
      { agent: "claude-code", owner: "pi", cwd: dir, preflight: preflight.env, env: {} },
    );
    assert.equal(launch.command, `exec "$${CLAUDE_SUBAGENT_ENV.bin}" --model "$${CLAUDE_INTERACTIVE_ENV.model}"`);
    assert.deepEqual(launch.env, { [CLAUDE_INTERACTIVE_ENV.model]: "sonnet" });

    const plain = await adapter.prepareInteractive(
      { cwd: dir, task: "" },
      { agent: "claude-code", owner: "pi", cwd: dir, preflight: preflight.env, env: {} },
    );
    assert.deepEqual(plain.env, {});

    await assert.rejects(
      adapter.prepareInteractive({ cwd: dir, task: "", thinking: "high" }, { agent: "claude-code", owner: "pi", cwd: dir, preflight: preflight.env, env: {} }),
      /thinking/,
    );
    await assert.rejects(
      adapter.prepareInteractive({ cwd: dir, task: "", model: "bad model" }, { agent: "claude-code", owner: "pi", cwd: dir, preflight: preflight.env, env: {} }),
      /model/,
    );
  });
});

test("opencode interactive command always uses --standalone and never attaches to the shared daemon", () => {
  const base = opencodeInteractiveCommand(false);
  assert.equal(base, `exec "$${OPENCODE_SUBAGENT_ENV.bin}" --standalone`);
  assert.equal(base.startsWith(`exec "$${OPENCODE_SUBAGENT_ENV.bin}" --standalone`), true, "--standalone is mandatory and first");

  const modeled = opencodeInteractiveCommand(true);
  assert.equal(modeled, `exec "$${OPENCODE_SUBAGENT_ENV.bin}" --standalone --model "$${OPENCODE_INTERACTIVE_ENV.model}"`);

  for (const command of [base, modeled]) {
    for (const forbidden of ["--auto", "--yolo", "--attach", "--continue", "--dangerously-skip-permissions"]) {
      assert.equal(command.includes(forbidden), false, `interactive opencode must never pass ${forbidden}`);
    }
  }
});

test("opencode prepareInteractive carries a validated model env and rejects thinking", async () => {
  await withTempDir(async (dir) => {
    const executable = await makeExecutable(dir, "opencode");
    const adapter = new OpenCodeAdapter({ resolveOpencode: async () => executable });
    const preflight = await adapter.preflightInteractive({ cwd: dir, task: "" });
    assert.equal(preflight.ok, true);
    if (!preflight.ok) return;
    assert.equal(preflight.env[OPENCODE_SUBAGENT_ENV.bin], executable);
    assert.equal(preflight.metadata?.opencodeRuntime, "standalone-private-server");

    const launch = await adapter.prepareInteractive(
      { cwd: dir, task: "", model: "anthropic/claude-sonnet-4-5" },
      { agent: "opencode", owner: "pi", cwd: dir, preflight: preflight.env, env: {} },
    );
    assert.deepEqual(launch.env, { [OPENCODE_INTERACTIVE_ENV.model]: "anthropic/claude-sonnet-4-5" });

    await assert.rejects(
      adapter.prepareInteractive({ cwd: dir, task: "", thinking: "high" }, { agent: "opencode", owner: "pi", cwd: dir, preflight: preflight.env, env: {} }),
      /thinking/,
    );
  });
});

test("interactive preflight needs no turn runner, unlike the structured-turn preflight", async () => {
  await withTempDir(async (dir) => {
    const executable = await makeExecutable(dir, "claude");
    const missingRunner = path.join(dir, "does-not-exist.ts");
    const adapter = new ClaudeCodeAdapter({ resolveClaude: async () => executable, runnerModule: missingRunner, env: {} });

    const structured = await adapter.preflight({ cwd: dir, task: "" });
    assert.equal(structured.ok, false, "the structured-turn preflight requires the packaged runner");

    const interactive = await adapter.preflightInteractive({ cwd: dir, task: "" });
    assert.equal(interactive.ok, true, interactive.ok ? "" : interactive.error);
  });
});

test("only first-class CLI adapters declare interactive support", () => {
  assert.equal(new ClaudeCodeAdapter().supportsInteractive, true);
  assert.equal(new OpenCodeAdapter().supportsInteractive, true);
  assert.equal((new PiAdapter() as AgentAdapter).supportsInteractive, undefined);
  assert.equal((new RunnerAdapter({ agent: "claude-code", spec: { version: 1, executable: "x", args: [], env: {}, output: "json", prompt: "stdin" } }) as AgentAdapter).supportsInteractive, undefined);
});

async function makeRegistry(dir: string): Promise<SubagentSessionRegistry> {
  return new SubagentSessionRegistry(path.join(dir, "sessions.json"));
}

test("session mode defaults to turns and interactive lifecycle is enforced", async () => {
  await withTempDir(async (dir) => {
    const registry = await makeRegistry(dir);
    const turns = await registry.createSession({ agent: "claude-code", cwd: dir, parentPiSessionId: "pi" });
    assert.equal(turns.mode, "turns");

    const interactive = await registry.createSession({ agent: "claude-code", cwd: dir, parentPiSessionId: "pi", mode: "interactive" });
    assert.equal(interactive.mode, "interactive");
    assert.equal(interactive.status, "starting");
    // An interactive-mode session can never be marked idle, even before launch.
    await assert.rejects(registry.transitionSession(interactive.sessionId, "idle", { parentPiSessionId: "pi" }), /never becomes idle/);

    await registry.bindSession(interactive.sessionId, { tmuxSessionId: "$1", tmuxPaneId: "%1", serverIdentity: "1:1" }, { parentPiSessionId: "pi" });
    const active = await registry.transitionSession(interactive.sessionId, "interactive", { parentPiSessionId: "pi" });
    assert.equal(active.status, "interactive");
    assert.equal(active.tmuxPaneId, "%1");

    // An interactive session never returns to idle and never runs a turn.
    await assert.rejects(registry.transitionSession(interactive.sessionId, "idle", { parentPiSessionId: "pi" }), /Illegal transition/);
    await assert.rejects(registry.createTurn(interactive.sessionId, { parentPiSessionId: "pi" }), /never runs turns/);

    // A turns session cannot be promoted to interactive.
    await registry.bindSession(turns.sessionId, { tmuxSessionId: "$2", serverIdentity: "1:1" }, { parentPiSessionId: "pi" });
    await assert.rejects(registry.transitionSession(turns.sessionId, "interactive", { parentPiSessionId: "pi" }), /cannot become interactive/);
  });
});

test("reconcile marks an interactive session lost when its TUI pane vanishes but keeps it while live", async () => {
  await withTempDir(async (dir) => {
    const registry = await makeRegistry(dir);
    const interactive = await registry.createSession({ agent: "opencode", cwd: dir, parentPiSessionId: "pi", mode: "interactive" });
    await registry.bindSession(interactive.sessionId, { tmuxSessionId: "$1", tmuxPaneId: "%1", serverIdentity: "1:1" }, { parentPiSessionId: "pi" });
    await registry.transitionSession(interactive.sessionId, "interactive", { parentPiSessionId: "pi" });

    const live = await registry.reconcile({ live: new Set(["$1", "%1"]), serverIdentity: "1:1" }, { parentPiSessionId: "pi" });
    assert.equal(live.sessions.length, 0, "a live TUI is not rewritten");
    assert.equal((await registry.getSession(interactive.sessionId))?.status, "interactive");

    const paneGone = await registry.reconcile({ live: new Set(["$1"]), serverIdentity: "1:1" }, { parentPiSessionId: "pi" });
    assert.equal(paneGone.sessions.length, 1);
    assert.equal((await registry.getSession(interactive.sessionId))?.status, "lost", "a vanished TUI pane is lost");
  });
});

test("a live interactive pane cannot be bound to another active session", async () => {
  await withTempDir(async (dir) => {
    const registry = await makeRegistry(dir);
    const first = await registry.createSession({ agent: "opencode", cwd: dir, parentPiSessionId: "pi", mode: "interactive" });
    await registry.bindSession(first.sessionId, { tmuxSessionId: "$1", tmuxPaneId: "%1", serverIdentity: "1:1" }, { parentPiSessionId: "pi" });
    await registry.transitionSession(first.sessionId, "interactive", { parentPiSessionId: "pi" });

    const second = await registry.createSession({ agent: "opencode", cwd: dir, parentPiSessionId: "pi", mode: "interactive" });
    await assert.rejects(
      registry.bindSession(second.sessionId, { tmuxSessionId: "$2", tmuxPaneId: "%1", serverIdentity: "1:1" }, { parentPiSessionId: "pi" }),
      /refusing to reuse a live tmux ID/,
    );
  });
});
