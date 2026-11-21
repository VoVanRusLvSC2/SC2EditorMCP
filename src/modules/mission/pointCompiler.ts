import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { decodeUtf8 } from "../../core/fileTransactions.js";
import { PlacementDocument } from "../placement/document.js";
import { objectIdSchema, sha256Schema, type MissionSpec } from "./spec.js";

export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

export const changeSchema = z.object({
  edit: z.number().int().nonnegative(),
  kind: z.enum(["create", "move", "satisfied"]),
  objectId: objectIdSchema,
});

export const pointCompilationSchema = z.object({
  changes: z.array(changeSchema).min(1).max(32),
  objectsSha256: sha256Schema,
});

export function compilePoints(source: Buffer, spec: MissionSpec) {
  const doc = new PlacementDocument(decodeUtf8(source, "Objects"));
  const objects = doc.list();
  const names = new Set<string>();
  const targets = new Set<number>();
  const changes = spec.edits.map((edit, index): z.infer<typeof changeSchema> => {
    const { x, y, z } = edit.position;
    const position = { x: Number(x.toFixed(6)), y: Number(y.toFixed(6)), z: Number(z.toFixed(6)) };
    const matching =
      edit.op === "ensurePoint"
        ? objects.filter(
            (object) =>
              object.kind === "ObjectPoint" &&
              object.attributes.Name?.toLowerCase() === edit.name.toLowerCase(),
          )
        : objects.filter((object) => object.id === edit.objectId);
    if (matching.length > 1) throw Error("MISSION_POINT_AMBIGUOUS: edit " + index);

    const existing = matching[0];
    if (edit.op === "ensurePoint") {
      const name = edit.name.toLowerCase();
      if (names.has(name)) throw Error("MISSION_POINT_EDIT_CONFLICT: " + edit.name);
      names.add(name);
      if (!existing) {
        const objectId = doc.addPoint({ name: edit.name, position });
        targets.add(objectId);
        return { edit: index, kind: "create", objectId };
      }
    }
    const expectedKind = edit.op === "moveDoodad" ? "ObjectDoodad" : "ObjectPoint";
    if (existing?.kind !== expectedKind || !objectIdSchema.safeParse(existing.id).success)
      throw Error("MISSION_POINT_NOT_FOUND_OR_UNADDRESSABLE: edit " + index);
    const objectId = existing.id!;
    if (objects.filter((object) => object.id === objectId).length !== 1)
      throw Error("MISSION_POINT_ID_AMBIGUOUS: " + objectId);
    if (targets.has(objectId)) throw Error("MISSION_POINT_EDIT_CONFLICT: " + objectId);
    targets.add(objectId);

    const xyz = existing.position?.split(",");
    const samePosition =
      xyz?.length === 3 &&
      [position.x, position.y, position.z].every(
        (coordinate, axis) => xyz[axis].trim() !== "" && Number(xyz[axis]) === coordinate,
      );
    if (edit.op === "ensurePoint") {
      if (
        !samePosition ||
        existing.attributes.Type !== "Normal" ||
        existing.attributes.Name !== edit.name
      )
        throw Error("MISSION_POINT_NAME_CONFLICT: " + edit.name);
      return { edit: index, kind: "satisfied", objectId };
    }
    if (edit.op === "moveDoodad") {
      if (existing.catalogId !== edit.expectedActor)
        throw Error("MISSION_DOODAD_ACTOR_MISMATCH: " + objectId);
      const { minX, minY, maxX, maxY } = edit.area;
      const inside = (x: number, y: number) => x >= minX && x <= maxX && y >= minY && y <= maxY;
      if (
        minX >= maxX ||
        minY >= maxY ||
        !xyz ||
        !inside(Number(xyz[0]), Number(xyz[1])) ||
        !inside(position.x, position.y)
      )
        throw Error("MISSION_DOODAD_OUTSIDE_EDIT_AREA: " + objectId);
      if (!samePosition) doc.move(objectId, position);
    } else if (!samePosition) {
      doc.updatePoint(objectId, { position });
    }
    if (samePosition) return { edit: index, kind: "satisfied", objectId };
    return { edit: index, kind: "move", objectId };
  });
  return {
    summary: { changes, objectsSha256: digest(doc.source) },
    source: doc.source,
    originalSha256: digest(source),
  };
}
