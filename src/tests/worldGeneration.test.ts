import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorldSpec, planWorld, routeEdgeDistance } from "../modules/world/plan.js";
import {
  campaignLandscapeEnabled,
  loadCampaignLandscape,
} from "../modules/world/missionLandscape.js";
import { compileWorldSurface } from "../modules/world/surface.js";
import { traceFacilityFloorJoints } from "../modules/world/floorJoints.js";
import { parseState } from "../modules/terrain/operations.js";
import {
  worldPathing,
  structureLayout,
  structureObjects,
  gateRequests,
  shorelineWeight,
  waterOperations,
} from "../modules/world/structures.js";
import { worldTriggers } from "../modules/world/gameplay.js";
import type { DecorPalette } from "../modules/placement/decorPalette.js";

const zones = Array.from({ length: 8 }, (_, i) => ({
  id: "Z" + i,
  biome: "engineered",
  tileSet: "Set" + i,
  anchor: { x: (i % 4) / 3, y: Math.floor(i / 4) },
}));
const spec = resolveWorldSpec({
  version: 1,
  name: "8 banks",
  width: 64,
  height: 64,
  mode: "mission",
  seed: 5,
  zones,
  connections: zones.slice(1).map((zone, i) => ({ from: zones[i].id, to: zone.id, kind: "road" })),
  starts: ["Z0"],
  objective: "Z7",
});
const banks = zones.map((z) => ({
  id: z.tileSet,
  cliffs: [],
  sourcePaths: [],
  textures: Array.from({ length: 8 }, (_, i) => z.tileSet + "_" + i),
}));

test("all 64 materials are painted; native RTXT stores local layer and bank separately", () => {
  const layout = planWorld(spec);
  const first = compileWorldSurface(spec, layout, banks);
  assert.equal(first.paintedTextures.length, 64);
  const state = parseState(first.files),
    sync = state.syncTextures!;
  const used = new Set<string>();
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const off = sync.dataOffset + (y * 64 + x) * 8;
      const bank = sync.bytes.readUInt32LE(off + 4),
        layer = sync.bytes.readUInt32LE(off);
      assert.equal(bank, state.descriptor.blockSet(x, y));
      assert.ok(layer < 8);
      const weights = state.masks!.weights(x * 8 + 4, y * 8 + 4);
      assert.equal(
        weights.reduce((n, w) => n + w, 0),
        15,
      );
      weights.forEach((w, i) => {
        if (w) used.add(sync.names[8 * bank + i]);
      });
    }
  assert.equal(used.size, 64);
  assert.deepEqual(first.files, compileWorldSurface(spec, layout, banks).files);
  sync.set(0, 0, 63);
  assert.equal(sync.bytes.readUInt32LE(sync.dataOffset), 7);
  assert.equal(sync.bytes.readUInt32LE(sync.dataOffset + 4), 7);
});
test("route reservations, budgets and invalid disconnected plans", () => {
  assert.throws(() => planWorld({ ...spec, connections: [] }), /DISCONNECTED/);
  assert.throws(() => planWorld({ ...spec, zones: [...spec.zones, spec.zones[0]] }), /DUPLICATE/);
  assert.throws(
    () =>
      planWorld({
        ...spec,
        zones: spec.zones.map((z, i) =>
          i === 0 ? { ...z, areaBlocks: { min: 99, max: 101 } } : z,
        ),
      }),
    /AREA_UNSATISFIED/,
  );
  const changes = spec.zones.map((z) => ({ ...z, density: 0.99 }));
  assert.deepEqual(planWorld(spec).blocks, planWorld({ ...spec, zones: changes }).blocks);
});
test("mission landmarks resolve separately from rooms and reject anchors outside the map", () => {
  const enriched = resolveWorldSpec({
    ...spec,
    zones: spec.zones.map((zone, i) =>
      i === 0 ? { ...zone, landmark: { actor: "TalDarimTower", offset: { x: 5, y: 7 } } } : zone,
    ),
  });
  const layout = planWorld(enriched);
  const { landmarks, chambers } = structureLayout(enriched, layout);
  assert.deepEqual(landmarks, [{ actor: "TalDarimTower", x: 15, y: 17 }]);
  assert.deepEqual(chambers, []);
  const unsafe = {
    ...enriched,
    zones: enriched.zones.map((zone, i) =>
      i === 0 ? { ...zone, landmark: { actor: "TalDarimTower", offset: { x: -10, y: 0 } } } : zone,
    ),
  };
  assert.throws(() => planWorld(unsafe), /WORLD_MISSION_LANDMARK_OUT_OF_BOUNDS/);
});
test("mission art plans vary trail width, blend both shores and keep a gap between cliff runs", () => {
  const mission = resolveWorldSpec({
    ...spec,
    width: 96,
    height: 96,
    zones: [
      { id: "Forest", biome: "natural", tileSet: "BelShir", anchor: { x: 0.5, y: 0 } },
      {
        id: "Court",
        biome: "engineered",
        tileSet: "Slayn",
        anchor: { x: 0.5, y: 0.82 },
        composition: {
          pockets: [{ center: { x: 64, y: 70 }, radius: 8 }],
          edges: [
            {
              actor: "Slayn_RockCliffTall",
              spacing: 4,
              height: 4,
              depth: 3,
              ledge: 6,
              points: [
                { x: 8, y: 56 },
                { x: 32, y: 56 },
              ],
            },
          ],
        },
      },
    ],
    starts: ["Forest"],
    objective: "Court",
    connections: [
      {
        from: "Forest",
        to: "Court",
        kind: "bridge",
        bankBoundary: true,
        width: 5,
        trail: [
          { at: 0, width: 8 },
          { at: 0.25, width: 2 },
          { at: 0.52, width: 5 },
          { at: 1, width: 5 },
        ],
        shoreline: {
          reach: 16,
          naturalRock: "BelShirDirtLight",
          builtRock: "Slayn2",
          rockActors: ["Rock"],
        },
      },
    ],
  });
  const layout = planWorld(mission);
  const structures = structureLayout(mission, layout);
  const [route] = layout.routes;
  const [bank] = structures.crossings;
  assert.ok(routeEdgeDistance({ x: 50, y: 10 }, route) < 0);
  assert.ok(routeEdgeDistance({ x: 50, y: 26 }, route) > 0);
  for (const side of [-1, 1]) {
    const near = shorelineWeight(bank, 46, bank.start + 4 + side * 5);
    const far = shorelineWeight(bank, 46, bank.start + 4 + side * 14);
    assert.ok(near > far && far > 0);
  }
  const water = waterOperations(mission, structures)[1];
  assert.equal(water.op, "water.create");
  assert.deepEqual(water.area, {
    type: "rectangle",
    minX: 0,
    minY: bank.start - 8,
    maxX: 96,
    maxY: bank.start + 16,
  });
  assert.deepEqual(structures.edges[0].area, {
    type: "rectangle",
    minX: 8,
    minY: 56,
    maxX: 32,
    maxY: 62,
  });
  const bad = structuredClone(mission);
  bad.zones[1].composition!.edges[0].points[1].x = 50;
  assert.throws(() => structureLayout(bad, planWorld(bad)), /EDGE_LEDGE_OVERLAPS_ROUTE/);
  const reversed = structuredClone(mission);
  reversed.connections[0].trail!.reverse();
  assert.throws(() => planWorld(reversed), /INVALID_TRAIL_PROFILE/);
});
test("river has a dry crossing and blocked adjacent cells", () => {
  const example = resolveWorldSpec({
    version: 1,
    name: "River",
    width: 64,
    height: 64,
    mode: "mission",
    seed: 22,
    zones: [
      { ...zones[0], anchor: { x: 0.5, y: 0 } },
      { ...zones[1], anchor: { x: 0.5, y: 1 } },
    ],
    starts: ["Z0"],
    objective: "Z1",
    connections: [{ from: "Z0", to: "Z1", kind: "bridge" }],
  });
  const structures = structureLayout(example, planWorld(example)),
    crossing = structures.crossings[0];
  const mask = worldPathing(example, structures);
  assert.equal(mask[4 + crossing.center.y * 64 + 32], 0);
  assert.equal(mask[4 + crossing.center.y * 64 + 40], 255);
});

test("a facility closes its perimeter around route openings and can face walls both ways", async () => {
  const key = (slot: number) => "SetA_" + slot;
  const input = {
    ...spec,
    width: 96,
    height: 96,
    landscape: "custom",
    zones: [
      { id: "Approach", biome: "natural", tileSet: "SetA", anchor: { x: 0.5, y: 0.16 } },
      {
        id: "Facility",
        biome: "engineered",
        tileSet: "SetA",
        anchor: { x: 0.5, y: 0.87 },
        materials: { ground: key(0), road: key(0), scatter: [key(0)] },
        composition: {
          pockets: [{ center: { x: 64, y: 69 }, radius: 4 }],
          edges: [
            {
              points: [
                { x: 64, y: 66 },
                { x: 64, y: 86 },
              ],
              actor: "Detail",
              spacing: 4,
              height: 0.25,
              depth: 0.5,
            },
          ],
        },
        facility: {
          wallFaces: "double",
          grounds: {
            min: { x: 30, y: 37 },
            max: { x: 90, y: 86 },
            floor: key(1),
            trim: key(2),
            exterior: key(0),
            perimeter: { actor: "Fence", spacing: 5, height: 2, depth: 1.8 },
            floorJoints: { actor: "Joint" },
          },
          spaces: [
            {
              id: "Court",
              role: "courtyard",
              center: { x: 48, y: 50 },
              width: 24,
              height: 16,
              floor: key(2),
              trim: key(3),
              walls: { actor: "Wall", sides: ["south", "north"] },
              partitions: [
                {
                  from: { x: 38, y: 51 },
                  to: { x: 58, y: 51 },
                  actor: "Wall",
                  opening: { at: 48, width: 5 },
                },
              ],
            },
            {
              id: "Lab",
              role: "lab",
              center: { x: 48, y: 76 },
              width: 24,
              height: 16,
              floor: key(4),
              trim: key(5),
              inlays: [{ min: { x: 39, y: 74 }, max: { x: 45, y: 80 }, floor: key(6) }],
              walls: { actor: "Wall", sides: ["south", "east", "north", "west"] },
            },
            {
              id: "Nursery",
              role: "organic",
              center: { x: 76, y: 55 },
              width: 20,
              height: 16,
              floor: key(6),
              shape: "ellipse",
              blend: 3,
            },
          ],
          passages: [
            {
              id: "Entry",
              from: { space: "Court", side: "south" },
              waypoints: [{ x: 48, y: 36 }],
              width: 6,
              floor: key(7),
              trim: key(3),
            },
            {
              id: "LabSide",
              from: { space: "Lab", side: "east" },
              waypoints: [{ x: 68, y: 76 }],
              width: 4,
              floor: key(7),
            },
            {
              id: "Hall",
              from: { space: "Court", side: "north" },
              to: { space: "Lab", side: "south" },
              width: 6,
              floor: key(7),
              trim: key(3),
            },
          ],
        },
      },
    ],
    connections: [{ from: "Approach", to: "Facility", kind: "road" }],
    starts: ["Approach"],
    objective: "Facility",
  };
  const mission = resolveWorldSpec(input);
  const layout = planWorld(mission);
  const structures = structureLayout(mission, layout);
  const state = parseState(
    compileWorldSurface(mission, layout, [
      {
        id: "SetA",
        cliffs: [],
        sourcePaths: [],
        textures: Array.from({ length: 8 }, (_, i) => key(i)),
      },
    ]).files,
  );
  const weight = (x: number, y: number, slot: number) =>
    state.masks!.weights(x * 8 + 1, y * 8 + 1)[slot];
  assert.equal(weight(44, 50, 2), 15);
  assert.equal(weight(36, 50, 3), 15);
  assert.equal(weight(50, 70, 4), 15);
  assert.equal(weight(41, 76, 6), 15);
  assert.equal(weight(31, 67, 1), 15);
  assert.equal(weight(30, 67, 2), 15);
  assert.equal(weight(29, 67, 0), 15);
  assert.equal(weight(48, 62, 7), 15);
  assert.equal(weight(76, 55, 6), 15);
  assert.ok(weight(68, 55, 6) > 0 && weight(68, 55, 6) < 15);
  const cells = worldPathing(mission, structures);
  assert.equal(cells[4 + 58 * 96 + 48], 0);
  assert.equal(cells[4 + 58 * 96 + 39], 255);
  assert.equal(cells[4 + 51 * 96 + 40], 255);
  assert.equal(cells[4 + 51 * 96 + 48], 0);
  assert.equal(cells[4 + 37 * 96 + 48], 0);
  assert.equal(cells[4 + 37 * 96 + 31], 255);
  assert.equal(cells[4 + 85 * 96 + 32], 255);
  assert.deepEqual(structures.perimeter.find((edge) => edge.side === "west")?.spans, [
    { from: 37, to: 86 },
  ]);
  const mock = {
    resolve: async ({ id }: { id: string }) => ({
      actor: { id },
      measured: {
        measurement: {
          dimensions: { width: 4, depth: 1, height: 2 },
          center: [0, 0, 1],
          bounds: { min: [-2, -0.5, 0], max: [2, 0.5, 2] },
        },
      },
    }),
  } as unknown as DecorPalette;
  const joints = traceFacilityFloorJoints(structures, state);
  assert.ok(
    joints.some(
      (joint) => !joint.vertical && joint.fixed === 74 && joint.from <= 40 && joint.to >= 44,
    ),
  );
  assert.ok(
    !joints.some(
      (joint) => joint.vertical && joint.fixed === 41 && joint.from <= 76 && joint.to >= 76,
    ),
  );
  const assembled = await structureObjects(structures, mock, (p) => ({ ...p, z: 4 }), joints);
  const [rear, front] = assembled.objects.filter((object) => object.catalogId === "Fence");
  assert.ok(assembled.floorJointObjects[0].count > 0);
  assert.equal(rear.catalogId, "Fence");
  assert.equal(front.position.x, rear.position.x);
  assert.ok(front.position.y < rear.position.y);
  assert.equal(Math.abs(front.rotation! - rear.rotation!), Math.PI);
  assert.ok(assembled.perimeterObjects.every((side) => side.sections === side.backFaces));
  assert.ok(assembled.facilityObjects.find((room) => room.space === "Court")!.backFaces > 0);
  const edging = assembled.objects.filter((object) => object.catalogId === "Detail");
  assert.equal(edging.length, 2);
  assert.ok(edging.every((object) => Math.abs(object.position.y - 76) > 5));
  assert.ok(edging.every((object) => object.position.z! + object.scale!.z * 2 > 4));
  const blocked = structuredClone(mission);
  blocked.zones[1].facility!.passages.shift();
  assert.throws(() => structureLayout(blocked, planWorld(blocked)), /FACILITY_BLOCKS_WORLD_ROUTE/);
});
test("facility terraces build a native rise and reserve stair lanes through the cliff rim", async () => {
  const mission = resolveWorldSpec({
    ...spec,
    width: 96,
    height: 96,
    landscape: "campaign",
    zones: [
      { id: "Entry", biome: "engineered", tileSet: "UmojaEx3", anchor: { x: 0.18, y: 0.14 } },
      {
        id: "Lab",
        biome: "engineered",
        tileSet: "UmojaEx3",
        anchor: { x: 0.3, y: 0.69 },
        facility: {
          spaces: [
            {
              id: "Floor",
              role: "lab",
              center: { x: 65, y: 61 },
              width: 32,
              height: 30,
              floor: "UmojaEx3_1",
            },
          ],
          terraces: [
            {
              id: "Deck",
              min: { x: 54, y: 56 },
              max: { x: 74, y: 70 },
              stairs: [{ side: "south", at: 65 }],
            },
          ],
        },
      },
    ],
    starts: ["Entry"],
    objective: "Lab",
    connections: [{ from: "Entry", to: "Lab", kind: "road" }],
  });
  const tiles = [
    {
      id: "UmojaEx3",
      cliffs: ["LabCliff1"],
      sourcePaths: [],
      textures: Array.from({ length: 8 }, (_, i) => "UmojaEx3_" + (i + 1)),
    },
  ];
  const layout = planWorld(mission);
  const campaign = await loadCampaignLandscape(mission, layout, tiles);
  const structures = structureLayout(mission, layout);
  const terrain = parseState(compileWorldSurface(mission, layout, tiles, campaign).files);
  assert.equal(terrain.descriptor.parsed.nodes.filter((node) => node.tag === "ramp").length, 1);
  assert.ok(Math.abs(terrain.heights.z(65, 61) - 6) < 0.01);
  assert.ok(Math.abs(terrain.heights.z(65, 49) - 4) < 0.01);
  const pathing = worldPathing(mission, structures);
  assert.equal(pathing[4 + 56 * 96 + 65], 0);
  assert.equal(pathing[4 + 56 * 96 + 59], 255);
  const offGrid = structuredClone(mission);
  offGrid.zones[1].facility!.terraces[0].stairs[0].at = 64;
  assert.throws(() => structureLayout(offGrid, planWorld(offGrid)), /FACILITY_STAIR_GRID/);
});
test("ladder produces mirrored banks and expansions with melee initialization", () => {
  const ladder = resolveWorldSpec({
    ...spec,
    mode: "ladder",
    dependencies: undefined,
    objective: undefined,
    starts: ["A", "B"],
    zones: [
      { ...zones[0], id: "A", anchor: { x: 0, y: 0 } },
      { ...zones[0], id: "B", anchor: { x: 1, y: 1 } },
    ],
    connections: [{ from: "A", to: "B", kind: "road" }],
  });
  const layout = planWorld(ladder);
  assert.equal(layout.expansions[0].x + layout.expansions[1].x, 64);
  assert.equal(layout.expansions[0].y + layout.expansions[1].y, 64);
  assert.equal(layout.counts[0], layout.counts[1]);
  assert.match(JSON.stringify(worldTriggers("ladder", [])), /MeleeInitUnits/);
  assert.match(
    JSON.stringify(worldTriggers("arcade", [1, 2], { x: 32, y: 32 })),
    /WorldControlScore2/,
  );
});

test("arcade gates open for either scout and only close when both leave", () => {
  const triggers = gateRequests([{ id: 18, position: { x: 10, y: 10 } }], [7, 9]);
  assert.deepEqual(
    triggers.map((t) => t.calls?.filter((c) => c.kind === "Condition").length),
    [1, 1, 2],
  );
  assert.match(JSON.stringify(triggers[2]), /SupplyDepotRaise/);
});

test("mission bridge can keep engineered terrain on the far bank", () => {
  const river = resolveWorldSpec({
    ...spec,
    zones: [
      { ...zones[0], biome: "natural", anchor: { x: 0.5, y: 0 } },
      { ...zones[1], anchor: { x: 0.5, y: 1 } },
    ],
    starts: ["Z0"],
    objective: "Z1",
    connections: [{ from: "Z0", to: "Z1", kind: "bridge", bankBoundary: true }],
  });
  const layout = planWorld(river);
  const [crossing] = structureLayout(river, layout).crossings;
  const boundary = crossing.start + 8;
  for (const [i, owner] of layout.blocks.entries())
    assert.equal(owner, Math.floor(i / 8) * 8 < boundary ? 0 : 1);
});

test("campaign styles plan stable native mesas and vary their contours by seed", async () => {
  const char = resolveWorldSpec({
    ...spec,
    mode: "mission",
    name: "Volcanic Shelf",
    width: 128,
    height: 128,
    zones: [
      { id: "Ash", tileSet: "Char", biome: "natural", anchor: { x: 0.28, y: 0.16 } },
      { id: "Ridge", tileSet: "Char", biome: "natural", anchor: { x: 0.65, y: 0.78 } },
    ],
    starts: ["Ash"],
    objective: "Ridge",
    connections: [{ from: "Ash", to: "Ridge", kind: "road", width: 5 }],
  });
  const sets = [
    {
      id: "Char",
      cliffs: ["CharCliff0", "CharCliff1"],
      sourcePaths: [],
      textures: [
        "CharDirtLight",
        "CharDirt",
        "CharDirtCracked",
        "CharSponge",
        "CharMud",
        "CharRock",
        "CharRedCracks",
        "CharLavaCracks",
      ],
    },
  ];
  const layout = planWorld(char);
  const first = (await loadCampaignLandscape(char, layout, sets))!;
  const secondSpec = { ...char, seed: char.seed + 1 };
  const second = (await loadCampaignLandscape(secondSpec, planWorld(secondSpec), sets))!;
  assert.deepEqual(first.decorBudget, { min: 45, max: 65 });
  assert.ok(first.zones.every((z) => z.profile === "lava" && z.roles.length === 3));
  assert.ok(first.features.some((f) => new Set(f.strokes.map((a) => a.maxX - a.minX)).size > 1));
  assert.notDeepEqual(first.features, second.features);
  assert.deepEqual(first, await loadCampaignLandscape(char, layout, sets));
  const surface = compileWorldSurface(char, layout, sets, first);
  assert.ok(parseState(surface.files).descriptor.parsed.nodes.some((n) => n.tag === "cc"));
  assert.ok(surface.paintedTextures.includes("CharLavaCracks"));
  assert.equal(campaignLandscapeEnabled({ ...char, landscape: "custom" }), false);
});

test("a forest crossing preserves softened shoulders, a raised laboratory and room floors", async () => {
  const anchor = (x: number, y: number) => ({ x: (x - 10) / 76, y: (y - 10) / 76 });
  const raised = resolveWorldSpec({
    ...spec,
    landscape: "campaign",
    width: 96,
    height: 96,
    zones: [
      { id: "Forest", biome: "natural", tileSet: "BelShir", anchor: anchor(31, 20) },
      {
        id: "Entry",
        biome: "engineered",
        tileSet: "UmojaEx3",
        anchor: anchor(31, 58),
        room: { width: 18, height: 14, floor: "UmojaEx3_3", trim: "UmojaEx3_4" },
      },
      {
        id: "Lab",
        biome: "engineered",
        tileSet: "UmojaEx3",
        anchor: anchor(69, 75),
        room: {
          width: 20,
          height: 14,
          floor: "UmojaEx3_5",
          trim: "UmojaEx3_4",
          doorActor: "UmojanLabDoors02",
        },
      },
    ],
    starts: ["Forest"],
    objective: "Lab",
    connections: [
      { from: "Forest", to: "Entry", kind: "bridge", bankBoundary: true, raisedBank: true },
      { from: "Entry", to: "Lab", kind: "door", waypoints: [{ x: 69, y: 58 }] },
    ],
  });
  const tiles = [
    {
      id: "BelShir",
      cliffs: ["BelShirOrganic"],
      sourcePaths: [],
      textures: [
        "BelShirDirtLight",
        "BelShirDirtDark",
        "BelShirBrush",
        "BelShirGrassLight",
        "BelShirGrassDark",
        "BelShirSmallTiles",
        "BelShirBricksSmall",
        "BelShirBricksLarge",
      ],
    },
    {
      id: "UmojaEx3",
      cliffs: ["UmojaManmade"],
      sourcePaths: [],
      textures: Array.from({ length: 8 }, (_, i) => "UmojaEx3_" + (i + 1)),
    },
  ];
  const layout = planWorld(raised);
  const campaign = await loadCampaignLandscape(raised, layout, tiles);
  const surface = parseState(compileWorldSurface(raised, layout, tiles, campaign).files);
  const layoutStructures = structureLayout(raised, layout);
  const [bank] = layoutStructures.embankments;
  assert.deepEqual(bank.center, { x: 31, y: 42 });
  assert.equal(layoutStructures.chambers[0].gates[1].x, 40);
  assert.deepEqual(layoutStructures.chambers[1].gates[0], {
    x: 69,
    y: 68,
    vertical: false,
    door: true,
    width: 5,
    doorActor: "UmojanLabDoors02",
  });
  assert.equal(surface.descriptor.parsed.nodes.filter((node) => node.tag === "ramp").length, 1);
  assert.ok(Math.abs(surface.heights.z(15, 42) - 4) < 0.001);
  assert.ok(Math.abs(surface.heights.z(15, 48) - 6) < 0.001);
  const weightAt = (x: number, y: number, slot: number) =>
    surface.masks!.weights(Math.floor(x * 8), Math.floor(y * 8))[slot];
  assert.equal(weightAt(31.5, 58.5, 2), 15);
  assert.equal(weightAt(39.5, 58.5, 3), 15);
  assert.equal(weightAt(60.5, 58.5, 1), 15);
  assert.equal(weightAt(69.5, 75.5, 4), 15);
  for (const side of [-1, 1]) {
    const shoulder = Array.from({ length: 64 }, (_, i) => weightAt(31 + (side * i) / 8, 26, 1));
    assert.ok(new Set(shoulder).size >= 9);
    assert.ok(shoulder.every((value, i) => i === 0 || Math.abs(value - shoulder[i - 1]) <= 2));
  }

  const taller = {
    ...raised,
    zones: raised.zones.map((zone) =>
      zone.id === "Entry" ? { ...zone, anchor: anchor(31, 66) } : zone,
    ),
    connections: raised.connections.map((edge) =>
      edge.raisedBank
        ? {
            ...edge,
            bankRise: 2,
            bankWallActor: "UmojanLabCliffWallsTall",
            bankCliffActors: ["UmojanLabWallCap", "UmojanLabMonitorWall"],
          }
        : edge,
    ),
  };
  const tallerLayout = planWorld(taller);
  const [higherBank] = structureLayout(taller, tallerLayout).embankments;
  assert.deepEqual(
    higherBank.steps.map((step) => [step.level, step.face, step.center.y]),
    [
      [2, 40, 40],
      [3, 44, 46],
    ],
  );
  assert.deepEqual(higherBank.cliffActors, ["UmojanLabWallCap", "UmojanLabMonitorWall"]);
  assert.ok(higherBank.steps.every((step) => step.wings.length === 2));
  assert.equal(higherBank.shoreline?.edge, 40);
  assert.equal(higherBank.shoreline?.opening, 31);
  const tallerCampaign = await loadCampaignLandscape(taller, tallerLayout, tiles);
  const higherSurface = parseState(
    compileWorldSurface(taller, tallerLayout, tiles, tallerCampaign).files,
  );
  assert.equal(
    higherSurface.descriptor.parsed.nodes.filter((node) => node.tag === "ramp").length,
    2,
  );
  for (const x of [15, 50]) {
    assert.ok(Math.abs(higherSurface.heights.z(x, 41) - 6) < 0.001);
    assert.ok(Math.abs(higherSurface.heights.z(x, 45) - 8) < 0.001);
  }

  const framed = {
    ...taller,
    zones: taller.zones.map((zone) =>
      zone.biome === "engineered"
        ? {
            ...zone,
            materials: { ...zone.materials, roadEdge: "UmojaEx3_4" },
          }
        : zone,
    ),
    connections: taller.connections.map((edge) =>
      edge.raisedBank
        ? {
            ...edge,
            bankRise: 1,
            bankLift: 1.1,
          }
        : edge,
    ),
  };
  const framedLayout = planWorld(framed);
  const [framedBank] = structureLayout(framed, framedLayout).embankments;
  assert.deepEqual(
    framedBank.steps.map(({ face, wings }) => [face, wings.length]),
    [[40, 0]],
  );
  assert.equal(framedBank.shoreline?.framedSingle, true);
  const framedCampaign = await loadCampaignLandscape(framed, framedLayout, tiles);
  const framedSurface = parseState(
    compileWorldSurface(framed, framedLayout, tiles, framedCampaign).files,
  );
  assert.equal(
    framedSurface.descriptor.parsed.nodes.filter((node) => node.tag === "ramp").length,
    1,
  );
  assert.equal(framedSurface.descriptor.blockSet(31, 39), 1);
  assert.equal(framedSurface.masks!.weights(31 * 8 + 4, 39 * 8 + 4)[1], 15);
  assert.equal(framedSurface.masks!.weights(31 * 8 + 4, 40 * 8 + 4)[1], 15);
  assert.equal(framedSurface.masks!.weights(28 * 8 + 4, 40 * 8 + 4)[3], 15);
  for (const x of [15, 50]) {
    assert.equal(framedSurface.heights.mask(x, 41) & 255, 2);
    assert.ok(Math.abs(framedSurface.heights.z(x, 41) - 7.1) < 0.001);
    assert.ok(Math.abs(framedSurface.heights.z(x, 45) - 7.1) < 0.001);
  }
});
