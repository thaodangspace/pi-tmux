import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTmuxTools } from "../src/tools.ts";
import { Registry } from "../src/registry.ts";
import { Tmux } from "../src/tmux.ts";

const available = await new Promise<boolean>((resolve) => {
  const child = spawn("tmux", ["-V"], { stdio: "ignore" });
  child.on("error", () => resolve(false));
  child.on("close", (code) => resolve(code === 0));
});

test("isolated tmux server exercises tools without touching the user's default server", { skip: !available }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-tmux-test-"));
  const socket = path.join(directory, "s");
  const tmux = new Tmux({ socket });
  const registry = new Registry(path.join(directory, "registry.json"));
  const tools: Record<string, any> = {};
  registerTmuxTools({ registerTool(tool: any) { tools[tool.name] = tool; } } as unknown as ExtensionAPI, tmux, registry);
  let approve = false;
  const context = {
    hasUI: true,
    sessionManager: { getSessionId: () => "pi-current" },
    ui: { async confirm() { return approve; } },
  } as unknown as ExtensionContext;
  const call = async (name: string, params: Record<string, unknown> = {}, ctx = context) => {
    const tool = tools[name];
    assert.ok(tool, `missing tool ${name}`);
    const value = await tool.execute("test-call", params, undefined, undefined, ctx);
    assert.equal(value.isError, undefined, `${name}: ${value.content?.[0]?.text}`);
    return JSON.parse(value.content[0].text);
  };
  const callError = async (name: string, params: Record<string, unknown>, ctx = context) => {
    const value = await tools[name].execute("test-call", params, undefined, undefined, ctx);
    assert.equal(value.isError, true);
    return value.content[0].text as string;
  };

  try {
    await runTmux(socket, ["-f", "/dev/null", "new-session", "-d", "-s", "bootstrap"]);
    await runTmux(socket, ["set-option", "-g", "default-shell", "/bin/sh"]);
    await runTmux(socket, ["set-option", "-s", "exit-empty", "off"]);
    await runTmux(socket, ["kill-session", "-t", "bootstrap"]);
    assert.match(await callError("tmux_create_session", { name: "invalid", cwd: path.join(directory, "missing") }), /[Ww]orking directory/);
    const created = await call("tmux_create_session", { name: "pi-test", cwd: directory });
    assert.match(created.id, /^\$\d+$/);
    assert.equal(created.attached, false);
    assert.equal(created.tracked, true);
    assert.equal(created.parentSessionId, null, "no TMUX_PANE on this server means the parent stays unknown");
    let sessions = await call("tmux_list_sessions");
    assert.deepEqual(sessions.items.map((s: any) => s.id), [created.id]);
    assert.equal(sessions.items[0].tracked, true);
    assert.deepEqual((await call("tmux_list_sessions", { tracked: false })).items, []);
    const createdList = await call("tmux_list_created");
    assert.deepEqual(createdList.items.map((entry: any) => [entry.kind, entry.id, entry.live]), [["session", created.id, true]]);
    assert.equal((await call("tmux_inspect_session", { target: created.id })).id, created.id);
    assert.match(await callError("tmux_select_session", { target: created.id }), /No attached tmux client/);

    // tmux_create_window must default to the session Pi runs in, never the client's view.
    const ownPane = (await call("tmux_list_panes", { session: created.id })).items[0].id;
    const serverPid = (await tmux.run(["display-message", "-p", "#{pid}"])).trim();
    const savedTmux = process.env.TMUX;
    const savedPane = process.env.TMUX_PANE;
    process.env.TMUX = `${socket},${serverPid},0`;
    process.env.TMUX_PANE = ownPane;
    try {
      const ownSession = (await call("tmux_list_sessions")).items.find((item: any) => item.current);
      assert.equal(ownSession.id, created.id, "the running session is flagged current");
      const defaultWindow = await call("tmux_create_window", { name: "auto-own" });
      assert.equal(defaultWindow.sessionId, created.id, "window defaults to the session Pi runs in");
      assert.equal(defaultWindow.parentSessionId, created.id);
      await call("tmux_kill_window", { target: defaultWindow.id });
    } finally {
      if (savedTmux === undefined) delete process.env.TMUX; else process.env.TMUX = savedTmux;
      if (savedPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = savedPane;
    }
    assert.match(await callError("tmux_create_window", { name: "no-parent" }), /not inside tmux|TMUX_PANE/);

    const window = await call("tmux_create_window", { session: created.id, name: "extra", cwd: directory });
    assert.match(window.id, /^@\d+$/);
    assert.equal(window.selected, false);
    assert.equal(window.tracked, true);
    assert.equal(window.parentSessionId, null, "the creating agent's session is unknown on this server");
    await call("tmux_rename_window", { target: window.id, name: "renamed" });
    assert.equal((await call("tmux_inspect_window", { target: window.id })).name, "renamed");
    await call("tmux_select_window", { target: window.id });

    const firstPaneList = await call("tmux_list_panes", { window: window.id });
    assert.equal(firstPaneList.items.length, 1);
    const pane = firstPaneList.items[0].id;
    const headless = { hasUI: false, sessionManager: context.sessionManager, ui: {} } as unknown as ExtensionContext;
    await call("tmux_send_text", { target: pane, text: "echo PI_OWNED" }, headless);
    await call("tmux_send_key", { target: pane, key: "Enter" }, headless);
    await runTmux(socket, ["new-session", "-d", "-s", "external"]);
    const externalPane = (await call("tmux_list_panes", { session: "external" })).items[0].id;
    assert.match(await callError("tmux_send_key", { target: externalPane, key: "Enter" }, headless), /confirmation|UI/i);
    const ownedWindow = await call("tmux_create_window", { session: "external", name: "owned" });
    const ownedWindowPane = (await call("tmux_list_panes", { window: ownedWindow.id })).items[0].id;
    await call("tmux_send_key", { target: ownedWindowPane, key: "Enter" }, headless);
    const ownedPane = await call("tmux_split_pane", { target: externalPane, orientation: "vertical" });
    await call("tmux_send_key", { target: ownedPane.id, key: "Enter" }, headless);
    assert.match(await callError("tmux_send_key", { target: externalPane, key: "Enter" }, headless), /confirmation|UI/i);
    assert.match(await callError("tmux_kill_window", { target: (await call("tmux_list_windows", { session: "external" })).items.find((item: any) => item.id !== ownedWindow.id).id }, headless), /confirmation|UI/i);
    await call("tmux_kill_pane", { target: ownedPane.id }, headless);
    await call("tmux_kill_window", { target: ownedWindow.id }, headless);
    assert.match(await callError("tmux_kill_session", { target: "external" }, headless), /confirmation|UI/i);
    await runTmux(socket, ["link-window", "-s", window.id, "-t", "external:"]);
    assert.match(await callError("tmux_send_key", { target: pane, key: "Enter" }, headless), /confirmation|UI/i);
    assert.match(await callError("tmux_kill_window", { target: window.id }, headless), /confirmation|UI/i);
    assert.match(await callError("tmux_kill_session", { target: created.id }, headless), /confirmation|UI/i);
    await runTmux(socket, ["unlink-window", "-t", "external:" + (await call("tmux_list_windows", { session: "external" })).items.find((item: any) => item.id === window.id).index]);
    await runTmux(socket, ["kill-session", "-t", "external"]);
    const otherPi = { hasUI: false, sessionManager: { getSessionId: () => "pi-other" }, ui: {} } as unknown as ExtensionContext;
    assert.match(await callError("tmux_send_key", { target: pane, key: "Enter" }, otherPi), /confirmation|UI/i);
    assert.match(await callError("tmux_kill_session", { target: created.id }, otherPi), /confirmation|UI/i);
    assert.deepEqual((await call("tmux_list_created", {}, otherPi)).items, []);
    assert.equal((await call("tmux_list_sessions", {}, otherPi)).items[0].tracked, false);
    assert.equal((await call("tmux_list_panes", { window: window.id })).items.length, 1);
    const split = await call("tmux_split_pane", { target: pane, orientation: "horizontal", cwd: directory });
    assert.match(split.id, /^%\d+$/);
    assert.equal(split.selected, false);
    await call("tmux_select_pane", { target: split.id });
    await call("tmux_resize_pane", { target: split.id, dimension: "width", amount: 30 });
    const panes = await call("tmux_list_panes", { window: window.id });
    assert.equal(panes.items.length, 2);
    assert.equal((await call("tmux_inspect_pane", { target: split.id })).id, split.id);

    const headlessContext = headless;
    const probe = await call("tmux_split_pane", { target: split.id, orientation: "vertical", cwd: directory });
    const headlessSend = await call("tmux_send_text", { target: probe.id, text: "echo PI_NO_UI_MARKER" }, headlessContext);
    assert.equal(headlessSend.approved, undefined);
    await call("tmux_send_key", { target: probe.id, key: "Enter" }, headlessContext);
    const probeCapture = await call("tmux_capture_pane", { target: probe.id, historyLines: 20 });
    assert.ok(probeCapture.snapshot.split("PI_NO_UI_MARKER").length - 1 >= 2, probeCapture.snapshot);
    await call("tmux_kill_pane", { target: probe.id }, headless);
    assert.equal((await call("tmux_list_panes", { window: window.id })).items.length, 2);
    assert.equal((await call("tmux_list_sessions")).items.length, 1);

    approve = true;
    const send = await call("tmux_send_text", { target: split.id, text: "echo PI_SENT_MARKER" });
    assert.equal(send.enterAppended, false);
    const beforeEnter = await call("tmux_capture_pane", { target: split.id, historyLines: 20 });
    assert.equal(beforeEnter.snapshot.split("PI_SENT_MARKER").length - 1, 1);
    await call("tmux_send_key", { target: split.id, key: "Enter" });
    const afterEnter = await call("tmux_capture_pane", { target: split.id, historyLines: 20 });
    assert.ok(afterEnter.snapshot.split("PI_SENT_MARKER").length - 1 >= 2, afterEnter.snapshot);
    assert.match(afterEnter.caveat, /does not indicate process completion/);

    const racingPane = await call("tmux_split_pane", { target: pane, orientation: "vertical" });
    const disappearingContext = {
      hasUI: true,
      sessionManager: otherPi.sessionManager,
      ui: { async confirm() { await tmux.run(["kill-pane", "-t", racingPane.id]); return true; } },
    } as unknown as ExtensionContext;
    assert.match(await callError("tmux_kill_pane", { target: racingPane.id }, disappearingContext), /not found/);
    assert.equal((await call("tmux_list_panes", { window: window.id })).items.length, 2);

    const removedPane = await call("tmux_kill_pane", { target: split.id }, headless);
    assert.equal(removedPane.removed, true);
    const removedWindow = await call("tmux_kill_window", { target: window.id });
    assert.equal(removedWindow.removed, true);
    assert.equal(removedWindow.forgotten, 2, "killing a window also forgets the window and panes recorded under it");
    assert.deepEqual((await call("tmux_list_created")).items.map((entry: any) => entry.id), [created.id]);
    const saved = (await registry.list()).find((entry) => entry.id === created.id)!;
    await registry.record({ ...saved, serverIdentity: "0:0" });
    assert.equal((await call("tmux_list_created")).items[0].live, false);
    assert.equal((await call("tmux_list_sessions")).items[0].tracked, false);
    assert.match(await callError("tmux_kill_session", { target: created.id }), /another or unknown tmux server/);
    await registry.record({ ...saved, piSessionId: undefined });
    const survivingPane = (await call("tmux_list_panes", { session: created.id })).items[0].id;
    assert.match(await callError("tmux_send_key", { target: survivingPane, key: "Enter" }, headless), /confirmation|UI/i);
    assert.match(await callError("tmux_kill_session", { target: created.id }, headless), /confirmation|UI/i);
    assert.deepEqual((await call("tmux_list_created")).items, []);
    await registry.record(saved);
    await call("tmux_rename_session", { target: created.id, name: "renamed-session" });
    assert.equal((await call("tmux_inspect_session", { target: created.id })).name, "renamed-session");
    const childSession = await call("tmux_create_session", { name: "child", cwd: directory, parent: created.id });
    assert.equal(childSession.parentSessionId, created.id, "an explicit parent is recorded as-is");
    assert.deepEqual((await call("tmux_list_created", { kind: "session" })).items.map((entry: any) => entry.id).sort(), [created.id, childSession.id].sort());
    const renamedSession = await call("tmux_create_session", { name: "other", cwd: directory });
    assert.match(renamedSession.id, /^\$\d+$/);
    const forgottenChild = await call("tmux_kill_session", { target: childSession.id });
    assert.equal(forgottenChild.forgotten, 1);
    await call("tmux_kill_session", { target: renamedSession.id });
    await call("tmux_kill_session", { target: created.id }, headless);
    assert.deepEqual((await call("tmux_list_created")).items, [], "killing tracked sessions clears their registry entries");
    sessions = await call("tmux_list_sessions");
    assert.deepEqual(sessions.items, []);
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
