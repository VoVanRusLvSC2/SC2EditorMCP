import * as z from "zod/v4";
import { triggerItemAtPath, verifyTriggerInsertion, type TriggerTreeItem } from "./triggerPaths.js";
import { commands, section, type Step, type Args } from "./triggerPatchPlan.js";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const graphRow = z.object({
  parent: z.number().int().min(-1).max(8191),
  depth: z.number().int().min(0).max(16),
  text: z.string().max(512),
  stateImage: z.number().int().min(0).max(15),
});
export const graphSchema = z.object({
  root: z.array(graphRow).max(8192),
  bodies: z.array(z.object({ path: z.string(), items: z.array(graphRow).max(8192) })).max(16),
  missing: z.array(z.string()).max(16),
});
export type Graph = z.infer<typeof graphSchema>;
export function verifyUnrelated(before: Graph, after: Graph, s: Step) {
  const declaration = commands[s.command].declaration;
  const signature =
    (declaration && !["local"].includes(String(s.args.view))) ||
    (s.command === "member_create" && s.args.kind === "parameter");
  const rootChange =
    s.command === "new_declaration" ||
    (declaration && !["local", "parameter"].includes(String(s.args.view)));
  if (!rootChange && !same(before.root, after.root))
    throw Error("LIVE_TRIGGER_PATCH_UNRELATED_ROOT_CHANGED");
  if (
    before.bodies.some((x) => x.path === s.args.path) &&
    !after.bodies.some((x) => x.path === s.args.path) &&
    !(s.command === "declaration_rename" && s.args.view === "return_type")
  )
    throw Error("LIVE_TRIGGER_PATCH_OWNER_CHANGED");
  if (!signature) {
    for (const body of before.bodies)
      if (body.path !== s.args.path) {
        const current = after.bodies.find((x) => x.path === body.path);
        if (!current || !same(body, current))
          throw Error("LIVE_TRIGGER_PATCH_UNRELATED_BODY_CHANGED");
      }
  }
}
export const receiptIndex = (r: Args) =>
  [r.itemIndex, r.actionIndex, r.eventIndex, r.conditionIndex].find(
    (v): v is number => typeof v === "number" && Number.isInteger(v) && v > 0,
  );

/** Adopt an acknowledged insertion only when the complete observed graph proves that exact append. */
export function observeAcknowledgedInsertion(
  before: Graph,
  after: Graph,
  s: Step,
  args: Args,
  result: Args,
) {
  if (
    !commands[s.command].append ||
    result.nativeTreeVerified !== true ||
    !["applied", "needs_parameters"].includes(String(result.status))
  )
    return;
  if (
    !same(before.root, after.root) ||
    !same(before.missing, after.missing) ||
    before.bodies.length !== after.bodies.length
  )
    return;
  for (const body of before.bodies)
    if (
      body.path !== args.path &&
      !same(
        body,
        after.bodies.find((x) => x.path === body.path),
      )
    )
      return;
  const old = before.bodies.find((x) => x.path === args.path),
    fresh = after.bodies.find((x) => x.path === args.path);
  if (!old || !fresh) return;
  const rows = (items: Graph["root"]): TriggerTreeItem[] =>
    items.map((x, i) => ({
      ...x,
      handle: String(i + 1),
      parent: x.parent < 0 ? "0" : String(x.parent + 1),
    }));
  const a = rows(old.items),
    b = rows(fresh.items),
    roots = a.filter((x) => x.parent === "0"),
    label =
      section(s) === "events" ? "Events" : section(s) === "conditions" ? "Conditions" : "Actions";
  const groups = a.filter(
    (x) => roots.length === 1 && x.parent === roots[0].handle && x.text === label,
  );
  if (groups.length !== 1) return;
  const group = triggerItemAtPath(a, groups[0], (args.groupPath ?? []) as number[]),
    added = verifyTriggerInsertion(a, b, group.handle);
  if (!added) return;
  const index = b.filter((x) => x.parent === added.parent).length,
    reported = receiptIndex(result);
  if (reported !== undefined && reported !== index) return;
  if (typeof result.nativeLabel === "string") {
    if (added.text !== result.nativeLabel) return;
  } else if (args.action === "wait" || args.event === "periodic") {
    const match = added.text.match(
      args.action === "wait"
        ? /^General\s*-\s*Wait\s+(\d+(?:\.\d+)?)\s+Game Time seconds$/
        : /^Timer\s*-\s*Every\s+(\d+(?:\.\d+)?)\s+seconds of Game Time$/,
    );
    if (
      result.parameterVerified !== true ||
      !match ||
      !Number.isFinite(Number(match[1])) ||
      !Number.isFinite(Number(args.seconds)) ||
      Math.abs(Number(match[1]) - Number(args.seconds)) > 0.00001
    )
      return;
  } else return;
  return { index, label: added.text };
}
