import { areaDistance } from "../terrain/geometry.js";
import type { Point2, TerrainArea, TerrainOperation } from "../terrain/types.js";

type Rect = Extract<TerrainArea, { type: "rectangle" }>;
export type LandformStyle = "riverTerraces" | "splitRidge";
export type CliffEdge = "natural" | "engineered";

interface LayoutGeometry {
  basin: Rect;
  playable: Rect;
  waterArea?: Rect;
  river?: boolean;
  routes: { width: number; points: Point2[] }[];
  zones: { radius: number; center: Point2 }[];
}

export interface Terrace {
  area: Rect;
  strokes: Rect[];
  level: 2 | 3;
}

export interface Ramp {
  center: Point2;
  direction: "east" | "north";
  lowerLevel: 1 | 2;
  clearance: Rect;
}

const rectangle = (minX: number, minY: number, maxX: number, maxY: number): Rect => ({
  type: "rectangle",
  minX,
  minY,
  maxX,
  maxY,
});
const expand = (a: Rect, by: number) =>
  rectangle(a.minX - by, a.minY - by, a.maxX + by, a.maxY + by);
const even = (value: number) => Math.round(value / 2) * 2;
const mid = (a: Rect): Point2 => ({ x: (a.minX + a.maxX) / 2, y: (a.minY + a.maxY) / 2 });

function terraceStrokes(
  area: Rect,
  edge: CliffEdge,
  bank: boolean,
  level: Terrace["level"],
): Rect[] {
  if (edge === "engineered") return [area];
  const { minX, minY, maxX, maxY } = area;
  // Keep the approach face straight through both ramp rails. Each shoulder
  // shares a span with the core, so the terrace has no point-only joins.
  if (bank)
    return [
      rectangle(minX, minY, maxX - 4, maxY),
      rectangle(minX + 2, minY + 2, maxX, maxY - 2),
      rectangle(maxX - 6, minY + 2, maxX - 2, maxY),
    ];
  if (level === 3)
    return [
      rectangle(minX, minY + 2, maxX, maxY - 2),
      rectangle(minX + 2, minY, maxX - 2, minY + 4),
      rectangle(minX, maxY - 4, maxX - 4, maxY),
    ];
  return [
    rectangle(minX, minY + 6, maxX, maxY - 6),
    rectangle(minX + 4, minY, maxX - 6, minY + 8),
    rectangle(minX + 2, minY + 4, maxX - 4, minY + 8),
    rectangle(minX + 2, maxY - 8, maxX - 2, maxY - 2),
    rectangle(minX + 6, maxY - 6, maxX - 6, maxY),
  ];
}

function riverTerraceStrokes(area: Rect, edge: CliffEdge, elongated: boolean) {
  if (edge === "engineered") return [area];
  const { minX, minY, maxX, maxY } = area;
  const center = mid(area);
  const rampY = even(center.y) - 1;
  const strokes: Rect[] = [];
  // Keep the adjacent two-cell cliff tiles straight as well as the ramp
  // footprint. Turning the wall at the end of a side cap can expose a gap.
  for (let y = minY; y < maxY; y += 2) {
    const t = (y + 1 - center.y) / ((maxY - minY) / 2);
    const half = (maxX - minX) * 0.48 * Math.sqrt(1 - t * t);
    const skew = t * (elongated ? 2.8 : -1.5) + Math.sin(t * Math.PI) * (elongated ? 1.4 : -0.8);
    const pivot = center.x + skew;
    const left =
      y <= rampY + 4 && y + 2 >= rampY - 4
        ? minX
        : Math.max(minX, Math.min(maxX - 4, even(pivot - half)));
    const right = Math.min(maxX, Math.max(left + 4, even(pivot + half)));
    const last = strokes.at(-1);
    if (last?.minX === left && last.maxX === right) last.maxY = y + 2;
    else strokes.push(rectangle(left, y, right, y + 2));
  }
  return strokes;
}

function entry(area: Rect, lowerLevel: Ramp["lowerLevel"], direction: Ramp["direction"]): Ramp {
  const center = mid(area);
  if (direction === "east") {
    const y = even(center.y) - 1;
    return {
      center: { x: area.minX, y },
      direction,
      lowerLevel,
      clearance: rectangle(area.minX - 5, y - 4, area.minX + 5, y + 4),
    };
  }
  const x = even(center.x) - 1;
  return {
    center: { x, y: area.minY },
    direction,
    lowerLevel,
    clearance: rectangle(x - 4, area.minY - 5, x + 4, area.minY + 5),
  };
}

function routeClearance(area: Rect, layout: LayoutGeometry) {
  if (
    area.minX < layout.playable.minX ||
    area.minY < layout.playable.minY ||
    area.maxX > layout.playable.maxX ||
    area.maxY > layout.playable.maxY
  )
    return false;
  if (layout.zones.some((z) => areaDistance(expand(area, z.radius + 1), z.center) >= 0))
    return false;
  const wet = layout.waterArea;
  if (
    wet &&
    area.minX < wet.maxX &&
    area.maxX > wet.minX &&
    area.minY < wet.maxY &&
    area.maxY > wet.minY
  )
    return false;
  for (const route of layout.routes) {
    const reservation = expand(area, route.width / 2 + 0.75);
    // Sampling at half-cell spacing is conservative with the extra margin above.
    for (let index = 1; index < route.points.length; index++) {
      const a = route.points[index - 1],
        b = route.points[index];
      const samples = Math.ceil(Math.hypot(a.x - b.x, a.y - b.y) * 2);
      for (let i = 0; i <= samples; i++) {
        const t = i / Math.max(1, samples);
        if (areaDistance(reservation, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }) >= 0)
          return false;
      }
    }
  }
  return true;
}

/** Fit native geometry to the current generated basin. Each tier has an
 * independent landing, and all cuts stay outside reserved ground routes. */
export function planMissionLandform(style: LandformStyle, layout: LayoutGeometry, edge: CliffEdge) {
  if (layout.river && style === "riverTerraces" && layout.waterArea) {
    const riverEdge = layout.waterArea.minX;
    const available = riverEdge - layout.playable.minX - 8;
    const width = Math.min(18, Math.floor(available / 2) * 2);
    if (width < 10) return;
    const height = layout.playable.maxY - layout.playable.minY;
    const cliffs: Terrace[] = [];
    const ramps: Ramp[] = [];
    for (const [centerY, length, offset] of [
      [0.33, 16, 0],
      [0.69, 22, 2],
    ] as const) {
      const y = even(layout.playable.minY + centerY * height - length / 2);
      const area = rectangle(riverEdge - width - 2, y, riverEdge - 2 - offset, y + length);
      const ramp = entry(area, 1, "east");
      if (!routeClearance(expand(area, 2), layout) || !routeClearance(ramp.clearance, layout))
        return;
      cliffs.push({ area, level: 2, strokes: riverTerraceStrokes(area, edge, offset > 0) });
      ramps.push(ramp);
    }
    return { style, edge, cliffs, ramps };
  }
  const center = mid(layout.basin);
  const banks = style === "riverTerraces";
  const shelves = banks
    ? ([
        [center.x - 3, layout.basin.maxY + 2, 10, 6, "east"],
        [center.x - 4, layout.basin.maxY + 2, 10, 6, "east"],
        [center.x - 6, layout.basin.maxY + 2, 14, 6, "east"],
        [center.x - 8, layout.basin.maxY + 2, 12, 6, "east"],
        [center.x - 10, layout.basin.maxY + 2, 12, 6, "east"],
        [center.x - 6, layout.basin.minY - 2, 14, 6, "east"],
        [center.x - 8, layout.basin.minY - 2, 12, 6, "east"],
      ] as const)
    : ([
        [center.x - 2, center.y, 20, 26, "north"],
        [center.x - 4, center.y, 20, 24, "north"],
        [center.x - 2, center.y, 18, 22, "north"],
        [center.x - 4, center.y, 18, 22, "north"],
      ] as const);
  for (const [cx, cy, width, length, direction] of shelves) {
    const x = even(cx - width / 2),
      y = even(cy - length / 2);
    const shelf = rectangle(x, y, x + width, y + length);
    const lower = entry(shelf, 1, direction);
    if (!routeClearance(expand(shelf, 2), layout) || !routeClearance(lower.clearance, layout))
      continue;
    const cliffs: Terrace[] = [
      { area: shelf, strokes: terraceStrokes(shelf, edge, banks, 2), level: 2 },
    ];
    const ramps = [lower];
    if (!banks) {
      const top = rectangle(shelf.minX + 6, shelf.minY + 8, shelf.maxX - 4, shelf.maxY - 4);
      cliffs.push({ area: top, strokes: terraceStrokes(top, edge, banks, 3), level: 3 });
      ramps.push(entry(top, 2, "east"));
    }
    return { style, edge, cliffs, ramps };
  }
}

/** Flat native zones are independent of the continuous mountain brushes. */
export function landformOperations(
  landform: NonNullable<ReturnType<typeof planMissionLandform>>,
  cliffSet: number,
): TerrainOperation[] {
  return [
    ...landform.cliffs.flatMap(({ strokes, level }) =>
      strokes.map((area) => ({
        op: "cliff.paint" as const,
        area,
        parameters: { level, cliffSet },
      })),
    ),
    ...landform.ramps.map(({ center, direction, lowerLevel }) => ({
      op: "ramp.create" as const,
      parameters: { center, direction, lowerLevel, cliffSet, width: 4 },
    })),
  ];
}
