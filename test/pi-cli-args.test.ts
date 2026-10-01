import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { resolveExecutable } from "../src/pi-subagent.ts";

/**
 * Verifies the real Pi CLI accepts the exact argument shape the launcher uses:
 * a boolean `-p` followed by `--`, after which the task is a message and cannot
 * be parsed as an option. A bogus `--model` forces Pi to fail at model
 * resolution, so this never performs a model call. Skipped where `pi` is absent
 * (for example CI); the same shape is exercised end-to-end with a fake Pi in
 * `test/pi-subagent-integration.test.ts`.
 */
const pi = await resolveExecutable("pi");

function run(args: string[], timeoutMs = 20_000): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(pi!, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, output }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

test("the real Pi CLI treats a task after -p -- as a message, not an option", { skip: pi ? false : "pi is not installed" }, async () => {
  const gated = await run(["--offline", "--model", "__pi_tmux_none__/__pi_tmux_none__", "-p", "--", "--help"]);
  assert.notEqual(gated.code, 0, `expected model resolution to fail: ${gated.output}`);
  assert.match(gated.output, /not found/i, "Pi reached model resolution, so the argument shape parsed");
  assert.ok(!gated.output.includes("Usage:"), `-- after -p must not let --help be parsed as an option:\n${gated.output}`);

  const ungated = await run(["--offline", "--model", "__pi_tmux_none__/__pi_tmux_none__", "-p", "--help"]);
  assert.equal(ungated.code, 0, ungated.output);
  assert.match(ungated.output, /Usage:/, "without --, the option is still parsed; this proves the contrast");
});
