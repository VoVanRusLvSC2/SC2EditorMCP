import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorldSpec, planWorld } from "../modules/world/plan.js";
import { compileWorldSurface } from "../modules/world/surface.js";
import { parseState } from "../modules/terrain/operations.js";
import { worldPathing, structureLayout, gateRequests } from "../modules/world/structures.js";
import { worldTriggers } from "../modules/world/gameplay.js";

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
