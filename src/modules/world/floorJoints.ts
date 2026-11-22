import type { TerrainState } from "../terrain/operations.js";
import type { Structures } from "./structures.js";
import { facilityRimBlocks, perimeterBlocks } from "./facility.js";

type JointStyle = NonNullable<Structures["facility"]["grounds"][number]["floorJoints"]>;
export type FloorJoint = {
  zone: string;
  vertical: boolean;
  fixed: number;
  from: number;
  to: number;
  style: JointStyle;
};

/** Trace material changes at the texel boundary, after overlay priorities have been applied. */
export function traceFacilityFloorJoints(
  structures: Structures,
  state: TerrainState,
): FloorJoint[] {
  const masks = state.masks!;
  const texels = 8;
  const joints: FloorJoint[] = [];
  for (const ground of structures.facility.grounds) {
    const style = ground.floorJoints;
    if (!style) continue;
    const { minX, minY, maxX, maxY } = ground.area;
    const width = (maxX - minX) * texels;
    const height = (maxY - minY) * texels;
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cellX = minX + Math.floor(x / texels);
        const cellY = minY + Math.floor(y / texels);
        if (state.descriptor.blockSet(cellX, cellY) !== ground.bank) continue;
        for (let slot = 0; slot < 8; slot++) {
          if (masks.get(minX * texels + x, minY * texels + y, slot) !== 15) continue;
          pixels[y * width + x] = slot + 1;
          break;
        }
      }
    }
    const rooms = structures.facility.spaces.filter((space) => space.zone === ground.zone);
    const perimeter = structures.perimeter.filter((edge) => edge.zone === ground.zone);
    for (const vertical of [true, false]) {
      const across = vertical ? width : height;
      const along = vertical ? height : width;
      const originAlong = vertical ? minY : minX;
      for (let fixedIndex = 1; fixedIndex < across; fixedIndex++) {
        const fixed = (vertical ? minX : minY) + fixedIndex / texels;
        let first = -1;
        for (let i = 0; i <= along; i++) {
          const index = vertical ? i * width + fixedIndex : fixedIndex * width + i;
          const a = pixels[index],
            b = pixels[index - (vertical ? 1 : width)];
          let joins = i < along && a !== 0 && b !== 0 && a !== b;
          if (joins) {
            const moving = originAlong + (i + 0.5) / texels;
            const p = vertical ? { x: fixed, y: moving } : { x: moving, y: fixed };
            const sample = (offset: number) =>
              state.heights.sample(
                vertical ? { x: p.x + offset, y: p.y } : { x: p.x, y: p.y + offset },
              ).height;
            joins =
              !rooms.some((space) => facilityRimBlocks(space, p)) &&
              !perimeter.some((edge) => perimeterBlocks(edge, p, style.width / 2)) &&
              Math.abs(sample(style.width / 2) - sample(-style.width / 2)) <= 0.18;
          }
          if (joins) {
            if (first < 0) first = i;
          } else if (first >= 0) {
            if (i - first >= texels)
              joints.push({
                zone: ground.zone,
                vertical,
                fixed,
                from: originAlong + first / texels,
                to: originAlong + i / texels,
                style,
              });
            first = -1;
          }
        }
      }
    }
  }
  return joints;
}
