import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { dependencySchema } from "../document/schemas.js";
import { valueNoise } from "../terrain/geometry.js";

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const size = z.number().int().min(64).max(256).multipleOf(8);
const zoneSpec = z
  .object({
    id,
    biome: z.enum(["natural", "engineered"]),
    tileSet: id,
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
        trim: id.optional(),
        scatter: z.array(id).min(1).max(8).optional(),
      })
      .strict()
      .optional(),
    walls: z.boolean().optional(),
    actors: z.array(id).max(128).default([]),
    distinctActors: z.number().int().min(0).max(64).default(0),
    density: z.number().min(0).max(1).default(0.3),
  })
  .strict();
const edge = z
  .object({
    model: id.optional(),
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
    width: size,
    height: size,
    zones: z.array(zoneSpec).min(1).max(32),
    connections: z.array(edge).max(96),
    starts: z.array(id).min(1).max(2),
    objective: id.optional(),
    dependencies: dependencySchema.optional(),
  })
  .strict();
export function resolveWorldSpec(input: unknown) {
  const spec = worldSpec.parse(input);
  const dependencies =
    spec.dependencies ??
    (spec.mode === "ladder"
      ? { mode: "custom" as const, entries: [{ file: "Mods/VoidMulti.SC2Mod" }] }
      : { mode: "standard" as const, expansion: "void" as const, campaign: false });
  return { ...spec, dependencies };
}
export type WorldSpec = ReturnType<typeof resolveWorldSpec>;
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
  const routes = spec.connections.map((e) => {
    const from = centers.get(e.from),
      to = centers.get(e.to);
    if (!from || !to || from === to)
      throw Error("WORLD_INVALID_CONNECTION: " + e.from + "/" + e.to);
    return { ...e, points: [from, to] };
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
  const blocks: number[] = [];
  const counts = zones.map(() => 0);
  for (let y = 4; y < spec.height; y += 8)
    for (let x = 4; x < spec.width; x += 8) {
      let best = Infinity,
        owner = 0;
      for (const [i, zone] of zones.entries()) {
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
