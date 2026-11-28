import { promises as fs } from "node:fs";
import path from "node:path";
import { directoryManifest } from "../../archive/archiveAdapter.js";
import { scanXml } from "../../core/xmlScanner.js";

function objects(source: string) {
  const xml = scanXml(source);
  if (xml.rootIds.length !== 1 || xml.diagnostics.some((d) => d.severity === "error"))
    throw Error("WORLD_INVALID_OBJECTS");
  const root = xml.nodes[xml.rootIds[0]];
  if (root.tag !== "PlacedObjects") throw Error("WORLD_INVALID_OBJECTS_ROOT");
  const nodes = new Map<string, { start: number; end: number; bytes: string; kind: string }>();
  for (const i of root.childIds) {
    const node = xml.nodes[i],
      id = node.attrs.Id;
    if (!/^\d+$/.test(id ?? "") || nodes.has(id)) throw Error("WORLD_AMBIGUOUS_OBJECT_ID");
    nodes.set(id, {
      start: node.start,
      end: node.end,
      kind: node.tag,
      bytes: source.slice(node.start, node.end),
    });
  }
  return {
    nodes,
    root,
    envelope: [source.slice(0, root.startTagEnd), source.slice(root.endTagStart)],
  };
}

// Apply generated edits to the author's document. Keep raw XML including unknown properties.
export function mergeWorldObjects(base: string, current: string, generated: string) {
  const a = objects(base),
    b = objects(current),
    c = objects(generated);
  if (JSON.stringify(a.envelope) !== JSON.stringify(c.envelope) || b.root.selfClosing)
    throw Error("WORLD_REBUILD_CONFLICT: Objects header");
  const patches: { start: number; end: number; text: string }[] = [];
  const additions: string[] = [];
  for (const id of new Set([...a.nodes.keys(), ...c.nodes.keys(), ...b.nodes.keys()])) {
    const old = a.nodes.get(id),
      mine = b.nodes.get(id),
      next = c.nodes.get(id);
    if (
      mine?.bytes !== old?.bytes &&
      (old ?? mine)?.kind !== "ObjectDoodad" &&
      mine?.bytes !== next?.bytes
    )
      throw Error("WORLD_REBUILD_REVIEW_GAMEPLAY_OBJECT: " + id);
    if (old?.bytes === next?.bytes || mine?.bytes === next?.bytes) continue;
    if (mine?.bytes !== old?.bytes) throw Error("WORLD_REBUILD_CONFLICT: Objects/" + id);
    if (mine) patches.push({ start: mine.start, end: mine.end, text: next?.bytes ?? "" });
    else if (next) additions.push(next.bytes);
  }
  if (additions.length)
    patches.push({
      start: b.root.endTagStart,
      end: b.root.endTagStart,
      text: additions.join("\n") + "\n",
    });
  for (const p of patches.sort((x, y) => y.start - x.start))
    current = current.slice(0, p.start) + p.text + current.slice(p.end);
  objects(current);
  return current;
}

export async function mergeWorldComponents(baseline: string, edited: string, generated: string) {
  const [a, b, c] = await Promise.all(
    [baseline, edited, generated].map(
      async (dir) => new Map((await directoryManifest(dir)).map((e) => [e.file, e.sha256])),
    ),
  );
  const names = [...new Set([...a.keys(), ...b.keys(), ...c.keys()])];
  // These files jointly encode one terrain surface or one GUI/Galaxy program.
  for (const family of [/^(t3|CellAttribute)/i, /^(Triggers$|MapScript\.galaxy$|.*\.galaxy$)/i]) {
    const related = names.filter((n) => family.test(n));
    if (
      related.some((n) => a.get(n) !== b.get(n)) &&
      related.some((n) => a.get(n) !== c.get(n)) &&
      related.some((n) => b.get(n) !== c.get(n))
    )
      throw Error("WORLD_REBUILD_CONFLICT: " + related.join(", "));
  }
  const kept: string[] = [],
    updated: string[] = [];
  // Only the private extracted copy in edited is modified. Input archives stay intact.
  for (const name of names) {
    const before = a.get(name),
      mine = b.get(name),
      next = c.get(name);
    if (mine === next) continue;
    if (before === next) {
      kept.push(name);
      continue;
    }
    const target = path.join(edited, name);
    if (mine !== before) {
      if (name !== "Objects" || !before || !mine || !next)
        throw Error("WORLD_REBUILD_CONFLICT: " + name);
      const [original, manual, built] = await Promise.all(
        [baseline, edited, generated].map((dir) => fs.readFile(path.join(dir, name), "utf8")),
      );
      await fs.writeFile(target, mergeWorldObjects(original, manual, built));
      kept.push(name);
    } else if (next) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(generated, name), target);
    } else await fs.unlink(target);
    updated.push(name);
  }
  return { kept, updated };
}
