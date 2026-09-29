import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { confirmMutation } from "../src/confirm.ts";
import { TmuxError } from "../src/tmux.ts";

function context(hasUI: boolean, confirm: () => Promise<boolean>) {
  return { hasUI, ui: { confirm } } as unknown as ExtensionContext;
}

test("confirmation fails closed without UI, on refusal, and on cancellation", async () => {
  await assert.rejects(confirmMutation(context(false, async () => true), "kill pane", "%1"), (error: unknown) => error instanceof TmuxError && error.code === "cancelled");
  await assert.rejects(confirmMutation(context(true, async () => false), "kill window", "@1"), /not approved/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(confirmMutation(context(true, async () => true), "kill pane", "%1", controller.signal), /cancelled/);
});

test("confirmation names the action and explicit target", async () => {
  let seen: string[] = [];
  await confirmMutation(context(true, async (...args: any[]) => { seen = args.slice(0, 2); return true; }), "kill session", "work ($1)");
  assert.equal(seen[0], "Confirm tmux kill session");
  assert.match(seen[1]!, /work \(\$1\)/);
});
