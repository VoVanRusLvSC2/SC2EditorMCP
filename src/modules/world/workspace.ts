import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Workspace } from "../../core/workspace.js";
import type { MissionBuildProviders } from "../mission/buildMap.js";
import { prepareMissionCatalog } from "../mission/appearance.js";
import { ModelMeasurements } from "../assets/measurement.js";
import { PlacementDocument, componentListWithObjects } from "../placement/document.js";
import { SettingsWorkspace } from "../settings/workspace.js";
import type { SettingsOperation } from "../settings/schemas.js";
import { TriggerWorkspace } from "../trigger/workspace.js";
import { parseState } from "../terrain/operations.js";
import { planWorld, resolveWorldSpec, type WorldSpec } from "./plan.js";
import { compileWorldSurface } from "./surface.js";
import { worldDecor } from "./decor.js";
import { DecorPalette } from "../placement/decorPalette.js";
import { TerrainWorkspace } from "../terrain/workspace.js";
import {
  structureLayout,
  worldPathing,
  structureObjects,
  gateRequests,
  waterOperations,
} from "./structures.js";
import { worldTriggers } from "./gameplay.js";

const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
export class WorldWorkspace {
  constructor(
    private workspace: Workspace,
    private providers: () => MissionBuildProviders,
  ) {}
  private root() {
    return this.workspace.resolveUserPath(".sc2mcp-output/world");
  }
  private key(file: string) {
    return path.relative(this.workspace.root, file).replaceAll("\\", "/");
  }
  private async resources(spec: WorldSpec, layout: ReturnType<typeof planWorld>) {
    const resolution = await this.providers().document.dependencies.resolve(
      spec.dependencies,
      true,
    );
    const sets = layout.sets.map((id) => {
      const set = resolution.terrainSets.find((s) => s.id === id);
      if (
        !set ||
        set.generic ||
        set.unsupported?.length ||
        !set.textures.length ||
        set.textures.length > 8
      )
        throw Error("WORLD_PALETTE_UNAVAILABLE: " + id + " " + JSON.stringify(set?.unsupported));
      return set;
    });
    for (const zone of layout.zones) {
      const materials = zone.materials;
      if (!materials) continue;
      const required = [
        materials.ground,
        materials.road,
        materials.trim,
        ...(materials.scatter ?? []),
      ];
      for (const id of required)
        if (id && !sets[zone.bank].textures.includes(id))
          throw Error("WORLD_MATERIAL_UNAVAILABLE: " + zone.id + "/" + id);
    }
    return {
      sets,
      generatorVersion: 1,
      localDependencies: resolution.source.localTrees.map((t) => ({
        root: t.root,
        sha256: digest(JSON.stringify(t.manifest)),
      })),
      build: resolution.source.build,
      dependencies: resolution.ordered.map((d) => d.file),
    };
  }
  async plan(input: unknown) {
    const spec = resolveWorldSpec(input),
      layout = planWorld(spec);
    const structures = structureLayout(spec, layout);
    const resources = await this.resources(spec, layout);
    const payload = JSON.stringify({ spec, resources, layout });
    const planId = digest(payload),
      root = this.root();
    await fs.mkdir(root, { recursive: true });
    const draft = await fs.mkdtemp(path.join(root, "pending-"));
    try {
      await fs.writeFile(path.join(draft, "plan.json"), payload);
      await fs.rename(draft, path.join(root, planId)).catch(async (error) => {
        if (
          !["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code) ||
          (await fs.readFile(path.join(root, planId, "plan.json"), "utf8")) !== payload
        )
          throw error;
      });
    } finally {
      await fs.rm(draft, { recursive: true, force: true });
    }
    return {
      planId,
      mode: spec.mode,
      zones: layout.zones.map((z, i) => ({
        id: z.id,
        center: z.center,
        tileSet: z.tileSet,
        blocks: layout.counts[i],
      })),
      routes: layout.routes,
      structures,
      palettes: resources.sets.map((s) => ({ id: s.id, textures: s.textures })),
      gameBuild: resources.build,
    };
  }
  async layout(planId: string) {
    if (!/^[a-f0-9]{64}$/.test(planId)) throw Error("WORLD_INVALID_PLAN_ID");
    const payload = await fs.readFile(path.join(this.root(), planId, "plan.json"), "utf8");
    if (digest(payload) !== planId) throw Error("WORLD_STALE_PLAN");
    return planWorld(resolveWorldSpec(JSON.parse(payload).spec));
  }
  async build(planId: string) {
    if (!/^[a-f0-9]{64}$/.test(planId)) throw Error("WORLD_INVALID_PLAN_ID");
    const parent = path.join(this.root(), planId);
    const payload = await fs.readFile(path.join(parent, "plan.json"), "utf8");
    if (digest(payload) !== planId) throw Error("WORLD_STALE_PLAN");
    const spec = resolveWorldSpec(JSON.parse(payload).spec),
      layout = planWorld(spec);
    const structures = structureLayout(spec, layout);
    const resources = await this.resources(spec, layout);
    if (digest(JSON.stringify({ spec, resources, layout })) !== planId)
      throw Error("WORLD_PLAN_INPUTS_CHANGED");
    const attempt = await fs.mkdtemp(path.join(parent, "build-"));
    try {
      const dir = path.join(attempt, "components"),
        archive = path.join(attempt, "world.SC2Map"),
        providers = this.providers();
      const foundation = await providers.document.plan({
        kind: "map",
        name: spec.name,
        destination: this.key(dir),
        dependencies: spec.dependencies,
        map: { width: spec.width, height: spec.height },
        terrain: { enabled: true, tileSet: layout.sets[0], baseHeight: 4 },
      });
      await providers.document.create(foundation.id, false);
      const surface = compileWorldSurface(spec, layout, resources.sets);
      for (const [name, bytes] of surface.files) await fs.writeFile(path.join(dir, name), bytes);
      const copy = new Workspace(dir),
        state = parseState(surface.files);
      const nativeCatalogs = new Set(await providers.catalogFiles());
      // These stock catalogs are loaded implicitly from declared Blizzard packages.
      for (const file of [
        "actordata.xml",
        "modeldata.xml",
        "unitdata.xml",
        "abildata.xml",
        "waterdata.xml",
        "footprintdata.xml",
      ])
        nativeCatalogs.add(file);
      const browse = await prepareMissionCatalog(copy, providers.casc, foundation, nativeCatalogs);
      const objects = PlacementDocument.create();
      const starts = spec.starts.map((name) => {
        const z = layout.zones.find((z) => z.id === name)!;
        return objects.addPoint({ name, type: "StartLoc", position: { ...z.center, z: 4 } });
      });
      const goal = layout.zones.find((z) => z.id === spec.objective)?.center;
      if (goal) objects.addPoint({ name: spec.objective!, position: { ...goal, z: 4 } });
      const roster: number[] = [];
      for (const [i, start] of spec.starts.entries()) {
        const p = layout.zones.find((z) => z.id === start)!.center;
        if (spec.mode === "ladder") {
          const sign = i === 0 ? 1 : -1;
          for (const site of [p, layout.expansions[i]])
            for (const offset of [
              [-5, 5],
              [-3, 6],
              [-1, 7],
              [1, 7],
              [3, 6],
              [5, 5],
              [-6, 3],
              [6, 3],
              [-7, -4],
              [7, -4],
            ]) {
              const x = site.x + offset[0] * sign,
                y = site.y + offset[1] * sign;
              objects.add({
                kind: "Unit",
                catalogId: offset[1] < 0 ? "VespeneGeyser" : "MineralField",
                owner: 0,
                position: { x, y, z: state.heights.sample({ x, y }).height },
              });
            }
        } else
          roster.push(
            objects.add({
              kind: "Unit",
              catalogId: "Marine",
              owner: i + 1,
              position: { ...p, z: 4 },
            }),
          );
      }
      const measurements = new ModelMeasurements(copy, providers.casc);
      const assembled = await browse.withSnapshot(() =>
        structureObjects(structures, new DecorPalette(browse, measurements)),
      );
      objects.addMany(assembled.objects);
      const gates = assembled.doors.map((p) => ({
        position: p,
        id: objects.add({
          kind: "Unit",
          catalogId: "SupplyDepot",
          owner: 1,
          position: { x: p.x, y: p.y, z: 4 },
        }),
      }));
      await fs.writeFile(path.join(dir, "CellAttribute_Pnp"), worldPathing(spec, structures));
      const water = waterOperations(spec, structures);
      if (water.length) {
        const terrain = new TerrainWorkspace(copy, browse);
        const planned = await terrain.plan({ operations: water });
        if (!planned.valid) throw Error("WORLD_WATER_INVALID: " + JSON.stringify(planned.issues));
        if (
          !(await terrain.apply(planned.id, { dryRun: false, stage: false, backup: false }))
            .accepted
        )
          throw Error("WORLD_WATER_APPLY_FAILED");
      }
      const decor = await browse.withSnapshot(() =>
        worldDecor(spec, layout, browse, measurements, state),
      );
      objects.addMany(decor);
      await fs.writeFile(path.join(dir, "Objects"), objects.source);
      const manifest = path.join(dir, "ComponentList.SC2Components");
      await fs.writeFile(manifest, componentListWithObjects(await fs.readFile(manifest, "utf8")));
      const settings = new SettingsWorkspace(copy);
      const operations: SettingsOperation[] = [
        { op: "player.slots", count: starts.length, disableComputerPlayers: false },
        { op: "starts.register", objectIds: starts },
        ...starts.map((id, i) => ({
          op: "player.set" as const,
          playerId: i + 1,
          patch: { startLocation: id },
        })),
      ];
      const settingsPlan = await settings.plan({ operations });
      await settings.apply(settingsPlan.id, { dryRun: false, stage: false, backup: false });
      const triggers = new TriggerWorkspace(copy, undefined, browse.data, providers.casc);
      const gui = await triggers.planBatch([
        ...worldTriggers(spec.mode, roster, goal),
        ...gateRequests(gates, roster),
      ]);
      await triggers.applyPlan(gui.planId, false, true);
      await triggers.generateRuntime(false, true);
      await copy.save("Triggers", { backup: false });
      const previews: Record<string, string> = {};
      const previewTerrain = new TerrainWorkspace(copy, browse);
      for (const mode of ["height", "texture"] as const) {
        const image = await previewTerrain.preview(undefined, "", mode, 256);
        const target = path.join(attempt, mode + ".png");
        await fs.writeFile(target, Buffer.from(image.imageBase64, "base64"));
        previews[mode] = this.key(target);
      }
      const packed = await providers.map.export(this.key(dir), this.key(archive), false, false);
      if (JSON.stringify(await this.resources(spec, layout)) !== JSON.stringify(resources))
        throw Error("WORLD_PLAN_INPUTS_CHANGED");
      if (!("verification" in packed) || !packed.verification.reopened)
        throw Error("WORLD_PACK_VERIFICATION_FAILED");
      const revision = digest(await fs.readFile(archive));
      const receipt = {
        planId,
        revision,
        archive: this.key(archive),
        mode: spec.mode,
        paintedTextures: surface.paintedTextures,
        previews,
        zones: layout.zones.map((zone, i) => ({
          id: zone.id,
          distinctActors: new Set(
            decor
              .filter(
                (d) =>
                  layout.blocks[
                    (Math.floor(d.position.y / 8) * spec.width) / 8 + Math.floor(d.position.x / 8)
                  ] === i,
              )
              .map((d) => d.catalogId),
          ).size,
        })),
        decorTypes: [...new Set(decor.map((d) => d.catalogId))],
        objects: objects.list().length,
        archiveReopened: true,
        editorVerification: "not_run",
        gameVerification: "not_run",
      };
      await fs.writeFile(path.join(attempt, "receipt.json"), JSON.stringify(receipt));
      return receipt;
    } catch (error) {
      await fs.rm(attempt, { recursive: true, force: true });
      throw error;
    }
  }
  async verify(planId: string, revision: string) {
    if (![planId, revision].every((id) => /^[a-f0-9]{64}$/.test(id)))
      throw Error("WORLD_INVALID_REVISION");
    const root = path.join(this.root(), planId);
    for (const row of await fs.readdir(root, { withFileTypes: true })) {
      if (!row.isDirectory() || !row.name.startsWith("build-")) continue;
      const dir = path.join(root, row.name);
      const raw = await fs.readFile(path.join(dir, "receipt.json"), "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      if (!raw) continue;
      const receipt = JSON.parse(raw);
      if (receipt.revision !== revision) continue;
      if (digest(await fs.readFile(path.join(dir, "world.SC2Map"))) !== revision)
        throw Error("WORLD_REVISION_CHANGED");
      return {
        ...receipt,
        archive: this.key(path.join(dir, "world.SC2Map")),
        verifiedArchiveHash: true,
      };
    }
    throw Error("WORLD_REVISION_NOT_FOUND");
  }
}
