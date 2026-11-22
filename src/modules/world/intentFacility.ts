import type { input } from "zod/v4";
import type { TerrainSet } from "../document/codecs/flatTerrainFactory.js";
import type { Point2 } from "../terrain/types.js";
import type { worldFacility } from "./facility.js";
import type { WorldIntent } from "./intent.js";
import { seedFor, type WorldLayout } from "./plan.js";

type Facility = input<typeof worldFacility>;
type Side = "south" | "east" | "north" | "west";
type StructureRole = Facility["spaces"][number]["role"];
type Dimensions = { left: number; right: number; bottom: number; top: number };
const sides = ["south", "east", "north", "west"] as const;
const labRooms: StructureRole[] = ["lab", "storage", "command", "production"];
const cityRooms: StructureRole[] = ["courtyard", "command", "storage", "production"];
const umoja = {
  wall: "UmojanLabGlassWallPanel",
  retainingWall: "UmojanLabCliffWallsTall",
  trim: "UmojanLabWallCap",
  fixtures: {
    lab: "UmojanLabDissectionTable",
    command: "UmojanLabConsoleSmall",
    production: "UmojanLabPowerConduit",
  },
};

interface FacilityInput {
  zone: WorldIntent["zones"][number];
  kind: "lab" | "city";
  layout: WorldLayout;
  width: number;
  height: number;
  set: TerrainSet;
  materials: Partial<Record<"floor" | "path" | "accent", string[]>>;
  seed: number;
  arrival?: { side: Side; bank: number };
}

export function planIntentFacility(args: FacilityInput) {
  const { zone, kind, layout, width, height, set, materials, seed, arrival } = args;
  const { center, bank } = layout.zones.find((z) => z.id === zone.id)!;
  const rotation = sides.indexOf(arrival?.side ?? "south");
  const face = (direction: Side) => sides[(sides.indexOf(direction) + rotation) % 4];
  const local = (u: number, v: number): Point2 => {
    const offset = [
      { x: u, y: v },
      { x: -v, y: u },
      { x: -u, y: -v },
      { x: v, y: -u },
    ][rotation];
    return { x: center.x + offset.x, y: center.y + offset.y };
  };
  const bounds = (box: Dimensions) => {
    const a = local(box.left, box.bottom);
    const b = local(box.right, box.top);
    return {
      min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
      max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
    };
  };
  const safe = (p: Point2) =>
    p.x >= 4 &&
    p.x <= width - 4 &&
    p.y >= 4 &&
    p.y <= height - 4 &&
    layout.zones[layout.blocks[Math.floor(p.y / 8) * (width / 8) + Math.floor(p.x / 8)]]?.bank ===
      bank;
  const landLimit = arrival
    ? rotation % 2 === 0
      ? Math.abs(arrival.bank - center.y)
      : Math.abs(arrival.bank - center.x)
    : Infinity;
  const fits = (box: Dimensions) => {
    for (let y = box.bottom; y <= box.top; y++)
      for (let x = box.left; x <= box.right; x++) if (!safe(local(x, y))) return false;
    return true;
  };
  const pick = (key: string, n: number) => (seedFor(seed, zone.id + "/facility/" + key) >>> 0) % n;
  const order = [...(zone.rooms ?? (kind === "city" ? cityRooms : labRooms))];
  for (let i = order.length - 1; i > 0; i--) {
    const j = pick("room/" + i, i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const twoRows = order.length > 2;
  const sideSize = order.length > 1 ? 19 : 10;
  const rowSize = twoRows ? 24 : 11;
  const site = { left: -sideSize, right: 19, bottom: -rowSize, top: rowSize };
  if (arrival) {
    site.bottom = Math.max(site.bottom, -landLimit + 2);
  }
  if (site.top - site.bottom < (twoRows ? 42 : 22) || !fits(site))
    throw Error("WORLD_INTENT_SITE_CLEARANCE: " + zone.id + " needs a larger contiguous site");
  // Grow along each face while all of its cells remain on the site's bank.
  const limits = { left: -42, right: 42, bottom: -Math.min(36, landLimit - 2), top: 36 };
  for (const side of ["left", "right", "bottom", "top"] as const) {
    const limit = limits[side];
    const step = Math.sign(limit - site[side]);
    while (step && site[side] !== limit) {
      const candidate = { ...site, [side]: site[side] + step };
      if (!fits(candidate)) break;
      Object.assign(site, candidate);
    }
  }
  const asset = set.id === "UmojaEx3" ? umoja : undefined;
  const available = (values: string[] = []) => values.filter((id) => set.textures.includes(id));
  const floors = [...new Set([...available(materials.floor), ...set.textures])];
  const ground = floors[0];
  const road = available(materials.path)[0] ?? floors[1] ?? ground;
  const accents = available(materials.accent);
  const trim =
    kind === "city"
      ? ([...accents, ...floors].find((id) => id !== road && id !== ground) ?? ground)
      : (accents[0] ?? floors[2] ?? ground);
  const palette = (preferred: string, otherwise: string) =>
    set.textures.includes(preferred) ? preferred : otherwise;
  const roomFloors = asset
    ? [palette("UmojaEx3_1", ground), palette("UmojaEx3_3", ground), palette("UmojaEx3_5", ground)]
    : floors.filter((id) => id !== road);

  const spineWidth = kind === "city" ? 12 : 8 + 2 * pick("spine", 3);
  const spineBottom = site.bottom + 4;
  const spineTop = site.top - 4 - pick("far-end", 3);
  const spineV = Math.floor((spineBottom + spineTop) / 2);
  const spineLength = 2 * Math.min(spineV - spineBottom, spineTop - spineV);
  const spaces: Facility["spaces"] = [];
  const passages: NonNullable<Facility["passages"]> = [];
  const terraces: NonNullable<Facility["terraces"]> = [];
  const rect = (u: number, v: number, w: number, h: number) => ({
    center: local(u, v),
    width: rotation % 2 ? h : w,
    height: rotation % 2 ? w : h,
  });
  const spine = kind === "city" ? "MainStreet" : "MainGallery";
  spaces.push({
    id: spine,
    role: "courtyard",
    ...rect(0, spineV, spineWidth, spineLength),
    floor: road,
    trim,
  });
  if (arrival) {
    passages.push({
      id: "SiteEntrance",
      width: 6,
      floor: road,
      trim,
      from: { space: spine, side: face("south") },
      waypoints: [local(0, site.bottom - 1)],
    });
  }
  const swap = pick("first-wing", 2) ? 1 : -1;
  const split = spineV + (pick("row-split", 5) - 2);
  const hallW = spineWidth / 2;
  for (const [i, role] of order.entries()) {
    const sign = i % 2 ? -swap : swap;
    const lo = !twoRows || i < 2 ? spineBottom + 2 : split + 4;
    const hi = !twoRows || i >= 2 ? spineTop - 1 : split - 4;
    const fitWidth = (sign > 0 ? site.right : -site.left) - hallW - 7;
    const roomW = 2 * Math.min(20, Math.floor(fitWidth / 2));
    const roomH = 2 * Math.min(15, Math.floor((hi - lo) / 2));
    const outerY = Math.floor((lo + hi) / 2);
    if (Math.min(roomW, roomH) < 10)
      throw Error("WORLD_INTENT_ROOM_CLEARANCE: " + zone.id + "/" + role);
    const u = sign * (hallW + 4 + roomW / 2 + pick("room-setback/" + i, 2));
    const v = outerY;
    const id = "Room" + (i + 1);
    const floor = roomFloors[i % roomFloors.length] ?? ground;
    const actor = asset?.fixtures[role as keyof typeof umoja.fixtures];
    const closed = kind === "lab" && role !== "courtyard";
    const rotateOffset = (side: Side, value: number) => {
      const yAxis = side === "west" || side === "east";
      const start = local(0, 0);
      const end = yAxis ? local(0, value) : local(value, 0);
      const worldSide = face(side);
      return worldSide === "west" || worldSide === "east" ? end.y - start.y : end.x - start.x;
    };
    const outerSide = sign > 0 ? "east" : "west";
    const largeRoom = asset && roomW >= 20 && roomH >= 16;
    const focus =
      largeRoom && (role === "command" || (role === "lab" && !zone.raised))
        ? role === "command"
          ? "briefing"
          : "research"
        : undefined;
    spaces.push({
      id,
      role,
      ...rect(u, v, roomW, roomH),
      floor,
      trim,
      ...(asset && closed ? { walls: { actor: asset.wall, sides: [...sides] } } : {}),
      ...(asset && role === "storage"
        ? {
            cargoBays: [
              {
                kind: "freight" as const,
                ...(roomW >= 16 && roomH >= 16 && pick("freight-shape/" + i, 2)
                  ? { staggered: true as const }
                  : {}),
                side: face(outerSide),
                corner: rotateOffset(outerSide, 1) > 0 ? ("end" as const) : ("start" as const),
              },
            ],
          }
        : {}),
      ...(focus
        ? { roomComposition: { focus: { kind: focus, side: face(outerSide) } } }
        : largeRoom && role === "production"
          ? { workstations: [{ kind: "service" as const, side: face(outerSide) }] }
          : actor
            ? {
                fixtures: [
                  {
                    actor,
                    side: face(outerSide),
                    count: role === "production" ? 1 : 2,
                    spacing: 6,
                    inset: 6,
                    adaptive: true as const,
                  },
                ],
              }
            : {}),
    });
    const hallSide = sign > 0 ? "east" : "west";
    const roomSide = sign > 0 ? "west" : "east";
    const service = i >= 2 && pick("service-link/" + i, 2) === 1;
    if (service) {
      const prior = i - 2;
      // The rooms face each other across a service aisle. Setbacks can differ by one.
      const priorU = sign * (hallW + 4 + roomW / 2 + pick("room-setback/" + prior, 2));
      passages.push({
        id: "Service" + i,
        width: 4,
        floor: road,
        trim,
        from: {
          space: "Room" + (prior + 1),
          side: face("north"),
          offset: rotateOffset("north", u - priorU),
        },
        to: { space: id, side: face("south") },
        ...(asset ? { threshold: asset.trim } : {}),
      });
    } else {
      passages.push({
        id: "Access" + i,
        width: 4,
        floor: road,
        trim,
        from: { space: spine, side: face(hallSide), offset: rotateOffset(hallSide, v - spineV) },
        to: { space: id, side: face(roomSide) },
        ...(asset ? { threshold: asset.trim } : {}),
      });
    }
    if (zone.raised && !terraces.length && (role === "lab" || i === order.length - 1)) {
      const area = bounds({ left: u - 7, right: u + 7, bottom: v + 1, top: v + 9 });
      const min = { x: 2 * Math.ceil(area.min.x / 2), y: 2 * Math.ceil(area.min.y / 2) };
      const max = { x: min.x + (rotation % 2 ? 8 : 12), y: min.y + (rotation % 2 ? 12 : 8) };
      if (
        roomW < 20 ||
        roomH < 20 ||
        !fits({ left: u - 9, right: u + 9, bottom: v - 4, top: v + 12 })
      )
        throw Error("WORLD_INTENT_TERRACE_CLEARANCE: " + zone.id + "/" + role);
      const stairSide = face("south");
      const across = stairSide === "south" || stairSide === "north" ? min.x : min.y;
      terraces.push({
        id: "UpperWorkBay",
        min,
        max,
        floor,
        faceActor: asset?.retainingWall,
        stairs: [{ side: stairSide, at: across + 5, treadActor: asset?.trim }],
      });
    }
  }
  return {
    materials: { ground, road, trim, roadEdge: trim, scatter: floors.slice(0, 3) },
    facility: {
      wallFaces: "double" as const,
      grounds: {
        ...bounds(site),
        floor: ground,
        trim,
        exterior: floors.at(-1)!,
        ...(asset
          ? { perimeter: { actor: asset.retainingWall, spacing: 4.8, height: 2.7, depth: 1.8 } }
          : {}),
      },
      spaces,
      passages,
      terraces,
    },
  };
}
