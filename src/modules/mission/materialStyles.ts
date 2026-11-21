import * as z from "zod/v4";
import { StyleCatalog } from "../placement/styleCatalog.js";

const roles = ["ground", "trail", "rock", "vegetation", "floor", "trim"] as const;
type Role = (typeof roles)[number];
type Notes = Record<string, Record<string, { description: string; roles: Role[] }>>;
const tags: Record<Role, RegExp> = {
  ground: /grass|sand|soil|dirt|snow|ash/i,
  trail: /road|gravel|path|dirt|pebble/i,
  rock: /rock|stone|scree|cliff/i,
  vegetation: /vine|foliage|moss|lea(?:f|ves)|grass/i,
  floor: /concrete|metal|pavement|plate/i,
  trim: /panel|trim|border|tile|paver/i,
};
export const missionMaterialsInput = z
  .object({
    tileSet: z.string().min(1).max(128),
    role: z.enum(roles).optional(),
    query: z.string().trim().max(128).optional(),
  })
  .strict();

export async function missionMaterialCatalog(
  input: z.output<typeof missionMaterialsInput>,
  catalog = new StyleCatalog(),
) {
  const [pack, notes] = await Promise.all([
    catalog.pack(input.tileSet),
    catalog.read<Notes>("style_rules/texture_descriptions.json"),
  ]);
  const items = pack.texture_ids.map((id) => {
    const note = notes[input.tileSet]?.[id];
    // Strip the tileset prefix from normal identifiers. A bare number carries no material meaning.
    const words = id.toLowerCase().startsWith(input.tileSet.toLowerCase())
      ? id.slice(input.tileSet.length)
      : id;
    const inferred = roles.filter((role) => tags[role].test(words));
    return {
      id,
      description: note?.description,
      roles: note?.roles ?? inferred,
      evidence: note
        ? "REVIEWED_TEXTURE_PREVIEW"
        : inferred.length
          ? "INFERRED_FROM_TEXTURE_ID"
          : "UNCLASSIFIED",
    };
  });
  const words = input.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  return {
    tileSet: input.tileSet,
    items: items.filter((row) => {
      const text = [row.id, row.description, ...row.roles].join(" ").toLowerCase();
      return (
        (!input.role || row.roles.includes(input.role)) &&
        words.every((word) => text.includes(word))
      );
    }),
  };
}

export function chooseMissionMaterial(
  rows: Awaited<ReturnType<typeof missionMaterialCatalog>>["items"],
  role: Role,
  excluded: (string | undefined)[] = [],
) {
  return (
    rows.find(
      (r) =>
        r.roles.includes(role) &&
        r.evidence === "REVIEWED_TEXTURE_PREVIEW" &&
        !excluded.includes(r.id),
    )?.id ?? rows.find((r) => r.roles.includes(role) && !excluded.includes(r.id))?.id
  );
}
