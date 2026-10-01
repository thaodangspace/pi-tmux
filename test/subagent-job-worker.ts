import { SubagentJobRegistry } from "../src/subagent-jobs.ts";

/**
 * Cross-process helper for the concurrency test. Each process drives complete
 * lifecycles through the shared registry file, so lost updates show up as a
 * missing job or a job stuck before `completed`.
 */
const [file, workerRaw, countRaw] = process.argv.slice(2);
if (!file || !workerRaw || !countRaw) throw new Error("usage: subagent-job-worker <file> <worker> <count>");

const worker = Number(workerRaw);
const count = Number(countRaw);
const registry = new SubagentJobRegistry(file);
const ids: string[] = [];

for (let index = 0; index < count; index++) {
  const job = await registry.create({ cwd: "/work", parentPiSessionId: null });
  await registry.bind(job.jobId, {
    tmuxSessionId: `$${worker + 1}`,
    tmuxPaneId: `%${(worker + 1) * 100_000 + index + 1}`,
    serverIdentity: "1:1",
  });
  await registry.transition(job.jobId, "starting");
  await registry.transition(job.jobId, "running");
  await registry.transition(job.jobId, "completed", { exitCode: 0 });
  ids.push(job.jobId);
}

process.stdout.write(JSON.stringify(ids));
