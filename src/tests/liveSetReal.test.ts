import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../core/workspace.js";
import { LiveTriggers } from "../modules/editorLive/triggers.js";
import { editLiteralNumber } from "../modules/editorLive/triggerNumber.js";
import type { MemoryDesktop } from "../modules/editorLive/memoryDesktop.js";

test("live Real parameters use guarded selection and verify the whole parameter tree", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc2-live-real-")), archive = path.join(root, "Current.SC2Map");
  await fs.writeFile(archive, "map");
  const window = { windowId: "123", processId: 929812, processStart: "77", enabled: true,
    acceptsFiles: true, title: `Triggers - [${archive}] - StarCraft II Editor` };
  const left = [{ handle: "1", parent: "0", depth: 0, text: "MAIN" }, { handle: "2", parent: "1", depth: 1, text: "Start" }];
  const detail = [{ handle: "3", parent: "0", depth: 0, text: "Start" },
    { handle: "4", parent: "3", depth: 1, text: "Actions" },
    { handle: "5", parent: "4", depth: 2, text: "Set global time scale to 1.0" }];
  let changed = false, commits = 0, fingerprint = "initial";
  const desktop: MemoryDesktop = { windows: async () => [window], command: async (_w, op, args) => {
    if (op === 50) {
      const params = changed ? [{ handle: "17", parent: "0", depth: 0, text: "Set Global Time Scale" },
        { handle: "18", parent: "17", depth: 1, text: "Time Scale: 2.5" }] :
        [{ handle: "7", parent: "0", depth: 0, text: "Set Global Time Scale" },
          { handle: "8", parent: "7", depth: 1, text: "Time Scale: 1.0" }];
      return { trees: [{ id: 28, count: left.length, fingerprint: "11", truncated: false, items: left },
        { id: 134, count: detail.length, fingerprint: "42", truncated: false, items: detail },
        { id: 468, count: params.length, fingerprint: changed ? "44" : "43", truncated: false, items: params }] };
    }
    if (op === 55) return { selectionRequested: true };
    if (op === 51) { assert.equal(args?.value, "2:5:8"); return { status: "pending" }; }
    if (op === 52) return { title: "Real", fingerprint, initial: fingerprint, manualInput: false };
    if (op === 59) { assert.equal(args?.value, "2.5"); fingerprint = "configured"; return { optionsSet: true }; }
    if (op === 58) { commits++; changed = true; detail[2].text = "Set global time scale to 2.5"; return { submitted: true }; }
    throw Error("Unexpected operation " + op);
  } };
  const live = new LiveTriggers(new Workspace(root), () => undefined, desktop, () => false, async () => {});
  t.after(async () => { await live.close(); await fs.rm(root, { recursive: true, force: true }); });
  const target = { archive, windowId: "123", path: "MAIN/Start", section: "actions" as const, itemIndex: 1, expectedDetailHash: "42" };
  const p = await live.parameters(target);
  assert.deepEqual(p.parameters, [{ index: 1, text: "Time Scale: 1.0", hasChildren: false }]);
  await assert.rejects(live.setReal({ ...target, parameterIndex: 1, expectedParameterHash: "99", value: 2.5 }), /PARAMETER_CHANGED/);
  assert.equal(commits, 0);
  const result = await live.setReal({ ...target, parameterIndex: 1, expectedParameterHash: p.parameterFingerprint, value: 2.5 });
  assert.equal(result.status, "applied");
  assert.equal(result.parameterVerified, true);
  assert.equal(commits, 1);
});

test("a non-Real dialog is cancelled without modifying the parameter", async () => {
  const window = { windowId: "123", processId: 1, processStart: "1", enabled: true, acceptsFiles: true, title: "Triggers" };
  let cancelled = 0;
  const desktop: MemoryDesktop = { windows: async () => [window], command: async (_w, op) => {
    if (op === 55) return { selectionRequested: true };
    if (op === 51) return { status: "pending" };
    if (op === 52) return { title: "Integer", fingerprint: "1", initial: "1", manualInput: false };
    if (op === 54) { cancelled++; return {}; }
    throw Error("Unexpected mutation " + op);
  } };
  const result = await editLiteralNumber({ desktop, window, triggerHandle: "1", itemHandle: "2", parameterHandle: "3",
    leftHash: "1", detailHash: "2", parameterHash: "3", field: "real", value: 1,
    guardArchive: async () => {}, pause: async () => {} });
  assert.equal(result.status, "stopped");
  assert.equal(cancelled, 1);
});

test("Integer is configured only through an Integer value dialog", async () => {
  const window = { windowId: "124", processId: 2, processStart: "1", enabled: true, acceptsFiles: true, title: "Triggers" };
  let configured = false, submitted = false;
  const desktop: MemoryDesktop = { windows: async () => [window], command: async (_w, op, args) => {
    if (op === 55) return { selectionRequested: true };
    if (op === 51) return { status: "pending" };
    if (op === 52) return { title: "Integer", fingerprint: "1", initial: "1", manualInput: false };
    if (op === 59) { assert.equal(args?.field, "integer"); assert.equal(args?.value, "12"); configured = true; return { optionsSet: true }; }
    if (op === 58) { assert.ok(configured); submitted = true; return { submitted: true }; }
    throw Error("Unexpected operation " + op);
  } };
  const result = await editLiteralNumber({ desktop, window, triggerHandle: "1", itemHandle: "2", parameterHandle: "3",
    leftHash: "1", detailHash: "2", parameterHash: "3", field: "integer", value: 12,
    guardArchive: async () => {}, pause: async () => {} });
  assert.equal(result.status, "submitted");
  assert.equal(submitted, true);
});
