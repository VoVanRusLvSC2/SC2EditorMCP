import * as z from "zod/v4";
import type { NativeEditorBridge } from "../../integrations/native/bridge.js";
import { testManifestSchema, type TestManifest } from "../testing/schemas.js";
import type { ProjectTestWorkspace } from "../testing/workspace.js";
import { projectIdSchema, sha256Schema } from "./spec.js";
import type { MissionWorkspace } from "./workspace.js";

const revision = { projectId: projectIdSchema, sha256: sha256Schema };
const checkSuite = z
  .object({
    contextLabel: z.string().trim().min(1).max(256).optional(),
    nativeSavedGame: z.boolean().default(false),
  })
  .strict();
const gameSuite = z
  .object({
    unitType: z.string().min(1).max(128).optional(),
    counterattack: z.boolean().default(false),
    owner: z.number().int().min(0).max(15).default(0),
    legTimeout: z.number().int().min(2).max(120).default(30),
  })
  .strict()
  .refine(
    (game) => game.unitType || game.counterattack,
    "Select a route unit or the counterattack check",
  );
export const missionVerifyInput = z
  .object({
    ...revision,
    editor: checkSuite.optional(),
    game: gameSuite.optional(),
    run: z.boolean().default(false),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (!args.editor && !args.game)
      ctx.addIssue({ code: "custom", message: "Select an Editor or game suite" });
    if (args.editor?.nativeSavedGame && !args.game)
      ctx.addIssue({
        code: "custom",
        message: "Native-saved game execution requires game and the actual GUI compile context",
      });
  });
export const missionViewsInput = z
  .object({
    ...revision,
    ids: z
      .array(z.enum(["start", "fork", "objective", "overview"]))
      .min(1)
      .max(4)
      .optional(),
  })
  .strict();

type Snapshot = Awaited<ReturnType<MissionWorkspace["resume"]>>;
type VerifyInput = z.output<typeof missionVerifyInput>;

export function missionTestManifest(state: Snapshot, args: VerifyInput): TestManifest {
  if (state.current.sha256 !== args.sha256) throw Error("MISSION_STALE_BASE");
  const contextLabel = args.editor?.contextLabel ?? state.creation?.gameplay?.contextLabel;
  if (args.editor?.nativeSavedGame && !contextLabel)
    throw Error("MISSION_NATIVE_SAVE_REQUIRES_GUI_CONTEXT");
  const manifest: z.input<typeof testManifestSchema> = {
    version: 1,
    map: state.current.archive,
    label: state.creation?.spec.name ?? state.projectId,
    ...(args.editor && {
      editor: {
        checks: contextLabel ? ["load", "save_reopen", "compile"] : ["load", "save_reopen"],
        contextLabel,
        gameArtifact: args.editor.nativeSavedGame ? "native_saved" : "source",
      },
    }),
  };
  if (args.game) {
    const creation = state.creation;
    if (!creation)
      throw Error(
        "MISSION_GAME_LAYOUT_REQUIRED: pass a custom manifest to project.test.plan for imported maps",
      );
    const points: NonNullable<TestManifest["game"]>["points"] = {};
    const routes: NonNullable<z.input<typeof testManifestSchema>["game"]>["routes"] = [];
    for (const route of args.game.unitType ? creation.routes : []) {
      for (const [index, point] of route.points.entries()) {
        const id = route.id + "_" + index;
        points[id] = point;
        if (index > 0)
          routes.push({
            id,
            from: route.id + "_" + (index - 1),
            to: id,
            type: args.game.unitType!,
            owner: args.game.owner,
            mobility: "ground",
            maxDeviation: route.width / 2,
            timeout: args.game.legTimeout,
            bidirectional: false,
          });
      }
    }
    manifest.game = {
      points,
      routes,
      views: creation.views.map((view) => ({
        id: view.id,
        camera: { ...view.target, yaw: view.yaw, distance: 27, pitch: 55 },
      })),
    };
    if (args.game.counterattack) {
      const recipe = creation.spec.gameplay;
      const authored = creation.gameplay;
      if (!recipe || !authored) throw Error("MISSION_COUNTERATTACK_REQUIRES_AUTHORED_GAMEPLAY");
      const goal = creation.zones[1].center;
      const { spawn } = authored;
      const distance = Math.hypot(spawn.x - goal.x, spawn.y - goal.y);
      const fraction = Math.min(4 / distance, 1);
      manifest.game.counterattack = {
        attacker: recipe.scout,
        guard: recipe.capture.guard,
        wave: recipe.wave.unit,
        count: recipe.wave.count,
        delay: recipe.wave.delay,
        hold: recipe.wave.hold,
        spawn,
        goal,
        approach: {
          x: goal.x + (spawn.x - goal.x) * fraction,
          y: goal.y + (spawn.y - goal.y) * fraction,
        },
      };
    }
  }
  return testManifestSchema.parse(manifest);
}

export async function verifyMission(
  mission: MissionWorkspace,
  tests: ProjectTestWorkspace,
  args: VerifyInput,
) {
  const state = await mission.resume(args.projectId);
  const manifest = missionTestManifest(state, args);
  const plan = await tests.plan(manifest);
  if (plan.sourceSha256 !== state.current.sha256) throw Error("MISSION_TEST_REVISION_CHANGED");
  const job = args.run && plan.ready ? await tests.run(plan.planId) : undefined;
  const reportRecorded = job?.report
    ? await mission.rememberVerification(args.projectId, {
        sourceSha256: plan.sourceSha256,
        jobId: job.jobId,
        report: job.report,
      })
    : false;
  return {
    projectId: args.projectId,
    revision: state.current,
    manifest,
    plan,
    ...(job ? { jobId: job.jobId, reportRecorded } : {}),
  };
}

export async function captureMissionViews(
  mission: MissionWorkspace,
  editor: NativeEditorBridge,
  args: z.output<typeof missionViewsInput>,
) {
  const state = await mission.resume(args.projectId);
  if (state.current.sha256 !== args.sha256) throw Error("MISSION_STALE_BASE");
  const creation = state.creation;
  if (!creation) throw Error("MISSION_VIEW_LAYOUT_REQUIRED");
  const { width, height } = creation.spec.map;
  const views = [
    ...creation.views.map((view) => ({ ...view, pitch: 55, distance: 27 })),
    {
      id: "overview" as const,
      target: { x: width / 2, y: height / 2 },
      yaw: 0,
      pitch: 68,
      distance: Math.max(width, height) * 0.77,
    },
  ];
  const selected = args.ids
    ? views.filter((view) => args.ids!.includes(view.id))
    : creation.spec.terrain.profile
      ? views
      : views.slice(0, 3);
  const captures = [];
  for (const view of selected) {
    const job = await editor.capture({
      archive: state.current.archive,
      expectedSha256: args.sha256,
      mode: "viewport",
      size: 1024,
      deadlineSeconds: 300,
      terrainCamera: {
        ...view.target,
        z: creation.baseHeight ?? 8,
        pitch: view.pitch,
        yaw: view.yaw,
        roll: 0,
        distance: view.distance,
        fov: 45,
      },
    });
    captures.push({ view: view.id, jobId: job.id });
  }
  return { projectId: state.projectId, revision: state.current, captures };
}
