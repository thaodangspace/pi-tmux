import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TmuxError } from "./tmux.ts";

export async function confirmMutation(
  ctx: ExtensionContext,
  action: string,
  target: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new TmuxError("Action cancelled before confirmation.", "cancelled");
  if (!ctx.hasUI) throw new TmuxError("This action requires interactive confirmation; no confirmation UI is available.", "cancelled");

  let approved: boolean;
  try {
    approved = await ctx.ui.confirm(
      `Confirm tmux ${action}`,
      `Allow ${action} for ${target}? This may execute input in, or permanently destroy, the selected tmux target.`,
      { signal, timeout: 30_000 },
    );
  } catch (error) {
    if (signal?.aborted) throw new TmuxError("Action cancelled during confirmation.", "cancelled");
    throw new TmuxError(`Confirmation failed; no tmux action was taken: ${error instanceof Error ? error.message : String(error)}`, "cancelled");
  }
  if (signal?.aborted) throw new TmuxError("Action cancelled during confirmation.", "cancelled");
  if (!approved) throw new TmuxError("Action was not approved; no tmux action was taken.", "cancelled");
}
