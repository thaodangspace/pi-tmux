import { SubagentSessionRegistry } from "../src/subagent-sessions.ts";

/**
 * Cross-process helper for the session/turn concurrency test. Each process
 * drives complete session lifecycles through the shared registry file, so lost
 * updates show up as a missing session, a missing turn, or a turn stuck before
 * `completed`.
 */
const [file, workerRaw, countRaw] = process.argv.slice(2);
if (!file || !workerRaw || !countRaw) throw new Error("usage: subagent-session-worker <file> <worker> <count>");

const worker = Number(workerRaw);
const count = Number(countRaw);
const registry = new SubagentSessionRegistry(file);
const ids: string[] = [];

for (let index = 0; index < count; index++) {
  const ordinal = worker * count + index + 1;
  const session = await registry.createSession({ agent: "pi", cwd: "/work", parentPiSessionId: null });
  await registry.bindSession(session.sessionId, { tmuxSessionId: `$${ordinal}`, serverIdentity: "1:1" });
  const turn = await registry.createTurn(session.sessionId);
  await registry.bindTurn(turn.turnId, { tmuxPaneId: `%${ordinal}` });
  await registry.transitionTurn(turn.turnId, "starting");
  await registry.transitionTurn(turn.turnId, "running");
  await registry.transitionTurn(turn.turnId, "completed", { exitCode: 0 });
  ids.push(session.sessionId);
}

process.stdout.write(JSON.stringify(ids));
