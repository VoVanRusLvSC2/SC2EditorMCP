import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createTriggerMember,
  verifyTriggerMember,
  verifyMemberInsertion,
} from "../modules/editorLive/triggerMembers.js";
import type { DeclarationContext } from "../modules/editorLive/triggerDeclaration.js";
import type { MemoryDesktop } from "../modules/editorLive/memoryDesktop.js";
import { compileAuthorScript } from "../app/authoringScript.js";

const row = (h: string, p: string, d: number, text: string) => ({
  handle: h,
  parent: p,
  depth: d,
  text,
});
const original = [
  row("10", "0", 0, "Compute"),
  row("11", "10", 1, "Parameters"),
  row("12", "11", 2, "Base = 0 <Integer>"),
  row("13", "10", 1, "Grammar Text: Compute(Base)"),
  row("14", "10", 1, "Local Variables"),
  row("15", "14", 2, "Bonus = 0 <Integer>"),
  row("16", "10", 1, "Actions"),
  row("17", "16", 2, "General -Return 42"),
];
let nextPid = 988100;
async function fixture(
  t: test.TestContext,
  options: {
    lostAck?: boolean;
    lostObservation?: boolean;
    collateral?: boolean;
    manual?: boolean;
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc2-live-members-")),
    archive = path.join(root, "Current.SC2Map");
  await fs.writeFile(archive, "baseline");
  const window = {
    windowId: "1",
    processId: ++nextPid,
    processStart: "800",
    title: `Triggers - [${archive}] - StarCraft II Editor`,
    enabled: true,
    acceptsFiles: true,
  };
  let left = [row("1", "0", 0, "MAIN"), row("2", "1", 1, "Compute")],
    body = structuredClone(original),
    revision = 20,
    token = "",
    createdName = "",
    starts = 0,
    observations = 0;
  const calls: Array<{ op: number; args: any }> = [];
  const desktop = {
    windows: async () => [window],
    command: async (_w: unknown, op: number, args: any) => {
      calls.push({ op, args });
      if (op === 69 && args.field === "preflight") {
        if (options.manual) throw Error("LIVE_TRIGGER_MANUAL_INLINE_PRESERVED");
        return { ready: true };
      }
      if (op === 50) {
        const main = Number(args.unit) === 28,
          items = main ? left : body;
        return {
          tree: {
            id: main ? 28 : 154,
            count: items.length,
            total: items.length,
            offset: 0,
            fingerprint: main ? "10" : String(revision),
            truncated: false,
            items,
          },
        };
      }
      if (op === 55) return { selectionRequested: true };
      if (op === 51) {
        starts++;
        token = args.token;
        createdName = args.value.split(":").slice(2).join(":");
        const parameter = args.field === "trigger.parameter",
          parent = parameter ? "11" : "14";
        const last =
          body
            .map((x, i) => (x.parent === parent ? i : -1))
            .filter((i) => i >= 0)
            .at(-1) ?? body.findIndex((x) => x.handle === parent);
        body = [
          ...body.slice(0, last + 1),
          row("99", parent, 2, createdName + " = 0 <Integer>"),
          ...body.slice(last + 1),
        ];
        if (parameter)
          body = body.map((x) =>
            x.handle === "13" ? { ...x, text: `Grammar Text: Compute(Base,${createdName})` } : x,
          );
        if (options.collateral)
          body = body.map((x) => (x.handle === "17" ? { ...x, text: "General -Return 43" } : x));
        revision++;
        if (options.lostAck) throw Error("lost command reply");
        return { status: "pending", token };
      }
      if (op === 52) {
        assert.equal(args.token, token);
        observations++;
        if (options.lostObservation && observations === 1) throw Error("lost observation reply");
        return { status: "created", nameSubmitted: true, name: createdName };
      }
      throw Error("Unexpected native operation " + op);
    },
  } satisfies MemoryDesktop;
  const c: DeclarationContext = {
    archive,
    archiveSha256: createHash("sha256").update("baseline").digest("hex"),
    window,
    desktop,
    guardArchive: async () => {},
    currentWindow: async () => window,
    pause: async () => {},
  };
  t.after(async () => {
    const directory = path.join(os.tmpdir(), "SC2EditorToolkit-live-memory", "trigger-members");
    for (const name of await fs.readdir(directory).catch(() => [])) {
      const file = path.join(directory, name),
        r = JSON.parse(await fs.readFile(file, "utf8"));
      if (r.processId === window.processId && r.archive === archive) await fs.unlink(file);
    }
    await fs.unlink(archive);
    await fs.rmdir(root);
  });
  const input = {
    archive,
    windowId: "1",
    path: "MAIN/Compute",
    kind: "parameter" as const,
    name: "Factor",
    expectedDetailHash: "20",
  };
  return {
    c,
    input,
    calls,
    counts: () => ({ starts, observations }),
    changeRoot: () => {
      left = [...left, row("3", "1", 1, "Manual addition")];
    },
  };
}

test("member creation verifies its native parameter and generated grammar without touching the archive", async (t) => {
  const f = await fixture(t),
    r = await createTriggerMember(f.c, f.input);
  assert.equal(r.status, "needs_parameters");
  assert.equal("nativeTreeVerified" in r && r.nativeTreeVerified, true);
  assert.equal(f.counts().starts, 1);
  assert.equal(await fs.readFile(f.input.archive, "utf8"), "baseline");
});
test("a local variable follows the same guarded creation workflow", async (t) => {
  const f = await fixture(t),
    r = await createTriggerMember(f.c, { ...f.input, kind: "local", name: "Result" });
  assert.equal(r.status, "needs_parameters");
  assert.equal(f.calls.find((x) => x.op === 51)?.args.field, "trigger.local");
});
test("stale detail state and duplicate local/parameter names refuse before New", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    createTriggerMember(f.c, { ...f.input, expectedDetailHash: "19" }),
    /DETAIL_CHANGED/,
  );
  await assert.rejects(createTriggerMember(f.c, { ...f.input, name: "Bonus" }), /NAME_EXISTS/);
  assert.equal(f.counts().starts, 0);
});
test("pending manual input refuses even the selection preceding New", async (t) => {
  const f = await fixture(t, { manual: true });
  await assert.rejects(createTriggerMember(f.c, f.input), /MANUAL_INLINE/);
  assert.equal(f.calls.filter((x) => x.op === 55).length, 0);
  assert.equal(f.counts().starts, 0);
});
test("a lost New reply recovers from the shared before snapshot in a new client without repeating New", async (t) => {
  const f = await fixture(t, { lostAck: true }),
    r = await createTriggerMember(f.c, f.input);
  assert.equal(r.status, "unknown");
  assert.ok("pendingId" in r && r.pendingId);
  await assert.rejects(createTriggerMember(f.c, f.input), /PENDING_VERIFY/);
  const recovered = await verifyTriggerMember(
    { ...f.c },
    { archive: f.input.archive, windowId: "1", pendingId: (r as any).pendingId },
  );
  assert.equal(recovered.status, "needs_parameters");
  assert.equal(f.counts().starts, 1);
  await assert.rejects(
    verifyTriggerMember(f.c, {
      archive: f.input.archive,
      windowId: "1",
      pendingId: (r as any).pendingId,
    }),
    /PENDING_ID/,
  );
});
test("a lost completion observation is read again using the same token", async (t) => {
  const f = await fixture(t, { lostObservation: true }),
    r = await createTriggerMember(f.c, f.input);
  assert.equal(r.status, "unknown");
  const recovered = await verifyTriggerMember(f.c, {
    archive: f.input.archive,
    windowId: "1",
    pendingId: (r as any).pendingId,
  });
  assert.equal(recovered.status, "needs_parameters");
  assert.deepEqual(f.counts(), { starts: 1, observations: 2 });
});
test("collateral action edits and later root changes retain recovery state rather than accepting the new name alone", async (t) => {
  const f = await fixture(t, { collateral: true }),
    r = await createTriggerMember(f.c, f.input);
  assert.equal(r.status, "verification_failed");
  f.changeRoot();
  const recovered = await verifyTriggerMember(f.c, {
    archive: f.input.archive,
    windowId: "1",
    pendingId: (r as any).pendingId,
  });
  assert.equal(recovered.status, "unknown");
  assert.equal(f.counts().starts, 1);
});
test("grammar verification preserves custom text and accepts recycled handles", () => {
  const before = { id: 154, fingerprint: "1", items: original };
  const after = structuredClone(original);
  after.splice(3, 0, row("99", "11", 2, "Factor = 0 <Integer>"));
  after.find((x) => x.handle === "13")!.text = "Grammar Text: Compute(Base,Factor)";
  const map = new Map(after.map((x, i) => [x.handle, String(1000 + i)]));
  const recycled = after.map((x) => ({
    ...x,
    handle: map.get(x.handle)!,
    parent: map.get(x.parent) ?? "0",
  }));
  assert.equal(
    verifyMemberInsertion(before, { ...before, items: recycled }, "11", "parameter", "Factor"),
    true,
  );
  const custom = original.map((x) =>
    x.handle === "13" ? { ...x, text: "Grammar Text: Award custom reward" } : x,
  );
  assert.equal(
    verifyMemberInsertion(
      { ...before, items: custom },
      { ...before, items: after },
      "11",
      "parameter",
      "Factor",
    ),
    false,
  );
});
test("compact authoring exposes member creation and recovery without a JSON plan", () => {
  const r = compileAuthorScript(
    "live trigger.member_create archive=A.SC2Map windowId=1 path=MAIN/Compute kind=parameter name=Base expectedDetailHash=20\nlive trigger.member_verify archive=A.SC2Map windowId=1 pendingId=12345678-1234-4234-8234-123456789abc",
    "stage",
  );
  assert.deepEqual(
    r.map((x) => x.tool),
    ["live.trigger.member_create", "live.trigger.member_verify"],
  );
});
