import * as z from "zod/v4";
import { StyleCatalog } from "../placement/styleCatalog.js";

export const campaignStyleId = z.enum(["wol", "hots", "lotv", "nova"]);
const titles = {
  wol: "Wings of Liberty",
  hots: "Heart of the Swarm",
  lotv: "Legacy of the Void",
  nova: "Nova Covert Ops",
};
type Campaign = z.output<typeof campaignStyleId>;
interface SourceMap {
  id: string;
  campaign: Campaign;
  name: { text: string };
  tileset: string;
  default_style_source: boolean;
}

export const missionStylesInput = z
  .object({
    campaign: campaignStyleId.optional(),
    query: z.string().trim().max(128).default(""),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(80).default(32),
  })
  .strict();

async function styleRows(catalog: StyleCatalog) {
  const [maps, index] = await Promise.all([
    catalog.read<SourceMap[]>("indexes/all_maps.json"),
    catalog.read<{ packs: { id: string; name: string }[] }>("mcp_view/index.json"),
  ]);
  const names = new Map(index.packs.map((pack) => [pack.id, pack.name]));
  const reference = new Map<
    string,
    {
      campaign: Campaign;
      tileSet: string;
      name: string;
      examples: { id: string; name: string }[];
    }
  >();
  for (const map of maps) {
    const name = names.get(map.tileset);
    if (!map.default_style_source || !name || !campaignStyleId.safeParse(map.campaign).success)
      continue;
    const key = map.campaign + ":" + map.tileset;
    const record = reference.get(key) ?? {
      campaign: map.campaign,
      tileSet: map.tileset,
      name,
      examples: [],
    };
    record.examples.push({ id: map.id, name: map.name.text });
    reference.set(key, record);
  }
  return [...reference.values()].sort(
    (a, b) => a.campaign.localeCompare(b.campaign) || a.tileSet.localeCompare(b.tileSet),
  );
}

export async function listMissionStyles(
  input: z.output<typeof missionStylesInput>,
  catalog = new StyleCatalog(),
) {
  const rows = await styleRows(catalog);
  const query = input.query.toLowerCase();
  const matches = rows.filter(
    (r) =>
      (!input.campaign || input.campaign === r.campaign) &&
      [r.tileSet, r.name, ...r.examples.map((m) => m.name)].some((name) =>
        name.toLowerCase().includes(query),
      ),
  );
  return {
    campaigns: Object.entries(titles).map(([id, name]) => ({
      id,
      name,
      styles: rows.filter((r) => r.campaign === id).length,
    })),
    total: matches.length,
    offset: input.offset,
    items: matches.slice(input.offset, input.offset + input.limit),
    evidence: "OBSERVED_CAMPAIGN_TILESETS_RESOLVE_INSTALLED_DEPENDENCIES_AT_BUILD",
  };
}

export async function missionStylePack(
  campaign: Campaign,
  tileSet: string,
  catalog: StyleCatalog,
): Promise<Awaited<ReturnType<StyleCatalog["pack"]>>> {
  if (
    !(await styleRows(catalog)).some((row) => row.campaign === campaign && row.tileSet === tileSet)
  )
    throw Error("MISSION_CAMPAIGN_TILESET_NOT_OBSERVED: " + campaign + "/" + tileSet);
  return catalog.pack(tileSet);
}
