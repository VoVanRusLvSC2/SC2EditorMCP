import type { input } from "zod/v4";
import type { TerrainSet } from "../document/codecs/flatTerrainFactory.js";
import type { Point2 } from "../terrain/types.js";
import type { worldFacility } from "./facility.js";
import type { WorldIntent } from "./intent.js";
import { seedFor, type WorldLayout } from "./plan.js";
import type { RoomPassport } from "./workstations.js";
import {
  compactFacilityLayout,
  compactPassage,
  compactWorkDeck,
  opposite,
} from "./compactFacility.js";

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
const protossRooms: StructureRole[] = ["organic", "command", "production", "courtyard"];
const ritualRooms: StructureRole[] = ["command", "entry", "production", "courtyard"];
const nova = {
  wall: "DOM_LabGlassWalls",
  retainingWall: "DOM_CliffStructures",
  trim: "DOM_GroundTrims",
};
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
  kind: "lab" | "city" | "base";
  layout: WorldLayout;
  width: number;
  height: number;
  set: TerrainSet;
  materials: Partial<Record<"floor" | "path" | "accent", string[]>>;
  seed: number;
  arrival?: { side: Side; bank: number };
  compactSide?: Side;
  topologySeed?: number;
}

export function planIntentFacility(args: FacilityInput) {
  const { zone, kind, layout, width, height, set, materials, seed, arrival, compactSide } = args;
  const { center, bank } = layout.zones.find((z) => z.id === zone.id)!;
  const rotation = sides.indexOf(compactSide ?? arrival?.side ?? "south");
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
  const isNova = set.id === "BlackopsLab_A";
  const isTalDarim = set.id === "Slayn" || set.id === "SlaynTemple";
  const roomDefaults =
    kind === "city"
      ? cityRooms
      : kind === "lab"
        ? labRooms
        : isTalDarim
          ? ritualRooms
          : protossRooms;
  const order: RoomRequest[] = (zone.rooms ?? roomDefaults).map((room) =>
    typeof room === "string" ? { role: room } : room,
  );
  for (let i = order.length - 1; i > 0; i--) {
    const j = pick("room/" + i, i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const twoRows = order.length > 2;
  const sideSize = order.length > 1 ? 19 : 10;
  const rowSize = twoRows ? 24 : 11;
  const site = compactSide
    ? { left: -27, right: 27, bottom: -24, top: 24 }
    : { left: -sideSize, right: 19, bottom: -rowSize, top: rowSize };
  if (arrival) {
    site.bottom = Math.max(site.bottom, -landLimit + 2);
  }
  if (site.top - site.bottom < (twoRows ? 42 : 22) || !fits(site))
    throw Error("WORLD_INTENT_SITE_CLEARANCE: " + zone.id + " needs a larger contiguous site");
  // Grow along each face while all of its cells remain on the site's bank.
  const limits = compactSide
    ? { ...site }
    : { left: -42, right: 42, bottom: -Math.min(36, landLimit - 2), top: 36 };
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
    : isNova
      ? nova
      : set.id === "Castanar"
        ? { wall: "MetalWall" }
        : undefined;
  const jointActor = isUmojan
    ? umoja.trim
    : isNova
      ? nova.trim
      : kind === "base"
        ? isTalDarim
          ? "Slayn_Road_Inlay"
          : "Protoss_Base_GroundTrim"
        : kind === "city" && /^Korhal/.test(set.id)
          ? "Korhal_Curbs"
          : kind === "city" && ["PortCity", "DefendersCity"].includes(set.id)
            ? "PortCity_Trims"
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
  const circulationTrim = jointActor && !isNova ? road : trim;
  const perimeterActor =
    asset?.retainingWall ??
    (kind === "base"
      ? isTalDarim
        ? "Slayn_Temple_BigWalls"
        : "Protoss_Base_OuterWalls"
      : undefined);
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

  const rotateOffset = (side: Side, value: number) => {
    const yAxis = side === "west" || side === "east";
    const start = local(0, 0);
    const end = yAxis ? local(0, value) : local(value, 0);
    const worldSide = face(side);
    return worldSide === "west" || worldSide === "east" ? end.y - start.y : end.x - start.x;
  };
  const roomActivity = (role: StructureRole, upper: boolean) =>
    upper && role === "lab"
      ? "containment"
      : kind === "base" && isTalDarim && role === "command"
        ? "ritual"
        : kind === "base" && role === "organic"
          ? "garden"
          : kind === "city" && role === "courtyard"
            ? "plaza"
            : kind === "city" && role === "command"
              ? "frontage"
              : roomActivities[role];
  const roomFloor = (role: StructureRole, index: number) => {
    const floor = roomFloors[index % roomFloors.length] ?? ground;
    return kind === "base" && role === "organic"
      ? palette(compactSide ? "Aiur4City6" : "Aiur4City7", floor)
      : floor;
  };
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
  const assemble = () => ({
    materials: { ground, road, trim, roadEdge: trim, scatter: floors.slice(0, 3) },
    facility: {
      wallFaces: "double" as const,
      grounds: {
        ...bounds(site),
        floor: ground,
        trim,
        exterior: floors.at(-1)!,
        ...(jointActor
          ? {
              floorJoints: {
                actor: jointActor,
                width: isUmojan ? 0.34 : 0.29,
                height: 0.075,
                segmentLength: 4.5,
              },
            }
          : {}),
        ...(perimeterActor
          ? {
              perimeter: {
                actor: perimeterActor,
                spacing: 4.8,
                height: 2.7,
                depth: 1.8,
                ...(set.id === "Aiur4City"
                  ? { corner: { actor: "Aiur_CliffCorner", scale: 1.2 } }
                  : {}),
              },
            }
          : {}),
      },
      spaces,
      passages,
      terraces,
    },
  });
  if (compactSide) {
    const family = kind === "city" ? 0 : (args.topologySeed ?? seed) % 3;
    const compact = compactFacilityLayout(family, pick("setback", 3));
    const [left, bottom, right, top] = compact.gallery;
    const galleryId = ["MainGallery", "CrossHall", "CentralCourt"][family];
    spaces.push({
      id: galleryId,
      role: "courtyard",
      ...rect((left + right) / 2, (bottom + top) / 2, right - left, top - bottom),
      floor: road,
      trim: circulationTrim,
      roomComposition: {
        activity: "circulation",
        placement: "wall",
        aisleWidth: 4,
        side: face(family === 1 ? "north" : "east"),
        tileSet: set.id,
        seed: seedFor(seed, zone.id + "/gallery") >>> 0,
      },
    });
    passages.push({
      id: "SiteEntrance",
      width: 6,
      floor: road,
      trim: circulationTrim,
      from: { space: galleryId, side: face("south") },
      waypoints: [local(0, site.bottom - 1)],
    });
    const upperRooms = order.filter(({ placement }) => placement === "upper");
    if (upperRooms.length > 1) throw Error("WORLD_INTENT_MULTIPLE_UPPER_ROOMS: " + zone.id);
    const upperRoom =
      upperRooms[0] ??
      (zone.raised ? (order.find(({ role }) => role === "lab") ?? order.at(-1)) : undefined);
    for (const [i, geometry] of compact.rooms.entries()) {
      const room = order[i];
      const { role } = room;
      const [a, b, c, d] = geometry.bounds;
      const id = "Room" + (i + 1);
      const side = geometry.gallerySide;
      const across = compactPassage(compact.gallery, geometry);
      const axis = side === "north" || side === "south" ? (a + c) / 2 : (b + d) / 2;
      const upper = room === upperRoom;
      const activity = room.activity ?? roomActivity(role, upper);
      const floor = roomFloor(role, i);
      const workFloor = roomFloors.find((value) => value !== floor && value !== road);
      // Reserve the doorway and put the main group on the opposite, uninterrupted wall.
      const workSide = side;
      const inset = workSide === "west" || workSide === "east";
      const shift = workSide === "west" || workSide === "south" ? -2 : 2;
      const roomRect = rect((a + c) / 2, (b + d) / 2, c - a, d - b);
      if (upper) {
        const deck = compactWorkDeck(roomRect, face(workSide));
        if (!deck) throw Error("WORLD_INTENT_TERRACE_CLEARANCE: " + zone.id + "/" + role);
        terraces.push({
          id: "UpperWorkBay",
          min: deck.min,
          max: deck.max,
          floor: workFloor ?? floor,
          faceActor: asset?.retainingWall,
          faceStyle: "square",
          stairs: [{ ...deck.stair, treadActor: asset?.trim }],
        });
      }
      spaces.push({
        id,
        role,
        ...roomRect,
        floor,
        trim,
        roomComposition: {
          activity,
          placement: upper ? "upper" : (room.placement ?? "wall"),
          side: face(workSide),
          tileSet: set.id,
          seed: seedFor(seed, zone.id + "/" + id + "/composition") >>> 0,
          density: room.density,
          condition: room.condition,
          aisleWidth: room.aisleWidth,
        },
        ...(asset && kind === "lab" && role !== "courtyard"
          ? { walls: { actor: asset.wall, sides: [...sides] } }
          : {}),
        ...(!upper && workFloor && !["circulation", "garden", "plaza"].includes(activity)
          ? {
              inlays: [
                {
                  ...bounds({
                    left: a + 4 + (inset ? shift : 0),
                    right: c - 4 + (inset ? shift : 0),
                    bottom: b + 4 + (inset ? 0 : shift),
                    top: d - 4 + (inset ? 0 : shift),
                  }),
                  floor: workFloor,
                },
              ],
            }
          : {}),
      });
      passages.push({
        id: "Access" + i,
        width: 4,
        floor: road,
        trim: circulationTrim,
        from: { space: galleryId, side: face(side), offset: rotateOffset(side, across) },
        to: {
          space: id,
          side: face(opposite[side]),
          offset: rotateOffset(opposite[side], across - axis),
        },
      });
    }
    return assemble();
  }
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
  // Shift the two wings independently to produce staggered cross-halls.
  const wingOffset = (i: number) => (isNova ? pick("wing-offset/" + (i % 2), 3) - 1 : 0);
  const split = spineV + (pick("row-split", 5) - 2);
  const hallW = spineWidth / 2;
  const upperIndex = order.findIndex((room) => room.placement === "upper");
  if (order.filter((room) => room.placement === "upper").length > 1)
    throw Error("WORLD_INTENT_MULTIPLE_UPPER_ROOMS: " + zone.id);
  const labIndex = order.findIndex(({ role }) => role === "lab");
  const raisedIndex =
    upperIndex >= 0
      ? upperIndex
      : zone.raised || (isNova && labIndex >= 0 && twoRows)
        ? labIndex >= 0
          ? labIndex
          : order.length - 1
        : -1;
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
    const v = outerY + wingOffset(i);
    const id = "Room" + (i + 1);
    const floor = roomFloor(role, i);
    const closed = kind === "lab" && role !== "courtyard";
    const outerSide = sign > 0 ? "east" : "west";
    const upper = i === raisedIndex;
    const activity = room.activity ?? roomActivity(role, upper);
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
      ...(!upper &&
      workFloor &&
      roomW >= 18 &&
      roomH >= 14 &&
      !["circulation", "garden"].includes(activity)
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
    const service =
      i >= 2 &&
      (isNova
        ? (pick("service-network", 4) & (1 << (i - 2))) !== 0
        : pick("service-link/" + i, 2) === 1);
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
        ...(!jointActor && asset?.trim ? { threshold: asset.trim } : {}),
      });
    } else {
      passages.push({
        id: "Access" + i,
        width: 4,
        floor: road,
        trim: circulationTrim,
        from: { space: spine, side: face(hallSide), offset: rotateOffset(hallSide, v - spineV) },
        to: { space: id, side: face(roomSide) },
        ...(!jointActor && asset?.trim ? { threshold: asset.trim } : {}),
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
      if (
        (isUmojan || isNova) &&
        activity === "containment" &&
        upperFloor &&
        upperFloor !== floor
      ) {
        const roomBounds = bounds({
          left: u - roomW / 2,
          right: u + roomW / 2,
          bottom: v - roomH / 2,
          top: v + roomH / 2,
        });
        const inlayMin = {
          x: Math.max(min.x + (stairSide === "west" ? 2 : 1), roomBounds.min.x + 2),
          y: Math.max(min.y + (stairSide === "south" ? 2 : 1), roomBounds.min.y + 2),
        };
        const inlayMax = {
          x: Math.min(max.x - (stairSide === "east" ? 2 : 1), roomBounds.max.x - 2),
          y: Math.min(max.y - (stairSide === "north" ? 2 : 1), roomBounds.max.y - 2),
        };
        if (inlayMin.x < inlayMax.x && inlayMin.y < inlayMax.y)
          spaces.at(-1)!.inlays = [{ min: inlayMin, max: inlayMax, floor: upperFloor }];
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
  return assemble();
}
