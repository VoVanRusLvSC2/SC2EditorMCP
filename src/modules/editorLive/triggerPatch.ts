import * as z from "zod/v4";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { EditorWindow } from "./desktop.js";
import type { LiveTriggers } from "./triggers.js";
import type { LiveDocument } from "./document.js";
import { withEditorSequenceLease } from "./editorLease.js";
import {
  commands,
  section,
  triggerPatchSchema,
  triggerPatchRecoverSchema,
  compileTriggerPatch,
  type Step,
  type Args,
} from "./triggerPatchPlan.js";
import { journal, history, readHistory, type PatchRecord } from "./triggerPatchJournal.js";
import {
  verifyUnrelated,
  observeAcknowledgedInsertion,
  receiptIndex,
} from "./triggerPatchGraph.js";
export {
  triggerPatchSchema,
  triggerPatchRecoverSchema,
  compileTriggerPatch,
} from "./triggerPatchPlan.js";
export { observeAcknowledgedInsertion } from "./triggerPatchGraph.js";
const flags = { copiesCreated: 0, reopensMap: false, retryMutation: false, atomicUndo: false };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function summary(r: PatchRecord, pending = true) {
  const active = r.inflight && r.receipts.find((x) => x.step === r.inflight!.index + 1);
  const raw =
    active?.result && typeof active.result === "object" && !Array.isArray(active.result)
      ? (active.result as Args)
      : undefined;
  const operationResult: Args | undefined = raw ? {} : undefined;
  if (raw && operationResult)
    for (const key of [
      "status",
      "pendingId",
      "phase",
      "recovery",
      "createdAction",
      "createdEvent",
      "createdCondition",
      "nativeTreeVerified",
      "parameterVerified",
      "itemIndex",
    ]) {
      const v = raw[key];
      if (typeof v === "string") operationResult[key] = v.slice(0, 2000);
      else if (typeof v === "boolean" || typeof v === "number") operationResult[key] = v;
    }
  return {
    status: r.status,
    patchId: r.id,
    ...(pending ? { pendingId: r.id } : {}),
    completed: r.next,
    total: r.steps.length,
    ...(r.inflight ? { inflightStep: r.inflight.index + 1, inflightKind: r.inflight.kind } : {}),
    ...(operationResult ? { operationResult } : {}),
    ...(typeof operationResult?.pendingId === "string"
      ? { nativePendingId: operationResult.pendingId }
      : {}),
    receipts: r.receipts.map((x) => ({ step: x.step, command: x.command, status: x.status })),
    validationRequired: r.validation,
    ...(r.error ? { error: r.error } : {}),
    ...(r.save ? { save: r.save } : {}),
    saved: !!r.save && typeof r.save === "object" && "saved" in r.save ? r.save.saved : false,
    ...flags,
  };
}

/** One process lease, guarded native primitives and a durable cursor; never replay an in-flight step. */
export class LiveTriggerPatches {
  busy = false;
  private closed = false;
  private active?: Promise<unknown>;
  constructor(
    private readonly root: string,
    private readonly triggers: LiveTriggers,
    private readonly document: Pick<LiveDocument, "status" | "save">,
    private readonly enter: <T>(fn: () => Promise<T>) => Promise<T>,
    private readonly blocked: () => boolean,
  ) {}
  private async run<T>(fn: () => Promise<T>) {
    if (this.closed || this.busy || this.blocked()) throw Error("LIVE_TRIGGER_PATCH_BUSY");
    this.busy = true;
    const task = Promise.resolve().then(() => this.enter(fn));
    this.active = task;
    try {
      return await task;
    } finally {
      this.busy = false;
      this.active = undefined;
    }
  }
  private target(a: { archive: string; windowId: string }) {
    return { archive: path.resolve(this.root, a.archive), windowId: a.windowId };
  }
  private async checkpoint(r: PatchRecord, w: EditorWindow) {
    await journal.update(w, r);
  }
  private async finish(r: PatchRecord, w: EditorWindow) {
    await history(r);
    await journal.release(w, r.archive, r.id);
    return summary(r, false);
  }
  private rememberAlias(r: PatchRecord, step: Step, args: Args, index: number) {
    if (step.alias)
      r.aliases[step.alias] = {
        path: String(args.path),
        section: section(step),
        group: JSON.stringify(args.groupPath ?? []),
        index,
      };
  }
  async start(input: z.input<typeof triggerPatchSchema>) {
    const a = triggerPatchSchema.parse(input),
      plan = compileTriggerPatch(a);
    return this.run(async () => {
      const target = this.target(a),
        before = await this.triggers.snapshot({ ...target, paths: plan.paths });
      return withEditorSequenceLease(before.window, async () => {
        if (await journal.read(before.window, target.archive))
          throw Error("LIVE_TRIGGER_PATCH_PENDING_RECOVERY_REQUIRED");
        const fresh = await this.triggers.snapshot({ ...target, paths: plan.paths });
        if (fresh.sha256 !== before.sha256 || !same(fresh.graph, before.graph))
          throw Error("LIVE_TRIGGER_PATCH_PREPARATION_CHANGED");
        if (fresh.graph.missing.some((p) => !plan.future.includes(p)))
          throw Error("LIVE_TRIGGER_PATCH_OWNER_MISSING");
        const r: PatchRecord = {
          id: randomUUID(),
          archive: target.archive,
          sha256: fresh.sha256,
          processId: fresh.window.processId,
          processStart: fresh.window.processStart,
          path: a.path,
          paths: plan.paths,
          steps: plan.steps,
          next: 0,
          saveOnComplete: a.saveOnComplete,
          graph: fresh.graph,
          aliases: {},
          receipts: [],
          validation: [],
          status: "prepared",
        };
        await journal.reserve(fresh.window, r);
        return this.execute(target, r, fresh.window);
      });
    });
  }
  private async arguments(target: { archive: string; windowId: string }, r: PatchRecord, s: Step) {
    const spec = commands[s.command],
      args: Args = { ...s.args, ...target };
    if (spec.tree) {
      const page = await this.triggers.tree(target);
      args.expectedTreeHash = page.tree.fingerprint;
    }
    if (spec.declaration) {
      const a = {
        ...target,
        path: String(args.path),
        ...(args.view ? { view: args.view } : {}),
        ...(args.member ? { member: args.member } : {}),
      };
      const panel = await this.triggers.declaration(
        a as Parameters<LiveTriggers["declaration"]>[0],
      );
      args.expectedDeclarationHash = panel.declarationFingerprint;
    }
    if (spec.detail || s.indexRef) {
      const body = await this.triggers.details({
        ...target,
        path: String(args.path),
        section: section(s) as "actions" | "events" | "conditions",
        ...(args.groupPath ? { groupPath: args.groupPath as number[] } : {}),
        limit: 32,
      });
      if (spec.detail) args.expectedDetailHash = body.detailFingerprint;
      if (s.indexRef) {
        if (s.indexRef.name === "last")
          args[s.indexRef.field] =
            "totalActions" in body
              ? body.totalActions
              : "totalEvents" in body
                ? body.totalEvents
                : body.totalConditions;
        else {
          const alias = r.aliases[s.indexRef.name];
          if (
            !alias ||
            alias.path !== args.path ||
            alias.section !== section(s) ||
            alias.group !== JSON.stringify(args.groupPath ?? [])
          )
            throw Error("LIVE_TRIGGER_PATCH_ALIAS_SCOPE_CHANGED");
          args[s.indexRef.field] = alias.index;
        }
      }
    }
    if (spec.parameter) {
      const p = await this.triggers.parameters({
        archive: target.archive,
        windowId: target.windowId,
        path: args.path,
        section: args.section,
        itemIndex: args.itemIndex,
        ...(args.groupPath ? { groupPath: args.groupPath } : {}),
        ...(args.parameterPath ? { parameterPath: args.parameterPath } : {}),
        expectedDetailHash: args.expectedDetailHash,
        offset: 0,
        limit: 32,
      } as Parameters<LiveTriggers["parameters"]>[0]);
      args.expectedParameterHash = p.parameterFingerprint;
    }
    return spec.schema.parse(args) as Args;
  }
  private async execute(
    target: { archive: string; windowId: string },
    r: PatchRecord,
    w: EditorWindow,
  ) {
    try {
      for (; r.next < r.steps.length;) {
        const current = await this.triggers.snapshot({ ...target, paths: r.paths });
        if (current.sha256 !== r.sha256 || !same(current.graph, r.graph))
          throw Error("LIVE_TRIGGER_PATCH_CURRENT_GRAPH_CHANGED");
        const step = r.steps[r.next],
          args = await this.arguments(target, r, step);
        r.status = "running";
        r.inflight = { index: r.next, args, kind: "mutation" };
        await this.checkpoint(r, w);
        const result = await (
          this.triggers[commands[step.command].method] as (a: unknown) => Promise<unknown>
        ).call(this.triggers, args);
        const receipt = z.object({ status: z.string() }).passthrough().parse(result);
        r.receipts.push({
          step: r.next + 1,
          command: step.command,
          status: receipt.status,
          result,
        });
        if (
          !["applied", "unchanged", "needs_parameters", "needs_validation"].includes(receipt.status)
        ) {
          r.status =
            receipt.status === "unknown" || receipt.status === "pending_native"
              ? "unknown"
              : "stopped";
          await this.checkpoint(r, w);
          return summary(r);
        }
        if (["needs_parameters", "needs_validation"].includes(receipt.status))
          r.validation.push(r.next + 1);
        if (["edit", "move"].includes(step.command)) r.aliases = {};
        const after = await this.triggers.snapshot({ ...target, paths: r.paths });
        if (after.sha256 !== r.sha256) throw Error("LIVE_TRIGGER_PATCH_ARCHIVE_CHANGED");
        verifyUnrelated(r.graph, after.graph, step);
        if (step.alias) {
          const index =
            receiptIndex(receipt) ??
            observeAcknowledgedInsertion(r.graph, after.graph, step, args, receipt)?.index;
          if (index === undefined) throw Error("LIVE_TRIGGER_PATCH_INSERT_INDEX_UNCONFIRMED");
          this.rememberAlias(r, step, args, index);
        }
        r.graph = after.graph;
        r.next++;
        r.inflight = undefined;
        await this.checkpoint(r, w);
      }
      if (r.validation.length) {
        r.status = "needs_validation";
        await this.checkpoint(r, w);
        return this.finish(r, w);
      }
      if (r.saveOnComplete) {
        const before = await this.document.status(target);
        if (before.sha256 !== r.sha256) throw Error("LIVE_TRIGGER_PATCH_ARCHIVE_CHANGED");
        r.inflight = { index: r.next, args: { expectedSha256: before.sha256 }, kind: "save" };
        await this.checkpoint(r, w);
        r.save = await this.document.save({ ...target, expectedSha256: before.sha256 });
        const saved = z.object({ status: z.string() }).passthrough().parse(r.save);
        if (!["saved", "already_clean"].includes(saved.status)) {
          r.status = "unknown";
          await this.checkpoint(r, w);
          return summary(r);
        }
        r.inflight = undefined;
      }
      r.status = "applied";
      await this.checkpoint(r, w);
      return this.finish(r, w);
    } catch (error) {
      r.status = r.inflight ? "unknown" : "stopped";
      r.error = String(error);
      await this.checkpoint(r, w);
      return summary(r);
    }
  }
  async recover(input: z.input<typeof triggerPatchRecoverSchema>) {
    const a = triggerPatchRecoverSchema.parse(input);
    return this.run(async () => {
      const target = this.target(a),
        before = await this.triggers.snapshot({ ...target, paths: [] });
      return withEditorSequenceLease(before.window, async () => {
        const active = await journal.read(before.window, target.archive),
          r = active?.id === a.patchId ? active : await readHistory(a.patchId);
        if (
          r.archive.toLowerCase() !== target.archive.toLowerCase() ||
          r.processId !== before.window.processId ||
          r.processStart !== before.window.processStart
        )
          throw Error("LIVE_TRIGGER_PATCH_CONTEXT_CHANGED");
        if (active?.id !== r.id) return { ...summary(r, false), history: true };
        if (!r.inflight && ["applied", "needs_validation"].includes(r.status))
          return this.finish(r, before.window);
        const observed = await this.triggers.snapshot({ ...target, paths: r.paths }),
          unchanged = observed.sha256 === r.sha256 && same(observed.graph, r.graph);
        if (a.action === "inspect")
          return { ...summary(r), currentGraphMatches: unchanged, replayAllowed: false };
        if (a.action === "release") {
          await history(r);
          await journal.release(before.window, r.archive, r.id);
          return { ...summary(r, false), released: true, unresolvedMutation: !!r.inflight };
        }
        if (
          r.inflight?.kind === "mutation" &&
          r.inflight.index === r.next &&
          observed.sha256 === r.sha256
        ) {
          const ack = r.receipts.at(-1),
            step = r.steps[r.next];
          if (
            ack?.step === r.next + 1 &&
            ack.result &&
            typeof ack.result === "object" &&
            !Array.isArray(ack.result)
          ) {
            const proof = observeAcknowledgedInsertion(
              r.graph,
              observed.graph,
              step,
              r.inflight.args,
              ack.result as Args,
            );
            if (proof) {
              this.rememberAlias(r, step, r.inflight.args, proof.index);
              ack.result = {
                ...ack.result,
                recoveryObservation: { kind: "acknowledged_insertion", ...proof },
              };
              r.graph = observed.graph;
              r.next++;
              r.inflight = undefined;
              r.error = undefined;
              await this.checkpoint(r, before.window);
              return this.execute(target, r, before.window);
            }
          }
        }
        if (r.inflight)
          return {
            ...summary(r),
            currentGraphMatches: unchanged,
            recovery:
              "An in-flight native edit is retained. Inspect/recover that original operation; it will never be repeated by this patch.",
            replayAllowed: false,
          };
        if (!unchanged) throw Error("LIVE_TRIGGER_PATCH_CURRENT_GRAPH_CHANGED");
        r.error = undefined;
        return this.execute(target, r, before.window);
      });
    });
  }
  async close() {
    this.closed = true;
    await this.active;
  }
}
