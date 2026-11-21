import * as z from "zod/v4";

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const projectIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
export const archiveSchema = z
  .string()
  .max(512)
  .regex(/\.sc2map$/i);
export const planIdSchema = z.string().regex(/^mission_[0-9a-f]{64}$/);
export const objectIdSchema = z.number().int().min(1).max(2_147_483_647);

const coordinate = z.number().min(-1_000_000).max(1_000_000);
const position = z.object({ x: coordinate, y: coordinate, z: coordinate }).strict();

export const missionSpecSchema = z
  .object({
    version: z.literal(1),
    intent: z.string().trim().min(1).max(1000),
    edits: z
      .array(
        z.discriminatedUnion("op", [
          z
            .object({
              op: z.literal("ensurePoint"),
              name: z
                .string()
                .regex(/^[A-Za-z][A-Za-z0-9_ -]{0,79}$/)
                .refine((name) => name.trimEnd() === name),
              position,
            })
            .strict(),
          z.object({ op: z.literal("movePoint"), objectId: objectIdSchema, position }).strict(),
          z
            .object({
              op: z.literal("moveDoodad"),
              objectId: objectIdSchema,
              expectedActor: z.string().min(1).max(128),
              position,
              area: z
                .object({ minX: coordinate, minY: coordinate, maxX: coordinate, maxY: coordinate })
                .strict(),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(32),
  })
  .strict();

export const missionPlanInput = z
  .object({
    projectId: projectIdSchema,
    sourceArchive: archiveSchema.optional(),
    baseSha256: sha256Schema,
    spec: missionSpecSchema,
  })
  .strict();

export type MissionSpec = z.output<typeof missionSpecSchema>;
