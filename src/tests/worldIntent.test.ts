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
