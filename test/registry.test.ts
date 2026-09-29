import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Registry, defaultRegistryPath, type RegistryEntry } from "../src/registry.ts";
import { TmuxError } from "../src/tmux.ts";

const entry = (overrides: Partial<RegistryEntry> = {}): RegistryEntry => ({
  kind: "session", id: "$3", sessionId: "$3", parentSessionId: "$0", name: "child",
  tool: "tmux_create_session", createdAt: "2026-01-01T00:00:00.000Z", ...overrides,
});

async function withRegistry(run: (registry: Registry, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-tmux-registry-"));
  try {
    await run(new Registry(path.join(directory, "nested", "registry.json")), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("registry starts empty and records entries with provenance", async () => {
  await withRegistry(async (registry) => {
    assert.deepEqual(await registry.list(), []);
    await registry.record(entry());
    await registry.record(entry({ kind: "pane", id: "%1", sessionId: "$3", windowId: "@4", name: "%1", tool: "tmux_split_pane" }));

    const items = await registry.list();
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], entry());
    assert.equal(items[1]!.windowId, "@4");
    assert.match(await readFile(registry.file, "utf8"), /"parentSessionId": "\$0"/);

    await registry.record(entry({ name: "renamed" }));
    assert.equal((await registry.list()).length, 2, "recording the same kind/id replaces rather than duplicates");
    assert.equal((await registry.list())[1]!.name, "renamed");
  });
});

test("removal is scoped to a session, window, or pane", async () => {
  await withRegistry(async (registry) => {
    await registry.record(entry());
    await registry.record(entry({ kind: "pane", id: "%1", sessionId: "$3", windowId: "@4", name: "%1" }));
    await registry.record(entry({ kind: "window", id: "@4", sessionId: "$3", windowId: "@4", name: "w" }));
    await registry.record(entry({ kind: "session", id: "$9", sessionId: "$9", name: "other" }));

    assert.equal(await registry.removePane("%1"), 1);
    assert.equal(await registry.removeWindow("$3", "@4"), 1, "removing a window also drops its panes");
    assert.deepEqual((await registry.list()).map((item) => item.id), ["$3", "$9"]);
    assert.equal(await registry.removeSession("$3"), 1);
    assert.deepEqual((await registry.list()).map((item) => item.id), ["$9"]);
    assert.equal(await registry.removeSession("$404"), 0);
  });
});

test("a corrupt registry is reported, not silently overwritten", async () => {
  await withRegistry(async (registry) => {
    await mkdir(path.dirname(registry.file), { recursive: true });
    await writeFile(registry.file, "{ not json", "utf8");
    await assert.rejects(() => registry.list(), (error: unknown) => error instanceof TmuxError && /not valid JSON/.test(error.message));
    await assert.rejects(() => registry.record(entry()), /not valid JSON/);
    assert.equal(await readFile(registry.file, "utf8"), "{ not json", "the original file must survive");
  });
});

test("default registry path honours PI_TMUX_REGISTRY and XDG_STATE_HOME", () => {
  assert.equal(defaultRegistryPath({ PI_TMUX_REGISTRY: "/custom/reg.json", XDG_STATE_HOME: "/state" } as NodeJS.ProcessEnv), "/custom/reg.json");
  assert.equal(defaultRegistryPath({ XDG_STATE_HOME: "/state" } as NodeJS.ProcessEnv), path.join("/state", "pi-tmux", "registry.json"));
});
