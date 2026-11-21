import { promises as fs } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { safeArchivePath } from "../../archive/archiveAdapter.js";
import { bytesHash } from "../../core/binaryTransactions.js";
import { decodeUtf8 } from "../../core/fileTransactions.js";
import type { XmlNode } from "../../core/types.js";
import type { Workspace } from "../../core/workspace.js";
import { decodeXmlValue, scanXml } from "../../core/xmlScanner.js";
import { Reader, Writer, readDocumentHeader, readDocumentInfo } from "./codecs/metadata.js";
import { escapeXml } from "./schemas.js";

const manifestName = "ComponentList.SC2Components";
const directory = z.string().max(1024).default("");
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const options = {
  directory,
  expectedSha256: revision,
  dryRun: z.boolean().default(true),
  stage: z.boolean().default(true),
};
const componentPath = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    try {
      safeArchivePath(value);
      return true;
    } catch {
      return false;
    }
  }, "Expected a relative SC2 component path");
const typeCode = z.string().regex(/^[A-Za-z0-9]{4}$/);
const localeCode = z.string().regex(/^[a-z]{2}[A-Z]{2}$/);
const component = z
  .object({
    type: typeCode,
    path: componentPath,
    locale: localeCode.optional(),
  })
  .strict();
type Component = z.infer<typeof component>;

export const componentApplySchema = z
  .object({
    ...options,
    operations: z
      .array(
        z.discriminatedUnion("op", [
          z
            .object({
              op: z.literal("add"),
              entry: component,
              allowMissing: z.boolean().default(false),
            })
            .strict(),
          z
            .object({
              op: z.literal("update"),
              entry: component,
              path: componentPath.optional(),
              type: typeCode.optional(),
              locale: localeCode.nullable().optional(),
              allowMissing: z.boolean().default(false),
            })
            .strict()
            .refine(
              (op) => op.path !== undefined || op.type !== undefined || op.locale !== undefined,
              "Specify a new path, type or locale",
            ),
          z.object({ op: z.literal("remove"), entry: component }).strict(),
        ]),
      )
      .min(1)
      .max(32),
  })
  .strict();
type ComponentUpdate = Extract<
  z.output<typeof componentApplySchema>["operations"][number],
  { op: "update" }
>;

function updatedEntry(op: ComponentUpdate): Component {
  return {
    path: op.path ?? op.entry.path,
    type: op.type ?? op.entry.type,
    locale: op.locale === undefined ? op.entry.locale : (op.locale ?? undefined),
  };
}

const modPath = componentPath.refine(
  (value) => /\.sc2(?:mod|campaign)$/i.test(value) && !value.includes(","),
);
const dependency = z
  .object({
    file: modPath,
    bnet: z
      .string()
      .min(1)
      .max(260)
      .regex(/^[^,\u0000-\u001f]+$/)
      .optional(),
  })
  .strict();
const metadataField = z.enum(["Icon", "Tutorial", "PatchNotes", "ModType"]);
export const metadataApplySchema = z
  .object({
    ...options,
    operations: z
      .array(
        z.discriminatedUnion("op", [
          z.object({ op: z.literal("add_dependency"), entry: dependency }).strict(),
          z.object({ op: z.literal("remove_dependency"), file: modPath }).strict(),
          z
            .object({
              op: z.literal("set_field"),
              field: metadataField,
              value: z
                .string()
                .max(2048)
                .regex(/^[^\u0000-\u001f]*$/),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(32),
  })
  .strict();

function xmlDocument(source: string, tag: string) {
  if (source.length > 2 * 1024 * 1024) throw Error("DOCUMENT_COMPONENT_SIZE_LIMIT");
  const parsed = scanXml(source);
  const root = parsed.nodes[parsed.rootIds[0]];
  if (
    parsed.rootIds.length !== 1 ||
    root?.tag !== tag ||
    parsed.diagnostics.some((entry) => entry.severity === "error")
  )
    throw Error("DOCUMENT_XML_INVALID: " + tag);
  return { root, children: (node: XmlNode) => node.childIds.map((id) => parsed.nodes[id]) };
}

function leaf(source: string, node: XmlNode) {
  const value = source.slice(node.startTagEnd, node.endTagStart);
  if (node.selfClosing) return "";
  if (node.childIds.length || /<|&(?!(?:[a-z]+|#[0-9]+|#x[0-9a-f]+);)/i.test(value))
    throw Error("DOCUMENT_XML_UNSUPPORTED_LEAF: " + node.tag);
  return decodeXmlValue(value.trim());
}

function replaceNode(source: string, node: XmlNode, value = "") {
  return source.slice(0, node.start) + value + source.slice(node.end);
}

function replaceLeaf(source: string, node: XmlNode, value: string) {
  leaf(source, node);
  const encoded = escapeXml(value);
  if (node.selfClosing) {
    const start = source.slice(node.start, node.end).replace(/\/\s*>$/, ">");
    return replaceNode(source, node, start + encoded + "</" + node.tag + ">");
  }
  const raw = source.slice(node.startTagEnd, node.endTagStart);
  const first = raw.search(/\S/);
  const end = raw.trimEnd().length;
  return (
    source.slice(0, node.startTagEnd) +
    raw.slice(0, Math.max(0, first)) +
    encoded +
    raw.slice(end) +
    source.slice(node.endTagStart)
  );
}

function updateDeclaration(source: string, node: XmlNode, before: Component, after: Component) {
  let next = before.path === after.path ? source : replaceLeaf(source, node, after.path);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const [attr, oldValue, newValue] of [
    ["Type", before.type, after.type],
    ["Locale", before.locale, after.locale],
  ]) {
    if (oldValue === newValue) continue;
    const span = node.attrSpans.find((attribute) => attribute.name === attr);
    if (span) {
      edits.push(
        newValue === undefined
          ? { start: span.start, end: span.end, text: "" }
          : { start: span.valueStart, end: span.valueEnd, text: escapeXml(newValue) },
      );
    } else if (newValue !== undefined) {
      edits.push({
        start: node.startTagEnd - 1,
        end: node.startTagEnd - 1,
        text: " " + attr + '="' + escapeXml(newValue) + '"',
      });
    }
  }
  for (const edit of edits.sort((a, b) => b.start - a.start))
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  return next;
}

function appendXml(source: string, parent: XmlNode, body: string) {
  const nl = source.includes("\r\n") ? "\r\n" : "\n";
  const startOfLine = source.lastIndexOf("\n", parent.start - 1) + 1;
  const parentIndent = source.slice(startOfLine, parent.start).match(/^[ \t]*$/)?.[0] ?? "";
  const line = parentIndent + "    " + body + nl;
  if (parent.selfClosing)
    return replaceNode(
      source,
      parent,
      source.slice(parent.start, parent.end).replace(/\/\s*>$/, ">") +
        nl +
        line +
        parentIndent +
        "</" +
        parent.tag +
        ">",
    );
  const beforeClose = source.slice(0, parent.endTagStart);
  const indent = beforeClose.match(/(?:^|\n)([ \t]*)$/)?.[1];
  const index = parent.endTagStart - (indent?.length ?? 0);
  return (
    source.slice(0, index) +
    (indent === undefined ? nl : "") +
    line +
    (indent === undefined ? parentIndent : "") +
    source.slice(index)
  );
}

function entries(source: string) {
  const { root, children } = xmlDocument(source, "Components");
  const records = children(root).filter(
    (node) => node.tag === "DataComponent" || node.tag === "Component",
  );
  return {
    root,
    rows: records.map((node) => ({
      node,
      entry: { type: node.attrs.Type, path: leaf(source, node), locale: node.attrs.Locale },
    })),
  };
}

const normalized = (file: string) => file.replaceAll("\\", "/").toLowerCase();
const componentKey = (entry: Component) =>
  JSON.stringify([entry.type?.toLowerCase(), normalized(entry.path), entry.locale?.toLowerCase()]);

async function payloads(workspace: Workspace, directory: string, entry: Component) {
  // Legacy/unknown declarations remain inspectable even when their logical path is not accepted for writes.
  if (!component.safeParse(entry).success) return [];
  const relative = entry.path.replaceAll("\\", "/");
  const candidates = new Set([relative]);
  if (relative.toLowerCase() === "gamedata") {
    candidates.add("Base.SC2Data/GameData.xml");
    candidates.add("Base.SC2Data/GameData");
  } else if (!relative.includes("/") && entry.locale && relative.toLowerCase() === "gametext") {
    candidates.add(entry.locale + ".SC2Data/LocalizedData");
  } else {
    candidates.add("Base.SC2Data/" + relative);
  }
  const found: string[] = [];
  for (const file of candidates) {
    const absolute = workspace.resolveUserPath(path.join(directory, file));
    const info = await fs.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    });
    if (info?.isFile()) found.push(file);
    else if (info?.isDirectory()) {
      for (const child of await fs.readdir(absolute, { withFileTypes: true })) {
        if (child.isFile()) found.push(file + "/" + child.name);
      }
    }
  }
  return found.sort().slice(0, 60);
}

function docInfo(source: string) {
  const { root, children } = xmlDocument(source, "DocInfo");
  const sections = children(root);
  const section = (tag: string) => {
    const matches = sections.filter((node) => node.tag === tag);
    if (matches.length > 1) throw Error("DOCUMENT_INFO_DUPLICATE_SECTION: " + tag);
    return matches[0];
  };
  return {
    root,
    section,
    values: (node: XmlNode) => children(node).filter((item) => item.tag === "Value"),
  };
}

function metadataRevision(info: Buffer, header: Buffer) {
  return bytesHash(Buffer.from(JSON.stringify([bytesHash(info), bytesHash(header)])));
}

function updateHeader(header: Buffer, previous: string[], updated: string[]) {
  const original = readDocumentHeader(header);
  if (JSON.stringify(previous) !== JSON.stringify(original.dependencies))
    throw Error("DOCUMENT_DEPENDENCY_HEADER_MISMATCH");
  const reader = new Reader(header);
  const prefix = reader.take(44);
  reader.u32();
  for (const old of previous) {
    if (reader.cstr() !== old) throw Error("DOCUMENT_DEPENDENCY_HEADER_MISMATCH");
  }
  const written = new Writer().raw(prefix).u32(updated.length);
  for (const value of updated) written.cstr(value);
  const result = written.raw(header.subarray(reader.offset)).done();
  readDocumentHeader(result);
  return result;
}

function dependencyFile(value: string) {
  return value.match(/(?:^|,)\s*file:(.+)$/i)?.[1]?.trim();
}

function updatedInfo(
  initial: string,
  operations: z.output<typeof metadataApplySchema>["operations"],
) {
  let source = initial;
  for (const op of operations) {
    const { root, section, values } = docInfo(source);
    if (op.op === "set_field") {
      const target = section(op.field);
      if (!target) {
        source = appendXml(
          source,
          root,
          "<" + op.field + "><Value>" + escapeXml(op.value) + "</Value></" + op.field + ">",
        );
      } else {
        const items = values(target);
        if (items.length > 1) throw Error("DOCUMENT_INFO_FIELD_IS_LIST: " + op.field);
        source = items.length
          ? replaceLeaf(source, items[0], op.value)
          : appendXml(source, target, "<Value>" + escapeXml(op.value) + "</Value>");
      }
      continue;
    }
    const target = section("Dependencies");
    const wanted = normalized(op.op === "add_dependency" ? op.entry.file : op.file);
    const matching = (target ? values(target) : []).filter((node) => {
      const file = dependencyFile(leaf(source, node));
      return file !== undefined && normalized(file) === wanted;
    });
    if (op.op === "remove_dependency") {
      if (matching.length !== 1) throw Error("DOCUMENT_DEPENDENCY_NOT_UNIQUE: " + op.file);
      source = replaceNode(source, matching[0]);
    } else {
      if (matching.length) throw Error("DOCUMENT_DEPENDENCY_ALREADY_PRESENT: " + op.entry.file);
      const spec =
        (op.entry.bnet ? "bnet:" + op.entry.bnet + "," : "") +
        "file:" +
        op.entry.file.replaceAll("\\", "/");
      const value = "<Value>" + escapeXml(spec) + "</Value>";
      source = target
        ? appendXml(source, target, value)
        : appendXml(source, root, "<Dependencies>" + value + "</Dependencies>");
    }
  }
  docInfo(source);
  return source;
}

const response = (value: unknown) => {
  const text = JSON.stringify(value);
  if (text.length > 64000) throw Error("DOCUMENT_RESPONSE_LIMIT: use a smaller page");
  return { content: [{ type: "text" as const, text }] };
};
export function registerExistingDocumentTools(server: McpServer, workspace: Workspace) {
  const key = (dir: string, name: string) => workspace.binary.key(path.join(dir, name));
  server.registerTool(
    "document.components.inspect",
    {
      description:
        "List existing ComponentList declarations and resolved payload files with an exact edit revision.",
      inputSchema: z
        .object({
          directory,
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(50).default(20),
        })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const file = key(args.directory, manifestName);
      const { bytes } = await workspace.binary.read(file);
      const { rows } = entries(decodeUtf8(bytes, file));
      const page = rows.slice(args.offset, args.offset + args.limit);
      const components = [];
      for (const { entry } of page)
        components.push({ ...entry, files: await payloads(workspace, args.directory, entry) });
      return response({ file, sha256: bytesHash(bytes), total: rows.length, components });
    },
  );
  server.registerTool(
    "document.components.apply",
    {
      description:
        "Add, update type/path/locale or remove ComponentList declarations by exact revision. Add/update require an existing payload unless allowMissing is set. Removing a declaration preserves its files. Stage by default, then save with modkit.save or map.save.",
      inputSchema: componentApplySchema,
    },
    async (args) => {
      const file = key(args.directory, manifestName);
      const targets = args.operations.flatMap((op) =>
        op.op === "remove" || op.allowMissing
          ? []
          : [op.op === "update" ? updatedEntry(op) : op.entry],
      );
      const verify = async () => {
        for (const target of targets)
          if (!(await payloads(workspace, args.directory, target)).length)
            throw Error("DOCUMENT_COMPONENT_PAYLOAD_MISSING: " + target.path);
      };
      return response(
        await workspace.binary.apply(
          [file],
          (sources) => {
            const bytes = sources.get(file)!;
            if (bytesHash(bytes) !== args.expectedSha256)
              throw Error("DOCUMENT_COMPONENT_REVISION_STALE");
            let source = decodeUtf8(bytes, file);
            for (const op of args.operations) {
              const { root, rows } = entries(source);
              const matches = rows.filter(
                ({ entry }) => componentKey(entry) === componentKey(op.entry),
              );
              if (op.op === "add") {
                if (matches.length)
                  throw Error("DOCUMENT_COMPONENT_ALREADY_DECLARED: " + op.entry.path);
                const locale = op.entry.locale ? ' Locale="' + op.entry.locale + '"' : "";
                source = appendXml(
                  source,
                  root,
                  '<DataComponent Type="' +
                    op.entry.type +
                    '"' +
                    locale +
                    ">" +
                    escapeXml(op.entry.path) +
                    "</DataComponent>",
                );
              } else {
                if (matches.length !== 1)
                  throw Error("DOCUMENT_COMPONENT_NOT_UNIQUE: " + op.entry.path);
                const match = matches[0];
                if (op.op === "remove") {
                  source = replaceNode(source, match.node);
                } else {
                  const target = updatedEntry({ ...op, entry: match.entry });
                  if (
                    rows.some(
                      ({ entry, node }) =>
                        node !== match.node && componentKey(entry) === componentKey(target),
                    )
                  )
                    throw Error("DOCUMENT_COMPONENT_ALREADY_DECLARED: " + target.path);
                  source = updateDeclaration(source, match.node, match.entry, target);
                }
              }
            }
            entries(source);
            return new Map([[file, Buffer.from(source)]]);
          },
          { dryRun: args.dryRun, stage: args.stage, backup: true, verify },
        ),
      );
    },
  );

  server.registerTool(
    "document.metadata.inspect",
    {
      description:
        "Read existing DocumentInfo dependencies, metadata and editable header profile with one revision token.",
      inputSchema: z.object({ directory }).strict(),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const file = key(args.directory, "DocumentInfo");
      const [info, header] = await Promise.all([
        workspace.binary.read(file),
        workspace.binary.read(key(args.directory, "DocumentHeader")),
      ]);
      const source = decodeUtf8(info.bytes, file);
      const { section, values } = docInfo(source);
      const fields = Object.fromEntries(
        metadataField.options.flatMap((field) => {
          const target = section(field);
          return target ? [[field, values(target).map((node) => leaf(source, node))]] : [];
        }),
      );
      let headerProfile = "absent";
      if (header.exists) {
        try {
          readDocumentHeader(header.bytes);
          headerProfile = "H2CS-v8";
        } catch {
          headerProfile = "opaque";
        }
      }
      return response({
        file,
        sha256: metadataRevision(info.bytes, header.bytes),
        ...readDocumentInfo(info.bytes),
        fields,
        headerProfile,
      });
    },
  );
  server.registerTool(
    "document.metadata.apply",
    {
      description:
        "Update single-valued DocumentInfo fields and add/remove ordered dependencies by exact revision. Keep a present supported H2CS v8 header in sync. Stage by default; save the whole group with modkit.save or map.save. Availability and usage of dependencies are separate checks.",
      inputSchema: metadataApplySchema,
    },
    async (args) => {
      const file = key(args.directory, "DocumentInfo"),
        header = key(args.directory, "DocumentHeader");
      return response(
        await workspace.binary.apply(
          [file, header],
          (sources) => {
            const info = sources.get(file)!,
              savedHeader = sources.get(header)!;
            if (metadataRevision(info, savedHeader) !== args.expectedSha256)
              throw Error("DOCUMENT_METADATA_REVISION_STALE");
            const updated = Buffer.from(updatedInfo(decodeUtf8(info, file), args.operations));
            const previous = readDocumentInfo(info).dependencies,
              next = readDocumentInfo(updated).dependencies;
            const result = new Map([[file, updated]]);
            if (savedHeader.length && JSON.stringify(previous) !== JSON.stringify(next))
              result.set(header, updateHeader(savedHeader, previous, next));
            return result;
          },
          { dryRun: args.dryRun, stage: args.stage, backup: true },
        ),
      );
    },
  );
}
