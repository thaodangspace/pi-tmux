import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import tmuxControlExtension from "../extensions/index.ts";
import {
  type CompletionDeliveryOptions,
  type SubagentCompletionEvent,
  CompletionDelivery,
  SUBAGENT_COMPLETION_CUSTOM_TYPE,
  buildSubagentCompletionEvent,
  createCompletionSink,
  defaultCompletionWatchFactory,
} from "../src/completion-delivery.ts";
import { SubagentJobRegistry, type SubagentJobV1 } from "../src/subagent-jobs.ts";
import type { LiveTargets } from "../src/targets.ts";
import { TmuxError } from "../src/tmux.ts";

interface Harness {
  dir: string;
  jobs: SubagentJobRegistry;
  watched: { opened: number; closed: number };
  makeDelivery: (overrides?: Partial<CompletionDeliveryOptions>) => { delivery: CompletionDelivery; delivered: SubagentCompletionEvent[] };
  createTerminalJob: (parent?: string, status?: "completed" | "failed") => Promise<SubagentJobV1>;
  createRunningJob: (parent?: string) => Promise<SubagentJobV1>;
  close: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-completion-"));
  const jobs = new SubagentJobRegistry(path.join(dir, "jobs.json"));
  const watched = { opened: 0, closed: 0 };
  let next = 1;
  const watch: CompletionDeliveryOptions["watch"] = () => {
    watched.opened++;
    let open = true;
    return {
      close() {
        if (open) { open = false; watched.closed++; }
      },
    };
  };
  const makeDelivery = (overrides: Partial<CompletionDeliveryOptions> = {}) => {
    const delivered: SubagentCompletionEvent[] = [];
    const delivery = new CompletionDelivery({
      ownerPiSessionId: "ses-parent",
      jobs,
      deliver: (event) => { delivered.push(event); },
      debounceMs: 0,
      pollIntervalMs: 0,
      watch,
      ...overrides,
    });
    return { delivery, delivered };
  };
  const bindRunning = async (parent: string): Promise<SubagentJobV1> => {
    const n = next++;
    const job = await jobs.create({ cwd: "/tmp", parentPiSessionId: parent });
    await jobs.bind(job.jobId, { tmuxSessionId: `$${n}`, tmuxPaneId: `%${n}`, serverIdentity: "1:1" });
    await jobs.transition(job.jobId, "starting");
    return jobs.transition(job.jobId, "running");
  };
  return {
    dir,
    jobs,
    watched,
    makeDelivery,
    createTerminalJob: async (parent = "ses-parent", status: "completed" | "failed" = "completed") =>
      jobs.transition((await bindRunning(parent)).jobId, status),
    createRunningJob: (parent = "ses-parent") => bindRunning(parent),
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Emulates Pi's sendCustomMessage stream/idle dispatch so the option shape's effect is asserted, not just recorded. */
function dispatch(options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }, isStreaming: boolean): string {
  if (options.deliverAs === "nextTurn") return "nextTurn";
  if (isStreaming && options.triggerTurn !== false) return options.deliverAs === "followUp" ? "followUp" : "steer";
  if (options.triggerTurn) return "turn";
  return isStreaming ? "deferred" : "append";
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

async function waitForAsync(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

test("delivers one machine-readable completion event to the owning parent and acknowledges it", async () => {
  const h = await makeHarness();
  try {
    const job = await h.createTerminalJob();
    const { delivery, delivered } = h.makeDelivery();
    await delivery.refresh();

    assert.equal(delivered.length, 1);
    const event = delivered[0]!;
    assert.equal(event.customType, SUBAGENT_COMPLETION_CUSTOM_TYPE);
    assert.equal(event.display, true);
    assert.equal(event.content, `Pi subagent ${job.jobId} completed`);
    assert.deepEqual(event.details, {
      version: 1,
      jobId: job.jobId,
      status: "completed",
      completionSeq: job.completionSeq,
      finishedAt: job.finishedAt,
    });
    assert.equal((await h.jobs.get(job.jobId))?.notifiedAt !== undefined, true, "the durable acknowledgement is recorded after delivery");
    assert.equal(delivery.observing, false, "no observation remains once nothing is active or pending");
    await delivery.shutdown();
  } finally {
    await h.close();
  }
});

test("recovers a completion that arrived while the parent was offline", async () => {
  const h = await makeHarness();
  try {
    // The child settles before any parent delivery instance exists.
    const job = await h.createTerminalJob();
    assert.equal((await h.jobs.get(job.jobId))?.notifiedAt, undefined);

    const { delivery, delivered } = h.makeDelivery();
    await delivery.refresh();

    assert.equal(delivered.length, 1, "on startup the parent redelivers the undelivered terminal job");
    assert.equal(delivered[0]!.details.jobId, job.jobId);
    assert.equal((await h.jobs.get(job.jobId))?.notifiedAt !== undefined, true);
    await delivery.shutdown();
  } finally {
    await h.close();
  }
});

test("never delivers another Pi conversation's completion", async () => {
  const h = await makeHarness();
  try {
    const other = await h.createTerminalJob("ses-other");
    const { delivery, delivered } = h.makeDelivery();
    await delivery.refresh();

    assert.equal(delivered.length, 0, "only the owning parent may receive the event");
    assert.equal((await h.jobs.get(other.jobId))?.notifiedAt, undefined, "a foreign job is never acknowledged");
    assert.equal(delivery.observing, false, "a foreign pending job does not keep this parent observing");
    await delivery.shutdown();
  } finally {
    await h.close();
  }
});

test("repeated passes do not re-deliver an acknowledged completion", async () => {
  const h = await makeHarness();
  try {
    const job = await h.createTerminalJob();
    const { delivery, delivered } = h.makeDelivery();
    await delivery.refresh();
    await delivery.refresh();
    await delivery.refresh();

    assert.equal(delivered.length, 1, "duplicate signals collapse to one logical delivery");
    assert.equal((await h.jobs.get(job.jobId))?.notifiedAt !== undefined, true);
    await delivery.shutdown();
  } finally {
    await h.close();
  }
});

test("does not acknowledge a completion whose parent event could not be delivered", async () => {
  const h = await makeHarness();
  try {
    const job = await h.createTerminalJob();
    let failing = true;
    const delivered: SubagentCompletionEvent[] = [];
    const { delivery } = h.makeDelivery({
      deliver: (event) => {
        if (failing) throw new TmuxError("parent delivery unavailable", "command_failed");
        delivered.push(event);
      },
    });

    await delivery.refresh();
    assert.equal(delivered.length, 0);
    assert.equal((await h.jobs.get(job.jobId))?.notifiedAt, undefined, "an undelivered completion must stay pending");

    failing = false;
    await delivery.refresh();
    assert.equal(delivered.length, 1, "the still-pending completion is retried");
    assert.equal((await h.jobs.get(job.jobId))?.notifiedAt !== undefined, true);
    await delivery.shutdown();
  } finally {
    await h.close();
  }
});

test("redelivers a completion after a crash between the event and its acknowledgement", async () => {
  class NoAckRegistry extends SubagentJobRegistry {
    override async markNotified(): Promise<SubagentJobV1> {
      throw new TmuxError("simulated crash before acknowledgement", "command_failed");
    }
  }
  const h = await makeHarness();
  try {
    const job = await h.createTerminalJob();

    // First parent instance delivers, then "crashes" before the acknowledgement lands.
    const first: SubagentCompletionEvent[] = [];
    const crashed = new CompletionDelivery({
      ownerPiSessionId: "ses-parent",
      jobs: new NoAckRegistry(h.jobs.file),
      deliver: (event) => { first.push(event); },
      debounceMs: 0,
      pollIntervalMs: 0,
      watch: () => ({ close() {} }),
    });
    await crashed.refresh();
    assert.equal(first.length, 1);
    assert.equal((await h.jobs.get(job.jobId))?.notifiedAt, undefined);
    await crashed.shutdown();

    // A fresh parent recovers the still-pending completion; the stable sequence marks it as a duplicate.
    const second: SubagentCompletionEvent[] = [];
    const recovered = new CompletionDelivery({
      ownerPiSessionId: "ses-parent",
      jobs: h.jobs,
      deliver: (event) => { second.push(event); },
      debounceMs: 0,
      pollIntervalMs: 0,
      watch: () => ({ close() {} }),
    });
    await recovered.refresh();
    assert.equal(second.length, 1);
    assert.equal(second[0]!.details.jobId, job.jobId);
    assert.equal(second[0]!.details.completionSeq, first[0]!.details.completionSeq, "the stable sequence identifies the retry as the same completion");
    assert.equal((await h.jobs.get(job.jobId))?.notifiedAt !== undefined, true);
    await recovered.shutdown();
  } finally {
    await h.close();
  }
});

test("reconciles a vanished running job to lost and delivers the lost completion", async () => {
  const h = await makeHarness();
  try {
    const job = await h.createRunningJob();
    const { delivery, delivered } = h.makeDelivery({
      liveTargets: async (): Promise<LiveTargets> => ({ live: new Set<string>(), labels: new Map(), serverIdentity: "1:1" }),
    });
    await delivery.refresh();

    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.details.status, "lost");
    assert.equal((await h.jobs.get(job.jobId))?.status, "lost", "the durable registry is the source of truth for the terminal state");
    assert.equal((await h.jobs.get(job.jobId))?.notifiedAt !== undefined, true);
    await delivery.shutdown();
  } finally {
    await h.close();
  }
});

test("holds a watcher only while jobs are active or undelivered, then releases it", async () => {
  const h = await makeHarness();
  try {
    const job = await h.createRunningJob();
    const { delivery, delivered } = h.makeDelivery({
      liveTargets: async (): Promise<LiveTargets> => ({ live: new Set(["$1", "%1"]), labels: new Map(), serverIdentity: "1:1" }),
    });

    await delivery.refresh();
    assert.equal(delivered.length, 0, "a live running job produces no completion event");
    assert.equal(delivery.observing, true, "the watcher is held while a job is active");
    assert.equal(h.watched.opened, 1);

    await h.jobs.transition(job.jobId, "completed");
    await delivery.refresh();
    assert.equal(delivered.length, 1);
    assert.equal(delivery.observing, false, "observation is released once nothing is active or pending");
    assert.equal(h.watched.closed, 1);
    await delivery.shutdown();
  } finally {
    await h.close();
  }
});

test("a real registry watcher wakes delivery after the child writes a terminal state", async () => {
  const h = await makeHarness();
  try {
    const job = await h.createRunningJob();
    const delivered: SubagentCompletionEvent[] = [];
    const delivery = new CompletionDelivery({
      ownerPiSessionId: "ses-parent",
      jobs: h.jobs,
      deliver: (event) => { delivered.push(event); },
      liveTargets: async (): Promise<LiveTargets> => ({ live: new Set(["$1", "%1"]), labels: new Map(), serverIdentity: "1:1" }),
      debounceMs: 0,
      pollIntervalMs: 0,
      watch: defaultCompletionWatchFactory,
    });

    await delivery.refresh(); // establishes the watcher while the job is active
    assert.equal(delivery.observing, true);

    await h.jobs.transition(job.jobId, "completed"); // the child-side durable terminal write
    await waitFor(() => delivered.length === 1, 5_000);

    assert.equal(delivered[0]!.details.jobId, job.jobId);
    assert.equal(delivered[0]!.details.status, "completed");
    await delivery.shutdown();
    assert.equal(delivery.observing, false);
  } finally {
    await h.close();
  }
});

test("the completion sink wakes an idle parent and queues as a follow-up when busy, never steering", async () => {
  const calls: Array<{ message: { customType: string; content: string; display: boolean; details: unknown }; options: { triggerTurn: boolean; deliverAs: "followUp" | "steer" | "nextTurn" } }> = [];
  const sink = createCompletionSink((message, options) => { calls.push({ message, options }); });
  const event: SubagentCompletionEvent = {
    customType: SUBAGENT_COMPLETION_CUSTOM_TYPE,
    content: "Pi subagent job-1 completed",
    display: true,
    details: { version: 1, jobId: "job-1", status: "completed", completionSeq: 3, finishedAt: "2026-01-01T00:00:00.000Z" },
  };

  await sink(event);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.message, { ...event });
  assert.deepEqual(calls[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(dispatch(calls[0]!.options, false), "turn", "an idle parent is woken into a new turn");
  assert.equal(dispatch(calls[0]!.options, true), "followUp", "a busy parent queues the completion instead of being interrupted");
});

test("a completion event is only built for a terminal job", () => {
  const running: SubagentJobV1 = {
    version: 1,
    jobId: "job-running",
    agent: "pi",
    status: "running",
    parentPiSessionId: "ses-parent",
    tmuxSessionId: "$1",
    tmuxPaneId: "%1",
    cwd: "/tmp",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  assert.throws(() => buildSubagentCompletionEvent(running), /terminal/);
});

test("the default watcher reports unavailable instead of throwing when the registry directory is missing", () => {
  const missing = path.join(os.tmpdir(), `pi-completion-missing-${randomUUID()}`, "jobs.json");
  assert.equal(defaultCompletionWatchFactory(missing, () => undefined), undefined);
});

test("the extension wires parent-side delivery to sendMessage on session_start", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-completion-ext-"));
  const previousJobs = process.env.PI_TMUX_SUBAGENT_JOBS;
  const previousRegistry = process.env.PI_TMUX_REGISTRY;
  process.env.PI_TMUX_SUBAGENT_JOBS = path.join(dir, "jobs.json");
  process.env.PI_TMUX_REGISTRY = path.join(dir, "registry.json");
  try {
    // A child settled while this parent was offline.
    const jobs = new SubagentJobRegistry(process.env.PI_TMUX_SUBAGENT_JOBS);
    const job = await jobs.create({ cwd: dir, parentPiSessionId: "ses-owner" });
    await jobs.bind(job.jobId, { tmuxSessionId: "$1", tmuxPaneId: "%1", serverIdentity: "1:1" });
    await jobs.transition(job.jobId, "starting");
    await jobs.transition(job.jobId, "running");
    await jobs.transition(job.jobId, "completed");

    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
    const sent: Array<{ message: { customType: string }; options: unknown }> = [];
    const pi = {
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => undefined;
      },
      registerTool: () => undefined,
      registerCommand: () => undefined,
      sendMessage: (message: { customType: string }, options: unknown) => { sent.push({ message, options }); },
    } as unknown as ExtensionAPI;
    const ctx = {
      mode: "print",
      hasUI: false,
      sessionManager: { getSessionId: () => "ses-owner" },
      ui: { setWidget: () => undefined, notify: () => undefined },
    } as unknown as ExtensionContext;

    tmuxControlExtension(pi);
    for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
    await waitFor(() => sent.length === 1, 2_000);

    assert.equal(sent[0]!.message.customType, SUBAGENT_COMPLETION_CUSTOM_TYPE);
    assert.deepEqual(sent[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
    await waitForAsync(async () => (await jobs.get(job.jobId))?.notifiedAt !== undefined, 2_000);

    for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, ctx);
  } finally {
    if (previousJobs === undefined) delete process.env.PI_TMUX_SUBAGENT_JOBS;
    else process.env.PI_TMUX_SUBAGENT_JOBS = previousJobs;
    if (previousRegistry === undefined) delete process.env.PI_TMUX_REGISTRY;
    else process.env.PI_TMUX_REGISTRY = previousRegistry;
    await rm(dir, { recursive: true, force: true });
  }
});
