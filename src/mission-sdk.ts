import { guiCallSchema } from "./modules/trigger/schemas.js";
export type { GuiCall, GuiValue } from "./modules/trigger/authoring.js";
import * as z from "zod/v4";

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const degrees = z.number().finite().min(-360).max(360);
const mechanic = z
  .object({
    id,
    // A hold needs consecutive game-time samples inside the stage radius.
    seconds: z.number().int().min(1).max(600),
    radius: z.number().min(1).max(12),
    approachWidth: z.number().min(3).max(12),
    landform: z.enum(["levelPad", "overlook", "sunkenYard"]).optional(),
    conditions: z
      .array(guiCallSchema.refine((c) => c.kind === "Condition"))
      .max(8)
      .optional(),
    onComplete: z
      .array(guiCallSchema.refine((c) => c.kind === "Action"))
      .max(16)
      .optional(),
  })
  .strict();

const facing = z
  .object({
    actor: id,
    variation: z.number().int().min(0).max(127).default(0),
    frontDegrees: degrees,
    standOff: z.number().min(0).max(14),
    height: z.number().min(0).max(12).default(0),
    source: z.string().trim().min(1).max(500),
  })
  .strict();

export const missionPackSchema = z
  .object({
    apiVersion: z.literal(1),
    id,
    mechanics: z.array(mechanic).max(64),
    facings: z.array(facing).max(512),
  })
  .strict()
  .superRefine((pack, ctx) => {
    for (const keys of [
      pack.mechanics.map((m) => m.id),
      pack.facings.map((f) => f.actor + "/" + f.variation),
    ]) {
      if (new Set(keys).size !== keys.length)
        ctx.addIssue({ code: "custom", message: "Duplicate mission pack contribution" });
    }
  });

export type MissionPack = z.output<typeof missionPackSchema>;
export function defineMissionPack(input: z.input<typeof missionPackSchema>): MissionPack {
  return missionPackSchema.parse(input);
}

export const missionStageSchema = z
  .object({
    id,
    zone: id,
    mechanic: id,
    title: z.string().trim().min(1).max(120),
  })
  .strict();
export interface MissionPluginContext {
  seed: number;
  width: number;
  height: number;
  zones: string[];
}
export interface MissionPlugin {
  apiVersion: 1;
  id: string;
  createPack(
    context: MissionPluginContext,
  ): z.input<typeof missionPackSchema> | Promise<z.input<typeof missionPackSchema>>;
}
export function defineMissionPlugin(plugin: MissionPlugin): MissionPlugin {
  return plugin;
}

export type MissionStage = z.output<typeof missionStageSchema>;

export function modelRotation(desiredRadians: number, measuredFrontDegrees: number): number {
  const turn = Math.PI * 2;
  return (((desiredRadians - (measuredFrontDegrees * Math.PI) / 180) % turn) + turn) % turn;
}
