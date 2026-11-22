import type { BrowseWorkspace } from "../browse/workspace.js";
import type { ModelMeasurements } from "../assets/measurement.js";
import { DecorPalette } from "../placement/decorPalette.js";
import { StyleCatalog } from "../placement/styleCatalog.js";
import type { PlacementObject } from "../placement/types.js";
import { segmentDistance, valueNoise } from "../terrain/geometry.js";
import type { TerrainState } from "../terrain/operations.js";
import { riverDepth, structureLayout } from "./structures.js";
import type { WorldSpec, WorldLayout } from "./plan.js";

export async function worldDecor(
  spec: WorldSpec,
  plan: WorldLayout,
  browse: BrowseWorkspace,
  measurements: ModelMeasurements,
  surface: TerrainState,
) {
  const palette = new DecorPalette(browse, measurements),
    catalog = new StyleCatalog();
  const structures = structureLayout(spec, plan);
  const placements: PlacementObject[] = [];
  const used: { x: number; y: number; radius: number }[] = [];
  for (const [index, zone] of plan.zones.entries()) {
    if (!zone.distinctActors) continue;
    const mirror =
      spec.mode === "ladder"
        ? plan.zones.findIndex(
            (z) =>
              z.center.x + zone.center.x === spec.width &&
              z.center.y + zone.center.y === spec.height,
          )
        : -1;
    if (mirror >= 0 && mirror < index) continue;
    let candidates = [...new Set(zone.actors)];
    if (!candidates.length) {
      const reference = await catalog.pack(zone.tileSet);
      const section = zone.biome === "natural" ? "vegetation" : "decor";
      const kind = zone.biome === "natural" ? "natural" : "built";
      const terms =
        zone.biome === "natural"
          ? ["tree", "fern", "forest", "shrub", "rock"]
          : [
              zone.tileSet.replace(/Ex\d+$/, ""),
              "laboratory",
              "console",
              "industrial",
              "storage",
              "lab",
            ];
      const searches = await Promise.all(
        terms.map((query) =>
          browse.search({ query, catalogType: "Actor", doodads: { kind }, limit: 32 }),
        ),
      );
      const lists = [reference.sections[section] ?? [], ...searches.map((s) => s.results)];
      candidates = [
        ...new Set(
          Array.from({ length: Math.max(...lists.map((l) => l.length)) }, (_, i) =>
            lists.flatMap((rows) => (rows[i] ? [rows[i].id] : [])),
          ).flat(),
        ),
      ];
    }
    const actors = new Set<string>();
    const failures: string[] = [];
    const blocks = plan.blocks.flatMap((owner, i) => (owner === index ? [i] : []));
    for (const id of candidates) {
      if (actors.size >= zone.distinctActors) break;
      let model;
      try {
        model = await palette.resolve({ id, variation: 0, preview: false });
      } catch (error) {
        failures.push(String(error));
        continue;
      }
      if (actors.has(model.actor.id)) continue;
      const bounds = model.measured.measurement.bounds;
      const radius = Math.max(
        0.5,
        Math.hypot(
          Math.max(Math.abs(bounds.min[0]), Math.abs(bounds.max[0])),
          Math.max(Math.abs(bounds.min[1]), Math.abs(bounds.max[1])),
        ),
      );
      const count = 1 + Math.floor((zone.density * blocks.length) / zone.distinctActors);
      let placed = 0;
      for (let i = 0; i < 256 && placed < count; i++) {
        const ordinal = i + candidates.indexOf(id) * 263;
        const noise = (channel: number) => (1 + valueNoise(ordinal, channel, zone.decorSeed)) / 2;
        const block = blocks[Math.min(blocks.length - 1, Math.floor(noise(1) * blocks.length))];
        const x = ((block % (spec.width / 8)) + noise(2)) * 8,
          y = (Math.floor(block / (spec.width / 8)) + noise(3)) * 8;
        if (
          Math.min(x, y, spec.width - x, spec.height - y) < radius + 2 ||
          plan.zones.some((z) => Math.hypot(x - z.center.x, y - z.center.y) < radius + 10) ||
          plan.expansions.some((p) => Math.hypot(x - p.x, y - p.y) < radius + 10) ||
          plan.routes.some(
            (r) => segmentDistance({ x, y }, r.points[0], r.points[1]) < radius + r.width / 2 + 1,
          ) ||
          used.some((p) => Math.hypot(x - p.x, y - p.y) < p.radius + radius)
        )
          continue;
        const sample = surface.heights.sample({ x, y });
        if (sample.slope > 0.34 || riverDepth(x, y, structures) > 0.1) continue;
        const positions = [{ x, y }];
        if (mirror >= 0) {
          const reflected = { x: spec.width - x, y: spec.height - y };
          if (
            Math.hypot(x - reflected.x, y - reflected.y) < 2 * radius ||
            riverDepth(reflected.x, reflected.y, structures) > 0.1
          )
            continue;
          positions.push(reflected);
        }
        for (const [side, position] of positions.entries()) {
          placements.push({
            kind: "Doodad",
            catalogId: model.actor.id,
            variation: 0,
            position: { ...position, z: surface.heights.sample(position).height },
            rotation: (noise(4) * Math.PI * 2 + side * Math.PI) % (Math.PI * 2),
          });
          used.push({ ...position, radius });
        }
        placed++;
        actors.add(model.actor.id);
      }
    }
    if (actors.size < zone.distinctActors)
      throw Error(
        "WORLD_DECOR_QUOTA: " +
          JSON.stringify({
            zone: zone.id,
            requested: zone.distinctActors,
            placed: [...actors],
            candidates: candidates.length,
            failures: failures.slice(0, 3),
          }),
      );
  }
  return placements;
}
