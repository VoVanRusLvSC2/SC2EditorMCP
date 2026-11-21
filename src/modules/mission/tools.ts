import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { missionPlanInput, planIdSchema, projectIdSchema } from "./spec.js";
import { missionCheckpointInput, type MissionWorkspace } from "./workspace.js";
import { missionBuildInput, missionBuildSpecSchema } from "./buildSpec.js";
import { planMissionLayouts } from "./layout.js";
import { missionModInput } from "./modBuilder.js";
import { missionInspectInput } from "./inspect.js";
import { missionContract, missionContractInput } from "./contracts.js";
import { listMissionStyles, missionStylesInput } from "./campaignStyles.js";
import { missionMaterialCatalog, missionMaterialsInput } from "./materialStyles.js";
import { missionDecorDensity, missionDecorDensityInput } from "./decorDensity.js";
import type { NativeEditorBridge } from "../../integrations/native/bridge.js";
import type { ProjectTestWorkspace } from "../testing/workspace.js";
import {
  captureMissionViews,
  missionVerifyInput,
  missionViewsInput,
  verifyMission,
} from "./verification.js";

const project = { projectId: projectIdSchema };

async function result(run: () => Promise<unknown>) {
  try {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ missionProject: await run() }) }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        },
      ],
    };
  }
}

export function registerMissionTools(
  server: McpServer,
  mission: MissionWorkspace,
  native: { tests: () => ProjectTestWorkspace; editor: () => NativeEditorBridge },
) {
  server.registerTool(
    "mission.contract",
    {
      description:
        "Discover the model's inputs, tool sequence and outputs for mission authoring. Omit section for the short index. Select a section for its exact JSON Schema.",
      inputSchema: missionContractInput,
      annotations: { readOnlyHint: true },
    },
    (args) => result(async () => missionContract(args.section)),
  );

  server.registerTool(
    "mission.styles",
    {
      description:
        "Discover observed campaign terrain styles, including Wings of Liberty, Heart of the Swarm, Legacy of the Void, and all nine Nova mission sources. Returns tileset references and source names for original layouts.",
      inputSchema: missionStylesInput,
      annotations: { readOnlyHint: true },
    },
    (args) => result(() => listMissionStyles(args)),
  );

  server.registerTool(
    "mission.materials",
    {
      description:
        "Search a tileset by texture ID, reviewed description or material role. Simple name-based inferences and unclassified numbered slots remain distinguishable.",
      inputSchema: missionMaterialsInput,
      annotations: { readOnlyHint: true },
    },
    (args) => result(() => missionMaterialCatalog(args)),
  );

  server.registerTool(
    "mission.verify",
    {
      description:
        "Plan revision-bound Editor or game verification. Generated map layouts supply route legs and views. Set run=true to queue a ready suite and then poll project.test.status/report.",
      inputSchema: missionVerifyInput,
      annotations: { destructiveHint: false },
    },
    (args) => result(() => verifyMission(mission, native.tests(), args)),
  );

  server.registerTool(
    "mission.views",
    {
      description:
        "Queue original Editor captures at the overview, start, fork or objective for the exact current archive SHA-256. Poll editor.job for the PNG and native readback.",
      inputSchema: missionViewsInput,
      annotations: { destructiveHint: false },
    },
    (args) => result(() => captureMissionViews(mission, native.editor(), args)),
  );

  server.registerTool(
    "mission.buildMod",
    {
      description:
        "Build a dependent SC2Mod with a researched local ability energy-cost override and optional unit speed override. Verify the packed revision and persist the project receipt.",
      inputSchema: missionModInput,
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    (args) => result(() => mission.buildMod(args)),
  );

  server.registerTool(
    "mission.decor_density",
    {
      description:
        "Estimate authored decoration density from campaign main missions over the full terrain area. Optionally filter by campaign and tileset. Returns the interquartile range, median and scaled counts for the requested map size.",
      inputSchema: missionDecorDensityInput,
      annotations: { readOnlyHint: true },
    },
    (args) => result(() => missionDecorDensity(args)),
  );

  server.registerTool(
    "mission.checkpoint",
    {
      description:
        "List, name or restore a sealed mission revision. Saving and restoring require the exact current archive hash and no pending plan.",
      inputSchema: missionCheckpointInput,
    },
    (args) => result(() => mission.checkpoint(args)),
  );

  server.registerTool(
    "mission.layout",
    {
      description:
        "Rank deterministic layouts for a new SC2Map from a creation MissionSpec. Includes basin fork, expedition, defense hub and river valley layouts with reserved routes, zone pads and review views. Geometry planning only.",
      inputSchema: z.object({ spec: missionBuildSpecSchema }).strict(),
      annotations: { readOnlyHint: true },
    },
    (args) => result(async () => planMissionLayouts(args.spec)),
  );

  server.registerTool(
    "mission.build",
    {
      description:
        "Create a fresh SC2Map from a high-level creation MissionSpec. The selected recipe generates terrain, textures, water and zone points. With campaignDecor enabled, the builder selects, measures and places doodads in batches. The builder verifies the packed archive and records the project revision. Omit layoutId to use the preferred layout. Repeating the same successful request returns the current project.",
      inputSchema: missionBuildInput,
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    (args) => result(() => mission.build(args)),
  );

  server.registerTool(
    "mission.inspect",
    {
      description:
        "Read a compact index of a hash-pinned map or current mission revision. Optionally select a rectangle and search names or IDs. Returns placement matches, native GUI identifiers, declared dependencies and catalog files.",
      inputSchema: missionInspectInput,
      annotations: { readOnlyHint: true },
    },
    (args) => result(() => mission.inspect(args)),
  );

  server.registerTool(
    "mission.resume",
    {
      description:
        "Resume an offline mission project from the same workspace and projectId. Verify the saved current archive SHA-256 and return the pending MissionSpec plan or latest apply receipt.",
      inputSchema: z.object(project).strict(),
      annotations: { readOnlyHint: true },
    },
    (args) => result(() => mission.resume(args.projectId)),
  );

  server.registerTool(
    "mission.plan",
    {
      description:
        "Compile MissionSpec v1 placement edits for a packed SC2Map, including scoped moves of existing Doodads. First call supplies a workspace sourceArchive and its SHA-256. Later plans use the current baseSha256 from mission.resume. Persist the deterministic plan without editing the map. A new plan replaces the pending plan.",
      inputSchema: missionPlanInput,
      annotations: { destructiveHint: false },
    },
    (args) => result(() => mission.plan(args)),
  );

  server.registerTool(
    "mission.apply",
    {
      description:
        "Apply the pending plan to a working copy, repack and verify archive components, then publish a new current revision. Repeating the latest applied plan returns its receipt. Native Editor and gameplay checks are separate.",
      inputSchema: z.object({ ...project, planId: planIdSchema }).strict(),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    (args) => result(() => mission.apply(args.projectId, args.planId)),
  );
}
