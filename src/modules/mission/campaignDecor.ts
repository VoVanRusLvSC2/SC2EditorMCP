import type { Workspace } from "../../core/workspace.js";
import { ModelMeasurements } from "../assets/measurement.js";
import type { BrowseWorkspace } from "../browse/workspace.js";
import type { CascWorkspace } from "../casc/workspace.js";
import { measuredMemberGeometry } from "../placement/compositionGeometry.js";
import { DecorPalette, type DecorModel } from "../placement/decorPalette.js";
import { checkGroupClearance } from "../placement/groupClearance.js";
import type { CatalogRow, StyleCatalog } from "../placement/styleCatalog.js";
import type { ExclusionZone } from "../placement/types.js";
import { PlacementWorkspace } from "../placement/workspace.js";
import { valueNoise } from "../terrain/geometry.js";
import type { Point2 } from "../terrain/types.js";
import type { TerrainWorkspace } from "../terrain/workspace.js";
import type { MissionBuildSpec } from "./buildSpec.js";
import type { MissionLayout } from "./layout.js";
import { riverSection } from "./river.js";
import { pavedBaseGeometry } from "./surface.js";

type Role = "bank" | "canopy" | "talus" | "outpost";
type Pack = Awaited<ReturnType<StyleCatalog["pack"]>>;
const preferences = {
  bank: {
    match: /shrub|bush|grass|reed|underbrush|groundcover|foliage/i,
    query: "low leafy plants",
    kind: "natural",
    width: 4,
    height: [0.16, 2.5],
    count: 72,
  },
  canopy: {
    match: /nature\/trees|tree/i,
    query: "tall leafy tree",
    kind: "natural",
    width: 13,
    height: [2.5, 17],
    count: 30,
  },
  talus: {
    match: /nature\/rocks|rubble|debris/i,
    query: "scattered rock chunks",
    kind: "natural",
    width: 5.5,
    height: [0.22, 2.5],
    count: 22,
  },
  outpost: {
    match: /floodlight|crate|storagetank|console|sandbags|props\/storage/i,
    query: "industrial crates floodlight",
    kind: "built",
    width: 4.5,
    height: [0.4, 6.5],
    count: 6,
  },
} as const;

export async function decorateCampaignRiver(
  copy: Workspace,
  casc: CascWorkspace,
  browse: BrowseWorkspace,
  terrain: TerrainWorkspace,
  layout: MissionLayout,
  spec: MissionBuildSpec,
  pack: Pack,
  waterLevel: number,
) {
  if (!layout.river) throw Error("CAMPAIGN_DECOR_REQUIRES_RIVER");
  const river = layout.river;
  const palette = new DecorPalette(browse, new ModelMeasurements(copy, casc));
  const surface = await terrain.surface();
  const routes = layout.routes.map((r) => ({ ...r, width: r.width + 0.8 }));
  const terrainExclusions: ExclusionZone[] = (layout.landform?.ramps ?? []).map((r) => r.clearance);
  const padExclusions: ExclusionZone[] = layout.zones.map((z) => ({
    type: "circle",
    center: z.center,
    radius: z.radius + 0.4,
  }));
  const base =
    spec.terrain.baseSurface && pavedBaseGeometry(layout, spec.terrain.baseSurface.zone).inner;
  const placed: {
    role: Role;
    id: string;
    key: string;
    position: Point2;
    rotation: number;
    scale: number;
    variation: number;
    bounds: ReturnType<typeof checkGroupClearance>;
  }[] = [];
  const occupied = new Map<string, Set<ExclusionZone>>();
  const lush = spec.decorDensity === "lush";

  function bins(minX: number, minY: number, maxX: number, maxY: number) {
    const keys = [];
    for (let y = Math.floor(minY / 8); y <= Math.floor(maxY / 8); y++)
      for (let x = Math.floor(minX / 8); x <= Math.floor(maxX / 8); x++) keys.push(x + ":" + y);
    return keys;
  }

  function inlandPositions(role: "bank" | "canopy"): Point2[] {
    const area = layout.playable;
    const groups = Math.max(8, Math.ceil((area.maxY - area.minY) / 6));
    const neighborhoods: { x: number; y: number; jitter: number }[] = [];
    for (let group = 0; group < groups; group++) {
      const y =
        area.minY +
        ((group + 0.5) * (area.maxY - area.minY)) / groups +
        valueNoise(group * 1.9, 71, spec.seed) * 2.5;
      const riverX = riverSection(river, y).x;
      for (const [side, boundary] of [
        [-1, area.minX],
        [1, area.maxX],
      ] as const) {
        for (const fraction of [0.33, 0.58, 0.82]) {
          const jitter = group * 83 + side * 13 + Math.round(fraction * 100);
          const x =
            riverX + (boundary - riverX) * fraction + valueNoise(jitter * 0.14, 21, spec.seed) * 4;
          neighborhoods.push({ x, y, jitter });
        }
      }
    }
    const spread = role === "canopy" ? 6 : 4;
    // Give each neighborhood a candidate before returning to fill a cluster.
    return Array.from({ length: role === "canopy" ? 12 : 24 }, (_, i) =>
      neighborhoods.map(({ x, y, jitter }) => ({
        x: x + valueNoise(i * 1.7, jitter + 19, spec.seed) * spread,
        y: y + valueNoise(i * 1.4, jitter + 41, spec.seed) * spread,
      })),
    ).flat();
  }

  async function models(role: Role) {
    const rule = preferences[role];
    const rows: CatalogRow[] =
      pack.sections[role === "bank" || role === "canopy" ? "vegetation" : "decor"] ?? [];
    const matches = rows.filter((r) => rule.match.test([r.id, ...(r.roles ?? [])].join(" ")));
    const queries =
      lush && role === "bank"
        ? ["fern", "grass tuft", "bush", rule.query]
        : lush && role === "canopy"
          ? ["leafy tree", "wide canopy tree", rule.query]
          : [rule.query];
    const searched = await Promise.all(
      queries.map((query) => browse.search({ query, doodads: { kind: rule.kind }, limit: 16 })),
    );
    const referenceIds = matches.slice(0, 11).map((r) => r.id);
    const sets = [referenceIds, ...searched.map(({ results }) => results.map(({ id }) => id))];
    const ids = [
      ...new Set(
        sets.length > 2
          ? Array.from({ length: 16 }, (_, i) => sets.flatMap((set) => set.slice(i, i + 1))).flat()
          : sets.flat(),
      ),
    ];
    const paletteSize = lush && role === "bank" ? 7 : lush && role === "canopy" ? 5 : 3;
    const selected: DecorModel[] = [];
    for (const id of ids) {
      try {
        const d = await palette.resolve({ id, variation: 0, preview: false });
        const size = d.measured.measurement.dimensions;
        if (
          Math.max(size.width, size.depth) > rule.width ||
          size.height < rule.height[0] ||
          size.height > rule.height[1]
        )
          continue;
        selected.push(d);
        if (selected.length === paletteSize) break;
      } catch {
        // Observation packs include incompatible references; continue with local candidates.
      }
    }
    if (!selected.length)
      throw Error(
        "MISSION_CAMPAIGN_DECOR_NO_MEASURED_ASSET: " + role + " " + ids.slice(0, 8).join(","),
      );
    return selected;
  }

  function positions(role: Role): Point2[] {
    const height = river.carrier.maxY;
    if (role === "outpost" && base) {
      const xs = [0.15, 0.86, 0.26, 0.7, 0.4],
        ys = [0.18, 0.8, 0.5, 0.7, 0.3];
      return ys.flatMap((v) =>
        xs.map((u) => ({
          x: base.minX + (base.maxX - base.minX) * u,
          y: base.minY + (base.maxY - base.minY) * v,
        })),
      );
    }
    if (role === "talus" && layout.landform?.cliffs.length) {
      return layout.landform.cliffs.flatMap(({ area, strokes }, j) =>
        Array.from({ length: 44 }, (_, i) => {
          const t = ((i % 22) + 0.5) / 22;
          const along = area.minY + (area.maxY - area.minY) * t;
          const distance = 1.9 + (i % 4) * 0.8 + valueNoise(i, j, spec.seed);
          const edge = strokes.find((s) => s.minY <= along && s.maxY >= along) ?? area;
          return { x: i < 22 ? edge.maxX + distance : edge.minX - distance, y: along };
        }),
      );
    }
    if (role === "canopy") {
      const groves = [0.13, 0.39, 0.66, 0.86, 0.23, 0.52, 0.77, 0.91];
      return groves.flatMap((fraction, group) => {
        const side = group % 3 === 1 ? 1 : -1;
        return Array.from({ length: 12 }, (_, i) => {
          const y = height * fraction + valueNoise(i * 0.92, group * 11, spec.seed) * 9;
          const center = riverSection(river, y);
          const distance = 5.8 + (i % 4) * 2.25 + valueNoise(i, group + 2, spec.seed) * 3;
          return { x: center.x + side * (center.halfWidth + distance), y };
        });
      });
    }
    const yPositions = Array.from(
      { length: 24 },
      (_, i) => 8 + ((height - 16) * ((i * 7) % 24)) / 23,
    );
    return yPositions.flatMap((y, i) =>
      [-1, 1].flatMap((side) => {
        const center = riverSection(river, y);
        const distance = 0.3;
        return [0, 1.45, 3.1].map((offset) => ({
          x:
            center.x +
            side * (center.halfWidth + distance + offset + valueNoise(i, side, spec.seed)),
          y: y + offset * 1.15 + side * valueNoise(i, offset, spec.seed) * 1.2,
        }));
      }),
    );
  }

  for (const role of ["outpost", "talus", "canopy", "bank"] as const) {
    if ((role === "outpost" && !base) || (role === "talus" && !layout.landform?.cliffs.length))
      continue;
    const available = await models(role);
    const area =
      (layout.playable.maxX - layout.playable.minX) * (layout.playable.maxY - layout.playable.minY);
    const limit =
      lush && (role === "bank" || role === "canopy")
        ? Math.ceil((area / 1024) * (role === "bank" ? 31 : 9))
        : preferences[role].count;
    const candidates = positions(role);
    if (lush && (role === "bank" || role === "canopy")) candidates.push(...inlandPositions(role));
    const exclusions =
      role === "outpost" ? terrainExclusions : [...terrainExclusions, ...padExclusions];
    let count = 0;
    for (const [i, position] of candidates.entries()) {
      const vary = lush && (role === "bank" || role === "canopy");
      const scale = vary
        ? 0.99 + valueNoise(position.x * 0.7, position.y * 0.7, spec.seed) * 0.23
        : 1;
      const patch = vary
        ? Math.round(valueNoise(position.x * 0.1, position.y * 0.1, spec.seed) * 4)
        : 0;
      const rotation =
        role === "outpost"
          ? ((i % 4) * Math.PI) / 2
          : valueNoise(i, 73 + count, spec.seed) * Math.PI;
      for (let offset = 0; offset < available.length; offset++) {
        const model =
          available[
            (i + offset + (patch % available.length) + available.length) % available.length
          ];
        const { min, max } = model.measured.measurement.bounds;
        const geometry = measuredMemberGeometry(position, 0, {
          offset: { x: 0, y: 0 },
          scale,
          rotation,
          boundsFrame: "member",
          horizontalBounds: { minX: min[0], maxX: max[0], minY: min[1], maxY: max[1] },
        });
        const rectangle =
          role === "outpost" && base
            ? {
                type: "rectangle" as const,
                minX: base.minX + 0.55,
                minY: base.minY + 0.55,
                maxX: base.maxX - 0.55,
                maxY: base.maxY - 0.55,
              }
            : layout.playable;
        const corners = geometry.corners;
        const nearby = new Set(
          bins(
            Math.min(...corners.map((p) => p.x)),
            Math.min(...corners.map((p) => p.y)),
            Math.max(...corners.map((p) => p.x)),
            Math.max(...corners.map((p) => p.y)),
          ).flatMap((key) => [...(occupied.get(key) ?? [])]),
        );
        let bounds;
        try {
          bounds = checkGroupClearance(geometry, rectangle, routes, [...exclusions, ...nearby]);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("LANDSCAPE_GROUP_")) continue;
          throw error;
        }
        const samples = [position, ...geometry.corners].map(surface.sample);
        if (
          samples.some(
            (s) =>
              s.height < waterLevel + 0.22 ||
              !s.mask ||
              s.hidden ||
              s.nativeMeshHole ||
              s.slope > (role === "bank" ? 0.7 : 0.4),
          )
        )
          continue;
        const heights = samples.map((s) => s.height);
        if (Math.max(...heights) - Math.min(...heights) > (role === "bank" ? 0.85 : 0.65)) continue;
        placed.push({
          role,
          id: model.actor.id,
          key: model.actor.key,
          variation: model.variation!,
          position,
          rotation,
          scale,
          bounds,
        });
        const reservation = {
          ...bounds,
          minX: bounds.minX - 0.28,
          minY: bounds.minY - 0.28,
          maxX: bounds.maxX + 0.28,
          maxY: bounds.maxY + 0.28,
        };
        for (const key of bins(
          reservation.minX,
          reservation.minY,
          reservation.maxX,
          reservation.maxY,
        )) {
          const bucket = occupied.get(key) ?? new Set();
          bucket.add(reservation);
          occupied.set(key, bucket);
        }
        count++;
        break;
      }
      if (count === limit) break;
    }
    if (!count) throw Error("MISSION_CAMPAIGN_DECOR_NO_GROUNDED_PLACEMENT: " + role);
  }
  const placement = new PlacementWorkspace(copy, browse);
  placement.terrain = terrain;
  const plan = await placement.addBatch({
    objects: placed.map(({ key, rotation, scale, position, variation }) => ({
      kind: "Doodad",
      key,
      rotation,
      ...(scale !== 1 ? { scale } : {}),
      position: { ...position, z: 0 },
      variation,
      snapToTerrain: true,
    })),
  });
  if (!(await placement.apply(plan.id, { dryRun: false, stage: false, backup: false })).accepted)
    throw Error("MISSION_CAMPAIGN_DECOR_APPLY_REFUSED");
  return placed.map(({ role, id, position, bounds }) => ({ role, id, position, bounds }));
}
