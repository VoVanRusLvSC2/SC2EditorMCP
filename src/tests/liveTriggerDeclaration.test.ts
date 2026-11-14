import test from "node:test";
import assert from "node:assert/strict";
import {
  declarationPath,
  readDeclaration,
  setDeclaration,
  newDeclaration,
  renameDeclaration,
  triggerDeclarationSetSchema,
  type DeclarationContext,
} from "../modules/editorLive/triggerDeclaration.js";
import type { MemoryDesktop } from "../modules/editorLive/memoryDesktop.js";
import { compileAuthorScript } from "../app/authoringScript.js";

const target = { archive: "A.SC2Map", windowId: "1", path: "MAIN/Budget" };
const row = (handle: string, parent: string, depth: number, text: string) => ({
  handle,
  parent,
  depth,
  text,
});
function fixture(
  options: {
    lost?: boolean;
    collateral?: boolean;
    manual?: boolean;
    indeterminate?: boolean;
    stuckFlag?: boolean;
  } = {},
) {
  let rows = [
    row("1", "0", 0, "MAIN"),
    row("2", "1", 1, "Budget = 0 <Integer>"),
    row("3", "1", 1, "Other"),
  ];
  let revision = 10,
    fieldRevision = 20;
  let controls = [
    {
      id: 320,
      type: "ComboBox",
      text: "Integer",
      enabled: true,
      checked: false,
      options: ["Integer", "Real", "Boolean"],
    },
    {
      id: 325,
      type: "Button",
      text: "Constant",
      enabled: true,
      checked: false,
      ...(options.indeterminate ? { checkState: 2, buttonStyle: 6 } : {}),
    },
    { id: 326, type: "Button", text: "Array", enabled: true, checked: false },
    {
      id: 328,
      type: "ComboBox",
      text: "1",
      enabled: true,
      checked: false,
      options: ["1", "2", "3", "4"],
    },
    { id: 332, type: "Edit", text: "4", enabled: true, checked: false },
  ];
  const calls: Array<{ op: number; args: any }> = [];
  const window = {
    windowId: "1",
    processId: 5,
    processStart: "50",
    title: "Triggers - [A.SC2Map] - StarCraft II Editor",
    enabled: true,
    acceptsFiles: true,
  };
  const desktop = {
    windows: async () => [window],
    command: async (_w: unknown, op: number, args: any) => {
      calls.push({ op, args });
      if (op === 50)
        return {
          tree: {
            id: Number(args.unit),
            count: rows.length,
            total: rows.length,
            offset: 0,
            fingerprint: String(revision),
            truncated: false,
            items: rows,
          },
        };
      if (op === 55) return { selectionRequested: true };
      if (op !== 69) throw Error("Unexpected operation");
      if (args.field === "preflight") {
        if (options.manual) throw Error("LIVE_TRIGGER_DECLARATION_MANUAL_BUFFER_PRESERVED");
        return { ready: true };
      }
      if (args.field === "read")
        return {
          kind: "variable",
          fingerprint: String(fieldRevision),
          treeFingerprint: String(revision),
          controls,
        };
      if (args.field === "create") {
        rows.push(row("4", "1", 1, args.token + " = 0 <Integer>"));
        revision++;
        if (options.lost) throw Error("lost acknowledgement");
        return { submitted: true, nameSubmitted: true };
      }
      assert.equal(args.expected, String(fieldRevision));
      const id =
        args.field === "type"
          ? 320
          : args.field === "constant"
            ? 325
            : args.field === "size"
              ? 332
              : 0;
      controls = controls.map((x) =>
        x.id !== id
          ? x
          : {
              ...x,
              ...(id === 325
                ? {
                    checked: args.value === "true",
                    ...(options.indeterminate
                      ? { checkState: options.stuckFlag ? 2 : args.value === "true" ? 1 : 0 }
                      : {}),
                  }
                : { text: args.value }),
            },
      );
      fieldRevision++;
      revision++;
      if (options.collateral) rows[2] = { ...rows[2], text: "Collateral" };
      if (options.lost) throw Error("lost acknowledgement");
      return { submitted: true };
    },
  } satisfies MemoryDesktop;
  const c: DeclarationContext = {
    desktop,
    window,
    guardArchive: async () => {},
    currentWindow: async () => window,
    pause: async () => {},
  };
  return { c, calls, controls: () => controls, rows: () => rows };
}
test("declaration paths accept exact labels or unique names, never ambiguous stems", () => {
  const f = fixture(),
    rows = f.rows();
  assert.equal(declarationPath(rows, "MAIN/Budget").handle, "2");
  assert.equal(declarationPath(rows, "MAIN/Budget = 0 <Integer>").handle, "2");
  assert.throws(
    () => declarationPath([...rows, row("4", "1", 1, "Budget = 1 <Real>")], "MAIN/Budget"),
    /NOT_UNIQUE/,
  );
  assert.throws(() => declarationPath(rows, "MAIN//Budget"), /MISSING/);
});
test("declaration type/array edits require explicit reset acknowledgement and valid dimensions", () => {
  const base = { ...target, expectedDeclarationHash: "20" };
  for (const edit of [
    { field: "type", value: "Real" },
    { field: "array", value: true },
    { field: "dimensions", value: 5, allowShapeChange: true },
    { field: "size", value: 0, allowShapeChange: true },
    { field: "constant", value: "true" },
    { field: "initial", value: "raw script" },
  ])
    assert.equal(triggerDeclarationSetSchema.safeParse({ ...base, ...edit }).success, false);
  assert.equal(
    triggerDeclarationSetSchema.safeParse({
      ...base,
      field: "size",
      value: 8192,
      allowShapeChange: true,
    }).success,
    true,
  );
});
test("read-only declaration inspection preserves native choices and exposes a fresh fingerprint", async () => {
  const f = fixture(),
    r = await readDeclaration(f.c, target);
  assert.equal(r.declarationFingerprint, "20");
  assert.equal(r.mapMutation, false);
  assert.deepEqual(r.controls.find((x) => x.id === 320)?.options, ["Integer", "Real", "Boolean"]);
  assert.equal(
    f.calls.filter((x) => x.op === 69 && !["read", "preflight"].includes(x.args.field)).length,
    0,
  );
});
test("stale declaration or unavailable type refuses before writing", async () => {
  const f = fixture();
  await assert.rejects(
    setDeclaration(f.c, {
      ...target,
      expectedDeclarationHash: "19",
      field: "constant",
      value: true,
    }),
    /CHANGED/,
  );
  await assert.rejects(
    setDeclaration(f.c, {
      ...target,
      expectedDeclarationHash: "20",
      field: "type",
      value: "Invented",
      allowTypeReset: true,
    }),
    /NOT_FOUND/,
  );
  assert.equal(
    f.calls.filter((x) => x.op === 69 && !["read", "preflight"].includes(x.args.field)).length,
    0,
  );
});
test("pending manual declaration input refuses before changing native selection", async () => {
  const f = fixture({ manual: true });
  await assert.rejects(readDeclaration(f.c, target), /MANUAL_BUFFER/);
  assert.equal(f.calls.filter((x) => x.op === 55).length, 0);
});
test("verified type change preserves unrelated declarations and requires validation", async () => {
  const f = fixture(),
    r = await setDeclaration(f.c, {
      ...target,
      field: "type",
      value: "Real",
      expectedDeclarationHash: "20",
      allowTypeReset: true,
    });
  assert.equal(r.status, "needs_validation");
  assert.equal("nativeDeclarationVerified" in r && r.nativeDeclarationVerified, true);
  assert.equal(f.calls.filter((x) => x.op === 69 && x.args.field === "type").length, 1);
});
test("declaration readback detects collateral changes rather than accepting the requested field alone", async () => {
  const f = fixture({ collateral: true }),
    r = await setDeclaration(f.c, {
      ...target,
      field: "constant",
      value: true,
      expectedDeclarationHash: "20",
    });
  assert.equal(r.status, "verification_failed");
});
test("uncertain declaration write never replays the native mutation", async () => {
  const f = fixture({ lost: true }),
    r = await setDeclaration(f.c, {
      ...target,
      field: "constant",
      value: true,
      expectedDeclarationHash: "20",
    });
  assert.equal(r.status, "unknown");
  assert.equal(r.retryMutation, false);
  assert.equal(f.calls.filter((x) => x.op === 69 && x.args.field === "constant").length, 1);
});

test("an indeterminate native flag is not an explicit false value", async () => {
  for (const stuckFlag of [false, true]) {
    const f = fixture({ indeterminate: true, stuckFlag });
    const result = await setDeclaration(f.c, {
      ...target,
      field: "constant",
      value: false,
      expectedDeclarationHash: "20",
    });
    assert.equal(result.status, stuckFlag ? "verification_failed" : "needs_validation");
    assert.equal(f.calls.filter((x) => x.op === 69 && x.args.field === "constant").length, 1);
  }
});
test("new declarations retain all siblings; a lost creation reply never adds another element", async () => {
  for (const lost of [false, true]) {
    const f = fixture({ lost }),
      r = await newDeclaration(f.c, {
        ...target,
        path: "MAIN",
        kind: "variable",
        name: "Created",
        expectedTreeHash: "10",
      });
    assert.equal(r.status, lost ? "unknown" : "needs_parameters");
    assert.equal(f.rows().length, 4);
    assert.equal(f.calls.filter((x) => x.op === 69 && x.args.field === "create").length, 1);
  }
});
test("declaration creation rejects stale roots and name collisions before invoking New", async () => {
  const f = fixture(),
    base = {
      ...target,
      path: "MAIN",
      kind: "variable" as const,
      name: "Budget",
      expectedTreeHash: "10",
    };
  await assert.rejects(newDeclaration(f.c, base), /NAME_EXISTS/);
  await assert.rejects(
    newDeclaration(f.c, { ...base, name: "OtherNew", expectedTreeHash: "9" }),
    /TREE_CHANGED/,
  );
  assert.equal(f.calls.filter((x) => x.op === 69 && x.args.field === "create").length, 0);
});
test("compact commands route declaration reads and writes without raw JSON", () => {
  const plan = compileAuthorScript(
    "live trigger.declaration archive=A.SC2Map windowId=1 path=MAIN/Budget\nlive trigger.declaration_set archive=A.SC2Map windowId=1 path=MAIN/Budget field=size value=8 expectedDeclarationHash=20 allowShapeChange=true",
    "stage",
  );
  assert.equal(plan[0].tool, "live.trigger.declaration");
  assert.equal(plan[1].tool, "live.trigger.declaration_set");
});

function scopedFixture(kind: "local" | "parameter", collateral = false) {
  const scope = kind === "local" ? "Local Variables" : "Parameters",
    base = kind === "local" ? 600 : 500;
  const left = [row("1", "0", 0, "MAIN"), row("2", "1", 1, "Compute")];
  let body = [
    row("10", "0", 0, "Compute"),
    row("11", "10", 1, scope),
    row("12", "11", 2, "Value = 0 <Integer>"),
    row("13", "10", 1, "Actions"),
    row("14", "13", 2, "General -Return 42"),
  ];
  let revision = 20;
  let controls = [
    {
      id: base,
      type: "ComboBox",
      text: "Integer",
      enabled: true,
      checked: false,
      options: ["Integer", "Real"],
    },
    { id: 531, type: "Button", text: "Default &Value:", enabled: true, checked: true },
  ];
  const window = {
    windowId: "1",
    processId: 9,
    processStart: "90",
    title: "Triggers - [A.SC2Map] - StarCraft II Editor",
    enabled: true,
    acceptsFiles: true,
  };
  const calls: Array<{ op: number; args: any }> = [];
  const desktop = {
    windows: async () => [window],
    command: async (_w: unknown, op: number, args: any) => {
      calls.push({ op, args });
      if (op === 50) {
        const main = Number(args.unit) === 28,
          items = main ? left : body;
        return {
          tree: {
            id: main ? 28 : 154,
            count: items.length,
            total: items.length,
            offset: 0,
            fingerprint: main ? "10" : String(revision + 100),
            truncated: false,
            items,
          },
        };
      }
      if (op === 55) return { selectionRequested: true };
      if (op === 69 && args.field === "preflight") return { ready: true };
      if (op === 69 && args.field === "read")
        return { kind, fingerprint: String(revision), treeFingerprint: "10", controls };
      if (op === 69 && args.field === "type") {
        assert.equal(args.unit, "2");
        controls = controls.map((x) => (x.id === base ? { ...x, text: args.value } : x));
        body = body.map((x) => (x.handle === "12" ? { ...x, text: "Value = 0 <Real>" } : x));
        revision++;
      } else if (op === 69 && args.field === "default_enabled") {
        controls = controls.map((x) =>
          x.id === 531 ? { ...x, checked: args.value === "true" } : x,
        );
        revision++;
      } else throw Error("Unexpected native operation");
      if (collateral)
        body = body.map((x) => (x.handle === "14" ? { ...x, text: "General -Return 43" } : x));
      return { submitted: true };
    },
  } satisfies MemoryDesktop;
  const c: DeclarationContext = {
    desktop,
    window,
    guardArchive: async () => {},
    currentWindow: async () => window,
    pause: async () => {},
  };
  const input = { ...target, path: "MAIN/Compute", view: kind, member: "Value" };
  return { c, input, calls };
}
test("local and parameter declarations resolve the owning graph and exact member before editing", async () => {
  for (const kind of ["local", "parameter"] as const) {
    const f = scopedFixture(kind),
      before = await readDeclaration(f.c, f.input);
    assert.equal(before.kind, kind);
    assert.equal(before.nativeLabel, "Value = 0 <Integer>");
    const r = await setDeclaration(f.c, {
      ...f.input,
      field: "type",
      value: "Real",
      allowTypeReset: true,
      expectedDeclarationHash: before.declarationFingerprint,
    });
    assert.equal(r.status, "needs_validation");
    assert.equal("nativeDeclarationVerified" in r && r.nativeDeclarationVerified, true);
    assert.ok(f.calls.some((x) => x.op === 55 && x.args.unit === "154" && x.args.field === "12"));
  }
});
test("a local edit cannot hide a collateral change inside the function body", async () => {
  const f = scopedFixture("local", true),
    before = await readDeclaration(f.c, f.input);
  const r = await setDeclaration(f.c, {
    ...f.input,
    field: "type",
    value: "Real",
    allowTypeReset: true,
    expectedDeclarationHash: before.declarationFingerprint,
  });
  assert.equal(r.status, "verification_failed");
});
test("parameter default flags require signature validation and cannot target a global", async () => {
  const f = scopedFixture("parameter"),
    before = await readDeclaration(f.c, f.input);
  const r = await setDeclaration(f.c, {
    ...f.input,
    field: "default_enabled",
    value: false,
    expectedDeclarationHash: before.declarationFingerprint,
  });
  assert.equal(r.status, "needs_validation");
  assert.equal(
    triggerDeclarationSetSchema.safeParse({
      ...target,
      field: "default_enabled",
      value: false,
      expectedDeclarationHash: "20",
    }).success,
    false,
  );
});
test("a member scope without a name refuses before touching selection", async () => {
  const f = scopedFixture("local");
  await assert.rejects(
    readDeclaration(f.c, { ...target, path: "MAIN/Compute", view: "local" }),
    /MEMBER_SCOPE/,
  );
  assert.equal(f.calls.length, 0);
});

function renameFixture(options: { lost?: boolean; collateralState?: boolean } = {}) {
  const left = [row("1", "0", 0, "MAIN"), row("2", "1", 1, "Compute")];
  let body = [
    row("10", "0", 0, "Compute"),
    row("11", "10", 1, "Parameters"),
    row("12", "11", 2, "Base = 7 <Integer>"),
    row("13", "10", 1, "Local Variables"),
    row("14", "13", 2, "Bonus = 5 <Integer>"),
    row("15", "10", 1, "Actions"),
    row("16", "15", 2, "General -Return (Base + Bonus)"),
  ].map((x) => ({ ...x, stateImage: 1 }));
  let selected = "12",
    count = 0;
  const window = {
    windowId: "1",
    processId: 9,
    processStart: "90",
    title: "Triggers - [A.SC2Map] - StarCraft II Editor",
    enabled: true,
    acceptsFiles: true,
  };
  const desktop = {
    windows: async () => [window],
    command: async (_w: unknown, op: number, args: any) => {
      if (op === 50) {
        const main = Number(args.unit) === 28,
          items = main ? left : body;
        return {
          tree: {
            id: main ? 28 : 154,
            count: items.length,
            total: items.length,
            offset: 0,
            fingerprint: main ? "10" : "30",
            truncated: false,
            items,
          },
        };
      }
      if (op === 55) {
        if (args.unit !== "28") selected = args.field;
        return { selectionRequested: true };
      }
      if (op === 69 && args.field === "preflight") return { ready: true };
      if (op === 69 && args.field === "read")
        return {
          kind: selected === "12" ? "parameter" : "local",
          fingerprint: "20",
          treeFingerprint: "10",
          controls: [],
        };
      if (op === 66) {
        count++;
        assert.equal(args.unit, "154");
        const item = body.find((x) => x.handle === args.field)!,
          stem = item.text.split(" = ")[0],
          suffix = item.text.slice(stem.length);
        body = body.map((x) => ({ ...x, text: x.text.replaceAll(stem, args.value) }));
        if (options.collateralState) body[5].stateImage = 2;
        if (options.lost) throw Error("lost rename reply");
        return { submitted: true, displaySuffix: suffix };
      }
      throw Error("Unexpected operation");
    },
  } satisfies MemoryDesktop;
  const c: DeclarationContext = {
    desktop,
    window,
    guardArchive: async () => {},
    currentWindow: async () => window,
    pause: async () => {},
  };
  return {
    c,
    count: () => count,
    body: () => body,
    input: {
      ...target,
      path: "MAIN/Compute",
      view: "parameter" as const,
      member: "Base",
      expectedDeclarationHash: "20",
    },
  };
}

test("declaration Rename retains the native member and reports updated reference labels", async () => {
  const f = renameFixture(),
    r = await renameDeclaration(f.c, { ...f.input, name: "Seed" });
  assert.equal(r.status, "needs_validation");
  assert.equal("nativeRenameVerified" in r && r.nativeRenameVerified, true);
  assert.equal("dependentReferencesUnverified" in r && r.dependentReferencesUnverified, true);
  assert.equal(f.body()[2].handle, "12");
  assert.equal(f.body()[6].text, "General -Return (Seed + Bonus)");
  assert.equal(f.count(), 1);
});

test("declaration Rename rejects stale hashes and collisions across parameter/local groups", async () => {
  const f = renameFixture();
  await assert.rejects(
    renameDeclaration(f.c, { ...f.input, name: "Seed", expectedDeclarationHash: "19" }),
    /CHANGED/,
  );
  await assert.rejects(renameDeclaration(f.c, { ...f.input, name: "Bonus" }), /NAME_EXISTS/);
  assert.equal(f.count(), 0);
});

test("Rename does not accept changed native flags and never replays a lost reply", async () => {
  const f = renameFixture({ collateralState: true });
  assert.equal(
    (await renameDeclaration(f.c, { ...f.input, name: "Seed" })).status,
    "verification_failed",
  );
  const g = renameFixture({ lost: true });
  assert.equal((await renameDeclaration(g.c, { ...g.input, name: "Seed" })).status, "unknown");
  assert.equal(g.count(), 1);
});
