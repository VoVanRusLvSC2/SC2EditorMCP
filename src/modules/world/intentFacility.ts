import type { input } from "zod/v4";
import type { TerrainSet } from "../document/codecs/flatTerrainFactory.js";
import type { Point2 } from "../terrain/types.js";
import type { worldFacility } from "./facility.js";
import type { WorldIntent } from "./intent.js";
import { seedFor, type WorldLayout } from "./plan.js";
import type { RoomPassport } from "./workstations.js";

type Facility = input<typeof worldFacility>;
type Side = "south" | "east" | "north" | "west";
type StructureRole = Facility["spaces"][number]["role"];
type RoomRequest = Partial<
  Pick<RoomPassport, "activity" | "density" | "condition" | "placement" | "aisleWidth">
> & {
  role: StructureRole;
};
type Dimensions = { left: number; right: number; bottom: number; top: number };
const sides = ["south", "east", "north", "west"] as const;
const labRooms: StructureRole[] = ["lab", "storage", "command", "production"];
const cityRooms: StructureRole[] = ["courtyard", "command", "storage", "production"];
const umoja = {
  wall: "UmojanLabGlassWallPanel",
  retainingWall: "UmojanLabCliffWallsTall",
  trim: "UmojanLabWallCap",
};
const roomActivities: Record<StructureRole, RoomPassport["activity"]> = {
  lab: "research",
  storage: "sorting",
  command: "briefing",
  production: "power",
  entry: "checkpoint",
  courtyard: "circulation",
  landing: "checkpoint",
  organic: "habitation",
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
  const order: RoomRequest[] = (zone.rooms ?? (kind === "city" ? cityRooms : labRooms)).map(
    (room) => (typeof room === "string" ? { role: room } : room),
  );
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
  const isUmojan = set.id === "UmojaEx3" || set.id === "DominionLab";
  const asset: { wall: string; trim?: string; retainingWall?: string } | undefined = isUmojan
    ? umoja
    : set.id === "Castanar"
      ? { wall: "MetalWall" }
      : set.id === "BlackopsLab_A"
        ? { wall: "DOM_LabGlassWalls", trim: "DOM_LabWallCap" }
        : undefined;
  const available = (values: string[] = []) => values.filter((id) => set.textures.includes(id));
  const floors = [...new Set([...available(materials.floor), ...set.textures])];
  const ground = floors[0];
  const road = available(materials.path)[0] ?? floors[1] ?? ground;
  const accents = available(materials.accent);
  const trim =
    kind === "city"
      ? ([...accents, ...floors].find((id) => id !== road && id !== ground) ?? ground)
      : (accents[0] ?? floors[2] ?? ground);
  const circulationTrim = isUmojan ? road : trim;
  const palette = (preferred: string, otherwise: string) =>
    set.textures.includes(preferred) ? preferred : otherwise;
  const roomFloors =
    set.id === "UmojaEx3"
      ? [
          palette("UmojaEx3_1", ground),
          palette("UmojaEx3_3", ground),
          palette("UmojaEx3_5", ground),
        ]
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
    trim: circulationTrim,
    roomComposition: {
      activity: "circulation",
      placement: "wall",
      aisleWidth: kind === "city" ? 6 : 4,
      side: face(pick("gallery-side", 2) ? "east" : "west"),
      tileSet: set.id,
      seed: seedFor(seed, zone.id + "/gallery") >>> 0,
    },
  });
  if (arrival) {
    passages.push({
      id: "SiteEntrance",
      width: 6,
      floor: road,
      trim: circulationTrim,
      from: { space: spine, side: face("south") },
      waypoints: [local(0, site.bottom - 1)],
    });
  }
  const swap = pick("first-wing", 2) ? 1 : -1;
  const split = spineV + (pick("row-split", 5) - 2);
  const hallW = spineWidth / 2;
  const upperIndex = order.findIndex((room) => room.placement === "upper");
  if (order.filter((room) => room.placement === "upper").length > 1)
    throw Error("WORLD_INTENT_MULTIPLE_UPPER_ROOMS: " + zone.id);
  const labIndex = order.findIndex(({ role }) => role === "lab");
  const raisedIndex =
    upperIndex >= 0 ? upperIndex : zone.raised ? (labIndex >= 0 ? labIndex : order.length - 1) : -1;
  for (const [i, room] of order.entries()) {
    const { role } = room;
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
    const closed = kind === "lab" && role !== "courtyard";
    const rotateOffset = (side: Side, value: number) => {
      const yAxis = side === "west" || side === "east";
      const start = local(0, 0);
      const end = yAxis ? local(0, value) : local(value, 0);
      const worldSide = face(side);
      return worldSide === "west" || worldSide === "east" ? end.y - start.y : end.x - start.x;
    };
    const outerSide = sign > 0 ? "east" : "west";
    const upper = i === raisedIndex;
    const activity =
      room.activity ?? (upper && role === "lab" ? "containment" : roomActivities[role]);
    const focusSide = pick("focus-side/" + i, 3) ? outerSide : "north";
    const compositionPlacement =
      room.placement && room.placement !== "auto"
        ? room.placement
        : upper
          ? "upper"
          : activity === "briefing" && roomW >= 20 && roomH >= 16 && pick("island/" + i, 2)
            ? "island"
            : "wall";
    const inset = Math.min(8, Math.floor(roomW / 4));
    const halfDepth = Math.min(5, Math.floor(roomH / 4));
    const bias = focusSide === "east" ? inset : focusSide === "west" ? -inset : 0;
    const northBias = focusSide === "north" ? Math.floor(roomH / 6) : 0;
    const workFloor = roomFloors.find((value) => value !== floor && value !== road);
    spaces.push({
      id,
      role,
      ...rect(u, v, roomW, roomH),
      floor,
      trim,
      roomComposition: {
        activity,
        placement: compositionPlacement,
        side: face(focusSide),
        tileSet: set.id,
        seed: seedFor(seed, zone.id + "/" + id + "/composition") >>> 0,
        density: room.density,
        condition: room.condition,
        aisleWidth: room.aisleWidth,
      },
      ...(!upper && workFloor && roomW >= 18 && roomH >= 14 && activity !== "circulation"
        ? {
            inlays: [
              {
                ...bounds({
                  left: u + bias - 4,
                  right: u + bias + 4,
                  bottom: v + northBias - halfDepth,
                  top: v + northBias + halfDepth,
                }),
                floor: workFloor,
              },
            ],
          }
        : {}),
      ...(asset && closed ? { walls: { actor: asset.wall, sides: [...sides] } } : {}),
      ...(asset &&
      closed &&
      !upper &&
      role === "lab" &&
      roomW >= 26 &&
      roomH >= 20 &&
      pick("lab-divider/" + i, 2)
        ? {
            partitions: [
              {
                from: local(u + sign * 6, v + 3),
                to: local(u + sign * (roomW / 2 - 3), v + 3),
                actor: asset.wall,
              },
            ],
          }
        : {}),
      ...(isUmojan && activity === "sorting"
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
        trim: circulationTrim,
        from: {
          space: "Room" + (prior + 1),
          side: face("north"),
          offset: rotateOffset("north", u - priorU),
        },
        to: { space: id, side: face("south") },
        ...(!isUmojan && asset?.trim ? { threshold: asset.trim } : {}),
      });
    } else {
      passages.push({
        id: "Access" + i,
        width: 4,
        floor: road,
        trim: circulationTrim,
        from: { space: spine, side: face(hallSide), offset: rotateOffset(hallSide, v - spineV) },
        to: { space: id, side: face(roomSide) },
        ...(!isUmojan && asset?.trim ? { threshold: asset.trim } : {}),
      });
    }
    if (upper) {
      const area = bounds({ left: u - 7, right: u + 7, bottom: v + 1, top: v + 9 });
      const min = { x: 2 * Math.ceil(area.min.x / 2), y: 2 * Math.ceil(area.min.y / 2) };
      const max = { x: min.x + (rotation % 2 ? 8 : 14), y: min.y + (rotation % 2 ? 14 : 8) };
      if (
        roomW < 20 ||
        roomH < 20 ||
        !fits({ left: u - 9, right: u + 9, bottom: v - 4, top: v + 12 })
      )
        throw Error("WORLD_INTENT_TERRACE_CLEARANCE: " + zone.id + "/" + role);
      const stairSide = face("south");
      const across = stairSide === "south" || stairSide === "north" ? min.x : min.y;
      const upperFloor =
        roomFloors.includes("UmojaEx3_5") && floor !== "UmojaEx3_5" ? "UmojaEx3_5" : workFloor;
      if (isUmojan && activity === "containment" && upperFloor && upperFloor !== floor) {
        spaces.at(-1)!.inlays = [
          {
            min: {
              x: min.x + (stairSide === "west" ? 2 : 1),
              y: min.y + (stairSide === "south" ? 2 : 1),
            },
            max: {
              x: max.x - (stairSide === "east" ? 2 : 1),
              y: max.y - (stairSide === "north" ? 2 : 1),
            },
            floor: upperFloor,
          },
        ];
      }
      terraces.push({
        id: "UpperWorkBay",
        min,
        max,
        floor,
        faceActor: asset?.retainingWall,
        faceStyle: "square",
        stairs: [{ side: stairSide, at: across + 7, treadActor: asset?.trim }],
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
        ...(isUmojan
          ? {
              floorJoints: { actor: umoja.trim, width: 0.34, height: 0.075, segmentLength: 4.5 },
            }
          : {}),
        ...(asset?.retainingWall
          ? { perimeter: { actor: asset.retainingWall, spacing: 4.8, height: 2.7, depth: 1.8 } }
          : {}),
      },
      spaces,
      passages,
      terraces,
    },
  };
}
