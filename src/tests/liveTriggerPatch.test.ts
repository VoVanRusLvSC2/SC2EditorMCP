import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compileTriggerPatch,
  LiveTriggerPatches,
  observeAcknowledgedInsertion,
} from "../modules/editorLive/triggerPatch.js";
import type { LiveTriggers } from "../modules/editorLive/triggers.js";
import { withEditorLease, withEditorSequenceLease } from "../modules/editorLive/editorLease.js";
import { compileAuthorScript } from "../app/authoringScript.js";

const base = { archive: "Current.SC2Map", windowId: "1", path: "MAIN/Start" };
test("compact patch preflights all native schemas, aliases and future owners", () => {
  const p = compileTriggerPatch({
    ...base,
    script:
      "append_action action=wait seconds=1 as=Pause\nset_wait actionIndex=@Pause seconds=2\nbind itemIndex=last parameterIndex=1 source=value value=42 groupPath=3/2",
  });
  assert.equal(p.steps.length, 3);
  assert.equal(p.steps[1].indexRef?.name, "Pause");
  assert.deepEqual(p.steps[2].args.groupPath, [3, 2]);
  assert.equal(p.steps[2].args.section, "actions");
  assert.equal(p.steps[0].args.expectedDetailHash, undefined);
  for (const script of [
    "append_action action=wait seconds=1\nset_integer itemIndex=1 parameterIndex=1 value=bad",
    "bind itemIndex=@missing parameterIndex=1 source=value value=2",
    "append_action action=wait seconds=1 as=Pause\nappend_action action=wait seconds=1 as=Pause",
    "bind archive=Other.SC2Map itemIndex=1 parameterIndex=1 source=value value=2",
    "bind expectedDetailHash=55 itemIndex=1 parameterIndex=1 source=value value=2",
    "live document.save expectedSha256=bad",
  ])
    assert.throws(() => compileTriggerPatch({ ...base, script }));
  const many = Array.from({ length: 64 }, () => "append_action action=wait seconds=1").join("\n");
  assert.equal(compileTriggerPatch({ ...base, script: many }).steps.length, 64);
  assert.throws(
    () => compileTriggerPatch({ ...base, script: many + "\nappend_action action=wait seconds=1" }),
    /STEP_BOUND/,
  );
});

test("one authoring block carries a GUI patch without JSON or explicit hashes", () => {
  const result = compileAuthorScript(
    "live trigger.patch archive=Current.SC2Map windowId=1 path=MAIN/Start <<EDITS\nappend_action action=wait seconds=1\nEDITS",
    "stage",
  );
  assert.equal(result[0].tool, "live.trigger.patch");
  assert.equal(result[0].args.script, "append_action action=wait seconds=1");
  assert.throws(
    () =>
      compileAuthorScript(
        "live trigger.patch archive=Current.SC2Map windowId=1 path=MAIN/Start script=x",
        "plan",
      ),
    /REQUIRES_STAGE/,
  );
});

test("insertion adoption requires an exact finite duration and retained native flags", () => {
  const items = [
    { parent: -1, depth: 0, text: "Start", stateImage: 0 },
    { parent: 0, depth: 1, text: "Actions", stateImage: 0 },
  ];
  const graph = { root: [], bodies: [{ path: base.path, items }], missing: [] };
  const step = compileTriggerPatch({ ...base, script: "append_action action=wait seconds=0.25" })
    .steps[0];
  const result = { status: "applied", nativeTreeVerified: true, parameterVerified: true };
  for (const duration of ["0.25", "0.2.5", "NaN", "0.5"]) {
    const after = {
      ...graph,
      bodies: [
        {
          path: base.path,
          items: [
            ...items,
            {
              parent: 1,
              depth: 2,
              text: "General -Wait " + duration + " Game Time seconds",
              stateImage: 0,
            },
          ],
        },
      ],
    };
    assert.equal(
      !!observeAcknowledgedInsertion(graph, after, step, step.args, result),
      duration === "0.25",
    );
  }
  const after = {
    ...graph,
    bodies: [
      {
        path: base.path,
        items: [
          { ...items[0], stateImage: 1 },
          items[1],
          { parent: 1, depth: 2, text: "General -Wait 0.25 Game Time seconds", stateImage: 0 },
        ],
      },
    ],
  };
  assert.equal(observeAcknowledgedInsertion(graph, after, step, step.args, result), undefined);
});

let serial = 0;
async function fixture(
  t: test.TestContext,
  options: {
    lost?: boolean;
    manualAt?: number;
    failSecondRead?: boolean;
    validation?: boolean;
    unknownSave?: boolean;
    failSnapshotAt?: number;
    legacyAppendReceipt?: boolean;
    nativePending?: boolean;
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc2-trigger-patch-")),
    archive = path.join(root, "Current.SC2Map");
  await fs.writeFile(archive, "map");
  const w = {
    windowId: "1",
    processId: 61000000 + serial++,
    processStart: String(Date.now()),
    enabled: true,
    acceptsFiles: true,
    title: `Triggers - [${archive}] - StarCraft II Editor`,
  };
  let value = 1,
    external = 0,
    snapshots = 0,
    reads = 0,
    mutations = 0,
    saves = 0,
    failed = false;
  const rows = ["Set Value"],
    calls: Array<{ name: string; args: any }> = [],
    ids = new Set<string>();
  const tr = {
    snapshot: async (a: any) => {
      snapshots++;
      if (options.failSnapshotAt === snapshots) throw Error("lost post-edit observation");
      if (options.manualAt === snapshots) external++;
      return {
        archive,
        sha256: "a".repeat(64),
        window: w,
        graph: {
          root: [{ parent: -1, depth: 0, text: "MAIN " + external, stateImage: 0 }],
          bodies: a.paths.map((p: string) => ({
            path: p,
            items: [
              { parent: -1, depth: 0, text: "Start", stateImage: 0 },
              { parent: 0, depth: 1, text: "Actions", stateImage: 0 },
              ...rows.map((text, i) => ({
                parent: 1,
                depth: 2,
                text: i === 0 ? text + " " + value : text,
                stateImage: 0,
              })),
            ],
          })),
          missing: [],
        },
        mapMutation: false,
      };
    },
    details: async (a: any) => {
      reads++;
      calls.push({ name: "details", args: a });
      if (options.failSecondRead && reads === 2 && !failed) {
        failed = true;
        throw Error("native inspection unavailable");
      }
      return {
        items: rows.map((text, i) => ({ text, index: i + 1, hasChildren: false })),
        actions: rows.map((text, i) => ({ text, index: i + 1, hasChildren: false })),
        totalActions: rows.length,
        detailFingerprint: String(value + 10),
      };
    },
    parameters: async (a: any) => {
      assert.equal(a.source, undefined);
      assert.equal(a.value, undefined);
      calls.push({ name: "parameters", args: a });
      return {
        parameterFingerprint: String(value + 100),
        parameters: [{ index: 1, text: "Value: " + value, hasChildren: false }],
      };
    },
    bind: async (a: any) => {
      calls.push({ name: "bind", args: a });
      assert.equal(a.expectedDetailHash, String(value + 10));
      assert.equal(a.expectedParameterHash, String(value + 100));
      mutations++;
      value = a.value;
      if (options.lost) throw Error("lost native commit reply");
      if (options.nativePending)
        return {
          status: "pending_native",
          pendingId: "11111111-1111-4111-8111-111111111111",
          recovery: "Inspect original native operation",
        };
      return {
        status: options.validation ? "needs_parameters" : "applied",
        nativeBindingVerified: true,
      };
    },
    appendAction: async (a: any) => {
      calls.push({ name: "appendAction", args: a });
      mutations++;
      rows.push("General -Wait " + a.seconds + " Game Time seconds");
      return {
        status: "applied",
        nativeTreeVerified: true,
        parameterVerified: true,
        ...(options.legacyAppendReceipt
          ? {}
          : { itemIndex: rows.length, nativeLabel: rows.at(-1) }),
      };
    },
    setWait: async (a: any) => {
      calls.push({ name: "setWait", args: a });
      mutations++;
      rows[a.actionIndex - 1] = "General -Wait " + a.seconds + " Game Time seconds";
      return { status: "applied" };
    },
  } as unknown as LiveTriggers;
  const doc = {
    status: async () => ({ sha256: "a".repeat(64) }),
    save: async () => {
      saves++;
      return {
        status: options.unknownSave ? "unknown" : "saved",
        saved: !options.unknownSave,
        copiesCreated: 0,
      };
    },
  };
  const make = () =>
      new LiveTriggerPatches(
        root,
        tr,
        doc as any,
        (fn) => fn(),
        () => false,
      ),
    patch = make(),
    input = { ...base, archive };
  const observe = (result: any) => {
    if (result.patchId) ids.add(result.patchId);
    return result;
  };
  t.after(async () => {
    for (const id of ids) {
      try {
        await patch.recover({
          archive: input.archive,
          windowId: input.windowId,
          patchId: id,
          action: "release",
        });
      } catch {}
      await fs
        .unlink(
          path.join(
            os.tmpdir(),
            "SC2EditorToolkit-live-memory",
            "trigger-patches",
            "history",
            id + ".json",
          ),
        )
        .catch(() => {});
    }
    await patch.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    recovery: { archive, windowId: input.windowId },
    patch,
    make,
    input,
    calls,
    observe,
    counts: () => ({ mutations, saves, snapshots }),
    change: () => external++,
  };
}

test("a patch refreshes guards, uses inserted aliases and saves the same document once", async (t) => {
  const f = await fixture(t),
    r = f.observe(
      await f.patch.start({
        ...f.input,
        saveOnComplete: true,
        script:
          "bind itemIndex=1 parameterIndex=1 source=value value=7\nappend_action action=wait seconds=1 as=Pause\nset_wait actionIndex=@Pause seconds=2",
      }),
    );
  assert.equal(r.status, "applied");
  assert.equal(r.completed, 3);
  assert.equal(r.pendingId, undefined);
  assert.equal(r.atomicUndo, false);
  assert.deepEqual(f.counts().mutations, 3);
  assert.equal(f.counts().saves, 1);
  assert.equal(f.calls.find((x) => x.name === "setWait")?.args.actionIndex, 2);
  const second = await f.make().recover({ ...f.recovery, patchId: r.patchId });
  assert.equal("history" in second && second.history, true);
  assert.equal(second.completed, 3);
});

test("a malformed later command cannot perform the first native edit", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.patch.start({
      ...f.input,
      script: "append_action action=wait seconds=1\nset_wait actionIndex=1 seconds=-1",
    }),
  );
  assert.deepEqual(f.counts(), { mutations: 0, saves: 0, snapshots: 0 });
});

test("lost native edits are journalled across clients and never repeated", async (t) => {
  const f = await fixture(t, { lost: true }),
    r = f.observe(
      await f.patch.start({
        ...f.input,
        script:
          "bind itemIndex=1 parameterIndex=1 source=value value=7\nappend_action action=wait seconds=1",
      }),
    );
  assert.equal(r.status, "unknown");
  assert.equal(r.inflightStep, 1);
  assert.equal(f.counts().mutations, 1);
  const other = f.make(),
    check = await other.recover({ ...f.recovery, patchId: r.patchId, action: "continue" });
  assert.equal("replayAllowed" in check && check.replayAllowed, false);
  assert.equal("currentGraphMatches" in check && check.currentGraphMatches, false);
  assert.equal(f.counts().mutations, 1);
  await assert.rejects(
    other.start({ ...f.input, script: "append_action action=wait seconds=1" }),
    /PENDING_RECOVERY/,
  );
  const release = await other.recover({ ...f.recovery, patchId: r.patchId, action: "release" });
  assert.equal("unresolvedMutation" in release && release.unresolvedMutation, true);
});

test("a nested native operation keeps its own recovery ID separate from the patch ID", async (t) => {
  const f = await fixture(t, { nativePending: true }),
    r = f.observe(
      await f.patch.start({
        ...f.input,
        script: "bind itemIndex=1 parameterIndex=1 source=value value=7",
      }),
    );
  assert.equal(r.status, "unknown");
  assert.equal(r.nativePendingId, "11111111-1111-4111-8111-111111111111");
  assert.notEqual(r.patchId, r.nativePendingId);
  assert.equal(r.operationResult.pendingId, r.nativePendingId);
});

test("a stopped observation resumes after the acknowledged cursor without repeating earlier writes", async (t) => {
  const f = await fixture(t, { failSecondRead: true }),
    r = f.observe(
      await f.patch.start({
        ...f.input,
        script:
          "bind itemIndex=1 parameterIndex=1 source=value value=7\nbind itemIndex=1 parameterIndex=1 source=value value=9",
      }),
    );
  assert.equal(r.status, "stopped");
  assert.equal(r.completed, 1);
  assert.equal(r.inflightStep, undefined);
  const other = f.make(),
    done = await other.recover({ ...f.recovery, patchId: r.patchId, action: "continue" });
  assert.equal(done.status, "applied");
  assert.equal(done.completed, 2);
  assert.equal(f.counts().mutations, 2);
  assert.deepEqual(
    f.calls.filter((x) => x.name === "bind").map((x) => x.args.value),
    [7, 9],
  );
});

test("manual graph changes between steps stop before the next write", async (t) => {
  const f = await fixture(t, { manualAt: 5 }),
    r = f.observe(
      await f.patch.start({
        ...f.input,
        script:
          "bind itemIndex=1 parameterIndex=1 source=value value=7\nbind itemIndex=1 parameterIndex=1 source=value value=9",
      }),
    );
  assert.equal(r.status, "stopped");
  assert.equal(r.completed, 1);
  assert.equal(f.counts().mutations, 1);
  await assert.rejects(
    f.make().recover({ ...f.recovery, patchId: r.patchId, action: "continue" }),
    /CURRENT_GRAPH_CHANGED/,
  );
});

test("an acknowledged insertion with a lost follow-up observation is adopted without replay", async (t) => {
  const f = await fixture(t, { failSnapshotAt: 4, legacyAppendReceipt: true }),
    r = f.observe(
      await f.patch.start({
        ...f.input,
        script:
          "append_action action=wait seconds=0.25 as=Pause\nset_wait actionIndex=@Pause seconds=0.5",
      }),
    );
  assert.equal(r.status, "unknown");
  assert.equal(r.completed, 0);
  assert.equal(f.counts().mutations, 1);
  const done = await f.make().recover({ ...f.recovery, patchId: r.patchId, action: "continue" });
  assert.equal(done.status, "applied");
  assert.equal(done.completed, 2);
  assert.equal(f.counts().mutations, 2);
  assert.equal(f.calls.filter((x) => x.name === "appendAction").length, 1);
});

test("a collateral root edit during a successful primitive cannot be accepted as its post-state", async (t) => {
  const f = await fixture(t, { manualAt: 4 }),
    r = f.observe(
      await f.patch.start({
        ...f.input,
        script:
          "bind itemIndex=1 parameterIndex=1 source=value value=7\nappend_action action=wait seconds=1",
      }),
    );
  assert.equal(r.status, "unknown");
  assert.match(r.error, /UNRELATED_ROOT_CHANGED/);
  assert.equal(f.counts().mutations, 1);
});

test("pending validation prevents automatic Save and an unknown Save is not replayed", async (t) => {
  const f = await fixture(t, { validation: true }),
    r = f.observe(
      await f.patch.start({
        ...f.input,
        saveOnComplete: true,
        script: "bind itemIndex=1 parameterIndex=1 source=value value=7",
      }),
    );
  assert.equal(r.status, "needs_validation");
  assert.equal(f.counts().saves, 0);
  const g = await fixture(t, { unknownSave: true }),
    s = g.observe(
      await g.patch.start({
        ...g.input,
        saveOnComplete: true,
        script: "bind itemIndex=1 parameterIndex=1 source=value value=7",
      }),
    );
  assert.equal(s.status, "unknown");
  assert.equal(s.inflightKind, "save");
  await g.make().recover({ ...g.recovery, patchId: s.patchId, action: "continue" });
  assert.equal(g.counts().saves, 1);
});

test("explicit sequence leases allow serial providers but exclude outside clients and overlapping borrowers", async () => {
  const w = {
    windowId: "1",
    processId: 62000000 + serial++,
    processStart: String(Date.now()),
    enabled: true,
    acceptsFiles: true,
    title: "Triggers",
  };
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const external = entered.then(() =>
    assert.rejects(
      withEditorLease(w, async () => {}),
      /LEASE_BUSY/,
    ),
  );
  await withEditorSequenceLease(w, async () => {
    enter();
    await external;
    await withEditorLease(w, async () => {});
    await withEditorLease(w, async () => {});
    let finish!: () => void;
    const first = withEditorLease(w, () => new Promise<void>((resolve) => (finish = resolve)));
    await assert.rejects(
      withEditorLease(w, async () => {}),
      /SEQUENCE_OVERLAP/,
    );
    finish();
    await first;
  });
  await withEditorLease(w, async () => {});
});
