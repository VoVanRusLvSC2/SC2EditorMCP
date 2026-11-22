import { createFlatTerrain, type TerrainSet } from "../document/codecs/flatTerrainFactory.js";
import { parseState } from "../terrain/operations.js";
import { riverDepth, structureLayout } from "./structures.js";
import { segmentDistance, valueNoise } from "../terrain/geometry.js";
import type { WorldSpec, WorldLayout } from "./plan.js";

export function compileWorldSurface(spec: WorldSpec, plan: WorldLayout, sets: TerrainSet[]) {
  if (
    sets.length !== plan.sets.length ||
    sets.some((s, i) => s.id !== plan.sets[i] || s.generic || s.unsupported?.length)
  )
    throw Error("WORLD_UNRESOLVED_PALETTE");
  const { width, height } = spec;
  const structures = structureLayout(spec, plan);
  const blocks = plan.blocks.map((zone) => plan.zones[zone].bank);
  const files = createFlatTerrain(width, height, sets[0], sets[0].textures[0], 4, { sets, blocks });
  const state = parseState(files);
  const masks = state.masks!,
    sync = state.syncTextures!;
  const paletteRoles = plan.zones.map((zone) => {
    const textures = sets[zone.bank].textures;
    const slot = (id: string) => {
      const n = textures.indexOf(id);
      if (n < 0) throw Error("WORLD_MATERIAL_UNAVAILABLE: " + zone.id + "/" + id);
      return n;
    };
    const preferred = zone.materials;
    const slots = preferred?.scatter?.map(slot) ?? textures.map((_, i) => i);
    if (preferred?.ground) {
      const base = slot(preferred.ground);
      return {
        slots: [base, ...slots.filter((s) => s !== base)],
        road: slot(preferred.road ?? textures[Math.min(1, textures.length - 1)]),
        trim: slot(preferred.trim ?? textures.at(-1)!),
      };
    }
    return {
      slots,
      road: slot(preferred?.road ?? textures[Math.min(1, textures.length - 1)]),
      trim: slot(preferred?.trim ?? textures.at(-1)!),
    };
  });
  const used = new Set<string>();
  const zoneAt = (x: number, y: number) =>
    plan.zones[
      plan.blocks[
        (Math.min(height / 8 - 1, Math.floor(y / 8)) * width) / 8 +
          Math.min(width / 8 - 1, Math.floor(x / 8))
      ]
    ];
  function distanceToRoad(x: number, y: number) {
    let distance = Infinity;
    for (const route of plan.routes)
      distance = Math.min(
        distance,
        segmentDistance({ x, y }, route.points[0], route.points[1]) - route.width / 2,
      );
    return distance;
  }
  for (let y = 0; y <= height; y++)
    for (let x = 0; x <= width; x++) {
      const mirror =
        spec.mode === "ladder" && (y > height / 2 || (y === height / 2 && x > width / 2));
      const sx = mirror ? width - x : x,
        sy = mirror ? height - y : y;
      const zone = zoneAt(sx, sy);
      const relief =
        zone.biome === "natural" ? zone.relief * valueNoise(sx / 10, sy / 10, zone.terrainSeed) : 0;
      const blend = Math.max(
        0,
        Math.min(
          1,
          distanceToRoad(sx, sy) / 4,
          (Math.hypot(sx - zone.center.x, sy - zone.center.y) - 8) / 3,
          ...plan.expansions.map((p) => (Math.hypot(sx - p.x, sy - p.y) - 8) / 3),
        ),
      );
      const old = state.heights.z(x, y);
      state.sync!.delta(
        x,
        y,
        state.heights.setZ(x, y, 4 + relief * blend - riverDepth(x, y, structures)) - old,
      );
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const reflect = spec.mode === "ladder" && y >= height / 2;
      const zone = zoneAt(reflect ? width - 1 - x : x, reflect ? height - 1 - y : y),
        textures = sets[zone.bank].textures;
      const roles = paletteRoles[plan.zones.indexOf(zone)];
      const road = distanceToRoad(x + 0.5, y + 0.5) <= 0;
      const totals = new Uint16Array(8);
      for (let dy = 0; dy < 8; dy++)
        for (let dx = 0; dx < 8; dx++) {
          const rawX = x + (dx + 0.5) / 8,
            rawY = y + (dy + 0.5) / 8;
          const px = reflect ? width - rawX : rawX,
            py = reflect ? height - rawY : rawY;
          let index: number,
            mix = 0,
            next: number | undefined;
          if (road) index = roles.road;
          else if (zone.biome === "engineered") {
            const panelWidth = 5 + ((zone.terrainSeed >>> 0) % 4);
            const panelHeight = 6 + ((zone.terrainSeed >>> 4) % 4);
            const u = px - zone.center.x + width,
              v = py - zone.center.y + height;
            const seam = u % panelWidth < 0.375 || v % panelHeight < 0.375;
            index = seam
              ? roles.trim
              : roles.slots[
                  (Math.floor(u / panelWidth) + 3 * Math.floor(v / panelHeight)) %
                    roles.slots.length
                ];
          } else {
            const field =
              (valueNoise(px / 6, py / 6, zone.terrainSeed) + 1) * 0.5 * (roles.slots.length - 1);
            const layer = Math.floor(field);
            index = roles.slots[layer];
            next = roles.slots[Math.min(layer + 1, roles.slots.length - 1)];
            mix = Math.round((field - layer) * 15);
          }
          next ??= index;
          for (let l = 0; l < 8; l++) {
            const weight = (l === index ? 15 - mix : 0) + (l === next ? mix : 0);
            masks.set(x * 8 + dx, y * 8 + dy, l, weight);
            totals[l] += weight;
          }
        }
      const dominant = totals.indexOf(Math.max(...totals));
      sync.set(x, y, zone.bank * 8 + dominant);
      textures.forEach((id, layer) => {
        if (totals[layer]) used.add(id);
      });
    }
  return { files, paintedTextures: [...used].sort() };
}
