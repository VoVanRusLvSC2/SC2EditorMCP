import { constants, createReadStream, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import * as z from "zod/v4";
import { extractArchive, packArchive, readArchiveEntry } from "../../archive/archiveAdapter.js";
import { Workspace } from "../../core/workspace.js";
import { withWorkspaceLock } from "../../core/workspaceLock.js";
import { componentListWithObjects } from "../placement/document.js";
import { compilePoints, digest, pointCompilationSchema } from "./pointCompiler.js";
import { missionBuildInput, missionBuildSpecSchema } from "./buildSpec.js";
import { buildMissionMap, type MissionBuildProviders } from "./buildMap.js";
import { planMissionLayouts } from "./layout.js";
import { terrainPointSchema } from "../terrain/schemas.js";
import {
  missionPlanInput,
  missionSpecSchema,
  planIdSchema,
  projectIdSchema,
  sha256Schema,
} from "./spec.js";

import { buildMissionMod, missionModInput, missionModSpecSchema } from "./modBuilder.js";
import { inspectMissionArchive, missionInspectInput } from "./inspect.js";
const revisionSchema = z
  .object({
    archive: z
      .string()
      .max(512)
      .regex(/\.sc2(?:map|mod)$/i),
    sha256: sha256Schema,
  })
  .strict();
const checkpointName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const checkpointSchema = z.object({ name: checkpointName, revision: revisionSchema }).strict();
export const missionCheckpointInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), projectId: projectIdSchema }).strict(),
  z
    .object({
      action: z.enum(["save", "restore"]),
      projectId: projectIdSchema,
      name: checkpointName,
      expectedSha256: sha256Schema,
    })
    .strict(),
]);
const planSchema = z
  .object({
    id: planIdSchema,
    baseSha256: sha256Schema,
    spec: missionSpecSchema,
    diff: pointCompilationSchema,
  })
  .strict();
const receiptSchema = z
  .object({
    plan: planSchema,
    outcome: z.enum(["applied", "no_change"]),
    changedComponents: z.array(z.string()),
  })
  .strict();
const creationSchema = z
  .object({
    spec: missionBuildSpecSchema,
    layoutId: z.string(),
    builtSha256: sha256Schema,
    buildMs: z.number().int().nonnegative().optional(),
    baseHeight: z.number().optional(),
    landform: z
      .object({
        style: z.enum(["riverTerraces", "splitRidge"]),
        cliffCells: z.number().int().positive(),
        ramps: z.array(
          z.object({
            center: terrainPointSchema,
            direction: z.enum(["east", "north"]),
            lowerLevel: z.union([z.literal(1), z.literal(2)]),
            clearance: z.object({
              type: z.literal("rectangle"),
              minX: z.number(),
              minY: z.number(),
              maxX: z.number(),
              maxY: z.number(),
            }),
          }),
        ),
      })
      .optional(),
    routes: z.array(
      z.object({
        id: z.string(),
        width: z.number(),
        points: z.array(terrainPointSchema),
        length: z.number(),
      }),
    ),
    views: z.array(
      z.object({
        id: z.enum(["start", "fork", "objective"]),
        target: terrainPointSchema,
        yaw: z.number(),
      }),
    ),
    zones: z.array(z.object({ id: z.string(), center: terrainPointSchema, radius: z.number() })),
    previews: z.record(z.string(), z.string()),
    decor: z
      .array(
        z.object({
          role: z.enum(["landmark", "ruins", "vegetation", "bank", "canopy", "talus", "outpost"]),
          id: z.string(),
          position: terrainPointSchema,
        }),
      )
      .optional(),
    decorTiming: z
      .object({
        placementMs: z.number().int().nonnegative(),
        surfaceFinishMs: z.number().int().nonnegative(),
        baseTrimMs: z.number().int().nonnegative(),
      })
      .optional(),
    bridge: z
      .object({
        actor: z.string(),
        position: terrainPointSchema.extend({ z: z.number() }),
        left: terrainPointSchema,
        right: terrainPointSchema,
        span: z.number().positive(),
        width: z.number().positive(),
        scale: z.number().positive(),
        rotation: z.number(),
      })
      .optional(),
    river: z
      .object({
        samples: z.number().int().positive(),
        level: z.number(),
        minWidth: z.number().positive(),
        maxWidth: z.number().positive(),
        carrier: z.object({
          type: z.literal("rectangle"),
          minX: z.number(),
          minY: z.number(),
          maxX: z.number(),
          maxY: z.number(),
        }),
        centerline: z.array(terrainPointSchema).min(2),
      })
      .optional(),
    baseTrim: z
      .array(
        z
          .object({
            side: z.enum(["inner", "outer"]),
            bounds: z.object({
              minX: z.number(),
              minY: z.number(),
              maxX: z.number(),
              maxY: z.number(),
            }),
            sections: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(2)
      .optional(),
    routeChecks: z.array(z.object({ id: z.string(), samples: z.number(), maxSlope: z.number() })),
    gameplay: z
      .object({
        units: z.object({
          scout: z.number().int().positive(),
          guard: z.number().int().positive(),
          bonus: z.number().int().positive().optional(),
        }),
        routeId: z.string(),
        spawn: terrainPointSchema,
        contextLabel: z.string(),
        runtimeSha256: sha256Schema,
      })
      .strict()
      .optional(),
    repairs: z
      .array(
        z.object({ routeId: z.string(), at: terrainPointSchema, radius: z.number().positive() }),
      )
      .optional(),
    entryCount: z.number(),
    material: z.object({
      baseTexture: z.string().optional(),
      trail: z.string(),
      accent: z.string().optional(),
      detail: z.string().optional(),
      floorTexture: z.string().optional(),
      trimTexture: z.string().optional(),
    }),
  })
  .strict();
const verificationSchema = z
  .object({
    jobId: z.string().uuid(),
    sourceSha256: sha256Schema,
    report: z.string().min(1).max(512),
  })
  .strict();
const persistedReport = z.object({
  jobId: z.string().uuid(),
  sourceSha256: sha256Schema,
  state: z.enum(["completed", "cancelled"]),
  outcome: z
    .enum(["passed", "failed", "partial", "inconclusive", "unsupported", "not_checked"])
    .nullable(),
});
const modSchema = z
  .object({
    spec: missionModSpecSchema,
    authored: z.array(
      z.object({
        id: z.string(),
        domain: z.enum(["Unit", "Abil"]),
        path: z.string(),
        value: z.number(),
        file: z.string(),
      }),
    ),
    entryCount: z.number().int().positive(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    current: revisionSchema,
    baseline: revisionSchema.optional(),
    creation: creationSchema.optional(),
    mod: modSchema.optional(),
    verification: verificationSchema.optional(),
    pending: planSchema.optional(),
    lastApplied: receiptSchema.optional(),
    checkpoints: z.array(checkpointSchema).max(64).optional(),
  })
  .strict();

type Revision = z.infer<typeof revisionSchema>;
type Plan = z.infer<typeof planSchema>;
type State = z.infer<typeof stateSchema>;

async function hashArchive(file: string) {
  if (!(await fs.lstat(file)).isFile()) throw Error("MISSION_ARCHIVE_NOT_FILE");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function sealedHash(file: string) {
  const handle = await fs.open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  return hashArchive(file);
}

async function assertRevision(file: string, expected: string) {
  if ((await hashArchive(file)) !== expected) throw Error("MISSION_STALE_REVISION: " + file);
}

async function readState(root: string): Promise<State | undefined> {
  const file = path.join(root, "state.json");
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw Error("MISSION_INVALID_STATE_FILE");
    return stateSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// The candidate and the apply receipt become current together at this rename.
async function writeState(root: string, state: State) {
  const temporary = path.join(root, "state-" + randomUUID() + ".tmp");
  try {
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(JSON.stringify(state, null, 2) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, path.join(root, "state.json"));
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class MissionWorkspace {
  constructor(
    private readonly workspace: Workspace,
    private readonly builder?: () => MissionBuildProviders,
  ) {}

  async build(input: z.input<typeof missionBuildInput>) {
    const { projectId, spec, layoutId } = missionBuildInput.parse(input);
    const root = this.root(projectId);
    return withWorkspaceLock(root, async () => {
      const previous = await readState(root);
      if (previous) {
        const created = previous.creation;
        if (
          !created ||
          digest(JSON.stringify(created.spec)) !== digest(JSON.stringify(spec)) ||
          (layoutId && layoutId !== created.layoutId)
        )
          throw Error("MISSION_PROJECT_EXISTS: choose a new project ID or plan an edit");
        await this.currentFile(previous.current);
        return { projectId, current: previous.current, creation: created, replayed: true };
      }
      if (!this.builder) throw Error("MISSION_BUILD_PROVIDERS_UNAVAILABLE");
      const started = performance.now();
      const layouts = planMissionLayouts(spec);
      const layout = layouts.variants.find(
        (candidate) => candidate.id === (layoutId ?? layouts.preferredId),
      );
      if (!layout) throw Error("MISSION_LAYOUT_ID_STALE");
      const attempt = await fs.mkdtemp(path.join(root, "r-"));
      let published = false;
      try {
        const built = await buildMissionMap(this.workspace, this.builder(), spec, layout, attempt);
        const sha256 = await sealedHash(this.workspace.resolveUserPath(built.archive));
        const current = { archive: built.archive, sha256 };
        const creation = creationSchema.parse({
          spec,
          layoutId: layout.id,
          builtSha256: sha256,
          buildMs: Math.round(performance.now() - started),
          baseHeight: built.baseHeight,
          landform: built.landform,
          routes: layout.routes,
          views: layout.views,
          zones: layout.zones,
          previews: built.previews,
          decor: built.decor,
          decorTiming: built.decorTiming,
          bridge: built.bridge,
          river: built.river,
          baseTrim: built.baseTrim,
          gameplay: built.gameplay,
          routeChecks: built.routeChecks,
          repairs: built.repairs,
          entryCount: built.entryCount,
          material: built.material,
        });
        await writeState(root, { version: 1, current, creation });
        published = true;
        return { projectId, current, creation, replayed: false };
      } finally {
        if (!published)
          await fs.rm(attempt, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  async buildMod(input: z.input<typeof missionModInput>) {
    const { projectId, spec } = missionModInput.parse(input);
    const root = this.root(projectId);
    return withWorkspaceLock(root, async () => {
      const previous = await readState(root);
      if (previous) {
        if (
          !previous.mod ||
          digest(JSON.stringify(previous.mod.spec)) !== digest(JSON.stringify(spec))
        )
          throw Error("MISSION_PROJECT_EXISTS: choose a new project ID");
        await this.currentFile(previous.current);
        return { projectId, current: previous.current, mod: previous.mod, replayed: true };
      }
      if (!this.builder) throw Error("MISSION_BUILD_PROVIDERS_UNAVAILABLE");
      const attempt = await fs.mkdtemp(path.join(root, "r-"));
      let published = false;
      try {
        const built = await buildMissionMod(this.workspace, this.builder(), spec, attempt);
        const sha256 = await sealedHash(this.workspace.resolveUserPath(built.archive));
        const current = { archive: built.archive, sha256 };
        const mod = modSchema.parse({
          spec,
          authored: built.authored,
          entryCount: built.entryCount,
        });
        await writeState(root, { version: 1, current, mod });
        published = true;
        return { projectId, current, mod, replayed: false };
      } finally {
        if (!published)
          await fs.rm(attempt, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  private root(projectId: string) {
    return this.workspace.resolveUserPath(".sc2mcp-mission/" + projectIdSchema.parse(projectId));
  }

  private key(file: string) {
    return path.relative(this.workspace.root, file).replaceAll("\\", "/");
  }

  private async currentFile(revision: Revision) {
    const file = this.workspace.resolveUserPath(revision.archive);
    await assertRevision(file, revision.sha256);
    return file;
  }

  async checkpoint(input: z.input<typeof missionCheckpointInput>) {
    const args = missionCheckpointInput.parse(input);
    const root = this.root(args.projectId);
    return withWorkspaceLock(root, async () => {
      const state = await readState(root);
      if (!state) throw Error("MISSION_PROJECT_NOT_FOUND: " + args.projectId);
      await this.currentFile(state.current);
      const checkpoints = state.checkpoints ?? [];
      if (args.action === "list") return { current: state.current, checkpoints };
      if (args.expectedSha256 !== state.current.sha256 || state.pending)
        throw Error("MISSION_CHECKPOINT_CURRENT_REVISION_OR_PLAN_CONFLICT");
      const checkpoint = checkpoints.find(({ name }) => name === args.name);
      if (args.action === "save") {
        if (checkpoint) {
          if (checkpoint.revision.sha256 !== state.current.sha256)
            throw Error("MISSION_CHECKPOINT_NAME_IN_USE");
          return { current: state.current, checkpoint, replayed: true };
        }
        const created = { name: args.name, revision: state.current };
        await writeState(
          root,
          stateSchema.parse({ ...state, checkpoints: [...checkpoints, created] }),
        );
        return { current: state.current, checkpoint: created, replayed: false };
      }
      if (!checkpoint) throw Error("MISSION_CHECKPOINT_NOT_FOUND");
      await this.currentFile(checkpoint.revision);
      if (checkpoint.revision.sha256 === state.current.sha256)
        return { current: state.current, checkpoint, replayed: true };
      await writeState(root, {
        ...state,
        current: checkpoint.revision,
        lastApplied: undefined,
      });
      return { current: checkpoint.revision, checkpoint, replayed: false };
    });
  }

  async resume(projectId: string) {
    const root = this.root(projectId);
    // Atomic state reads need no writer lock. Archives referenced by state are retained.
    const state = await readState(root);
    if (!state) throw Error("MISSION_PROJECT_NOT_FOUND: " + projectId);
    await this.currentFile(state.current);
    const latest = state.verification;
    let verificationStatus:
      "completed" | "cancelled" | "stale" | "report_unavailable" | "report_unconfirmed" | undefined;
    let verificationOutcome: z.infer<typeof persistedReport>["outcome"] | undefined;
    if (latest) {
      if (latest.sourceSha256 !== state.current.sha256) verificationStatus = "stale";
      else {
        verificationStatus = "report_unavailable";
        try {
          const file = this.workspace.resolveUserPath(latest.report);
          const stat = await fs.lstat(file);
          if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
            throw Error("MISSION_TEST_REPORT_SIZE_OR_PATH");
          const report = persistedReport.parse(JSON.parse(await fs.readFile(file, "utf8")));
          if (report.jobId !== latest.jobId || report.sourceSha256 !== latest.sourceSha256)
            throw Error("MISSION_TEST_REPORT_REVISION_MISMATCH");
          verificationStatus = report.state;
          verificationOutcome = report.outcome;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            verificationStatus = "report_unconfirmed";
        }
      }
    }
    const phase = state.pending
      ? "planned"
      : verificationStatus === "completed" && verificationOutcome === "passed"
        ? "verified"
        : state.lastApplied
          ? "applied"
          : state.creation || state.mod
            ? "built"
            : "prepared";
    return { projectId, ...state, phase, verificationStatus, verificationOutcome };
  }

  async inspect(input: z.input<typeof missionInspectInput>) {
    const args = missionInspectInput.parse(input);
    const revision = args.projectId
      ? (await this.resume(args.projectId)).current
      : { archive: args.sourceArchive!, sha256: args.sha256 };
    if (revision.sha256 !== args.sha256) throw Error("MISSION_STALE_BASE");
    const file = await this.currentFile(revision);
    const index = await inspectMissionArchive(file, args);
    await assertRevision(file, revision.sha256);
    return { revision, ...index };
  }

  async rememberVerification(projectId: string, input: z.infer<typeof verificationSchema>) {
    const root = this.root(projectId);
    const verification = verificationSchema.parse({
      ...input,
      report: this.key(this.workspace.resolveUserPath(input.report)),
    });
    return withWorkspaceLock(root, async () => {
      const state = await readState(root);
      if (state?.current.sha256 !== verification.sourceSha256) return false;
      await writeState(root, { ...state, verification });
      return true;
    });
  }

  async plan(input: z.input<typeof missionPlanInput>) {
    const args = missionPlanInput.parse(input);
    const root = this.root(args.projectId);
    return withWorkspaceLock(root, async () => {
      const previous = await readState(root);
      if (previous?.mod) throw Error("MISSION_POINT_EDITS_REQUIRE_MAP");
      const source = args.sourceArchive && this.workspace.resolveUserPath(args.sourceArchive);
      if (!previous && !source) throw Error("MISSION_SOURCE_ARCHIVE_REQUIRED");
      const current = previous?.current ?? { archive: this.key(source!), sha256: args.baseSha256 };
      const file = await this.currentFile(current);
      if (args.baseSha256 !== current.sha256 || (source && this.key(source) !== current.archive))
        throw Error("MISSION_STALE_BASE: call mission.resume for the current revision");

      const objects = await readArchiveEntry(file, "Objects");
      const { summary } = compilePoints(objects, args.spec);
      await assertRevision(file, current.sha256);
      const payload = { baseSha256: current.sha256, spec: args.spec, diff: summary };
      const id = "mission_" + digest(JSON.stringify(payload));
      const plan = { id, ...payload };
      if (previous?.pending?.id !== id)
        await writeState(root, {
          version: 1,
          current,
          baseline: previous?.baseline ?? (previous?.lastApplied ? undefined : current),
          lastApplied: previous?.lastApplied,
          creation: previous?.creation,
          verification: previous?.verification,
          checkpoints: previous?.checkpoints,
          pending: plan,
        });
      return { projectId: args.projectId, current, plan };
    });
  }

  async apply(projectId: string, planId: string) {
    const root = this.root(projectId);
    planIdSchema.parse(planId);
    return withWorkspaceLock(root, async () => {
      const state = await readState(root);
      if (!state) throw Error("MISSION_PROJECT_NOT_FOUND: " + projectId);
      const file = await this.currentFile(state.current);
      const plan = state.pending;
      if (plan?.id !== planId) {
        if (state.lastApplied?.plan.id === planId)
          return { projectId, current: state.current, ...state.lastApplied, replayed: true };
        throw Error("MISSION_PLAN_NOT_CURRENT: " + planId);
      }
      if (plan.baseSha256 !== state.current.sha256) throw Error("MISSION_STALE_PLAN");
      const compiled = compilePoints(await readArchiveEntry(file, "Objects"), plan.spec);
      if (JSON.stringify(compiled.summary) !== JSON.stringify(plan.diff))
        throw Error("MISSION_PLAN_RECOMPILE_MISMATCH");

      const candidate =
        compiled.originalSha256 !== compiled.summary.objectsSha256
          ? await this.materialize(root, file, plan, compiled)
          : undefined;
      await assertRevision(file, plan.baseSha256);
      const current = candidate?.revision ?? state.current;
      const receipt = receiptSchema.parse({
        plan,
        outcome: candidate ? "applied" : "no_change",
        changedComponents: candidate?.changedComponents ?? [],
      });
      await writeState(root, { ...state, current, pending: undefined, lastApplied: receipt });
      return { projectId, current, ...receipt, replayed: false };
    });
  }

  private async materialize(
    root: string,
    source: string,
    plan: Plan,
    compiled: ReturnType<typeof compilePoints>,
  ) {
    // A killed process can leave an orphan attempt. No subsequent call uses its
    // mutable components or points at its candidate before state publication.
    const attempt = await fs.mkdtemp(path.join(root, "r-"));
    const snapshot = path.join(attempt, "base.SC2Map");
    const components = path.join(attempt, "map");
    const candidate = path.join(attempt, "candidate.SC2Map");
    let verified = false;
    try {
      await fs.copyFile(source, snapshot, constants.COPYFILE_EXCL);
      await assertRevision(snapshot, plan.baseSha256);
      const before = await extractArchive(snapshot, components);
      const workspace = new Workspace(components);
      const registration = "ComponentList.SC2Components";
      await workspace.applyRawTransaction(
        ["Objects", registration],
        (sources) => {
          if (digest(sources.get("Objects")!) !== compiled.originalSha256)
            throw Error("MISSION_PRIVATE_OBJECTS_CHANGED");
          return new Map([
            ["Objects", compiled.source],
            [registration, componentListWithObjects(sources.get(registration)!)],
          ]);
        },
        {
          dryRun: false,
          stage: false,
          backup: false,
          summary: "Apply the verified mission placement diff",
        },
      );
      const packed = await packArchive(components, candidate, { backup: false });
      const oldEntries = before.verification.contentSha256;
      const newEntries = packed.verification.contentSha256;
      const changedComponents = [
        ...new Set([...Object.keys(oldEntries), ...Object.keys(newEntries)]),
      ]
        .filter((entry) => oldEntries[entry] !== newEntries[entry])
        .sort();
      if (
        newEntries.Objects !== plan.diff.objectsSha256 ||
        changedComponents.some(
          (entry) => entry !== "Objects" && entry !== "ComponentList.SC2Components",
        )
      )
        throw Error("MISSION_UNEXPECTED_COMPONENT_DIFF");
      const sha256 = await sealedHash(candidate);
      verified = true;
      return { revision: { archive: this.key(candidate), sha256 }, changedComponents };
    } finally {
      if (!verified) {
        await fs.rm(attempt, { recursive: true, force: true }).catch(() => undefined);
      } else {
        await Promise.allSettled([
          fs.rm(snapshot, { force: true }),
          fs.rm(components, { recursive: true, force: true }),
        ]);
      }
    }
  }
}
