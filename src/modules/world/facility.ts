import * as z from "zod/v4";
import { areaDistance, segmentDistance } from "../terrain/geometry.js";
import type { Point2, TerrainArea } from "../terrain/types.js";
import { cargoBay, cargoBayFixtures } from "./cargo.js";
import {
  roomComposition,
  roomCompositionFixtures,
  workstation,
  workstationFixtures,
} from "./workstations.js";
import type { WorldLayout, WorldSpec } from "./plan.js";

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const point = z
  .object({ x: z.number().int().min(4).max(252), y: z.number().int().min(4).max(252) })
  .strict();
const side = z.enum(["south", "east", "north", "west"]);
const wallFaces = z.enum(["single", "double"]);
const floorJointStyle = z
  .object({
    actor: id,
    width: z.number().min(0.15).max(0.8).default(0.38),
    height: z.number().min(0.03).max(0.18).default(0.08),
    segmentLength: z.number().min(2).max(8).default(4),
  })
  .strict();
const wall = z
  .object({ actor: id, sides: z.array(side).min(1).max(4), faces: wallFaces.optional() })
  .strict();
const perimeterStyle = z
  .object({
    actor: id,
    spacing: z.number().min(2).max(10),
    height: z.number().min(0.5).max(6),
    depth: z.number().min(0.5).max(5),
    faces: wallFaces.default("double"),
  })
  .strict();
const partition = z
  .object({
    from: point,
    to: point,
    actor: id,
    faces: wallFaces.optional(),
    opening: z
      .object({ at: z.number().int(), width: z.number().min(3).max(12) })
      .strict()
      .optional(),
  })
  .strict();
const face = z
  .object({ space: id, side, offset: z.number().int().min(-30).max(30).default(0) })
  .strict();
export const facilityRole = z.enum([
  "entry",
  "courtyard",
  "command",
  "production",
  "storage",
  "lab",
  "landing",
  "organic",
]);

export const worldFacility = z
  .object({
    wallFaces: wallFaces.default("single"),
    terraces: z
      .array(
        z
          .object({
            id,
            min: point,
            max: point,
            kind: z.enum(["accessible", "scenic"]).default("accessible"),
            floor: id.optional(),
            faceActor: id.optional(),
            faceStyle: z.literal("square").optional(),
            stairs: z
              .array(
                z
                  .object({
                    side,
                    at: z.number().int().min(5).max(251),
                    treadActor: id.optional(),
                  })
                  .strict(),
              )
              .max(6)
              .default([]),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    grounds: z
      .object({
        min: point,
        max: point,
        floor: id,
        trim: id.optional(),
        exterior: id,
        perimeter: perimeterStyle.optional(),
        floorJoints: floorJointStyle.optional(),
      })
      .strict()
      .optional(),
    spaces: z
      .array(
        z
          .object({
            id,
            role: facilityRole,
            center: point,
            width: z.number().int().multipleOf(2).min(8).max(64),
            height: z.number().int().multipleOf(2).min(8).max(64),
            shape: z.enum(["rectangle", "ellipse"]).default("rectangle"),
            floor: id,
            trim: id.optional(),
            blend: z.number().min(0).max(4).default(0),
            inlays: z
              .array(
                z
                  .object({
                    min: point,
                    max: point,
                    floor: id,
                  })
                  .strict(),
              )
              .max(12)
              .default([]),
            walls: wall.optional(),
            partitions: z.array(partition).max(12).default([]),
            cargoBays: z.array(cargoBay).max(4).optional(),
            workstations: z.array(workstation).max(8).optional(),
            roomComposition: roomComposition.optional(),
            aisles: z
              .array(
                z
                  .object({
                    from: point,
                    to: point,
                    width: z.number().min(2).max(12),
                  })
                  .strict(),
              )
              .max(16)
              .optional(),
            fixtures: z
              .array(
                z
                  .object({
                    actor: id,
                    side,
                    count: z.number().int().min(1).max(12),
                    inset: z.number().min(1).max(14).default(2),
                    spacing: z.number().min(1).max(14),
                    offset: z.number().min(-24).max(24).default(0),
                    rotation: z.number().min(-360).max(360).optional(),
                    adaptive: z.literal(true).optional(),
                    scale: z.number().min(0.5).max(2).optional(),
                  })
                  .strict(),
              )
              .max(24)
              .default([]),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    passages: z
      .array(
        z
          .object({
            id,
            from: face,
            to: face.optional(),
            waypoints: z.array(point).max(8).default([]),
            width: z.number().min(3).max(14),
            floor: id,
            trim: id.optional(),
            threshold: id.optional(),
            jamb: id.optional(),
          })
          .strict(),
      )
      .max(32)
      .default([]),
  })
  .strict();

type Facility = z.infer<typeof worldFacility>;
type Face = z.infer<typeof face>;
type Side = z.infer<typeof side>;
type Space = Facility["spaces"][number];
type Rect = Extract<TerrainArea, { type: "rectangle" }>;

export const facilitySides = {
  south: { x: 0, y: -1 },
  east: { x: 1, y: 0 },
  north: { x: 0, y: 1 },
  west: { x: -1, y: 0 },
} as const;
const opposite = { north: "south", south: "north", east: "west", west: "east" } as const;

export function partitionSpans(p: z.infer<typeof partition>) {
  const axis = p.from.x === p.to.x ? "y" : "x";
  const start = Math.min(p.from[axis], p.to[axis]),
    end = Math.max(p.from[axis], p.to[axis]);
  const half = (p.opening?.width ?? 0) / 2;
  return p.opening
    ? [
        [start, p.opening.at - half],
        [p.opening.at + half, end],
      ]
    : [[start, end]];
}

export function partitionDistance(p: z.infer<typeof partition>, point: Point2) {
  const axis = p.from.x === p.to.x ? "y" : "x";
  return Math.min(
    ...partitionSpans(p).map(([a, b]) =>
      segmentDistance(point, { ...p.from, [axis]: a }, { ...p.from, [axis]: b }),
    ),
  );
}

type Stair = Facility["terraces"][number]["stairs"][number] & { center: Point2; direction: Side };
type Terrace = {
  id: string;
  zone: string;
  bank: number;
  area: Rect;
  floor?: string;
  faceActor?: string;
  faceStyle?: "square";
  stairs: Stair[];
};
type Perimeter = z.infer<typeof perimeterStyle>;
export function terraceFace(area: Rect, side: Side) {
  const vertical = Boolean(facilitySides[side].x);
  const fixed =
    side === "south"
      ? area.minY
      : side === "north"
        ? area.maxY
        : side === "west"
          ? area.minX
          : area.maxX;
  return {
    vertical,
    fixed,
    from: vertical ? area.minY : area.minX,
    to: vertical ? area.maxY : area.maxX,
  };
}

type BoundaryRoute = { points: Point2[]; halfWidthAt: (point: Point2) => number };
export function facilityPerimeter(area: Rect, style: Perimeter, paths: BoundaryRoute[]) {
  return side.options.map((name) => {
    const face = terraceFace(area, name);
    const fixed = face.vertical ? "x" : "y",
      along = face.vertical ? "y" : "x";
    const gates: { from: number; to: number }[] = [];
    for (const path of paths)
      for (let i = 1; i < path.points.length; i++) {
        const a = path.points[i - 1],
          b = path.points[i];
        const perpendicular = b[fixed] - a[fixed];
        if (!perpendicular) continue;
        const fraction = (face.fixed - a[fixed]) / perpendicular;
        if (fraction < 0 || fraction > 1) continue;
        const at = a[along] + (b[along] - a[along]) * fraction;
        if (at < face.from || at > face.to) continue;
        const p = { ...a, [fixed]: face.fixed, [along]: at };
        const half =
          ((path.halfWidthAt(p) + 0.45) * Math.hypot(b.x - a.x, b.y - a.y)) /
          Math.abs(perpendicular);
        gates.push({ from: Math.max(face.from, at - half), to: Math.min(face.to, at + half) });
      }
    gates.sort((a, b) => a.from - b.from);
    const spans: { from: number; to: number }[] = [];
    let start = face.from;
    for (const gate of [...gates, { from: face.to, to: face.to }]) {
      if (gate.from > start) spans.push({ from: start, to: gate.from });
      start = Math.max(start, gate.to);
    }
    return { ...face, side: name, style, spans };
  });
}

export function perimeterBlocks(
  perimeter: ReturnType<typeof facilityPerimeter>[number],
  p: Point2,
  clearance = 0,
) {
  const axis = perimeter.vertical ? p.x : p.y;
  const along = perimeter.vertical ? p.y : p.x;
  return (
    Math.abs(axis - perimeter.fixed) <= perimeter.style.depth / 2 + clearance &&
    perimeter.spans.some(({ from, to }) => along >= from - clearance && along <= to + clearance)
  );
}

export function onFacilityStair(stair: Stair, p: Point2, clearance = 0) {
  const vertical = Boolean(facilitySides[stair.side].x);
  return (
    Math.abs(p[vertical ? "y" : "x"] - stair.at) < 2 + clearance &&
    Math.abs(p[vertical ? "x" : "y"] - stair.center[vertical ? "x" : "y"]) <= 3 + clearance
  );
}

export function facilityTerraceBlocks(terrace: Terrace, p: Point2) {
  return (
    Math.abs(areaDistance(terrace.area, p)) <= 1 &&
    !terrace.stairs.some((stair) => onFacilityStair(stair, p))
  );
}

export function facilityFace(space: Space, side: Side, offset: number): Point2 {
  const outward = facilitySides[side];
  return {
    x: space.center.x + (outward.x * space.width) / 2 + (outward.x ? 0 : offset),
    y: space.center.y + (outward.y * space.height) / 2 + (outward.y ? 0 : offset),
  };
}

export function facilitySpaceDistance(space: Space, p: Point2) {
  return space.shape === "ellipse"
    ? ((1 -
        Math.hypot(
          (2 * (p.x - space.center.x)) / space.width,
          (2 * (p.y - space.center.y)) / space.height,
        )) *
        Math.min(space.width, space.height)) /
        2
    : Math.min(
        space.width / 2 - Math.abs(p.x - space.center.x),
        space.height / 2 - Math.abs(p.y - space.center.y),
      );
}

type Opening = { offset: number; width: number; side: Side };
type FacilitySpace = Space & {
  zone: string;
  bank: number;
  openings: Opening[];
  defaultWallFaces: z.infer<typeof wallFaces>;
};
type Port = { space: FacilitySpace; point: Point2; side: Side };
type Passage = Facility["passages"][number] & {
  zone: string;
  bank: number;
  points: Point2[];
  ports: Port[];
  parts: Extract<TerrainArea, { type: "rectangle" }>[];
};

export function planFacilities(spec: WorldSpec, layout: WorldLayout) {
  const terraces: Terrace[] = [];
  const spaces: FacilitySpace[] = [],
    passages: Passage[] = [];
  const grounds: {
    zone: string;
    bank: number;
    area: Extract<TerrainArea, { type: "rectangle" }>;
    floor: string;
    trim?: string;
    exterior: string;
    perimeter?: Perimeter;
    floorJoints?: z.infer<typeof floorJointStyle>;
  }[] = [];
  const width = spec.width / 8;
  const ownerBank = (p: Point2) =>
    layout.zones[layout.blocks[Math.floor(p.y / 8) * width + Math.floor(p.x / 8)]]?.bank;
  const assertSurface = (p: Point2, bank: number, label: string) => {
    if (
      p.x < 2 ||
      p.y < 2 ||
      p.x > spec.width - 2 ||
      p.y > spec.height - 2 ||
      ownerBank(p) !== bank
    )
      throw Error("WORLD_FACILITY_OUTSIDE_PALETTE: " + label);
  };
  for (const zone of layout.zones) {
    const base = zone.facility;
    if (!base) continue;
    if (spec.mode !== "mission" || zone.room || zone.walls || zone.wallActor)
      throw Error("WORLD_FACILITY_REQUIRES_MISSION_AND_OWN_LAYOUT: " + zone.id);
    const terraceIds = new Set<string>();
    for (const t of base.terraces) {
      if (terraceIds.has(t.id)) throw Error("WORLD_FACILITY_DUPLICATE_TERRACE: " + t.id);
      terraceIds.add(t.id);
      if ((t.kind === "accessible") !== t.stairs.length > 0)
        throw Error("WORLD_FACILITY_TERRACE_ACCESS: " + t.id);
      const area = {
        type: "rectangle" as const,
        minX: t.min.x,
        minY: t.min.y,
        maxX: t.max.x,
        maxY: t.max.y,
      };
      if (
        area.maxX - area.minX < (t.kind === "scenic" ? 6 : 8) ||
        area.maxY - area.minY < (t.kind === "scenic" ? 6 : 8) ||
        [area.minX, area.minY, area.maxX, area.maxY].some((n) => n % 2) ||
        terraces.some(
          (other) =>
            area.minX < other.area.maxX + 4 &&
            area.maxX > other.area.minX - 4 &&
            area.minY < other.area.maxY + 4 &&
            area.maxY > other.area.minY - 4,
        )
      )
        throw Error("WORLD_FACILITY_TERRACE_GRID_OR_CLEARANCE: " + t.id);
      for (let y = area.minY - 2; y <= area.maxY + 2; y += 2)
        for (let x = area.minX - 2; x <= area.maxX + 2; x += 2)
          assertSurface({ x, y }, zone.bank, t.id);
      const stairs: Stair[] = [];
      for (const stair of t.stairs) {
        const face = terraceFace(area, stair.side);
        if (stair.at % 2 !== 1 || stair.at - face.from < 5 || face.to - stair.at < 5)
          throw Error("WORLD_FACILITY_STAIR_GRID: " + t.id);
        const fixed = face.fixed + (stair.side === "west" || stair.side === "south" ? -2 : 2);
        const center = face.vertical ? { x: fixed, y: stair.at } : { x: stair.at, y: fixed };
        const resolved: Stair = { ...stair, direction: opposite[stair.side], center };
        if (
          center.x < 5 ||
          center.y < 5 ||
          center.x > spec.width - 5 ||
          center.y > spec.height - 5 ||
          [...stairs, ...terraces.flatMap((other) => other.stairs)].some(
            (other) =>
              Math.abs(other.center.x - center.x) <= 5 && Math.abs(other.center.y - center.y) <= 5,
          )
        )
          throw Error("WORLD_FACILITY_STAIR_CLEARANCE: " + t.id);
        assertSurface(
          {
            x: center.x + 4 * facilitySides[stair.side].x,
            y: center.y + 4 * facilitySides[stair.side].y,
          },
          zone.bank,
          t.id,
        );
        stairs.push(resolved);
      }
      terraces.push({
        id: t.id,
        zone: zone.id,
        bank: zone.bank,
        area,
        floor: t.floor,
        faceActor: t.faceActor,
        ...(t.faceStyle ? { faceStyle: t.faceStyle } : {}),
        stairs,
      });
    }
    const site = base.grounds;
    if (site) {
      if (site.min.x >= site.max.x || site.min.y >= site.max.y)
        throw Error("WORLD_FACILITY_INVALID_GROUNDS: " + zone.id);
      const area = {
        type: "rectangle" as const,
        minX: site.min.x,
        minY: site.min.y,
        maxX: site.max.x,
        maxY: site.max.y,
      };
      for (let y = area.minY; y <= area.maxY; y++)
        for (let x = area.minX; x <= area.maxX; x++)
          assertSurface({ x, y }, zone.bank, zone.id + "/grounds");
      if (
        grounds.some(
          (other) =>
            area.minX < other.area.maxX &&
            area.maxX > other.area.minX &&
            area.minY < other.area.maxY &&
            area.maxY > other.area.minY,
        )
      )
        throw Error("WORLD_FACILITY_OVERLAPPING_GROUNDS: " + zone.id);
      grounds.push({
        zone: zone.id,
        bank: zone.bank,
        floor: site.floor,
        trim: site.trim,
        exterior: site.exterior,
        perimeter: site.perimeter,
        floorJoints: site.floorJoints,
        area,
      });
    }
    const byId = new Map<string, FacilitySpace>();
    for (const part of base.spaces) {
      if (byId.has(part.id)) throw Error("WORLD_FACILITY_DUPLICATE_SPACE: " + part.id);
      if (
        part.walls &&
        (part.shape === "ellipse" || new Set(part.walls.sides).size !== part.walls.sides.length)
      )
        throw Error("WORLD_FACILITY_INVALID_WALL_SIDES: " + part.id);
      if (part.roomComposition && part.workstations?.length)
        throw Error("WORLD_FACILITY_MIXED_WORKSTATION_LAYOUT: " + part.id);
      const space: FacilitySpace = {
        ...part,
        fixtures: [
          ...part.fixtures,
          ...(part.cargoBays ?? []).flatMap((bay) => cargoBayFixtures(part, bay)),
          ...(part.workstations ?? []).flatMap((station) => workstationFixtures(part, station)),
          ...(part.roomComposition && "focus" in part.roomComposition
            ? roomCompositionFixtures(part, part.roomComposition)
            : []),
        ],
        zone: zone.id,
        bank: zone.bank,
        openings: [],
        defaultWallFaces: base.wallFaces,
      };
      for (const { from, to } of part.aisles ?? []) {
        if (
          (from.x === to.x && from.y === to.y) ||
          [from, to].some((p) => facilitySpaceDistance(space, p) < 0)
        )
          throw Error("WORLD_FACILITY_INVALID_AISLE: " + part.id);
      }
      for (const p of part.partitions) {
        if (
          part.shape !== "rectangle" ||
          (p.from.x === p.to.x) === (p.from.y === p.to.y) ||
          [p.from, p.to].some((v) => facilitySpaceDistance(space, v) < 1.5) ||
          partitionSpans(p).some(([from, to]) => to - from < 1)
        )
          throw Error("WORLD_FACILITY_INVALID_PARTITION: " + part.id);
      }
      for (const { min, max } of part.inlays) {
        if (
          min.x >= max.x ||
          min.y >= max.y ||
          [min, max, { x: min.x, y: max.y }, { x: max.x, y: min.y }].some(
            (p) => facilitySpaceDistance(space, p) < 1.5,
          )
        )
          throw Error("WORLD_FACILITY_INVALID_INLAY: " + part.id);
      }
      if (
        site &&
        (part.center.x - part.width / 2 < site.min.x ||
          part.center.x + part.width / 2 > site.max.x ||
          part.center.y - part.height / 2 < site.min.y ||
          part.center.y + part.height / 2 > site.max.y)
      )
        throw Error("WORLD_FACILITY_SPACE_OUTSIDE_GROUNDS: " + part.id);
      for (const other of spaces)
        if (
          Math.abs(other.center.x - space.center.x) < (other.width + space.width) / 2 + 2 &&
          Math.abs(other.center.y - space.center.y) < (other.height + space.height) / 2 + 2
        )
          throw Error("WORLD_FACILITY_SPACE_OVERLAP: " + other.id + "/" + space.id);
      for (let y = part.center.y - part.height / 2; y <= part.center.y + part.height / 2; y++)
        for (let x = part.center.x - part.width / 2; x <= part.center.x + part.width / 2; x++)
          if (facilitySpaceDistance(space, { x, y }) >= 0)
            assertSurface({ x, y }, zone.bank, space.id);
      byId.set(space.id, space);
      spaces.push(space);
    }
    const ids = new Set<string>();
    for (const link of base.passages) {
      if (ids.has(link.id)) throw Error("WORLD_FACILITY_DUPLICATE_PASSAGE: " + link.id);
      ids.add(link.id);
      const faces = link.to ? [link.from, link.to] : [link.from];
      const ports = faces.map((f: Face) => {
        const space = byId.get(f.space);
        if (
          !space ||
          space.shape !== "rectangle" ||
          Math.abs(f.offset) + link.width / 2 + (link.jamb ? 2 : 0.5) >=
            (facilitySides[f.side].x ? space.height : space.width) / 2 ||
          space.openings.some(
            (other) =>
              other.side === f.side &&
              Math.abs(other.offset - f.offset) < (other.width + link.width) / 2 + 1,
          )
        )
          throw Error("WORLD_FACILITY_BAD_GATE: " + link.id + "/" + f.space);
        space.openings.push({ offset: f.offset, width: link.width, side: f.side });
        return { space, side: f.side, point: facilityFace(space, f.side, f.offset) };
      });
      const points = [
        ports[0].point,
        ...link.waypoints,
        ...ports.slice(1).map((port) => port.point),
      ];
      const outside = ({ point, side }: Port, next: Point2) =>
        (next.x - point.x) * facilitySides[side].x + (next.y - point.y) * facilitySides[side].y > 0;
      if (
        ports[0].space === ports[1]?.space ||
        points.length < 2 ||
        !outside(ports[0], points[1]) ||
        (ports[1] && !outside(ports[1], points.at(-2)!))
      )
        throw Error("WORLD_FACILITY_PASSAGE_DIRECTION: " + link.id);
      const parts: Passage["parts"] = [];
      for (const [i, a] of points.slice(0, -1).entries()) {
        const b = points[i + 1];
        if ((a.x === b.x) === (a.y === b.y))
          throw Error("WORLD_FACILITY_ORTHOGONAL_PASSAGE: " + link.id);
        const half = link.width / 2;
        const insetA = i === 0 ? 0 : half;
        const insetB = i === points.length - 2 ? 0 : half;
        const area = {
          type: "rectangle" as const,
          minX: Math.min(a.x, b.x) - (a.x === b.x ? half : a.x < b.x ? insetA : insetB),
          maxX: Math.max(a.x, b.x) + (a.x === b.x ? half : a.x < b.x ? insetB : insetA),
          minY: Math.min(a.y, b.y) - (a.y === b.y ? half : a.y < b.y ? insetA : insetB),
          maxY: Math.max(a.y, b.y) + (a.y === b.y ? half : a.y < b.y ? insetB : insetA),
        };
        parts.push(area);
        for (let y = area.minY; y <= area.maxY; y += 0.5)
          for (let x = area.minX; x <= area.maxX; x += 0.5) {
            const p = { x, y };
            assertSurface(p, zone.bank, link.id);
            for (const space of spaces)
              if (facilitySpaceDistance(space, p) > 0)
                throw Error("WORLD_FACILITY_PASSAGE_CROSSES_SPACE: " + link.id + "/" + space.id);
          }
      }
      passages.push({ ...link, zone: zone.id, bank: zone.bank, ports, points, parts });
    }
  }
  for (const space of spaces) {
    const passport = space.roomComposition;
    if (!passport || !("activity" in passport)) continue;
    const stairs = terraces
      .filter(
        (t) =>
          t.zone === space.zone &&
          facilitySpaceDistance(space, { x: t.area.minX, y: t.area.minY }) >= 0 &&
          facilitySpaceDistance(space, { x: t.area.maxX, y: t.area.maxY }) >= 0,
      )
      .flatMap((t) => t.stairs);
    if (passport.placement === "upper" && !stairs.length)
      throw Error("WORLD_ROOM_UPPER_REQUIRES_STAIRS: " + space.id);
    const aisles = [...(space.aisles ?? [])];
    const add = (from: Point2, to: Point2, width = passport.aisleWidth) => {
      if (from.x !== to.x || from.y !== to.y) aisles.push({ from, to, width });
    };
    const corridor = passport.activity === "circulation";
    const vertical = space.height > space.width;
    const first = space.openings[0];
    const hub = { ...space.center };
    if (space.openings.length === 1 && !stairs.length) {
      const normal = facilitySides[first.side];
      hub.x += normal.x * 3;
      hub.y += normal.y * 3;
    }
    if (corridor) {
      const from = facilityFace(space, vertical ? "south" : "west", 0);
      const to = facilityFace(space, vertical ? "north" : "east", 0);
      add(from, to);
    }
    const automatic = !space.aisles?.length || corridor;
    for (const opening of space.openings) {
      const from = facilityFace(space, opening.side, opening.offset);
      const normal = facilitySides[opening.side];
      const landing = corridor ? 2 : 4;
      const throat = { x: from.x - normal.x * landing, y: from.y - normal.y * landing };
      const width = Math.min(passport.aisleWidth, opening.width);
      add(from, throat, width);
      if (automatic)
        add(
          throat,
          corridor ? (vertical ? { x: hub.x, y: throat.y } : { x: throat.x, y: hub.y }) : hub,
          width,
        );
    }
    for (const stair of stairs) {
      const normal = facilitySides[stair.direction];
      if (automatic) add(hub, stair.center);
      add(stair.center, { x: stair.center.x + normal.x * 5, y: stair.center.y + normal.y * 5 }, 4);
    }
    space.aisles = aisles;
  }
  for (const pass of passages)
    for (const space of spaces) {
      if (space.zone === pass.zone) continue;
      for (let y = space.center.y - space.height / 2; y <= space.center.y + space.height / 2; y++)
        for (let x = space.center.x - space.width / 2; x <= space.center.x + space.width / 2; x++)
          if (
            facilitySpaceDistance(space, { x, y }) > 0 &&
            facilityPassageDistance(pass, { x, y }) < 0
          )
            throw Error("WORLD_FACILITY_PASSAGE_CROSSES_SPACE: " + pass.id + "/" + space.id);
    }
  return { spaces, passages, grounds, terraces };
}

export type FacilityLayout = ReturnType<typeof planFacilities>;

export function facilityRimBlocks(space: FacilitySpace, point: Point2) {
  if (space.partitions.some((part) => partitionDistance(part, point) <= 0.51)) return true;
  if (!space.walls || Math.abs(facilitySpaceDistance(space, point)) > 0.5) return false;
  return space.walls.sides.some((side) => {
    const normal = facilitySides[side];
    const wall = facilityFace(space, side, 0);
    const fixed = normal.x ? "x" : "y",
      along = normal.x ? "y" : "x";
    const offset = point[along] - space.center[along];
    return (
      Math.abs(point[fixed] - wall[fixed]) <= 0.5 &&
      !space.openings.some((o) => o.side === side && Math.abs(o.offset - offset) < o.width / 2)
    );
  });
}

export function facilityPassageDistance(passage: Passage, point: Point2) {
  let edge = -Infinity;
  for (const part of passage.parts) edge = Math.max(edge, areaDistance(part, point));
  return -edge;
}
