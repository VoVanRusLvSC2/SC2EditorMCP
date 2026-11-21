import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createProject } from "../app/project.js";
import { createProjectServer } from "../app/server.js";
import { resolveModuleSelection } from "../app/moduleSelection.js";
import { projectToolRegistry } from "../app/toolServer.js";
import { documentHeader, readDocumentHeader } from "../modules/document/codecs/metadata.js";
import { createMapInfo } from "../modules/document/codecs/mapInfoFactory.js";
import { PlayersDocument } from "../modules/settings/players.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc2-component-parity-"));
  const project = await createProject(root, {
    selection: resolveModuleSelection({ SC2_MCP_MODULES: "document,map,script,terrain,settings" }),
  });
  const tools = projectToolRegistry(createProjectServer(project)).batchTools;
  t.after(async () => {
    await project.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    async write(file: string, data: string | Buffer) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), data);
    },
    read: (file: string) => fs.readFile(path.join(root, file)),
    async call(toolName: string, args: Record<string, unknown> = {}) {
      const tool = tools.get(toolName);
      assert.ok(tool, toolName);
      const raw = (await tool.invoke(tool.schema.parse(args), {})) as {
        isError?: boolean;
        content: [{ text: string }];
      };
      if (raw.isError) throw Error(raw.content[0].text);
      return JSON.parse(raw.content[0].text);
    },
  };
}

test("manifest entries change by source span and staged payload removals block save", async (t) => {
  const f = await fixture(t);
  const file = "ComponentList.SC2Components",
    original =
      '\uFEFF<?xml version="1.0"?>\r\n<Components>\r\n    <!-- keep -->\r\n    <DataComponent Type="info" Extension="custom">DocumentInfo</DataComponent>\r\n</Components>';
  await f.write(file, original);
  await f.write("DocumentInfo", "<DocInfo/>");
  await f.write("Regions", "<Regions/>");
  const initial = await f.call("document.components.inspect");
  assert.deepEqual(initial.components[0].files, ["DocumentInfo"]);
  await f.call("document.components.apply", {
    expectedSha256: initial.sha256,
    operations: [{ op: "add", entry: { type: "regi", path: "Regions" } }],
    dryRun: false,
  });
  assert.equal((await f.read(file)).toString(), original);
  await assert.rejects(
    f.call("document.components.apply", {
      expectedSha256: initial.sha256,
      operations: [{ op: "remove", entry: { type: "info", path: "DocumentInfo" } }],
    }),
    /DOCUMENT_COMPONENT_REVISION_STALE/,
  );
  await fs.unlink(path.join(f.root, "Regions"));
  await assert.rejects(f.call("modkit.save", { file }), /DOCUMENT_COMPONENT_PAYLOAD_MISSING/);
  await f.write("Regions", "<Regions/>");
  await f.call("modkit.save", { file });
  const added = await f.call("document.components.inspect");
  await f.call("document.components.apply", {
    expectedSha256: added.sha256,
    dryRun: false,
    stage: false,
    operations: [
      {
        op: "update",
        entry: { type: "regi", path: "Regions" },
        type: "test",
        locale: "enUS",
        path: "NewRegionPayload",
        allowMissing: true,
      },
    ],
  });
  const updated = await f.call("document.components.inspect");
  assert.deepEqual(
    updated.components.find((entry: { type: string }) => entry.type === "test"),
    { type: "test", path: "NewRegionPayload", locale: "enUS", files: [] },
  );
  await f.call("document.components.apply", {
    expectedSha256: updated.sha256,
    dryRun: false,
    stage: false,
    operations: [
      { op: "remove", entry: { type: "test", path: "NewRegionPayload", locale: "enUS" } },
    ],
  });
  const saved = (await f.read(file)).toString();
  assert.match(saved, /\uFEFF<\?xml/);
  assert.match(
    saved,
    /<!-- keep -->\r\n    <DataComponent Type="info" Extension="custom">DocumentInfo<\/DataComponent>/,
  );
  assert.doesNotMatch(saved, /regi/);
  assert.equal((await f.read("Regions")).toString(), "<Regions/>");
});

test("DocumentInfo dependencies and binary header share one guarded save", async (t) => {
  const f = await fixture(t);
  const deps = ["file:Mods/Void.SC2Mod"];
  const originalHeader = documentHeader(
    deps,
    [{ key: "DocInfo/Name", locale: "enUS", value: "Keep" }],
    { major: 5, minor: 0, patch: 17, build: 98310 },
    "map",
    100,
    1,
  );
  await f.write("DocumentHeader", originalHeader);
  await f.write(
    "DocumentInfo",
    '<DocInfo>\r\n<Custom Attr="keep"/><Dependencies><Value>' +
      deps[0] +
      "</Value></Dependencies>\r\n</DocInfo>",
  );
  const info = await f.call("document.metadata.inspect");
  await f.call("document.metadata.apply", {
    expectedSha256: info.sha256,
    dryRun: false,
    operations: [
      { op: "add_dependency", entry: { file: "Mods/Swarm.SC2Mod", bnet: "Swarm (Mod)/0.0/999" } },
      { op: "set_field", field: "Icon", value: "Assets/Test&Icon.dds" },
    ],
  });
  assert.deepEqual(await f.read("DocumentHeader"), originalHeader);
  await f.call("modkit.save", { file: "DocumentInfo" });
  const header = readDocumentHeader(await f.read("DocumentHeader"));
  assert.deepEqual(header.dependencies, [
    ...deps,
    "bnet:Swarm (Mod)/0.0/999,file:Mods/Swarm.SC2Mod",
  ]);
  assert.deepEqual(header.strings, readDocumentHeader(originalHeader).strings);
  assert.match((await f.read("DocumentInfo")).toString(), /<Custom Attr="keep"\/>/);
  const after = await f.call("document.metadata.inspect");
  assert.deepEqual(after.fields.Icon, ["Assets/Test&Icon.dds"]);
  await f.call("document.metadata.apply", {
    expectedSha256: after.sha256,
    dryRun: false,
    stage: false,
    operations: [{ op: "remove_dependency", file: "mods/swarm.sc2mod" }],
  });
  assert.deepEqual(await f.read("DocumentHeader"), originalHeader);
});

test("GUI trigger clone remaps owned references and delete retains shared nodes", async (t) => {
  const f = await fixture(t),
    strings = "enUS.SC2Data/LocalizedData/TriggerStrings.txt";
  await f.write(strings, "Trigger/Name/A1111111=Original\r\nParam/Value/C1111111=Copied text\r\n");
  await f.write(
    "Triggers",
    [
      '<TriggerData><Root><Item Type="Trigger" Id="A1111111"/><Item Type="Trigger" Id="A2222222"/></Root>',
      '<Element Type="Trigger" Id="A1111111"><Identifier>First</Identifier><Action Type="FunctionCall" Id="B1111111"/><Action Type="FunctionCall" Id="B2222222"/></Element>',
      '<Element Type="Trigger" Id="A2222222"><Identifier>Second</Identifier><Action Type="FunctionCall" Id="B2222222"/></Element>',
      '<Element Type="FunctionCall" Id="B1111111"><Parameter Type="Param" Id="C1111111"/></Element>',
      '<Element Type="FunctionCall" Id="B2222222"><Parameter Type="Param" Id="C2222222"/></Element>',
      '<Element Type="Param" Id="C1111111"><ValueType Type="text"/></Element>',
      '<Element Type="Param" Id="C2222222"><ValueType Type="int"/></Element>',
      "</TriggerData>",
    ].join("\r\n"),
  );
  const before = await f.call("trigger.inspect");
  const cloned = await f.call("trigger.graph.edit", {
    id: "A1111111",
    expectedSha256: before.sha256,
    dryRun: false,
    operation: {
      op: "clone",
      newIdentifier: "FirstCopy",
      name: "Copy",
    },
  });
  assert.equal(cloned.clonedNodes, 5);
  const copyDraft = await f.call("trigger.inspect");
  assert.equal(
    copyDraft.triggers.find((item: { id: string }) => item.id === cloned.newId).displayName,
    "Copy",
  );
  await f.call("trigger.save");
  assert.match(
    (await f.read(strings)).toString(),
    /Param\/Value\/(?!C1111111)[A-F0-9]{8}=Copied text/,
  );
  const original = await f.call("trigger.graph.edit", {
    id: "A1111111",
    expectedSha256: copyDraft.sha256,
    dryRun: false,
    stage: false,
    operation: { op: "delete" },
  });
  assert.equal(original.removedNodes, 3);
  assert.equal(original.retainedSharedNodes, 2);
  const saved = (await f.read("Triggers")).toString();
  assert.match(saved, /Id="B2222222"/);
  assert.doesNotMatch(saved, /Id="B1111111"/);
});

test("mask edits preserve LFCT header, other bits and other cells", async (t) => {
  const f = await fixture(t);
  await f.write("MapInfo", createMapInfo(32, 32, "Aiur", 8, 0, true));
  const flags = Buffer.concat([Buffer.alloc(32 + 32 * 32), Buffer.from([22, 23])]);
  flags.write("LFCT");
  flags.writeUInt32LE(102, 4);
  flags.writeUInt32LE(32, 24);
  flags.writeUInt32LE(32, 28);
  flags[32 + 32 + 2] = 2;
  await f.write("t3CellFlags", flags);
  const before = await f.call("terrain.cell_flags.inspect", { cells: [{ x: 2, y: 1 }] });
  assert.equal(before.cells[0].value, 2);
  await f.call("terrain.cell_flags.apply", {
    expectedSha256: before.sha256,
    cells: [{ x: 2, y: 1, value: 4, mask: 4 }],
    dryRun: false,
    stage: false,
  });
  flags[32 + 32 + 2] = 6;
  assert.deepEqual(await f.read("t3CellFlags"), flags);
  const raw = await f.call("terrain.component_bytes.inspect", {
    component: "t3CellFlags",
    offset: 32 + 32 + 2,
    length: 2,
  });
  assert.equal(raw.hex, "0600");
  await f.call("terrain.component_bytes.apply", {
    component: "t3CellFlags",
    expectedSha256: raw.sha256,
    offset: 32 + 32 + 3,
    hex: "02",
    dryRun: false,
    stage: false,
  });
  flags[32 + 32 + 3] = 2;
  assert.deepEqual(await f.read("t3CellFlags"), flags);
  await assert.rejects(
    f.call("terrain.component_bytes.apply", {
      component: "t3CellFlags",
      expectedSha256: raw.sha256,
      offset: 32,
      hex: "02",
    }),
    /TERRAIN_BINARY_REVISION_STALE/,
  );
});

test("a player slot plan groups native records with selected lobby defaults", async (t) => {
  const f = await fixture(t),
    map = createMapInfo(32, 32, "Aiur", 8, 0, true);
  await f.write("MapInfo", map);
  await f.write(
    "ComponentList.SC2Components",
    '<Components><DataComponent Type="attr">Attributes</DataComponent></Components>',
  );
  await f.write(
    "Attributes",
    '<Attributes><Attribute><Id Value="10"/><Type Value="Player"/><Value><Id Value="1"/></Value><Default><Slot Id="0"/><Value Id="1"/></Default></Attribute></Attributes>',
  );
  const plan = await f.call("settings.plan", { operations: [{ op: "player.slots", count: 2 }] });
  assert.deepEqual(
    plan.files
      .sort((a: { file: string }, b: { file: string }) => a.file.localeCompare(b.file))
      .map((entry: { file: string }) => entry.file),
    ["Attributes", "MapInfo"],
  );
  const applied = await f.call("settings.apply", { planId: plan.id, dryRun: false });
  await f.call("settings.save", { transactionId: applied.transactionId, dryRun: false });
  const changed = new PlayersDocument(await f.read("MapInfo"));
  assert.deepEqual(
    changed.players.filter((p) => p.control === "User").map((p) => p.id),
    [1, 2],
  );
  assert.deepEqual(
    changed.players.filter((p) => ["Neutral", "Hostile"].includes(p.control)),
    new PlayersDocument(map).players.filter((p) => ["Neutral", "Hostile"].includes(p.control)),
  );
  assert.match((await f.read("Attributes")).toString(), /<Slot Id="1"\/>/);
});
