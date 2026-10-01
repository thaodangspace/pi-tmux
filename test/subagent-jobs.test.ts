import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SubagentJobRegistry, defaultSubagentJobsPath, isTerminalStatus } from "../src/subagent-jobs.ts";
import { TmuxError } from "../src/tmux.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tsxAvailable = existsSync(path.join(repoRoot, "node_modules", "tsx", "package.json"));

async function withRegistry(
  run: (registry: SubagentJobRegistry, file: string, directory: string) => Promise<void>,
  relative = path.join("nested", "subagent-jobs.json"),
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-tmux-jobs-"));
  try {
    const file = path.join(directory, relative);
    await run(new SubagentJobRegistry(file), file, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Creates a job and drives it to `status`, binding a fresh target first. */
async function jobAt(registry: SubagentJobRegistry, status: string, options: { session?: string; pane?: string; serverIdentity?: string; parent?: string | null } = {}): Promise<string> {
  const job = await registry.create({ cwd: "/work", parentPiSessionId: options.parent ?? null });
  if (status === "created") return job.jobId;
  await registry.bind(job.jobId, {
    tmuxSessionId: options.session ?? "$1",
    tmuxPaneId: options.pane ?? `%${Math.floor(Math.random() * 1_000_000) + 1}`,
    ...(options.serverIdentity ? { serverIdentity: options.serverIdentity } : {}),
  });
  await registry.transition(job.jobId, "starting");
  if (status === "starting") return job.jobId;
  await registry.transition(job.jobId, "running");
  if (status === "running") return job.jobId;
  await registry.transition(job.jobId, status as "completed" | "failed" | "cancelled" | "lost");
  return job.jobId;
}

test("default jobs path honours PI_TMUX_SUBAGENT_JOBS and XDG_STATE_HOME with a documented fallback", () => {
  assert.equal(defaultSubagentJobsPath({ PI_TMUX_SUBAGENT_JOBS: "/custom/jobs.json", XDG_STATE_HOME: "/state" } as NodeJS.ProcessEnv), "/custom/jobs.json");
  assert.equal(defaultSubagentJobsPath({ XDG_STATE_HOME: "/state" } as NodeJS.ProcessEnv), path.join("/state", "pi-tmux", "subagent-jobs.json"));
  assert.equal(defaultSubagentJobsPath({} as NodeJS.ProcessEnv), path.join(os.homedir(), ".local", "state", "pi-tmux", "subagent-jobs.json"));
});

test("jobs follow the legal lifecycle and creation is allowed without a tmux target", async () => {
  await withRegistry(async (registry) => {
    assert.deepEqual(await registry.list(), []);
    const job = await registry.create({ cwd: "/work", parentPiSessionId: "pi-parent" });
    assert.match(job.jobId, /^[0-9a-f-]{36}$/);
    assert.equal(job.agent, "pi");
    assert.equal(job.version, 1);
    assert.equal(job.status, "created");
    assert.equal(job.tmuxSessionId, null);
    assert.equal(job.tmuxPaneId, null);
    assert.deepEqual(await registry.get(job.jobId), job);

    // A bound target is required before starting/running, and the rejection must not persist.
    await assert.rejects(() => registry.transition(job.jobId, "starting"), /must be bound/);
    assert.equal((await registry.get(job.jobId))!.status, "created");
    await assert.rejects(() => registry.transition(job.jobId, "running"), /Illegal transition/);

    await registry.bind(job.jobId, { tmuxSessionId: "$1", tmuxPaneId: "%1", serverIdentity: "100:5" });
    await registry.bind(job.jobId, { tmuxSessionId: "$1", tmuxPaneId: "%1" }); // idempotent repeat
    await assert.rejects(() => registry.bind(job.jobId, { tmuxSessionId: "$1", tmuxPaneId: "%2" }), /already bound/);
    await assert.rejects(() => registry.bind(job.jobId, { tmuxSessionId: "named-session", tmuxPaneId: "%9" }), /stable tmux ID/);
    await assert.rejects(() => registry.bind(job.jobId, { tmuxSessionId: "$9", tmuxPaneId: "pane-name" }), /stable tmux ID/);

    const starting = await registry.transition(job.jobId, "starting");
    assert.equal(starting.status, "starting");
    assert.ok(starting.startedAt);
    const running = await registry.transition(job.jobId, "running");
    assert.equal(running.status, "running");
    assert.deepEqual(await registry.transition(job.jobId, "running"), running, "duplicate non-terminal transitions are idempotent");
    await assert.rejects(() => registry.transition(job.jobId, "created"), /Illegal transition/);

    const completed = await registry.transition(job.jobId, "completed", { exitCode: 0, resultPath: "/work/out.txt" });
    assert.equal(completed.status, "completed");
    assert.equal(completed.exitCode, 0);
    assert.equal(completed.resultPath, "/work/out.txt");
    assert.equal(completed.completionSeq, 1);
    assert.ok(completed.finishedAt);
  });
});

test("terminal outcomes are immutable and duplicate terminal transitions are idempotent", async () => {
  await withRegistry(async (registry) => {
    const jobId = await jobAt(registry, "completed");
    const completed = (await registry.get(jobId))!;
    assert.equal(isTerminalStatus(completed.status), true);

    await assert.rejects(() => registry.transition(jobId, "failed"), /immutable/);
    await assert.rejects(() => registry.transition(jobId, "running"), /immutable/);
    await assert.rejects(() => registry.transition(jobId, "lost"), /immutable/);
    assert.deepEqual(await registry.transition(jobId, "completed"), completed, "a duplicate terminal transition is a no-op");
    assert.equal((await registry.get(jobId))!.status, "completed");

    // Failure, cancellation, and loss are all valid terminal outcomes from any non-terminal state.
    const cancelled = await registry.create({ cwd: "/work", parentPiSessionId: null });
    assert.deepEqual(await registry.transition(cancelled.jobId, "cancelled"), await registry.transition(cancelled.jobId, "cancelled"));
    await assert.rejects(() => registry.transition(cancelled.jobId, "lost"), /immutable/);

    const failed = await jobAt(registry, "failed");
    assert.equal((await registry.get(failed))!.status, "failed");
    const lost = await jobAt(registry, "lost");
    assert.equal((await registry.get(lost))!.status, "lost");
  });
});

test("a running job and a terminal outcome survive registry re-instantiation", async () => {
  await withRegistry(async (registry, file) => {
    const running = await jobAt(registry, "running");
    const completed = await jobAt(registry, "completed");

    const restarted = new SubagentJobRegistry(file);
    assert.equal((await restarted.get(running))!.status, "running");
    assert.equal((await restarted.get(running))!.tmuxPaneId, (await registry.get(running))!.tmuxPaneId);
    assert.equal((await restarted.get(completed))!.status, "completed");
    assert.ok((await restarted.get(completed))!.completionSeq);

    await restarted.transition(running, "completed", { exitCode: 0 });
    const restartedAgain = new SubagentJobRegistry(file);
    assert.equal((await restartedAgain.get(running))!.status, "completed");
    assert.deepEqual(await restartedAgain.list({ status: ["created", "starting", "running"] }), []);
    assert.deepEqual(await restartedAgain.list({ status: "completed" }).then((jobs) => jobs.map((job) => job.jobId).sort()), [running, completed].sort());
  });
});

test("corrupt or unrecognized state is reported and never overwritten", async () => {
  await withRegistry(async (registry) => {
    await mkdir(path.dirname(registry.file), { recursive: true });
    const cases = [
      "{ not json",
      JSON.stringify({ version: 2, nextCompletionSeq: 1, jobs: [] }),
      JSON.stringify({ version: 1, jobs: [] }),
      JSON.stringify({ version: 1, nextCompletionSeq: 1, jobs: [{ jobId: "only-an-id" }] }),
      JSON.stringify({ version: 1, nextCompletionSeq: 1, jobs: [{ version: 1, jobId: "dup", agent: "pi", status: "created", parentPiSessionId: null, tmuxSessionId: null, tmuxPaneId: null, cwd: "/w", createdAt: new Date(0).toISOString() }, { version: 1, jobId: "dup", agent: "pi", status: "created", parentPiSessionId: null, tmuxSessionId: null, tmuxPaneId: null, cwd: "/w", createdAt: new Date(0).toISOString() }] }),
    ];
    for (const content of cases) {
      await writeFile(registry.file, content, "utf8");
      await assert.rejects(() => registry.list(), (error: unknown) => error instanceof TmuxError);
      await assert.rejects(() => registry.create({ cwd: "/work", parentPiSessionId: null }), (error: unknown) => error instanceof TmuxError);
      assert.equal(await readFile(registry.file, "utf8"), content, "the original file must survive untouched");
    }
  });
});

test("the state file is owner-only and atomic writes clean up after a failure", { skip: process.getuid?.() === 0 ? "running as root bypasses directory permissions" : false }, async () => {
  await withRegistry(async (registry, file, directory) => {
    await registry.create({ cwd: "/work", parentPiSessionId: null });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, "nested"))).mode & 0o777, 0o700);

    const before = await readFile(file, "utf8");
    const parent = path.dirname(file);
    await chmod(parent, 0o500);
    try {
      await assert.rejects(() => registry.create({ cwd: "/work", parentPiSessionId: null }), (error: unknown) => error instanceof TmuxError);
      assert.equal(await readFile(file, "utf8"), before, "a failed write must not clobber the previous state");
    } finally {
      await chmod(parent, 0o700);
    }
    assert.deepEqual((await readdir(parent)).filter((name) => name.endsWith(".tmp")), [], "temporary files are cleaned up");
  });
});

test("retention keeps active and undelivered jobs and caps acknowledged history", async () => {
  await withRegistry(async (registry) => {
    const bounded = new SubagentJobRegistry(registry.file, { maxAcknowledged: 2, maxJobs: 10 });
    const delivered: string[] = [];
    for (let index = 0; index < 3; index++) {
      const job = await bounded.create({ cwd: "/work", parentPiSessionId: null });
      await bounded.transition(job.jobId, "cancelled");
      await bounded.markNotified(job.jobId);
      delivered.push(job.jobId);
    }
    // Oldest acknowledged history is evicted; the newest two remain.
    assert.deepEqual((await bounded.list()).map((job) => job.jobId).sort(), delivered.slice(1).sort());

    const active = await bounded.create({ cwd: "/work", parentPiSessionId: null });
    const undelivered = await bounded.create({ cwd: "/work", parentPiSessionId: null });
    await bounded.transition(undelivered.jobId, "cancelled");
    const jobs = await bounded.list();
    assert.equal(jobs.length, 4, "active and undelivered jobs are never evicted");
    assert.ok(jobs.some((job) => job.jobId === active.jobId));
    assert.deepEqual((await bounded.pendingDeliveries()).map((job) => job.jobId), [undelivered.jobId]);
  });
});

test("the hard bound rejects new jobs without evicting live data", async () => {
  await withRegistry(async (registry) => {
    const bounded = new SubagentJobRegistry(registry.file, { maxAcknowledged: 1, maxJobs: 2 });
    const first = await bounded.create({ cwd: "/work", parentPiSessionId: null });
    await bounded.create({ cwd: "/work", parentPiSessionId: null });
    await assert.rejects(() => bounded.create({ cwd: "/work", parentPiSessionId: null }), /hard bound/);
    assert.equal((await bounded.list()).length, 2);

    await bounded.transition(first.jobId, "cancelled");
    await bounded.markNotified(first.jobId);
    await assert.rejects(() => bounded.create({ cwd: "/work", parentPiSessionId: null }), /hard bound/);
    assert.equal((await bounded.list()).length, 2, "the previous state is intact after a rejected create");
  });
});

test("binding guards against reusing a live tmux pane ID", async () => {
  await withRegistry(async (registry) => {
    const first = await registry.create({ cwd: "/work", parentPiSessionId: null });
    await registry.bind(first.jobId, { tmuxSessionId: "$1", tmuxPaneId: "%1" });
    const second = await registry.create({ cwd: "/work", parentPiSessionId: null });
    await assert.rejects(() => registry.bind(second.jobId, { tmuxSessionId: "$2", tmuxPaneId: "%1" }), /already bound to active job/);
    // Once the first job is terminal its pane ID may be reused (the old pane is gone).
    await registry.transition(first.jobId, "cancelled");
    const bound = await registry.bind(second.jobId, { tmuxSessionId: "$2", tmuxPaneId: "%1" });
    assert.equal(bound.tmuxPaneId, "%1");
  });
});

test("delivery bookkeeping is ordered, idempotent, and terminal-only", async () => {
  await withRegistry(async (registry) => {
    const first = await jobAt(registry, "cancelled");
    const second = await jobAt(registry, "failed");
    const active = await registry.create({ cwd: "/work", parentPiSessionId: null });

    const pending = await registry.pendingDeliveries();
    assert.deepEqual(pending.map((job) => job.jobId), [first, second]);
    assert.ok(pending[0]!.completionSeq! < pending[1]!.completionSeq!);
    await assert.rejects(() => registry.markNotified(active.jobId), /terminal/);

    const notified = await registry.markNotified(first);
    assert.ok(notified.notifiedAt);
    assert.deepEqual(await registry.markNotified(first), notified, "marking twice is idempotent");
    assert.deepEqual((await registry.pendingDeliveries()).map((job) => job.jobId), [second]);

    assert.equal(await registry.get("missing-job"), undefined);
    await assert.rejects(() => registry.transition("missing-job", "cancelled"), /Unknown subagent job/);
  });
});

test("reconcile marks missing or foreign targets lost and leaves terminal jobs alone", async () => {
  await withRegistry(async (registry) => {
    const live = await jobAt(registry, "running", { session: "$1", pane: "%1", serverIdentity: "1:1" });
    const gone = await jobAt(registry, "running", { session: "$2", pane: "%2", serverIdentity: "1:1" });
    const foreign = await jobAt(registry, "running", { session: "$3", pane: "%3", serverIdentity: "2:2" });
    const terminal = await jobAt(registry, "completed", { session: "$4", pane: "%4", serverIdentity: "1:1" });
    await registry.markNotified(terminal); // Terminal but already delivered: still never revisited.

    const lost = await registry.reconcile({ live: new Set(["$1", "%1", "$3"]), serverIdentity: "1:1" });
    assert.deepEqual(lost.map((job) => job.jobId).sort(), [gone, foreign].sort());
    for (const job of lost) {
      assert.equal(job.status, "lost");
      assert.ok(job.finishedAt);
      assert.ok(job.completionSeq);
    }
    assert.equal((await registry.get(live))!.status, "running", "a live target is untouched");
    assert.equal((await registry.get(terminal))!.status, "completed", "terminal jobs are never revisited");
    assert.deepEqual((await registry.pendingDeliveries()).map((job) => job.jobId).sort(), [gone, foreign].sort());
    assert.deepEqual(await registry.reconcile({ live: new Set(["$1", "%1"]) }), [], "second reconcile is a no-op");
  });
});

test("a no-op reconcile does not rewrite the registry file", async () => {
  await withRegistry(async (registry, file) => {
    await jobAt(registry, "running", { session: "$1", pane: "%1", serverIdentity: "1:1" });
    const before = await stat(file);
    assert.deepEqual(await registry.reconcile({ live: new Set(["$1", "%1"]), serverIdentity: "1:1" }), []);
    const after = await stat(file);
    // Every write replaces the file by atomic rename, so a changed inode is a
    // write; a no-op reconcile must leave the file (and any watcher) alone.
    assert.equal(after.ino, before.ino, "a no-op reconcile must not rename the registry file");
    assert.equal(after.mtimeMs, before.mtimeMs, "a no-op reconcile must not write the registry file");
  });
});

test("reconcile can be scoped to one parent and never mutates another parent's job", async () => {
  await withRegistry(async (registry) => {
    const mine = await jobAt(registry, "running", { session: "$1", pane: "%1", serverIdentity: "1:1", parent: "pi-a" });
    const theirs = await jobAt(registry, "running", { session: "$2", pane: "%2", serverIdentity: "1:1", parent: "pi-b" });

    const lost = await registry.reconcile({ live: new Set<string>(), serverIdentity: "1:1" }, { parentPiSessionId: "pi-a" });
    assert.deepEqual(lost.map((job) => job.jobId), [mine]);
    assert.equal((await registry.get(mine))!.status, "lost");
    assert.equal((await registry.get(theirs))!.status, "running", "another parent's job is never reconciled");
    assert.equal((await registry.get(theirs))!.finishedAt, undefined);

    await assert.rejects(() => registry.reconcile({ live: new Set<string>() }, { parentPiSessionId: "" }), /non-empty string/);
  });
});

test("two registry instances sharing a file serialize read-modify-write", async () => {
  await withRegistry(async (registry, file) => {
    const a = new SubagentJobRegistry(file, { lockRetryMs: 1 });
    const b = new SubagentJobRegistry(file, { lockRetryMs: 1 });
    const created = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? a : b).create({ cwd: "/work", parentPiSessionId: null })));
    assert.equal(new Set(created.map((job) => job.jobId)).size, 12, "every concurrent create is persisted");
    assert.equal((await a.list()).length, 12);
    assert.equal((await registry.list()).length, 12);
  });
});

test("a lock owned by a dead process is reclaimed exactly once", async () => {
  await withRegistry(async (registry, file) => {
    await mkdir(path.dirname(file), { recursive: true });
    const deadPid = await deadProcessPid();
    await writeFile(`${file}.lock`, JSON.stringify({ pid: deadPid, token: "dead", acquiredAt: new Date().toISOString() }));
    assert.ok((await registry.create({ cwd: "/work", parentPiSessionId: null })).jobId, "a dead owner's lock is reclaimed");
    await assert.rejects(() => readFile(`${file}.lock`, "utf8"), /ENOENT/);
    await assert.rejects(() => readFile(`${file}.lock.break`, "utf8"), /ENOENT/, "the breaker is released");
  });
});

test("a lock held by a live owner is never stolen, even when old", async () => {
  await withRegistry(async (registry, file) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.lock`, JSON.stringify({ pid: process.pid, token: "live", acquiredAt: new Date(0).toISOString() }));
    await utimes(`${file}.lock`, 0, 0);
    const bounded = new SubagentJobRegistry(file, { lockTimeoutMs: 150, lockRetryMs: 10 });
    await assert.rejects(() => bounded.create({ cwd: "/work", parentPiSessionId: null }), /Timed out|lock/);
    assert.equal(JSON.parse(await readFile(`${file}.lock`, "utf8")).token, "live", "the live owner's lock is untouched");
    await rm(`${file}.lock`, { force: true });
    assert.ok((await registry.create({ cwd: "/work", parentPiSessionId: null })).jobId);
  });
});

test("a held breaker is respected rather than stolen, so recovery cannot run concurrently", async () => {
  await withRegistry(async (registry, file) => {
    await mkdir(path.dirname(file), { recursive: true });
    const deadPid = await deadProcessPid();
    // A stale main lock plus a breaker whose owner also died is the ambiguous
    // case: fail closed instead of risking two concurrent removers.
    await writeFile(`${file}.lock`, JSON.stringify({ pid: deadPid, token: "dead", acquiredAt: new Date().toISOString() }));
    await writeFile(`${file}.lock.break`, JSON.stringify({ pid: deadPid, token: "dead-breaker", acquiredAt: new Date().toISOString() }));
    const bounded = new SubagentJobRegistry(file, { lockTimeoutMs: 150, lockRetryMs: 10 });
    await assert.rejects(() => bounded.create({ cwd: "/work", parentPiSessionId: null }), /Timed out|lock/);
    assert.equal(JSON.parse(await readFile(`${file}.lock`, "utf8")).token, "dead", "the stale main lock is left for manual recovery");
    assert.equal(JSON.parse(await readFile(`${file}.lock.break`, "utf8")).token, "dead-breaker");
  });
});

test("concurrent contenders safely break one stale lock without losing updates", async () => {
  await withRegistry(async (registry, file) => {
    await mkdir(path.dirname(file), { recursive: true });
    const deadPid = await deadProcessPid();
    await writeFile(`${file}.lock`, JSON.stringify({ pid: deadPid, token: "dead", acquiredAt: new Date().toISOString() }));
    const instances = Array.from({ length: 8 }, () => new SubagentJobRegistry(file, { lockRetryMs: 1 }));
    const created = await Promise.all(instances.map((instance) => instance.create({ cwd: "/work", parentPiSessionId: null })));
    assert.equal(new Set(created.map((job) => job.jobId)).size, instances.length);
    assert.equal((await registry.list()).length, instances.length, "no update was lost while breaking the stale lock");
    await assert.rejects(() => readFile(`${file}.lock`, "utf8"), /ENOENT/);
  });
});

test("concurrent processes cannot clobber each other's updates", { skip: tsxAvailable ? false : "tsx is not installed" }, async () => {
  await withRegistry(async (registry, file) => {
    const workers = 3;
    const perWorker = 8;
    const workerPath = path.join(import.meta.dirname, "subagent-job-worker.ts");
    const results = await Promise.all(Array.from({ length: workers }, (_, worker) => runWorker(workerPath, file, worker, perWorker)));
    const ids = results.flat();
    assert.equal(new Set(ids).size, workers * perWorker);
    const jobs = await registry.list();
    assert.equal(jobs.length, workers * perWorker, "no create was lost to a concurrent write");
    assert.equal(jobs.filter((job) => job.status === "completed").length, jobs.length, "every lifecycle finished");
    assert.equal(new Set(jobs.map((job) => job.jobId)).size, jobs.length);
  });
});

test("concurrent processes safely break one stale lock without losing updates", { skip: tsxAvailable ? false : "tsx is not installed" }, async () => {
  await withRegistry(async (registry, file) => {
    await mkdir(path.dirname(file), { recursive: true });
    const workerPath = path.join(import.meta.dirname, "subagent-job-worker.ts");
    const workers = 6;
    const perWorker = 3;
    let expected = 0;
    for (let round = 0; round < 2; round++) {
      const deadPid = await deadProcessPid();
      await writeFile(`${file}.lock`, JSON.stringify({ pid: deadPid, token: `dead-${round}`, acquiredAt: new Date().toISOString() }));
      const results = await Promise.all(Array.from({ length: workers }, (_, worker) => runWorker(workerPath, file, round * workers + worker, perWorker)));
      expected += workers * perWorker;
      assert.equal(new Set(results.flat()).size, workers * perWorker);
      assert.equal((await registry.list()).length, expected, `round ${round}: no update was lost while breaking the stale lock across processes`);
    }
  });
});

async function deadProcessPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  const pid = child.pid!;
  await once(child, "exit");
  return pid;
}

function runWorker(workerPath: string, file: string, worker: number, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, file, String(worker), String(count)], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`worker ${worker} exited ${code}: ${stderr || stdout}`));
        return;
      }
      try { resolve(JSON.parse(stdout) as string[]); } catch (error) { reject(new Error(`worker ${worker} returned invalid JSON: ${String(error)}`)); }
    });
  });
}
