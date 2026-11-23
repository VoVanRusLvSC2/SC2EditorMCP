import assert from "node:assert/strict";
import test from "node:test";
import type { TerrainSet } from "../modules/document/codecs/flatTerrainFactory.js";
import { isCargoProp } from "../modules/world/cargo.js";
import { worldDecor } from "../modules/world/decor.js";
import type { DecorPalette } from "../modules/placement/decorPalette.js";
import type { TerrainState } from "../modules/terrain/operations.js";
import { planWorld, resolveWorldSpec } from "../modules/world/plan.js";
import { structureLayout, structureObjects } from "../modules/world/structures.js";
import { compileWorldIntent, worldIntent } from "../modules/world/intent.js";
import { StyleCatalog } from "../modules/placement/styleCatalog.js";
import { selectDecorCoverage } from "../modules/world/decorCoverage.js";
import { segmentDistance } from "../modules/terrain/geometry.js";

const palettes: TerrainSet[] = ["BelShir", "UmojaEx3", "Korhal"].map((id) => ({
  id,
  cliffs: [],
  sourcePaths: [],
  textures: Array.from({ length: 8 }, (_, i) => id + "_" + (i + 1)),
}));
const mission = worldIntent.parse({
  version: 1,
  name: "Forest to Laboratory",
  mode: "mission",
  width: 144,
  height: 144,
  zones: [
    { id: "Forest", biome: "natural", tileSet: "BelShir", sector: "south" },
    { id: "Lab", biome: "engineered", tileSet: "UmojaEx3", sector: "north", raised: true },
  ],
  links: [{ from: "Forest", to: "Lab", kind: "bridge" }],
  starts: ["Forest"],
  objective: "Lab",
  textureBudget: 16,
});

test("stock decor covers missions and training and guides automatic references", async () => {
  const catalog = new StyleCatalog();
  const lab = await catalog.query({ mission: "zlab02", limit: 3 });
  assert.ok("mission" in lab && lab.mission);
  assert.equal(lab.mission.types, 90);
  assert.equal(lab.mission.instances, 1212);
  assert.equal(lab.items[0].id, "Decal");
  assert.equal(lab.compositionRules?.marking?.placement, "layout");
  const evolution = await catalog.query({ section: "missions", query: "evolution" });
  const challenges = await catalog.query({ section: "missions", query: "challenge" });
  assert.ok("total" in evolution && "total" in challenges);
  assert.equal(evolution.total, 7);
  assert.equal(challenges.total, 9);

  const { spec, layout } = await compileWorldIntent(mission, 197, palettes);
  assert.equal(spec.decorReference, "auto");
  const automatic = await selectDecorCoverage(layout, spec.decorReference);
  const forest = automatic.zones.find((zone) => zone.id === "Forest")!;
  const laboratory = automatic.zones.find((zone) => zone.id === "Lab")!;
  assert.ok(
    forest.trainingSources.some(
      ({ mission, role }) => mission === "zevolutionroach" && role === "evolution",
    ),
  );
  assert.ok(forest.trainingSources.some(({ role }) => role === "challenge"));
  assert.equal(laboratory.reference?.mission, "zlab02");
  assert.equal(laboratory.reference?.match, "family");
  assert.equal(automatic.minimum, laboratory.reference?.eligibleTypes);
  const explicit = await selectDecorCoverage(layout, "zevolutionroach");
  assert.equal(
    explicit.zones.find((zone) => zone.id === "Forest")?.reference?.mapRole,
    "evolution",
  );
  assert.equal(explicit.zones.find((zone) => zone.id === "Forest")?.reference?.match, "requested");
  await assert.rejects(
    selectDecorCoverage(layout, "zstorylab"),
    /WORLD_DECOR_REFERENCE_UNAVAILABLE/,
  );
});

test("one mission brief produces repeatable and distinct routes, crossings and interiors", async () => {
  const seeds = [197, 317, 911];
  const designs = await Promise.all(
    seeds.map((seed) => compileWorldIntent(mission, seed, palettes)),
  );
  assert.deepEqual(designs[0], await compileWorldIntent(mission, seeds[0], palettes));
  const distinct = (select: (layout: (typeof designs)[number]) => unknown) =>
    new Set(designs.map((layout) => JSON.stringify(select(layout)))).size;
  assert.equal(
    distinct(({ structures }) => structures.crossings[0].center),
    3,
  );
  assert.equal(
    distinct(({ layout }) => layout.routes[0].points.slice(1, -1)),
    3,
  );
  assert.equal(
    distinct(({ structures }) =>
      structures.facility.spaces.map((room) => [room.role, room.center]),
    ),
    3,
  );
  assert.ok(
    distinct(({ structures }) =>
      structures.facility.passages.map((p) => p.ports.map((port) => port.space.role)),
    ) >= 2,
  );
  for (const { layout, structures } of designs) {
    assert.ok(layout.routes[0].trail);
    assert.equal(structures.perimeter.filter((edge) => edge.spans.length === 2).length, 1);
    assert.equal(structures.facility.terraces[0].stairs.length, 1);
    const storage = structures.facility.spaces.find((space) => space.role === "storage")!;
    const cargo = storage.fixtures.filter((fixture) => isCargoProp(fixture.actor));
    assert.equal(
      cargo.reduce((count, row) => count + row.count, 0),
      7,
    );
    assert.ok(new Set(cargo.map(({ inset }) => inset)).size > 1);
    assert.equal(storage.cargoBays?.[0].kind, "freight");
    assert.ok(storage.fixtures.some(({ actor }) => actor === "LandingLights"));
  }
  await assert.rejects(
    compileWorldIntent({ ...mission, textureBudget: 8 }, 197, palettes),
    /WORLD_INTENT_TEXTURE_BUDGET/,
  );
});

test("city defaults reserve a main street and distinct uses of adjoining blocks", async () => {
  const request = worldIntent.parse({
    ...mission,
    name: "City",
    zones: [
      mission.zones[0],
      { id: "Lab", biome: "engineered", tileSet: "Korhal", sector: "north", layout: "city" },
    ],
  });
  const { structures } = await compileWorldIntent(request, 197, palettes);
  assert.equal(structures.facility.spaces[0].id, "MainStreet");
  assert.ok(
    structures.facility.spaces.some(
      (space) => space.id !== "MainStreet" && space.role === "courtyard",
    ),
  );
});

test("room passports fit role-specific modules around aisles and on a raised work surface", async () => {
  const request = worldIntent.parse({
    ...mission,
    zones: [
      mission.zones[0],
      {
        ...mission.zones[1],
        rooms: [
          { role: "lab", activity: "containment", placement: "upper", density: "busy" },
          { role: "command", activity: "briefing", placement: "island" },
          "storage",
          { role: "production", condition: "abandoned" },
        ],
      },
    ],
  });
  const { structures } = await compileWorldIntent(request, 317, palettes);
  const deck = structures.facility.terraces[0].area;
  const terrace = structures.facility.terraces[0];
  const stair = terrace.stairs[0];
  assert.equal(terrace.faceStyle, "square");
  const across = stair.side === "north" || stair.side === "south" ? "x" : "y";
  assert.equal(
    stair.at,
    across === "x" ? (deck.minX + deck.maxX) / 2 : (deck.minY + deck.maxY) / 2,
  );
  const deckInsets = structures.facility.spaces.find(({ role }) => role === "lab")!.inlays[0];
  const deckBuffer = {
    south: deckInsets.min.y - deck.minY,
    north: deck.maxY - deckInsets.max.y,
    west: deckInsets.min.x - deck.minX,
    east: deck.maxX - deckInsets.max.x,
  };
  assert.equal(deckBuffer[structures.facility.terraces[0].stairs[0].side], 2);
  assert.ok(structures.facility.grounds[0].floorJoints);
  assert.ok(structures.facility.passages.every(({ threshold }) => !threshold));
  assert.equal(structures.facility.spaces[0].trim, structures.facility.spaces[0].floor);
  const mock = {
    resolveAsset: async (id: string) => ({ actor: { id } }),
    resolve: async ({ id, variation }: { id: string; variation: number }) => {
      const halfSize = id === "LandingLights" ? 0.1 : 0.5;
      const longPanel = id === "UmojanLabWallConsoles";
      const halfWidth = longPanel ? 2.12 + variation * 0.03 : halfSize;
      const halfDepth = longPanel ? (variation === 2 ? 2.25 : 0.65) : halfSize;
      const pivot = longPanel ? variation * 0.12 : 0;
      return {
        actor: { id },
        variation,
        variants: longPanel ? ["monitor_00.m3", "monitor_01.m3", "monitor_02.m3"] : [],
        measured: {
          measurement: {
            center: [0, 0, 0.5],
            bounds: {
              min: [pivot - halfWidth, -halfDepth, 0],
              max: [pivot + halfWidth, halfDepth, 1],
            },
            dimensions: { width: 2 * halfWidth, depth: 2 * halfDepth, height: 1 },
          },
        },
      };
    },
    catalog: { pack: async () => ({ sections: { decor: [] } }) },
  } as unknown as DecorPalette;
  const built = await structureObjects(structures, mock, (p) => ({
    ...p,
    z: p.x >= deck.minX && p.x <= deck.maxX && p.y >= deck.minY && p.y <= deck.maxY ? 6 : 4,
  }));
  assert.equal(built.roomCompositions.length, 5);
  const chamber = built.roomCompositions.find(({ activity }) => activity === "containment")!;
  assert.equal(chamber.fitted[0].actor, "UmojanLabZergChamberLarge");
  assert.equal(chamber.fitted[0].position.z, 4);
  assert.ok(chamber.workApproach);
  assert.ok(chamber.secondaryApproach);
  const lowerBench = chamber.fitted.find(({ slot }) => slot === "labBench")!;
  assert.equal(lowerBench.actor, "UmojanLabDissectionTable");
  assert.equal(lowerBench.position.z, 4);
  const lowerConsole = chamber.fitted.find(({ slot }) => slot === "console")!;
  assert.equal(lowerConsole.position.z, 4);
  const analysis = chamber.fitted.filter(({ slot }) => slot === "analysisConsole");
  assert.equal(analysis.length, 3);
  assert.ok(analysis.every(({ actor }) => actor === "UmojanLabWallConsoles"));
  assert.deepEqual(
    analysis.map(({ variation }) => variation),
    [0, 1, 0],
  );
  const low = across === "x" ? "minX" : "minY";
  const high = across === "x" ? "maxX" : "maxY";
  const bank = analysis.map(({ operator }) => operator!.footprint).sort((a, b) => a[low] - b[low]);
  const bankWidth = bank.at(-1)![high] - bank[0][low];
  assert.ok(bankWidth > (deck[high] - deck[low]) * 0.9);
  for (let i = 1; i < bank.length; i++)
    assert.ok(Math.abs(bank[i][low] - bank[i - 1][high] - 0.2) < 1e-6);
  const sideConsoles = chamber.fitted.filter(({ slot }) => slot === "sideConsole");
  assert.equal(sideConsoles.length, 2);
  assert.ok(
    sideConsoles.every(
      ({ actor, position }) =>
        actor === "UmojanLabMonitorFloor" &&
        position.z === 6 &&
        Math.abs(position[across] - stair.at) > Math.abs(analysis[0].position[across] - stair.at),
    ),
  );
  const chamberSpace = structures.facility.spaces.find(({ id }) => id === chamber.space)!;
  const { position: anchor, rotation } = chamber.fitted[0];
  const center = chamberSpace.center;
  const towardInterior =
    (center.x - anchor.x) * Math.sin(rotation) - (center.y - anchor.y) * Math.cos(rotation);
  assert.ok(towardInterior > 0 && Math.abs(Math.sin(2 * rotation)) < 1e-6);
  assert.ok((anchor[across] - center[across]) * (lowerBench.position[across] - center[across]) < 0);
  const rearAxis = across === "x" ? "y" : "x";
  assert.ok(
    (anchor[rearAxis] - center[rearAxis]) *
      (stair.direction === "north" || stair.direction === "east" ? 1 : -1) >
      0,
  );
  assert.ok(analysis.every(({ position }) => position.z === 6));
  assert.equal(
    new Set(analysis.map(({ position }) => (across === "x" ? position.y : position.x))).size,
    1,
  );
  assert.equal(chamber.stairLights.length, 2);
  assert.deepEqual(
    chamber.stairLights.map((pair) => pair[0].z),
    [4, 6],
  );
  for (const [left, right] of chamber.stairLights) {
    assert.equal(left.z, right.z);
    assert.ok(Math.abs((left[across] + right[across]) / 2 - stair.at) < 1e-6);
  }
  assert.ok(built.roomCompositions.find(({ activity }) => activity === "briefing")?.workApproach);
  assert.ok(built.roomCompositions.every(({ fit }) => fit === "placed"));
  const power = built.roomCompositions.find(({ activity }) => activity === "power")!;
  assert.equal(power.lightRuns.length, 0);
  assert.equal(power.stairLights.length, 0);
  assert.ok(power.fitted.every(({ slot }) => slot !== "pathLight"));
  assert.ok(chamber.lightRuns.length + chamber.entryLights.length > 0);
  assert.ok(chamber.fitted.filter(({ slot }) => slot === "sampleStation").length >= 4);
  assert.ok(chamber.fitted.some(({ slot }) => slot === "sampleAux"));
  const gallery = built.roomCompositions.find(({ activity }) => activity === "circulation")!;
  const gallerySpace = structures.facility.spaces.find(({ id }) => id === gallery.space)!;
  const tallGallery = gallerySpace.height > gallerySpace.width;
  const axis = tallGallery ? "x" : "y";
  const roadHalfWidth = (tallGallery ? gallerySpace.width : gallerySpace.height) / 2;
  assert.ok(gallery.galleryLights.length >= 2);
  for (const [a, b] of gallery.galleryLights) {
    assert.equal(a[tallGallery ? "y" : "x"], b[tallGallery ? "y" : "x"]);
    assert.equal((a[axis] + b[axis]) / 2, gallerySpace.center[axis]);
    assert.ok(Math.abs(a[axis] - gallerySpace.center[axis]) > roadHalfWidth);
  }
  assert.equal(gallery.postOutline?.length, 8);
  assert.equal(gallery.postDecal?.actor, "Terran_Target_Splat");
  assert.ok(built.objects.some(({ catalogId }) => catalogId === gallery.postDecal?.actor));
  assert.ok(gallery.fitted.filter(({ slot }) => slot === "postSupply").length >= 2);
  const caps = built.objects.filter(
    ({ catalogId, scale }) => catalogId === terrace.faceActor && scale?.z === 0.16,
  );
  assert.ok(caps.length >= 2);
  const cross = across === "x" ? "y" : "x";
  assert.equal(new Set(caps.map(({ position }) => position[cross])).size, 1);
  const expectedCapAngle =
    (across === "x" ? 0 : Math.PI / 2) +
    (stair.side === "east" || stair.side === "south" ? 0 : Math.PI);
  assert.ok(caps.every(({ rotation }) => rotation === expectedCapAngle));
  for (const report of built.roomCompositions) {
    const planned = structures.facility.spaces.find(({ id }) => id === report.space)!;
    assert.ok(planned.aisles?.length);
    assert.deepEqual(
      report.fitted.filter(({ slot }) => slot === "pathLight").map(({ position }) => position),
      [
        ...report.stairLights.flat(),
        ...report.entryLights.flat(),
        ...report.galleryLights.flat(),
        ...report.lightRuns.flatMap(({ positions }) => positions),
      ],
    );
    for (const { from, to, spacing, positions } of report.lightRuns) {
      assert.ok(positions.length >= 2);
      for (const [i, point] of positions.slice(1).entries()) {
        const previous = positions[i];
        const dx = point.x - previous.x,
          dy = point.y - previous.y;
        assert.ok(Math.abs(Math.hypot(dx, dy) - spacing) < 1e-6);
        assert.ok(Math.abs(dx * (to.y - from.y) - dy * (to.x - from.x)) < 1e-6);
      }
    }
    assert.ok(
      report.fitted.every(
        ({ actor }) => actor !== "UmojanLabConsoleSmall" && actor !== "UmojanLabAlarms",
      ),
    );
    const consoles = report.fitted.flatMap(({ operator, position, slot }) =>
      operator ? [{ ...operator, z: position.z, slot }] : [],
    );
    for (const [i, current] of consoles.entries()) {
      const b = current.footprint,
        a = current.approach;
      const workingSide = {
        north: a.minY >= b.maxY,
        south: a.maxY <= b.minY,
        west: a.maxX <= b.minX,
        east: a.minX >= b.maxX,
      };
      assert.ok(workingSide[current.front]);
      for (const other of consoles
        .slice(0, i)
        .filter((item) => Math.abs(item.z - current.z) < 0.75)) {
        const c = other.footprint;
        const sameBank = current.slot === "analysisConsole" && other.slot === current.slot;
        assert.ok(
          Math.hypot(
            Math.max(0, b.minX - c.maxX, c.minX - b.maxX),
            Math.max(0, b.minY - c.maxY, c.minY - b.maxY),
          ) >=
            (sameBank ? 0.2 : 3) - 1e-6,
        );
      }
    }
    assert.ok(
      report.fitted.every(({ position }) =>
        planned.aisles!.every(
          ({ from, to, width }) => segmentDistance(position, from, to) > width / 2,
        ),
      ),
    );
  }
});

test("ladder and arcade briefs use their existing mode-specific constraints", async () => {
  const common = {
    version: 1,
    name: "Opposite sides",
    width: 144,
    height: 144,
    zones: [
      { id: "One", biome: "natural", tileSet: "BelShir", sector: "west" },
      { id: "Two", biome: "natural", tileSet: "BelShir", sector: "east" },
      { id: "Middle", biome: "natural", tileSet: "BelShir", sector: "center" },
    ],
    links: [
      { from: "One", to: "Middle" },
      { from: "Two", to: "Middle" },
    ],
    starts: ["One", "Two"],
  };
  const ladder = await compileWorldIntent(
    worldIntent.parse({
      ...common,
      mode: "ladder",
      zones: [common.zones[0], { ...common.zones[1], mirrorOf: "One" }, common.zones[2]],
    }),
    197,
    palettes,
  );
  assert.equal(ladder.layout.zones[0].center.x + ladder.layout.zones[1].center.x, 144);
  assert.equal(ladder.layout.expansions.length, 2);
  const arcade = await compileWorldIntent(
    worldIntent.parse({
      ...common,
      mode: "arcade",
      objective: "Middle",
    }),
    197,
    palettes,
  );
  assert.equal(arcade.spec.objective, "Middle");
  assert.equal(arcade.layout.routes.length, 2);
});

test("engineered zones keep cargo props out of ambient scatter", async () => {
  assert.ok(!isCargoProp("Blast_Craters"));
  assert.ok(isCargoProp("JarbanMinor_Pallete_Large"));
  const { spec: generated } = await compileWorldIntent(mission, 197, palettes);
  const spec = resolveWorldSpec({
    ...generated,
    zones: generated.zones.map((zone) =>
      zone.biome === "engineered" ? { ...zone, distinctActors: 1, actors: ["Crate"] } : zone,
    ),
  });
  const layout = planWorld(spec);
  const attempts: string[] = [];
  const palette = {
    resolve: (selector: { id: string }) => {
      attempts.push(selector.id);
      throw Error("unexpected asset lookup");
    },
  } as unknown as DecorPalette;
  await assert.rejects(
    worldDecor(spec, layout, structureLayout(spec, layout), palette, {} as TerrainState),
    /WORLD_DECOR_QUOTA/,
  );
  assert.deepEqual(attempts, []);
});

test("measured workstation fixtures leave an authored aisle clear", async () => {
  const map = {
    version: 1,
    mode: "mission",
    name: "Work aisle",
    width: 64,
    height: 64,
    seed: 1,
    zones: [
      { id: "Entry", biome: "natural", tileSet: "SetA", anchor: { x: 0.2, y: 0.1 } },
      {
        id: "Lab",
        biome: "engineered",
        tileSet: "SetA",
        anchor: { x: 0.2, y: 0.8 },
        facility: {
          spaces: [
            {
              id: "Workbench",
              role: "lab",
              center: { x: 44, y: 46 },
              width: 16,
              height: 16,
              floor: "SetA_1",
              workstations: [{ kind: "experiment", side: "south" }],
            },
          ],
        },
      },
    ],
    starts: ["Entry"],
    objective: "Lab",
    connections: [{ from: "Entry", to: "Lab", kind: "road" }],
  };
  const mock = {
    resolve: async ({ id }: { id: string }) => ({
      actor: { id },
      measured: { measurement: { dimensions: { width: 1, depth: 1, height: 1 } } },
    }),
  } as unknown as DecorPalette;
  const build = (
    aisles: { from: { x: number; y: number }; to: { x: number; y: number }; width: number }[],
    briefing = false,
  ) => {
    const spec = resolveWorldSpec({
      ...map,
      zones: map.zones.map((zone) =>
        zone.facility
          ? {
              ...zone,
              facility: {
                spaces: zone.facility.spaces.map((space) => ({
                  ...space,
                  aisles,
                  ...(briefing
                    ? {
                        workstations: undefined,
                        roomComposition: { focus: { kind: "briefing", side: "north" } },
                      }
                    : {}),
                })),
              },
            }
          : zone,
      ),
    });
    return structureObjects(structureLayout(spec, planWorld(spec)), mock, (p) => ({ ...p, z: 4 }));
  };
  const atNorth = await build([{ from: { x: 39, y: 51 }, to: { x: 49, y: 51 }, width: 3 }]);
  assert.equal(atNorth.facilityObjects[0].fixtures, 4);
  await assert.rejects(
    build([{ from: { x: 39, y: 43 }, to: { x: 49, y: 43 }, width: 3 }]),
    /WORLD_FACILITY_FIXTURE_CLEARANCE: Workbench\/UmojanLabDissectionTable/,
  );
  const briefing = await build([], true);
  assert.deepEqual(
    briefing.objects
      .filter((prop) => prop.scale)
      .map(({ catalogId, scale }) => ({ catalogId, scale })),
    [{ catalogId: "UmojanLabHoloProjector", scale: { x: 1.3, y: 1.3, z: 1.3 } }],
  );
  await assert.rejects(
    build([{ from: { x: 39, y: 48 }, to: { x: 49, y: 48 }, width: 2.4 }], true),
    /WORLD_FACILITY_FIXTURE_CLEARANCE: Workbench\/UmojanLabHoloProjector/,
  );
});

test("Nova preserves one dark lab brief across distinct room and passage layouts", async () => {
  const set: TerrainSet = {
    id: "BlackopsLab_A",
    cliffs: [],
    sourcePaths: [],
    textures: Array.from({ length: 8 }, (_, i) => "BlackOpsLabA" + (i + 1)),
  };
  const request = worldIntent.parse({
    version: 1,
    name: "Nova research annex",
    mode: "mission",
    width: 128,
    height: 128,
    zones: [
      { id: "Access", biome: "engineered", tileSet: set.id, sector: "south", layout: "open" },
      {
        id: "NovaLab",
        biome: "engineered",
        tileSet: set.id,
        sector: "north",
        rooms: [
          { role: "lab", activity: "containment", placement: "upper" },
          { role: "command", activity: "briefing" },
          { role: "storage", activity: "sorting" },
          { role: "production", activity: "power" },
        ],
      },
    ],
    links: [{ from: "Access", to: "NovaLab" }],
    starts: ["Access"],
    objective: "NovaLab",
  });
  const seeds = [197, 317, 911];
  const layouts = await Promise.all(seeds.map((seed) => compileWorldIntent(request, seed, [set])));
  assert.deepEqual(layouts[0], await compileWorldIntent(request, seeds[0], [set]));
  const graphs = layouts.map(({ spec, structures: { facility } }) => {
    assert.deepEqual(spec.decorBudget, { min: 45, max: 65 });
    assert.equal(facility.grounds[0].floorJoints?.actor, "DOM_GroundTrims");
    assert.notEqual(facility.spaces[0].trim, facility.spaces[0].floor);
    const lab = facility.spaces.find(({ role }) => role === "lab")!;
    assert.equal(lab.walls?.actor, "DOM_LabGlassWalls");
    assert.equal(lab.inlays.length, 1);
    assert.equal(facility.terraces[0].stairs.length, 1);
    return facility.passages.map(({ ports }) => ports.map(({ space }) => space.role));
  });
  assert.equal(new Set(graphs.map((graph) => JSON.stringify(graph))).size, 3);
});

test("constructed Aiur and Slayn reserve separate functional pads and trim families", async () => {
  for (const [tileSet, pattern, decoration, joint] of [
    ["Aiur4City", "Aiur4City", "garden", "Protoss_Base_GroundTrim"],
    ["SlaynTemple", "Slayn", "ritual", "Slayn_Road_Inlay"],
  ] as const) {
    const set: TerrainSet = {
      id: tileSet,
      cliffs: [],
      sourcePaths: [],
      textures: Array.from({ length: 8 }, (_, i) => pattern + (i + 1)),
    };
    const request = worldIntent.parse({
      version: 1,
      name: "Protoss settlement",
      mode: "mission",
      width: 128,
      height: 128,
      zones: [
        { id: "Approach", biome: "engineered", tileSet, sector: "south", layout: "open" },
        { id: "Site", biome: "engineered", tileSet, sector: "north" },
      ],
      links: [{ from: "Approach", to: "Site" }],
      starts: ["Approach"],
      objective: "Site",
    });
    const {
      structures: { facility },
    } = await compileWorldIntent(request, 197, [set]);
    assert.equal(facility.grounds[0].floorJoints?.actor, joint);
    assert.ok(
      facility.spaces.some(
        ({ roomComposition }) =>
          roomComposition &&
          "activity" in roomComposition &&
          roomComposition.activity === decoration,
      ),
    );
  }
});

test("a compact facility brief changes its circulation topology without losing room access", async () => {
  for (const [tileSet, texture, layout] of [
    ["BlackopsLab_A", "BlackOpsLabA", "lab"],
    ["Aiur4City", "Aiur4City", "base"],
  ] as const) {
    const set: TerrainSet = {
      id: tileSet,
      cliffs: [],
      sourcePaths: [],
      textures: Array.from({ length: 8 }, (_, i) => texture + (i + 1)),
    };
    for (const sector of ["south", "east", "north", "west"] as const) {
      const intent = worldIntent.parse({
        version: 1,
        name: "Compact facility",
        mode: "mission",
        width: 64,
        height: 64,
        zones: [
          { id: "Arrival", biome: "engineered", tileSet, sector, layout: "open" },
          { id: "Facility", biome: "engineered", tileSet, sector: "center", layout },
        ],
        links: [{ from: "Arrival", to: "Facility" }],
        starts: ["Arrival"],
        objective: "Facility",
        decorBudget: { min: 45, max: 65 },
      });
      for (const [seed, id] of [
        [198, "MainGallery"],
        [199, "CrossHall"],
        [200, "CentralCourt"],
      ] as const) {
        const result = await compileWorldIntent(intent, seed, [set]);
        const { spaces, passages } = result.structures.facility;
        assert.deepEqual(result.spec.decorBudget, { min: 45, max: 65 });
        assert.equal(spaces[0].id, id);
        assert.equal(spaces.length, 5);
        assert.equal(passages.length, 5);
        assert.equal(passages[0].ports[0].side, sector);
        assert.deepEqual(
          passages.slice(1).map((pass) => pass.ports[1].space.id),
          ["Room1", "Room2", "Room3", "Room4"],
        );
        for (const pass of passages.slice(1)) {
          const room = pass.ports[1].space;
          assert.equal(room.openings.length, 1);
          assert.ok(room.aisles?.length);
          assert.equal(
            room.roomComposition &&
              "activity" in room.roomComposition &&
              room.roomComposition.tileSet,
            tileSet,
          );
        }
      }
    }
  }
});
