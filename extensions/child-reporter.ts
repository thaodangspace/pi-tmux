import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHILD_REPORTER_ENV, ChildReporter } from "../src/subagent-reporter.ts";
import { TurnReporter } from "../src/turn-reporter.ts";
import { errorMessage } from "../src/tmux.ts";

/**
 * Packaged child-only completion reporter (issues #2 and #12).
 *
 * This extension is intentionally *not* in the package's auto-loaded
 * `pi.extensions` list. A parent launches a delegated Pi with it explicitly:
 *
 *   pi --extension <package>/extensions/child-reporter.ts ...args
 *
 * The mode is chosen by the launch metadata. Without `PI_TMUX_CHILD_REPORTER_MODE`
 * it reports one one-shot `SubagentJobV1`; with `=session` it reports one
 * `SubagentTurnV1` of a reusable `SubagentSessionV1`. Loaded anywhere else, it
 * fails visibly at `session_start` without mutating any record. Its only writes
 * are the durable lifecycle transition and a bounded completion payload. Outcome
 * comes from Pi's structured lifecycle events, never from pane output.
 */
export default function piTmuxChildReporter(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  const report = (label: string) => (level: "info" | "warning" | "error", message: string) => {
    // stdout is reserved for protocol output in `--mode json`/`print`.
    console.error(`[pi-tmux ${label}] ${level}: ${message}`);
    if (level !== "info") context?.ui.notify(`pi-tmux ${label}: ${message}`, level);
  };

  const sessionMode = process.env[CHILD_REPORTER_ENV.mode] === "session";
  const reporter = sessionMode
    ? new TurnReporter({ report: report("turn reporter") })
    : new ChildReporter({ report: report("child reporter") });

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
      throw error; // Reported by Pi as an extension error; no record was mutated.
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
      throw error; // Surfaces the failure; the durable record is left recoverable.
    }
  });
}
