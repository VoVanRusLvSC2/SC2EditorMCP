import * as z from "zod/v4";
import { inspectArchive, readArchiveEntry } from "../../archive/archiveAdapter.js";
import { decodeUtf8 } from "../../core/fileTransactions.js";
import { decodeXmlValue, scanXml } from "../../core/xmlScanner.js";
import { readDocumentInfo } from "../document/codecs/metadata.js";
import { PlacementDocument } from "../placement/document.js";
import { inspectRegionXml } from "../placement/regions.js";
import { archiveSchema, projectIdSchema, sha256Schema } from "./spec.js";

const xy = z.number().min(-1_000_000).max(1_000_000);
const area = z
  .object({ minX: xy, minY: xy, maxX: xy, maxY: xy })
  .strict()
  .refine((a) => a.minX <= a.maxX && a.minY <= a.maxY, "Invalid search area");
export const missionInspectInput = z
  .object({
    projectId: projectIdSchema.optional(),
    sourceArchive: archiveSchema.optional(),
    sha256: sha256Schema,
    area: area.optional(),
    query: z.string().trim().min(1).max(96).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict()
  .refine(
    (i) => Boolean(i.projectId) !== Boolean(i.sourceArchive),
    "Select a project or source archive",
  );

export async function inspectMissionArchive(
  file: string,
  input: z.output<typeof missionInspectInput>,
) {
  const archive = await inspectArchive(file);
  const entries = archive.entries.filter((entry) => !entry.internal);
  const neutral = new Map(
    entries
      .filter((entry) => !entry.locale)
      .map((entry) => [entry.name.replaceAll("\\", "/").toLowerCase(), entry]),
  );
  const component = async (name: string) => {
    const entry = neutral.get(name.toLowerCase());
    if (!entry) return { status: "absent" as const };
    if (entry.size > 1024 * 1024) return { status: "too_large" as const };
    return { status: "read" as const, bytes: await readArchiveEntry(file, name) };
  };
  const [objects, triggers, info, nativeRegions] = await Promise.all([
    component("Objects"),
    component("Triggers"),
    component("DocumentInfo"),
    component("Regions"),
  ]);
  const query = input.query?.toLowerCase();
  const match = (...values: Array<string | number | undefined>) =>
    !query ||
    values.some((value) =>
      String(value ?? "")
        .toLowerCase()
        .includes(query),
    );
  const rows =
    objects.status === "read"
      ? new PlacementDocument(decodeUtf8(objects.bytes!, "Objects")).list()
      : [];
  const totalByKind: Record<string, number> = Object.create(null);
  const placements = [];
  for (const row of rows) {
    totalByKind[row.kind] = (totalByKind[row.kind] ?? 0) + 1;
    const { area } = input;
    const [x, y, z] = row.position?.split(",").map(Number) ?? [];
    const position = [x, y, z].every(Number.isFinite) ? { x, y, z } : undefined;
    if (area && (!position || x < area.minX || x > area.maxX || y < area.minY || y > area.maxY))
      continue;
    if (match(row.id, row.kind, row.catalogId, row.attributes.Name))
      placements.push({
        id: row.id,
        kind: row.kind,
        catalogId: row.catalogId,
        name: row.attributes.Name,
        position,
      });
  }
  const bindings = [];
  const regions =
    nativeRegions.status === "read"
      ? inspectRegionXml(decodeUtf8(nativeRegions.bytes!, "Regions")).filter((region) =>
          match(region.id, region.name),
        )
      : [];
  if (triggers.status === "read") {
    const source = decodeUtf8(triggers.bytes!, "Triggers");
    const xml = scanXml(source);
    if (xml.diagnostics.some((issue) => issue.severity === "error"))
      throw Error("MISSION_TRIGGER_INDEX_INVALID");
    for (const node of xml.nodes) {
      const { Id: id, Type: kind } = node.attrs;
      if (
        node.tag !== "Element" ||
        !id ||
        !["Category", "Trigger", "FunctionDef", "Variable", "CustomScript"].includes(kind)
      )
        continue;
      const identifier = node.childIds
        .map((child) => xml.nodes[child])
        .find((child) => child.tag === "Identifier");
      const name =
        identifier && decodeXmlValue(source.slice(identifier.startTagEnd, identifier.endTagStart));
      const scope = node.parentId == null ? undefined : xml.nodes[node.parentId].attrs.Id;
      if (match(id, kind, name, scope)) bindings.push({ id, kind, name, scope });
    }
  }
  const dependencies = info.status === "read" ? readDocumentInfo(info.bytes!).dependencies : [];
  const catalogs = [...neutral.values()]
    .map(({ name }) => name.replaceAll("\\", "/"))
    .filter((name) => /^base\.sc2data\/gamedata\/.*\.xml$/i.test(name) && match(name));
  return {
    componentCount: entries.length,
    regions: {
      status: nativeRegions.status,
      matched: regions.length,
      items: regions.slice(0, input.limit),
    },
    dependencies: {
      status: info.status,
      total: dependencies.length,
      items: dependencies.slice(0, input.limit),
    },
    placements: {
      status: objects.status,
      totalByKind,
      matched: placements.length,
      items: placements.slice(0, input.limit),
    },
    gui: {
      status: triggers.status,
      matched: bindings.length,
      items: bindings.slice(0, input.limit),
    },
    data: { matched: catalogs.length, files: catalogs.slice(0, input.limit) },
  };
}
