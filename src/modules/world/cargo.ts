import * as z from "zod/v4";

export const cargoBay = z
  .object({
    kind: z.enum(["freight", "specimen", "utility"]),
    side: z.enum(["south", "east", "north", "west"]),
    corner: z.enum(["start", "end"]),
    staggered: z.literal(true).optional(),
  })
  .strict();

type Bay = z.output<typeof cargoBay>;

// SC2 has Crater doodads whose names include "Crate".
export const isCargoProp = (id: string) => /crate(?!r)|pallet/i.test(id);

const kits = {
  freight: [
    { actor: "DOM_LabCrates", count: 2, spacing: 2.7, inset: 2.2, along: 0 },
    { actor: "UmojanLabCrates", count: 3, spacing: 1.4, inset: 4.3, along: 0.9 },
    { actor: "UmojanLabCratePhysics", count: 2, spacing: 1.1, inset: 4.5, along: -2.35 },
    { actor: "LandingLights", count: 1, spacing: 1, inset: 2, along: -3.1 },
  ],
  specimen: [
    { actor: "UmojanLabZergCrates", count: 1, spacing: 1, inset: 2.7, along: 0.4 },
    { actor: "UmojanLabCrates", count: 2, spacing: 1.4, inset: 5, along: 1 },
    { actor: "UmojanLabConsoleSmall", count: 1, spacing: 1, inset: 3.3, along: -2.6 },
  ],
  utility: [
    { actor: "ValhallaGenerator", count: 1, spacing: 1, inset: 2.8, along: -0.3 },
    { actor: "CompoundSewers_Fan", count: 1, spacing: 1, inset: 3.1, along: -3 },
    { actor: "UmojanLabCratePhysics", count: 3, spacing: 1.15, inset: 5.3, along: -0.8 },
  ],
} as const;

const staggeredFreight = [
  { actor: "DOM_LabCrates", count: 1, spacing: 1, inset: 2.35, along: 0.9 },
  { actor: "DOM_LabCrates", count: 1, spacing: 1, inset: 3.25, along: -1.95 },
  { actor: "UmojanLabCrates", count: 2, spacing: 1.3, inset: 4.5, along: 1.25 },
  { actor: "UmojanLabCratePhysics", count: 2, spacing: 1.1, inset: 5.2, along: -2.65 },
  { actor: "LandingLights", count: 1, spacing: 1, inset: 2, along: -3.7 },
] as const;

export function cargoBayFixtures(
  space: { id: string; width: number; height: number; shape: string },
  bay: Bay,
) {
  const across = bay.side === "north" || bay.side === "south";
  const edgeLength = across ? space.width : space.height;
  const depth = across ? space.height : space.width;
  if (space.shape !== "rectangle" || edgeLength < 10 || depth < 8)
    throw Error("WORLD_CARGO_BAY_CLEARANCE: " + space.id);
  const sign = bay.corner === "end" ? 1 : -1;
  const center = edgeLength / 2 - 4.5;
  if (bay.staggered && bay.kind !== "freight")
    throw Error("WORLD_CARGO_BAY_STAGGERED_REQUIRES_FREIGHT: " + space.id);
  const rows = bay.staggered ? staggeredFreight : kits[bay.kind];
  return rows.map(({ along, ...row }) => ({
    ...row,
    side: bay.side,
    offset: sign * (center + along),
  }));
}
