import * as z from "zod/v4";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PendingComponent } from "./pendingComponent.js";
import { patchId, stepSchema } from "./triggerPatchPlan.js";
import { graphSchema } from "./triggerPatchGraph.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema = z.object({
  id: patchId,
  archive: z.string(),
  sha256: hash,
  processId: z.number().int().positive(),
  processStart: z.string(),
  path: z.string(),
  paths: z.array(z.string()).max(16),
  steps: z.array(stepSchema).min(1).max(64),
  next: z.number().int().min(0).max(64),
  saveOnComplete: z.boolean(),
  graph: graphSchema,
  aliases: z.record(
    z.string(),
    z.object({
      path: z.string(),
      section: z.string(),
      group: z.string(),
      index: z.number().int().positive(),
    }),
  ),
  receipts: z
    .array(
      z.object({ step: z.number(), command: z.string(), status: z.string(), result: z.unknown() }),
    )
    .max(64),
  validation: z.array(z.number()).max(64),
  status: z.enum(["prepared", "running", "stopped", "unknown", "needs_validation", "applied"]),
  inflight: z
    .object({
      index: z.number(),
      args: z.record(z.string(), z.unknown()),
      kind: z.enum(["mutation", "save"]),
    })
    .optional(),
  error: z.string().optional(),
  save: z.unknown().optional(),
});
export type PatchRecord = z.infer<typeof recordSchema>;
export const journal = new PendingComponent(
  "trigger-patches",
  recordSchema,
  "LIVE_TRIGGER_PATCH",
  32 * 1024 * 1024,
);
async function historyFile(id: string) {
  patchId.parse(id);
  const directory = path.join(
    os.tmpdir(),
    "SC2EditorToolkit-live-memory",
    "trigger-patches",
    "history",
  );
  await fs.mkdir(directory, { recursive: true });
  if (
    (await fs.lstat(directory)).isSymbolicLink() ||
    path.resolve(await fs.realpath(directory)).toLowerCase() !== directory.toLowerCase()
  )
    throw Error("LIVE_TRIGGER_PATCH_HISTORY_INVALID");
  return path.join(directory, id + ".json");
}
export async function history(record: PatchRecord) {
  const file = await historyFile(record.id),
    text = JSON.stringify(record) + "\n";
  await fs.writeFile(file, text, { flag: "wx" }).catch(async (error) => {
    if (error.code !== "EEXIST" || (await fs.readFile(file, "utf8")) !== text) throw error;
  });
}
export async function readHistory(id: string) {
  const file = await historyFile(id),
    stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
    throw Error("LIVE_TRIGGER_PATCH_HISTORY_INVALID");
  const r = recordSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
  if (r.id !== id) throw Error("LIVE_TRIGGER_PATCH_ID_CHANGED");
  return r;
}
