import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CompletionDelivery, createCompletionSink } from "../src/completion-delivery.ts";
import { Registry } from "../src/registry.ts";
import { SubagentJobRegistry } from "../src/subagent-jobs.ts";
import { Targets } from "../src/targets.ts";
import { Tmux } from "../src/tmux.ts";
import { registerTmuxTools } from "../src/tools.ts";
import { registerTmuxUi } from "../src/ui.ts";

export default function tmuxControlExtension(pi: ExtensionAPI): void {
  // No subprocesses or persistent resources are started until a tool is called.
  const tmux = new Tmux();
  const registry = new Registry();
  const jobs = new SubagentJobRegistry();
  const targets = new Targets(tmux);

  // Parent-side completion delivery for delegated Pi subagents (issue #4). It is
  // created per session so it can only ever deliver this conversation's jobs,
  // and it holds a watcher only while this conversation owns an active or
  // undelivered job.
  let delivery: CompletionDelivery | undefined;

  registerTmuxTools(pi, tmux, registry, { jobs, targets });
  registerTmuxUi(pi, { tmux, registry });

  pi.on("session_start", async (_event, ctx) => {
    await detachDelivery();
    delivery = new CompletionDelivery({
      ownerPiSessionId: ctx.sessionManager.getSessionId(),
      jobs,
      liveTargets: () => targets.liveTargets(),
      deliver: createCompletionSink((message, options) => pi.sendMessage(message, options)),
      log: (level, message) => {
        if (level === "error") ctx.ui.notify(`pi-tmux: ${message}`, "error");
      },
    });
    // Recover any terminal job completed while this parent was offline; deferred
    // so a delivery that starts a turn does not run inside session startup.
    delivery.notify();
  });

  // A subagent tool may have just created, reconciled, or cancelled a job.
  pi.on("tool_result", (event) => {
    if (event.toolName.startsWith("tmux_subagent_")) delivery?.notify();
  });

  pi.on("session_shutdown", async () => {
    await detachDelivery();
  });

  async function detachDelivery(): Promise<void> {
    const current = delivery;
    delivery = undefined;
    await current?.shutdown().catch(() => undefined);
  }
}
