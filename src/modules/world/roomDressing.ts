import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { projectPath } from "../../app/paths.js";
import { measuredMemberGeometry } from "../placement/compositionGeometry.js";
import { readDecorEvidence, scenicActor } from "../placement/decorEvidence.js";
import type { DecorModel, DecorPalette } from "../placement/decorPalette.js";
import { checkGroupClearance } from "../placement/groupClearance.js";
import type {
  ExclusionZone,
  LocationRoute,
  PlacementObject,
  Position3,
} from "../placement/types.js";
import type { Point2, TerrainArea } from "../terrain/types.js";
import {
  facilityFace,
  facilitySides,
  facilitySpaceDistance,
  partitionSpans,
  type FacilityLayout,
} from "./facility.js";
import { seedFor } from "./plan.js";
import type { RoomPassport } from "./workstations.js";

type Space = FacilityLayout["spaces"][number];
type Terrace = FacilityLayout["terraces"][number];
type Footprint = ReturnType<typeof checkGroupClearance>;
type Reserve = Point2 & { radius: number };
type Side = RoomPassport["side"];
type Aisle = NonNullable<Space["aisles"]>[number];
type Sample = { side: Side; points: Point2[] };
type LightRun = { from: Point2; to: Point2; side: number; spacing: number; positions: Position3[] };
type Asset = { id: string; variation?: number; scale?: number; wallFacing?: boolean };
type StationRecipe = { anchor: string; support: string[] };
type Recipes = {
  version: 1;
  ergonomics: { consoleGap: number; opposedWithin: number };
  wayfinding: {
    spacing: number;
    edgeOffset: number;
    stairSideOffset: number;
    upperLandingDepth: number;
  };
  raisedContainment: {
    experiments: StationRecipe;
    samplePrep: StationRecipe;
    groundConsole: string;
    analysisConsole: string;
    analysisSeam: number;
    sideConsole: string;
    experimentRow: string;
    experimentPitch: number;
    experimentMax: number;
    experimentSupport: string[];
  };
  activities: Record<RoomPassport["activity"], StationRecipe & { secondary?: StationRecipe }>;
  wallBanks?: Record<
    string,
    Partial<
      Record<
        RoomPassport["activity"],
        Array<{
          slot: string;
          count: number;
          pitch: number;
        }>
      >
    >
  >;
  slots: Record<string, { roles: string[]; match: string }>;
  palettes: Record<string, Record<string, Asset[]> | string | undefined>;
};

export async function loadRoomRecipes() {
  const raw = await readFile(
    projectPath("resources/authoring-catalog/style_rules/room_composition.json"),
    "utf8",
  );
  const recipes = JSON.parse(raw) as Recipes;
  if (recipes.version !== 1) throw Error("WORLD_ROOM_RECIPE_VERSION");
  return { recipes, revision: createHash("sha256").update(raw).digest("hex") };
}

const sideOrder = ["north", "east", "south", "west"] as const;
const wallFacing = { north: 0, east: 270, south: 180, west: 90 } as const;
const opposite = { north: "south", south: "north", east: "west", west: "east" } as const;
const accentSlots = new Set([
  "console",
  "wallConsole",
  "analysisConsole",
  "security",
  "pathLight",
  "labEquipment",
]);
const rect = (minX: number, minY: number, maxX: number, maxY: number) =>
  ({ type: "rectangle", minX, minY, maxX, maxY }) as const;
const boundsOf = (space: Space) =>
  rect(
    space.center.x - space.width / 2 + 0.65,
    space.center.y - space.height / 2 + 0.65,
    space.center.x + space.width / 2 - 0.65,
    space.center.y + space.height / 2 - 0.65,
  );
const overlap = (a: Footprint, b: Footprint) =>
  Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > -0.18 &&
  Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) > -0.18;
const clearGap = (a: Footprint, b: Footprint) =>
  Math.hypot(
    Math.max(0, a.minX - b.maxX, b.minX - a.maxX),
    Math.max(0, a.minY - b.maxY, b.minY - a.maxY),
  );

function partitionBounds(space: Space): ExclusionZone[] {
  return space.partitions.flatMap((part) =>
    partitionSpans(part).map(([from, to]) =>
      part.from.x === part.to.x
        ? rect(part.from.x - 0.78, from, part.from.x + 0.78, to)
        : rect(from, part.from.y - 0.78, to, part.from.y + 0.78),
    ),
  );
}

function pattern(
  space: Space,
  passport: RoomPassport,
  side: RoomPassport["side"],
  island: boolean,
) {
  const normal = facilitySides[side];
  const halfSpan = (normal.x ? space.height : space.width) / 2;
  const halfDepth = (normal.x ? space.width : space.height) / 2;
  const direction = passport.seed % 2 ? 1 : -1;
  const offsets = [0, 0.29, -0.29, 0.56, -0.56, 0.76, -0.76];
  const depths = island
    ? [halfDepth, halfDepth - 2.3, halfDepth + 2.3, 3.3]
    : passport.activity === "circulation"
      ? [1.35, 1.8, 2.35, 3.3]
      : [2.6, 3.8, 5, 6.4];
  return depths.flatMap((depth) =>
    offsets.map((offset) => {
      const wall = facilityFace(space, side, direction * offset * halfSpan);
      return { x: wall.x - normal.x * depth, y: wall.y - normal.y * depth };
    }),
  );
}

function containmentBays(space: Space, stair: Terrace["stairs"][number], order: Side[]): Sample[] {
  const rear = facilitySides[stair.direction];
  const lateral: Side[] = rear.x ? ["south", "north"] : ["west", "east"];
  const entrance = space.openings.find(({ side }) => lateral.includes(side))?.side;
  const sides = [
    ...new Set([
      ...(entrance ? [entrance] : []),
      ...order.filter((side) => lateral.includes(side)),
    ]),
  ];
  const half = (rear.x ? space.width : space.height) / 2;
  return sides.map((side) => {
    const outward = facilitySides[side];
    const points = [3.6, 4.2, 3.2, 4.8].flatMap((inset) =>
      [0.66, 0.56, 0.73, 0.44, 0.31].map((offset) => {
        const p = facilityFace(space, side, half * offset * (rear.x || rear.y));
        return { x: p.x - outward.x * inset, y: p.y - outward.y * inset };
      }),
    );
    return { side, points };
  });
}

function upperPoints(area: Terrace["area"]) {
  const cx = (area.minX + area.maxX) / 2,
    cy = (area.minY + area.maxY) / 2;
  const w = area.maxX - area.minX,
    h = area.maxY - area.minY;
  return [0, -0.24, 0.24, -0.32, 0.32].flatMap((x) =>
    [0, 0.18, -0.18].map((y) => ({ x: cx + w * x, y: cy + h * y })),
  );
}

function stationRow(
  station: { position: Point2; side: Side },
  index: number,
  cargo: boolean,
): Sample[] {
  const { position, side } = station;
  const normal = facilitySides[side];
  const direction = index % 2 ? -1 : 1;
  const offsets = cargo ? [0, 1.5, -1.5, 3, -3, 4.5, -4.5] : [0, 2.4, -2.4, 4, -4, 6, -6];
  const depths = cargo ? [0, 1.8, -1.8] : [0, -2.4, 2.4, -4.8, 4.8, -6.8, 6.8];
  return [
    {
      side,
      points: depths.flatMap((depth) =>
        offsets.map((offset) => ({
          x: position.x + normal.x * depth - normal.y * offset * direction,
          y: position.y + normal.y * depth + normal.x * offset * direction,
        })),
      ),
    },
  ];
}

function lightAisles(aisles: Aisle[]): Aisle[] {
  const merged: Aisle[] = [];
  for (const { from, to, width } of aisles) {
    const dx = to.x - from.x,
      dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (!length) continue;
    const ux = dx / length,
      uy = dy / length;
    const aside = (p: Point2) => (p.x - from.x) * uy - (p.y - from.y) * ux;
    const along = (p: Point2) => (p.x - from.x) * ux + (p.y - from.y) * uy;
    let first = 0,
      last = length;
    for (let i = 0; i < merged.length;) {
      const old = merged[i];
      const a = along(old.from),
        b = along(old.to);
      if (
        old.width === width &&
        Math.abs(aside(old.from)) < 1e-6 &&
        Math.abs(aside(old.to)) < 1e-6 &&
        Math.min(a, b) <= last + 1e-6 &&
        Math.max(a, b) >= first - 1e-6
      ) {
        first = Math.min(first, a, b);
        last = Math.max(last, a, b);
        merged.splice(i, 1);
        i = 0;
      } else i++;
    }
    merged.push({
      from: { x: from.x + ux * first, y: from.y + uy * first },
      to: { x: from.x + ux * last, y: from.y + uy * last },
      width,
    });
  }
  return merged;
}

function workApproaches(area: Footprint, wall: RoomPassport["side"], operator: boolean) {
  const cx = (area.minX + area.maxX) / 2;
  const cy = (area.minY + area.maxY) / 2;
  const length = 1.65;
  const half = 0.9;
  const aprons = {
    south: rect(cx - half, area.minY - length, cx + half, area.minY),
    north: rect(cx - half, area.maxY, cx + half, area.maxY + length),
    west: rect(area.minX - length, cy - half, area.minX, cy + half),
    east: rect(area.maxX, cy - half, area.maxX + length, cy + half),
  };
  return (
    operator
      ? [opposite[wall]]
      : [
          opposite[wall],
          ...sideOrder.filter((side) => side !== wall && side !== opposite[wall]),
          wall,
        ]
  ).map((side) => aprons[side]);
}

export function createRoomDresser(palette: DecorPalette, recipes: Recipes) {
  const models = new Map<
    string,
    Promise<Awaited<ReturnType<DecorPalette["resolve"]>> | undefined>
  >();
  const fromCatalog = new Map<string, Promise<Asset[]>>();
  const modelCorners = new WeakMap<DecorModel, Map<string, Point2[]>>();
  function cornersAtOrigin(model: DecorModel, rotation: number, scale: number) {
    let cache = modelCorners.get(model);
    if (!cache) {
      cache = new Map();
      modelCorners.set(model, cache);
    }
    const key = rotation + "/" + scale;
    let corners = cache.get(key);
    if (!corners) {
      const { bounds } = model.measured.measurement;
      corners = measuredMemberGeometry({ x: 0, y: 0 }, 0, {
        offset: { x: 0, y: 0 },
        rotation,
        scale,
        boundsFrame: "member",
        horizontalBounds: {
          minX: bounds.min[0],
          minY: bounds.min[1],
          maxX: bounds.max[0],
          maxY: bounds.max[1],
        },
      }).corners;
      cache.set(key, corners);
    }
    return corners;
  }
  const measure = (asset: Asset) => {
    const key = asset.id + "/" + (asset.variation ?? 0);
    if (!models.has(key))
      models.set(
        key,
        palette
          .resolve({ id: asset.id, variation: asset.variation ?? 0, preview: false })
          .catch(() => undefined),
      );
    return models.get(key)!;
  };
  const stockAssets = (tileSet: string, slot: string) => {
    const key = tileSet + "/" + slot;
    if (!fromCatalog.has(key))
      fromCatalog.set(
        key,
        (async () => {
          const [index, pack] = await Promise.all([
            readDecorEvidence(),
            palette.catalog.pack(tileSet).catch((error: unknown) => {
              if (String(error).includes("CATALOG_TILESET_UNKNOWN")) return undefined;
              throw error;
            }),
          ]);
          const { roles, match } = recipes.slots[slot];
          const pattern = new RegExp(match, "i");
          return (pack?.sections.decor ?? [])
            .filter(
              (actor) =>
                scenicActor(index, actor.id) &&
                index.actors[actor.id]?.kind === "built" &&
                roles.includes(index.actors[actor.id]!.role) &&
                pattern.test(actor.id + " " + (actor.name ?? "")),
            )
            .slice(0, 8)
            .map(({ id }) => ({ id }));
        })(),
      );
    return fromCatalog.get(key)!;
  };

  return async function dress(
    space: Space,
    passport: RoomPassport,
    facility: FacilityLayout,
    routes: LocationRoute[],
    reserved: Reserve[],
    pointOnGround: (p: Point2) => Position3,
  ) {
    const recipe = recipes.activities[passport.activity];
    const theme = recipes.palettes[passport.tileSet];
    const paletteSlots = typeof theme === "string" ? recipes.palettes[theme] : theme;
    const area = boundsOf(space);
    const roomShape: TerrainArea =
      space.shape === "ellipse"
        ? {
            type: "polygon",
            points: Array.from({ length: 16 }, (_, i) => {
              const angle = (i * Math.PI) / 8;
              return {
                x: space.center.x + (space.width / 2 - 0.65) * Math.cos(angle),
                y: space.center.y + (space.height / 2 - 0.65) * Math.sin(angle),
              };
            }),
          }
        : area;
    const exclusions = [
      ...partitionBounds(space),
      ...reserved.map((r) => ({
        type: "circle" as const,
        center: { x: r.x, y: r.y },
        radius: r.radius,
      })),
    ];
    const lanes = [
      ...routes,
      ...(space.aisles ?? []).map((a, i) => ({
        id: space.id + "/" + i,
        points: [a.from, a.to],
        width: a.width,
      })),
    ];
    const deck = facility.terraces.find(
      (t) =>
        t.zone === space.zone &&
        t.stairs.length &&
        t.area.minX >= area.minX &&
        t.area.minY >= area.minY &&
        t.area.maxX <= area.maxX &&
        t.area.maxY <= area.maxY,
    );
    const order = [passport.side, ...sideOrder.filter((side) => side !== passport.side)];
    const footprints: Footprint[] = [];
    const consoles: {
      footprint: Footprint;
      position: Position3;
      front: Side;
      slot: string;
    }[] = [];
    const objects: PlacementObject[] = [];
    const fitted: {
      group: "primary" | "secondary";
      slot: string;
      actor: string;
      variation: number;
      rotation: number;
      position: Position3;
      operator?: { front: RoomPassport["side"]; footprint: Footprint; approach: Footprint };
    }[] = [];
    const missing: string[] = [];
    let workApproach: Footprint | undefined;

    async function fit(
      slot: string,
      i: number,
      samples: { side: RoomPassport["side"]; points: Point2[] }[],
      surface: TerrainArea,
      group: "primary" | "secondary" = "primary",
      assets?: Asset[],
      faceInterior = false,
    ) {
      const curated = typeof paletteSlots === "object" ? (paletteSlots[slot] ?? []) : [];
      const orderSeed = seedFor(passport.seed, slot + "/" + i) >>> 0;
      const shift = i < 0 ? 0 : orderSeed % Math.max(1, curated.length);
      const ordered = [...curated.slice(shift), ...curated.slice(0, shift)];
      async function tryAssets(candidates: Asset[]) {
        for (const asset of candidates) {
          const model = await measure(asset);
          if (!model) continue;
          const scale = asset.scale ?? 1;
          const operator =
            slot !== "pathLight" &&
            /monitor|console|wall.?screen|terminal|holoprojector/i.test(model.actor.id);
          for (const { side, points } of samples) {
            for (const p of points) {
              const preferred = (wallFacing[side] * Math.PI) / 180;
              const angles =
                faceInterior || asset.wallFacing || operator
                  ? [preferred]
                  : [preferred, preferred + Math.PI];
              for (const rotation of angles) {
                const geometry = {
                  position: p,
                  corners: cornersAtOrigin(model, rotation, scale).map(({ x, y }) => ({
                    x: p.x + x,
                    y: p.y + y,
                  })),
                };
                let footprint: Footprint;
                try {
                  footprint = checkGroupClearance(geometry, surface, lanes, exclusions);
                } catch (error) {
                  if (!String(error).includes("LANDSCAPE_GROUP_")) throw error;
                  continue;
                }
                if (footprints.some((old) => overlap(footprint, old))) continue;
                const position = pointOnGround(p);
                const front = opposite[side];
                if (
                  operator &&
                  consoles.some((other) => {
                    if (Math.abs(other.position.z - position.z) > 0.75) return false;
                    const gap = clearGap(footprint, other.footprint);
                    const sameBank =
                      slot === recipes.raisedContainment.analysisConsole && other.slot === slot;
                    const minimum = sameBank
                      ? recipes.raisedContainment.analysisSeam
                      : recipes.ergonomics.consoleGap;
                    if (gap + 1e-6 < minimum) return true;
                    if (gap >= recipes.ergonomics.opposedWithin || other.front !== side)
                      return false;
                    const { x, y } = facilitySides[front];
                    const dx = other.position.x - position.x,
                      dy = other.position.y - position.y;
                    return dx * x + dy * y > 0 && Math.abs(dx * y - dy * x) <= 1.5;
                  })
                )
                  continue;
                let approach: Footprint | undefined;
                if (
                  geometry.corners.some(
                    (corner) => Math.abs(pointOnGround(corner).z - position.z) > 0.38,
                  )
                )
                  continue;
                if (
                  operator ||
                  (i < 0 &&
                    passport.activity !== "circulation" &&
                    passport.activity !== "checkpoint")
                ) {
                  approach = workApproaches(footprint, side, operator).find((apron) => {
                    if (footprints.some((old) => overlap(apron, old))) return false;
                    const corners = [
                      { x: apron.minX, y: apron.minY },
                      { x: apron.maxX, y: apron.minY },
                      { x: apron.minX, y: apron.maxY },
                      { x: apron.maxX, y: apron.maxY },
                    ];
                    if (corners.some((p) => Math.abs(pointOnGround(p).z - position.z) > 0.38))
                      return false;
                    try {
                      checkGroupClearance(
                        { position: corners[0], corners },
                        surface,
                        [],
                        exclusions,
                      );
                    } catch (error) {
                      if (!String(error).includes("LANDSCAPE_GROUP_")) throw error;
                      return false;
                    }
                    return true;
                  });
                  if (!approach) continue;
                  if (i < 0 && group === "primary") workApproach = approach;
                  exclusions.push(approach);
                }
                const object: PlacementObject = {
                  kind: "Doodad",
                  catalogId: model.actor.id,
                  position,
                  rotation,
                  variation: model.variation ?? 0,
                  ...(scale === 1 ? {} : { scale: { x: scale, y: scale, z: scale } }),
                  flags: { HeightAbsolute: "1" },
                };
                footprints.push(footprint);
                objects.push(object);
                if (operator) consoles.push({ footprint, position, front, slot });
                fitted.push({
                  group,
                  slot,
                  actor: model.actor.id,
                  variation: object.variation ?? 0,
                  rotation,
                  position,
                  ...(operator && approach ? { operator: { front, footprint, approach } } : {}),
                });
                return { side, position, footprint, approach };
              }
            }
          }
        }
      }
      const result = await tryAssets(assets ?? ordered);
      if (result) return result;
      if (assets) return undefined;
      if (curated.length && accentSlots.has(slot)) return undefined;
      const attempted = new Set(ordered.map((asset) => asset.id));
      return tryAssets(
        (await stockAssets(passport.tileSet, slot)).filter(({ id }) => !attempted.has(id)),
      );
    }

    async function fitWallRow(
      slot: string,
      side: Side,
      wall: Point2,
      layout: { pitch: number } | { span: number; seam: number },
      depths: number[],
      surface: TerrainArea,
      options: { onFloor?: (p: Point2) => boolean; counts?: number[]; shifts?: number[] } = {},
    ) {
      const normal = facilitySides[side];
      const curated = typeof paletteSlots === "object" ? paletteSlots[slot] : undefined;
      const candidates =
        Array.isArray(curated) && curated.length
          ? curated
          : await stockAssets(passport.tileSet, slot);
      const before = [
        objects.length,
        footprints.length,
        fitted.length,
        consoles.length,
        exclusions.length,
      ];
      for (const target of options.counts ?? [3, 2]) {
        for (const asset of candidates) {
          const model = await measure(asset);
          if (!model) continue;
          const variations = [
            ...new Set([
              model.variation ?? 0,
              ...(model.variants ?? []).flatMap((file) => {
                const match = file.match(/_(\d+)\.m3$/i);
                return match ? [Number(match[1])] : [];
              }),
            ]),
          ];
          let packed: { along: number; asset: Asset }[] | undefined;
          if ("span" in layout) {
            const rotation = (wallFacing[side] * Math.PI) / 180;
            const extents: { variant: Asset; min: number; width: number; depth: number }[] = [];
            for (const variation of variations) {
              const variant = { ...asset, variation, wallFacing: true };
              const measured = await measure(variant);
              if (!measured) continue;
              const corners = cornersAtOrigin(measured, rotation, 1);
              const axis = corners.map(({ x, y }) => -x * normal.y + y * normal.x);
              const cross = corners.map(({ x, y }) => x * normal.x + y * normal.y);
              const depth = Math.max(...cross) - Math.min(...cross);
              const reference = extents[0];
              if (reference && Math.abs(depth - reference.depth) > reference.depth * 0.25) continue;
              const min = Math.min(...axis);
              extents.push({ variant, min, width: Math.max(...axis) - min, depth });
            }
            if (!extents.length) continue;
            const members = Array.from({ length: target }, (_, i) => extents[i % extents.length]);
            const total = members.reduce((width, member) => width + member.width, 0);
            const seams = (target - 1) * layout.seam;
            const nominal = asset.scale ?? 1;
            const scale = Math.min(nominal, (layout.span - seams - 0.04) / total);
            if (scale < nominal * 0.82) continue;
            let edge = -(total * scale + seams) / 2;
            packed = members.map(({ variant, min, width }) => {
              const along = edge - min * scale;
              edge += width * scale + layout.seam;
              return { along, asset: { ...variant, scale } };
            });
          }
          for (const { depth, shift } of (options.shifts ?? [0]).flatMap((shift) =>
            depths.map((depth) => ({ depth, shift })),
          )) {
            const used = new Set<number>();
            let approach: Footprint | undefined;
            for (let i = 0; i < target; i++) {
              const member = packed?.[i];
              const along =
                shift +
                (member?.along ?? (i - (target - 1) / 2) * ("pitch" in layout ? layout.pitch : 0));
              const p = {
                x: wall.x - normal.x * depth - normal.y * along,
                y: wall.y - normal.y * depth + normal.x * along,
              };
              if (options.onFloor && !options.onFloor(p)) break;
              const variants = [...variations.filter((v) => !used.has(v)), ...used];
              const piece = await fit(
                slot,
                i,
                [{ side, points: [p] }],
                surface,
                "secondary",
                member ? [member.asset] : variants.map((variation) => ({ ...asset, variation })),
              );
              if (!piece) break;
              approach ??= piece.approach;
              used.add(fitted.at(-1)!.variation);
              if (i + 1 === target) return { count: target, approach };
            }
            [objects.length, footprints.length, fitted.length, consoles.length, exclusions.length] =
              before;
          }
        }
      }
      return undefined;
    }

    const fitLightPair = async (samples: Sample[], surface = roomShape) => {
      const positions: Position3[] = [];
      for (const sample of samples) {
        const light = await fit("pathLight", 0, [sample], surface);
        if (light) positions.push(light.position);
      }
      if (positions.length === 2 && Math.abs(positions[0].z - positions[1].z) <= 0.18)
        return positions;
      objects.length -= positions.length;
      footprints.length -= positions.length;
      fitted.length -= positions.length;
      return undefined;
    };
    const entryLights: Position3[][] = [];
    const edgeOffset = recipes.wayfinding.edgeOffset;
    const dressEntryLights = async () => {
      if (passport.condition !== "abandoned" && (space.walls || deck))
        for (const { side, offset, width } of space.openings) {
          const normal = facilitySides[side];
          const edge = width / 2 + edgeOffset;
          // Move the two fixtures together if a workstation occupies the preferred jamb.
          for (const [depth, extra] of [
            [1.65, 0],
            [2.1, 0.38],
            [1.45, 0.75],
            [2.8, 0.75],
          ]) {
            const pair = await fitLightPair(
              [-edge - extra, edge + extra].map((shift) => {
                const p = facilityFace(space, side, offset + shift);
                return { side, points: [{ x: p.x - depth * normal.x, y: p.y - depth * normal.y }] };
              }),
            );
            if (pair) {
              entryLights.push(pair);
              break;
            }
          }
        }
    };
    // Ordinary rooms reserve both jamb fixtures before fitting their equipment.
    const site = facility.grounds.find(({ zone }) => zone === space.zone);
    const compact =
      site &&
      site.area.maxX - site.area.minX >= 44 &&
      site.area.maxX - site.area.minX <= 54 &&
      site.area.maxY - site.area.minY >= 44 &&
      site.area.maxY - site.area.minY <= 54;
    if (!deck || compact) await dressEntryLights();
    const entryObjects = objects.splice(0);
    const entryFixtures = fitted.splice(0);
    const upper = passport.placement === "upper" && deck;
    const raisedLab = upper && passport.activity === "containment" && recipes.raisedContainment;
    const upperArea =
      upper &&
      rect(
        upper.area.minX + 0.55,
        upper.area.minY + 0.55,
        upper.area.maxX - 0.55,
        upper.area.maxY - 0.55,
      );
    const ground = order.map((side) => ({
      side,
      points: pattern(space, passport, side, passport.placement === "island"),
    }));
    const elevated = upper ? order.map((side) => ({ side, points: upperPoints(upper.area) })) : [];
    const upperHeight = upper
      ? pointOnGround({
          x: (upper.area.minX + upper.area.maxX) / 2,
          y: (upper.area.minY + upper.area.maxY) / 2,
        }).z
      : Infinity;
    const labGround = (p: Point2) => pointOnGround(p).z < upperHeight - 0.75;
    const primary = raisedLab ? raisedLab.experiments : recipe;
    const primarySurface = !raisedLab && upperArea ? upperArea : roomShape;
    const focus = await fit(
      primary.anchor,
      -1,
      raisedLab && upper
        ? [...containmentBays(space, upper.stairs[0], order), ...ground].map(
            ({ side, points }) => ({ side, points: points.filter(labGround) }),
          )
        : upperArea
          ? elevated
          : ground,
      primarySurface,
      "primary",
      undefined,
      Boolean(raisedLab),
    );
    if (!focus) missing.push(primary.anchor);
    const budget = Math.max(
      1,
      Math.min(
        primary.support.length,
        (space.width * space.height >= 420 ? 5 : 3) +
          (passport.density === "busy" ? 2 : passport.density === "light" ? -2 : 0),
      ),
    );
    const support =
      passport.condition === "damaged" ? ["damage", ...primary.support] : primary.support;
    async function fitSupport(
      station: NonNullable<typeof focus>,
      anchor: string,
      slots: string[],
      surface: TerrainArea,
      group: "primary" | "secondary",
      onFloor?: (p: Point2) => boolean,
    ) {
      let cargoRow = anchor === "cargo" ? station : undefined;
      for (const [i, slot] of slots.entries()) {
        const cargo = slot === "cargo";
        const row = stationRow(cargo ? (cargoRow ?? station) : station, i, cargo);
        const samples = onFloor
          ? row.map(({ side, points }) => ({ side, points: points.filter(onFloor) }))
          : row;
        const piece = await fit(slot, i, samples, surface, group);
        if (!piece) missing.push(group === "primary" ? slot : group + "/" + slot);
        else if (cargo) cargoRow ??= piece;
      }
    }
    const isGallery =
      passport.activity === "circulation" && !space.walls && space.shape !== "ellipse";
    let postOutline: Point2[] | undefined;
    let postDecal:
      { actor: string; variation: number; scale: number; position: Position3 } | undefined;
    if (focus && isGallery && site?.floorJoints) {
      const normal = facilitySides[focus.side];
      const supports = [focus.footprint];
      for (const edge of [-1, 1]) {
        const points = [2.4, 2.9, 3.5].flatMap((offset) =>
          [0, 0.35, -0.35].map((inset) => ({
            x: focus.position.x - normal.y * offset * edge + normal.x * inset,
            y: focus.position.y + normal.x * offset * edge + normal.y * inset,
          })),
        );
        const piece = await fit("postSupply", 0, [{ side: focus.side, points }], roomShape);
        if (piece) supports.push(piece.footprint);
      }
      if (supports.length > 1) {
        const minX = Math.max(area.minX, Math.min(...supports.map((p) => p.minX)) - 0.28);
        const minY = Math.max(area.minY, Math.min(...supports.map((p) => p.minY)) - 0.28);
        const maxX = Math.min(area.maxX, Math.max(...supports.map((p) => p.maxX)) + 0.28);
        const maxY = Math.min(area.maxY, Math.max(...supports.map((p) => p.maxY)) + 0.28);
        const c = 0.28;
        postOutline = [
          { x: minX + c, y: minY },
          { x: maxX - c, y: minY },
          { x: maxX, y: minY + c },
          { x: maxX, y: maxY - c },
          { x: maxX - c, y: maxY },
          { x: minX + c, y: maxY },
          { x: minX, y: maxY - c },
          { x: minX, y: minY + c },
        ];
        const decals = typeof paletteSlots === "object" ? (paletteSlots.postDecal ?? []) : [];
        for (const asset of decals) {
          const model = await palette
            .resolveAsset(asset.id, asset.variation ?? 0)
            .catch(() => undefined);
          if (!model) continue;
          postDecal = {
            actor: model.actor.id,
            variation: asset.variation ?? 0,
            scale: asset.scale ?? 1,
            position: focus.position,
          };
          break;
        }
      }
    } else if (focus)
      await fitSupport(
        focus,
        primary.anchor,
        support.slice(0, budget),
        primarySurface,
        "primary",
        raisedLab ? labGround : undefined,
      );
    let secondaryApproach: Footprint | undefined;
    let prepPosition: Point2 | undefined;
    const secondary = raisedLab ? raisedLab.samplePrep : recipe.secondary;
    const large = space.width * space.height >= (passport.density === "busy" ? 420 : 520);
    if (focus && secondary && (raisedLab || (large && passport.density !== "light"))) {
      const fromPrimary = (p: Point2) => Math.hypot(p.x - focus.position.x, p.y - focus.position.y);
      const lower = (p: Point2) => !upper || labGround(p);
      const samples = order
        .map((side) => ({
          side,
          points: pattern(space, passport, side, false)
            .filter(
              (p) =>
                lower(p) && fromPrimary(p) >= Math.min(8, Math.min(space.width, space.height) / 3),
            )
            .sort((a, b) => fromPrimary(b) - fromPrimary(a)),
        }))
        .sort(
          (a, b) =>
            (raisedLab
              ? Number(b.side === opposite[focus.side]) - Number(a.side === opposite[focus.side])
              : 0) ||
            (b.points.length ? fromPrimary(b.points[0]) : 0) -
              (a.points.length ? fromPrimary(a.points[0]) : 0),
        );
      const station = await fit(secondary.anchor, -1, samples, roomShape, "secondary");
      if (!station) missing.push("secondary/" + secondary.anchor);
      else {
        prepPosition = station.position;
        secondaryApproach = station.approach;
        await fitSupport(
          station,
          secondary.anchor,
          secondary.support,
          roomShape,
          "secondary",
          lower,
        );
      }
    }
    if (raisedLab && upper && upperArea) {
      const stair = upper.stairs[0];
      const side = stair.direction;
      const normal = facilitySides[side];
      const wall = order.map((wallSide) => {
        const outward = facilitySides[wallSide];
        const span = outward.x ? space.height : space.width;
        const points = [1.6, 2, 2.4].flatMap((depth) =>
          [0.28, -0.28, 0.15, -0.15, 0].map((offset) => {
            const p = facilityFace(space, wallSide, span * offset);
            return { x: p.x - outward.x * depth, y: p.y - outward.y * depth };
          }),
        );
        return { side: wallSide, points: points.filter(labGround) };
      });
      if (!(await fit(raisedLab.groundConsole, 0, wall, roomShape))) missing.push("ground/console");
      const { minX, minY, maxX, maxY } = upper.area;
      const back = normal.x ? (normal.x > 0 ? maxX : minX) : normal.y > 0 ? maxY : minY;
      const align = normal.x ? (minY + maxY) / 2 : (minX + maxX) / 2;
      const analysis = await fitWallRow(
        raisedLab.analysisConsole,
        side,
        normal.x ? { x: back, y: align } : { x: align, y: back },
        {
          span: normal.x ? upperArea.maxY - upperArea.minY : upperArea.maxX - upperArea.minX,
          seam: raisedLab.analysisSeam,
        },
        [1.2, 1.35, 1.55, 1.8, 2.05],
        upperArea,
      );
      if (analysis) secondaryApproach = analysis.approach;
      else missing.push("upper/analysisConsole");
      if (analysis) {
        const lateral = normal.x ? (["south", "north"] as const) : (["west", "east"] as const);
        const front = normal.x ? (normal.x > 0 ? minX : maxX) : normal.y > 0 ? minY : maxY;
        for (const [i, flank] of lateral.entries()) {
          const points = [1.35, 1.55, 1.8].flatMap((fromEdge) =>
            [1.35, 1.65, 2].map((fromFront) => {
              const along =
                i === 0 ? (normal.x ? minY : minX) + fromEdge : (normal.x ? maxY : maxX) - fromEdge;
              const across = front + (normal.x || normal.y) * fromFront;
              return normal.x ? { x: across, y: along } : { x: along, y: across };
            }),
          );
          if (
            !(await fit(
              raisedLab.sideConsole,
              i,
              [{ side: flank, points }],
              upperArea,
              "secondary",
            ))
          )
            missing.push("upper/sideConsole/" + flank);
        }
      }
      const sampleWall = facilityFace(space, stair.side, 0);
      const sampleSpan = normal.x ? space.height : space.width;
      const maxSamples = passport.density === "busy" ? raisedLab.experimentMax : 3;
      const samples = await fitWallRow(
        raisedLab.experimentRow,
        stair.side,
        sampleWall,
        { pitch: raisedLab.experimentPitch },
        [2, 2.6, 3.15],
        roomShape,
        {
          onFloor: labGround,
          counts: Array.from({ length: maxSamples - 1 }, (_, i) => maxSamples - i),
          shifts: [0, -0.14, 0.14, -0.24, 0.24].map((fraction) => sampleSpan * fraction),
        },
      );
      if (!samples) missing.push("ground/sampleStation");
      if (samples && passport.density !== "light") {
        const outward = facilitySides[stair.side];
        const towardPrep = prepPosition
          ? Math.sign(
              -(prepPosition.x - sampleWall.x) * outward.y +
                (prepPosition.y - sampleWall.y) * outward.x,
            ) || 1
          : 1;
        for (const [i, slot] of raisedLab.experimentSupport.entries()) {
          const direction = i % 2 === 0 ? towardPrep : -towardPrep;
          const points = [7.5, 8.6, 10, -7.5, -8.6, -10]
            .flatMap((along) =>
              [2.3, 2.9, 3.6, 5.4, 6.2].map((depth) => ({
                x: sampleWall.x - outward.x * depth - outward.y * along * direction,
                y: sampleWall.y - outward.y * depth + outward.x * along * direction,
              })),
            )
            .filter(labGround);
          if (!(await fit(slot, i, [{ side: stair.side, points }], roomShape, "secondary")))
            missing.push("ground/" + slot);
        }
      }
    }
    if (compact && !isGallery && focus && typeof paletteSlots === "object") {
      const stations: Partial<Record<RoomPassport["activity"], string[]>> = {
        containment: ["sampleStation", "labEquipment", "specimenRack", "sampleAux", "equipment"],
        briefing: [
          "analysisConsole",
          "equipment",
          "labBench",
          "wallConsole",
          "bench",
          "siteBanner",
        ],
        sorting: ["supplyRack", "utility", "loading", "cargo", "cargo"],
        power: [
          "pipeBank",
          "plantBank",
          "equipment",
          "utility",
          "console",
          "powerPoint",
          "relayPlatform",
          "powerPoint",
          "powerInlay",
        ],
        garden: [
          "gardenPlant",
          "gardenPlant",
          "bench",
          "tree",
          "pathLight",
          "gardenStatue",
          "gardenStone",
        ],
        plaza: ["gardenPlant", "bench", "pathLight"],
        frontage: ["facade", "sign", "pathLight"],
        ritual: ["brazier", "pillar", "utility"],
      };
      // Fit additional groups against role-specific wall bays and skip occupied approaches.
      const clearGround = ground.map(({ side, points }) => ({
        side,
        points: points.filter(
          (p) =>
            (!upper || labGround(p)) &&
            Math.hypot(p.x - focus.position.x, p.y - focus.position.y) >= 3.2,
        ),
      }));
      if (raisedLab && upperArea && passport.density === "busy") {
        for (const [i, slot] of ["deckUtility", "deckDiagnostic"].entries()) {
          if (paletteSlots[slot]?.length)
            await fit(slot, i, elevated, upperArea, "secondary", paletteSlots[slot]);
        }
      }
      const busyBanks: Partial<Record<RoomPassport["activity"], string[]>> = {
        containment: ["sampleRack", "laboratoryCart", "labEquipment"],
        briefing: ["diagnosticBank", "diagnosticBank", "bench"],
        sorting: ["laboratoryCart", "supplyRack", "cargo"],
        power: ["engineeringRack", "engineeringRack", "plantBank"],
      };
      const selected = [
        ...(stations[passport.activity] ?? []),
        ...(passport.density === "busy" ? (busyBanks[passport.activity] ?? []) : []),
      ];
      for (const [index, key] of selected.entries()) {
        const assets = paletteSlots[key];
        if (!assets?.length) continue;
        const existing = new Set(fitted.map(({ actor }) => actor));
        const choices = [...assets].sort(
          (a, b) => Number(existing.has(a.id)) - Number(existing.has(b.id)),
        );
        await fit(key, index, clearGround, roomShape, "secondary", choices);
      }
    }
    const clearWallRuns = (side: Side) => {
      const span = (facilitySides[side].x ? space.height : space.width) / 2;
      const wall = facilityFace(space, side, 0);
      const gates = space.openings
        .filter((opening) => opening.side === side)
        .map(({ offset, width }) => [offset - width / 2 - 1.2, offset + width / 2 + 1.2])
        .sort(([a], [b]) => a - b);
      const segments: Array<{ length: number; center: Point2 }> = [];
      let cursor = -span + 1.3;
      for (const [start, end] of [...gates, [span - 1.3, span]]) {
        const stop = Math.min(start, span - 1.3);
        if (stop - cursor >= 2.8) {
          const middle = (cursor + stop) / 2;
          segments.push({
            length: stop - cursor,
            center: facilitySides[side].x
              ? { x: wall.x, y: wall.y + middle }
              : { x: wall.x + middle, y: wall.y },
          });
        }
        cursor = Math.max(cursor, end);
      }
      return segments.sort((a, b) => b.length - a.length);
    };
    const banks = recipes.wallBanks?.[passport.tileSet]?.[passport.activity] ?? [];
    const occupiedWalls = new Set<Side>();
    for (const { slot, count, pitch } of banks) {
      for (const side of order) {
        if (occupiedWalls.has(side)) continue;
        let row;
        for (const { length, center } of clearWallRuns(side)) {
          const fitCount = Math.min(count, Math.floor(length / pitch));
          if (fitCount < 2) continue;
          row = await fitWallRow(
            slot,
            side,
            center,
            { span: length, seam: 0.45 },
            [2.1, 2.7, 3.3],
            roomShape,
            {
              counts: Array.from({ length: fitCount - 1 }, (_, i) => fitCount - i),
              ...(upper ? { onFloor: labGround } : {}),
            },
          );
          if (row) break;
        }
        if (row) {
          occupiedWalls.add(side);
          break;
        }
      }
    }
    // Stock Slayn keeps the flame actor on the brazier's own placement pivot.
    if (passport.tileSet === "Slayn" || passport.tileSet === "SlaynTemple") {
      const flame = await measure({ id: "Slayn_Brazier_Fire" });
      if (flame) {
        for (const base of objects.filter(({ catalogId }) => catalogId === "Slayn_Braziers")) {
          objects.push({ ...base, catalogId: flame.actor.id, variation: flame.variation ?? 0 });
        }
      }
    }
    const lightRuns: LightRun[] = [];
    const stairLights: Position3[][] = [];
    const galleryLights: Position3[][] = [];
    if (passport.condition !== "abandoned") {
      const { spacing, edgeOffset, stairSideOffset, upperLandingDepth } = recipes.wayfinding;
      for (const stair of deck?.stairs ?? []) {
        const inward = facilitySides[stair.direction];
        for (const depth of [-2.7, upperLandingDepth]) {
          const pair = await fitLightPair(
            [-stairSideOffset, stairSideOffset].map((edge) => ({
              side: stair.side,
              points: [
                {
                  x: stair.center.x + inward.x * depth - inward.y * edge,
                  y: stair.center.y + inward.y * depth + inward.x * edge,
                },
              ],
            })),
          );
          if (pair) stairLights.push(pair);
        }
      }
      if (deck && !compact) await dressEntryLights();
      objects.push(...entryObjects);
      fitted.push(...entryFixtures);
      const markers = [...stairLights.flat(), ...entryLights.flat()];
      for (const { from, to, width } of lightAisles(space.aisles ?? [])) {
        const dx = to.x - from.x,
          dy = to.y - from.y;
        const length = Math.hypot(dx, dy);
        const galleryAxis =
          isGallery &&
          site &&
          (space.height > space.width
            ? dx === 0 && from.x === space.center.x && length >= space.height - 0.1
            : dy === 0 && from.y === space.center.y && length >= space.width - 0.1);
        const floorHalfWidth = galleryAxis ? Math.min(space.width, space.height) / 2 : width / 2;
        const lightSurface = galleryAxis ? site.area : roomShape;
        const count = 1 + Math.floor((length - 1.6) / spacing);
        if (count < 2) continue;
        const first = (length - (count - 1) * spacing) / 2;
        if (galleryAxis) {
          const edge = floorHalfWidth + edgeOffset;
          for (let i = 0; i < count; i++) {
            const t = (first + i * spacing) / length;
            const axis = { x: from.x + dx * t, y: from.y + dy * t };
            const positions = [-1, 1].map((sign) => ({
              x: axis.x - ((sign * dy) / length) * edge,
              y: axis.y + ((sign * dx) / length) * edge,
            }));
            if (
              positions.some(
                (p) =>
                  Math.abs(pointOnGround(p).z - pointOnGround(axis).z) > 0.18 ||
                  facility.spaces.some(
                    (other) => other !== space && facilitySpaceDistance(other, p) > -0.65,
                  ),
              )
            )
              continue;
            const pair = await fitLightPair(
              positions.map((p) => ({
                side:
                  dx === 0 ? (p.x < axis.x ? "west" : "east") : p.y < axis.y ? "south" : "north",
                points: [p],
              })),
              lightSurface,
            );
            if (pair) galleryLights.push(pair);
          }
          continue;
        }
        for (const edge of [1, -1]) {
          const firstRun = lightRuns.length;
          let positions: Position3[] = [];
          const finishRun = () => {
            if (positions.length >= 2) lightRuns.push({ from, to, side: edge, spacing, positions });
            else if (positions.length === 1) {
              objects.pop();
              footprints.pop();
              fitted.pop();
            }
            positions = [];
          };
          for (let i = 0; i < count; i++) {
            const t = (first + i * spacing) / length;
            const offset = (edge * (floorHalfWidth + edgeOffset)) / length;
            const p = { x: from.x + dx * t - dy * offset, y: from.y + dy * t + dx * offset };
            const z = pointOnGround(p).z;
            const laneHeight = pointOnGround({ x: from.x + dx * t, y: from.y + dy * t }).z;
            const onLanding =
              Math.abs(laneHeight - z) <= 0.18 &&
              [0.45, -0.45].every(
                (shift) =>
                  Math.abs(
                    pointOnGround({
                      x: p.x + (shift * dx) / length,
                      y: p.y + (shift * dy) / length,
                    }).z - z,
                  ) <= 0.18,
              );
            const light =
              onLanding && markers.every((m) => Math.hypot(m.x - p.x, m.y - p.y) >= 1.4)
                ? await fit("pathLight", 0, [{ side: passport.side, points: [p] }], lightSurface)
                : undefined;
            if (light) positions.push(light.position);
            else finishRun();
          }
          finishRun();
          if (lightRuns.length > firstRun) break;
        }
      }
    }
    return {
      objects,
      footprints,
      report: {
        activity: passport.activity,
        condition: passport.condition,
        placement: passport.placement,
        density: passport.density,
        fit: focus ? "placed" : "unfitted",
        ...(workApproach ? { workApproach } : {}),
        ...(secondaryApproach ? { secondaryApproach } : {}),
        lightRuns,
        stairLights,
        entryLights,
        galleryLights,
        ...(postOutline ? { postOutline } : {}),
        ...(postDecal ? { postDecal } : {}),
        fitted,
        missing,
      },
    };
  };
}
