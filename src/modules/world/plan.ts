import { missionPackSchema, missionStageSchema } from "../../mission-sdk.js";
import { bindMissionStages } from "./stages.js";
import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { dependencySchema } from "../document/schemas.js";
import { valueNoise } from "../terrain/geometry.js";
import { worldFacility } from "./facility.js";

export const worldId = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
export const worldSize = z.number().int().min(64).max(256).multipleOf(8);
const id = worldId;
const mapPoint = z
  .object({
    x: z.number().int().min(4).max(252),
    y: z.number().int().min(4).max(252),
  })
  .strict();
const edgeRun = z
  .object({
    points: z.array(mapPoint).min(2).max(12),
    actor: id,
    spacing: z.number().min(1.5).max(10),
    height: z.number().min(0.15).max(9),
    depth: z.number().min(0.5).max(10),
    roughness: z.number().min(0).max(1).optional(),
    ledge: z.number().int().min(-16).max(16).optional(),
  })
  .strict();
const zoneSpec = z
  .object({
    id,
    biome: z.enum(["natural", "engineered"]),
    tileSet: id,
    style: id.optional(),
    anchor: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
    areaBlocks: z
      .object({ min: z.number().int().positive(), max: z.number().int().positive() })
      .strict()
      .optional(),
    influence: z.number().min(0.5).max(2).default(1),
    relief: z.number().min(0).max(1.5).default(0.6),
    materials: z
      .object({
        ground: id.optional(),
        road: id.optional(),
        roadEdge: id.optional(),
        trim: id.optional(),
        scatter: z.array(id).min(1).max(8).optional(),
      })
      .strict()
      .optional(),
    walls: z.boolean().optional(),
    room: z
      .object({
        width: z.number().int().min(10).max(60).multipleOf(2),
        height: z.number().int().min(10).max(60).multipleOf(2),
        floor: id,
        trim: id.optional(),
        doorActor: id.optional(),
      })
      .strict()
      .optional(),
    wallActor: id.optional(),
    facility: worldFacility.optional(),
    composition: z
      .object({
        edges: z.array(edgeRun).max(16).default([]),
        pockets: z
          .array(
            z
              .object({
                center: mapPoint,
                radius: z.number().min(4).max(24),
              })
              .strict(),
          )
          .min(1)
          .max(12),
        pavingRadius: z.number().min(5).max(22).optional(),
      })
      .strict()
      .optional(),
    landmark: z
      .object({
        actor: id,
        faceZone: id.optional(),
        variation: z.number().int().min(0).max(127).optional(),
        offset: z
          .object({ x: z.number().min(-20).max(20), y: z.number().min(-20).max(20) })
          .strict(),
      })
      .strict()
      .optional(),
    actors: z.array(id).max(128).default([]),
    distinctActors: z.number().int().min(0).max(64).default(0),
    density: z.number().min(0).max(1).default(0.3),
  })
  .strict();
const edge = z
  .object({
    model: id.optional(),
    bankBoundary: z.boolean().default(false),
    bankStart: z.number().int().min(8).max(240).multipleOf(8).optional(),
    raisedBank: z.boolean().optional(),
    bankRise: z.number().int().min(1).max(2).optional(),
    bankWallActor: id.optional(),
    bankLift: z.number().min(0).max(1.5).optional(),
    bankCliffActors: z.array(id).min(1).max(4).optional(),
    shoreline: z
      .object({
        reach: z.number().min(6).max(23),
        naturalRock: id,
        builtRock: id,
        rockActors: z.array(id).min(1).max(4),
      })
      .strict()
      .optional(),
    trail: z
      .array(
        z
          .object({
            at: z.number().min(0).max(1),
            width: z.number().min(2).max(16),
          })
          .strict(),
      )
      .min(2)
      .max(10)
      .optional(),
    waypoints: z.array(mapPoint).max(8).optional(),
    from: id,
    to: id,
    kind: z.enum(["road", "door", "bridge"]),
    width: z.number().min(3).max(12).default(5),
  })
  .strict();
export const worldSpec = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(160),
    mode: z.enum(["mission", "ladder", "arcade"]),
    seed: z.number().int().nonnegative().max(0x7fffffff),
    width: worldSize,
    height: worldSize,
    landscape: z.enum(["campaign", "custom"]).optional(),
    decorReference: id.optional(),
    decorBudget: z
      .object({ min: z.number().int().min(45).max(65), max: z.number().int().min(45).max(65) })
      .strict()
      .refine((b) => b.min <= b.max)
      .optional(),
    zones: z.array(zoneSpec).min(1).max(32),
    connections: z.array(edge).max(96),
    missionPack: missionPackSchema.optional(),
    stages: z.array(missionStageSchema).min(1).max(24).optional(),
    starts: z.array(id).min(1).max(2),
    objective: id.optional(),
    dependencies: dependencySchema.optional(),
  })
  .strict();
export function worldDependencies(
  mode: z.input<typeof worldSpec>["mode"],
  request?: z.output<typeof dependencySchema>,
) {
  return (
    request ??
    (mode === "ladder"
      ? { mode: "custom" as const, entries: [{ file: "Mods/VoidMulti.SC2Mod" }] }
      : { mode: "standard" as const, expansion: "void" as const, campaign: false })
  );
}
export function resolveWorldSpec(input: unknown) {
  const spec = worldSpec.parse(input);
  return { ...spec, dependencies: worldDependencies(spec.mode, spec.dependencies) };
}
export type WorldSpec = ReturnType<typeof resolveWorldSpec>;

export function smoothstep(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

export function routeEdgeDistance(
  point: { x: number; y: number },
  route: WorldLayout["routes"][number],
) {
  let distance = Infinity;
  let along = 0;
  for (const { from, dx, dy, length, offset } of route.segments) {
    const x = point.x - from.x,
      y = point.y - from.y;
    const t = Math.max(0, Math.min(length, (x * dx + y * dy) / length));
    const current = Math.hypot(x - (t * dx) / length, y - (t * dy) / length);
    if (current >= distance) continue;
    distance = current;
    along = offset + t;
  }
  if (!route.trail) return distance - route.width / 2;
  const at = along / route.length;
  const index = Math.max(
    1,
    route.trail.findIndex((knot) => knot.at >= at),
  );
  const a = route.trail[index - 1],
    b = route.trail[index];
  return distance - (a.width + (b.width - a.width) * smoothstep((at - a.at) / (b.at - a.at))) / 2;
}

export function bridgeAxis(points: { x: number; y: number }[], bankStart?: number) {
  const [a, b] = points;
  const alongY = Math.abs(b.y - a.y) >= Math.abs(b.x - a.x);
  const start = bankStart ?? Math.floor(((alongY ? a.y + b.y : a.x + b.x) / 2 - 4) / 8) * 8;
  return { alongY, start };
}

export function seedFor(seed: number, key: string) {
  return createHash("sha256")
    .update(seed + "/" + key)
    .digest()
    .readInt32LE();
}
export function planWorld(spec: WorldSpec) {
  const ids = new Set(spec.zones.map((z) => z.id));
  if (ids.size !== spec.zones.length) throw Error("WORLD_DUPLICATE_ZONE");
  const centers = new Map(
    spec.zones.map((zone) => [
      zone.id,
      {
        x: Math.round(10 + zone.anchor.x * (spec.width - 20)),
        y: Math.round(10 + zone.anchor.y * (spec.height - 20)),
      },
    ]),
  );
  const sets = [...new Set(spec.zones.map((z) => z.tileSet))];
  if (sets.length > 8) throw Error("WORLD_TEXTURE_SET_BUDGET");
  const requiredStarts = spec.mode === "mission" ? 1 : 2;
  if (
    spec.starts.length !== requiredStarts ||
    new Set(spec.starts).size !== requiredStarts ||
    spec.starts.some((start) => !ids.has(start))
  )
    throw Error("WORLD_START_ZONES");
  if (
    spec.mode !== "ladder" &&
    (!spec.objective || !ids.has(spec.objective) || spec.starts.includes(spec.objective))
  )
    throw Error("WORLD_OBJECTIVE_ZONE");
  if (spec.objective && !ids.has(spec.objective)) throw Error("WORLD_UNKNOWN_OBJECTIVE");
  const inBounds = (p: { x: number; y: number }) => p.x <= spec.width - 4 && p.y <= spec.height - 4;
  const routes = bindMissionStages(
    spec.mode,
    spec.starts[0],
    spec.objective,
    spec.connections,
    spec.missionPack,
    spec.stages,
  ).map((e) => {
    const from = centers.get(e.from),
      to = centers.get(e.to);
    if (!from || !to || from === to)
      throw Error("WORLD_INVALID_CONNECTION: " + e.from + "/" + e.to);
    if (
      (e.kind === "bridge" && e.waypoints?.length) ||
      (e.bankStart !== undefined && (e.kind !== "bridge" || spec.mode !== "mission")) ||
      ((e.bankRise !== undefined ||
        e.bankWallActor ||
        e.bankCliffActors ||
        e.bankLift !== undefined) &&
        !e.raisedBank) ||
      (e.raisedBank && (e.kind !== "bridge" || !e.bankBoundary || spec.mode !== "mission"))
    )
      throw Error("WORLD_INVALID_BRIDGE_GEOMETRY: " + e.from + "/" + e.to);
    if (e.waypoints?.some((p) => p.x > spec.width - 4 || p.y > spec.height - 4))
      throw Error("WORLD_ROUTE_WAYPOINT_OUT_OF_BOUNDS");
    if (
      e.shoreline &&
      (spec.mode !== "mission" || e.kind !== "bridge" || !e.bankBoundary || e.raisedBank)
    )
      throw Error("WORLD_INVALID_SHORELINE");
    if (
      e.trail &&
      (spec.mode !== "mission" ||
        e.kind === "door" ||
        e.trail[0].at !== 0 ||
        e.trail.at(-1)!.at !== 1 ||
        e.trail.some((k, i, all) => i > 0 && k.at <= all[i - 1].at))
    )
      throw Error("WORLD_INVALID_TRAIL_PROFILE");
    const points = [from, ...(e.waypoints ?? []), to].filter(
      (p, i, all) => i === 0 || p.x !== all[i - 1].x || p.y !== all[i - 1].y,
    );
    if (points.length < 2) throw Error("WORLD_OVERLAPPING_CONNECTION");
    if (spec.mode === "ladder" && e.waypoints?.length)
      throw Error("WORLD_LADDER_WAYPOINTS_UNSUPPORTED");
    let length = 0;
    const segments = points.slice(1).map((to, i) => {
      const from = points[i],
        dx = to.x - from.x,
        dy = to.y - from.y;
      const segment = { from, dx, dy, length: Math.hypot(dx, dy), offset: length };
      length += segment.length;
      return segment;
    });
    return { ...e, points, segments, length };
  });
  const keys = routes.map((r) => [r.from, r.to].sort().join("/"));
  if (new Set(keys).size !== keys.length) throw Error("WORLD_DUPLICATE_CONNECTION");
  const connected = new Set([spec.starts[0]]);
  for (let i = 0; i < ids.size; i++)
    for (const e of routes) {
      if (connected.has(e.from) || connected.has(e.to)) {
        connected.add(e.from);
        connected.add(e.to);
      }
    }
  if (connected.size !== ids.size) throw Error("WORLD_DISCONNECTED_ZONES");
  const zones = spec.zones.map((zone) => ({
    ...zone,
    center: centers.get(zone.id)!,
    bank: sets.indexOf(zone.tileSet),
    terrainSeed: seedFor(spec.seed, zone.id + "/terrain"),
    decorSeed: seedFor(spec.seed, zone.id + "/decor"),
  }));
  for (const zone of zones) {
    if (zone.composition) {
      if (spec.mode !== "mission" || zone.biome !== "engineered")
        throw Error("WORLD_COMPOSITION_REQUIRES_ENGINEERED_MISSION_ZONE: " + zone.id);
      for (const pocket of zone.composition.pockets)
        if (!inBounds(pocket.center))
          throw Error("WORLD_COMPOSITION_POCKET_OUT_OF_BOUNDS: " + zone.id);
      for (const run of zone.composition.edges) {
        if (!run.points.every(inBounds)) throw Error("WORLD_EDGE_OUT_OF_BOUNDS: " + zone.id);
        for (let i = 1; i < run.points.length; i++) {
          const a = run.points[i - 1],
            b = run.points[i];
          if (a.x === b.x && a.y === b.y) throw Error("WORLD_EDGE_DUPLICATE_POINT: " + zone.id);
          if (run.ledge) {
            const vertical = a.x === b.x;
            const end = vertical ? a.x + run.ledge : a.y + run.ledge;
            if (
              (!vertical && a.y !== b.y) ||
              end < 2 ||
              end > (vertical ? spec.width : spec.height) - 2
            )
              throw Error("WORLD_INVALID_EDGE_LEDGE: " + zone.id);
            if ([a.x, a.y, b.x, b.y, end].some((value) => value % 2))
              throw Error("WORLD_EDGE_LEDGE_REQUIRES_TWO_CELL_GRID: " + zone.id);
          }
        }
      }
    }
    if (!zone.landmark) continue;
    if (zone.landmark.faceZone && !ids.has(zone.landmark.faceZone))
      throw Error("WORLD_UNKNOWN_FACING_ZONE: " + zone.landmark.faceZone);
    const x = zone.center.x + zone.landmark.offset.x;
    const y = zone.center.y + zone.landmark.offset.y;
    if (spec.mode !== "mission" || Math.min(x, y, spec.width - x, spec.height - y) < 4)
      throw Error("WORLD_MISSION_LANDMARK_OUT_OF_BOUNDS: " + zone.id);
  }
  const boundaries = routes
    .filter((r) => r.bankBoundary)
    .map((r) => {
      const from = zones.find((z) => z.id === r.from)!;
      const to = zones.find((z) => z.id === r.to)!;
      if (r.kind !== "bridge" || from.biome === to.biome || spec.mode !== "mission")
        throw Error("WORLD_BANK_BOUNDARY_REQUIRES_MISSION_BRIDGE_BETWEEN_BIOMES");
      const { alongY, start } = bridgeAxis(r.points, r.bankStart);
      const axis = alongY ? "y" : "x";
      const before = from.center[axis] < to.center[axis] ? from.biome : to.biome;
      // The ramp for a framed single bank crosses the shoreline into the river
      // block. Use the facility's native tiles on the whole water band.
      const framedSingle = r.raisedBank && r.bankWallActor && (r.bankRise ?? 1) === 1;
      const boundary = framedSingle && before === "natural" ? start : start + 8;
      if (zones.some((z) => z.center[axis] < boundary !== (z.biome === before)))
        throw Error("WORLD_BANK_BOUNDARY_ZONE_CONFLICT");
      return { axis, boundary, before };
    });
  const blocks: number[] = [];
  const counts = zones.map(() => 0);
  for (let y = 4; y < spec.height; y += 8)
    for (let x = 4; x < spec.width; x += 8) {
      let best = Infinity,
        owner = 0;
      for (const [i, zone] of zones.entries()) {
        if (
          boundaries.some(
            (b) => (b.axis === "x" ? x : y) < b.boundary !== (zone.biome === b.before),
          )
        )
          continue;
        const dx = x - zone.center.x,
          dy = y - zone.center.y;
        const distance =
          zone.biome === "natural"
            ? Math.hypot(dx, dy) + 5 * valueNoise(x / 16, y / 16, zone.terrainSeed)
            : Math.max(Math.abs(dx), Math.abs(dy));
        if (distance / zone.influence < best) {
          best = distance / zone.influence;
          owner = i;
        }
      }
      if (!Number.isFinite(best)) throw Error("WORLD_BANK_BOUNDARY_BLOCK_CONFLICT");
      blocks.push(owner);
      counts[owner]++;
    }
  for (const [i, count] of counts.entries()) {
    const zone = zones[i];
    if (
      !count ||
      blocks[Math.floor(zone.center.y / 8) * (spec.width / 8) + Math.floor(zone.center.x / 8)] !== i
    )
      throw Error("WORLD_ZONE_HAS_NO_CENTER_BLOCK: " + zone.id);
  }
  if (spec.mode === "ladder") {
    if (routes.some((r) => r.kind === "door"))
      throw Error("WORLD_LADDER_DYNAMIC_GATES_UNSUPPORTED");
    const [a, b] = spec.starts.map((start) => centers.get(start)!);
    if (a.x + b.x !== spec.width || a.y + b.y !== spec.height)
      throw Error("WORLD_LADDER_START_SYMMETRY");
  }
  const expansions: { x: number; y: number }[] = [];
  if (spec.mode === "ladder") {
    const mirrors = zones.map((z) =>
      zones.findIndex(
        (other) =>
          other.center.x + z.center.x === spec.width && other.center.y + z.center.y === spec.height,
      ),
    );
    if (mirrors.some((i) => i < 0)) throw Error("WORLD_LADDER_MIRRORED_ZONES_REQUIRED");
    for (const [i, j] of mirrors.entries()) {
      const a = zones[i],
        b = zones[j];
      if (
        a.tileSet !== b.tileSet ||
        a.biome !== b.biome ||
        a.relief !== b.relief ||
        a.walls !== b.walls ||
        JSON.stringify(a.room) !== JSON.stringify(b.room) ||
        a.wallActor !== b.wallActor ||
        JSON.stringify(a.materials) !== JSON.stringify(b.materials) ||
        a.influence !== b.influence ||
        a.density !== b.density ||
        a.distinctActors !== b.distinctActors ||
        JSON.stringify(a.actors) !== JSON.stringify(b.actors)
      )
        throw Error("WORLD_LADDER_ASYMMETRIC_ZONE: " + a.id);
    }
    for (const r of routes) {
      const mirror = (id: string) => zones[mirrors[zones.findIndex((z) => z.id === id)]].id;
      if (
        !routes.some(
          (e) =>
            e.kind === r.kind &&
            e.width === r.width &&
            [e.from, e.to].sort().join("/") === [mirror(r.from), mirror(r.to)].sort().join("/"),
        )
      )
        throw Error("WORLD_LADDER_ASYMMETRIC_CONNECTION");
    }
    for (let i = 0; i < blocks.length / 2; i++) blocks[blocks.length - 1 - i] = mirrors[blocks[i]];
    counts.fill(0);
    for (const i of blocks) counts[i]++;
    const home = centers.get(spec.starts[0])!;
    const choices = [
      { x: home.x + 18, y: home.y },
      { x: home.x - 18, y: home.y },
      { x: home.x, y: home.y + 18 },
      { x: home.x, y: home.y - 18 },
    ];
    const site = choices.find(
      (p) =>
        p.x >= 10 &&
        p.y >= 10 &&
        spec.width - p.x >= 10 &&
        spec.height - p.y >= 10 &&
        Math.hypot(spec.width - 2 * p.x, spec.height - 2 * p.y) >= 18 &&
        Math.hypot(p.x - (spec.width - home.x), p.y - (spec.height - home.y)) >= 18,
    );
    if (!site) throw Error("WORLD_LADDER_EXPANSION_CLEARANCE");
    expansions.push(site, { x: spec.width - site.x, y: spec.height - site.y });
  }
  for (const [i, z] of zones.entries())
    if (z.areaBlocks && (counts[i] < z.areaBlocks.min || counts[i] > z.areaBlocks.max))
      throw Error("WORLD_ZONE_AREA_UNSATISFIED: " + z.id + " blocks=" + counts[i]);
  return { zones, sets, blocks, routes, counts, expansions };
}
export type WorldLayout = ReturnType<typeof planWorld>;
