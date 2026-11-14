import * as z from "zod/v4";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PendingComponent } from "./pendingComponent.js";
import { readTriggerTreePages } from "./triggerTreePages.js";
import { structuralTree, verifyTriggerInsertion } from "./triggerPaths.js";
import { declarationPath, type DeclarationContext } from "./triggerDeclaration.js";
import { liveFileDigest } from "./identity.js";

const target = z.object({
  archive: z.string().min(1).max(4096),
  windowId: z.string().regex(/^\d+$/),
});
const name = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .refine((v) => [...v].every((c) => c.charCodeAt(0) >= 32 && c !== "/" && c !== "*"));
export const triggerMemberCreateSchema = target
  .extend({
    path: z.string().min(1).max(2048),
    kind: z.enum(["local", "parameter"]),
    name,
    expectedDetailHash: z.string().regex(/^\d+$/),
  })
  .strict();
export const triggerMemberVerifySchema = target.extend({ pendingId: z.string().uuid() }).strict();
const tree = z.object({
  id: z.number().int(),
  fingerprint: z.string().regex(/^\d+$/),
  items: z
    .array(
      z.object({
        handle: z.string(),
        parent: z.string(),
        depth: z.number().int().min(0).max(16),
        text: z.string().max(512),
        stateImage: z.number().int().min(0).max(15).optional(),
      }),
    )
    .max(8192),
});
const recordSchema = z.object({
  id: z.string().uuid(),
  archive: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  processId: z.number().int().positive(),
  processStart: z.string().regex(/^\d+$/),
  path: z.string(),
  kind: z.enum(["local", "parameter"]),
  name,
  group: z.string(),
  left: tree,
  detail: tree,
});
const pending = new PendingComponent(
  "trigger-members",
  recordSchema,
  "LIVE_TRIGGER_MEMBER",
  32 * 1024 * 1024,
);
const nameOf = (text: string) => text.replace(/\s+<[^<>]+>$/, "").split(" = ")[0];
const flags = { copiesCreated: 0, reopensMap: false, saved: false, retryMutation: false };

/** A parameter's original generated grammar gains its new argument. Custom grammar must stay unchanged. */
export function verifyMemberInsertion(
  before: z.infer<typeof tree>,
  after: z.infer<typeof tree>,
  group: string,
  kind: "local" | "parameter",
  name: string,
) {
  const original = before.items.map((x) => ({ ...x }));
  if (kind === "parameter") {
    const oldNames = original.filter((x) => x.parent === group).map((x) => nameOf(x.text));
    const owner = original.find((x) => x.parent === "0");
    const grammar = original.find(
      (x) =>
        x.parent === owner?.handle &&
        x.text === `Grammar Text: ${owner.text}(${oldNames.join(",")})`,
    );
    if (grammar) grammar.text = `Grammar Text: ${owner!.text}(${[...oldNames, name].join(",")})`;
  }
  const added = verifyTriggerInsertion(original, after.items, group);
  return (
    !!added && nameOf(added.text) === name && !after.items.some((x) => x.parent === added.handle)
  );
}

async function finish(c: DeclarationContext, record: z.infer<typeof recordSchema>) {
  await c.guardArchive();
  if ((c.archiveSha256 ?? (await liveFileDigest(record.archive))) !== record.sha256)
    throw Error("LIVE_TRIGGER_MEMBER_ARCHIVE_CHANGED");
  let completed: { status: "created"; nameSubmitted: boolean; name?: string } | undefined;
  for (let i = 0; i < 50; i++) {
    try {
      const raw = await c.desktop.command(c.window, 52, { token: record.id });
      const value = z
        .object({
          status: z.literal("created"),
          nameSubmitted: z.boolean(),
          name: z.string().optional(),
        })
        .safeParse(raw);
      if (value.success) {
        completed = value.data;
        break;
      }
      // An alternate native modal is retained for inspection, not blindly accepted.
      return {
        status: "pending_native",
        pendingId: record.id,
        recovery:
          "Inspect the owned native declaration dialog and verify this same pendingId; never repeat New.",
        ...flags,
      };
    } catch (error) {
      if (!String(error).includes("DIALOG_NOT_READY")) throw error;
    }
    await c.pause(100);
  }
  if (!completed) return { status: "pending_native", pendingId: record.id, ...flags };
  c.window = await c.currentWindow();
  const left = await readTriggerTreePages(c.desktop, c.window, 28),
    owner = declarationPath(left.items, record.path);
  // Recovery reselects the recorded owner only after checking the complete root
  // graph. It does not repeat creation, edit a field or commit a dialog.
  if (
    JSON.stringify(structuralTree(left.items)) !== JSON.stringify(structuralTree(record.left.items))
  )
    throw Error("LIVE_TRIGGER_MEMBER_ROOT_CHANGED");
  await c.desktop.command(c.window, 69, { field: "preflight" });
  await c.desktop.command(c.window, 55, {
    unit: "28",
    field: owner.handle,
    expected: left.fingerprint,
  });
  const detail = await readTriggerTreePages(c.desktop, c.window, record.detail.id);
  const verified =
    completed.nameSubmitted &&
    (!completed.name || completed.name === record.name) &&
    verifyMemberInsertion(record.detail, detail, record.group, record.kind, record.name);
  if (verified) {
    await pending.release(c.window, record.archive, record.id);
    try {
      await c.desktop.command(c.window, 59, { field: "member_verified", token: record.id });
    } catch {
      /* The graph is verified and the journal released. Native flags expire with their window. */
    }
  }
  return {
    status: verified ? "needs_parameters" : "verification_failed",
    path: record.path,
    kind: record.kind,
    member: record.name,
    nativeTreeVerified: verified,
    detailFingerprint: detail.fingerprint,
    ...(!verified ? { pendingId: record.id } : {}),
    ...flags,
  };
}

/** One original New command with a shared recovery record, including lost acknowledgements. */
export async function createTriggerMember(
  c: DeclarationContext,
  input: z.input<typeof triggerMemberCreateSchema>,
) {
  const a = triggerMemberCreateSchema.parse(input),
    archive = c.archive ?? path.resolve(a.archive);
  if (await pending.read(c.window, archive))
    throw Error("LIVE_TRIGGER_MEMBER_PENDING_VERIFY_REQUIRED");
  await c.guardArchive();
  await c.desktop.command(c.window, 69, { field: "preflight" });
  const left = await readTriggerTreePages(c.desktop, c.window, 28),
    owner = declarationPath(left.items, a.path);
  await c.desktop.command(c.window, 55, {
    unit: "28",
    field: owner.handle,
    expected: left.fingerprint,
  });
  const detail = await readTriggerTreePages(c.desktop, c.window, 134);
  if (detail.fingerprint !== a.expectedDetailHash)
    throw Error("LIVE_TRIGGER_MEMBER_DETAIL_CHANGED");
  const roots = detail.items.filter(
    (x) => x.parent === "0" && nameOf(x.text) === nameOf(owner.text),
  );
  const groups = detail.items.filter(
    (x) =>
      roots.length === 1 &&
      x.parent === roots[0].handle &&
      x.text === (a.kind === "local" ? "Local Variables" : "Parameters"),
  );
  if (groups.length !== 1) throw Error("LIVE_TRIGGER_MEMBER_GROUP_REQUIRED");
  const scopes = new Set(
    detail.items
      .filter(
        (x) => x.parent === roots[0].handle && ["Local Variables", "Parameters"].includes(x.text),
      )
      .map((x) => x.handle),
  );
  if (detail.items.some((x) => scopes.has(x.parent) && nameOf(x.text) === a.name))
    throw Error("LIVE_TRIGGER_MEMBER_NAME_EXISTS");
  const group = groups[0],
    insertion = detail.items.filter((x) => x.parent === group.handle).at(-1) ?? group;
  await c.desktop.command(c.window, 55, {
    unit: String(detail.id),
    field: insertion.handle,
    expected: detail.fingerprint,
  });
  const record = recordSchema.parse({
    id: randomUUID(),
    archive,
    sha256: c.archiveSha256 ?? (await liveFileDigest(archive)),
    processId: c.window.processId,
    processStart: c.window.processStart,
    path: a.path,
    kind: a.kind,
    name: a.name,
    group: group.handle,
    left,
    detail,
  });
  await pending.reserve(c.window, record);
  try {
    await c.guardArchive();
    await c.desktop.command(c.window, 51, {
      unit: randomUUID(),
      field: `trigger.${a.kind}`,
      token: record.id,
      expected: `${left.fingerprint}:${detail.fingerprint}`,
      value: `${owner.handle}:${insertion.handle}:${a.name}`,
    });
    return await finish(c, record);
  } catch (error) {
    return { status: "unknown", pendingId: record.id, error: String(error), ...flags };
  }
}

export async function verifyTriggerMember(
  c: DeclarationContext,
  input: z.input<typeof triggerMemberVerifySchema>,
) {
  const a = triggerMemberVerifySchema.parse(input),
    archive = c.archive ?? path.resolve(a.archive);
  const record = await pending.read(c.window, archive);
  if (!record || record.id !== a.pendingId) throw Error("LIVE_TRIGGER_MEMBER_PENDING_ID_REQUIRED");
  try {
    return await finish(c, record);
  } catch (error) {
    return { status: "unknown", pendingId: record.id, error: String(error), ...flags };
  }
}
