import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  archiveBackendAvailable,
  extractArchive,
  packArchive,
  readArchiveEntry,
} from "../archive/archiveAdapter.js";
import { PlacementDocument, componentListWithObjects } from "../modules/placement/document.js";
import type { MissionWorkspace } from "../modules/mission/workspace.js";
import { compilePoints } from "../modules/mission/pointCompiler.js";
import { missionSpecSchema } from "../modules/mission/spec.js";
import { missionBuildSpecSchema } from "../modules/mission/buildSpec.js";
import { planMissionLayouts } from "../modules/mission/layout.js";

const projectId = "resume-check";
const spec = missionSpecSchema.parse({
  version: 1,
  intent: "Add a named reference point for the basin inspection.",
  edits: [
    { op: "ensurePoint", name: "MissionResume_BasinReference", position: { x: 103, y: 46, z: 0 } },
  ],
});
const sha = async (file: string) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
type MissionResult<K extends "plan" | "resume" | "apply"> = Awaited<
  ReturnType<MissionWorkspace[K]>
>;

async function openMcp(root: string, preload?: string) {
  const client = new Client({ name: "mission-restart-acceptance", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...(preload ? ["--import", pathToFileURL(preload).href] : []), "dist/index.js"],
    env: { SC2_UI_ROOT: root, SC2_MCP_PROFILE: "workflow", SC2_MCP_MODULES: "" },
    stderr: "pipe",
  });
  await client.connect(transport);
  const raw = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const read = <T>(result: Awaited<ReturnType<typeof raw>>): T => {
    const entry = result.content[0];
    assert.equal(entry.type, "text");
    if (entry.type !== "text") throw Error("Expected MCP text");
    assert.notEqual(result.isError, true, entry.text);
    return JSON.parse(entry.text);
  };
  return {
    pid: transport.pid,
    close: () => client.close(),
    list: () => client.listTools(),
    raw,
    read,
    call: async <K extends "plan" | "resume" | "apply">(
      name: K,
      args: Record<string, unknown> = {},
    ) =>
      read<{ missionProject: MissionResult<K> }>(
        await raw("mission." + name, { projectId, ...args }),
      ).missionProject,
  };
}

// Fault injection lives in the test process loader. The server has no crash switch.
const interruptPublication = [
  'import { promises as fs } from "node:fs";',
  'import path from "node:path";',
  "const rename = fs.rename;",
  "fs.rename = async (from, to) => {",
  '  if (path.basename(to) === "state.json") {',
  '    const state = JSON.parse(await fs.readFile(from, "utf8"));',
  '    if (state.lastApplied?.outcome === "applied") {',
  "      await fs.access(path.join(process.env.SC2_UI_ROOT, state.current.archive));",
  '      await fs.writeFile(path.join(process.env.SC2_UI_ROOT, "interrupted.json"), JSON.stringify(state));',
  "      process.exit(73);",
  "    }",
  "  }",
  "  return rename(from, to);",
  "};",
].join("\n");

async function exercise(root: string, sourceArchive: string) {
  const source = path.join(root, sourceArchive);
  const baseSha256 = await sha(source);
  const preload = path.join(root, "interrupt.mjs");
  await fs.writeFile(preload, interruptPublication);

  const planner = await openMcp(root);
  let planned;
  try {
    const { tools } = await planner.list();
    assert.deepEqual(
      tools
        .filter(({ name }) => name.startsWith("mission."))
        .map(({ name }) => name)
        .sort(),
      [
        "mission.apply",
        "mission.build",
        "mission.buildMod",
        "mission.checkpoint",
        "mission.contract",
        "mission.decor_density",
        "mission.inspect",
        "mission.layout",
        "mission.materials",
        "mission.plan",
        "mission.resume",
        "mission.styles",
        "mission.verify",
        "mission.views",
      ],
    );
    planned = await planner.call("plan", { sourceArchive, baseSha256, spec });
    assert.equal(planned.current.sha256, baseSha256);
    assert.equal(planned.plan.diff.changes[0].kind, "create");
    const { missionProject: contract } = planner.read<{
      missionProject: { section: string; schema: { properties: Record<string, unknown> } };
    }>(await planner.raw("mission.contract", { section: "terrain" }));
    assert.equal(contract.section, "terrain");
    assert.ok(contract.schema.properties.terrain);
  } finally {
    await planner.close();
  }

  const crash = await openMcp(root, preload);
  try {
    const restored = await crash.call("resume");
    assert.deepEqual(restored.pending, planned.plan);
    // The transport must close without returning an apply result.
    await assert.rejects(crash.call("apply", { planId: planned.plan.id }), /closed|not connected/i);
  } finally {
    await crash.close();
  }
  const interrupted = JSON.parse(await fs.readFile(path.join(root, "interrupted.json"), "utf8"));
  assert.equal(interrupted.lastApplied.plan.id, planned.plan.id);
  assert.equal(await sha(path.join(root, interrupted.current.archive)), interrupted.current.sha256);

  const recovery = await openMcp(root);
  let applied;
  try {
    const resumed = await recovery.call("resume");
    assert.equal(resumed.phase, "planned");
    assert.deepEqual(resumed.baseline, planned.current);
    assert.deepEqual(resumed.current, planned.current);
    assert.deepEqual(resumed.pending, planned.plan);
    applied = await recovery.call("apply", { planId: resumed.pending!.id });
    assert.equal(applied.outcome, "applied");
    assert.notEqual(applied.current.archive, interrupted.current.archive);
    assert.notEqual(applied.current.sha256, baseSha256);
    assert.deepEqual(applied.changedComponents, ["Objects"]);
  } finally {
    await recovery.close();
  }

  const retry = await openMcp(root);
  try {
    const resumed = await retry.call("resume");
    assert.equal(resumed.phase, "applied");
    assert.deepEqual(resumed.baseline, planned.current);
    assert.deepEqual(resumed.current, applied.current);
    assert.equal(resumed.pending, undefined);
    assert.equal(resumed.lastApplied?.plan.id, applied.plan.id);
    const repeated = await retry.call("apply", { planId: applied.plan.id });
    assert.equal(repeated.replayed, true);
    assert.deepEqual(repeated.current, applied.current);
    const { missionProject: index } = retry.read<{
      missionProject: Awaited<ReturnType<MissionWorkspace["inspect"]>>;
    }>(
      await retry.raw("mission.inspect", {
        projectId,
        sha256: applied.current.sha256,
        query: "MissionResume_BasinReference",
        area: { minX: 102, minY: 45, maxX: 104, maxY: 47 },
        limit: 1,
      }),
    );
    assert.equal(index.placements.matched, 1);
    assert.equal(index.placements.items[0].id, applied.plan.diff.changes[0].objectId);

    const stale = await retry.raw("mission.plan", { projectId, sourceArchive, baseSha256, spec });
    assert.equal(stale.isError, true);
    assert.match(JSON.stringify(stale.content), /MISSION_STALE_BASE/);

    const newPlan = await retry.call("plan", { baseSha256: applied.current.sha256, spec });
    assert.deepEqual(newPlan.plan.diff.changes, [
      { edit: 0, kind: "satisfied", objectId: applied.plan.diff.changes[0].objectId },
    ]);
    // Also exercise the registered batch path, including its compact receipt.
    const result = retry.read<{
      steps: Array<{ result: { missionProject: MissionResult<"apply"> } }>;
    }>(
      await retry.raw("modkit.batch", {
        steps: [
          { id: "apply", tool: "mission.apply", args: { projectId, planId: newPlan.plan.id } },
        ],
      }),
    );
    const noop = result.steps[0].result.missionProject;
    assert.equal(noop.outcome, "no_change");
    assert.deepEqual(noop.current, applied.current);
    assert.deepEqual(noop.changedComponents, []);
  } finally {
    await retry.close();
  }

  const finalArchive = path.join(root, applied.current.archive);
  assert.equal(await sha(finalArchive), applied.current.sha256);
  const sourceMap = await extractArchive(source, path.join(root, "read-base"));
  const finalMap = await extractArchive(finalArchive, path.join(root, "read-final"));
  const before = sourceMap.verification.contentSha256;
  const after = finalMap.verification.contentSha256;
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  assert.deepEqual(
    Object.keys(before).filter((file) => before[file] !== after[file]),
    ["Objects"],
  );

  const doc = new PlacementDocument(
    (await readArchiveEntry(finalArchive, "Objects")).toString("utf8"),
  );
  const points = doc
    .list()
    .filter(
      (o) => o.kind === "ObjectPoint" && o.attributes.Name === "MissionResume_BasinReference",
    );
  assert.equal(points.length, 1);
  assert.equal(points[0].id, applied.plan.diff.changes[0].objectId);
  assert.equal(points[0].position, "103,46,0");
  assert.equal(await sha(source), baseSha256);

  return {
    sourceArchive,
    baseSha256,
    finalArchive,
    finalSha256: applied.current.sha256,
    interruptedArchive: interrupted.current.archive,
    planId: applied.plan.id,
    pointId: points[0].id,
    pointCount: points.length,
    changedComponents: applied.changedComponents,
    archiveComponents: Object.keys(after).length,
    pids: [planner.pid, crash.pid, recovery.pid, retry.pid],
    interruptedAfterArchiveWrite: true,
    replayedWithSameRevision: true,
    freshPlanOutcome: "no_change",
  };
}

test("point compilation preserves existing IDs and rejects conflicting names", () => {
  const doc = PlacementDocument.create();
  const id = doc.addPoint({ name: "Basin", position: { x: 3, y: 1, z: 0 } });
  const source = Buffer.from(doc.source);
  assert.throws(
    () =>
      compilePoints(source, {
        ...spec,
        edits: [{ op: "ensurePoint", name: "basin", position: { x: 3, y: 1, z: 0 } }],
      }),
    /MISSION_POINT_NAME_CONFLICT/,
  );
  const moved = compilePoints(source, {
    ...spec,
    edits: [{ op: "movePoint", objectId: id, position: { x: 4, y: 1, z: 0 } }],
  });
  assert.deepEqual(moved.summary.changes, [{ edit: 0, kind: "move", objectId: id }]);
  const ambiguous = new PlacementDocument(doc.source);
  ambiguous.addPoint({ name: "Basin", position: { x: 3, y: 1, z: 0 } });
  assert.throws(
    () =>
      compilePoints(Buffer.from(ambiguous.source), {
        ...spec,
        edits: [{ op: "ensurePoint", name: "Basin", position: { x: 3, y: 1, z: 0 } }],
      }),
    /MISSION_POINT_AMBIGUOUS/,
  );
});

test(
  "MCP resumes after interruption and applies a named point exactly once",
  {
    timeout: 90_000,
    skip: !archiveBackendAvailable(),
  },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc2-mission-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const components = path.join(root, "fixture");
    await fs.mkdir(components);
    await fs.writeFile(path.join(components, "Objects"), PlacementDocument.create().source);
    await fs.writeFile(
      path.join(components, "ComponentList.SC2Components"),
      componentListWithObjects(""),
    );
    await fs.writeFile(path.join(components, "Unrelated"), "keep exact bytes");
    await packArchive(components, path.join(root, "Base.SC2Map"), { backup: false });
    const evidence = await exercise(root, "Base.SC2Map");
    await fs.appendFile(evidence.finalArchive, "external revision");
    const verifier = await openMcp(root);
    try {
      const result = await verifier.raw("mission.resume", {
        projectId,
      });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /MISSION_STALE_REVISION/);
    } finally {
      await verifier.close();
    }
  },
);

test(
  "MCP restart acceptance on a private copy of Smash and Grab",
  {
    timeout: 120_000,
    skip: !process.env.SC2_MISSION_ACCEPTANCE_SOURCE,
  },
  async () => {
    const source = path.resolve(process.env.SC2_MISSION_ACCEPTANCE_SOURCE!);
    const parent = path.resolve(process.env.SC2_MISSION_ACCEPTANCE_PARENT ?? os.tmpdir());
    const root = await fs.mkdtemp(path.join(parent, "sc2-mission-smash-"));
    const baseSha256 = await sha(source);
    await fs.copyFile(source, path.join(root, "Base.SC2Map"));
    const evidence = await exercise(root, "Base.SC2Map");
    assert.equal(evidence.baseSha256, baseSha256);
    assert.equal(await sha(source), baseSha256);
    await fs.writeFile(
      path.join(root, "acceptance.json"),
      JSON.stringify({ original: source, ...evidence }, null, 2),
    );
    console.log("Smash and Grab restart evidence:", path.join(root, "acceptance.json"));
  },
);

test("layout families change topology independently of the seed", () => {
  const common = {
    version: 2,
    mode: "create",
    intent: "Compare different map graphs",
    name: "Layout comparison",
    seed: 124,
    map: { width: 96, height: 96 },
    terrain: { tileSet: "Agria" },
    layout: {
      start: { id: "Camp", radius: 10 },
      objective: { id: "Gate", radius: 10 },
      bonus: { id: "Outpost", radius: 6 },
      routeWidth: 6,
      variantCount: 8,
    },
  };
  const plan = (pattern: "basinFork" | "expedition" | "defenseHub") =>
    planMissionLayouts(
      missionBuildSpecSchema.parse({
        ...common,
        layout: { ...common.layout, pattern },
      }),
    ).variants[0];
  const basin = plan("basinFork"),
    expedition = plan("expedition"),
    hub = plan("defenseHub");
  assert.deepEqual(basin.routes[0].points.at(-1), basin.routes[1].points.at(-1));
  assert.deepEqual(expedition.routes[1].points.at(-1), expedition.zones[2].center);
  assert.ok(
    expedition.routes[0].points.some(
      (point) =>
        point.x === expedition.routes[1].points[0].x &&
        point.y === expedition.routes[1].points[0].y,
    ),
  );
  assert.equal(hub.routes.length, 4);
  assert.ok(hub.routes.slice(0, 3).every((route) => route.points.at(-1) === hub.zones[0].center));
  assert.equal(new Set([basin.id, expedition.id, hub.id]).size, 3);
});

test(
  "a deterministic new-map plan builds, reopens and resumes through MCP",
  {
    timeout: 90_000,
    skip: !archiveBackendAvailable(),
  },
  async (t) => {
    const install = process.env.SC2_CASC_ROOT ?? "C:/Program Files (x86)/StarCraft II";
    try {
      await fs.access(path.join(install, ".build.info"));
    } catch {
      t.skip("SC2 install unavailable");
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc2-mission-new-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const spec = {
      version: 2,
      mode: "create",
      intent: "Two separate approaches around a low basin.",
      name: "Basin of the Lanterns",
      seed: 124,
      map: { width: 96, height: 96 },
      dependencies: { mode: "standard", expansion: "liberty", campaign: false },
      terrain: { tileSet: "Agria" },
      layout: {
        start: { id: "Camp", radius: 10 },
        objective: { id: "Shrine", radius: 10 },
        bonus: { id: "Lantern", radius: 6 },
        routeWidth: 6,
        variantCount: 8,
      },
    };
    type Created = Awaited<ReturnType<MissionWorkspace["build"]>>;
    type LayoutResult = ReturnType<
      typeof import("../modules/mission/layout.js").planMissionLayouts
    >;
    const author = await openMcp(root);
    let created: Created;
    try {
      const layout = async () =>
        author.read<{ missionProject: LayoutResult }>(await author.raw("mission.layout", { spec }))
          .missionProject;
      const plan = await layout();
      assert.deepEqual(await layout(), plan);
      assert.ok(plan.variants.length > 1);
      assert.ok(
        plan.variants.every((item) => (item.minSeparation ?? 0) >= spec.layout.routeWidth + 1),
      );
      assert.ok(plan.variants.every((item) => item.routes[0].length < item.routes[1].length));
      const built = await author.raw("mission.build", {
        projectId,
        spec,
        layoutId: plan.preferredId,
      });
      created = author.read<{ missionProject: Created }>(built).missionProject;
      assert.equal(created.creation.layoutId, plan.preferredId);
      assert.deepEqual(
        created.creation.views.map((view) => view.id),
        ["start", "fork", "objective"],
      );
      assert.equal(created.creation.routeChecks.length, 2);
      assert.ok(
        created.creation.routeChecks.every(
          (route) => route.samples > 100 && route.maxSlope <= 0.25,
        ),
      );
      assert.equal(await sha(path.join(root, created.current.archive)), created.current.sha256);
      const checkpoint = { projectId, name: "original", expectedSha256: created.current.sha256 };
      const saved = await author.raw("mission.checkpoint", { action: "save", ...checkpoint });
      assert.ok(!saved.isError);
      const listed = await author.raw("mission.checkpoint", { action: "list", projectId });
      assert.deepEqual(
        author.read<{ missionProject: { checkpoints: unknown[] } }>(listed).missionProject
          .checkpoints,
        [{ name: "original", revision: created.current }],
      );
      const styled = author.read<{ missionProject: { samples: number; forMap: number[] } }>(
        await author.raw("mission.decor_density", { campaign: "nova", width: 128, height: 128 }),
      ).missionProject;
      assert.equal(styled.samples, 9);
      assert.ok(styled.forMap[1] > 700);
      const objects = new PlacementDocument(
        (await readArchiveEntry(path.join(root, created.current.archive), "Objects")).toString(
          "utf8",
        ),
      );
      assert.deepEqual(
        objects.list().map((object) => object.attributes.Name),
        ["Camp", "Shrine", "Lantern"],
      );
      for (const file of Object.values(created.creation.previews)) {
        const image = await fs.readFile(path.join(root, file));
        assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      }
    } finally {
      await author.close();
    }
    const followup = await openMcp(root);
    try {
      const resumed = await followup.call("resume");
      assert.deepEqual(resumed.current, created.current);
      assert.deepEqual(resumed.creation, created.creation);
      const built = await followup.raw("mission.build", { projectId, spec });
      const repeated = followup.read<{ missionProject: Created }>(built).missionProject;
      assert.equal(repeated.replayed, true);
      assert.deepEqual(repeated.current, created.current);
      const result = await followup.raw("mission.verify", {
        projectId,
        sha256: created.current.sha256,
        editor: {},
        game: { unitType: "Marine" },
        run: false,
      });
      const { missionProject: verification } = followup.read<{
        missionProject: Awaited<
          ReturnType<typeof import("../modules/mission/verification.js").verifyMission>
        >;
      }>(result);
      assert.equal(verification.plan.sourceSha256, created.current.sha256);
      assert.deepEqual(verification.plan.suites.editor, ["load", "save_reopen"]);
      assert.equal(verification.plan.suites.routes, 7);
      assert.equal(verification.plan.suites.views, 3);
      assert.equal(verification.jobId, undefined);
    } finally {
      await followup.close();
    }
  },
);
