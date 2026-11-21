import * as z from "zod/v4";
import { StyleCatalog } from "../placement/styleCatalog.js";
import { campaignStyleId } from "./campaignStyles.js";

export const missionDecorDensityInput = z
  .object({
    campaign: campaignStyleId.optional(),
    tileSet: z.string().trim().min(1).max(128).optional(),
    width: z.number().int().min(1).max(256).default(128),
    height: z.number().int().min(1).max(256).default(128),
  })
  .strict();

interface MapReference {
  id: string;
  source: string;
  role: string;
  file: string;
  campaign: string;
  tileset: string;
  components?: { Objects?: boolean };
}

export async function missionDecorDensity(
  args: z.output<typeof missionDecorDensityInput>,
  catalog = new StyleCatalog(),
) {
  const [index, evidence] = await Promise.all([
    catalog.read<MapReference[]>("indexes/all_maps.json"),
    catalog.read<{ map: string; area: number }[]>("mcp_view/evidence/map_areas.json"),
  ]);
  const areas = new Map(evidence.map(({ map, area }) => [map, area]));
  const relevant = index.filter(
    (m) =>
      m.role === "main" &&
      m.components?.Objects &&
      (!args.campaign || args.campaign === m.campaign) &&
      (!args.tileSet || args.tileSet.toLowerCase() === m.tileset.toLowerCase()) &&
      (areas.get(m.source) ?? 0) > 0,
  );
  const densities = (
    await Promise.all(
      relevant.map(async (m) => {
        const { doodads } = await catalog.read<{ doodads: { id: string; count: number }[] }>(
          m.file,
        );
        const props = doodads.filter(
          ({ id }) =>
            !/pathing|creepblocker|placementblocker|invisibleblocker|lineofsightblocker|visionblocker/i.test(
              id,
            ),
        );
        return (props.reduce((sum, row) => sum + row.count, 0) * 1024) / areas.get(m.source)!;
      }),
    )
  ).sort((a, b) => a - b);
  const values = densities.length
    ? [0.25, 0.5, 0.75].map((p) => densities[Math.round((densities.length - 1) * p)])
    : undefined;
  return {
    samples: densities.length,
    per32x32: values?.map((value) => Number(value.toFixed(1))) ?? null,
    forMap: values?.map((value) => Math.round((value * args.width * args.height) / 1024)) ?? null,
    percentiles: ["p25", "median", "p75"],
    basis: "full terrain area; authored doodads, excluding named blockers and pathing helpers",
  };
}
