import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTmuxTools } from "../src/tools.ts";
import { Tmux } from "../src/tmux.ts";

class CaptureTmux extends Tmux {
  output = "";
  commands: string[][] = [];
  override async run(args: readonly string[]): Promise<string> {
    this.commands.push([...args]);
    if (args[0] === "list-panes") return "$0\twork\t@0\t0\tmain\t%0\t0\t1\t/tmp\t80\t24\n";
    if (args[0] === "capture-pane") return this.output;
    throw new Error(`unexpected command: ${args[0]}`);
  }
}

class ClientTmux extends Tmux {
  clients = "client-1\t$1\t/dev/tty1\n";
  commands: string[][] = [];
  override async run(args: readonly string[]): Promise<string> {
    this.commands.push([...args]);
    if (args[0] === "list-sessions") return "$1\twork\t0\t1\n";
    if (args[0] === "list-clients") return this.clients;
    if (args[0] === "switch-client") return "";
    throw new Error(`unexpected command: ${args[0]}`);
  }
}

test("capture strips ANSI/control codes, reports truncation, and enforces byte and line bounds", async () => {
  const tmux = new CaptureTmux();
  const tools: Record<string, any> = {};
  registerTmuxTools({ registerTool(tool: any) { tools[tool.name] = tool; } } as unknown as ExtensionAPI, tmux);
  const call = async (params: Record<string, unknown>) => {
    const value = await tools.tmux_capture_pane.execute("id", params, undefined, undefined, {});
    assert.equal(value.isError, undefined);
    return JSON.parse(value.content[0].text);
  };

  tmux.output = "\u001b[31mred\u001b[0m\r\nplain\u0007";
  const clean = await call({ target: "%0" });
  assert.equal(clean.snapshot, "red\nplain");
  assert.equal(clean.truncated, false);
  assert.ok(!tmux.commands.at(-1)!.includes("-e"));

  tmux.output = "x".repeat(60_000);
  const bytes = await call({ target: "%0" });
  assert.equal(bytes.truncated, true);
  assert.ok(Buffer.byteLength(bytes.snapshot) <= 40_000);

  tmux.output = Array.from({ length: 3500 }, (_, i) => `line-${i}`).join("\n");
  const lines = await call({ target: "%0", historyLines: 5000 });
  assert.equal(lines.truncated, true);
  assert.match(lines.snapshot, /^\[Snapshot truncated/);
  assert.ok(lines.snapshot.split("\n").length <= 3001);
});

test("invalid capture bounds fail before starting a tmux command", async () => {
  const tmux = new CaptureTmux();
  const tools: Record<string, any> = {};
  registerTmuxTools({ registerTool(tool: any) { tools[tool.name] = tool; } } as unknown as ExtensionAPI, tmux);
  const error = await tools.tmux_capture_pane.execute("id", { target: "%0", historyLines: 5001 }, undefined, undefined, {});
  assert.equal(error.isError, true);
  assert.match(error.content[0].text, /0 to 5000/);
  assert.deepEqual(tmux.commands, []);
});

test("session selection chooses only an unambiguous attached client and never falls back", async () => {
  const tmux = new ClientTmux();
  const tools: Record<string, any> = {};
  registerTmuxTools({ registerTool(tool: any) { tools[tool.name] = tool; } } as unknown as ExtensionAPI, tmux);
  const select = tools.tmux_select_session.execute;

  const selected = await select("id", { target: "$1" }, undefined, undefined, {});
  assert.equal(selected.isError, undefined);
  assert.deepEqual(tmux.commands.at(-1), ["switch-client", "-c", "client-1", "-t", "$1"]);

  tmux.clients = "client-1\t$1\t/dev/tty1\nclient-2\t$1\t/dev/tty2\n";
  const switchCount = tmux.commands.filter((args) => args[0] === "switch-client").length;
  const ambiguous = await select("id", { target: "$1" }, undefined, undefined, {});
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content[0].text, /Multiple tmux clients/);
  assert.equal(tmux.commands.filter((args) => args[0] === "switch-client").length, switchCount);

  await select("id", { target: "$1", client: "client-2" }, undefined, undefined, {});
  assert.deepEqual(tmux.commands.at(-1), ["switch-client", "-c", "client-2", "-t", "$1"]);
  const before = tmux.commands.filter((args) => args[0] === "switch-client").length;
  const unknown = await select("id", { target: "$1", client: "wrong-client" }, undefined, undefined, {});
  assert.equal(unknown.isError, true);
  assert.equal(tmux.commands.filter((args) => args[0] === "switch-client").length, before);
});
