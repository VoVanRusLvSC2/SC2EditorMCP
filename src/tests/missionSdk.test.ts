import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { defineMissionPack, modelRotation } from "../mission-sdk.js";
import { measuredFacing } from "../modules/world/facings.js";
import { bindMissionStages } from "../modules/world/stages.js";
import { stageTriggers } from "../modules/world/gameplay.js";
import { mergeWorldComponents, mergeWorldObjects } from "../modules/world/rebuild.js";
import { PlacementDocument } from "../modules/placement/document.js";
import { loadMissionPlugin } from "../modules/world/plugin.js";

const pack = defineMissionPack({
  apiVersion: 1,
  id: "Ore",
  facings: [],
  mechanics: [{ id: "Load", seconds: 4, radius: 3, approachWidth: 8 }],
});
const stages = [{ id: "Shipment", zone: "Exit", mechanic: "Load", title: "Load shipment" }];

test("mechanic reserves every approach leg without changing its source or side road", () => {
  const edges = [
    { from: "Start", to: "Yard", width: 3, trail: [{ at: 0, width: 4 }] },
    { from: "Exit", to: "Yard", width: 4 },
    { from: "Yard", to: "Side", width: 3 },
  ];
  const routes = bindMissionStages("mission", "Start", "Exit", edges, pack, stages);
  assert.deepEqual(
    routes.map((r) => r.width),
    [8, 8, 3],
  );
  assert.equal(routes[0].trail![0].width, 8);
  assert.equal(edges[0].trail![0].width, 4);
  assert.throws(
    () => bindMissionStages("mission", "Start", "Exit", [], pack, stages),
    /UNREACHABLE/,
  );
  assert.throws(
    () => bindMissionStages("mission", "Start", "Exit", edges, pack, [...stages, ...stages]),
    /DUPLICATE/,
  );
  assert.throws(
    () =>
      bindMissionStages("mission", "Start", "Exit", edges, pack, [
        { ...stages[0], mechanic: "Typo" },
      ]),
    /UNKNOWN/,
  );
  assert.throws(
    () => bindMissionStages("arcade", "Start", "Exit", edges, pack, stages),
    /REQUIRES_MISSION/,
  );
});

test("measured model front is variation-specific and points back into the room", () => {
  const rule = measuredFacing("CastanarMonitorFloor", 0)!;
  assert.equal(rule.standOff, 2.6);
  assert.equal(modelRotation(Math.PI / 2, rule.frontDegrees), Math.PI);
  assert.equal(measuredFacing("CastanarMonitorFloor", 1), undefined);
  assert.equal(measuredFacing(rule.actor, 0, [{ ...rule, frontDegrees: 180 }])?.frontDegrees, 180);
});

test("published SDK loads an external plugin and validates its contributions", async () => {
  const old = process.env.SC2_MISSION_PLUGINS;
  try {
    process.env.SC2_MISSION_PLUGINS = JSON.stringify({
      OreYard: path.resolve("examples/mission-sdk/ore-yard.mjs"),
    });
    const context = { seed: 5, width: 64, height: 64, zones: ["Start", "Loader", "Exit"] };
    const small = await loadMissionPlugin("OreYard", context),
      large = await loadMissionPlugin("OreYard", { ...context, width: 128 });
    assert.equal(small.mechanics[1].approachWidth, 7);
    assert.equal(large.mechanics[1].approachWidth, 10);
    const triggers = stageTriggers(9, [
      { ...small.mechanics[1], title: "Load", point: { x: 12, y: 19 } },
    ]);
    assert.match(JSON.stringify(triggers), /Cargo loaded/);
    assert.match(JSON.stringify(triggers), /TriggerAddEventUnitDied/);
    await assert.rejects(loadMissionPlugin("unknown", context), /NOT_CONFIGURED/);
    assert.throws(
      () => defineMissionPack({ ...small, mechanics: [...small.mechanics, ...small.mechanics] }),
      /Duplicate/,
    );
  } finally {
    if (old === undefined) delete process.env.SC2_MISSION_PLUGINS;
    else process.env.SC2_MISSION_PLUGINS = old;
  }
});

test("manual crate transform and an independently regenerated fixture merge by ID", () => {
  const doc = PlacementDocument.create();
  const [crate, lamp] = doc.addMany(
    ["Crate", "AlarmLight"].map((catalogId) => ({
      kind: "Doodad",
      catalogId,
      position: { x: 10, y: 11, z: 4 },
    })),
  );
  const mine = new PlacementDocument(doc.source),
    next = new PlacementDocument(doc.source);
  mine.move(crate, { x: 14, y: 12, z: 4 });
  next.rotate(lamp, Math.PI);
  const merged = new PlacementDocument(mergeWorldObjects(doc.source, mine.source, next.source));
  assert.equal(merged.list()[0].position, mine.list()[0].position);
  assert.equal(merged.list()[1].rotation, next.list()[1].rotation);
  next.rotate(crate, 0.5);
  assert.throws(() => mergeWorldObjects(doc.source, mine.source, next.source), /CONFLICT/);
});

test("manual terrain and generated changes to the same terrain family require review", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc2-sdk-"));
  try {
    const dirs = ["base", "mine", "next"].map((s) => path.join(dir, s));
    for (const d of dirs) {
      await fs.mkdir(d);
      await fs.writeFile(path.join(d, "t3HeightMap"), "a");
      await fs.writeFile(path.join(d, "t3TextureMasks"), "a");
    }
    await fs.writeFile(path.join(dirs[1], "t3HeightMap"), "manual");
    await fs.writeFile(path.join(dirs[2], "t3TextureMasks"), "generated");
    await assert.rejects(mergeWorldComponents(dirs[0], dirs[1], dirs[2]), /CONFLICT/);
    assert.equal(await fs.readFile(path.join(dirs[1], "t3HeightMap"), "utf8"), "manual");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
