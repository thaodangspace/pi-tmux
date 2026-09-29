import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Registry, type RegistryEntry } from "../src/registry.ts";
import { Tmux } from "../src/tmux.ts";
import { formatCreated, registerTmuxUi } from "../src/ui.ts";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");
const created = (overrides: Partial<RegistryEntry>): RegistryEntry => ({
  kind: "session", id: "$3", sessionId: "$3", parentSessionId: null, name: "pi-test",
  piSessionId: "pi-current", tool: "tmux_create_session", createdAt: "2026-03-01T11:58:00.000Z", serverIdentity: "123:456", ...overrides,
});

class FakeTmux extends Tmux {
  commands: string[][] = [];
  sessions = "$3\tpi-test\t0\t1\n";
  windows = "$3\tpi-test\t@4\t0\textra\t1\t1\n";
  panes = "$3\tpi-test\t@4\t0\textra\t%1\t0\t1\t/tmp\t80\t24\n";
  clients = "";
  capture = "prompt$ \n";
  override async run(args: readonly string[]): Promise<string> {
    this.commands.push([...args]);
    if (args[0] === "display-message") return "123:456\n";
    if (args[0] === "list-sessions") return this.sessions;
    if (args[0] === "list-windows") return this.windows;
    if (args[0] === "list-panes") return args.includes("#{session_id}\t#{window_id}\t#{pane_id}\t#{window_linked}\t#{session_grouped}")
      ? "$3\t@4\t%1\t0\t0\n" : this.panes;
    if (args[0] === "list-clients") return this.clients;
    if (args[0] === "capture-pane") return this.capture;
    return "";
  }
}

interface Harness {
  pi: ExtensionAPI;
  handlers: Map<string, (event: any, ctx: any) => any>;
  command: (args: string, ctx: any) => Promise<void>;
  tmux: FakeTmux;
  registry: Registry;
  widgets: unknown[];
  notices: string[];
}

async function harness(run: (h: Harness) => Promise<void>, directory: string): Promise<void> {
  const tmux = new FakeTmux();
  const registry = new Registry(path.join(directory, "registry.json"));
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const widgets: unknown[] = [];
  const notices: string[] = [];
  let command: Harness["command"] = async () => {};
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => any) { handlers.set(event, handler); return () => {}; },
    registerCommand(name: string, options: { handler: Harness["command"] }) { if (name === "tmux") command = options.handler; },
  } as unknown as ExtensionAPI;

  registerTmuxUi(pi, { tmux, registry });
  await run({ pi, handlers, command, tmux, registry, widgets, notices });
}

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-tmux-ui-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("formatCreated names targets readably, orders live ones first, and summarises what is gone", () => {
  const entries = [
    created({ id: "$9", name: "gone", createdAt: "2026-03-01T11:00:00.000Z" }),
    created({ kind: "pane", id: "%1", sessionId: "$3", windowId: "@4", name: "%1" }),
    created({ parentSessionId: "$0" }),
  ];
  const live = { live: new Set(["$3", "%1"]), labels: new Map([["$3", "pi-test"], ["%1", "pi-test:extra.0"]]), serverIdentity: "123:456" };
  const lines = formatCreated(entries, live, 2, NOW);
  assert.equal(lines[0], "pi-tmux · 3 created · 1 gone · +1 more (/tmux)");
  assert.equal(lines[1], "● pi-test  session  2m  ← $0");
  assert.equal(lines[2], "● pi-test:extra.0  pane  2m");

  // A dead target keeps the name it was created with, falls back to its parent's path, and never leaks a bare ID.
  const goneOnly = { live: new Set<string>(), labels: new Map<string, string>() };
  assert.deepEqual(formatCreated([created({ id: "$9", name: "$9" })], goneOnly, 8, NOW), ["pi-tmux · 1 created · 1 gone", "✗ untitled ($9)  session  2m"]);
  const parentOnly = { live: new Set(["$3"]), labels: new Map([["$3", "pi-test"]]), serverIdentity: "123:456" };
  assert.deepEqual(formatCreated([created({ kind: "pane", id: "%1", windowId: "@4", name: "%1" })], parentOnly, 8, NOW), ["pi-tmux · 1 created · 1 gone", "✗ pi-test (%1)  pane  2m"]);
  assert.deepEqual(formatCreated([], goneOnly), []);
  assert.equal(formatCreated(entries, live, 9, NOW)[0], "pi-tmux · 3 created · 1 gone");
});

test("the widget tracks the registry and can be hidden", async () => {
  await withDirectory(async (directory) => {
    await harness(async ({ handlers, registry, widgets }) => {
      await registry.record(created({}));
      await registry.record(created({ id: "$8", sessionId: "$8", piSessionId: "pi-other", name: "other" }));
      await registry.record(created({ id: "$9", sessionId: "$9", piSessionId: undefined, name: "legacy" }));
      await handlers.get("session_start")!({}, widgetContext(widgets, "tui"));
      assert.equal((widgets.at(-1) as string[])[0], "pi-tmux · 1 created");
      assert.match((widgets.at(-1) as string[])[1]!, /^● pi-test  session  \d+[smhd]$/);

      await handlers.get("session_shutdown")!({}, widgetContext(widgets, "tui"));
      assert.equal(widgets.at(-1), undefined, "shutdown clears the widget");
    }, directory);
  });
});

test("the widget is skipped outside interactive mode and hidden when the registry is empty", async () => {
  await withDirectory(async (directory) => {
    await harness(async ({ handlers, widgets }) => {
      await handlers.get("session_start")!({}, widgetContext(widgets, "print"));
      assert.equal(widgets.length, 0, "no widget in print mode");

      const broken = widgetContext(widgets, "tui");
      await handlers.get("turn_end")!({}, broken);
      assert.equal(widgets.at(-1), undefined, "an empty registry hides the widget");
    }, directory);
  });
});

test("/tmux list falls back to a plain notification without UI and hides the widget on off", async () => {
  await withDirectory(async (directory) => {
    await harness(async ({ command, registry, notices, widgets, tmux }) => {
      await registry.record(created({}));
      await command("list", plainContext(notices));
      assert.equal(notices.length, 1);
      assert.match(notices[0]!, /pi-tmux · 1 created/);
      assert.match(notices[0]!, /● pi-test  session/);
      assert.ok(tmux.commands.some((args) => args[0] === "list-sessions"));

      await command("off", plainContext(notices));
      assert.match(notices.at(-1)!, /widget hidden/);
      await command("nonsense", plainContext(notices));
      assert.match(notices.at(-1)!, /unknown argument/);
      assert.equal(widgets.length, 0, "non-interactive contexts never touch the widget");
    }, directory);
  });
});

test("the picker kills a session owned by this Pi session without confirmation and forgets its children", async () => {
  await withDirectory(async (directory) => {
    await harness(async ({ command, registry, tmux, notices }) => {
      await registry.record(created({}));
      await registry.record(created({ kind: "window", id: "@4", sessionId: "$3", windowId: "@4", name: "extra" }));
      const ctx = interactiveContext({ selections: [0, 3], confirmations: [true] }, notices); // first entry, then "Kill"
      await command("list", ctx);

      assert.ok(tmux.commands.some((args) => args[0] === "kill-session" && args[2] === "$3"), "kill-session must be the mutation that runs");
      assert.deepEqual(await registry.list(), []);
      assert.match(notices.find((message) => message.includes("killed"))!, /killed session pi-test; removed 2 registry entries/);
    }, directory);
  });
});

test("a cancelled picker changes nothing", async () => {
  await withDirectory(async (directory) => {
    await harness(async ({ command, registry, tmux }) => {
      await registry.record(created({}));
      await command("list", interactiveContext({ cancel: true }));
      assert.equal((await registry.list()).length, 1);
    }, directory);
  });
});

test("prune refuses to guess while the server is empty and removes only stale entries", async () => {
  await withDirectory(async (directory) => {
    await harness(async ({ command, registry, tmux, notices }) => {
      await registry.record(created({}));
      await registry.record(created({ id: "$9", name: "gone" }));

      tmux.sessions = "";
      tmux.windows = "";
      tmux.panes = "";
      await command("prune", interactiveContext({ confirmations: [true] }, notices));
      assert.match(notices.at(-1)!, /refusing to prune/);
      assert.equal((await registry.list()).length, 2, "nothing is pruned while no target is visible");

      tmux.sessions = "$3\tpi-test\t0\t1\n";
      tmux.windows = "$3\tpi-test\t@4\t0\textra\t1\t1\n";
      tmux.panes = "$3\tpi-test\t@4\t0\textra\t%1\t0\t1\t/tmp\t80\t24\n";
      await command("prune", interactiveContext({ confirmations: [false] }, notices));
      assert.equal((await registry.list()).length, 2, "a refused confirmation prunes nothing");

      await command("prune", interactiveContext({ confirmations: [true] }, notices));
      assert.match(notices.at(-1)!, /pruned 1 gone entry/);
      assert.deepEqual((await registry.list()).map((entry) => entry.id), ["$3"]);
    }, directory);
  });
});

test("prune all cleans stale legacy and other-conversation entries but keeps live and other-server entries", async () => {
  await withDirectory(async (directory) => {
    await harness(async ({ command, registry, notices }) => {
      await registry.record(created({}));
      await registry.record(created({ id: "$8", sessionId: "$8", piSessionId: "pi-other" }));
      await registry.record(created({ id: "$9", sessionId: "$9", piSessionId: undefined }));
      await registry.record(created({ id: "$10", sessionId: "$10", serverIdentity: "999:999" }));
      await command("prune all", interactiveContext({ confirmations: [true] }, notices));
      assert.deepEqual((await registry.list()).map((entry) => entry.id).sort(), ["$3", "$10"].sort());
    }, directory);
  });
});

function widgetContext(widgets: unknown[], mode: string) {
  return { mode, hasUI: mode === "tui", sessionManager: { getSessionId: () => "pi-current" }, ui: { setWidget: (_key: string, content: unknown) => widgets.push(content) } };
}

function plainContext(notices: string[]) {
  return { mode: "print", hasUI: false, sessionManager: { getSessionId: () => "pi-current" }, ui: { notify: (message: string) => notices.push(message) } };
}

function interactiveContext(options: { selections?: number[]; confirmations?: boolean[]; cancel?: boolean }, notices: string[] = []) {
  const selections = [...(options.selections ?? [])];
  const confirmations = [...(options.confirmations ?? [])];
  return {
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => "pi-current" },
    ui: {
      select(_title: string, choices: string[]) {
        return Promise.resolve(options.cancel ? undefined : choices[selections.shift() ?? 0]);
      },
      confirm() { return Promise.resolve(confirmations.shift() ?? false); },
      notify(message: string) { notices.push(message); },
      setWidget() {},
    },
  };
}
