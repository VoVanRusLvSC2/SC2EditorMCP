import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createFlatTerrain } from "../modules/document/codecs/flatTerrainFactory.js";
import { Workspace } from "../core/workspace.js";
import { TerrainWorkspace } from "../modules/terrain/workspace.js";
import { checkAndRepairMissionRoutes } from "../modules/mission/routeRepair.js";
import { gameplayRequests, gameplaySchema } from "../modules/mission/gameplay.js";
import { triggerPlanSchema } from "../modules/trigger/schemas.js";
import { missionBuildSpecSchema } from "../modules/mission/buildSpec.js";
import { planMissionLayouts, routeSamples } from "../modules/mission/layout.js";
import { sculptMissionSurface } from "../modules/mission/surface.js";
import { riverSection } from "../modules/mission/river.js";
import { landformOperations } from "../modules/mission/nativeLandforms.js";
import { planRiverBridge } from "../modules/mission/riverBridge.js";

test("mission recipes link real GUI triggers to the placed scout, guard and bonus IDs", () => {
  const spec = gameplaySchema.parse({
    scout: "Thor",
    capture: { guard: "Zergling", title: "Secure the relay" },
    bonus: { guard: "Zergling", title: "Clear the outpost" },
    wave: { unit: "Zergling", count: 3, delay: 4, hold: 20, title: "Hold the relay" },
  });
  const result = gameplayRequests(
    spec,
    { scout: 19, guard: 20, bonus: 21 },
    { x: 54, y: 17 },
    { x: 54, y: 79 },
    { x: 62.5, y: 70 },
  );
  for (const request of result) triggerPlanSchema.parse(request);
  const triggers = new Map(
    result.flatMap((request) =>
      request.create ? ([[request.create.identifier, request.calls]] as const) : [],
    ),
  );
  assert.deepEqual(triggers.get("MissionCapture")?.[0], {
    kind: "Event",
    function: "TriggerAddEventUnitDied",
    args: { u: { kind: "unit", objectId: 20 } },
  });
  assert.deepEqual(triggers.get("MissionDefeat")?.[0], {
    kind: "Event",
    function: "TriggerAddEventUnitDied",
    args: { u: { kind: "unit", objectId: 19 } },
  });
  assert.deepEqual(triggers.get("MissionBonus")?.[0], {
    kind: "Event",
    function: "TriggerAddEventUnitDied",
    args: { u: { kind: "unit", objectId: 21 } },
  });
  const capture = JSON.stringify(triggers.get("MissionCapture"));
  assert.equal(capture.match(/"function":"UnitCreate"/g)?.length, 3);
  assert.equal(capture.match(/"function":"UnitIssueOrder"/g)?.length, 3);
  assert.equal(capture.match(/"function":"GameOver"/g)?.length, 1);
  assert.equal(
    result.flatMap((r) => r.calls).filter((c) => c.function === "TriggerAddEventMapInit").length,
    1,
  );
  assert.deepEqual(
    triggers
      .get("MapInitialization")
      ?.slice(1)
      .map((c) => [c.function, c.args.t]),
    ["SetupGameplay", "SetupObjectives", "SetupCamera"].map((name) => [
      "TriggerExecute",
      { kind: "trigger", name },
    ]),
  );
  assert.ok(
    ["SetupGameplay", "SetupObjectives", "SetupCamera"].every((name) =>
      triggers.get(name)?.every((call) => call.kind !== "Event"),
    ),
  );
});

test("one steep route patch is repaired without moving terrain outside its brush", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc2-mission-repair-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = createFlatTerrain(
    64,
    64,
    {
      id: "Test",
      textures: ["Dirt"],
      cliffs: ["Cliff"],
      sourcePaths: [],
    },
    "Dirt",
    8,
  );
  for (const [file, bytes] of files) await fs.writeFile(path.join(root, file), bytes);
  const terrain = new TerrainWorkspace(new Workspace(root));
  const point = { x: 20, y: 20 },
    apart = { x: 27, y: 20 };
  const bump = await terrain.plan({
    operations: [
      {
        op: "height.raise",
        amount: 0.8,
        area: { type: "circle", center: point, radius: 0.35 },
      },
    ],
  });
  assert.equal(
    (await terrain.apply(bump.id, { dryRun: false, stage: false, backup: false })).accepted,
    true,
  );
  const before = await terrain.surface();
  assert.ok(before.sample(point).slope > 0.25);
  const routes = [
    {
      id: "route",
      width: 8,
      points: [
        { x: 14, y: 20 },
        { x: 26, y: 20 },
      ],
      length: 12,
    },
  ];
  const repaired = await checkAndRepairMissionRoutes(terrain, routes, 8);
  assert.ok(repaired.repairs.length > 0 && repaired.repairs.length <= 4);
  assert.ok(repaired.routeChecks[0].maxSlope <= 0.25);
  const after = await terrain.surface();
  assert.equal(after.sample(apart).height, before.sample(apart).height);
  assert.deepEqual((await checkAndRepairMissionRoutes(terrain, routes, 8)).repairs, []);
});

test("river channels reach both map edges and keep the dry banks inside the native water grid", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc2-mission-river-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const spec = missionBuildSpecSchema.parse({
    version: 2,
    mode: "create",
    name: "River test",
    intent: "A river with two dry approaches",
    seed: 381,
    map: { width: 128, height: 128 },
    terrain: {
      tileSet: "Test",
      profile: "wetland",
      landform: "riverTerraces",
      water: { parent: "TestWater" },
    },
    layout: {
      pattern: "riverValley",
      start: { id: "Camp", radius: 10 },
      objective: { id: "Base", radius: 13 },
      routeWidth: 6,
      variantCount: 10,
    },
  });
  const layout = planMissionLayouts(spec).variants[0];
  const river = layout.river!;
  const bridge = planRiverBridge(layout, "Dirt");
  assert.equal(bridge.operations.length, 2);
  assert.ok(bridge.left.x < riverSection(river, bridge.left.y).x);
  assert.ok(bridge.right.x > riverSection(river, bridge.right.y).x);
  const flat = createFlatTerrain(
    128,
    128,
    { id: "Test", textures: ["Grass", "Dirt"], cliffs: ["Cliff"], sourcePaths: [] },
    "Grass",
    4,
  );
  for (const [file, bytes] of flat) await fs.writeFile(path.join(root, file), bytes);
  const terrain = new TerrainWorkspace(new Workspace(root));
  const { operations, waterLevel } = sculptMissionSurface(
    "wetland",
    layout,
    spec.seed,
    { base: 4, up: 4.9, down: 12.9 },
    { trail: "Dirt" },
  );
  const landform = layout.landform!;
  const plan = await terrain.plan({
    operations: [...landformOperations(landform, 0), ...operations],
  });
  assert.equal(plan.valid, true, JSON.stringify(plan.issues));
  const { sample } = await terrain.surface("", plan.id);
  assert.ok(sample(bridge.left).height > waterLevel + 0.4);
  assert.ok(sample(bridge.right).height > waterLevel + 0.4);
  for (const [i, ramp] of landform.ramps.entries()) {
    for (let y = ramp.center.y - 4; y <= ramp.center.y + 4; y++)
      assert.ok(
        landform.cliffs[i].strokes.some(
          (s) => s.minX === ramp.center.x && y >= s.minY && y < s.maxY,
        ),
        "a cliff turn touches a ramp side cap",
      );
    const x = ramp.center.x - 4;
    const weight = (y: number) =>
      sample({ x, y }).textures?.find(({ id }) => id === "Dirt")?.weight ?? 0;
    assert.ok(weight(ramp.center.y) > weight(ramp.center.y + 8));
  }
  for (const y of [0.5, 3.5, 20, 64, 108, 124.5, 127.5]) {
    const { x } = riverSection(river, y);
    assert.ok(sample({ x, y }).height < waterLevel, "dry river center at " + y);
    for (const x of [river.carrier.minX, river.carrier.maxX])
      assert.ok(sample({ x, y }).height > waterLevel);
  }
});

test("wetland shores hide the native water tile edges and preserve the reserved approaches", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc2-mission-shore-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const spec = missionBuildSpecSchema.parse({
    version: 2,
    mode: "create",
    intent: "A rounded wetland enclosed by two dry routes",
    name: "Wetland surface test",
    seed: 124,
    map: { width: 96, height: 96 },
    terrain: { tileSet: "Test", profile: "wetland", water: { parent: "TestWater" } },
    layout: {
      start: { id: "Start", radius: 10 },
      objective: { id: "Goal", radius: 10 },
      bonus: { id: "Bonus", radius: 6 },
      routeWidth: 6,
      variantCount: 8,
    },
  });
  const layout = planMissionLayouts(spec).variants[0];
  const files = createFlatTerrain(
    96,
    96,
    { id: "Test", textures: ["Grass", "Dirt", "Rock"], cliffs: ["Cliff"], sourcePaths: [] },
    "Grass",
    4,
  );
  for (const [file, bytes] of files) await fs.writeFile(path.join(root, file), bytes);
  const terrain = new TerrainWorkspace(new Workspace(root));
  const { operations, waterLevel } = sculptMissionSurface(
    "wetland",
    layout,
    spec.seed,
    {
      base: 4,
      up: 4.9,
      down: 12.9,
    },
    { trail: "Dirt", accent: "Rock" },
  );
  const plan = await terrain.plan({ operations });
  assert.equal(plan.valid, true, JSON.stringify(plan.issues));
  assert.equal(
    (await terrain.apply(plan.id, { dryRun: false, stage: false, backup: false })).accepted,
    true,
  );
  const { sample } = await terrain.surface();
  const { minX, minY, maxX, maxY } = layout.waterArea!;
  assert.ok(sample({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 }).height < waterLevel);
  for (let x = minX; x <= maxX; x++) {
    assert.ok(sample({ x, y: minY }).height > waterLevel);
    assert.ok(sample({ x, y: maxY }).height > waterLevel);
  }
  for (let y = minY; y <= maxY; y++) {
    assert.ok(sample({ x: minX, y }).height > waterLevel);
    assert.ok(sample({ x: maxX, y }).height > waterLevel);
  }
  for (const route of layout.routes)
    assert.ok(routeSamples(route.points).every((point) => sample(point).slope <= 0.1));
});
