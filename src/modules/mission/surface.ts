import { areaDistance, valueNoise } from "../terrain/geometry.js";
import type { Point2, TerrainArea, TerrainOperation } from "../terrain/types.js";
import { groundShapes, type MissionLayout } from "./layout.js";
import type { MissionBuildSpec } from "./buildSpec.js";
import { riverStrip } from "./river.js";

type Profile = "wetland" | "highland";
interface Material {
  trail: string;
  accent?: string;
  detail?: string;
}

const circle = (center: Point2, radius: number): TerrainArea => ({
  type: "circle",
  center,
  radius,
});

export function pavedBaseGeometry(
  layout: MissionLayout,
  zone: NonNullable<MissionBuildSpec["terrain"]["baseSurface"]>["zone"],
) {
  const { center, radius } = layout.zones[["start", "objective", "bonus"].indexOf(zone)];
  const half = radius / Math.SQRT2 - 0.75;
  const { x, y } = center;
  const trim = 0.68;
  const minX = x - half,
    minY = y - half,
    maxX = x + half,
    maxY = y + half;
  return {
    floor: { minX, minY, maxX, maxY },
    trim,
    inner: { minX: minX + trim, minY: minY + trim, maxX: maxX - trim, maxY: maxY - trim },
    outer: { minX: minX - trim, minY: minY - trim, maxX: maxX + trim, maxY: maxY + trim },
  };
}

export function pavedBaseSurface(
  layout: MissionLayout,
  {
    zone,
    floorTexture,
    trimTexture,
  }: {
    zone: NonNullable<MissionBuildSpec["terrain"]["baseSurface"]>["zone"];
    floorTexture: string;
    trimTexture: string;
  },
): TerrainOperation[] {
  const {
    floor: { minX, minY, maxX, maxY },
    trim,
  } = pavedBaseGeometry(layout, zone);
  // Center each painted strip on the actual floor-to-ground seam.
  const areas = [
    [minX, minY, maxX, maxY],
    [minX - trim, minY - trim, maxX + trim, minY + trim],
    [minX - trim, maxY - trim, maxX + trim, maxY + trim],
    [minX - trim, minY + trim, minX + trim, maxY - trim],
    [maxX - trim, minY + trim, maxX + trim, maxY - trim],
  ];
  return areas.map(([minX, minY, maxX, maxY], index) => ({
    op: "texture.paint",
    area: { type: "rectangle", minX, minY, maxX, maxY },
    texture: index === 0 ? floorTexture : trimTexture,
  }));
}

function outline(
  center: Point2,
  rx: number,
  ry: number,
  seed: number,
  roundness: number,
  rotation = 0,
): TerrainArea {
  return {
    type: "polygon",
    points: Array.from({ length: 24 }, (_, index) => {
      const angle = (index / 24) * Math.PI * 2;
      const x = Math.cos(angle),
        y = Math.sin(angle);
      const round = (Math.abs(x) ** roundness + Math.abs(y) ** roundness) ** (-1 / roundness);
      const weather = 1 + valueNoise(x * 2.3 + 7, y * 2.3, seed) * 0.19;
      const dx = x * round * rx * weather;
      const dy = y * round * ry * weather;
      return {
        x: center.x + dx * Math.cos(rotation) - dy * Math.sin(rotation),
        y: center.y + dx * Math.sin(rotation) + dy * Math.cos(rotation),
      };
    }),
  };
}

/** Rounded, asymmetrical footprint within the altitude envelope of the writer. */
export function sculptMissionSurface(
  profile: Profile,
  layout: MissionLayout,
  seed: number,
  heights: { base: number; up: number; down: number },
  material: Material,
): { operations: TerrainOperation[]; waterLevel: number } {
  const { corridors, pads } = groundShapes(layout);
  const nativeReservations = [
    ...(layout.landform?.cliffs ?? []).map(({ area }) => ({
      ...area,
      minX: area.minX - 2,
      minY: area.minY - 2,
      maxX: area.maxX + 2,
      maxY: area.maxY + 2,
    })),
    ...(layout.landform?.ramps ?? []).map(({ clearance }) => clearance),
  ];
  const protectedAreas = [
    ...corridors.map((corridor) => ({ ...corridor, width: corridor.width + 5 })),
    ...pads,
    ...nativeReservations,
  ];
  const { base, up, down } = heights;
  const wetland = profile === "wetland";
  const depth = Math.min(layout.river ? 2.5 : wetland ? 3.2 : 2.8, down * 0.66);
  const summit = Math.min(wetland ? 3.8 : 5.5, up * 0.7);
  const { basin, playable, zones } = layout;
  const mainClearings = layout.river
    ? pads.slice(0, 2).map((pad, i) => {
        const { x, y } = pad.center;
        const rx = Math.min(pad.radius * 1.35 + 3, Math.min(x, playable.maxX + 4 - x) * 0.81);
        const ry = Math.min(pad.radius * 1.1 + 3, Math.min(y, playable.maxY + 4 - y) * 0.81);
        return outline(pad.center, rx, ry, (seed + i * 379) | 0, 2);
      })
    : [];
  const center = { x: (basin.minX + basin.maxX) / 2, y: (basin.minY + basin.maxY) / 2 };
  const rx = (basin.maxX - basin.minX) / 2 + 1.5;
  const ry = (basin.maxY - basin.minY) / 2 + 1.25;
  const boundary = layout.river
    ? riverStrip(layout.river, 2.5)
    : outline(center, rx, ry, seed, 2.5);
  const water = wetland && !layout.river ? layout.waterArea : undefined;
  const pond = water && {
    center: { x: (water.minX + water.maxX) / 2, y: (water.minY + water.maxY) / 2 },
    rx: Math.min(rx * 0.93, (water.maxX - water.minX) * 0.41),
    ry: Math.min(ry * 0.94, (water.maxY - water.minY) * 0.41),
  };
  const terrainClear = [...protectedAreas, boundary];
  const operations: TerrainOperation[] = [
    {
      op: "height.noise",
      area: playable,
      amplitude: Math.min(1.35, up * 0.2, down * 0.2, wetland ? depth * 0.32 : Infinity),
      wavelength: 28,
      edgeBlend: 9,
      seed,
      protectedAreas,
    },
    {
      op: "height.noise",
      area: playable,
      amplitude: Math.min(0.3, up * 0.045, down * 0.045, wetland ? depth * 0.09 : Infinity),
      wavelength: 6,
      edgeBlend: 5,
      seed: (seed + 219) | 0,
      protectedAreas,
    },
    ...(layout.river || layout.landform?.style === "splitRidge"
      ? []
      : [
          {
            op: "height.set",
            area: boundary,
            height: base - depth * (pond ? 0.3 : 1),
            edgeBlend: wetland ? 5 : 5.8,
            protectedAreas,
          } satisfies TerrainOperation,
        ]),
  ];
  if (layout.river) {
    operations.push({
      op: "height.set",
      area: riverStrip(layout.river),
      height: base - depth,
      edgeBlend: 3.8,
      protectedAreas,
    });
    // The feathered brush also falls off across its end caps. Open just the
    // submerged channel core at both map edges so the river crosses the map.
    const end = layout.river.carrier.maxY;
    for (const [minY, maxY] of [
      [0, 4],
      [end - 4, end],
    ]) {
      operations.push({
        op: "height.set",
        area: riverStrip(layout.river, -2.9, minY, maxY),
        height: base - depth,
        protectedAreas,
      });
    }
  }
  if (pond) {
    // The engine water layer uses 8x8 tiles. Keep terrain above the
    // water at their edges and carve the visible shoreline inside them.
    operations.push({
      op: "height.set",
      area: outline(pond.center, pond.rx, pond.ry, (seed + 71) | 0, 2.2),
      height: base - depth,
      edgeBlend: Math.min(pond.rx, pond.ry) * 0.47,
      protectedAreas,
    });
  }

  const direction = zones[1].center.y >= zones[0].center.y ? 1 : -1;
  const shoulderCenters = [
    { x: center.x - rx - 10, y: center.y - ry * 0.52 },
    { x: center.x + rx + 10, y: center.y + ry * 0.28 },
    { x: zones[0].center.x - 16, y: zones[0].center.y + 6 * direction },
    { x: zones[0].center.x + 15, y: zones[0].center.y - 3 * direction },
    { x: zones[1].center.x + 12, y: zones[1].center.y + 4 * direction },
  ];
  for (const [index, position] of (layout.landform ? [] : shoulderCenters).entries()) {
    const radius = Math.min(16 + (index % 2) * 3, areaDistance(playable, position));
    if (radius < 6 || summit <= 0) continue;
    const peak = Math.max(0.6, 0.83 + valueNoise(index, 11, seed) * 0.16);
    operations.push({
      op: "height.set",
      area: circle(position, radius),
      height: base + summit * peak,
      edgeBlend: radius * 0.84,
      protectedAreas: terrainClear,
    });
  }
  if (layout.landform) {
    const massifs = wetland
      ? [
          { x: center.x - 18, y: center.y - 15, length: 19, width: 7, angle: 0.43, height: 0.57 },
          { x: center.x + 24, y: center.y + 8, length: 22, width: 9, angle: -1.22, height: 0.67 },
          { x: center.x - 20, y: center.y + 20, length: 14, width: 6, angle: 0.95, height: 0.42 },
        ]
      : [
          { x: center.x + 26, y: center.y - 4, length: 27, width: 11, angle: 1.08, height: 0.96 },
          { x: center.x + 22, y: center.y + 18, length: 17, width: 8, angle: -0.67, height: 0.83 },
          { x: center.x - 24, y: center.y - 15, length: 25, width: 12, angle: -0.52, height: 0.91 },
          { x: center.x - 28, y: center.y + 14, length: 15, width: 7, angle: 0.7, height: 0.68 },
        ];
    for (const [index, massif] of massifs.entries()) {
      const extent = areaDistance(playable, massif);
      const length = Math.min(massif.length, extent * 0.92);
      const width = Math.min(massif.width, length);
      if (width < 4) continue;
      operations.push({
        op: "height.set",
        area: outline(massif, length, width, (seed + index * 263) | 0, 2, massif.angle),
        height: base + summit * massif.height,
        edgeBlend: width * 0.82,
        protectedAreas: wetland ? terrainClear : protectedAreas,
      });
    }
  }
  // Feather the shoulders into the reserved flat path edges and plaza floors.
  for (const corridor of corridors)
    operations.push({
      op: "height.set",
      area: { ...corridor, width: corridor.width + 10 },
      height: base,
      edgeBlend: 4,
      protectedAreas: nativeReservations,
    });
  for (const pad of pads)
    operations.push({
      op: "height.set",
      area: { ...pad, radius: pad.radius + 4 },
      height: base,
      edgeBlend: 3.5,
      protectedAreas: nativeReservations,
    });
  for (const area of mainClearings)
    operations.push({
      op: "height.set",
      area,
      height: base,
      edgeBlend: 4.6,
      protectedAreas: nativeReservations,
    });

  if (material.detail)
    operations.push({
      op: "texture.paint_rules",
      area: playable,
      strength: wetland ? 0.8 : 0.66,
      edgeBlend: 6,
      pattern: { wavelength: 7.5, threshold: -0.28, transition: 0.78, seed: (seed + 972) | 0 },
      rules: [{ texture: material.detail, minHeight: base - depth * 0.82, heightFade: 1.4 }],
    });
  if (material.accent)
    operations.push(
      {
        op: "texture.blend",
        area: boundary,
        texture: layout.river ? material.trail : material.accent,
        strength: layout.river ? 0.62 : wetland ? 0.57 : 0.73,
        edgeBlend: layout.river ? 4.2 : 5.8,
        pattern: {
          wavelength: layout.river ? 11 : 8,
          threshold: layout.river ? -0.44 : -0.55,
          transition: layout.river ? 0.89 : 0.83,
          seed: (seed + 127) | 0,
        },
      },
      {
        op: "texture.paint_rules",
        area: playable,
        strength: wetland ? 0.44 : 0.72,
        edgeBlend: 6,
        pattern: { wavelength: 5.8, threshold: -0.38, transition: 0.86, seed: (seed + 43) | 0 },
        rules: [
          { texture: material.accent, minHeight: base + summit * 0.47, heightFade: 2 },
          {
            texture: material.accent,
            minSlope: 0.31,
            slopeFade: 0.34,
            ...(layout.river ? { minHeight: base - 0.3, heightFade: 0.75 } : {}),
          },
        ],
      },
      {
        op: "texture.blend",
        area: outline(pads[1].center, pads[1].radius + 1, pads[1].radius, seed ^ 319, 2),
        texture: material.accent,
        strength: 0.88,
        edgeBlend: 5.2,
      },
    );
  operations.push({
    op: "texture.blend",
    area: pads[0],
    texture: material.trail,
    strength: 0.69,
    edgeBlend: 5,
  });
  for (const [index, corridor] of corridors.entries())
    operations.push({
      op: "texture.blend",
      area: { ...corridor, width: corridor.width + (index === 0 ? 5 : 3.8) },
      texture: material.trail,
      strength: index === 0 ? 0.82 : 0.58,
      edgeBlend: index === 0 ? 4.4 : 3.8,
      pattern: { wavelength: 6, threshold: -0.63, transition: 0.9, seed: (seed + index * 37) | 0 },
    });
  for (const area of mainClearings)
    operations.push({
      op: "texture.blend",
      area,
      texture: material.trail,
      strength: 0.84,
      edgeBlend: 5,
      pattern: { wavelength: 9, threshold: -0.66, transition: 0.8, seed: (seed + 817) | 0 },
    });
  // Grade the approach with material masks. Native side-cap cutouts and the
  // ramp's topology stay owned by the cardinal ramp writer.
  for (const [index, ramp] of (layout.landform?.ramps ?? []).entries()) {
    const rampSeed = (seed + index * 491) | 0;
    const rotation = ramp.direction === "east" ? 0 : Math.PI / 2;
    const along =
      ramp.direction === "east"
        ? Math.min(ramp.center.x - playable.minX, playable.maxX - ramp.center.x)
        : Math.min(ramp.center.y - playable.minY, playable.maxY - ramp.center.y);
    operations.push({
      op: "texture.blend",
      area: outline(ramp.center, Math.min(9, along * 0.9), 5.6, rampSeed, 2, rotation),
      texture: material.trail,
      strength: 0.82,
      edgeBlend: 4.1,
      pattern: { wavelength: 5, threshold: -0.6, transition: 0.9, seed: rampSeed },
      protectedAreas: pads,
    });
  }
  return { operations, waterLevel: base - depth * (wetland ? 0.5 : 0.58) };
}
