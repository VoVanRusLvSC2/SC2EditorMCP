import * as z from "zod/v4";
import { dependencySchema } from "../document/schemas.js";
import type { TerrainSet } from "../document/codecs/flatTerrainFactory.js";
import type { Point2 } from "../terrain/types.js";
import { facilityRole } from "./facility.js";
import { planIntentFacility } from "./intentFacility.js";
import { structureLayout } from "./structures.js";
import { readWorldStyles } from "./missionLandscape.js";
import { planWorld, resolveWorldSpec, seedFor, worldId, worldSize, worldSpec } from "./plan.js";
import { roomPassport } from "./workstations.js";

const sector = z.enum(["north", "south", "east", "west", "center"]);
const roomRole = facilityRole.exclude(["landing"]);
const roomBrief = roomPassport
  .pick({
    activity: true,
    density: true,
    condition: true,
    placement: true,
    aisleWidth: true,
  })
  .partial()
  .extend({ role: roomRole })
  .strict();
const zone = z
  .object({
    id: worldId,
    biome: z.enum(["natural", "engineered"]),
    tileSet: worldId,
    sector: sector.optional(),
    style: worldId.optional(),
    layout: z.enum(["open", "lab", "city", "base"]).optional(),
    condition: z.literal("operational").default("operational"),
    rooms: z
      .array(z.union([roomRole, roomBrief]))
      .min(1)
      .max(4)
      .optional(),
    raised: z.boolean().default(false),
    relief: z.number().min(0).max(1.5).optional(),
    density: z.number().min(0).max(1).optional(),
    distinctActors: worldSpec.shape.zones.element.shape.distinctActors,
    mirrorOf: worldId.optional(),
  })
  .strict();

export const worldIntent = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(160),
    mode: z.enum(["mission", "ladder", "arcade"]),
    width: worldSize,
    height: worldSize,
    zones: z.array(zone).min(2).max(16),
    links: z
      .array(
        z
          .object({
            from: worldId,
            to: worldId,
            kind: z.enum(["route", "bridge"]).default("route"),
            character: z.enum(["main", "service", "trail"]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(48),
    starts: z.array(worldId).min(1).max(2),
    objective: worldId.optional(),
    dependencies: dependencySchema.optional(),
    textureBudget: z.number().int().min(1).max(64).default(64),
    decorBudget: worldSpec.shape.decorBudget,
    decorReference: worldSpec.shape.decorReference,
  })
  .strict();

export const intentSeed = z.number().int().nonnegative().max(0x7fffffff);
export type WorldIntent = z.output<typeof worldIntent>;
type Zone = WorldIntent["zones"][number];
type SpecInput = z.input<typeof worldSpec>;
type Link = SpecInput["connections"][number];
const sectors = {
  north: [0.5, 0.77],
  south: [0.5, 0.23],
  east: [0.77, 0.5],
  west: [0.23, 0.5],
  center: [0.5, 0.5],
} as const;

export function intentChoice(seed: number, key: string, count: number) {
  return (seedFor(seed, key) >>> 0) % count;
}

export async function compileWorldIntent(intent: WorldIntent, seed: number, sets: TerrainSet[]) {
  const registry = await readWorldStyles();
  const zones = new Map(intent.zones.map((z) => [z.id, z]));
  if (zones.size !== intent.zones.length) throw Error("WORLD_INTENT_DUPLICATE_ZONE");
  const setIds = [...new Set(intent.zones.map((z) => z.tileSet))];
  const selectedSets = setIds.map((id) => {
    const set = sets.find((s) => s.id === id);
    if (
      !set ||
      set.generic ||
      set.unsupported?.length ||
      !set.textures.length ||
      set.textures.length > 8
    )
      throw Error("WORLD_PALETTE_UNAVAILABLE: " + id);
    return set;
  });
  const textures = new Set(selectedSets.flatMap((set) => set.textures));
  if (textures.size > intent.textureBudget)
    throw Error("WORLD_INTENT_TEXTURE_BUDGET: " + textures.size + "/" + intent.textureBudget);

  const attempts = 12;
  const retryable =
    /^(WORLD_(INTENT_(ZONE|CROSSING|SITE|ROOM|TERRACE)_CLEARANCE|ZONE_HAS_NO_CENTER_BLOCK|BANK_BOUNDARY_ZONE_CONFLICT|FACILITY_(TERRACE_BLOCKS_ROUTE|ORTHOGONAL_PASSAGE|PASSAGE_CROSSES_SPACE|OUTSIDE_PALETTE|BAD_GATE))):/;
  const failures = new Set<string>();
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return resolveIntentLayout(
        intent,
        seed,
        attempt ? seedFor(seed, "layout/" + attempt) : seed,
        zones,
        selectedSets,
        registry,
      );
    } catch (error) {
      if (!(error instanceof Error) || !retryable.test(error.message)) throw error;
      failures.add(error.message);
    }
  }
  throw Error("WORLD_INTENT_NO_LAYOUT: " + [...failures].join("; "));
}

function resolveIntentLayout(
  intent: WorldIntent,
  worldSeed: number,
  seed: number,
  zones: Map<string, Zone>,
  selectedSets: TerrainSet[],
  registry: Awaited<ReturnType<typeof readWorldStyles>>,
) {
  const { width, height, mode } = intent;
  const locations = new Map<string, Point2>();
  const reserved = new Set<string>();
  const toAnchor = (p: Point2) => ({ x: (p.x - 10) / (width - 20), y: (p.y - 10) / (height - 20) });
  for (const [index, z] of intent.zones.entries()) {
    if (z.mirrorOf) continue;
    const [x, y] = z.sector
      ? sectors[z.sector]
      : [0.5 + 0.27 * Math.cos(index * 2.4), 0.5 + 0.27 * Math.sin(index * 2.4)];
    const next = (axis: string, size: number, fraction: number) =>
      Math.min(
        size - 10,
        Math.max(10, Math.round(size * fraction) + intentChoice(seed, z.id + "/" + axis, 13) - 6),
      );
    const point =
      mode === "ladder" && z.sector === "center"
        ? { x: width / 2, y: height / 2 }
        : { x: next("x", width, x), y: next("y", height, y) };
    // Advance by terrain blocks when two requests compete for the same sector.
    for (let n = 0; n < 15 && reserved.has(blockKey(point)); n++) {
      point.x = 10 + ((point.x - 10 + 8) % (width - 19));
      if (n % 4 === 3) point.y = 10 + ((point.y - 10 + 8) % (height - 19));
    }
    if (reserved.has(blockKey(point))) throw Error("WORLD_INTENT_ZONE_CLEARANCE: " + z.id);
    locations.set(z.id, point);
    reserved.add(blockKey(point));
  }
  for (const z of intent.zones.filter((z) => z.mirrorOf)) {
    const peer = zones.get(z.mirrorOf!);
    const at = locations.get(z.mirrorOf!);
    if (mode !== "ladder" || !peer || !at || peer.tileSet !== z.tileSet || peer.biome !== z.biome)
      throw Error("WORLD_INTENT_BAD_MIRROR: " + z.id);
    locations.set(z.id, { x: width - at.x, y: height - at.y });
  }

  const styleOf = (z: Zone) => z.style ?? registry.tilesets[z.tileSet]?.profile;
  const layoutOf = (z: Zone) =>
    z.layout ??
    (z.biome !== "engineered"
      ? "open"
      : z.rooms || z.raised
        ? "lab"
        : styleOf(z) === "city"
          ? "city"
          : styleOf(z) === "interior" || z.tileSet === "UmojaEx3"
            ? "lab"
            : ["Aiur4City", "Slayn", "SlaynTemple"].includes(z.tileSet)
              ? "base"
              : "open");
  // Compact, single-bank sites use one aligned approach and a separate floor plan.
  const site = intent.zones.find((z) => z.id === intent.objective);
  const start = intent.zones.find((z) => z.id === intent.starts[0]);
  const compactSide = start?.sector && start.sector !== "center" ? start.sector : "south";
  const compact =
    mode === "mission" &&
    width === 64 &&
    height === 64 &&
    intent.zones.length === 2 &&
    intent.links.length === 1 &&
    intent.links[0].kind === "route" &&
    site?.biome === "engineered" &&
    start?.layout === "open" &&
    site.tileSet === start.tileSet &&
    (site.rooms?.length ?? 4) === 4 &&
    intent.links[0].character !== "trail" &&
    layoutOf(site) !== "open";
  if (compact) {
    const axis = compactSide === "north" || compactSide === "south" ? "y" : "x";
    const positive = compactSide === "north" || compactSide === "east";
    locations.set(start.id, { x: 32, y: 32, [axis]: positive ? 54 : 10 });
    locations.set(site.id, { x: 32, y: 32, [axis]: positive ? 30 : 34 });
  }

  const bridges = intent.links.filter((link) => link.kind === "bridge");
  if (bridges.length > 1 && mode === "mission")
    throw Error("WORLD_INTENT_CROSSING_LIMIT: one independent river per mission");
  const approaches: SpecInput["zones"] = [];
  const arrivals = new Map<string, { side: "north" | "south" | "east" | "west"; bank: number }>();
  const crossing = new Map<(typeof bridges)[number], Link>();
  const trails = new Map<(typeof bridges)[number], Link>();
  for (const link of intent.links) {
    if (!zones.has(link.from) || !zones.has(link.to) || link.from === link.to)
      throw Error("WORLD_INTENT_BAD_LINK: " + link.from + "/" + link.to);
    if (
      link.kind !== "bridge" ||
      mode !== "mission" ||
      zones.get(link.from)!.biome === zones.get(link.to)!.biome
    )
      continue;
    const from = zones.get(link.from)!;
    const to = zones.get(link.to)!;
    const wild = from.biome === "natural" ? from : to;
    const site = from.biome === "engineered" ? from : to;
    const a = locations.get(wild.id)!;
    const b = locations.get(site.id)!;
    const alongY = Math.abs(b.y - a.y) >= Math.abs(b.x - a.x);
    const axis = alongY ? "y" : "x",
      lateral = alongY ? "x" : "y";
    const length = alongY ? height : width,
      span = alongY ? width : height;
    const sign = b[axis] >= a[axis] ? 1 : -1;
    const bank =
      8 * Math.round((length * 0.46 + 8 * intentChoice(seed, "river/position", 3) - 8) / 8);
    const mid =
      Math.floor(span * 0.25) +
      8 * intentChoice(seed, "river/crossing", Math.max(1, Math.floor(span / 16)));
    const shift = Math.max(10, Math.round(length * 0.24));
    const land = { ...a, [axis]: bank + 4 - sign * 15, [lateral]: mid };
    a[axis] = sign > 0 ? Math.min(a[axis], land[axis] - 18) : Math.max(a[axis], land[axis] + 18);
    const clamp = (n: number) => Math.max(10, Math.min(length - 10, n));
    a[axis] = clamp(a[axis]);
    land[axis] = clamp(land[axis]);
    // Keep the bridge's authored segment cardinal. The trail leads onto it independently.
    b[axis] = clamp(bank + 4 + sign * shift);
    b[lateral] = mid;
    let approach = "CrossingApproach";
    while (zones.has(approach)) approach += "_";
    const side = alongY ? (sign > 0 ? "south" : "north") : sign > 0 ? "west" : "east";
    arrivals.set(site.id, { side, bank: sign > 0 ? bank + 8 : bank });
    approaches.push({
      id: approach,
      biome: "natural",
      tileSet: wild.tileSet,
      anchor: toAnchor(land),
      density: wild.density ?? 0.4,
      relief: wild.relief ?? 0.8,
      style: wild.style,
      influence: 0.5,
    });
    crossing.set(link, {
      from: approach,
      to: site.id,
      kind: "bridge",
      bankBoundary: true,
      bankStart: bank,
      width: 6,
    });
    const corridor = Math.abs(a[axis] - land[axis]);
    if (corridor < 4 && Math.abs(a[lateral] - mid) < 8)
      throw Error("WORLD_INTENT_CROSSING_CLEARANCE: enlarge the natural approach");
    const detour =
      (intentChoice(seed, "river/trailSide", 2) ? 1 : -1) *
      (9 + intentChoice(seed, "river/trailBend", 10));
    const weave = (progress: number, offset: number): Point2 => ({
      ...a,
      [axis]: Math.round(a[axis] + progress * (land[axis] - a[axis])),
      [lateral]: Math.max(
        10,
        Math.min(span - 10, Math.round(a[lateral] + progress * (mid - a[lateral]) + offset)),
      ),
    });
    trails.set(link, {
      from: wild.id,
      to: approach,
      kind: "road",
      width: 5,
      waypoints: [weave(0.3, detour), weave(0.68, -Math.round(detour / 2))],
      trail: trailProfile(seed, wild.id + "/approach"),
    });
  }

  const campaign = mode === "mission" && intent.zones.every((z) => styleOf(z));
  const compositionBudget =
    campaign &&
    !intent.decorReference &&
    intent.zones.some(
      ({ tileSet }) => tileSet === "BlackopsLab_A" || registry.tilesets[tileSet]?.spatial,
    )
      ? { min: 45, max: 65 }
      : undefined;
  const decorBudget = intent.decorBudget ?? compositionBudget;
  const specInput: SpecInput = {
    version: 1,
    name: intent.name,
    width,
    height,
    mode,
    seed: worldSeed,
    dependencies: intent.dependencies,
    decorBudget,
    decorReference:
      intent.decorReference ??
      (!decorBudget && intent.zones.every((zone) => !zone.distinctActors) ? "auto" : undefined),
    starts: intent.starts,
    objective: intent.objective,
    zones: [
      ...intent.zones.map((z) => {
        const peer = z.mirrorOf ? zones.get(z.mirrorOf)! : z;
        const profile = styleOf(peer);
        if (profile && !registry.profiles[profile])
          throw Error("WORLD_INTENT_UNKNOWN_STYLE: " + profile);
        return {
          id: z.id,
          biome: peer.biome,
          tileSet: peer.tileSet,
          anchor: toAnchor(locations.get(z.id)!),
          style: campaign ? profile : undefined,
          density: peer.density ?? (peer.biome === "natural" ? 0.42 : 0.22),
          distinctActors: peer.distinctActors,
          relief: peer.relief ?? (peer.biome === "natural" ? 0.8 : 0.15),
        };
      }),
      ...approaches.map((approach) => ({
        ...approach,
        style: campaign ? approach.style : undefined,
      })),
    ],
    connections: intent.links.flatMap((link): Link[] => {
      const river = crossing.get(link);
      if (river) return [trails.get(link)!, river];
      const natural =
        zones.get(link.from)!.biome === "natural" && zones.get(link.to)!.biome === "natural";
      const trail = mode === "mission" && (link.character === "trail" || natural);
      const a = locations.get(link.from)!;
      const b = locations.get(link.to)!;
      const grain = (intentChoice(seed, link.from + "/" + link.to + "/bend", 15) - 7) * 2;
      const mid = {
        x: Math.max(
          10,
          Math.min(
            width - 10,
            Math.round((a.x + b.x) / 2 + ((a.y - b.y) / Math.max(width, height)) * grain),
          ),
        ),
        y: Math.max(
          10,
          Math.min(
            height - 10,
            Math.round((a.y + b.y) / 2 + ((b.x - a.x) / Math.max(width, height)) * grain),
          ),
        ),
      };
      return [
        {
          from: link.from,
          to: link.to,
          kind: link.kind === "bridge" ? "bridge" : "road",
          width: link.character === "service" ? 4 : trail ? 5 : 8,
          ...(trail && link.kind !== "bridge"
            ? { waypoints: [mid], trail: trailProfile(seed, link.from + "/" + link.to) }
            : {}),
        },
      ];
    }),
  };
  specInput.landscape = campaign ? "campaign" : "custom";

  const base = planWorld(resolveWorldSpec(specInput));
  for (const [index, z] of intent.zones.entries()) {
    const kind = layoutOf(z);
    if (kind === "open") {
      if (z.rooms || z.raised) throw Error("WORLD_INTENT_OPEN_SITE_WITH_ROOMS: " + z.id);
      continue;
    }
    if (z.biome !== "engineered")
      throw Error("WORLD_INTENT_SITE_REQUIRES_ENGINEERED_ZONE: " + z.id);
    if (mode !== "mission") {
      if (z.layout !== undefined || z.rooms || z.raised)
        throw Error("WORLD_INTENT_SITE_REQUIRES_MISSION: " + z.id);
      continue;
    }
    const set = selectedSets[base.zones[index].bank];
    const entry = registry.tilesets[set.id];
    const facility = planIntentFacility({
      zone: z,
      kind,
      layout: base,
      width,
      height,
      set,
      seed,
      materials: entry?.materials ?? {},
      arrival: arrivals.get(z.id),
      ...(compact && site.id === z.id ? { compactSide, topologySeed: worldSeed } : {}),
    });
    Object.assign(specInput.zones[index], facility);
  }
  const spec = resolveWorldSpec(specInput);
  const layout = planWorld(spec);
  return { spec, layout, structures: structureLayout(spec, layout) };
}

function blockKey(p: Point2) {
  return Math.floor(p.x / 8) + "/" + Math.floor(p.y / 8);
}

function trailProfile(seed: number, key: string) {
  return [
    { at: 0, width: 4 },
    { at: 0.27, width: 7 + intentChoice(seed, key + "/wide", 4) },
    { at: 0.63, width: 3 + intentChoice(seed, key + "/narrow", 3) },
    { at: 1, width: 5 },
  ];
}
