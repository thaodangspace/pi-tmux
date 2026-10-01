import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piTmuxChildReporter from "../extensions/child-reporter.ts";
import {
  CHILD_REPORTER_ENV,
  ChildReporter,
  type ChildReporterRegistry,
  completionDirFor,
  parseChildReporterMetadata,
} from "../src/subagent-reporter.ts";
import { SubagentJobRegistry } from "../src/subagent-jobs.ts";
import { TmuxError } from "../src/tmux.ts";

interface Harness {
  registry: SubagentJobRegistry;
  file: string;
  directory: string;
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-tmux-reporter-"));
  try {
    const file = path.join(directory, "nested", "subagent-jobs.json");
    await run({ registry: new SubagentJobRegistry(file), file, directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

interface JobOptions {
  parent?: string | null;
  status?: "created" | "starting" | "running" | "cancelled" | "completed";
  session?: string;
  pane?: string;
}

let paneCounter = 0;
const panes = new Map<string, string>();

/** Creates a job and drives it to `status` with a stable bound target. */
async function makeJob(registry: SubagentJobRegistry, options: JobOptions = {}): Promise<string> {
  const job = await registry.create({ cwd: "/work", parentPiSessionId: options.parent ?? "pi-parent" });
  if ((options.status ?? "starting") === "created") return job.jobId;
  const pane = options.pane ?? `%${++paneCounter}`;
  await registry.bind(job.jobId, { tmuxSessionId: options.session ?? "$1", tmuxPaneId: pane, serverIdentity: "1:1" });
  panes.set(job.jobId, pane);
  await registry.transition(job.jobId, "starting");
  if ((options.status ?? "starting") === "starting") return job.jobId;
  await registry.transition(job.jobId, "running");
  if (options.status === "running") return job.jobId;
  await registry.transition(job.jobId, options.status as "cancelled" | "completed");
  return job.jobId;
}

function envFor(input: { jobId: string; statePath: string; parent?: string; ancestors?: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    [CHILD_REPORTER_ENV.jobId]: input.jobId,
    [CHILD_REPORTER_ENV.state]: input.statePath,
  };
  if (input.parent !== undefined) env[CHILD_REPORTER_ENV.parentSessionId] = input.parent;
  if (input.ancestors !== undefined) env[CHILD_REPORTER_ENV.ancestors] = input.ancestors;
  return env;
}

function reporterFor(harness: Harness, jobId: string, extra: Partial<{ parent: string; ancestors: string; registry: ChildReporterRegistry; tmuxPane: string }> = {}): ChildReporter {
  const env = envFor({ jobId, statePath: harness.file, parent: extra.parent ?? "pi-parent", ancestors: extra.ancestors });
  const pane = extra.tmuxPane ?? panes.get(jobId);
  if (pane) env.TMUX_PANE = pane;
  return new ChildReporter({ env, registry: extra.registry ?? harness.registry, report: () => undefined });
}

test("parseChildReporterMetadata accepts the documented contract and rejects absent/partial/invalid metadata", () => {
  const metadata = parseChildReporterMetadata({
    [CHILD_REPORTER_ENV.jobId]: "job-1",
    [CHILD_REPORTER_ENV.state]: "/state/subagent-jobs.json",
    [CHILD_REPORTER_ENV.parentSessionId]: "pi-parent",
    [CHILD_REPORTER_ENV.ancestors]: " a , b ,a, ",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(metadata, { jobId: "job-1", statePath: "/state/subagent-jobs.json", parentSessionId: "pi-parent", ancestors: ["a", "b"] });

  assert.throws(() => parseChildReporterMetadata({} as NodeJS.ProcessEnv), /Missing PI_TMUX_SUBAGENT_JOB_ID/);
  assert.throws(() => parseChildReporterMetadata({ [CHILD_REPORTER_ENV.jobId]: "job-1" } as NodeJS.ProcessEnv), /Missing PI_TMUX_SUBAGENT_STATE/);
  assert.throws(
    () => parseChildReporterMetadata({ [CHILD_REPORTER_ENV.jobId]: "job-1", [CHILD_REPORTER_ENV.state]: "relative/jobs.json" } as NodeJS.ProcessEnv),
    /absolute path/,
  );
  assert.throws(
    () => parseChildReporterMetadata({ [CHILD_REPORTER_ENV.jobId]: "job-1", [CHILD_REPORTER_ENV.state]: "/s.json", [CHILD_REPORTER_ENV.parentSessionId]: "" } as NodeJS.ProcessEnv),
    /empty/,
  );
});

test("attach moves starting -> running, settle writes a bounded payload and moves running -> completed", async () => {
  await withHarness(async (harness) => {
    const jobId = await makeJob(harness.registry, { status: "starting" });
    const env = envFor({ jobId, statePath: harness.file, parent: "pi-parent" });
    const reporter = new ChildReporter({ env, registry: harness.registry, report: () => undefined });

    const attached = await reporter.attach({ childSessionId: "child-session-1" });
    assert.deepEqual(attached, { status: "running", passive: false });
    assert.equal((await harness.registry.get(jobId))!.status, "running");
    assert.equal(reporter.jobId, jobId);
    // The lineage marker is published into the reporter's own environment for descendants.
    assert.equal(env[CHILD_REPORTER_ENV.ancestors], jobId);

    reporter.observeOutcome("completed");
    reporter.observeAgentEnd([{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "all done" }] }]);
    const settled = await reporter.settle();
    assert.equal(settled.status, "completed");
    assert.ok(settled.resultPath);

    const job = (await harness.registry.get(jobId))!;
    assert.equal(job.status, "completed");
    assert.equal(job.resultPath, settled.resultPath);
    assert.ok(job.finishedAt);
    assert.equal((await stat(settled.resultPath!)).mode & 0o777, 0o600);

    const payload = JSON.parse(await readFile(settled.resultPath!, "utf8"));
    assert.equal(payload.version, 1);
    assert.equal(payload.jobId, jobId);
    assert.equal(payload.status, "completed");
    assert.equal(payload.childSessionId, "child-session-1");
    assert.equal(payload.summary, "all done");
    assert.equal(payload.error, undefined);
    assert.equal(path.dirname(settled.resultPath!), completionDirFor(harness.file));
  });
});

test("repeated settle is idempotent and does not rewrite the terminal job or payload", async () => {
  await withHarness(async (harness) => {
    const jobId = await makeJob(harness.registry, { status: "starting" });
    const reporter = reporterFor(harness, jobId);
    await reporter.attach({ childSessionId: "child-1" });
    reporter.observeOutcome("completed");

    const first = await reporter.settle();
    const finishedAt = (await harness.registry.get(jobId))!.finishedAt;
    const payload = await readFile(first.resultPath!, "utf8");

    const second = await reporter.settle();
    assert.deepEqual(second, first);
    assert.equal((await harness.registry.get(jobId))!.finishedAt, finishedAt);
    assert.equal(await readFile(first.resultPath!, "utf8"), payload, "a duplicate settle does not rewrite the payload");
  });
});

test("a cancellation/terminal race never rewrites the terminal job", async () => {
  await withHarness(async (harness) => {
    // Cancelled before the child attaches: passive, quiet no-op.
    const cancelled = await makeJob(harness.registry, { status: "cancelled" });
    const early = reporterFor(harness, cancelled);
    const attached = await early.attach({ childSessionId: "child-1" });
    assert.deepEqual(attached, { status: "cancelled", passive: true });
    const settled = await early.settle();
    assert.deepEqual(settled, { status: "ignored", reason: "job-already-terminal" });
    assert.equal((await harness.registry.get(cancelled))!.status, "cancelled");

    // Cancelled after attach but before settle: the immutable outcome wins.
    const racing = await makeJob(harness.registry, { status: "starting" });
    const reporter = reporterFor(harness, racing);
    await reporter.attach({ childSessionId: "child-1" });
    await harness.registry.transition(racing, "cancelled");
    const result = await reporter.settle();
    assert.deepEqual(result, { status: "ignored", reason: "job-already-terminal" });
    const job = (await harness.registry.get(racing))!;
    assert.equal(job.status, "cancelled");
    assert.equal(job.resultPath, undefined, "the reporter must not attach a result to a cancelled job");
  });
});

test("derive failure from structured lifecycle data, never from pane text", async () => {
  await withHarness(async (harness) => {
    const errored = await makeJob(harness.registry, { status: "starting" });
    const errorReporter = reporterFor(harness, errored);
    await errorReporter.attach({ childSessionId: "child-e" });
    errorReporter.observeAgentEnd([{ role: "assistant", stopReason: "error", errorMessage: "provider exploded", content: "ignored" }]);
    const failed = await errorReporter.settle();
    assert.equal(failed.status, "failed");
    const errorJob = (await harness.registry.get(errored))!;
    assert.equal(errorJob.status, "failed");
    assert.equal(errorJob.error, "provider exploded");
    assert.equal(JSON.parse(await readFile(failed.resultPath!, "utf8")).status, "failed");

    const aborted = await makeJob(harness.registry, { status: "starting" });
    const abortReporter = reporterFor(harness, aborted);
    await abortReporter.attach({ childSessionId: "child-a" });
    abortReporter.observeOutcome("aborted");
    const abortedResult = await abortReporter.settle();
    assert.equal(abortedResult.status, "failed");
    assert.match((await harness.registry.get(aborted))!.error ?? "", /aborted/);

    // No structured outcome at all: never infer success from output.
    const silent = await makeJob(harness.registry, { status: "starting" });
    const silentReporter = reporterFor(harness, silent);
    await silentReporter.attach({ childSessionId: "child-s" });
    const silentResult = await silentReporter.settle();
    assert.equal(silentResult.status, "failed");
    assert.match((await harness.registry.get(silent))!.error ?? "", /without an observed agent outcome/);
  });
});

test("invalid metadata and identity mismatches reject before mutating any job", async () => {
  await withHarness(async (harness) => {
    const jobId = await makeJob(harness.registry, { status: "starting" });
    const before = await harness.registry.get(jobId);

    // Missing metadata.
    const missing = new ChildReporter({ env: {} as NodeJS.ProcessEnv, registry: harness.registry, report: () => undefined });
    await assert.rejects(() => missing.attach({ childSessionId: "child-1" }), /Missing PI_TMUX_SUBAGENT_JOB_ID/);

    // Unknown job.
    const unknown = reporterFor(harness, "does-not-exist");
    await assert.rejects(() => unknown.attach({ childSessionId: "child-1" }), /does not exist/);

    // Parent mismatch and missing parent metadata.
    await assert.rejects(() => reporterFor(harness, jobId, { parent: "someone-else" }).attach({ childSessionId: "child-1" }), /Parent session mismatch/);
    const noParent = new ChildReporter({ env: envFor({ jobId, statePath: harness.file }), registry: harness.registry, report: () => undefined });
    await assert.rejects(() => noParent.attach({ childSessionId: "child-1" }), /incomplete/);

    // Pane mismatch.
    await assert.rejects(() => reporterFor(harness, jobId).attach({ childSessionId: "child-1", tmuxPaneId: "%99" }), /different pane/);

    // The unrelated-unmutated invariant.
    assert.deepEqual(await harness.registry.get(jobId), before);
    assert.equal(before!.status, "starting");
  });
});

test("recursive-delegation guards reject self-parent and ancestor re-entry", async () => {
  await withHarness(async (harness) => {
    const selfParent = await makeJob(harness.registry, { status: "starting", parent: "child-1" });
    await assert.rejects(() => reporterFor(harness, selfParent, { parent: "child-1" }).attach({ childSessionId: "child-1" }), /self-referential/);

    const jobId = await makeJob(harness.registry, { status: "starting" });
    await assert.rejects(() => reporterFor(harness, jobId, { ancestors: `ancestor-1,${jobId}` }).attach({ childSessionId: "child-2" }), /recursive subagent loop/);
  });
});

test("an unbound or corrupt job is rejected without touching unrelated jobs", async () => {
  await withHarness(async (harness) => {
    const unbound = await makeJob(harness.registry, { status: "created" });
    await assert.rejects(() => reporterFor(harness, unbound).attach({ childSessionId: "child-1" }), /no bound tmux target|must bind/);

    const healthy = await makeJob(harness.registry, { status: "running" });
    const corrupt = path.join(harness.directory, "corrupt.json");
    await writeFile(corrupt, "{ not json", "utf8");
    const broken = new ChildReporter({
      env: envFor({ jobId: healthy, statePath: corrupt, parent: "pi-parent" }),
      registry: new SubagentJobRegistry(corrupt),
      report: () => undefined,
    });
    await assert.rejects(() => broken.attach({ childSessionId: "child-1" }), (error: unknown) => error instanceof TmuxError);
    assert.equal((await harness.registry.get(healthy))!.status, "running");
  });
});

test("persistence failures fail closed and leave the job recoverable", async () => {
  await withHarness(async (harness) => {
    // Registry write failure on the terminal transition.
    const jobId = await makeJob(harness.registry, { status: "starting" });
    const failing: ChildReporterRegistry = {
      get: (id) => harness.registry.get(id),
      transition: async (id, status, options) => {
        if (status === "completed" || status === "failed") throw new TmuxError("simulated registry write failure", "command_failed");
        return harness.registry.transition(id, status, options);
      },
    };
    const reporter = reporterFor(harness, jobId, { registry: failing });
    await reporter.attach({ childSessionId: "child-1" });
    reporter.observeOutcome("completed");
    await assert.rejects(() => reporter.settle(), /simulated registry write failure/);
    assert.equal((await harness.registry.get(jobId))!.status, "running", "the durable state is not faked as terminal");

    // Completion-payload write failure must also not claim success.
    const payloadJob = await makeJob(harness.registry, { status: "starting" });
    const blocked = path.join(harness.directory, "blocked-dir");
    await writeFile(blocked, "not a directory", "utf8");
    const payloadReporter = new ChildReporter({
      env: envFor({ jobId: payloadJob, statePath: harness.file, parent: "pi-parent" }),
      registry: harness.registry,
      completionDir: blocked,
      report: () => undefined,
    });
    await payloadReporter.attach({ childSessionId: "child-1" });
    payloadReporter.observeOutcome("completed");
    await assert.rejects(() => payloadReporter.settle(), (error: unknown) => error instanceof TmuxError);
    assert.equal((await harness.registry.get(payloadJob))!.status, "running");
  });
});

test("only the requested job changes; unrelated jobs are untouched", async () => {
  await withHarness(async (harness) => {
    const target = await makeJob(harness.registry, { status: "starting" });
    const unrelated = await makeJob(harness.registry, { status: "running", session: "$2", pane: "%2" });
    const unrelatedBefore = await harness.registry.get(unrelated);

    const reporter = reporterFor(harness, target);
    await reporter.attach({ childSessionId: "child-1" });
    reporter.observeOutcome("completed");
    await reporter.settle();

    assert.equal((await harness.registry.get(target))!.status, "completed");
    assert.deepEqual(await harness.registry.get(unrelated), unrelatedBefore);
  });
});

test("the completion summary and error are explicitly bounded", async () => {
  await withHarness(async (harness) => {
    const jobId = await makeJob(harness.registry, { status: "starting" });
    const reporter = new ChildReporter({
      env: envFor({ jobId, statePath: harness.file, parent: "pi-parent" }),
      registry: harness.registry,
      maxSummaryBytes: 8,
      maxErrorBytes: 6,
      report: () => undefined,
    });
    await reporter.attach({ childSessionId: "child-1" });
    reporter.observeAgentEnd([{ role: "assistant", stopReason: "error", errorMessage: "0123456789", content: "abcdefghijklmnop" }]);
    const result = await reporter.settle();
    const payload = JSON.parse(await readFile(result.resultPath!, "utf8"));
    assert.ok(Buffer.byteLength(payload.error, "utf8") <= 6);
    assert.equal(payload.error, "012345");
    assert.equal(payload.summary, undefined, "a failed job carries no success summary");
  });
});

// --- Extension wiring -------------------------------------------------------

type AnyHandler = (event: any, ctx: any) => any;

function fakeExtension() {
  const handlers = new Map<string, AnyHandler[]>();
  const pi = {
    on: (event: string, handler: AnyHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => undefined;
    },
  } as unknown as ExtensionAPI;
  const emit = async (event: string, payload: unknown, ctx: unknown) => {
    const list = handlers.get(event) ?? [];
    const results = [];
    for (const handler of list) results.push(await handler(payload, ctx));
    return results;
  };
  return { pi, handlers, emit };
}

async function withEnv<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the packaged extension wires agent_settled to a running -> completed transition and is idempotent", async () => {
  await withHarness(async (harness) => {
    const jobId = await makeJob(harness.registry, { status: "starting" });
    const { pi, handlers, emit } = fakeExtension();
    piTmuxChildReporter(pi);
    assert.deepEqual([...handlers.keys()].sort(), ["agent_before_settle", "agent_end", "agent_settled", "session_start", "turn_end"].sort());

    const ctx = { sessionManager: { getSessionId: () => "extension-child" }, cwd: "/work", ui: { notify: () => undefined } };
    await withEnv({ [CHILD_REPORTER_ENV.jobId]: jobId, [CHILD_REPORTER_ENV.state]: harness.file, [CHILD_REPORTER_ENV.parentSessionId]: "pi-parent", TMUX_PANE: panes.get(jobId)! }, async () => {
      await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
      assert.equal((await harness.registry.get(jobId))!.status, "running");
      await emit("agent_before_settle", { type: "agent_before_settle", outcome: "completed" }, ctx);
      await emit("agent_settled", { type: "agent_settled" }, ctx);
      const finishedAt = (await harness.registry.get(jobId))!.finishedAt;
      await emit("agent_settled", { type: "agent_settled" }, ctx); // duplicate delivery
      const job = (await harness.registry.get(jobId))!;
      assert.equal(job.status, "completed");
      assert.equal(job.finishedAt, finishedAt);
    });
  });
});

test("the packaged extension fails visibly on invalid metadata without mutating a job", async () => {
  await withHarness(async (harness) => {
    const jobId = await makeJob(harness.registry, { status: "running" });
    const before = await harness.registry.get(jobId);
    const { pi, emit } = fakeExtension();
    piTmuxChildReporter(pi);
    const ctx = { sessionManager: { getSessionId: () => "extension-child" }, cwd: "/work", ui: { notify: () => undefined } };
    await withEnv({ [CHILD_REPORTER_ENV.jobId]: jobId }, async () => {
      await assert.rejects(() => emit("session_start", { type: "session_start", reason: "startup" }, ctx), /Missing PI_TMUX_SUBAGENT_STATE/);
    });
    assert.deepEqual(await harness.registry.get(jobId), before);
  });
});

test("the extension module is a default-exported factory and is not part of the auto-loaded manifest", async () => {
  assert.equal(typeof piTmuxChildReporter, "function");
  const manifest = JSON.parse(await readFile(path.join(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./extensions/index.ts"]);
  assert.equal(manifest.pi.childReporter, "./extensions/child-reporter.ts");
});
