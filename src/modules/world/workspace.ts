import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Workspace } from "../../core/workspace.js";
import type { DependencyResolution } from "../document/dependencies.js";
import type { MissionBuildProviders } from "../mission/buildMap.js";
import { prepareMissionCatalog } from "../mission/appearance.js";
import { ModelMeasurements } from "../assets/measurement.js";
import { PlacementDocument, componentListWithObjects } from "../placement/document.js";
import type { Point2 } from "../terrain/types.js";
import { SettingsWorkspace } from "../settings/workspace.js";
import type { SettingsOperation } from "../settings/schemas.js";
import { TriggerWorkspace } from "../trigger/workspace.js";
import { parseState } from "../terrain/operations.js";
import { compileWorldIntent, type WorldIntent } from "./intent.js";
import { planWorld, resolveWorldSpec, worldDependencies, type WorldSpec } from "./plan.js";
import { loadCampaignLandscape } from "./missionLandscape.js";
import { compileWorldSurface } from "./surface.js";
import { traceFacilityFloorJoints } from "./floorJoints.js";
import { worldDecor } from "./decor.js";
import { selectDecorCoverage, type DecorCoverage } from "./decorCoverage.js";
import { loadRoomRecipes } from "./roomDressing.js";
import { DecorPalette } from "../placement/decorPalette.js";
import { TerrainWorkspace } from "../terrain/workspace.js";
import {
  structureLayout,
  type Structures,
  worldPathing,
  structureObjects,
  gateRequests,
  waterOperations,
} from "./structures.js";
import { worldTriggers } from "./gameplay.js";

const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const summarizeCoverage = (coverage: DecorCoverage) => ({
  minimum: coverage.minimum,
  zones: coverage.zones.map(({ id, reference, trainingSources, composition }) => ({
    id,
    reference: reference ?? null,
    ...(composition ? { composition: composition.composition } : {}),
    ...(trainingSources.length ? { trainingSources } : {}),
  })),
});
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
  private async resources(
    spec: WorldSpec,
    layout: ReturnType<typeof planWorld>,
    structures: Structures,
    resolved?: DependencyResolution,
  ) {
    const resolution =
      resolved ?? (await this.providers().document.dependencies.resolve(spec.dependencies, true));
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
      if (zone.room && zone.biome !== "engineered")
        throw Error("WORLD_ROOM_REQUIRES_ENGINEERED_ZONE: " + zone.id);
      const required = [
        materials?.ground,
        materials?.road,
        materials?.roadEdge,
        materials?.trim,
        ...(materials?.scatter ?? []),
        zone.room?.floor,
        zone.room?.trim,
        ...(zone.facility?.spaces.flatMap((part) => [
          part.floor,
          part.trim,
          ...part.inlays.map((inlay) => inlay.floor),
        ]) ?? []),
        ...(zone.facility?.passages.flatMap((part) => [part.floor, part.trim]) ?? []),
        zone.facility?.grounds?.floor,
        zone.facility?.grounds?.trim,
        zone.facility?.grounds?.exterior,
        ...(zone.facility?.terraces.flatMap((terrace) => (terrace.floor ? [terrace.floor] : [])) ??
          []),
      ];
      for (const id of required)
        if (id && !sets[zone.bank].textures.includes(id))
          throw Error("WORLD_MATERIAL_UNAVAILABLE: " + zone.id + "/" + id);
    }
    const campaign = await loadCampaignLandscape(spec, layout, sets, structures);
    if (spec.decorBudget && spec.decorReference)
      throw Error("WORLD_DECOR_BUDGET_REFERENCE_CONFLICT");
    const reference = spec.decorReference ?? (campaign && !spec.decorBudget ? "auto" : undefined);
    const coverage = reference ? await selectDecorCoverage(layout, reference) : undefined;
    if (coverage && campaign)
      coverage.minimum = Math.max(coverage.minimum, campaign.decorBudget.min);
    return {
      sets,
      generatorVersion: 36,
      ...(structures.facility.spaces.some(
        ({ roomComposition }) => roomComposition && "activity" in roomComposition,
      )
        ? { roomRecipeRevision: (await loadRoomRecipes()).revision }
        : {}),
      campaign,
      coverage,
      localDependencies: resolution.source.localTrees.map((t) => ({
        root: t.root,
        sha256: digest(JSON.stringify(t.manifest)),
      })),
      build: resolution.source.build,
      dependencies: resolution.ordered.map((d) => d.file),
    };
  }
  async planIntent(intent: WorldIntent, seed: number) {
    const resolution = await this.providers().document.dependencies.resolve(
      worldDependencies(intent.mode, intent.dependencies),
      true,
    );
    const { spec, layout, structures } = await compileWorldIntent(
      intent,
      seed,
      resolution.terrainSets,
    );
    return { ...(await this.savePlan(spec, layout, structures, resolution)), seed };
  }
  async plan(input: unknown) {
    const spec = resolveWorldSpec(input),
      layout = planWorld(spec);
    const structures = structureLayout(spec, layout);
    return this.savePlan(spec, layout, structures);
  }
  private async savePlan(
    spec: WorldSpec,
    layout: ReturnType<typeof planWorld>,
    structures: Structures,
    resolved?: DependencyResolution,
  ) {
    const resources = await this.resources(spec, layout, structures, resolved);
    if (
      !resources.campaign &&
      (spec.landscape === "campaign" ||
        spec.decorBudget ||
        spec.zones.some((z) => z.style) ||
        structures.embankments.length ||
        structures.edges.some((edge) => edge.area) ||
        structures.facility.terraces.length)
    )
      throw Error("WORLD_CAMPAIGN_LANDSCAPE_REQUIRED");
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
        ...(z.composition ? { composition: z.composition } : {}),
      })),
      routes: layout.routes,
      structures,
      ...(resources.campaign
        ? {
            landscape: {
              ...(resources.coverage ? {} : { decorBudget: resources.campaign.decorBudget }),
              zones: resources.campaign.zones.map(({ id, profile, style, materials, roles }) => ({
                id,
                profile,
                style,
                materials,
                requiredRoles: roles.map((r) => r.label),
              })),
              cliffs: resources.campaign.features.map(({ strokes, ...feature }) => feature),
            },
          }
        : {}),
      palettes: resources.sets.map((s) => ({ id: s.id, textures: s.textures })),
      ...(resources.coverage ? { decorCoverage: summarizeCoverage(resources.coverage) } : {}),
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
    const elapsedMs: Record<string, number> = {};
    let started = performance.now();
    const finishStage = (stage: string) => {
      const now = performance.now();
      elapsedMs[stage] = Math.round(now - started);
      started = now;
    };
    if (!/^[a-f0-9]{64}$/.test(planId)) throw Error("WORLD_INVALID_PLAN_ID");
    const parent = path.join(this.root(), planId);
    const payload = await fs.readFile(path.join(parent, "plan.json"), "utf8");
    if (digest(payload) !== planId) throw Error("WORLD_STALE_PLAN");
    const spec = resolveWorldSpec(JSON.parse(payload).spec),
      layout = planWorld(spec);
    const structures = structureLayout(spec, layout);
    finishStage("layout");
    const resources = await this.resources(spec, layout, structures);
    finishStage("resolveDependencies");
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
      finishStage("document");
      const surface = compileWorldSurface(
        spec,
        layout,
        resources.sets,
        resources.campaign,
        structures,
      );
      for (const [name, bytes] of surface.files) await fs.writeFile(path.join(dir, name), bytes);
      const copy = new Workspace(dir),
        state = parseState(surface.files);
      finishStage("surface");
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
      finishStage("catalog");
      const objects = PlacementDocument.create();
      const addGroundUnit = (catalogId: string, owner: number, point: Point2) => {
        const { x, y } = point;
        const terrain = state.heights.sample(point);
        if (!terrain.mask || !Number.isFinite(terrain.height))
          throw Error("WORLD_UNIT_REQUIRES_TERRAIN: " + catalogId + " " + x + "," + y);
        // Native ObjectUnit Position.Z is a terrain-relative height offset.
        return objects.add({ kind: "Unit", catalogId, owner, position: { x, y, z: 0 } });
      };
      const pointOnGround = ({ x, y }: Point2) => ({
        x,
        y,
        z: state.heights.sample({ x, y }).height,
      });
      const starts = spec.starts.map((name) => {
        const z = layout.zones.find((z) => z.id === name)!;
        return objects.addPoint({ name, type: "StartLoc", position: pointOnGround(z.center) });
      });
      const goal = layout.zones.find((z) => z.id === spec.objective)?.center;
      if (goal) objects.addPoint({ name: spec.objective!, position: pointOnGround(goal) });
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
              addGroundUnit(offset[1] < 0 ? "VespeneGeyser" : "MineralField", 0, { x, y });
            }
        } else roster.push(addGroundUnit("Marine", i + 1, p));
      }
      const measurements = new ModelMeasurements(copy, providers.casc);
      const palette = new DecorPalette(browse, measurements, undefined, true);
      const { assembled, decoration, gates } = await browse.withSnapshot(async () => {
        const assembled = await structureObjects(
          structures,
          palette,
          pointOnGround,
          traceFacilityFloorJoints(structures, state),
        );
        objects.addMany(assembled.objects);
        const gates = assembled.doors.map((p) => ({
          position: p,
          id: addGroundUnit("SupplyDepot", 1, p),
        }));
        await fs.writeFile(path.join(dir, "CellAttribute_Pnp"), worldPathing(spec, structures));
        const water = waterOperations(spec, structures);
        if (water.length) {
          const terrain = new TerrainWorkspace(copy, browse);
          const planned = await terrain.plan({ operations: water });
          if (!planned.valid) throw Error("WORLD_WATER_INVALID: " + JSON.stringify(planned.issues));
          const result = await terrain.apply(planned.id, {
            dryRun: false,
            stage: false,
            backup: false,
          });
          if (!result.accepted) throw Error("WORLD_WATER_APPLY_FAILED");
        }
        finishStage("structuresAndWater");
        const decoration = await worldDecor(
          spec,
          layout,
          structures,
          palette,
          state,
          resources.campaign,
          assembled.objects.map((o) => o.catalogId),
          assembled.reserved,
          resources.coverage,
        );
        return { assembled, decoration, gates };
      });
      const decor = decoration.placements;
      objects.addMany(decor);
      const scenicTypes = new Set(decoration.scenicTypes);
      if (resources.coverage) {
        const placed = decoration.qualifyingTypes.length;
        if (placed < resources.coverage.minimum)
          throw Error(
            "WORLD_DECOR_REFERENCE_SHORTFALL: " +
              JSON.stringify({
                ...summarizeCoverage(resources.coverage),
                placed,
              }),
          );
      } else if (resources.campaign) {
        const { min, max } = resources.campaign.decorBudget;
        if (scenicTypes.size < min || scenicTypes.size > max)
          throw Error(
            "WORLD_CAMPAIGN_DECOR_BUDGET: " + scenicTypes.size + " expected " + min + ".." + max,
          );
      }
      await fs.writeFile(path.join(dir, "Objects"), objects.source);
      const manifest = path.join(dir, "ComponentList.SC2Components");
      await fs.writeFile(manifest, componentListWithObjects(await fs.readFile(manifest, "utf8")));
      finishStage("decoration");
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
      finishStage("settingsAndTriggers");
      const previews: Record<string, string> = {};
      const previewTerrain = new TerrainWorkspace(copy, browse);
      for (const mode of ["height", "texture"] as const) {
        const image = await previewTerrain.preview(undefined, "", mode, 256);
        const target = path.join(attempt, mode + ".png");
        await fs.writeFile(target, Buffer.from(image.imageBase64, "base64"));
        previews[mode] = this.key(target);
      }
      finishStage("preview");
      const packed = await providers.map.export(this.key(dir), this.key(archive), false, false);
      finishStage("packAndReopen");
      if (
        JSON.stringify(await this.resources(spec, layout, structures)) !== JSON.stringify(resources)
      )
        throw Error("WORLD_PLAN_INPUTS_CHANGED");
      if (!("verification" in packed) || !packed.verification.reopened)
        throw Error("WORLD_PACK_VERIFICATION_FAILED");
      const revision = digest(await fs.readFile(archive));
      finishStage("revalidate");
      const receipt = {
        planId,
        revision,
        archive: this.key(archive),
        mode: spec.mode,
        paintedTextures: surface.paintedTextures,
        ...(assembled.edgeObjects.length ? { edgeObjects: assembled.edgeObjects } : {}),
        ...(assembled.floorJointObjects.length
          ? { facilityFloorJoints: assembled.floorJointObjects }
          : {}),
        ...(assembled.facilityObjects.length ? { facilityObjects: assembled.facilityObjects } : {}),
        ...(assembled.roomCompositions.length
          ? { roomCompositions: assembled.roomCompositions }
          : {}),
        ...(assembled.perimeterObjects.length
          ? { facilityPerimeter: assembled.perimeterObjects }
          : {}),
        ...(structures.facility.terraces.length
          ? {
              facilityTerraces: structures.facility.terraces.map((t) => ({
                id: t.id,
                stairs: t.stairs.length,
              })),
            }
          : {}),
        previews,
        elapsedMs,
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
        ...(resources.coverage
          ? {
              decorCoverage: {
                ...summarizeCoverage(resources.coverage),
                placedTypes: decoration.qualifyingTypes.length,
                placedByRole: decoration.qualifyingByRole,
                types: decoration.qualifyingTypes,
              },
            }
          : {}),
        ...(resources.campaign
          ? {
              landscape: {
                distinctScenicTypes: scenicTypes.size,
                ...(resources.coverage ? {} : { decorBudget: resources.campaign.decorBudget }),
                requiredDecor: decoration.requiredDecor,
                nativeCliffCells: state.descriptor.parsed.nodes.filter((n) => n.tag === "cc")
                  .length,
                nativeCliffFeatures: resources.campaign.features.map(
                  ({ strokes, ...feature }) => feature,
                ),
              },
            }
          : {}),
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
