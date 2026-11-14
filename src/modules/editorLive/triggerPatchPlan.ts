import * as z from "zod/v4";
import { compileAuthorScript } from "../../app/authoringScript.js";
import {
  triggerTargetSchema,
  triggerBindSchema,
  triggerSetIntegerSchema,
  triggerSetRealSchema,
  triggerSetUnitSchema,
  triggerSetPointSchema,
  triggerSetWaitSchema,
  triggerSetPeriodicSchema,
  triggerAppendActionSchema,
  triggerAppendEventSchema,
  triggerAppendConditionSchema,
  triggerGraphEditSchema,
  triggerMoveSchema,
} from "./triggers.js";
import {
  triggerDeclarationSetSchema,
  triggerDeclarationRenameSchema,
  triggerNewDeclarationSchema,
} from "./triggerDeclaration.js";
import { triggerMemberCreateSchema } from "./triggerMembers.js";

export const patchId = z.string().uuid();
export const triggerPatchSchema = triggerTargetSchema
  .extend({
    path: z.string().min(1).max(1024),
    script: z.string().min(1).max(16384),
    saveOnComplete: z.boolean().default(false),
  })
  .strict();
export const triggerPatchRecoverSchema = triggerTargetSchema
  .extend({
    patchId,
    action: z.enum(["inspect", "continue", "release"]).default("inspect"),
  })
  .strict();

export type Args = Record<string, unknown>;
type Method =
  | "bind"
  | "setInteger"
  | "setReal"
  | "setUnit"
  | "setPoint"
  | "setWait"
  | "setPeriodic"
  | "appendAction"
  | "appendEvent"
  | "appendCondition"
  | "editGraph"
  | "move"
  | "declarationSet"
  | "declarationRename"
  | "newDeclaration"
  | "memberCreate";
interface Command {
  schema: z.ZodType;
  method: Method;
  detail?: boolean;
  parameter?: boolean;
  declaration?: boolean;
  tree?: boolean;
  append?: string;
  owner?: boolean;
}
export const commands: Record<string, Command> = {
  bind: { schema: triggerBindSchema, method: "bind", detail: true, parameter: true, owner: true },
  set_integer: {
    schema: triggerSetIntegerSchema,
    method: "setInteger",
    detail: true,
    parameter: true,
    owner: true,
  },
  set_real: {
    schema: triggerSetRealSchema,
    method: "setReal",
    detail: true,
    parameter: true,
    owner: true,
  },
  set_unit: {
    schema: triggerSetUnitSchema,
    method: "setUnit",
    detail: true,
    parameter: true,
    owner: true,
  },
  set_point: {
    schema: triggerSetPointSchema,
    method: "setPoint",
    detail: true,
    parameter: true,
    owner: true,
  },
  set_wait: { schema: triggerSetWaitSchema, method: "setWait", detail: true, owner: true },
  set_periodic: {
    schema: triggerSetPeriodicSchema,
    method: "setPeriodic",
    detail: true,
    owner: true,
  },
  append_action: {
    schema: triggerAppendActionSchema,
    method: "appendAction",
    detail: true,
    append: "actions",
    owner: true,
  },
  append_event: {
    schema: triggerAppendEventSchema,
    method: "appendEvent",
    append: "events",
    owner: true,
  },
  append_condition: {
    schema: triggerAppendConditionSchema,
    method: "appendCondition",
    detail: true,
    append: "conditions",
    owner: true,
  },
  edit: { schema: triggerGraphEditSchema, method: "editGraph", detail: true, owner: true },
  move: { schema: triggerMoveSchema, method: "move", detail: true, owner: true },
  declaration_set: {
    schema: triggerDeclarationSetSchema,
    method: "declarationSet",
    declaration: true,
  },
  declaration_rename: {
    schema: triggerDeclarationRenameSchema,
    method: "declarationRename",
    declaration: true,
  },
  new_declaration: { schema: triggerNewDeclarationSchema, method: "newDeclaration", tree: true },
  member_create: {
    schema: triggerMemberCreateSchema,
    method: "memberCreate",
    detail: true,
    owner: true,
  },
};
export const stepSchema = z.object({
  command: z.enum(Object.keys(commands) as [string, ...string[]]),
  args: z.record(z.string(), z.unknown()),
  alias: z.string().optional(),
  indexRef: z
    .object({ field: z.enum(["itemIndex", "actionIndex", "eventIndex"]), name: z.string() })
    .optional(),
});
export type Step = z.infer<typeof stepSchema>;
export const section = (s: Step): string =>
  (s.args.section ??
    commands[s.command].append ??
    (s.command === "set_periodic" ? "events" : "actions")) as string;
const owner = (s: Step) =>
  commands[s.command].owner || ["local", "parameter", "return_type"].includes(String(s.args.view));

/** The existing compact lexer supplies quoting/scalars; every native schema is checked before mutation. */
export function compileTriggerPatch(input: z.input<typeof triggerPatchSchema>): {
  steps: Step[];
  paths: string[];
  future: string[];
} {
  const a = triggerPatchSchema.parse(input),
    labels = new Set<string>();
  const source = a.script
    .split(/\r?\n/)
    .map((line) => {
      const raw = line.trim();
      return !raw || raw.startsWith("#")
        ? raw
        : raw.startsWith("live ") || raw.startsWith("live.")
          ? raw
          : "live trigger." + raw;
    })
    .join("\n");
  const parsed = source
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .flatMap((line) => compileAuthorScript(line, "stage")),
    steps: Step[] = [],
    paths = new Set<string>(),
    future = new Set<string>();
  if (!parsed.length || parsed.length > 64) throw Error("LIVE_TRIGGER_PATCH_STEP_BOUND");
  for (const line of parsed) {
    const command = line.tool.replace(/^live\.trigger\./, ""),
      spec = commands[command];
    if (!line.tool.startsWith("live.trigger.") || !spec)
      throw Error("LIVE_TRIGGER_PATCH_COMMAND_NOT_SUPPORTED: " + line.tool);
    const args = { ...line.args },
      step: Step = { command, args };
    for (const key of Object.keys(args))
      if (["archive", "windowId", "pendingId"].includes(key) || key.startsWith("expected"))
        throw Error("LIVE_TRIGGER_PATCH_OWNS_TARGET_AND_GUARDS");
    if (args.as !== undefined) {
      if (
        typeof args.as !== "string" ||
        !/^[A-Za-z_]\w{0,47}$/.test(args.as) ||
        labels.has(args.as) ||
        !spec.append
      )
        throw Error("LIVE_TRIGGER_PATCH_ALIAS_INVALID");
      step.alias = args.as;
      delete args.as;
    }
    for (const field of ["itemIndex", "actionIndex", "eventIndex"] as const) {
      const value = args[field];
      if (typeof value === "string" && (value === "last" || value.startsWith("@"))) {
        const name = value === "last" ? value : value.slice(1);
        if (step.indexRef || (name !== "last" && !labels.has(name)))
          throw Error("LIVE_TRIGGER_PATCH_INDEX_REFERENCE_INVALID");
        step.indexRef = { field, name };
        args[field] = 1;
      }
    }
    args.path ??= a.path;
    if (spec.parameter || command === "edit" || command === "move") args.section ??= "actions";
    const placeholder = {
      ...args,
      archive: a.archive,
      windowId: a.windowId,
      ...(spec.detail ? { expectedDetailHash: "1" } : {}),
      ...(spec.parameter ? { expectedParameterHash: "1" } : {}),
      ...(spec.declaration ? { expectedDeclarationHash: "1" } : {}),
      ...(spec.tree ? { expectedTreeHash: "1" } : {}),
    };
    const normalized = spec.schema.parse(placeholder) as Args;
    for (const key of Object.keys(args)) delete args[key];
    for (const [key, value] of Object.entries(normalized))
      if (!["archive", "windowId"].includes(key) && !key.startsWith("expected")) args[key] = value;
    if (step.alias) labels.add(step.alias);
    if (owner(step)) paths.add(String(args.path));
    if (
      command === "new_declaration" &&
      ["trigger", "function", "action_definition"].includes(String(args.kind))
    )
      future.add(args.path + "/" + args.name);
    if (command === "declaration_rename" && args.view === "return_type")
      future.add(String(args.path).split("/").slice(0, -1).concat(String(args.name)).join("/"));
    steps.push(step);
  }
  if (paths.size > 16) throw Error("LIVE_TRIGGER_PATCH_OWNER_BOUND");
  return { steps, paths: [...paths].sort(), future: [...future] };
}
