import type { MissionPack } from "../../mission-sdk.js";

// Facing-strip observations for variation zero. See docs/MISSION_SDK.md for provenance.
const source = "TeamAntioch/sc2-adjutant@69140d7/packages/core/data/doodad-facings.json";
const stock: MissionPack["facings"] = [
  { actor: "CastanarWorkstation", frontDegrees: 270, standOff: 2.6, height: 0 },
  { actor: "CastanarMonitorFloor", frontDegrees: 270, standOff: 2.6, height: 0 },
  { actor: "CastanarLightboard", frontDegrees: 270, standOff: 1.9, height: 2.2 },
  { actor: "DOM_LabConsoles", frontDegrees: 270, standOff: 2.6, height: 0 },
  { actor: "CompoundSewers_Tank", frontDegrees: 180, standOff: 2.6, height: 0 },
].map((f) => ({ ...f, variation: 0, source }));

export function measuredFacing(
  actor: string,
  variation: number,
  overrides?: MissionPack["facings"],
) {
  const matches = (f: MissionPack["facings"][number]) =>
    f.actor === actor && f.variation === variation;
  return overrides?.find(matches) ?? stock.find(matches);
}
