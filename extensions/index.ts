import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Registry } from "../src/registry.ts";
import { Tmux } from "../src/tmux.ts";
import { registerTmuxTools } from "../src/tools.ts";
import { registerTmuxUi } from "../src/ui.ts";

export default function tmuxControlExtension(pi: ExtensionAPI): void {
  // No subprocesses or persistent resources are started until a tool is called.
  const tmux = new Tmux();
  const registry = new Registry();
  registerTmuxTools(pi, tmux, registry);
  registerTmuxUi(pi, { tmux, registry });
}
