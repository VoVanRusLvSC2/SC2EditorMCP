import type { WorldLayout, WorldSpec } from "./plan.js";
import type { PlacementObject } from "../placement/types.js";
import type { GuiRequest, GuiValue } from "../trigger/authoring.js";
import type { Point2, TerrainOperation } from "../terrain/types.js";
import type { DecorPalette } from "../placement/decorPalette.js";
import { segmentDistance } from "../terrain/geometry.js";

export function structureLayout(spec: WorldSpec, layout: WorldLayout) {
  const crossings = layout.routes
    .filter((r) => r.kind === "bridge")
    .map((route) => {
      const [a, b] = route.points;
      const alongY = Math.abs(b.y - a.y) >= Math.abs(b.x - a.x);
      const across = alongY ? spec.height : spec.width;
      const start = Math.floor(((alongY ? a.y + b.y : a.x + b.x) / 2 - 4) / 8) * 8;
      if (start < 8 || start + 8 > across - 8) throw Error("WORLD_BRIDGE_LANDINGS_OUT_OF_BOUNDS");
      const coord = (start + 4 - (alongY ? a.y : a.x)) / (alongY ? b.y - a.y : b.x - a.x);
      const x = a.x + (b.x - a.x) * coord,
        y = a.y + (b.y - a.y) * coord;
      return { route, alongY, start, center: { x, y } };
    });
  const chambers = layout.zones
    .filter(
      (z) =>
        z.biome === "engineered" &&
        (z.walls ||
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
        c = z.center;
      const gates = layout.routes
        .filter((r) => r.from === z.id || r.to === z.id)
        .map((r) => {
          const dest = r.points[r.from === z.id ? 1 : 0];
          const dx = dest.x - c.x,
            dy = dest.y - c.y,
            scale = half / Math.max(Math.abs(dx), Math.abs(dy));
          const vertical = Math.abs(dx) > Math.abs(dy);
          return {
            x: Math.round(c.x + scale * dx),
            y: Math.round(c.y + scale * dy),
            vertical,
            door: r.kind === "door",
            width: r.kind === "door" ? 2 : r.width,
          };
        });
      return { id: z.id, c, half, gates };
    });
  for (const r of layout.routes.filter((r) => r.kind === "door"))
    if (!chambers.some((c) => c.id === r.from || c.id === r.to))
      throw Error("WORLD_DOOR_REQUIRES_ROOM");
  for (const b of crossings)
    for (const z of layout.zones) {
      const axis = b.alongY ? z.center.y : z.center.x;
      if (axis >= b.start - 3 && axis <= b.start + 11)
        throw Error("WORLD_RIVER_OVERLAPS_ZONE_CENTER: " + z.id);
    }
  return { crossings, chambers };
}
export type Structures = ReturnType<typeof structureLayout>;
export function riverDepth(x: number, y: number, structures: Structures) {
  let depth = 0;
  for (const b of structures.crossings) {
    const axis = b.alongY ? y : x;
    const bank = Math.max(0, Math.min(1, (axis - b.start) / 2, (b.start + 8 - axis) / 2));
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
      for (const room of structures.chambers) {
        const rim =
          Math.abs(Math.max(Math.abs(px - room.c.x), Math.abs(py - room.c.y)) - room.half) <= 0.51;
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

export async function structureObjects(s: Structures, palette: DecorPalette) {
  const objects: PlacementObject[] = [];
  const doors: Point2[] = [];
  for (const c of s.chambers) {
    // Wall segment positions follow the same perimeter and openings as the no-path mask.
    for (const vertical of [false, true])
      for (const side of [-1, 1])
        for (let u = -c.half; u < c.half; u += 2) {
          const x = c.c.x + (vertical ? side * c.half : u + 1),
            y = c.c.y + (vertical ? u + 1 : side * c.half);
          if (c.gates.some((g) => Math.hypot(x - g.x, y - g.y) <= g.width / 2 + 1)) continue;
          objects.push({
            kind: "Doodad",
            catalogId: "MoebiusLabWallCap",
            position: { x, y, z: 4 },
            rotation: vertical ? Math.PI / 2 : 0,
          });
        }
    doors.push(...c.gates.filter((g) => g.door));
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
    const span = 10 / Math.max(Math.abs(Math.sin(angle)), Math.abs(Math.cos(angle)));
    const scale = span / Math.max(dimensions.width, dimensions.depth);
    objects.push({
      kind: "Doodad",
      catalogId: m.actor.id,
      scale: { x: scale, y: scale, z: scale },
      rotation,
      position: {
        x: b.center.x - scale * (center[0] * Math.cos(rotation) - center[1] * Math.sin(rotation)),
        y: b.center.y - scale * (center[0] * Math.sin(rotation) + center[1] * Math.cos(rotation)),
        z: 4.05,
      },
    });
  }
  return { objects, doors };
}
export function waterOperations(spec: WorldSpec, structures: Structures): TerrainOperation[] {
  if (!structures.crossings.length) return [];
  return [
    { op: "water.material", id: "WorldRiverWater", parent: "Agria", height: 3.2 },
    ...structures.crossings.map((b) => ({
      op: "water.create" as const,
      template: "WorldRiverWater",
      area: {
        type: "rectangle" as const,
        minX: b.alongY ? 0 : b.start,
        minY: b.alongY ? b.start : 0,
        maxX: b.alongY ? spec.width : b.start + 8,
        maxY: b.alongY ? b.start + 8 : spec.height,
      },
    })),
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
