import * as z from "zod/v4";
import type { EditorWindow } from "./desktop.js";
import type { MemoryDesktop } from "./memoryDesktop.js";
import { readTriggerTreePages } from "./triggerTreePages.js";
import { structuralTree, type TriggerTreeItem } from "./triggerPaths.js";
import { editParameterBinding } from "./triggerBinding.js";

const display = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((v) => [...v].every((c) => c.charCodeAt(0) >= 32));
const target = z.object({
  archive: z.string().min(1).max(4096),
  windowId: z.string().regex(/^\d+$/),
  path: z.string().min(1).max(2048),
});
export const triggerDeclarationSchema = target
  .extend({
    view: z.enum(["variable", "return_type", "local", "parameter"]).default("variable"),
    member: display.optional(),
  })
  .strict();
export const triggerDeclarationSetSchema = triggerDeclarationSchema
  .extend({
    expectedDeclarationHash: z.string().regex(/^\d+$/),
    field: z.enum([
      "type",
      "subtype",
      "constant",
      "array",
      "dimensions",
      "size",
      "initial",
      "default_enabled",
      "option",
    ]),
    option: display.optional(),
    value: z.union([display, z.number().finite(), z.boolean()]),
    dimension: z.number().int().min(1).max(4).default(1),
    allowTypeReset: z.boolean().default(false),
    allowShapeChange: z.boolean().default(false),
  })
  .strict()
  .superRefine((a, c) => {
    const fail = (message: string) => c.addIssue({ code: "custom", message });
    if (
      (a.field === "type" || a.field === "subtype") &&
      (typeof a.value !== "string" || !a.allowTypeReset)
    )
      fail("Type changes require an exact native type and allowTypeReset=true.");
    if (
      ["constant", "array", "default_enabled", "option"].includes(a.field) &&
      typeof a.value !== "boolean"
    )
      fail("Boolean value required.");
    if (a.field === "default_enabled" && a.view !== "parameter")
      fail("default_enabled belongs to parameter declarations.");
    if (a.field === "option" ? a.view !== "parameter" || !a.option : a.option !== undefined)
      fail("option requires parameter scope and an exact native option label.");
    if (["array", "dimensions", "size"].includes(a.field) && !a.allowShapeChange)
      fail("Array changes require allowShapeChange=true.");
    if (
      a.field === "dimensions" &&
      !(typeof a.value === "number" && Number.isInteger(a.value) && a.value >= 1 && a.value <= 4)
    )
      fail("Dimensions must be 1..4.");
    if (
      a.field === "size" &&
      !(typeof a.value === "number" && Number.isInteger(a.value) && a.value >= 1 && a.value <= 8192)
    )
      fail("Size must be 1..8192.");
    if (a.field === "initial" && typeof a.value === "string")
      fail(
        "Use compatible numeric/Boolean values; arbitrary string initializers are not supported by this operation yet.",
      );
  });
export const triggerNewDeclarationSchema = target
  .extend({
    kind: z.enum(["variable", "function", "action_definition", "trigger"]),
    name: display.refine((v) => v.length <= 63 && !v.includes("/") && !v.includes("*")),
    expectedTreeHash: z.string().regex(/^\d+$/),
  })
  .strict();
export const triggerDeclarationRenameSchema = triggerDeclarationSchema
  .extend({
    name: display.refine((v) => v.length <= 63 && !v.includes("/") && !v.includes("*")),
    expectedDeclarationHash: z.string().regex(/^\d+$/),
  })
  .strict();
const nativePanel = z.object({
  kind: z.enum(["variable", "return_type", "local", "parameter"]),
  fingerprint: z.string().regex(/^\d+$/),
  treeFingerprint: z.string().regex(/^\d+$/),
  controls: z.array(
    z.object({
      id: z.number().int(),
      type: z.string(),
      text: z.string(),
      enabled: z.boolean(),
      checked: z.boolean(),
      checkState: z.number().int().min(0).max(2).optional(),
      buttonStyle: z.number().int().optional(),
      tree: z
        .object({
          fingerprint: z.string(),
          truncated: z.boolean(),
          items: z.array(
            z.object({
              handle: z.string(),
              parent: z.string(),
              depth: z.number(),
              text: z.string(),
              stateImage: z.number().int().optional(),
            }),
          ),
        })
        .optional(),
      options: z.array(z.string()).optional(),
    }),
  ),
});
type Panel = z.infer<typeof nativePanel>;
export interface DeclarationContext {
  archive?: string;
  archiveSha256?: string;
  desktop: MemoryDesktop;
  window: EditorWindow;
  guardArchive(): Promise<void>;
  currentWindow(): Promise<EditorWindow>;
  pause(ms: number): Promise<void>;
}
const nameOf = (text: string) =>
  text
    .replace(/\*$/, "")
    .replace(/\s+<[^<>]+>$/, "")
    .split(" = ")[0];

/** Resolve exact display paths first; a name-only declaration path must remain unique. */
export function declarationPath(items: readonly TriggerTreeItem[], path: string) {
  let parent = "0",
    selected: TriggerTreeItem | undefined;
  for (const part of path.split("/")) {
    const children = items.filter((x) => x.parent === parent);
    const exact = children.filter((x) => x.text === part);
    const matches = exact.length ? exact : children.filter((x) => nameOf(x.text) === part);
    if (matches.length !== 1) throw Error("LIVE_TRIGGER_DECLARATION_PATH_NOT_UNIQUE_OR_MISSING");
    selected = matches[0];
    parent = selected.handle;
  }
  if (!selected) throw Error("LIVE_TRIGGER_DECLARATION_PATH_REQUIRED");
  return selected;
}
async function select(
  c: DeclarationContext,
  path: string,
  view: z.infer<typeof triggerDeclarationSchema>["view"],
  member?: string,
) {
  if ((view === "local" || view === "parameter") !== (member !== undefined))
    throw Error("LIVE_TRIGGER_DECLARATION_MEMBER_SCOPE_REQUIRED");
  const tree = await readTriggerTreePages(c.desktop, c.window, 28),
    item = declarationPath(tree.items, path);
  await c.guardArchive();
  z.object({ ready: z.literal(true) }).parse(
    await c.desktop.command(c.window, 69, { field: "preflight" }),
  );
  await c.desktop.command(c.window, 55, {
    unit: "28",
    field: item.handle,
    expected: tree.fingerprint,
  });
  if (view === "return_type") {
    const detail = await readTriggerTreePages(c.desktop, c.window, 154);
    const roots = detail.items.filter(
      (x) => x.parent === "0" && nameOf(x.text) === nameOf(item.text),
    );
    const returns = detail.items.filter(
      (x) =>
        roots.length === 1 && x.parent === roots[0].handle && x.text.startsWith("Return Type:"),
    );
    if (returns.length !== 1) throw Error("LIVE_TRIGGER_FUNCTION_RETURN_TYPE_UNAVAILABLE");
    await c.desktop.command(c.window, 55, {
      unit: "154",
      field: returns[0].handle,
      expected: detail.fingerprint,
    });
  }
  let detail: Awaited<ReturnType<typeof readTriggerTreePages>> | undefined,
    selectedMember: TriggerTreeItem | undefined;
  if (view === "local" || view === "parameter") {
    detail = await readTriggerTreePages(c.desktop, c.window, 134);
    const roots = detail.items.filter(
      (x) => x.parent === "0" && nameOf(x.text) === nameOf(item.text),
    );
    const groups = detail.items.filter(
      (x) =>
        roots.length === 1 &&
        x.parent === roots[0].handle &&
        x.text === (view === "local" ? "Local Variables" : "Parameters"),
    );
    const matches = detail.items.filter(
      (x) =>
        groups.length === 1 &&
        x.parent === groups[0].handle &&
        (x.text === member || nameOf(x.text) === member),
    );
    if (matches.length !== 1) throw Error("LIVE_TRIGGER_DECLARATION_MEMBER_NOT_UNIQUE_OR_MISSING");
    selectedMember = matches[0];
    await c.desktop.command(c.window, 55, {
      unit: String(detail.id),
      field: selectedMember.handle,
      expected: detail.fingerprint,
    });
  }
  let panel: Panel | undefined;
  for (let i = 0; i < 30; i++) {
    try {
      panel = nativePanel.parse(
        await c.desktop.command(c.window, 69, { unit: item.handle, field: "read" }),
      );
      if (panel.kind === view) break;
    } catch (error) {
      if (!String(error).includes("PANEL_UNAVAILABLE")) throw error;
    }
    await c.pause(100);
  }
  if (!panel || panel.kind !== view || panel.treeFingerprint !== tree.fingerprint)
    throw Error("LIVE_TRIGGER_DECLARATION_PANEL_CHANGED");
  return { tree, item, panel, detail, selectedMember };
}
function fieldControl(panel: Panel, field: string, dimension = 1) {
  const base =
    panel.kind === "variable"
      ? 320
      : panel.kind === "local"
        ? 600
        : panel.kind === "parameter"
          ? 500
          : 615;
  const v = panel.kind === "variable";
  const id =
    field === "type"
      ? base
      : field === "subtype"
        ? base + 1
        : field === "constant"
          ? base + 5
          : field === "array"
            ? base + 6
            : field === "dimensions"
              ? base + 8
              : field === "default_enabled" && panel.kind === "parameter"
                ? 531
                : field === "option" && panel.kind === "parameter"
                  ? 526
                  : field === "initial"
                    ? panel.kind === "parameter"
                      ? 534
                      : panel.kind === "local"
                        ? 625
                        : v
                          ? 345
                          : 0
                    : 0;
  if (field === "size") {
    const count = Number(panel.controls.find((x) => x.id === base + 8)?.text);
    if (dimension > count) throw Error("LIVE_TRIGGER_ARRAY_DIMENSION_MISSING");
    const matches = panel.controls.filter(
      (x) =>
        x.id === (count === 1 ? base + 12 : base + 16 + 2 * (dimension - 1)) &&
        !["Defines Default Value", "Minimum Value:", "Maximum Value:", "Default Value:"].includes(
          x.text.replaceAll("&", ""),
        ),
    );
    if (matches.length !== 1) throw Error("LIVE_TRIGGER_ARRAY_SIZE_UNAVAILABLE");
    return matches[0];
  }
  const matches = panel.controls.filter(
    (x) =>
      x.id === id &&
      (field !== "constant" || x.text === "Constant") &&
      (field !== "array" || x.text === "Array"),
  );
  if (matches.length !== 1) throw Error("LIVE_TRIGGER_DECLARATION_FIELD_UNAVAILABLE");
  return matches[0];
}
const flags = { copiesCreated: 0, reopensMap: false, saved: false, retryMutation: false };

/** Native Rename retains the declaration object; graph readback does not establish all use sites. */
export async function renameDeclaration(
  c: DeclarationContext,
  input: z.input<typeof triggerDeclarationRenameSchema>,
) {
  const a = triggerDeclarationRenameSchema.parse(input),
    selected = await select(c, a.path, a.view, a.member);
  if (selected.panel.fingerprint !== a.expectedDeclarationHash)
    throw Error("LIVE_TRIGGER_DECLARATION_CHANGED");
  const member = selected.selectedMember,
    source = member ? selected.detail! : selected.tree,
    item = member ?? selected.item;
  if (nameOf(item.text) === a.name)
    return { status: "unchanged", ...flags, declarationFingerprint: selected.panel.fingerprint };
  if (
    source.items.some(
      (x) => x.handle !== item.handle && x.parent === item.parent && nameOf(x.text) === a.name,
    )
  )
    throw Error("LIVE_TRIGGER_DECLARATION_NAME_EXISTS");
  // Local/parameter names share one scope even though the editor puts them in separate groups.
  if (
    member &&
    source.items.some(
      (x) =>
        x.handle !== member.handle &&
        nameOf(x.text) === a.name &&
        source.items.some(
          (p) => p.handle === x.parent && ["Local Variables", "Parameters"].includes(p.text),
        ),
    )
  )
    throw Error("LIVE_TRIGGER_DECLARATION_NAME_EXISTS");
  await c.guardArchive();
  try {
    const ack = z
      .object({ submitted: z.literal(true), displaySuffix: z.string() })
      .parse(
        await c.desktop.command(c.window, 66, {
          unit: String(source.id),
          field: item.handle,
          expected: source.fingerprint,
          value: a.name,
        }),
      );
    c.window = await c.currentWindow();
    const after = await readTriggerTreePages(c.desktop, c.window, source.id),
      oldShape = structuralTree(source.items),
      fresh = structuralTree(after.items),
      index = source.items.findIndex((x) => x.handle === item.handle);
    const topology =
      oldShape.length === fresh.length &&
      oldShape.every(
        (x, i) =>
          x.parent === fresh[i].parent &&
          x.depth === fresh[i].depth &&
          x.stateImage === fresh[i].stateImage,
      );
    const targetVerified = topology && fresh[index].text === a.name + ack.displaySuffix;
    const changedLabels = topology
      ? fresh.flatMap((x, i) =>
          x.text === oldShape[i].text
            ? []
            : [{ index: i + 1, before: oldShape[i].text, after: x.text }],
        )
      : [];
    let rootPreserved = true;
    if (member) {
      const root = await readTriggerTreePages(c.desktop, c.window, 28);
      rootPreserved =
        JSON.stringify(structuralTree(root.items)) ===
        JSON.stringify(structuralTree(selected.tree.items));
    }
    return {
      status: targetVerified && rootPreserved ? "needs_validation" : "verification_failed",
      path: a.path,
      ...(a.member ? { member: a.member } : {}),
      name: a.name,
      nativeRenameVerified: targetVerified && rootPreserved,
      topologyPreserved: topology,
      changedLabels: changedLabels.slice(0, 32),
      changedLabelCount: changedLabels.length,
      dependentReferencesUnverified: true,
      ...flags,
    };
  } catch (error) {
    return {
      status: "unknown",
      path: a.path,
      ...(a.member ? { member: a.member } : {}),
      name: a.name,
      error: String(error),
      recovery:
        "Inspect this same declaration and its references; never repeat an unknown Rename automatically.",
      ...flags,
    };
  }
}
export async function readDeclaration(
  c: DeclarationContext,
  input: z.input<typeof triggerDeclarationSchema>,
) {
  const a = triggerDeclarationSchema.parse(input),
    selected = await select(c, a.path, a.view, a.member);
  return {
    status: "inspected",
    ...selected.panel,
    path: a.path,
    nativeLabel: selected.selectedMember?.text ?? selected.item.text,
    ...(a.member ? { member: a.member } : {}),
    declarationFingerprint: selected.panel.fingerprint,
    ...flags,
    mapMutation: false,
  };
}

/** One guarded change. Type/shape edits explicitly retain dependent-reference uncertainty. */
export async function setDeclaration(
  c: DeclarationContext,
  input: z.input<typeof triggerDeclarationSetSchema>,
) {
  const a = triggerDeclarationSetSchema.parse(input),
    selected = await select(c, a.path, a.view, a.member);
  if (selected.panel.fingerprint !== a.expectedDeclarationHash)
    throw Error("LIVE_TRIGGER_DECLARATION_CHANGED");
  const control = fieldControl(selected.panel, a.field, a.dimension);
  if (!control.enabled) throw Error("LIVE_TRIGGER_DECLARATION_FIELD_DISABLED");
  if (control.type === "ComboBox" && !control.options?.includes(String(a.value)))
    throw Error("LIVE_TRIGGER_DECLARATION_OPTION_NOT_FOUND");
  const mutating =
    a.field === "type" ||
    a.field === "subtype" ||
    ["array", "dimensions", "size", "constant", "default_enabled", "option"].includes(a.field);
  const optionNodes =
    a.field === "option" && control.tree && !control.tree.truncated
      ? control.tree.items.filter((x) => x.text === a.option)
      : [];
  if (
    a.field === "option" &&
    (optionNodes.length !== 1 || ![1, 2].includes(optionNodes[0].stateImage ?? 0))
  )
    throw Error("LIVE_TRIGGER_PARAMETER_OPTION_UNAVAILABLE");
  const current =
    a.field === "option"
      ? optionNodes[0].stateImage === 2
      : ["constant", "array", "default_enabled"].includes(a.field)
        ? control.checked
        : control.text;
  const checkbox = ["constant", "array", "default_enabled"].includes(a.field);
  if (
    String(current) === String(a.value) &&
    (!checkbox || control.checkState === undefined || control.checkState === (a.value ? 1 : 0))
  )
    return { status: "unchanged", ...flags, declarationFingerprint: selected.panel.fingerprint };
  await c.guardArchive();
  try {
    if (a.field === "initial" || (a.field === "size" && control.type === "Button")) {
      if (a.view === "return_type") throw Error("LIVE_TRIGGER_FUNCTION_VALUE_UNSUPPORTED");
      const value =
        typeof a.value === "number" || typeof a.value === "boolean" ? a.value : undefined;
      const result = await editParameterBinding({
        desktop: c.desktop,
        window: c.window,
        declaration: {
          handle: selected.item.handle,
          fingerprint: selected.panel.fingerprint,
          controlId: control.id,
          arraySize: a.field === "size",
        },
        source: "value",
        value,
        guardArchive: c.guardArchive,
        pause: c.pause,
      });
      if (result.status !== "submitted")
        return { ...result, path: a.path, field: a.field, ...flags };
    } else {
      await c.desktop.command(c.window, 69, {
        unit: selected.item.handle,
        field: a.field,
        value: a.field === "option" ? a.option! : String(a.value),
        ...(a.field === "option" ? { token: String(a.value) } : {}),
        expected: selected.panel.fingerprint,
      });
    }
    let panel: Panel | undefined;
    for (let i = 0; i < 30; i++) {
      c.window = await c.currentWindow();
      panel = nativePanel.parse(
        await c.desktop.command(c.window, 69, { unit: selected.item.handle, field: "read" }),
      );
      if (panel.fingerprint !== selected.panel.fingerprint) break;
      await c.pause(100);
    }
    if (!panel) throw Error("LIVE_TRIGGER_DECLARATION_READBACK_MISSING");
    const afterControl = fieldControl(panel, a.field, a.dimension);
    const afterOptions =
      a.field === "option" && afterControl.tree && !afterControl.tree.truncated
        ? afterControl.tree.items.filter((x) => x.text === a.option)
        : [];
    const actual =
      a.field === "option"
        ? afterOptions.length === 1 && [1, 2].includes(afterOptions[0].stateImage ?? 0)
          ? afterOptions[0].stateImage === 2
          : undefined
        : ["constant", "array", "default_enabled"].includes(a.field)
          ? afterControl.checked
          : afterControl.text;
    const expected =
      typeof a.value === "boolean" && a.field === "initial"
        ? a.value
          ? "True"
          : "False"
        : a.value;
    const verified =
      String(actual) === String(expected) &&
      (!checkbox ||
        afterControl.checkState === undefined ||
        afterControl.checkState === (a.value ? 1 : 0));
    const afterTree = await readTriggerTreePages(c.desktop, c.window, 28);
    const before = structuralTree(selected.tree.items),
      after = structuralTree(afterTree.items);
    const index = selected.tree.items.findIndex((x) => x.handle === selected.item.handle);
    let preserved =
      before.length === after.length &&
      before.every(
        (x, i) =>
          x.parent === after[i].parent &&
          x.depth === after[i].depth &&
          x.stateImage === after[i].stateImage &&
          (i === index || x.text === after[i].text),
      );
    if (selected.detail && selected.selectedMember) {
      const body = await readTriggerTreePages(c.desktop, c.window, selected.detail.id);
      const old = structuralTree(selected.detail.items),
        fresh = structuralTree(body.items);
      const changed = selected.detail.items.findIndex(
        (x) => x.handle === selected.selectedMember!.handle,
      );
      preserved =
        preserved &&
        old.length === fresh.length &&
        old.every(
          (x, i) =>
            x.parent === fresh[i].parent &&
            x.depth === fresh[i].depth &&
            x.stateImage === fresh[i].stateImage &&
            (i === changed || x.text === fresh[i].text),
        );
    }
    return {
      status:
        verified && preserved ? (mutating ? "needs_validation" : "applied") : "verification_failed",
      path: a.path,
      ...(a.member ? { member: a.member } : {}),
      field: a.field,
      previousValue: current,
      value: a.value,
      nativeDeclarationVerified: verified && preserved,
      declarationFingerprint: panel.fingerprint,
      treeFingerprint: afterTree.fingerprint,
      dependentReferencesUnverified: mutating,
      ...flags,
    };
  } catch (error) {
    return { status: "unknown", path: a.path, field: a.field, error: String(error), ...flags };
  }
}

export async function newDeclaration(
  c: DeclarationContext,
  input: z.input<typeof triggerNewDeclarationSchema>,
) {
  const a = triggerNewDeclarationSchema.parse(input),
    tree = await readTriggerTreePages(c.desktop, c.window, 28);
  if (tree.fingerprint !== a.expectedTreeHash) throw Error("LIVE_TRIGGER_DECLARATION_TREE_CHANGED");
  const parent = declarationPath(tree.items, a.path);
  if (tree.items.some((x) => x.parent === parent.handle && nameOf(x.text) === a.name))
    throw Error("LIVE_TRIGGER_DECLARATION_NAME_EXISTS");
  await c.guardArchive();
  z.object({ ready: z.literal(true) }).parse(
    await c.desktop.command(c.window, 69, { field: "preflight" }),
  );
  await c.desktop.command(c.window, 55, {
    unit: "28",
    field: parent.handle,
    expected: tree.fingerprint,
  });
  let submitted = false;
  try {
    submitted = true; // An exception may lose the original command's reply.
    const ack = z.object({ submitted: z.literal(true), nameSubmitted: z.boolean() }).parse(
      await c.desktop.command(c.window, 69, {
        unit: parent.handle,
        field: "create",
        value: a.kind,
        token: a.name,
        expected: tree.fingerprint,
      }),
    );
    c.window = await c.currentWindow();
    const after = await readTriggerTreePages(c.desktop, c.window, 28);
    const matches = after.items.filter(
      (x) =>
        x.parent === parent.handle &&
        nameOf(x.text) === a.name &&
        !tree.items.some((t) => t.handle === x.handle),
    );
    const added = matches.length === 1 ? matches[0] : undefined;
    const remainder = added ? after.items.filter((x) => x.handle !== added.handle) : after.items;
    const verified =
      ack.nameSubmitted &&
      added &&
      JSON.stringify(structuralTree(tree.items)) === JSON.stringify(structuralTree(remainder));
    return {
      status: verified ? "needs_parameters" : "verification_failed",
      path: a.path + "/" + a.name,
      kind: a.kind,
      name: a.name,
      nativeTreeVerified: !!verified,
      treeFingerprint: after.fingerprint,
      ...flags,
    };
  } catch (error) {
    if (!submitted) throw error;
    return { status: "unknown", error: String(error), ...flags };
  }
}
