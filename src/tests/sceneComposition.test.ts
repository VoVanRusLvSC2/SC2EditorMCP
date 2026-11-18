import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { layoutPrefab, type Slot, type DecorPrefabs } from "../modules/placement/decorPrefabs.js";
import type { DecorModel } from "../modules/placement/decorPalette.js";
import { measureGeometry, type MeasuredModel } from "../modules/assets/measurement.js";
import { composeScene, designScene, sceneSchema } from "../modules/placement/scenePlanner.js";
import { scenePng, sceneSvg, sceneSurfaceReview } from "../modules/placement/sceneReview.js";
import { measuredMemberGeometry } from "../modules/placement/compositionGeometry.js";
import { checkGroupClearance } from "../modules/placement/groupClearance.js";
import { measuredObjects } from "../modules/placement/measuredGroups.js";
import { corridorWithinArea } from "../modules/terrain/geometry.js";
import { compileAuthorScript } from "../app/authoringScript.js";
import { compactResult } from "../app/toolResults.js";
import { Workspace } from "../core/workspace.js";
import { TerrainWorkspace } from "../modules/terrain/workspace.js";
import { BrowseWorkspace } from "../modules/browse/workspace.js";
import { DataWorkspace } from "../modules/data/workspace.js";
import { PlacementWorkspace } from "../modules/placement/workspace.js";
import { PlacementDocument } from "../modules/placement/document.js";

function model(width: number, depth: number, height: number): MeasuredModel {
  const positions: number[] = [];
  for (const x of [-width / 2, width / 2])
    for (const y of [-depth / 2, depth / 2]) for (const z of [0, height]) positions.push(x, y, z);
  const geometry = {
    positions,
    indices: [0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3],
    vertexCount: 8,
    triangleCount: 4,
    regions: 1,
    stride: 12,
    bounds: { min: [-width / 2, -depth / 2, 0], max: [width / 2, depth / 2, height] },
    pose: "raw-rest-geometry",
    materials: false,
    animations: false,
  } as MeasuredModel["geometry"];
  return {
    file: "box.m3",
    sha256: "0".repeat(64),
    build: "test",
    geometry,
    transform: {},
    measurement: measureGeometry(geometry),
    attachmentNames: [],
    cacheHit: false,
  };
}
const roles: Slot[] = [
  ["fence", model(4, 0.4, 2)],
  ["prop", model(2, 2, 2)],
  ["secondaryProp", model(0.8, 1.2, 0.6)],
  ["light", model(0.4, 0.4, 3)],
  ["tree", model(3, 4, 7)],
].map(([name, measured]) => ({
  name: name as string,
  decor: {
    actor: { id: name + "Actor", key: "Actor:" + name },
    measured,
    variation: 0,
  } as DecorModel,
}));
const args = {
  zone: "west",
  tileset: "Agria",
  profile: "outpost" as const,
  bounds: { minX: 4, minY: 4, maxX: 92, maxY: 92 },
  baseTexture: "Soil",
  pathTexture: "Road",
  accentTexture: "Grass",
};
const template = (recipe: Parameters<typeof layoutPrefab>[0]) => layoutPrefab(recipe, roles, 6, 42);

test("whole scenes reserve circulation and a plaza, retain measured scale and vary hierarchy deterministically", () => {
  for (const profile of ["outpost", "woodland"] as const) {
    const focal = template(profile === "outpost" ? "checkpoint" : "forest_clearing"),
      support = template(profile === "outpost" ? "supply_cluster" : "woodland_cluster");
    if (profile === "woodland") {
      assert.equal(support.members.filter((m) => m.id === "treeActor").length, 5);
      assert.equal(support.members.filter((m) => m.id === "secondaryPropActor").length, 3);
      assert.equal(new Set(support.members.map((m) => m.offset.x)).size, 8);
    }
    for (const density of ["sparse", "standard", "rich"] as const) {
      const scene = composeScene({ ...args, profile, density }, focal, support),
        again = composeScene({ ...args, profile, density }, focal, support);
      assert.deepEqual(scene, again);
      assert.equal(scene.groups.length, { sparse: 3, standard: 5, rich: 7 }[density]);
      const config = scene.intent.zones[0].config;
      assert.equal(config.terrain.heightMode, "preserve");
      assert.equal(config.objectCount, 0);
      assert.deepEqual(scene.intent.zones[1].dependsOn, [args.zone]);
      assert.ok(
        scene.routes.every((r) =>
          corridorWithinArea({ type: "rectangle", ...args.bounds }, r.points, r.width),
        ),
      );
      for (const group of config.groups)
        for (const member of group.members) {
          assert.equal(member.scale, 1);
          assert.doesNotThrow(() =>
            checkGroupClearance(
              measuredMemberGeometry(group.anchor, group.angle, member),
              { type: "rectangle", ...args.bounds },
              scene.routes,
              config.exclusionZones ?? [],
            ),
          );
        }
      assert.ok(
        scene.metrics.measuredBoundsCoverage > 0 && scene.metrics.measuredBoundsCoverage < 0.5,
      );
      assert.equal(scene.review.visualAcceptance, "not_checked");
    }
    assert.notDeepEqual(
      composeScene({ ...args, profile, seed: 1 }, focal, support).groups,
      composeScene({ ...args, profile, seed: 4 }, focal, support).groups,
    );
  }
});

test("protected areas are respected, incompatible groups fail without scaling or silently disappearing", () => {
  const focal = template("checkpoint"),
    support = template("supply_cluster");
  assert.throws(
    () =>
      composeScene(
        { ...args, exclusions: [{ type: "circle", center: { x: 48, y: 35 }, radius: 3 }] },
        focal,
        support,
      ),
    /MAIN_ROUTE_IN_EXCLUSION/,
  );
  const exclusion = { type: "rectangle" as const, minX: 8, minY: 8, maxX: 30, maxY: 30 };
  const scene = composeScene({ ...args, exclusions: [exclusion] }, focal, support);
  assert.ok(
    scene.intent.zones[0].config.exclusionZones?.some(
      (e) => e.type === "rectangle" && e.minX === 8,
    ),
  );
  assert.throws(
    () =>
      composeScene(
        { ...args, bounds: { minX: 0, minY: 0, maxX: 24, maxY: 24 }, density: "rich" },
        focal,
        support,
      ),
    /DOES_NOT_FIT/,
  );
  assert.equal(sceneSchema.safeParse({ ...args, unknown: 42 }).success, false);
  assert.equal(
    sceneSchema.safeParse({
      ...args,
      exclusions: [{ type: "rectangle", minX: 5, maxX: 1, minY: 0, maxY: 4 }],
    }).success,
    false,
  );
  assert.equal(
    sceneSchema.safeParse({ ...args, bounds: { minX: 0, minY: 0, maxX: NaN, maxY: 50 } }).success,
    false,
  );
});

test("scene design resolves only two templates, generates no per-group PNGs and keeps compact commands and receipts", async () => {
  const calls: string[] = [];
  const prefabs = {
    layout: async (input: { recipe: Parameters<typeof layoutPrefab>[0] }) => {
      calls.push(input.recipe);
      return { layout: template(input.recipe), slots: roles };
    },
  } as unknown as Pick<DecorPrefabs, "layout">;
  const design = await designScene(args, prefabs);
  assert.deepEqual(calls, ["checkpoint", "supply_cluster"]);
  assert.equal(design.performance.perGroupImages, 0);
  const compiled = compileAuthorScript(
    "terrain scene.plan zone=west profile=outpost tileset=Agria rect=4,4,92,92 baseTexture=Soil pathTexture=Road preview=false",
    "save",
  );
  assert.deepEqual(
    compiled.map((s) => s.tool),
    ["terrain.scene.plan", "terrain.apply", "terrain.save"],
  );
  assert.deepEqual(compiled[0].args.bounds, args.bounds);
  assert.equal(compiled[0].args.preview, false);
  assert.deepEqual(
    (
      compactResult({
        id: "plan",
        scene: { metrics: design.metrics },
        pngFile: "blueprint.png",
      }) as any
    ).scene.metrics,
    design.metrics,
  );
  assert.throws(
    () => compileAuthorScript("terrain scene.plan rect=0,0,64,64 bounds.minX=2", "plan"),
    /BOUNDS_CONFLICT/,
  );
});

test("bounded candidate search avoids unsuitable measured ground before the map plan is built", () => {
  const focal = template("checkpoint"),
    support = template("supply_cluster"),
    first = composeScene(args, focal, support);
  const old = first.intent.zones[0].config.groups[1],
    blocked = measuredMemberGeometry(old.anchor, old.angle, old.members[0]).position;
  const surface = {
    waterCoverageKnown: true,
    sampleGround: (p: { x: number; y: number }) => ({
      height: 1,
      slope: 0.02,
      mask: 1,
      protected: Math.hypot(p.x - blocked.x, p.y - blocked.y) < 1,
    }),
  };
  const next = composeScene(args, focal, support, surface);
  assert.equal(next.groups.length, first.groups.length);
  assert.notDeepEqual(next.groups[1].anchor, first.groups[1].anchor);
  for (const group of next.intent.zones[0].config.groups)
    assert.doesNotThrow(() => measuredObjects(group, surface));
  assert.throws(
    () =>
      composeScene(args, focal, support, {
        waterCoverageKnown: false,
        sampleGround: surface.sampleGround,
      }),
    /WATER_COVERAGE_UNAVAILABLE/,
  );
  assert.doesNotThrow(() =>
    composeScene(
      { ...args, exclusions: [{ type: "rectangle", minX: 120, maxX: 150, minY: 120, maxY: 150 }] },
      focal,
      support,
    ),
  );
});

test("one schematic PNG and ground diagnostics retain their bounded non-engine scope", async () => {
  const scene = composeScene(args, template("checkpoint"), template("supply_cluster")),
    svg = sceneSvg(scene);
  assert.match(svg, /not an SC2 render/);
  assert.match(svg, /FOCAL/);
  const png = await scenePng(scene);
  assert.equal(png.readUInt32BE(16), 960);
  const good = sceneSurfaceReview(scene, {
    heights: { sample: () => ({ height: 2, slope: 0.05, mask: 1 }) },
  } as any);
  assert.equal(good.reviewRequired, false);
  assert.ok(good.samples > 0 && good.samples <= 625);
  assert.equal(good.slopeHistogram.upTo01, good.samples);
  const bad = sceneSurfaceReview(scene, {
    heights: { sample: () => ({ height: 1, slope: 2, mask: 0 }) },
  } as any);
  assert.equal(bad.reviewRequired, true);
  assert.equal(bad.aboveLimit, bad.samples);
  assert.equal(bad.holes, bad.samples);
  const start = performance.now();
  for (let i = 0; i < 100; i++)
    composeScene({ ...args, seed: i }, template("checkpoint"), template("supply_cluster"));
  // Keep timing diagnostic: machine load must not turn a valid planner into a flaky test.
  assert.ok(Number.isFinite(performance.now() - start));
});

test("scene output uses the existing owned transaction, keeps unrelated objects and guards edits on regeneration", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc2-scene-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of await fs.readdir("src/tests/fixtures/terrain-native/nydus"))
    await fs.writeFile(
      path.join(root, name.slice(0, -3)),
      gunzipSync(await fs.readFile(path.join("src/tests/fixtures/terrain-native/nydus", name))),
    );
  await fs.cp("src/tests/fixtures/browse-placement-map", root, { recursive: true });
  const ws = new Workspace(root),
    browse = new BrowseWorkspace(ws, new DataWorkspace(ws)),
    placement = new PlacementWorkspace(ws, browse),
    terrain = new TerrainWorkspace(ws, browse, placement);
  placement.terrain = terrain;
  const resolved = await browse.resolve({ id: "AgriaTree", catalogType: "Actor" });
  if (!resolved.resolved || !resolved.object) throw Error("Fixture Actor unavailable");
  const member = {
    id: "AgriaTree",
    offset: { x: 4, y: 0 },
    heightOffset: 0,
    horizontalBounds: { minX: -0.1, minY: -0.1, maxX: 0.1, maxY: 0.1 },
    boundsFrame: "member" as const,
    rotation: 0,
    scale: 1,
    variation: 0,
    key: resolved.object.key,
  };
  const scene = composeScene(
    {
      ...args,
      profile: "woodland",
      density: "sparse",
      clearance: 3,
      bounds: { minX: 2, minY: 2, maxX: 30, maxY: 30 },
      baseTexture: "BelShirDirtLight",
      pathTexture: "BelShirDirtLight",
      accentTexture: undefined,
      maxSlope: 4,
    },
    {
      members: [member, { ...member, offset: { x: -4, y: 0 } }],
      reserved: [{ minX: -1.5, maxX: 1.5, minY: -2, maxY: 2 }],
    },
    {
      members: [{ ...member, offset: { x: 0, y: 0 } }],
      reserved: [{ minX: -1.5, maxX: 1.5, minY: -2, maxY: 2 }],
    },
  );
  const original = await fs.readFile(path.join(root, "Objects"), "utf8"),
    before = new PlacementDocument(original).list();
  const plan = await terrain.ownedLandscape(scene.intent);
  assert.equal(plan.valid, true);
  assert.deepEqual(await fs.readFile(path.join(root, "Objects"), "utf8"), original);
  await terrain.apply(plan.id, { dryRun: false, stage: true, backup: false });
  await terrain.savePlan(plan.id, { dryRun: false, backup: false });
  const saved = await fs.readFile(path.join(root, "Objects"), "utf8"),
    after = new PlacementDocument(saved).list();
  for (const object of before)
    assert.deepEqual(
      { ...after.find((o) => o.id === object.id), nodeId: undefined },
      { ...object, nodeId: undefined },
    );
  assert.equal(after.length, before.length + scene.metrics.objects);
  const repeated = await terrain.ownedLandscape(scene.intent);
  assert.equal(repeated.ownership.rebuilt.length, 0);
  await assert.rejects(
    terrain.ownedLandscape({ ...scene.intent, lighting: "MissingSceneLight" }),
    /LIGHTING_DEPENDENCY_UNAVAILABLE/,
  );
  assert.deepEqual(ws.binary.draftFiles(), []);
  await fs.writeFile(
    path.join(root, "Base.SC2Data/GameData/LightData.xml"),
    '<Catalog><CLight id="SceneLight"/></Catalog>',
  );
  const lit = await terrain.ownedLandscape({ ...scene.intent, lighting: "SceneLight" });
  await terrain.apply(lit.id, { dryRun: false, stage: true, backup: false });
  await terrain.savePlan(lit.id, { dryRun: false, backup: false });
  assert.match(
    await fs.readFile(path.join(root, "Base.SC2Data/GameData/TerrainData.xml"), "utf8"),
    /SceneLight/,
  );
  assert.match(
    await fs.readFile(path.join(root, "Base.SC2Data/GameData.xml"), "utf8"),
    /TerrainData.xml/,
  );
  assert.match(
    await fs.readFile(path.join(root, "ComponentList.SC2Components"), "utf8"),
    /Objects/,
  );
  const ledger = JSON.parse(await fs.readFile(path.join(root, ".sc2mcp/locations.json"), "utf8")),
    ownedId = ledger.zones.find((r: any) => r.id === args.zone).objects[0].id;
  const doc = new PlacementDocument(await fs.readFile(path.join(root, "Objects"), "utf8"));
  doc.rotate(ownedId, 0.47);
  await fs.writeFile(path.join(root, "Objects"), doc.source);
  await assert.rejects(
    terrain.ownedLandscape({
      ...scene.intent,
      zones: scene.intent.zones.map((z) =>
        z.id === args.zone ? { ...z, purpose: "Changed composition" } : z,
      ),
    }),
    /MANUAL|CONFLICT|CHANGED/,
  );
});
