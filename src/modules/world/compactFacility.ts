type Side = "south" | "east" | "north" | "west";
type Bounds = [left: number, bottom: number, right: number, top: number];
type Room = { bounds: Bounds; gallerySide: Side };

const courtyard: Room[] = [
  { bounds: [-25, -10, -9, 8], gallerySide: "west" },
  { bounds: [9, -10, 25, 8], gallerySide: "east" },
  { bounds: [-23, 11, -1, 23], gallerySide: "north" },
  { bounds: [1, 11, 23, 23], gallerySide: "north" },
];

function wings(setback: number): Room[] {
  return [
    { bounds: [-24, -23 + setback, -6, -7 + setback], gallerySide: "south" },
    { bounds: [6, -23, 24, -7], gallerySide: "south" },
    { bounds: [-24, 7, -6, 23], gallerySide: "north" },
    { bounds: [6, 8 - setback, 24, 24 - setback], gallerySide: "north" },
  ];
}

function spine(setback: number): Room[] {
  return [
    { bounds: [-25, -22, -7, -4], gallerySide: "west" },
    { bounds: [7, -22 + setback, 25, -4 + setback], gallerySide: "east" },
    { bounds: [-25, 4 - setback, -7, 22 - setback], gallerySide: "west" },
    { bounds: [7, 4, 25, 22], gallerySide: "east" },
  ];
}

export function compactFacilityLayout(
  family: number,
  setback: number,
): { gallery: Bounds; rooms: Room[] } {
  if (family === 2) return { gallery: [-7, -7, 7, 7], rooms: courtyard };
  if (family === 1) return { gallery: [-22, -4, 22, 4], rooms: wings(setback) };
  return { gallery: [-5, -21, 5, 21], rooms: spine(setback) };
}

export const opposite: Record<Side, Side> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
};

export function compactPassage(gallery: Bounds, room: Room) {
  const { gallerySide: side, bounds } = room;
  const i = side === "east" || side === "west" ? 1 : 0;
  const min = Math.max(gallery[i], bounds[i]);
  const max = Math.min(gallery[i + 2], bounds[i + 2]);
  return Math.floor((min + max) / 2);
}

/** A level deck sits against the wall furthest from the existing doorway. */
export function compactWorkDeck(
  room: { center: { x: number; y: number }; width: number; height: number },
  rear: Side,
) {
  const vertical = rear === "east" || rear === "west";
  const axis = vertical ? "x" : "y";
  const across = vertical ? "y" : "x";
  const depth = vertical ? room.width : room.height;
  const breadth = vertical ? room.height : room.width;
  if (depth < 16 || breadth < 14) return undefined;
  const center = room.center[axis];
  const tangent = 2 * Math.floor(room.center[across] / 2) + 1;
  const positive = rear === "east" || rear === "north";
  const edge = positive
    ? 2 * Math.floor((center + depth / 2 - 2) / 2)
    : 2 * Math.ceil((center - depth / 2 + 2) / 2);
  const lo = positive ? edge - 8 : edge;
  const hi = lo + 8;
  return {
    min: vertical ? { x: lo, y: tangent - 5 } : { x: tangent - 5, y: lo },
    max: vertical ? { x: hi, y: tangent + 5 } : { x: tangent + 5, y: hi },
    stair: { side: opposite[rear], at: tangent },
  };
}
