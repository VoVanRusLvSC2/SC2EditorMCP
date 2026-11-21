import type { Workspace } from "../../core/workspace.js";
import type { CascWorkspace } from "../casc/workspace.js";
import type { DocumentWorkspace } from "../document/workspace.js";
import { DataWorkspace } from "../data/workspace.js";
import { BrowseWorkspace } from "../browse/workspace.js";
import { ModelMeasurements } from "../assets/measurement.js";
import { DecorPalette, type DecorModel } from "../placement/decorPalette.js";
import { checkGroupClearance } from "../placement/groupClearance.js";
import { measuredMemberGeometry } from "../placement/compositionGeometry.js";
import { PlacementWorkspace } from "../placement/workspace.js";
import type { LocationRoute, ExclusionZone } from "../placement/types.js";
import { valueNoise } from "../terrain/geometry.js";
import type { TerrainWorkspace } from "../terrain/workspace.js";
import type { Point2 } from "../terrain/types.js";
import type { MissionBuildSpec } from "./buildSpec.js";
import type { MissionLayout } from "./layout.js";

type Foundation = Awaited<ReturnType<DocumentWorkspace["plan"]>>;

export async function prepareMissionCatalog(
  copy: Workspace,
  casc: CascWorkspace,
  foundation: Foundation,
  nativeCatalogFiles: ReadonlySet<string>,
) {
  const data = new DataWorkspace(copy);
  data.nativeCatalogFiles = nativeCatalogFiles;
  const browse = new BrowseWorkspace(copy, data);
  for (const dependency of foundation.resolvedDependencies.ordered) {
    const root =
      dependency.source === "builtin"
        ? (await casc.ensurePackage(dependency.file.toLowerCase(), ["catalogs"], [])).root
        : dependency.root!;
    data.addDependencyRoot(root, dependency.file.toLowerCase());
    browse.addDependencyRoot(root);
  }
  return browse;
}

type Decor = NonNullable<MissionBuildSpec["decor"]>;
type Role = "landmark" | "ruins" | "vegetation";

function ring(origin: Point2, radius: number, angle: number) {
  return { x: origin.x + radius * Math.cos(angle), y: origin.y + radius * Math.sin(angle) };
}

export async function decorateMission(
  copy: Workspace,
  casc: CascWorkspace,
  browse: BrowseWorkspace,
  terrain: TerrainWorkspace,
  layout: MissionLayout,
  spec: MissionBuildSpec & { decor: Decor },
) {
  const palette = new DecorPalette(browse, new ModelMeasurements(copy, casc));
  const surface = await terrain.surface();
  const style = spec.decor.style;
  const exclusions: ExclusionZone[] = [
    ...(style === "floodedRuins" ? [layout.basin] : []),
    ...(layout.waterArea ? [layout.waterArea] : []),
    ...(layout.landform?.ramps ?? []).map(({ clearance }) => clearance),
    ...layout.zones.map((zone) => ({
      type: "circle" as const,
      center: zone.center,
      radius: zone.radius * 0.65,
    })),
  ];
  const routes: LocationRoute[] = layout.routes.map((route) => ({
    ...route,
    width: route.width + 1.5,
  }));
  const placed: Array<{
    role: Role;
    key: string;
    id: string;
    variation: number;
    rotation: number;
    position: Point2;
    bounds: { minX: number; minY: number; maxX: number; maxY: number };
  }> = [];
  const measures = new Map<string, DecorModel>();
  async function measure(role: Role) {
    const selector = spec.decor[role];
    const cacheKey = selector.actor + ":" + selector.variation;
    let model = measures.get(cacheKey);
    if (!model) {
      model = await palette.resolve({
        ...(selector.actor.startsWith("Actor:") ? { key: selector.actor } : { id: selector.actor }),
        variation: selector.variation,
        preview: false,
      });
      measures.set(cacheKey, model);
    }
    return { model, variation: selector.variation };
  }

  const start = layout.zones[0],
    objective = layout.zones[1];
  const basinCenter = {
    x: (layout.basin.minX + layout.basin.maxX) / 2,
    y: (layout.basin.minY + layout.basin.maxY) / 2,
  };
  let landmark: Point2 | undefined;
  const add = async (role: Role, count: number, candidates: (size: number) => Point2[]) => {
    const { model, variation } = await measure(role);
    const { min, max } = model.measured.measurement.bounds;
    const horizontalBounds = { minX: min[0], minY: min[1], maxX: max[0], maxY: max[1] };
    const size = Math.max(Math.abs(min[0]), Math.abs(min[1]), Math.abs(max[0]), Math.abs(max[1]));
    const reservations =
      landmark && max[2] - min[2] > 2
        ? [...routes, { id: "landmark_sightline", points: [start.center, landmark], width: 5 }]
        : routes;
    let accepted = 0;
    for (const [index, position] of candidates(size).entries()) {
      const rotation = role === "landmark" ? 0 : valueNoise(index, count, spec.seed) * Math.PI;
      const geometry = measuredMemberGeometry(position, 0, {
        offset: { x: 0, y: 0 },
        rotation,
        scale: 1,
        boundsFrame: "member",
        horizontalBounds,
      });
      let bounds;
      try {
        bounds = checkGroupClearance(geometry, layout.playable, reservations, exclusions);
      } catch (error) {
        if (
          error instanceof Error &&
          /^LANDSCAPE_GROUP_(OUTSIDE_ZONE|IN_RESERVED_ROUTE|IN_EXCLUSION)$/.test(error.message)
        )
          continue;
        throw error;
      }
      const samples = [position, ...geometry.corners].map(surface.sample);
      if (
        samples.some(
          (sample) =>
            sample.mask === 0 || sample.hidden || sample.water?.length || sample.slope > 0.34,
        )
      )
        continue;
      if (
        style !== "floodedRuins" &&
        Math.max(...samples.map((s) => s.height)) - Math.min(...samples.map((s) => s.height)) > 0.8
      )
        continue;
      placed.push({
        role,
        key: model.actor.key,
        id: model.actor.id,
        variation,
        rotation,
        position,
        bounds,
      });
      exclusions.push({
        type: "rectangle",
        minX: bounds.minX - 0.6,
        minY: bounds.minY - 0.6,
        maxX: bounds.maxX + 0.6,
        maxY: bounds.maxY + 0.6,
      });
      if (role === "landmark") landmark = position;
      if (++accepted === count) return;
    }
    throw Error("MISSION_DECOR_CANNOT_FIT: " + role + " " + accepted + "/" + count);
  };

  const angles = [0.5, 0.1, 0.9, -0.05, 1.05, -0.18, 1.18, 0.33, 0.67];
  const shelf = layout.landform?.cliffs.at(-1)?.area;
  const terraceCenter = shelf && {
    x: (shelf.minX + shelf.maxX) / 2 + (style === "ridgeRuins" ? 2 : 1),
    y: (shelf.minY + shelf.maxY) / 2,
  };
  await add("landmark", 1, (size) => [
    ...(style !== "floodedRuins" && terraceCenter ? [terraceCenter] : []),
    ...[0, 3, 6].flatMap((offset) =>
      angles.map((angle) =>
        ring(objective.center, objective.radius * 0.68 + size + 1 + offset, angle * Math.PI),
      ),
    ),
  ]);
  const clusterCenters =
    style === "riverShrine"
      ? [
          { x: basinCenter.x - 13, y: basinCenter.y + 2 },
          { x: basinCenter.x + 13, y: basinCenter.y - 12 },
          { x: basinCenter.x - 17, y: basinCenter.y - 14 },
          { x: basinCenter.x + 19, y: basinCenter.y + 14 },
        ]
      : [
          { x: basinCenter.x - 15, y: basinCenter.y + 10 },
          { x: basinCenter.x + 15, y: basinCenter.y - 9 },
          { x: basinCenter.x - 23, y: basinCenter.y - 18 },
          { x: basinCenter.x + 22, y: basinCenter.y + 10 },
        ];
  const clusters = (size: number, offsets: number[]) =>
    offsets.flatMap((radius, tier) =>
      clusterCenters.flatMap((center, group) =>
        Array.from({ length: group === 0 ? 12 : 7 }, (_, i) => {
          const spread = valueNoise(i * 1.13, group * 7 + tier, spec.seed);
          const turn = valueNoise(i * 0.8, tier * 9 + group, spec.seed ^ 811);
          return ring(
            center,
            radius + size + spread * (1.2 + radius * 0.14),
            i * 2.39996 + turn * 0.7 + group * 0.5,
          );
        }),
      ),
    );
  await add("ruins", style === "ridgeRuins" ? 6 : 4, (size) =>
    style !== "floodedRuins"
      ? clusters(size, [3, 5, 8, 11, 15])
      : [objective.center, basinCenter, start.center].flatMap((center, zone) =>
          [11, 16, 22].flatMap((radius) =>
            Array.from({ length: 16 }, (_, i) =>
              ring(center, radius + size, ((i + zone * 0.28) / 16) * Math.PI * 2),
            ),
          ),
        ),
  );
  await add("vegetation", style === "riverShrine" ? 17 : 10, (size) =>
    style !== "floodedRuins"
      ? clusters(size, [0.8, 3, 5, 8, 11, 14, 17])
      : [14, 19, 25, 31].flatMap((radius) =>
          Array.from({ length: 24 }, (_, i) => {
            const stagger = valueNoise(i, radius, spec.seed);
            return ring(
              basinCenter,
              radius + size + stagger * 1.5,
              ((i + stagger / 2) / 24) * Math.PI * 2,
            );
          }),
        ),
  );

  const placement = new PlacementWorkspace(copy, browse);
  placement.terrain = terrain;
  const plan = await placement.addBatch({
    objects: placed.map(({ key, rotation, position, variation }) => ({
      key,
      kind: "Doodad",
      rotation,
      position: { ...position, z: 0 },
      variation,
      snapToTerrain: true,
      maxSlope: 0.34,
    })),
  });
  const result = await placement.apply(plan.id, { dryRun: false, stage: false, backup: false });
  if (!result.accepted) throw Error("MISSION_DECOR_APPLY_REFUSED");
  return placed.map(({ role, id, position, bounds }) => ({ role, id, position, bounds }));
}
