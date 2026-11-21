import {
  areaDistance,
  corridorWithinArea,
  segmentDistance,
  valueNoise,
} from "../terrain/geometry.js";
import type { Point2, TerrainArea } from "../terrain/types.js";
import type { MissionBuildSpec } from "./buildSpec.js";
import { digest } from "./pointCompiler.js";
import { planMissionLandform } from "./nativeLandforms.js";
import { planMissionRiver } from "./river.js";

type Rectangle = Extract<TerrainArea, { type: "rectangle" }>;
type Circle = Extract<TerrainArea, { type: "circle" }>;
type Corridor = Extract<TerrainArea, { type: "corridor" }>;

const distance = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y);
const length = (points: Point2[]) =>
  points.slice(1).reduce((total, point, index) => total + distance(point, points[index]), 0);

// Sample at half-cell increments, including exact waypoints.
export function routeSamples(points: Point2[]) {
  return points.slice(1).flatMap((end, index) => {
    const start = points[index];
    const steps = Math.max(1, Math.ceil(distance(start, end) * 2));
    return Array.from({ length: steps + 1 }, (_, i) => ({
      x: start.x + ((end.x - start.x) * i) / steps,
      y: start.y + ((end.y - start.y) * i) / steps,
    }));
  });
}

function candidate(spec: MissionBuildSpec, index: number) {
  const { width, height } = spec.map;
  const { layout, seed } = spec;
  const jitter = (channel: number, magnitude: number) =>
    Math.round(valueNoise(index, channel, seed) * magnitude);
  const center = Math.round(width / 2) + jitter(1, width * 0.07);
  const north = Math.round(height * 0.82),
    south = Math.round(height * 0.18);
  const middle = Math.round(height / 2);
  const direction = jitter(2, 9) >= 0 ? 1 : -1;
  const primaryOffset = Math.round(width * 0.19) + jitter(3, width * 0.03);
  const scenicOffset = Math.round(width * 0.3) + jitter(4, width * 0.04);
  const primaryX = center + direction * primaryOffset;
  const scenicX = center - direction * scenicOffset;

  const start = { ...layout.start, center: { x: center, y: south } };
  const objective = { ...layout.objective, center: { x: center, y: north } };
  const bonus = layout.bonus && { ...layout.bonus, center: { x: scenicX, y: middle } };
  let zones = [start, objective, ...(bonus ? [bonus] : [])];

  const primary = [
    start.center,
    { x: primaryX, y: Math.round(height * 0.36) },
    { x: primaryX + jitter(5, 3), y: Math.round(height * 0.64) },
    objective.center,
  ];
  const scenic = [
    start.center,
    { x: scenicX + jitter(6, 3), y: Math.round(height * 0.37) },
    { x: scenicX, y: middle },
    { x: scenicX + jitter(7, 3), y: Math.round(height * 0.65) },
    objective.center,
  ];
  let routes = [
    { id: "primary", width: layout.routeWidth, points: primary, length: length(primary) },
    { id: "scenic", width: layout.routeWidth, points: scenic, length: length(scenic) },
  ];
  let basin: Rectangle = {
    type: "rectangle",
    minX: center - Math.round(width * 0.09),
    maxX: center + Math.round(width * 0.09),
    minY: Math.round(height * 0.39),
    maxY: Math.round(height * 0.61),
  };
  const pattern = layout.pattern ?? "basinFork";
  const river =
    pattern === "riverValley" ? planMissionRiver(width, height, seed, index) : undefined;
  let junction: Point2 | undefined;
  const leg = (id: string, points: Point2[]) => ({
    id,
    points,
    width: layout.routeWidth,
    length: length(points),
  });
  if (river) {
    const inner = river.carrier.maxX + Math.round(width * 0.13);
    const outer = Math.round(width * 0.87) + jitter(6, 2);
    const bankCenter = Math.round((inner + outer) / 2);
    const camp = { ...start, center: { x: bankCenter, y: south } };
    const base = { ...objective, center: { x: bankCenter + jitter(8, 3), y: north } };
    const side = bonus && { ...bonus, center: { x: outer, y: middle } };
    zones = [camp, base, ...(side ? [side] : [])];
    routes = [
      leg("riverbank", [
        camp.center,
        { x: inner, y: Math.round(height * 0.36) },
        { x: inner + jitter(5, 3), y: Math.round(height * 0.64) },
        base.center,
      ]),
      leg("outer-bank", [
        camp.center,
        { x: outer, y: Math.round(height * 0.42) },
        { x: outer, y: Math.round(height * 0.68) },
        base.center,
      ]),
    ];
    basin = { ...river.carrier, minY: 8, maxY: height - 8 };
  } else if (pattern === "expedition") {
    junction = { x: center, y: middle };
    const destination = {
      ...objective,
      center: { x: center + direction * jitter(8, width * 0.13), y: north },
    };
    const side = bonus && {
      ...bonus,
      center: { x: center - direction * Math.round(width * 0.29), y: middle + jitter(9, 4) },
    };
    zones = [start, destination, ...(side ? [side] : [])];
    routes = [
      leg("expedition", [
        start.center,
        { x: center + jitter(10, 5), y: Math.round(height * 0.34) },
        junction,
        destination.center,
      ]),
      ...(side ? [leg("detour", [junction, side.center])] : []),
    ];
    const flank = center + direction * Math.round(width * 0.24);
    basin = {
      ...basin,
      minX: flank - Math.round(width * 0.1),
      maxX: flank + Math.round(width * 0.1),
    };
  } else if (pattern === "defenseHub") {
    junction = { x: center, y: middle };
    const hub = { ...start, center: junction };
    const side = bonus && { ...bonus, center: { x: scenicX, y: Math.round(height * 0.72) } };
    zones = [hub, objective, ...(side ? [side] : [])];
    routes = [
      leg("north", [objective.center, junction]),
      leg("east", [{ x: Math.round(width * 0.85), y: middle + jitter(11, 8) }, junction]),
      leg("west", [{ x: Math.round(width * 0.15), y: middle + jitter(12, 8) }, junction]),
      ...(side ? [leg("outpost", [junction, side.center])] : []),
    ];
    basin = {
      ...basin,
      minY: south - Math.round(height * 0.1),
      maxY: south + Math.round(height * 0.1),
    };
  }
  let waterArea: Rectangle | undefined =
    river?.carrier ??
    (spec.terrain.water && {
      type: "rectangle",
      minX: Math.ceil((basin.minX + 1) / 8) * 8,
      minY: Math.ceil((basin.minY + 1) / 8) * 8,
      maxX: Math.floor((basin.maxX - 1) / 8) * 8,
      maxY: Math.floor((basin.maxY - 1) / 8) * 8,
    });
  if (waterArea && !river && spec.terrain.profile === "wetland") {
    const cover: Rectangle = {
      type: "rectangle",
      minX: Math.floor(basin.minX / 8) * 8,
      minY: Math.floor(basin.minY / 8) * 8,
      maxX: Math.ceil(basin.maxX / 8) * 8,
      maxY: Math.ceil(basin.maxY / 8) * 8,
    };
    const horizontal = { ...waterArea, minX: cover.minX, maxX: cover.maxX };
    const coverage = (
      spec.terrain.landform === "riverTerraces"
        ? [horizontal]
        : [cover, horizontal, { ...waterArea, minY: cover.minY, maxY: cover.maxY }]
    ).filter(
      (area) =>
        area.minX >= 4 &&
        area.minY >= 4 &&
        area.maxX <= width - 4 &&
        area.maxY <= height - 4 &&
        area.maxX > area.minX &&
        area.maxY > area.minY &&
        routes.every((route) =>
          routeSamples(route.points).every(
            (point) => areaDistance(area, point) < -route.width / 2 - 1,
          ),
        ),
    );
    const extent = (area: Rectangle) => (area.maxX - area.minX) * (area.maxY - area.minY);
    coverage.sort((a, b) => extent(b) - extent(a));
    waterArea = coverage[0] ?? waterArea;
  }
  if (waterArea && (waterArea.minX >= waterArea.maxX || waterArea.minY >= waterArea.maxY)) return;
  const playable: Rectangle = {
    type: "rectangle",
    minX: 4,
    minY: 4,
    maxX: width - 4,
    maxY: height - 4,
  };
  const pads: Circle[] = zones.map((zone) => ({
    type: "circle",
    radius: zone.radius,
    center: zone.center,
  }));
  if (pads.some((pad) => areaDistance(playable, pad.center) < pad.radius + 1)) return;
  if (
    pads.some((pad, i) =>
      pads
        .slice(0, i)
        .some((other) => distance(other.center, pad.center) < other.radius + pad.radius + 2),
    )
  )
    return;
  if (routes.some((route) => !corridorWithinArea(playable, route.points, route.width))) return;
  if (pads.some((pad) => areaDistance(basin, pad.center) >= -pad.radius - 1)) return;

  let minSeparation = Infinity;
  for (const route of routes) {
    for (const sample of routeSamples(route.points)) {
      if (areaDistance(basin, sample) >= -route.width / 2 - 1) return;
      if (pattern === "basinFork" || river) {
        // The starting and ending plazas are the intentional junctions.
        if (pads.slice(0, 2).some((pad) => areaDistance(pad, sample) >= -route.width)) continue;
      } else if (
        junction &&
        distance(sample, junction) <= Math.max(2.8 * route.width, layout.start.radius + route.width)
      ) {
        continue;
      }
      for (const other of routes)
        if (other !== route) {
          minSeparation = Math.min(
            minSeparation,
            ...other.points.slice(1).map((p, i) => segmentDistance(sample, other.points[i], p)),
          );
        }
    }
  }
  if (
    routes.length > 1 &&
    (!Number.isFinite(minSeparation) || minSeparation < layout.routeWidth + 1)
  )
    return;
  let score: number;
  if (pattern === "basinFork") {
    const lengthRatio = routes[1].length / routes[0].length;
    if (lengthRatio < 1.06) return;
    score = Math.round(1000 * (1 - Math.abs(lengthRatio - 1.23)) + minSeparation);
  } else {
    const direct = distance(routes[0].points[0], routes[0].points.at(-1)!);
    score = Math.round(
      (1000 * direct) / routes[0].length + (Number.isFinite(minSeparation) ? minSeparation : 0),
    );
  }
  const views = [
    { id: "start" as const, target: zones[0].center, yaw: 0 },
    {
      id: "fork" as const,
      target: junction ?? { x: center, y: Math.round(height * 0.34) },
      yaw: 0,
    },
    { id: "objective" as const, target: zones[1].center, yaw: 180 },
  ];
  const landform =
    spec.terrain.landform &&
    planMissionLandform(
      spec.terrain.landform,
      { basin, playable, waterArea, routes, zones, river: Boolean(river) },
      spec.terrain.cliffEdge ?? "natural",
    );
  if (spec.terrain.landform && !landform) return;
  const layoutData = {
    index,
    zones,
    routes,
    basin,
    waterArea,
    playable,
    views,
    minSeparation: Number.isFinite(minSeparation) ? minSeparation : undefined,
    score,
    landform,
    ...(river ? { river } : {}),
  };
  return { id: "layout_" + digest(JSON.stringify([spec, layoutData])), ...layoutData };
}

export type MissionLayout = NonNullable<ReturnType<typeof candidate>>;

export function planMissionLayouts(spec: MissionBuildSpec) {
  const variants = Array.from({ length: spec.layout.variantCount }, (_, i) => candidate(spec, i))
    .filter((item): item is MissionLayout => item !== undefined)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (!variants.length)
    throw Error("MISSION_LAYOUT_UNSATISFIABLE: enlarge the map or reduce pad and corridor sizes");
  return { pattern: spec.layout.pattern ?? "basinFork", preferredId: variants[0].id, variants };
}

export function groundShapes(layout: MissionLayout) {
  const corridors: Corridor[] = layout.routes.map(({ points, width }) => ({
    type: "corridor",
    points,
    width,
  }));
  const pads: Circle[] = layout.zones.map(({ center, radius }) => ({
    type: "circle",
    center,
    radius,
  }));
  return { corridors, pads };
}
