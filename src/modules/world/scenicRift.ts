import type { TerrainArea, TerrainOperation } from "../terrain/types.js";

type RiftBand = Extract<TerrainArea, { type: "rectangle" }>;

/** Paint an art-directed rift cut from default level 1 to native level 0. */
export function planScenicRift(bands: readonly RiftBand[], cliffSet = 0): TerrainOperation[] {
  return bands.map(area => ({ op: "cliff.paint", area, parameters: { level: 0, cliffSet } }));
}
