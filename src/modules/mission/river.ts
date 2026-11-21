import { valueNoise } from "../terrain/geometry.js";
import type { Point2, TerrainArea } from "../terrain/types.js";
import type { TerrainWorkspace } from "../terrain/workspace.js";

type Rectangle = Extract<TerrainArea, { type: "rectangle" }>;
export interface MissionRiver {
  carrier: Rectangle;
  centerline: Point2[];
  halfWidths: number[];
}

/** The editor stores rectangular water coverage; the channel floor reveals the river. */
export function planMissionRiver(
  width: number,
  height: number,
  seed: number,
  variant: number,
): MissionRiver {
  const centerX = Math.round((width * 0.37 + valueNoise(variant, 19, seed) * 3) / 8) * 8;
  const span = width >= 120 ? 16 : 12;
  const carrier = {
    type: "rectangle" as const,
    minX: Math.floor((centerX - span) / 8) * 8,
    maxX: Math.ceil((centerX + span) / 8) * 8,
    minY: 0,
    maxY: height,
  };
  const phase = valueNoise(variant, 21, seed) * Math.PI;
  const centerline = Array.from({ length: 17 }, (_, i) => {
    const t = i / 16;
    return {
      x:
        centerX +
        Math.sin(t * Math.PI * 3.25 + phase) * 4.5 +
        Math.sin(t * Math.PI * 2 - phase) * 1.4,
      y: -12 + t * (height + 24),
    };
  });
  const halfWidths = centerline.map((p, i) =>
    Math.min(
      6.5 + valueNoise(i / 3, 37, seed) * 1.35,
      p.x - carrier.minX - 2.25,
      carrier.maxX - p.x - 2.25,
    ),
  );
  return { carrier, centerline, halfWidths };
}

export function riverStrip(
  river: MissionRiver,
  extraWidth = 0,
  minY = river.carrier.minY,
  maxY = river.carrier.maxY,
): Extract<TerrainArea, { type: "polygon" }> {
  const rows = [
    minY,
    ...river.centerline.filter((p) => p.y > minY && p.y < maxY).map((p) => p.y),
    maxY,
  ];
  const bank = (side: number) =>
    rows.map((y) => {
      const { x, halfWidth } = riverSection(river, y);
      return { x: x + side * Math.max(1.85, halfWidth + extraWidth), y };
    });
  return { type: "polygon", points: [...bank(-1), ...bank(1).reverse()] };
}

export function riverSection(river: MissionRiver, y: number) {
  const next = river.centerline.findIndex((p) => p.y > y);
  const i = Math.max(0, next < 0 ? river.centerline.length - 2 : next - 1);
  const a = river.centerline[i],
    b = river.centerline[i + 1];
  const t = (y - a.y) / (b.y - a.y);
  return {
    x: a.x + (b.x - a.x) * t,
    halfWidth: river.halfWidths[i] + (river.halfWidths[i + 1] - river.halfWidths[i]) * t,
  };
}

export function reviewMissionRiver(
  river: MissionRiver,
  level: number,
  sample: Awaited<ReturnType<TerrainWorkspace["surface"]>>["sample"],
) {
  let samples = 0;
  let minWidth = Infinity,
    maxWidth = 0;
  for (let y = 0.5; y < river.carrier.maxY; y += 1) {
    const { x } = riverSection(river, y);
    const submerged = (at: number) => {
      const p = sample({ x: at, y });
      return !!p.water?.length && p.height < level - 0.08;
    };
    if (!submerged(x)) throw Error("MISSION_RIVER_CENTERLINE_IS_DRY: " + y);
    for (const side of [river.carrier.minX, river.carrier.maxX])
      if (sample({ x: side, y }).height <= level + 0.15)
        throw Error("MISSION_RIVER_SIDE_CLIPS_NATIVE_WATER: " + y);
    let west = x,
      east = x;
    while (submerged(west - 0.5)) west -= 0.5;
    while (submerged(east + 0.5)) east += 0.5;
    minWidth = Math.min(minWidth, east - west);
    maxWidth = Math.max(maxWidth, east - west);
    samples++;
  }
  if (minWidth < 3) throw Error("MISSION_RIVER_CHANNEL_TOO_NARROW");
  return {
    samples,
    level,
    minWidth,
    maxWidth,
    carrier: river.carrier,
    centerline: river.centerline,
  };
}
