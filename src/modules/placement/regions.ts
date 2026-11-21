import * as z from "zod/v4";
import type { Workspace } from "../../core/workspace.js";
import { bytesHash } from "../../core/binaryTransactions.js";
import { decodeUtf8 } from "../../core/fileTransactions.js";
import { decodeXmlValue, scanXml } from "../../core/xmlScanner.js";
import type { XmlNode } from "../../core/types.js";
import { readVersion, versionMarker } from "../document/codecs/metadata.js";
import { MapInfoDocument } from "../map/mapInfo.js";

const coordinate = z.number().min(0).max(256);
const name = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32));
const id = z.number().int().min(1).max(2_147_483_647);
const shape = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("circle"),
      x: coordinate,
      y: coordinate,
      radius: z.number().positive().max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal("rectangle"),
      minX: coordinate,
      minY: coordinate,
      maxX: coordinate,
      maxY: coordinate,
    })
    .strict(),
]);
export const regionApplyInput = z
  .object({
    directory: z.string().default(""),
    expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
    operations: z
      .array(
        z.discriminatedUnion("op", [
          z.object({ op: z.literal("create"), name, shape }).strict(),
          z.object({ op: z.literal("delete"), id }).strict(),
          z
            .object({ op: z.literal("update"), id, name: name.optional(), shape: shape.optional() })
            .strict()
            .refine(
              (a) => a.name !== undefined || a.shape !== undefined,
              "Specify a name or shape to update",
            ),
        ]),
      )
      .min(1)
      .max(64),
    dryRun: z.boolean().default(true),
    stage: z.boolean().default(true),
    backup: z.boolean().default(true),
  })
  .strict();

const files = [
  "Regions",
  "Regions.version",
  "ComponentList.SC2Components",
  "MapInfo",
  "MapInfo.version",
] as const;
const escape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const number = (n: number) => Number(n.toFixed(5)).toString();
const newline = (s: string) => (s.includes("\r\n") ? "\r\n" : "\n");

function document(source: string, tag: string) {
  const xml = scanXml(source);
  const root = xml.rootIds.length === 1 ? xml.nodes[xml.rootIds[0]] : undefined;
  if (!root || root.tag !== tag || xml.diagnostics.some((issue) => issue.severity === "error"))
    throw Error("REGION_INVALID_" + tag.toUpperCase());
  return {
    root,
    children: (node: XmlNode, kind?: string) =>
      node.childIds.map((child) => xml.nodes[child]).filter((child) => !kind || child.tag === kind),
  };
}

function append(source: string, root: XmlNode, line: string) {
  const nl = newline(source);
  return root.selfClosing
    ? source.slice(0, root.startTagEnd).replace(/\/\s*>$/, ">") +
        nl +
        line +
        nl +
        "</" +
        root.tag +
        ">" +
        source.slice(root.end)
    : source.slice(0, root.endTagStart) + line + nl + source.slice(root.endTagStart);
}

function readRegions(source: string) {
  const { root, children } = document(source, "Regions");
  const ids = new Set<number>();
  const rows = children(root, "region").map((node) => {
    const key = Number(node.attrs.id);
    if (!/^\d+$/.test(node.attrs.id) || !id.safeParse(key).success || ids.has(key))
      throw Error("REGION_DUPLICATE_OR_INVALID_ID: " + node.attrs.id);
    ids.add(key);
    return {
      id: key,
      node,
      names: children(node, "name"),
      shapes: children(node, "shape"),
      children,
    };
  });
  return { root, rows };
}

export function inspectRegionXml(source: string) {
  return readRegions(source).rows.map((row) => ({
    id: row.id,
    name: row.names[0]?.attrs.value,
    shapes: row.shapes.map((s) => ({
      type: s.attrs.type,
      fields: Object.fromEntries(row.children(s).map((n) => [n.tag, n.attrs.value])),
    })),
  }));
}

function renderShape(input: z.output<typeof shape>, map: MapInfoDocument) {
  const { width, height } = map;
  if (input.type === "circle") {
    if (Number(number(input.radius)) <= 0) throw Error("REGION_SUBPRECISION_RADIUS");
    if (
      input.x - input.radius < 0 ||
      input.y - input.radius < 0 ||
      input.x + input.radius > width ||
      input.y + input.radius > height
    )
      throw Error("REGION_OUTSIDE_MAP");
    return (
      '<shape type="circle"><center value="' +
      number(input.x) +
      "," +
      number(input.y) +
      '"/><radius value="' +
      number(input.radius) +
      '"/></shape>'
    );
  }
  if (
    Number(number(input.maxX)) <= Number(number(input.minX)) ||
    Number(number(input.maxY)) <= Number(number(input.minY)) ||
    input.maxX > width ||
    input.maxY > height
  )
    throw Error("REGION_INVALID_RECTANGLE_OR_BOUNDS");
  return (
    '<shape type="rect"><quad value="' +
    [input.minX, input.maxX, input.minY, input.maxY].map(number).join(",") +
    '"/></shape>'
  );
}

function componentRegistration(source: string) {
  const { root, children } = document(source, "Components");
  const matches = children(root).filter((n) => n.attrs.Type?.toLowerCase() === "regi");
  if (
    matches.length > 1 ||
    matches.some(
      (n) =>
        !["DataComponent", "Component"].includes(n.tag) ||
        n.attrs.Locale ||
        n.childIds.length ||
        decodeXmlValue(source.slice(n.startTagEnd, n.endTagStart)).trim() !== "Regions",
    )
  )
    throw Error("REGION_COMPONENT_REGISTRATION_CONFLICT");
  return matches.length
    ? source
    : append(source, root, '    <DataComponent Type="regi">Regions</DataComponent>');
}

function pathKeys(workspace: Workspace, directory: string) {
  return files.map((file) => workspace.binary.key(directory ? directory + "/" + file : file));
}
const empty = '<?xml version="1.0" encoding="utf-8"?>\r\n<Regions/>\r\n';
const revision = (buffers: Buffer[]) =>
  bytesHash(Buffer.from(JSON.stringify(buffers.map(bytesHash))));

function hasRegionReference(sources: string[], id: number, name: string | undefined) {
  const directId = new RegExp("\\bRegionFromId\\s*\\(\\s*" + id + "\\s*\\)");
  const nameCalls = /\bRegionFromName\s*\(\s*"((?:\\.|[^"\\])*)"\s*\)/g;
  if (
    sources.some((source) => {
      const text = source.replaceAll("&quot;", '"');
      if (directId.test(text)) return true;
      return (
        name !== undefined &&
        [...text.matchAll(nameCalls)].some(
          (call) => call[1] === name || call[1] === JSON.stringify(name).slice(1, -1),
        )
      );
    })
  )
    return true;
  const { nodes } = scanXml(sources[1] ?? "");
  return nodes.some((node) => {
    if (
      node.tag !== "ValueType" ||
      node.attrs.Type?.toLowerCase() !== "region" ||
      node.parentId === null
    )
      return false;
    return nodes[node.parentId].childIds.some(
      (child) =>
        nodes[child].tag === "ValueId" &&
        Number(nodes[child].attrs.Id ?? nodes[child].attrs.Value) === id,
    );
  });
}

export class RegionWorkspace {
  constructor(private readonly workspace: Workspace) {}

  async inspect(directory: string) {
    const keys = pathKeys(this.workspace, directory);
    const snapshots = await Promise.all(keys.map((key) => this.workspace.binary.read(key)));
    const buffers = snapshots.map((file) => file.bytes);
    return {
      file: keys[0],
      sha256: revision(buffers),
      regions: inspectRegionXml(buffers[0].length ? decodeUtf8(buffers[0], keys[0]) : empty),
      editorVerified: false,
    };
  }

  async apply(input: z.input<typeof regionApplyInput>) {
    const args = regionApplyInput.parse(input);
    const keys = pathKeys(this.workspace, args.directory);
    const [regionKey, versionKey, manifestKey, mapKey, donorKey] = keys;
    const references = args.operations.some(({ op }) => op === "delete")
      ? ["MapScript.galaxy", "Triggers"].map((file) =>
          this.workspace.binary.key(args.directory ? args.directory + "/" + file : file),
        )
      : [];
    const createdIds: number[] = [];
    const deletedIds: number[] = [];
    const transaction = await this.workspace.binary.apply(
      [...keys, ...references],
      (sources) => {
        if (revision(keys.map((key) => sources.get(key)!)) !== args.expectedSha256)
          throw Error("STALE_REGION_REVISION");
        const map = new MapInfoDocument(sources.get(mapKey)!);
        const initial = sources.get(regionKey)!;
        let xml = initial.length ? decodeUtf8(initial, regionKey) : empty;
        const originalRows = readRegions(xml).rows;
        let highestId = originalRows.reduce((max, row) => Math.max(max, row.id), 0);
        const script = references.map((file) => decodeUtf8(sources.get(file)!, file));
        for (const op of args.operations) {
          const { root, rows } = readRegions(xml);
          if (op.op === "delete") {
            const row = rows.find((r) => r.id === op.id);
            if (!row) throw Error("REGION_ID_NOT_FOUND: " + op.id);
            const originalName = originalRows.find((r) => r.id === row.id)?.names[0]?.attrs.value;
            if (
              [...new Set([row.names[0]?.attrs.value, originalName])].some((name) =>
                hasRegionReference(script, row.id, name),
              )
            )
              throw Error("REGION_HAS_LITERAL_SCRIPT_REFERENCE: " + op.id);
            xml = xml.slice(0, row.node.start) + xml.slice(row.node.end);
            deletedIds.push(op.id);
            continue;
          }
          if (
            op.name &&
            rows.some(
              (row) =>
                row.names.some((n) => n.attrs.value === op.name) &&
                (op.op === "create" || row.id !== op.id),
            )
          )
            throw Error("REGION_NAME_CONFLICT: " + op.name);
          const replacement = op.shape && renderShape(op.shape, map);
          if (op.op === "create") {
            const next = ++highestId;
            id.parse(next);
            createdIds.push(next);
            xml = append(
              xml,
              root,
              '    <region id="' +
                next +
                '"><name value="' +
                escape(op.name) +
                '"/>' +
                replacement +
                "</region>",
            );
            continue;
          }
          const row = rows.find((r) => r.id === op.id);
          if (!row) throw Error("REGION_ID_NOT_FOUND: " + op.id);
          const edits: { start: number; end: number; text: string }[] = [];
          if (op.name !== undefined) {
            const span =
              row.names.length === 1
                ? row.names[0].attrSpans.find((a) => a.name === "value")
                : undefined;
            if (!span) throw Error("REGION_NAME_FIELD_UNSUPPORTED");
            edits.push({ start: span.valueStart, end: span.valueEnd, text: escape(op.name) });
          }
          if (replacement) {
            const current = row.shapes[0];
            const fields =
              current &&
              (current.attrs.type === "rect"
                ? ["quad"]
                : current.attrs.type === "circle"
                  ? ["center", "radius"]
                  : []);
            if (
              row.shapes.length !== 1 ||
              !fields?.length ||
              Object.keys(current.attrs).length !== 1 ||
              /<!--|<!\[CDATA\[|<\?/.test(xml.slice(current.startTagEnd, current.endTagStart)) ||
              current.childIds.length !== fields.length ||
              fields.some((field) => {
                const matches = row.children(current, field);
                return (
                  matches.length !== 1 ||
                  Object.keys(matches[0].attrs).join() !== "value" ||
                  !matches[0].selfClosing
                );
              })
            )
              throw Error("REGION_SHAPE_HAS_UNSUPPORTED_FIELDS");
            edits.push({ start: current.start, end: current.end, text: replacement });
          }
          for (const edit of edits.sort((a, b) => b.start - a.start))
            xml = xml.slice(0, edit.start) + edit.text + xml.slice(edit.end);
        }
        const next = new Map(sources);
        next.set(regionKey, Buffer.from(xml));
        const marker = sources.get(versionKey)!;
        const source = readVersion(marker.length ? marker : sources.get(donorKey)!);
        if (source.tag !== (marker.length ? "regi" : "mapi")) throw Error("REGION_VERSION_TAG");
        next.set(
          versionKey,
          versionMarker("regi", source, source.timestamp, readRegions(xml).rows.length),
        );
        next.set(
          manifestKey,
          Buffer.from(componentRegistration(decodeUtf8(sources.get(manifestKey)!, manifestKey))),
        );
        return next;
      },
      { dryRun: args.dryRun, stage: args.stage, backup: args.backup },
    );
    return { ...transaction, createdIds, deletedIds, editorVerified: false };
  }
}
