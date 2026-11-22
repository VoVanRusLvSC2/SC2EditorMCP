import {
  bridgeAxis,
  routeEdgeDistance,
  seedFor,
  smoothstep,
  type WorldLayout,
  type WorldSpec,
} from "./plan.js";
import type { PlacementObject, Position3 } from "../placement/types.js";
import type { GuiRequest, GuiValue } from "../trigger/authoring.js";
import type { Point2, TerrainOperation } from "../terrain/types.js";
import type { DecorPalette } from "../placement/decorPalette.js";
import { areaDistance, segmentDistance, valueNoise } from "../terrain/geometry.js";
import type { FloorJoint } from "./floorJoints.js";
import {
  facilityFace,
  facilityPassageDistance,
  facilityPerimeter,
  facilityRimBlocks,
  facilitySides,
  facilitySpaceDistance,
  facilityTerraceBlocks,
  onFacilityStair,
  partitionDistance,
  partitionSpans,
  perimeterBlocks,
  planFacilities,
  terraceFace,
} from "./facility.js";

const riverHeight = 3.2;

export function structureLayout(spec: WorldSpec, layout: WorldLayout) {
  const facility = planFacilities(spec, layout);
  const perimeter = facility.grounds.flatMap((ground) =>
    ground.perimeter
      ? facilityPerimeter(ground.area, ground.perimeter, [
          ...layout.routes.map((route) => ({
            points: route.points,
            halfWidthAt: (p: Point2) => -routeEdgeDistance(p, route),
          })),
          ...facility.passages
            .filter((pass) => pass.zone === ground.zone)
            .map((pass) => ({ points: pass.points, halfWidthAt: () => pass.width / 2 })),
        ]).map((edge) => ({ ...edge, zone: ground.zone }))
      : [],
  );
  const crossings = layout.routes
    .filter((r) => r.kind === "bridge")
    .map((route) => {
      const [a, b] = route.points;
      const { alongY, start } = bridgeAxis(route.points, route.bankStart);
      const across = alongY ? spec.height : spec.width;
      if (start < 8 || start + 8 > across - 8) throw Error("WORLD_BRIDGE_LANDINGS_OUT_OF_BOUNDS");
      const aAxis = alongY ? a.y : a.x;
      const bAxis = alongY ? b.y : b.x;
      if (
        route.bankStart !== undefined &&
        (Math.min(aAxis, bAxis) > start - 4 || Math.max(aAxis, bAxis) < start + 12)
      )
        throw Error("WORLD_BRIDGE_LANDINGS_DO_NOT_REACH_BANKS");
      const coord = (start + 4 - aAxis) / (bAxis - aAxis);
      const x = a.x + (b.x - a.x) * coord,
        y = a.y + (b.y - a.y) * coord;
      const engineered =
        layout.zones.find((z) => z.id === route.to)!.biome === "engineered" ? b : a;
      const builtSide = (alongY ? engineered.y : engineered.x) > start ? 1 : -1;
      return {
        route,
        alongY,
        start,
        center: { x, y },
        builtSide,
        seed: seedFor(spec.seed, route.from + "/shore"),
      };
    });
  const chambers = layout.zones
    .filter(
      (z) =>
        z.biome === "engineered" &&
        (z.walls ||
          z.room ||
          z.wallActor ||
          layout.routes.some((r) => r.kind === "door" && (r.from === z.id || r.to === z.id))),
    )
    .map((z) => {
      const seed =
        spec.mode === "ladder"
          ? layout.zones.find(
              (t) =>
                t.id === z.id ||
                (t.center.x + z.center.x === spec.width && t.center.y + z.center.y === spec.height),
            )!.terrainSeed
          : z.terrainSeed;
      const half = 5 + Math.abs(seed % 4),
        c = z.center,
        hx = z.room ? z.room.width / 2 : half,
        hy = z.room ? z.room.height / 2 : half;
      if (
        z.room &&
        (c.x - hx < 4 || c.x + hx > spec.width - 4 || c.y - hy < 4 || c.y + hy > spec.height - 4)
      )
        throw Error("WORLD_ROOM_OUT_OF_BOUNDS: " + z.id);
      const gates = layout.routes
        .filter((r) => r.from === z.id || r.to === z.id)
        .map((r) => {
          const dest = r.points[r.from === z.id ? 1 : r.points.length - 2];
          const dx = dest.x - c.x,
            dy = dest.y - c.y,
            scale = Math.min(hx / Math.abs(dx), hy / Math.abs(dy));
          const vertical = Math.abs(dx) / hx > Math.abs(dy) / hy;
          const doorActor = r.kind === "door" ? z.room?.doorActor : undefined;
          return {
            x: Math.round(c.x + scale * dx),
            y: Math.round(c.y + scale * dy),
            vertical,
            door: r.kind === "door",
            width: r.kind === "door" && !doorActor ? 2 : r.width,
            doorActor,
          };
        });
      return { id: z.id, c, hx, hy, gates, wallActor: z.wallActor, room: z.room, bank: z.bank };
    });
  const columns = spec.width / 8;
  for (const [i, room] of chambers.entries()) {
    for (const other of chambers.slice(i + 1)) {
      if (
        (room.room || other.room) &&
        Math.abs(other.c.x - room.c.x) <= other.hx + room.hx &&
        Math.abs(other.c.y - room.c.y) <= other.hy + room.hy
      )
        throw Error("WORLD_ROOM_OVERLAP: " + room.id + "/" + other.id);
    }
    if (!room.room) continue;
    for (
      let y = Math.floor((room.c.y - room.hy) / 8);
      y <= Math.floor((room.c.y + room.hy) / 8);
      y++
    )
      for (
        let x = Math.floor((room.c.x - room.hx) / 8);
        x <= Math.floor((room.c.x + room.hx) / 8);
        x++
      )
        if (layout.zones[layout.blocks[y * columns + x]].bank !== room.bank)
          throw Error("WORLD_ROOM_PALETTE_BOUNDARY: " + room.id);
  }
  for (const r of layout.routes.filter((r) => r.kind === "door"))
    if (!chambers.some((c) => c.id === r.from || c.id === r.to))
      throw Error("WORLD_DOOR_REQUIRES_ROOM");
  for (const b of crossings)
    for (const z of layout.zones) {
      const axis = b.alongY ? z.center.y : z.center.x;
      if (axis >= b.start - 3 && axis <= b.start + 11)
        throw Error("WORLD_RIVER_OVERLAPS_ZONE_CENTER: " + z.id);
    }
  const embankments = crossings
    .filter((b) => b.route.raisedBank)
    .map((b) => {
      const to = layout.zones.find((z) => z.id === b.route.to)!;
      const from = layout.zones.find((z) => z.id === b.route.from)!;
      const target = to.biome === "engineered" ? to : from;
      const axis = b.alongY ? "y" : "x",
        lateral = b.alongY ? "x" : "y";
      const high = target.center[axis] > b.start;
      const inland = high ? 1 : -1;
      const shoreEdge = high ? b.start + 8 : b.start;
      const compact = b.route.bankRise === 2;
      const framedSingle = !compact && !!b.route.bankWallActor;
      const edge = shoreEdge + inland * (compact ? 2 : framedSingle ? 0 : 4);
      const across = b.alongY ? spec.height : spec.width;
      const center = {
        ...b.center,
        [axis]: edge + (high ? -2 : 2),
        [lateral]: 2 * Math.floor(b.center[lateral] / 2) + 1,
      };
      const [a, d] = b.route.points;
      const sideMargin = compact ? 9 : 6;
      if (
        (high ? to : from).biome === (high ? from : to).biome ||
        edge < 8 ||
        edge > across - 8 ||
        Math.abs(a[lateral] - d[lateral]) > 1 ||
        center[lateral] < sideMargin ||
        center[lateral] >= (b.alongY ? spec.width : spec.height) - sideMargin
      )
        throw Error("WORLD_RAISED_BANK_REQUIRES_ALIGNED_BRIDGE");
      const opening = center[lateral];
      const cutout = Math.max(5, b.route.width / 2 + 2.5);
      const left = Math.floor((opening - cutout) / 2) * 2;
      const right = Math.ceil((opening + cutout) / 2) * 2;
      const limit = b.alongY ? spec.width : spec.height;
      const rectangle = (
        alongMin: number,
        alongMax: number,
        acrossMin: number,
        acrossMax: number,
      ) =>
        b.alongY
          ? {
              type: "rectangle" as const,
              minX: alongMin,
              minY: acrossMin,
              maxX: alongMax,
              maxY: acrossMax,
            }
          : {
              type: "rectangle" as const,
              minX: acrossMin,
              minY: alongMin,
              maxX: acrossMax,
              maxY: alongMax,
            };
      // Keep a short ramp landing in the center. The side faces are projected
      // toward the water together so the structure reads as one double ledge.
      const steps = Array.from({ length: b.route.bankRise ?? 1 }, (_, i) => {
        const front = edge + inland * i * 6;
        const face = compact ? shoreEdge + inland * i * 4 : front;
        const margin = 2 + i * 4;
        const min = high ? front : margin;
        const max = high ? across - margin : front;
        const area = rectangle(margin, limit - margin, min, max);
        const shoulder = compact ? i * 2 : 0;
        const spans = [
          [margin, left - shoulder],
          [right + shoulder, limit - margin],
        ].filter(([from, to]) => to - from >= 2);
        const wings = compact
          ? spans.map(([from, to]) =>
              rectangle(from, to, Math.min(face, front), Math.max(face, front)),
            )
          : [];
        const ramp = { ...center, [axis]: front - inland * 2 };
        return { area, center: ramp, level: 2 + i, wings, face, spans };
      });
      const upper = steps.at(-1)!.area;
      if (upper.maxX - upper.minX < 4 || upper.maxY - upper.minY < 4)
        throw Error("WORLD_RAISED_BANK_OUT_OF_BOUNDS");
      for (const room of chambers) {
        if (
          room.c.x - room.hx < upper.minX + 2 ||
          room.c.x + room.hx > upper.maxX - 2 ||
          room.c.y - room.hy < upper.minY + 2 ||
          room.c.y + room.hy > upper.maxY - 2
        )
          throw Error("WORLD_ROOM_OVERLAPS_EMBANKMENT_EDGE: " + room.id);
      }
      const direction = b.alongY ? (high ? "north" : "south") : high ? "east" : "west";
      const shoreline = b.route.bankWallActor
        ? {
            actor: b.route.bankWallActor,
            alongY: b.alongY,
            inland,
            edge: shoreEdge,
            opening: b.center[lateral],
            halfWidth: b.route.width / 2 + 0.85,
            framedSingle,
            limit: b.alongY ? spec.width : spec.height,
          }
        : undefined;
      const cliffActors = [...new Set(b.route.bankCliffActors ?? [])];
      return {
        area: steps[0].area,
        center: steps[0].center,
        steps,
        direction,
        zone: target.id,
        shoreline,
        cliffActors,
        lift: b.route.bankLift ?? 0,
        alongY: b.alongY,
        inland,
        compact,
      };
    });
  if (embankments.length > 1) throw Error("WORLD_RAISED_BANK_LIMIT");
  const landmarks = layout.zones.flatMap((zone) =>
    zone.landmark
      ? [
          {
            actor: zone.landmark.actor,
            ...(zone.landmark.variation === undefined
              ? {}
              : { variation: zone.landmark.variation }),
            x: zone.center.x + zone.landmark.offset.x,
            y: zone.center.y + zone.landmark.offset.y,
          },
        ]
      : [],
  );
  const edges = layout.zones.flatMap((zone) =>
    (zone.composition?.edges ?? []).flatMap((run) =>
      run.points.slice(1).map((to, i) => {
        const from = run.points[i];
        const vertical = from.x === to.x;
        const ledge = run.ledge ?? 0;
        const minX = Math.min(from.x, to.x),
          maxX = Math.max(from.x, to.x);
        const minY = Math.min(from.y, to.y),
          maxY = Math.max(from.y, to.y);
        const area = ledge
          ? {
              type: "rectangle" as const,
              minX: vertical ? minX + Math.min(0, ledge) : minX,
              maxX: vertical ? maxX + Math.max(0, ledge) : maxX,
              minY: vertical ? minY : minY + Math.min(0, ledge),
              maxY: vertical ? maxY : maxY + Math.max(0, ledge),
            }
          : undefined;
        if (area)
          for (let y = area.minY; y <= area.maxY; y += 1)
            for (let x = area.minX; x <= area.maxX; x += 1)
              if (layout.routes.some((route) => routeEdgeDistance({ x, y }, route) < 2))
                throw Error("WORLD_EDGE_LEDGE_OVERLAPS_ROUTE: " + zone.id);
        return {
          zone: zone.id,
          from,
          to,
          area,
          actor: run.actor,
          spacing: run.spacing,
          height: run.height,
          depth: run.depth,
          roughness: run.roughness ?? 0,
          seed: seedFor(spec.seed, zone.id + "/edge/" + from.x + "/" + from.y),
          ledge,
        };
      }),
    ),
  );
  for (const space of facility.spaces) {
    for (const part of space.partitions)
      for (const t of facility.terraces)
        for (const [a, b] of partitionSpans(part)) {
          const vertical = part.from.x === part.to.x;
          for (let along = a; along <= b; along += 0.5) {
            const point = vertical ? { x: part.from.x, y: along } : { x: along, y: part.from.y };
            if (
              Math.abs(areaDistance(t.area, point)) < 2 ||
              t.stairs.some((stair) => onFacilityStair(stair, point, 1))
            )
              throw Error("WORLD_FACILITY_PARTITION_ON_TERRACE_EDGE: " + space.id + "/" + t.id);
          }
        }
    for (let y = space.center.y - space.height / 2; y <= space.center.y + space.height / 2; y++)
      for (let x = space.center.x - space.width / 2; x <= space.center.x + space.width / 2; x++) {
        const point = { x, y };
        if (facilitySpaceDistance(space, point) < 0) continue;
        if (
          chambers.some((room) => roomDistance(room, x, y) <= 1) ||
          edges.some((edge) => edge.area && areaDistance(edge.area, point) >= 0) ||
          crossings.some((b) => {
            const axis = b.alongY ? y : x;
            const across = b.alongY ? x : y;
            return Math.abs(axis - b.start - 4) <= shorelineWidth(b, across);
          })
        )
          throw Error("WORLD_FACILITY_SURFACE_CONFLICT: " + space.id);
        if (
          facilityRimBlocks(space, point) &&
          layout.routes.some((r) =>
            r.segments.some(
              ({ from, dx, dy }) =>
                segmentDistance(point, from, { x: from.x + dx, y: from.y + dy }) <= 0.5,
            ),
          )
        )
          throw Error("WORLD_FACILITY_BLOCKS_WORLD_ROUTE: " + space.id);
      }
  }
  for (const t of facility.terraces) {
    for (const path of [...layout.routes, ...facility.passages])
      for (let i = 1; i < path.points.length; i++) {
        const a = path.points[i - 1],
          b = path.points[i];
        const samples = Math.ceil(2 * Math.hypot(b.x - a.x, b.y - a.y));
        for (let j = 0; j <= samples; j++) {
          const p = { x: a.x + ((b.x - a.x) * j) / samples, y: a.y + ((b.y - a.y) * j) / samples };
          if (facilityTerraceBlocks(t, p))
            throw Error("WORLD_FACILITY_TERRACE_BLOCKS_ROUTE: " + t.id);
        }
      }
  }
  return {
    crossings,
    chambers,
    embankments,
    landmarks,
    edges,
    facility,
    perimeter,
    routes: layout.routes,
    width: spec.width,
    height: spec.height,
  };
}
export type Structures = ReturnType<typeof structureLayout>;
type Crossing = Structures["crossings"][number];

export function shorelineWidth(b: Crossing, across: number) {
  const center = b.alongY ? b.center.x : b.center.y;
  if (!b.route.shoreline) return 4;
  const variation = valueNoise(across / 17, 0, b.seed);
  return 4 + 1.65 * variation * smoothstep((Math.abs(center - across) - 6) / 10);
}

export function shorelineWeight(b: Crossing, x: number, y: number) {
  if (!b.route.shoreline) return 0;
  const axis = b.alongY ? y : x,
    across = b.alongY ? x : y;
  const center = b.alongY ? b.center.x : b.center.y;
  const fromWater = Math.max(0, Math.abs(axis - b.start - 4) - shorelineWidth(b, across));
  const focus = 0.55 + 0.45 * smoothstep(1 - Math.abs(across - center) / 44);
  const paleBays = 0.84 + 0.16 * valueNoise(across / 12, 3, b.seed);
  return focus * smoothstep(1 - fromWater / (b.route.shoreline.reach * paleBays));
}

export function roomDistance(room: Structures["chambers"][number], x: number, y: number) {
  return Math.max(Math.abs(x - room.c.x) - room.hx, Math.abs(y - room.c.y) - room.hy);
}
export function riverDepth(x: number, y: number, structures: Structures) {
  let depth = 0;
  for (const b of structures.crossings) {
    const axis = b.alongY ? y : x;
    const half = shorelineWidth(b, b.alongY ? x : y);
    const bank = Math.max(0, Math.min(1, (half - Math.abs(axis - b.start - 4)) / 2));
    const span = Math.max(
      0,
      Math.min(
        1,
        segmentDistance({ x, y }, b.route.points[0], b.route.points[1]) - b.route.width / 2,
      ),
    );
    depth = Math.max(depth, 1.7 * bank * span);
  }
  return depth;
}
export function worldPathing(spec: WorldSpec, structures: Structures) {
  const bytes = Buffer.alloc(4 + spec.width * spec.height);
  bytes.writeUInt32LE(spec.width * spec.height * 8);
  for (let y = 0; y < spec.height; y++)
    for (let x = 0; x < spec.width; x++) {
      const px = x + 0.5,
        py = y + 0.5;
      let blocked = riverDepth(px, py, structures) > 0.4;
      if (structures.perimeter.some((edge) => perimeterBlocks(edge, { x: px, y: py })))
        blocked = true;
      if (structures.facility.terraces.some((t) => facilityTerraceBlocks(t, { x: px, y: py })))
        blocked = true;
      if (structures.facility.spaces.some((space) => facilityRimBlocks(space, { x: px, y: py })))
        blocked = true;
      for (const room of structures.chambers) {
        const rim = Math.abs(roomDistance(room, px, py)) <= 0.51;
        const opening = room.gates.some(
          (g) =>
            Math.abs(px - g.x) <= (g.vertical ? 1 : g.width / 2) &&
            Math.abs(py - g.y) <= (g.vertical ? g.width / 2 : 1),
        );
        if (rim && !opening) blocked = true;
      }
      if (blocked) bytes[4 + y * spec.width + x] = 255;
    }
  return bytes;
}

export async function structureObjects(
  s: Structures,
  palette: DecorPalette,
  pointOnGround: (point: Point2) => Position3,
  floorJoints: FloorJoint[] = [],
) {
  const objects: PlacementObject[] = [];
  const doors: Point2[] = [];
  for (const c of s.chambers) {
    const model = await palette.resolve({
      id: c.wallActor ?? "MoebiusLabWallCap",
      variation: 0,
      preview: false,
    });
    const length = panelLength(model);
    for (const vertical of [false, true])
      for (const side of [-1, 1]) {
        const fixed = vertical ? c.c.x + side * c.hx : c.c.y + side * c.hy;
        const extent = vertical ? c.hy : c.hx;
        const axis = vertical ? c.c.y : c.c.x;
        const openings = c.gates
          .filter((g) => (vertical ? g.x : g.y) === fixed)
          .map((g) => {
            const at = vertical ? g.y : g.x;
            const half = g.width / 2 + (g.door && !g.doorActor ? 0.35 : 0);
            return { min: at - half, max: at + half };
          })
          .sort((a, b) => a.min - b.min);
        let start = axis - extent;
        const end = axis + extent;
        for (const opening of [...openings, { min: end, max: end }]) {
          const span = Math.min(end, opening.min) - start;
          const pieces = Math.ceil(span / length);
          for (let i = 0; i < pieces; i++) {
            const step = span / pieces;
            const at = start + (i + 0.5) * step;
            const point = vertical ? { x: fixed, y: at } : { x: at, y: fixed };
            objects.push(fittedPanel(model, pointOnGround(point), vertical, step, length));
          }
          start = Math.max(start, opening.max);
        }
      }
    for (const gate of c.gates.filter((g) => g.door)) {
      if (gate.doorActor) {
        const panel = await palette.resolve({ id: gate.doorActor, variation: 0, preview: false });
        objects.push(
          fittedPanel(panel, pointOnGround(gate), gate.vertical, gate.width, panelLength(panel)),
        );
      } else {
        doors.push(gate);
      }
    }
  }
  for (const b of s.crossings) {
    const failures: string[] = [];
    let m;
    for (const id of b.route.model
      ? [b.route.model]
      : [
          "KorhalBridge",
          "MarSaraBridge",
          "Aiur_Temple_BridgeSection",
          "ZerusLogBridge",
          "BattleStation_MechBridge",
        ]) {
      try {
        m = await palette.resolve({ id, variation: 0, preview: false });
        break;
      } catch (error) {
        failures.push(String(error));
      }
    }
    if (!m) throw Error("WORLD_BRIDGE_MODEL_UNAVAILABLE: " + failures.join(", "));
    const { dimensions, center } = m.measured.measurement;
    const [a, d] = b.route.points,
      angle = Math.atan2(d.y - a.y, d.x - a.x);
    const rotation = angle - (dimensions.width >= dimensions.depth ? 0 : Math.PI / 2);
    const compact = b.route.raisedBank && b.route.bankRise === 2;
    const framedSingle = b.route.raisedBank && !compact && s.embankments[0].shoreline?.framedSingle;
    const length = framedSingle ? 7 : compact ? 9 : 10;
    const shift = framedSingle
      ? s.embankments[0].inland * 1.5
      : compact
        ? s.embankments[0].inland * 0.5
        : 0;
    const target = b.alongY
      ? { ...b.center, y: b.center.y - shift }
      : { ...b.center, x: b.center.x - shift };
    const span = length / Math.max(Math.abs(Math.sin(angle)), Math.abs(Math.cos(angle)));
    const modelLength = Math.max(dimensions.width, dimensions.depth);
    const scale = span / modelLength;
    const cross = framedSingle ? 9 / modelLength : scale;
    const sx = dimensions.width >= dimensions.depth ? scale : cross;
    const sy = dimensions.width >= dimensions.depth ? cross : scale;
    objects.push({
      kind: "Doodad",
      catalogId: m.actor.id,
      scale: { x: sx, y: sy, z: cross },
      flags: { HeightAbsolute: "1" },
      rotation,
      position: {
        x: target.x - (center[0] * sx * Math.cos(rotation) - center[1] * sy * Math.sin(rotation)),
        y: target.y - (center[0] * sx * Math.sin(rotation) + center[1] * sy * Math.cos(rotation)),
        z: pointOnGround(target).z + 0.05,
      },
    });
  }
  for (const bank of s.embankments) {
    const shore = bank.shoreline;
    const at = (along: number, across: number) =>
      bank.alongY ? { x: along, y: across } : { x: across, y: along };
    const reverse = bank.alongY ? bank.inland < 0 : bank.inland > 0;
    if (shore) {
      const cap = bank.compact || shore.framedSingle;
      const wall = await palette.resolve({ id: shore.actor, variation: 0, preview: false });
      const length = panelLength(wall);
      const spans = bank.compact
        ? bank.steps[0].spans
        : [
            [2, shore.opening - shore.halfWidth],
            [shore.opening + shore.halfWidth, shore.limit - 2],
          ];
      for (const [from, to] of spans) {
        const pieces = Math.ceil((to - from) / length);
        for (let i = 0; i < pieces; i++) {
          const span = (to - from) / pieces;
          const along = from + span * (i + 0.5);
          const crest = pointOnGround(at(along, shore.edge + shore.inland)).z;
          const offset = cap ? 0.85 : 0.32;
          const bottom = cap ? riverHeight - 0.12 : crest - 1.1;
          const position = { ...at(along, shore.edge - shore.inland * offset), z: bottom };
          objects.push(
            fittedPanel(wall, position, !shore.alongY, span, length, {
              height: crest - bottom + 0.14,
              depth: cap ? 2.28 : 1.6,
              reverse,
            }),
          );
        }
      }
      if (shore.framedSingle) {
        for (const side of [-1, 1]) {
          const along = shore.opening + side * (shore.halfWidth + 0.17);
          const crest = pointOnGround(at(along, shore.edge + shore.inland)).z;
          const position = { ...at(along, shore.edge - shore.inland * 1.15), z: crest - 1.45 };
          objects.push(
            fittedPanel(wall, position, shore.alongY, 1.75, length, {
              height: 1.55,
              depth: 0.46,
              reverse: side > 0,
            }),
          );
        }
      }
    }
    const accents = await Promise.all(
      bank.cliffActors.map((id) => palette.resolve({ id, variation: 0, preview: false })),
    );
    for (const [tier, step] of bank.steps.entries())
      for (const [side, [from, to]] of step.spans.entries()) {
        if (!accents.length) continue;
        const groups = Math.floor((to - from) / 14);
        for (let i = 0; i < groups; i++) {
          const model = accents[(tier + side + i) % accents.length];
          const length = panelLength(model);
          const along = from + (to - from) * ((i + (side ? 0.65 : 0.4)) / groups);
          const crest = pointOnGround(at(along, step.face + bank.inland)).z;
          const offset = tier === 0 && shore && (bank.compact || shore.framedSingle) ? 2.15 : 1.22;
          const position = { ...at(along, step.face - bank.inland * offset), z: crest - 1.56 };
          objects.push(
            fittedPanel(model, position, !bank.alongY, Math.min(3.2, length), length, {
              height: 1.12,
              depth: 0.72,
              reverse,
            }),
          );
        }
      }
  }
  const reserved: { x: number; y: number; radius: number }[] = [];
  const edgeObjects: { zone: string; count: number }[] = [];
  const pointAt = (from: Point2, to: Point2, t: number) => ({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
  });
  const fitted = new Map<string, Panel>();
  const panel = async (id: string) => {
    if (!fitted.has(id))
      fitted.set(id, await palette.resolve({ id, variation: 0, preview: false }));
    return fitted.get(id)!;
  };
  const floorJointObjects = new Map<string, number>();
  for (const joint of floorJoints) {
    const { style, vertical, fixed, from, to } = joint;
    const model = await panel(style.actor);
    const length = panelLength(model);
    const count = Math.ceil((to - from) / style.segmentLength);
    const span = (to - from) / count;
    const point = (t: number, offset = 0) =>
      pointOnGround(vertical ? { x: fixed + offset, y: t } : { x: t, y: fixed + offset });
    for (let i = 0; i < count; i++) {
      const start = from + i * span;
      const mid = start + span / 2;
      const position = point(mid);
      if (
        [
          point(start + 0.08),
          point(start + span - 0.08),
          point(mid, -style.width / 2),
          point(mid, style.width / 2),
        ].some((sample) => Math.abs(sample.z - position.z) > 0.18)
      )
        continue;
      objects.push(
        fittedPanel(model, { ...position, z: position.z - 0.015 }, vertical, span, length, {
          height: style.height,
          depth: style.width,
          reverse: false,
        }),
      );
      floorJointObjects.set(joint.zone, (floorJointObjects.get(joint.zone) ?? 0) + 1);
    }
  }
  const perimeterObjects = [];
  for (const edge of s.perimeter) {
    const model = await panel(edge.style.actor);
    const length = panelLength(model);
    let sections = 0;
    for (const item of edge.spans) {
      const from = item.from - (item.from === edge.from ? edge.style.depth / 2 : 0);
      const to = item.to + (item.to === edge.to ? edge.style.depth / 2 : 0);
      const pieces = Math.ceil((to - from) / edge.style.spacing);
      const span = (to - from) / pieces;
      for (let i = 0; i < pieces; i++) {
        const at = from + (i + 0.5) * span;
        const p = edge.vertical ? { x: edge.fixed, y: at } : { x: at, y: edge.fixed };
        objects.push(
          ...wallPanels(
            model,
            pointOnGround(p),
            edge.vertical,
            span + 0.025,
            length,
            edge.style.faces,
            edge.style,
          ),
        );
        sections++;
      }
    }
    perimeterObjects.push({
      zone: edge.zone,
      side: edge.side,
      sections,
      backFaces: edge.style.faces === "double" ? sections : 0,
    });
  }
  const spaces = s.facility.spaces;
  const passages = s.facility.passages;
  const facilityObjects: {
    zone: string;
    space: string;
    role: string;
    wallSections: number;
    fixtures: number;
    partitionSections: number;
    backFaces: number;
  }[] = [];
  for (const space of spaces) {
    const receipt = {
      zone: space.zone,
      space: space.id,
      role: space.role,
      wallSections: 0,
      fixtures: 0,
      partitionSections: 0,
      backFaces: 0,
    };
    if (space.walls) {
      const model = await panel(space.walls.actor);
      const length = panelLength(model);
      for (const side of space.walls.sides) {
        const vertical = Boolean(facilitySides[side].x);
        const limit = (vertical ? space.height : space.width) / 2;
        const openings = space.openings
          .filter((o) => o.side === side)
          .sort((a, b) => a.offset - b.offset);
        let start = -limit;
        for (const end of [...openings, { offset: limit, width: 0 }]) {
          const span = end.offset - end.width / 2 - start;
          const pieces = Math.ceil(span / length);
          for (let i = 0; i < pieces; i++) {
            const step = span / pieces;
            const at = facilityFace(space, side, start + (i + 0.5) * step);
            const panels = wallPanels(
              model,
              pointOnGround(at),
              vertical,
              step,
              length,
              space.walls.faces ?? space.defaultWallFaces,
            );
            objects.push(...panels);
            receipt.backFaces += panels.length - 1;
            receipt.wallSections++;
          }
          start = end.offset + end.width / 2;
        }
      }
    }
    for (const part of space.partitions) {
      const model = await panel(part.actor);
      const length = panelLength(model);
      const vertical = part.from.x === part.to.x;
      for (const [from, to] of partitionSpans(part)) {
        const pieces = Math.ceil((to - from) / length);
        const step = (to - from) / pieces;
        for (let i = 0; i < pieces; i++) {
          const at = from + (i + 0.5) * step;
          const p = vertical ? { x: part.from.x, y: at } : { x: at, y: part.from.y };
          const panels = wallPanels(
            model,
            pointOnGround(p),
            vertical,
            step,
            length,
            part.faces ?? space.defaultWallFaces,
          );
          objects.push(...panels);
          receipt.backFaces += panels.length - 1;
          receipt.partitionSections++;
        }
      }
    }
    for (const row of space.fixtures) {
      const model = await panel(row.actor);
      const outward = facilitySides[row.side];
      const { dimensions } = model.measured.measurement;
      const scale = row.scale ?? 1;
      const radius = (scale * Math.hypot(dimensions.width, dimensions.depth)) / 2;
      const clear = (p: Point2) => {
        const closeToPort = passages.some((pass) =>
          pass.ports.some(
            (port) =>
              port.space === space &&
              Math.hypot(p.x - port.point.x, p.y - port.point.y) < pass.width / 2 + radius,
          ),
        );
        return (
          facilitySpaceDistance(space, p) >= radius * 0.65 &&
          !space.partitions.some((part) => partitionDistance(part, p) < 0.65 * radius + 0.35) &&
          !s.facility.terraces.some(
            (t) =>
              Math.abs(areaDistance(t.area, p)) < 1 + 0.45 * radius ||
              t.stairs.some((stair) => onFacilityStair(stair, p, 0.45 * radius)),
          ) &&
          !closeToPort &&
          !(space.aisles ?? []).some(
            ({ from, to, width }) => segmentDistance(p, from, to) < width / 2 + radius,
          ) &&
          !s.routes.some((route) => routeEdgeDistance(p, route) < radius) &&
          !reserved.some(
            (old) => Math.hypot(p.x - old.x, p.y - old.y) < (radius + old.radius) * 0.75,
          )
        );
      };
      const offsets = row.adaptive ? [0, -2, 2, -4, 4, -6, 6, -8, 8] : [0];
      const insets = row.adaptive ? [row.inset, row.inset - 2, row.inset + 2] : [row.inset];
      for (let i = 0; i < row.count; i++) {
        const along = row.offset + (i - (row.count - 1) / 2) * row.spacing;
        const candidates = insets.flatMap((inset) =>
          offsets.map((offset) => {
            const at = facilityFace(space, row.side, along + offset);
            return { x: at.x - outward.x * inset, y: at.y - outward.y * inset };
          }),
        );
        const p = candidates.find(clear);
        if (!p) throw Error("WORLD_FACILITY_FIXTURE_CLEARANCE: " + space.id + "/" + row.actor);
        objects.push({
          kind: "Doodad",
          catalogId: model.actor.id,
          variation: model.variation,
          position: pointOnGround(p),
          ...(scale === 1 ? {} : { scale: { x: scale, y: scale, z: scale } }),
          flags: { HeightAbsolute: "1" },
          rotation:
            row.rotation === undefined
              ? Math.atan2(-outward.y, -outward.x)
              : (row.rotation * Math.PI) / 180,
        });
        reserved.push({ ...p, radius });
        receipt.fixtures++;
      }
    }
    facilityObjects.push(receipt);
  }
  for (const terrace of s.facility.terraces) {
    for (const stair of terrace.stairs) {
      if (!stair.treadActor) continue;
      const model = await panel(stair.treadActor);
      const inward = facilitySides[stair.direction];
      for (let i = 0; i < 5; i++) {
        const along = (i - 2) * 0.72;
        const p = pointOnGround({
          x: stair.center.x + inward.x * along,
          y: stair.center.y + inward.y * along,
        });
        objects.push(
          fittedPanel(model, { ...p, z: p.z - 0.06 }, Boolean(inward.x), 3.65, panelLength(model), {
            height: 0.22,
            depth: 0.64,
            reverse: false,
          }),
        );
      }
    }
    if (!terrace.faceActor) continue;
    const model = await panel(terrace.faceActor);
    const length = panelLength(model);
    for (const side of ["south", "east", "north", "west"] as const) {
      const face = terraceFace(terrace.area, side);
      const outward = facilitySides[side];
      const gaps = terrace.stairs
        .filter((stair) => stair.side === side)
        .map((stair) => stair.at)
        .sort((a, b) => a - b);
      let from = face.from + 0.6;
      for (const gap of [...gaps, face.to + 2.1]) {
        const end = gap - 2.7;
        const pieces = Math.ceil((end - from) / length);
        for (let i = 0; i < pieces; i++) {
          const span = (end - from) / pieces;
          const along = from + (i + 0.5) * span;
          const p = face.vertical ? { x: face.fixed, y: along } : { x: along, y: face.fixed };
          const foot = pointOnGround({ x: p.x + 2 * outward.x, y: p.y + 2 * outward.y });
          objects.push(
            fittedPanel(
              model,
              { x: p.x + 0.9 * outward.x, y: p.y + 0.9 * outward.y, z: foot.z - 0.1 },
              face.vertical,
              span,
              length,
              { height: 2.05, depth: 0.85, reverse: side === "east" || side === "south" },
            ),
          );
        }
        from = gap + 2.7;
      }
    }
  }
  for (const link of passages)
    for (const port of link.ports) {
      const normal = facilitySides[port.side];
      if (link.threshold) {
        const model = await panel(link.threshold);
        objects.push(
          fittedPanel(
            model,
            pointOnGround(port.point),
            Boolean(normal.x),
            link.width,
            panelLength(model),
          ),
        );
      }
      if (link.jamb) {
        const model = await panel(link.jamb);
        const { width, depth } = model.measured.measurement.dimensions;
        const gap = (link.width + Math.hypot(width, depth)) / 2;
        for (const n of [-gap, gap]) {
          const p = { x: port.point.x + normal.y * n, y: port.point.y + normal.x * n };
          if (
            facilityPassageDistance(link, p) < 0 ||
            p.x < 2 ||
            p.x > s.width - 2 ||
            p.y < 2 ||
            p.y > s.height - 2
          )
            throw Error("WORLD_FACILITY_JAMB_CLEARANCE: " + link.id);
          objects.push({
            kind: "Doodad",
            catalogId: model.actor.id,
            variation: model.variation,
            position: pointOnGround(p),
            flags: { HeightAbsolute: "1" },
            rotation: Math.atan2(normal.y, normal.x),
          });
        }
      }
    }
  for (const edge of s.edges) {
    const model = await panel(edge.actor);
    const angle = Math.atan2(edge.to.y - edge.from.y, edge.to.x - edge.from.x);
    const length = Math.hypot(edge.to.x - edge.from.x, edge.to.y - edge.from.y);
    const pieces = Math.ceil(length / edge.spacing);
    const vertical = edge.from.x === edge.to.x;
    let count = 0;
    for (let i = 0; i < pieces; i++) {
      const jitter = (channel: number) => edge.roughness * valueNoise(i, channel, edge.seed);
      const p = pointAt(edge.from, edge.to, (i + 0.5 + 0.23 * jitter(0)) / pieces);
      p.x -= Math.sin(angle) * jitter(1);
      p.y += Math.cos(angle) * jitter(1);
      const height = edge.height * (1 + 0.48 * jitter(2));
      const depth = edge.depth * (1 + 0.24 * jitter(3));
      const span = (length / pieces) * (1.03 + 0.29 * jitter(4));
      const radius = Math.max(depth, span) / 2;
      if (
        s.routes.some((route) => routeEdgeDistance(p, route) < radius + 1) ||
        passages.some((passage) => facilityPassageDistance(passage, p) < radius + 1)
      )
        continue;
      const foot = edge.area
        ? {
            x: p.x + (vertical ? -Math.sign(edge.ledge) * 1.25 : 0),
            y: p.y + (vertical ? 0 : -Math.sign(edge.ledge) * 1.25),
          }
        : p;
      const position = { ...p, z: pointOnGround(foot).z - Math.min(0.38, height / 3) };
      const face = edge.area && (vertical ? edge.ledge < 0 : edge.ledge > 0);
      objects.push(
        fittedPanel(
          model,
          position,
          vertical,
          span,
          panelLength(model),
          { height, depth, reverse: !!face },
          angle + 0.53 * jitter(5),
        ),
      );
      reserved.push({ ...p, radius });
      count++;
    }
    edgeObjects.push({ zone: edge.zone, count });
  }
  for (const b of s.crossings) {
    const shore = b.route.shoreline;
    if (!shore) continue;
    const models = await Promise.all([...new Set(shore.rockActors)].map(panel));
    const across = b.alongY ? s.width : s.height;
    const center = b.alongY ? b.center.x : b.center.y;
    for (const side of [-1, 1]) {
      const positionAt = (along: number, land: number) => {
        const axis = b.start + 4 + side * (shorelineWidth(b, along) + land);
        return b.alongY ? { x: along, y: axis } : { x: axis, y: along };
      };
      for (let i = 0; i < Math.floor(across / 5); i++) {
        const n = valueNoise(i * 0.7, side, b.seed);
        const at = 4 + i * 5 + n * 1.4;
        if (at < 4 || at > across - 4 || Math.abs(at - center) < 6 || (n < -0.3 && i % 3)) continue;
        const point = positionAt(at, 0.35 + n * 1.2);
        const model = models[(i + Number(side > 0)) % models.length];
        const position = pointOnGround(point);
        const large = Math.abs(at - center) < 20 && i % 3 === 0;
        objects.push(
          fittedPanel(
            model,
            { ...position, z: position.z - 0.45 },
            !b.alongY,
            large ? 5.6 : 3.65 + n,
            panelLength(model),
            {
              height: (large ? 2.5 : 1.36) + n * 0.52,
              depth: 2.9 + n,
              reverse: side * b.builtSide < 0,
            },
            (b.alongY ? 0 : Math.PI / 2) + n * 0.35,
          ),
        );
        reserved.push({ ...point, radius: large ? 2.7 : 1.9 });
      }
    }
  }
  for (const landmark of s.landmarks) {
    const actor = await palette.resolve({
      id: landmark.actor,
      variation: landmark.variation ?? 0,
      preview: false,
    });
    if (riverDepth(landmark.x, landmark.y, s) > 0.1)
      throw Error("WORLD_LANDMARK_IN_WATER: " + landmark.actor);
    const { min, max } = actor.measured.measurement.bounds;
    const radius = Math.hypot(
      Math.max(Math.abs(min[0]), Math.abs(max[0])),
      Math.max(Math.abs(min[1]), Math.abs(max[1])),
    );
    reserved.push({ x: landmark.x, y: landmark.y, radius });
    objects.push({
      kind: "Doodad",
      catalogId: actor.actor.id,
      variation: actor.variation,
      position: pointOnGround(landmark),
      flags: { HeightAbsolute: "1" },
    });
  }
  return {
    objects,
    doors,
    reserved,
    edgeObjects,
    facilityObjects,
    perimeterObjects,
    floorJointObjects: [...floorJointObjects].map(([zone, count]) => ({ zone, count })),
  };
}
type Panel = Awaited<ReturnType<DecorPalette["resolve"]>>;

function panelLength(model: Panel) {
  const { width, depth } = model.measured.measurement.dimensions;
  const length = Math.max(width, depth);
  if (!Number.isFinite(length) || length < 0.25)
    throw Error("WORLD_INVALID_PANEL_MODEL: " + model.actor.id);
  return length;
}

function wallPanels(
  model: Panel,
  position: Position3,
  vertical: boolean,
  span: number,
  length: number,
  faces: "single" | "double",
  size?: { height: number; depth: number },
) {
  if (faces === "single")
    return [
      fittedPanel(model, position, vertical, span, length, size && { ...size, reverse: false }),
    ];
  const { width, depth, height } = model.measured.measurement.dimensions;
  const halfDepth = (size?.depth ?? Math.max(0.35, Math.min(width, depth))) / 2;
  return [-1, 1].map((side) => {
    const shift = side * (halfDepth / 2 + 0.015);
    const center = {
      x: position.x + (vertical ? shift : 0),
      y: position.y - (vertical ? 0 : shift),
      z: position.z,
    };
    return fittedPanel(model, center, vertical, span, length, {
      height: size?.height ?? height,
      depth: halfDepth,
      reverse: side < 0,
    });
  });
}

function fittedPanel(
  model: Panel,
  position: Position3,
  vertical: boolean,
  span: number,
  length: number,
  lining?: { height: number; depth: number; reverse: boolean },
  angle = vertical ? Math.PI / 2 : 0,
): PlacementObject {
  const { center, dimensions, bounds } = model.measured.measurement;
  const alongX = dimensions.width >= dimensions.depth;
  const stretch = span / length;
  const rotation = angle - (alongX ? 0 : Math.PI / 2) + (lining?.reverse ? Math.PI : 0);
  const cross = lining
    ? lining.depth / Math.max(0.25, Math.min(dimensions.width, dimensions.depth))
    : 1;
  const sz = lining ? lining.height / Math.max(0.25, dimensions.height) : 1;
  const sx = alongX ? stretch : cross;
  const sy = alongX ? cross : stretch;
  return {
    kind: "Doodad",
    catalogId: model.actor.id,
    position: {
      x: position.x - (center[0] * sx * Math.cos(rotation) - center[1] * sy * Math.sin(rotation)),
      y: position.y - (center[0] * sx * Math.sin(rotation) + center[1] * sy * Math.cos(rotation)),
      z: lining ? position.z - bounds.min[2] * sz : position.z,
    },
    scale: { x: sx, y: sy, z: sz },
    rotation,
    flags: { HeightAbsolute: "1" },
  };
}

export function waterOperations(spec: WorldSpec, structures: Structures): TerrainOperation[] {
  if (!structures.crossings.length) return [];
  return [
    { op: "water.material", id: "WorldRiverWater", parent: "Agria", height: riverHeight },
    ...structures.crossings.map((b) => {
      const margin = b.route.shoreline ? 8 : 0;
      return {
        op: "water.create" as const,
        template: "WorldRiverWater",
        area: {
          type: "rectangle" as const,
          minX: b.alongY ? 0 : b.start - margin,
          minY: b.alongY ? b.start - margin : 0,
          maxX: b.alongY ? spec.width : b.start + 8 + margin,
          maxY: b.alongY ? b.start + 8 + margin : spec.height,
        },
      };
    }),
  ];
}
export function gateRequests(
  gates: { id: number; position: Point2 }[],
  units: number[],
): GuiRequest[] {
  const fixed = (value: number): GuiValue => ({ kind: "literal", type: "fixed", value });
  const call = (name: string, args: Record<string, GuiValue>): GuiValue => ({
    kind: "call",
    function: name,
    args,
  });
  const p = (name: string): GuiValue => ({ kind: "preset", name });
  return gates.flatMap((g) =>
    [...units.map((id) => [id]), units].map((observed, index): GuiRequest => {
      const lower = index < units.length;
      const distances = observed.map((id) =>
        call("DistanceBetweenPoints", {
          p1: call("UnitGetPosition", { u: { kind: "unit", objectId: id } }),
          p2: call("Point", { x: fixed(g.position.x), y: fixed(g.position.y) }),
        }),
      );
      return {
        create: { identifier: "WorldGate" + g.id + (lower ? "Open" + index : "Close") },
        calls: [
          {
            kind: "Event" as const,
            function: "TriggerAddEventTimePeriodic",
            args: { dur: fixed(1), timeType: p("game") },
          },
          ...distances.map((distance) => ({
            kind: "Condition" as const,
            function: "Comparison",
            args: { val1: distance, op: p(lower ? "lt" : "gt"), val2: fixed(lower ? 5 : 7) },
          })),
          {
            kind: "Action" as const,
            function: "UnitIssueOrder",
            args: {
              u: { kind: "unit" as const, objectId: g.id },
              queue: p("replace"),
              ord: call("Order", {
                abilCmd: call("AbilityCommand", {
                  ability: {
                    kind: "gamelink",
                    domain: "Abil",
                    id: lower ? "SupplyDepotLower" : "SupplyDepotRaise",
                  },
                  command: { kind: "literal", type: "int", value: 0 },
                }),
              }),
            },
          },
        ],
      };
    }),
  );
}
