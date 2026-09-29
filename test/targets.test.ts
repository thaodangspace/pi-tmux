import assert from "node:assert/strict";
import test from "node:test";
import { Targets } from "../src/targets.ts";
import { Tmux, TmuxError } from "../src/tmux.ts";

class ListingTmux extends Tmux {
  constructor(private readonly outputs: Record<string, string>) { super(); }
  override async run(args: readonly string[]): Promise<string> {
    const key = args[0]!;
    if (!(key in this.outputs) || /no server running/i.test(this.outputs[key]!)) throw new TmuxError("no server running", "unavailable");
    return this.outputs[key]!;
  }
}

const sessions = "$1\twork\t0\t2\n$2\tother\t1\t1\n";
const windows = "$1\twork\t@3\t0\tmain\t1\t2\n$1\twork\t@4\t1\tmain\t0\t1\n$2\tother\t@8\t0\tmain\t1\t1\n";
const panes = "$1\twork\t@3\t0\tmain\t%5\t0\t1\t/tmp\t80\t24\n$1\twork\t@3\t0\tmain\t%6\t1\t0\t/tmp\t80\t24\n";

test("parses stable IDs and resolves only exact, unambiguous selectors", async () => {
  const targets = new Targets(new ListingTmux({ "list-sessions": sessions, "list-windows": windows, "list-panes": panes }));
  assert.deepEqual((await targets.sessions()).map((s) => s.id), ["$1", "$2"]);
  assert.equal((await targets.session("work")).id, "$1");
  assert.equal((await targets.window("work:1")).id, "@4");
  assert.equal((await targets.pane("work:main.1")).id, "%6");
  await assert.rejects(targets.window("main"), /ambiguous/);
  await assert.rejects(targets.pane("%999"), /not found/);
});

test("empty server returns empty listings while malformed output fails", async () => {
  const empty = new Targets(new ListingTmux({ "list-sessions": "no server running" }));
  assert.deepEqual(await empty.sessions(), []);
  const invalid = new Targets(new ListingTmux({ "list-sessions": "$1\tmissing-fields" }));
  await assert.rejects(invalid.sessions(), /parse tmux listing/);
});
