import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Tmux, TmuxError } from "../src/tmux.ts";

function fakeSpawn(run: (child: FakeChild, command: string, args: readonly string[], options: unknown) => void) {
  return ((command: string, args: readonly string[], options: unknown) => {
    const child = new FakeChild();
    run(child, command, args, options);
    return child as never;
  }) as never;
}
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  kill(signal = "SIGTERM") { this.killed.push(signal); setImmediate(() => this.emit("close", null)); return true; }
  finish(code = 0) { this.emit("close", code); }
}

test("passes an argv array without a shell and supports injected test socket", async () => {
  let observed: { command?: string; args?: readonly string[]; options?: { shell?: boolean } } = {};
  const tmux = new Tmux({ socket: "/tmp/test.sock", spawnProcess: fakeSpawn((child, command, args, options) => {
    observed = { command, args, options: options as { shell?: boolean } };
    setImmediate(() => { child.stdout.write("ok\n"); child.finish(); });
  }) });
  assert.equal(await tmux.run(["send-keys", "-l", "-t", "%8", "--", "$(touch nope); text"]), "ok\n");
  assert.equal(observed.command, "tmux");
  assert.deepEqual(observed.args, ["-S", "/tmp/test.sock", "send-keys", "-l", "-t", "%8", "--", "$(touch nope); text"]);
  assert.equal(observed.options?.shell, false);
});

test("bounds combined stdout/stderr and reports output overflow", async () => {
  const tmux = new Tmux({ maxOutputBytes: 5, spawnProcess: fakeSpawn((child) => {
    setImmediate(() => { child.stdout.write("1234"); child.stderr.write("xx"); });
  }) });
  await assert.rejects(tmux.run(["display-message", "x"]), (error: unknown) => error instanceof TmuxError && error.code === "output_limit");
});

test("timeout and abort terminate child processes with actionable errors", async () => {
  const spawnProcess = fakeSpawn((child) => { child.on("kill", () => {}); });
  const timed = new Tmux({ spawnProcess });
  await assert.rejects(timed.run(["list-sessions"], { timeoutMs: 10 }), (error: unknown) => error instanceof TmuxError && error.code === "timeout");

  const controller = new AbortController();
  const aborted = timed.run(["list-sessions"], { signal: controller.signal, timeoutMs: 1000 });
  controller.abort();
  await assert.rejects(aborted, (error: unknown) => error instanceof TmuxError && error.code === "cancelled");
});

test("rejects invalid argv before spawning", async () => {
  const tmux = new Tmux();
  await assert.rejects(tmux.run(["list-sessions", "bad\0arg"]), (error: unknown) => error instanceof TmuxError && error.code === "invalid_option");
});
