import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ChildReporter } from "../src/subagent-reporter.ts";
import { errorMessage } from "../src/tmux.ts";

/**
 * Packaged child-only Pi completion reporter (issue #2).
 *
 * This extension is intentionally *not* in the package's auto-loaded
 * `pi.extensions` list. A parent launches a delegated Pi with it explicitly:
 *
 *   pi --extension <package>/extensions/child-reporter.ts ...args
 *
 * and sets the documented `PI_TMUX_SUBAGENT_*` environment. Loaded anywhere
 * else, it fails visibly at `session_start` without mutating any job. It never
 * starts a child, notifies a parent, touches GitHub, or kills a tmux session;
 * its only writes are the job lifecycle in the durable registry and a bounded
 * completion payload. Outcome comes from Pi's structured lifecycle events, never
 * from pane output.
 */
export default function piTmuxChildReporter(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;

  const reporter = new ChildReporter({
    report: (level, message) => {
      // stdout is reserved for protocol output in `--mode json`/`print`.
      console.error(`[pi-tmux child reporter] ${level}: ${message}`);
      if (level !== "info") context?.ui.notify(`pi-tmux child reporter: ${message}`, level);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    try {
      await reporter.attach({
        childSessionId: ctx.sessionManager.getSessionId(),
        tmuxPaneId: process.env.TMUX_PANE,
      });
    } catch (error) {
      const message = errorMessage(error);
      ctx.ui.notify(`pi-tmux child reporter failed to start: ${message}`, "error");
      throw error; // Reported by Pi as an extension error; no job was mutated.
    }
  });

  // Structured lifecycle signal: Pi's recorded outcome for the last turn.
  pi.on("turn_end", (event) => {
    reporter.observeOutcome(event.outcome);
  });
  // Final actionable boundary; carries the authoritative pre-settle outcome.
  pi.on("agent_before_settle", (event) => {
    reporter.observeOutcome(event.outcome);
  });
  // Structured error text / final assistant message, bounded before it is stored.
  pi.on("agent_end", (event) => {
    reporter.observeAgentEnd(event.messages);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    context = ctx;
    try {
      await reporter.settle();
    } catch (error) {
      const message = errorMessage(error);
      ctx.ui.notify(`pi-tmux child reporter failed to persist completion: ${message}`, "error");
      throw error; // Surfaces the failure; the durable job is left recoverable.
    }
  });
}
