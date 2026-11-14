import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../core/workspace.js";
import { LiveTriggers } from "../modules/editorLive/triggers.js";
import type { MemoryDesktop } from "../modules/editorLive/memoryDesktop.js";

test("existing Wait is selected by action index and changed without adding another action", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc2-live-set-wait-")), archive = path.join(root, "Current.SC2Map");
  await fs.writeFile(archive, "map");
  const window = { windowId: "123", processId: 929811, processStart: "77", enabled: true,
    acceptsFiles: true, title: `Triggers - [${archive}] - StarCraft II Editor` };
  const left = [{ handle: "1", parent: "0", depth: 0, text: "MAIN" }, { handle: "2", parent: "1", depth: 1, text: "Start" }];
  const detail = [{ handle: "3", parent: "0", depth: 0, text: "Start" },
    { handle: "4", parent: "3", depth: 1, text: "Actions" },
    { handle: "5", parent: "4", depth: 2, text: "Existing action" },
    { handle: "6", parent: "4", depth: 2, text: "General -Wait 3.5 Game Time seconds" }];
  const params = [{ handle: "7", parent: "0", depth: 0, text: "Wait" },
    { handle: "8", parent: "7", depth: 1, text: "Time: 3.5" },
    { handle: "9", parent: "7", depth: 1, text: "Time Type: Game Time" }];
  let fingerprint = "initial", commits = 0;
  const desktop: MemoryDesktop = { windows: async () => [window], command: async (_w, op, args) => {
    if (op === 50) return { trees: [
      { id: 28, count: left.length, fingerprint: "left", truncated: false, items: left },
      { id: 134, count: detail.length, fingerprint: "42", truncated: false, items: detail },
      { id: 468, count: params.length, fingerprint: "params", truncated: false, items: params },
    ] };
    if (op === 55) return { selectionRequested: true };
    if (op === 51) { assert.equal(args?.value, "2:6:8"); return { status: "pending" }; }
    if (op === 52) return { title: "Real", fingerprint, initial: fingerprint, manualInput: false };
    if (op === 59) { fingerprint = "configured"; return { optionsSet: true }; }
    if (op === 58) { commits++; detail[3].text = "General -Wait 6.25 Game Time seconds"; return { submitted: true }; }
    throw Error("Unexpected operation " + op);
  } };
  const live = new LiveTriggers(new Workspace(root), () => undefined, desktop, () => false, async () => {});
  t.after(async () => { await live.close(); await fs.rm(root, { recursive: true, force: true }); });
  const target = { archive, windowId: "123", path: "MAIN/Start" };
  const page = await live.details({ ...target, offset: 1, limit: 1, includeDetail: false });
  assert.ok("actions" in page);
  assert.deepEqual(page.actions, [{ index: 2, text: "General -Wait 3.5 Game Time seconds", hasChildren: false }]);
  await assert.rejects(live.setWait({ ...target, actionIndex: 2, seconds: 6.25, expectedDetailHash: "41" }), /DETAIL_CHANGED/);
  await assert.rejects(live.setWait({ ...target, actionIndex: 1, seconds: 6.25, expectedDetailHash: "42" }), /NOT_LITERAL_GAME_TIME_WAIT/);
  assert.equal(commits, 0);
  const result = await live.setWait({ ...target, actionIndex: 2, seconds: 6.25, expectedDetailHash: "42" });
  assert.equal(result.status, "applied");
  assert.ok("previousSeconds" in result);
  assert.equal(result.previousSeconds, 3.5);
  assert.equal(commits, 1);
  assert.equal(detail.length, 4);
});
