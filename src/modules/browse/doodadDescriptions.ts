import { readFile } from "node:fs/promises";
import * as z from "zod/v4";
import { projectPath } from "../../app/paths.js";

const kind = z.enum(["built", "creature", "natural"]);
const size = z.enum(["tiny", "small", "medium", "large", "huge"]);
const role = z.enum(["cliff", "clutter", "decal", "effect", "foliage", "prop", "structure"]);
const facet = z.string().trim().min(1).max(48).toLowerCase();

export const doodadSearchSchema = z
  .object({
    kind: kind.optional(),
    size: size.optional(),
    role: role.optional(),
    biome: facet.optional(),
    story: facet.optional(),
  })
  .strict();

export type DoodadSearch = z.output<typeof doodadSearchSchema>;

const descriptionSchema = z.object({
  look: z.string(),
  kind,
  size,
  role,
  biome: z.array(z.string()),
  story: z.array(z.string()),
});

export type DoodadDescription = z.output<typeof descriptionSchema>;

export const doodadDescriptionSource = {
  credit: "SC2 doodad descriptions from TeamAntioch/sc2-asset-catalog",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  url: "https://github.com/TeamAntioch/sc2-asset-catalog/blob/5012c87a25ca938aea3ee5a4ad35a705cfc9007b/packages/sc2-asset-catalog/data/doodad-descriptions.json",
};

const ignoredWords = new Set([
  "a",
  "an",
  "and",
  "as",
  "for",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

function singular(word: string) {
  if (/(?:ches|shes|sses|xes|zzes)$/.test(word)) return word.slice(0, -2);
  return word.length > 3 && /[^su]s$/.test(word) ? word.slice(0, -1) : word;
}

export function doodadWords(text: string): string[] {
  return [
    ...new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
        .filter((word) => !ignoredWords.has(word))
        .map(singular),
    ),
  ];
}

let cached: ReturnType<typeof load> | undefined;
async function load() {
  const file = projectPath("resources/authoring-catalog/team-antioch/doodad-descriptions.json");
  const records = z
    .record(z.string(), descriptionSchema)
    .parse(JSON.parse(await readFile(file, "utf8")));
  return new Map(
    Object.entries(records).map(([id, description]) => [
      id,
      {
        description,
        words: new Set(
          doodadWords(
            [
              description.look,
              description.kind,
              description.role,
              description.size,
              ...description.biome,
              ...description.story,
            ].join(" "),
          ),
        ),
      },
    ]),
  );
}

export function readDoodadDescriptions() {
  return (cached ??= load().catch((error: unknown) => {
    cached = undefined;
    throw error;
  }));
}

export function matchesDoodadFacets(filters: DoodadSearch, value?: DoodadDescription) {
  return (
    (!filters.kind || value?.kind === filters.kind) &&
    (!filters.size || value?.size === filters.size) &&
    (!filters.role || value?.role === filters.role) &&
    (!filters.biome || value?.biome.includes(filters.biome)) &&
    (!filters.story || value?.story.includes(filters.story))
  );
}
