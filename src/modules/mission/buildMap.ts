import { promises as fs } from "node:fs";
import path from "node:path";
import { Workspace } from "../../core/workspace.js";
import type { DocumentWorkspace } from "../document/workspace.js";
import type { MapWorkspace } from "../map/workspace.js";
import { PointWorkspace } from "../placement/points.js";
import { TerrainWorkspace } from "../terrain/workspace.js";
import type { TerrainOperation } from "../terrain/types.js";
import type { MissionBuildSpec } from "./buildSpec.js";
import { groundShapes, routeSamples, type MissionLayout } from "./layout.js";
import type { CascWorkspace } from "../casc/workspace.js";
import { prepareMissionCatalog, decorateMission } from "./appearance.js";
import { authorMissionGameplay } from "./gameplay.js";
import { checkAndRepairMissionRoutes } from "./routeRepair.js";
import { pavedBaseGeometry, pavedBaseSurface, sculptMissionSurface } from "./surface.js";
import { landformOperations } from "./nativeLandforms.js";
import { parseTerrainXml } from "../terrain/surface/format/terrain-params.js";
import { ModelMeasurements } from "../assets/measurement.js";
import { DecorPalette } from "../placement/decorPalette.js";
import { fitMaterialBorder, measureBorderKit } from "../placement/materialBorder.js";
import { PlacementWorkspace } from "../placement/workspace.js";
import { StyleCatalog } from "../placement/styleCatalog.js";
import { missionStylePack } from "./campaignStyles.js";
import { decorateCampaignRiver } from "./campaignDecor.js";
import { reviewMissionRiver } from "./river.js";
import { chooseMissionMaterial, missionMaterialCatalog } from "./materialStyles.js";

export interface MissionBuildProviders {
  document: DocumentWorkspace;
  casc: CascWorkspace;
  catalogFiles: () => Promise<ReadonlySet<string>>;
  map: MapWorkspace;
}

export async function buildMissionMap(
  workspace: Workspace,
  providers: MissionBuildProviders,
  spec: MissionBuildSpec,
  layout: MissionLayout,
  attempt: string,
) {
  const output = workspace.resolveUserPath(".sc2mcp-output");
  await fs.mkdir(output, { recursive: true });
  const staging = await fs.mkdtemp(path.join(output, "mission-"));
  const key = (file: string) => path.relative(workspace.root, file).replaceAll("\\", "/");
  const directory = key(path.join(staging, "map"));
  const archive = key(path.join(attempt, "candidate.SC2Map"));
  try {
    const styleCatalog = new StyleCatalog();
    const style = spec.terrain.styleCampaign
      ? await missionStylePack(spec.terrain.styleCampaign, spec.terrain.tileSet, styleCatalog)
      : undefined;
    const classified = spec.terrain.materialsFromStyle
      ? (await missionMaterialCatalog({ tileSet: spec.terrain.tileSet }, styleCatalog)).items
      : undefined;
    const select = (
      role: Parameters<typeof chooseMissionMaterial>[1],
      excluded?: (string | undefined)[],
    ) => classified && chooseMissionMaterial(classified, role, excluded);
    const initialTexture = spec.terrain.initialTexture ?? select("ground");
    if (classified && !initialTexture) throw Error("MISSION_STYLE_GROUND_TEXTURE_UNCLASSIFIED");
    const foundation = await providers.document.plan({
      kind: "map",
      destination: directory,
      name: spec.name,
      map: spec.map,
      dependencies: spec.dependencies,
      terrain: {
        enabled: true,
        tileSet: spec.terrain.tileSet,
        initialTexture,
        ...(spec.terrain.profile ? { baseHeight: 4 } : {}),
      },
    });
    await providers.document.create(foundation.id, false);
    const baseHeight = foundation.foundation.baseHeight!;
    const room = foundation.foundation.heightEditing;
    if (!room || !room.commonRange || room.downwardRoom < 0.7)
      throw Error("MISSION_FOUNDATION_INSUFFICIENT_HEIGHT_RANGE");
    const depth = Math.min(1.7, room.downwardRoom * 0.7);
    const relief = Math.min(0.65, room.downwardRoom * 0.2, room.upwardRoom * 0.5);
    const copy = new Workspace(path.join(staging, "map"));
    const browse =
      spec.decor ||
      spec.terrain.water ||
      spec.terrain.lighting ||
      spec.terrain.baseSurface?.trimBorder ||
      spec.gameplay
        ? await prepareMissionCatalog(
            copy,
            providers.casc,
            foundation,
            await providers.catalogFiles(),
          )
        : undefined;
    const terrain = new TerrainWorkspace(copy, browse);
    const state = await terrain.state();
    const palette = state.descriptor.textures.flatMap((texture) =>
      texture.id ? [texture.id] : [],
    );
    const baseTexture = foundation.foundation.initialTexture;
    const trail =
      spec.terrain.trailTexture ??
      (classified
        ? select("trail", [baseTexture])
        : (palette.find(
            (texture) => texture !== baseTexture && /road|dirt|gravel|stone|tile/i.test(texture),
          ) ?? palette.find((texture) => texture !== baseTexture)));
    const accent =
      spec.terrain.accentTexture ??
      (classified
        ? select("rock", [baseTexture, trail])
        : (palette.find(
            (texture) =>
              texture !== baseTexture && texture !== trail && /rock|mud|sand/i.test(texture),
          ) ?? palette.find((texture) => texture !== baseTexture && texture !== trail)));
    const detail =
      spec.terrain.detailTexture ??
      (classified
        ? select("vegetation", [baseTexture, trail, accent])
        : spec.terrain.profile
          ? palette.find(
              (texture) =>
                ![baseTexture, trail, accent].includes(texture) &&
                /grass|foliage|moss|sand|rough/i.test(texture),
            )
          : undefined);
    const requestedBase = spec.terrain.baseSurface;
    const floorTexture = requestedBase && (requestedBase.floorTexture ?? select("floor"));
    const trimTexture =
      requestedBase && (requestedBase.trimTexture ?? select("trim", [floorTexture]));
    if (requestedBase && (!floorTexture || !trimTexture || floorTexture === trimTexture))
      throw Error("MISSION_BASE_MATERIAL_ROLES_UNRESOLVED");
    const baseSurface =
      requestedBase && floorTexture && trimTexture
        ? { ...requestedBase, floorTexture, trimTexture }
        : undefined;
    for (const texture of [
      trail,
      accent,
      detail,
      baseSurface?.floorTexture,
      baseSurface?.trimTexture,
    ])
      if (texture && !palette.includes(texture))
        throw Error("MISSION_TEXTURE_OUTSIDE_TILESET: " + texture);
    if (!trail) throw Error("MISSION_ROUTE_TEXTURE_MISSING");

    const { corridors, pads } = groundShapes(layout);
    const protectedAreas = [...corridors, ...pads];
    const operations: TerrainOperation[] = [];
    if (layout.landform) operations.push(...landformOperations(layout.landform, 0));
    let waterLevel = baseHeight - depth * 0.55;
    if (spec.terrain.profile) {
      const sculpted = sculptMissionSurface(
        spec.terrain.profile,
        layout,
        spec.seed,
        {
          base: baseHeight,
          up: room.upwardRoom,
          down: room.downwardRoom,
        },
        { trail, accent, detail },
      );
      operations.push(...sculpted.operations);
      waterLevel = sculpted.waterLevel;
    } else {
      if (relief > 0)
        operations.push({
          op: "height.noise",
          area: layout.playable,
          amplitude: relief,
          wavelength: 11,
          edgeBlend: 5,
          seed: spec.seed,
          protectedAreas,
        });
      operations.push({
        op: "height.set",
        area: layout.basin,
        height: baseHeight - depth,
        edgeBlend: 3,
        protectedAreas,
      });
      for (const corridor of corridors) {
        operations.push({
          op: "height.set",
          area: { ...corridor, width: corridor.width + 4 },
          height: baseHeight,
          edgeBlend: 2,
        });
        operations.push({ op: "texture.blend", area: corridor, texture: trail, edgeBlend: 1.5 });
      }
      if (accent) {
        operations.push({
          op: "texture.blend",
          area: layout.basin,
          texture: accent,
          edgeBlend: 2.5,
          protectedAreas,
        });
        // The objective has a stronger material frame than the starting plaza.
        operations.push({ op: "texture.blend", area: pads[1], texture: accent, edgeBlend: 3 });
      }
    }
    if (spec.terrain.lighting)
      operations.push({ op: "lighting.assign", id: spec.terrain.lighting });
    async function applyTerrain(operations: TerrainOperation[]) {
      const plan = await terrain.plan({ operations });
      if (!plan.valid) throw Error("MISSION_TERRAIN_PLAN_INVALID: " + JSON.stringify(plan.issues));
      const applied = await terrain.apply(plan.id, { dryRun: false, stage: false, backup: false });
      if (!applied.accepted) throw Error("MISSION_TERRAIN_APPLY_REFUSED");
    }
    await applyTerrain(operations);

    const { routeChecks, repairs } = await checkAndRepairMissionRoutes(
      terrain,
      layout.routes,
      baseHeight,
    );
    const points = new PointWorkspace(copy);
    const pointPlan = await points.plan({
      operations: layout.zones.map((zone) => ({
        op: "create",
        name: zone.id,
        position: { ...zone.center, z: 0 },
      })),
    });
    await points.apply(pointPlan.planId, false);
    await copy.save("Objects", { backup: false });

    const decorStarted = performance.now();
    const decor =
      spec.campaignDecor && style && browse
        ? await browse.withSnapshot(() =>
            decorateCampaignRiver(
              copy,
              providers.casc,
              browse,
              terrain,
              layout,
              spec,
              style,
              waterLevel,
            ),
          )
        : spec.decor && browse
          ? await decorateMission(copy, providers.casc, browse, terrain, layout, {
              ...spec,
              decor: spec.decor,
            })
          : undefined;
    const placementMs = Math.round(performance.now() - decorStarted);
    const finish: TerrainOperation[] = [];
    if (decor && spec.decor?.style !== "floodedRuins") {
      for (const [index, { role, position, bounds }] of decor.entries()) {
        if (spec.decorDensity === "lush" && role === "bank" && index % 8 !== 0) continue;
        const texture =
          role === "vegetation" || role === "bank" || role === "canopy" ? detail : accent;
        if (!texture) continue;
        const radius = Math.min(
          6,
          Math.max(2, Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.5 + 1.4),
        );
        finish.push({
          op: "texture.blend",
          area: { type: "circle", center: position, radius },
          texture,
          edgeBlend: radius * 0.9,
          strength: role === "vegetation" ? 0.46 : 0.68,
          protectedAreas: [...corridors, ...(layout.waterArea ? [layout.waterArea] : [])],
        });
      }
    }
    const finishStarted = performance.now();
    if (baseSurface) finish.push(...pavedBaseSurface(layout, baseSurface));
    // The candidate is private until export. Keep the terrain writer's
    // transaction bound even when a dense scene has many contact brushes.
    for (let start = 0; start < finish.length; start += 100)
      await applyTerrain(finish.slice(start, start + 100));
    const surfaceFinishMs = Math.round(performance.now() - finishStarted);
    let river;
    if (spec.terrain.water) {
      if (!layout.waterArea) throw Error("MISSION_WATER_AREA_MISSING");
      const id = "MissionBasinWater";
      await applyTerrain([
        { op: "water.material", id, parent: spec.terrain.water.parent, height: waterLevel },
        { op: "water.create", template: id, area: layout.waterArea },
      ]);
      const { sample } = await terrain.surface();
      for (const route of layout.routes)
        if (routeSamples(route.points).some((point) => sample(point).water?.length))
          throw Error("MISSION_LATE_WATER_OVERLAPS_ROUTE: " + route.id);
      if (layout.river) river = reviewMissionRiver(layout.river, waterLevel, sample);
    }
    let baseTrim;
    const trimStarted = performance.now();
    if (baseSurface?.trimBorder && browse) {
      const models = new DecorPalette(browse, new ModelMeasurements(copy, providers.casc));
      const kit = await browse.withSnapshot(() => measureBorderKit(models));
      const surface = await terrain.surface();
      const { inner, outer } = pavedBaseGeometry(layout, baseSurface.zone);
      const borders =
        baseSurface.trimBorder === "both"
          ? (["outer", "inner"] as const)
          : [baseSurface.trimBorder];
      const fitted = borders.map((side) =>
        fitMaterialBorder(
          surface,
          side === "inner"
            ? {
                bounds: inner,
                insideTexture: baseSurface.floorTexture,
                outsideTexture: baseSurface.trimTexture,
                widthScale: 0.66,
              }
            : { bounds: outer, insideTexture: baseSurface.trimTexture, widthScale: 1 },
          kit,
        ),
      );
      const placement = new PlacementWorkspace(copy, browse);
      placement.terrain = terrain;
      const plan = await placement.addBatch({
        objects: fitted.flatMap((border) => border.objects),
      });
      const applied = await placement.apply(plan.id, {
        dryRun: false,
        stage: false,
        backup: false,
      });
      if (!applied.accepted) throw Error("MISSION_BASE_TRIM_APPLY_REFUSED");
      baseTrim = fitted.map(({ bounds, objects }, index) => ({
        side: borders[index],
        bounds,
        sections: objects.length,
      }));
    }
    const baseTrimMs = Math.round(performance.now() - trimStarted);
    let landform;
    if (layout.landform) {
      const descriptor = parseTerrainXml((await terrain.state()).descriptor.source);
      const cliffCells = descriptor.cliffCells?.length ?? 0;
      const ramps = descriptor.ramps ?? [];
      if (
        !cliffCells ||
        ramps.length !== layout.landform.ramps.length ||
        layout.landform.ramps.some(
          ({ center, lowerLevel }) =>
            !ramps.some(
              (ramp) =>
                ramp.lo === lowerLevel &&
                ramp.frames.mid?.center[0] === center.x &&
                ramp.frames.mid.center[1] === center.y,
            ),
        )
      )
        throw Error("MISSION_LANDFORM_READBACK_MISMATCH");
      landform = { style: layout.landform.style, cliffCells, ramps: layout.landform.ramps };
    }
    const gameplay =
      spec.gameplay && browse
        ? await authorMissionGameplay(copy, providers.casc, browse, terrain, layout, spec.gameplay)
        : undefined;
    const previews: Record<string, string> = {};
    for (const mode of ["height", "texture"] as const) {
      const image = await terrain.preview(undefined, "", mode, 256);
      const file = path.join(attempt, mode + ".png");
      await fs.writeFile(file, Buffer.from(image.imageBase64, "base64"), { flag: "wx" });
      previews[mode] = key(file);
    }
    const result = await providers.map.export(directory, archive, false, false);
    if (!("verification" in result) || !result.verification.reopened)
      throw Error("MISSION_BUILD_ARCHIVE_VERIFICATION_REQUIRED");
    return {
      archive,
      previews,
      routeChecks,
      repairs,
      baseHeight,
      decor,
      ...(decor || baseTrim ? { decorTiming: { placementMs, surfaceFinishMs, baseTrimMs } } : {}),
      ...(river ? { river } : {}),
      ...(baseTrim ? { baseTrim } : {}),
      gameplay,
      landform,
      entryCount: result.verification.entryCount,
      material: { baseTexture, trail, accent, detail, floorTexture, trimTexture },
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
