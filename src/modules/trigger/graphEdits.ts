import { createHash } from "node:crypto";
import * as z from "zod/v4";
import type { XmlNode } from "../../core/types.js";
import type { TriggerGraph } from "./workspace.js";

const label = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[^\x00-\x1f]+$/);
export const triggerGraphEditSchema = z
  .object({
    library: z.string().max(128).default(""),
    id: z.string().regex(/^[a-f0-9]{8}$/i),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
    locale: z
      .string()
      .regex(/^[a-z]{2}[A-Z]{2}$/)
      .default("enUS"),
    operation: z.discriminatedUnion("op", [
      z.object({ op: z.literal("rename"), name: label }).strict(),
      z
        .object({
          op: z.literal("clone"),
          newIdentifier: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,95}$/),
          name: label,
        })
        .strict(),
      z.object({ op: z.literal("delete") }).strict(),
    ]),
    dryRun: z.boolean().default(true),
    stage: z.boolean().default(true),
  })
  .strict();

type Operation = z.output<typeof triggerGraphEditSchema>["operation"];
type Element = TriggerGraph["elements"][number];
const identity = (library: string, type: string, id: string) => JSON.stringify([library, type, id]);
const elementKey = (e: Element) => identity(e.library, e.type, e.id);
const structural = new Set(["FunctionCall", "Param", "Comment", "Event", "Condition", "Action"]);
type Span = { start: number; end: number; text: string };
function splice(source: string, changes: Span[], offset = 0) {
  for (const edit of changes.sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start - offset) + edit.text + source.slice(edit.end - offset);
  return source;
}

function attr(node: XmlNode, name: string, value: string): Span {
  const location = node.attrSpans.find((item) => item.name === name);
  if (!location) throw Error("TRIGGER_REFERENCE_ATTRIBUTE_MISSING: " + name);
  return { start: location.valueStart, end: location.valueEnd, text: value };
}

export function editTriggerGraph(
  source: string,
  graph: TriggerGraph,
  selected: Element,
  operation: Exclude<Operation, { op: "rename" }>,
) {
  const { nodes } = graph.parsed;
  const selectedKey = elementKey(selected);
  const scope = nodes[selected.node.parentId ?? -1];
  if (!(scope?.tag === "TriggerData" || scope?.tag === "Library"))
    throw Error("TRIGGER_UNKNOWN_ELEMENT_CONTAINER");
  const localVars = new Set(
    graph
      .refs(selected)
      .filter(
        (ref) =>
          ref.node.parentId === selected.node.id &&
          ref.type === "Variable" &&
          ["Local", "LocalVariable", "Variable"].includes(ref.node.tag),
      )
      .map((ref) => ref.key),
  );
  const closure = new Map<string, Element>();
  const pending = [selected];
  while (pending.length) {
    const current = pending.pop()!;
    const k = elementKey(current);
    if (closure.has(k)) continue;
    if (closure.size >= 512) throw Error("TRIGGER_EDIT_GRAPH_LIMIT");
    closure.set(k, current);
    if (/<(?:ScriptCode|CustomScript)\b/.test(current.xml))
      throw Error("TRIGGER_EDIT_OPAQUE_SCRIPT_OWNER: " + current.id);
    for (const ref of graph.refs(current)) {
      if (ref.library !== selected.library || !(structural.has(ref.type) || localVars.has(ref.key)))
        continue;
      const target = graph.byKey.get(ref.key);
      if (!target || target.node.parentId !== scope.id)
        throw Error("TRIGGER_EDIT_MISSING_LOCAL_NODE: " + ref.id);
      pending.push(target);
    }
  }

  const incoming = new Map<string, Array<{ node: XmlNode; owner?: string }>>();
  for (const node of nodes) {
    if (node.tag === "Element" || !node.attrs.Type || !node.attrs.Id) continue;
    const k = identity(node.attrs.Library ?? graph.libraryOf(node), node.attrs.Type, node.attrs.Id);
    if (!closure.has(k)) continue;
    let parent = node.parentId === null ? undefined : nodes[node.parentId];
    while (parent && parent.tag !== "Element" && parent.parentId !== null)
      parent = nodes[parent.parentId];
    const enclosing =
      parent?.tag === "Element" && parent.attrs.Type && parent.attrs.Id
        ? identity(graph.libraryOf(parent), parent.attrs.Type, parent.attrs.Id)
        : undefined;
    const links = incoming.get(k) ?? [];
    links.push({ node, owner: enclosing });
    incoming.set(k, links);
  }
  const memberships = (incoming.get(selectedKey) || []).filter(({ node }) => {
    const parent = nodes[node.parentId ?? -1];
    return (
      node.tag === "Item" &&
      graph.libraryOf(node) === selected.library &&
      ((parent?.tag === "Root" && parent.parentId === scope.id) ||
        (parent?.tag === "Element" &&
          parent.attrs.Type === "Category" &&
          parent.parentId === scope.id))
    );
  });
  if (memberships.length !== 1) throw Error("TRIGGER_EDIT_FOLDER_MEMBERSHIP_NOT_UNIQUE");
  const item = memberships[0].node;
  if (operation.op === "delete") {
    if (
      (incoming.get(selectedKey) ?? []).some(
        ({ node, owner }) => node !== item && (!owner || !closure.has(owner)),
      )
    )
      throw Error("TRIGGER_EDIT_HAS_INCOMING_REFERENCES");
    const retained = new Set<string>();
    const shared = [...closure.keys()].filter(
      (k) =>
        k !== selectedKey &&
        (incoming.get(k) ?? []).some(({ owner }) => !owner || !closure.has(owner)),
    );
    while (shared.length) {
      const k = shared.pop()!;
      if (retained.has(k)) continue;
      if (k === selectedKey) throw Error("TRIGGER_EDIT_HAS_INCOMING_REFERENCES");
      retained.add(k);
      for (const ref of graph.refs(closure.get(k)!)) if (closure.has(ref.key)) shared.push(ref.key);
    }
    const removed = [...closure].filter(([k]) => !retained.has(k)).map(([, element]) => element);
    const changes = [item, ...removed.map(({ node }) => node)].map(({ start, end }) => ({
      start,
      end,
      text: "",
    }));
    return { xml: splice(source, changes), removed, retainedCount: retained.size, cloned: [] };
  }

  function identifiers(element: Element) {
    return element.node.childIds
      .map((child) => nodes[child])
      .filter((child) => child.tag === "Identifier");
  }
  if (
    graph.elements.some(
      (element) =>
        element.library === selected.library &&
        element.type === "Trigger" &&
        identifiers(element).some(
          (node) =>
            source.slice(node.startTagEnd, node.endTagStart).trim().toLowerCase() ===
            operation.newIdentifier.toLowerCase(),
        ),
    )
  )
    throw Error("TRIGGER_EDIT_IDENTIFIER_ALREADY_PRESENT");
  const used = new Set(graph.elements.map((element) => element.id.toUpperCase()));
  const mapped = new Map<string, string>();
  const cloned = Array.from(closure, ([k, element]) => {
    let next: string;
    let salt = 0;
    do {
      next = createHash("sha256")
        .update(k + "\0" + operation.newIdentifier + "\0" + salt++)
        .digest("hex")
        .slice(0, 8)
        .toUpperCase();
    } while (used.has(next));
    used.add(next);
    mapped.set(k, next);
    return { element, id: next };
  });
  const nl = source.includes("\r\n") ? "\r\n" : "\n";
  const newItem = splice(
    source.slice(item.start, item.end),
    [attr(item, "Id", mapped.get(selectedKey)!)],
    item.start,
  );
  const copied = cloned
    .map(({ element, id }) => {
      const changes = [attr(element.node, "Id", id)];
      for (const ref of graph.refs(element)) {
        const replacement = mapped.get(ref.key);
        if (replacement) changes.push(attr(ref.node, "Id", replacement));
      }
      if (element === selected) {
        const names = identifiers(element);
        if (names.length > 1 || names[0]?.childIds.length || names[0]?.selfClosing)
          throw Error("TRIGGER_EDIT_IDENTIFIER_PROFILE");
        changes.push(
          names.length === 1
            ? {
                start: names[0].startTagEnd,
                end: names[0].endTagStart,
                text: operation.newIdentifier,
              }
            : {
                start: element.node.startTagEnd,
                end: element.node.startTagEnd,
                text: "<Identifier>" + operation.newIdentifier + "</Identifier>",
              },
        );
        if (element.node.selfClosing) throw Error("TRIGGER_EDIT_EMPTY_ELEMENT_PROFILE");
      }
      return splice(element.xml, changes, element.node.start);
    })
    .join(nl);
  return {
    xml: splice(source, [
      { start: item.end, end: item.end, text: nl + newItem },
      { start: scope.endTagStart, end: scope.endTagStart, text: copied + nl },
    ]),
    removed: [],
    retainedCount: 0,
    cloned,
    newId: mapped.get(selectedKey)!,
  };
}
