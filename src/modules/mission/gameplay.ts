import * as z from "zod/v4";
import type { Workspace } from "../../core/workspace.js";
import type { CascWorkspace } from "../casc/workspace.js";
import type { BrowseWorkspace } from "../browse/workspace.js";
import { PlacementWorkspace } from "../placement/workspace.js";
import { PlacementDocument } from "../placement/document.js";
import type { TerrainWorkspace } from "../terrain/workspace.js";
import type { Point2 } from "../terrain/types.js";
import type { GuiCall, GuiRequest, GuiValue } from "../trigger/authoring.js";
import { TriggerWorkspace } from "../trigger/workspace.js";
import { missionFolders } from "../trigger/organization.js";
import type { MissionLayout } from "./layout.js";

const unit = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/);
const title = z.string().trim().min(1).max(120);
export const gameplaySchema = z
  .object({
    scout: unit,
    scoutDependency: z.string().min(1).max(128).optional(),
    capture: z
      .object({ guard: unit, title, dependency: z.string().min(1).max(128).optional() })
      .strict(),
    bonus: z
      .object({ guard: unit, title, dependency: z.string().min(1).max(128).optional() })
      .strict()
      .optional(),
    wave: z
      .object({
        unit,
        count: z.number().int().min(1).max(12),
        delay: z.number().min(1).max(90),
        hold: z.number().min(4).max(180),
        route: z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,31}$/)
          .optional(),
        title,
      })
      .strict(),
  })
  .strict();

type GameplaySpec = z.output<typeof gameplaySchema>;
interface MissionUnits {
  scout: number;
  guard: number;
  bonus?: number;
}

const player = 1,
  enemy = 15;
const integer = (value: number): GuiValue => ({ kind: "literal", type: "int", value });
const fixed = (value: number): GuiValue => ({ kind: "literal", type: "fixed", value });
const bool = (value: boolean): GuiValue => ({ kind: "literal", type: "bool", value });
const preset = (name: string): GuiValue => ({ kind: "preset", name });
const variable = (name: string): GuiValue => ({ kind: "variable", name });
const call = (fn: string, args: Record<string, GuiValue> = {}): GuiValue => ({
  kind: "call",
  function: fn,
  args,
});
const action = (fn: string, args: Record<string, GuiValue> = {}): GuiCall => ({
  kind: "Action",
  function: fn,
  args,
});
const event = (fn: string, args: Record<string, GuiValue> = {}): GuiCall => ({
  kind: "Event",
  function: fn,
  args,
});
const point = (where: Point2) => call("Point", { x: fixed(where.x), y: fixed(where.y) });
const link = (domain: string, id: string): GuiValue => ({ kind: "gamelink", domain, id });
const text = (value: string): GuiValue => ({ kind: "text", value });
const assign = (name: string, value: GuiValue) =>
  action("SetVariable", { var: variable(name), val: value });
const objective = (name: string, objectiveTitle: string, visibility: string, category: string) => [
  action("ObjectiveCreate", {
    name: text(objectiveTitle),
    description: text(""),
    state: preset(visibility),
    primary: preset(category),
  }),
  assign(name, call("ObjectiveLastCreated")),
];
const state = (name: string, value: string) =>
  action("ObjectiveSetState", { objective: variable(name), state: preset(value) });
const dead = (id: number) =>
  event("TriggerAddEventUnitDied", { u: { kind: "unit", objectId: id } });
const runTrigger = (name: string) =>
  action("TriggerExecute", {
    t: { kind: "trigger", name },
    check: preset("ignore"),
    wait: preset("wait"),
  });
const wait = (time: number) => action("Wait", { t: fixed(time), timeType: preset("game") });
const gameOver = (victory: boolean) =>
  action("GameOver", {
    player: integer(player),
    type: preset(victory ? "victory" : "defeat"),
    showDialog: preset("show"),
    showScore: preset("show"),
  });
const whenActive = (calls: GuiCall[]): GuiCall => ({
  kind: "Action",
  function: "IfThenElse",
  args: {},
  children: [
    { role: "if", call: { kind: "Condition", function: "custom:MissionIsActive", args: {} } },
    ...calls.map((call) => ({ role: "then", call })),
  ],
});

export function gameplayRequests(
  spec: GameplaySpec,
  units: MissionUnits,
  start: Point2,
  goal: Point2,
  spawn: Point2,
): GuiRequest[] {
  if (!!spec.bonus !== (units.bonus !== undefined)) throw Error("MISSION_BONUS_BINDING_MISMATCH");
  const captureId = "MissionCaptureObjective";
  const holdId = "MissionHoldObjective";
  const bonusId = "MissionBonusObjective";
  const running = "MissionRunning";
  const announce = (message: string) =>
    action("UIDisplayMessage", {
      players: call("PlayerGroupSingle", { p: integer(player) }),
      messageArea: preset("Chat"),
      message: text(message),
    });
  const wave: GuiCall[] = [];
  for (let i = 0; i < spec.wave.count; i++) {
    const angle = i * 2.399963;
    const radius = i ? 0.32 * Math.sqrt(i) : 0;
    const where = { x: spawn.x + radius * Math.cos(angle), y: spawn.y + radius * Math.sin(angle) };
    wave.push(
      action("UnitCreate", {
        count: integer(1),
        type: link("Unit", spec.wave.unit),
        flags: preset("Birth"),
        player: integer(enemy),
        pos: point(where),
        angle: fixed(0),
      }),
      action("UnitIssueOrder", {
        u: call("UnitLastCreated"),
        queue: preset("replace"),
        ord: call("OrderTargetingPoint", {
          abilCmd: call("AbilityCommand", { ability: link("Abil", "attack"), command: integer(0) }),
          p: point(goal),
        }),
      }),
    );
  }

  const requests: GuiRequest[] = [
    {
      variables: [
        { name: running, type: "bool", initial: bool(false) },
        ...[captureId, holdId, ...(spec.bonus ? [bonusId] : [])].map((name) => ({
          name,
          type: "objective" as const,
        })),
      ],
      functions: [
        { name: "MissionIsActive", kind: "Condition", calls: [], returns: variable(running) },
      ],
      calls: [],
    },
    {
      create: { identifier: "SetupGameplay", folder: "GAMEPLAY" },
      calls: [assign(running, bool(true))],
    },
    {
      create: { identifier: "SetupCamera", folder: "CINEMATIC" },
      calls: [
        action("CameraPan", { player: integer(player), p: point(start), duration: fixed(0) }),
      ],
    },
    {
      create: { identifier: "SetupObjectives", folder: "MAIN OBJECTIVES" },
      calls: [
        ...objective(captureId, spec.capture.title, "Active", "primary"),
        ...objective(holdId, spec.wave.title, "Hidden", "primary"),
        ...(spec.bonus ? objective(bonusId, spec.bonus.title, "Active", "secondary") : []),
      ],
    },
    {
      create: { identifier: "MissionCapture", folder: "MAIN OBJECTIVES" },
      calls: [
        dead(units.guard),
        whenActive([
          state(captureId, "Completed"),
          state(holdId, "Active"),
          announce("Objective secured. A counterattack is approaching."),
          wait(spec.wave.delay),
          whenActive([
            ...wave,
            announce("Counterattack has arrived."),
            wait(spec.wave.hold),
            whenActive([assign(running, bool(false)), state(holdId, "Completed"), gameOver(true)]),
          ]),
        ]),
      ],
    },
    {
      create: { identifier: "MissionDefeat", folder: "GAMEPLAY" },
      calls: [dead(units.scout), whenActive([assign(running, bool(false)), gameOver(false)])],
    },
  ];
  if (units.bonus !== undefined)
    requests.push({
      create: { identifier: "MissionBonus", folder: "MAIN OBJECTIVES" },
      calls: [
        dead(units.bonus),
        whenActive([state(bonusId, "Completed"), announce("Bonus objective completed.")]),
      ],
    });
  requests.push({
    create: {
      identifier: "MapInitialization",
      folder: "INITIALIZATION",
      translations: { enUS: "Map Initialization" },
    },
    calls: [
      event("TriggerAddEventMapInit"),
      runTrigger("SetupGameplay"),
      runTrigger("SetupObjectives"),
      runTrigger("SetupCamera"),
    ],
  });
  return requests;
}

export async function authorMissionGameplay(
  copy: Workspace,
  casc: CascWorkspace,
  browse: BrowseWorkspace,
  terrain: TerrainWorkspace,
  layout: MissionLayout,
  spec: GameplaySpec,
) {
  const [start, goal, bonus] = layout.zones;
  const atGoal = (point: Point2 | undefined) =>
    point?.x === goal.center.x && point.y === goal.center.y;
  const route = layout.routes.find(
    (route) =>
      (!spec.wave.route || spec.wave.route === route.id) &&
      (atGoal(route.points.at(-1)) || atGoal(route.points[0])),
  );
  if (!route) throw Error("MISSION_WAVE_ROUTE_NOT_FOUND");
  const ordered = atGoal(route.points.at(-1)) ? route.points : [...route.points].reverse();
  const lead = ordered.at(-2)!;
  const end = ordered.at(-1)!;
  const spawn = { x: (lead.x + end.x) / 2, y: (lead.y + end.y) / 2 };
  if (Math.hypot(spawn.x - goal.center.x, spawn.y - goal.center.y) < 6)
    throw Error("MISSION_WAVE_SPAWN_TOO_CLOSE");

  const placement = new PlacementWorkspace(copy, browse);
  placement.terrain = terrain;
  const roster = [
    { type: spec.scout, owner: player, center: start.center, dependency: spec.scoutDependency },
    {
      type: spec.capture.guard,
      owner: enemy,
      center: goal.center,
      dependency: spec.capture.dependency,
    },
    ...(spec.bonus && bonus
      ? [
          {
            type: spec.bonus.guard,
            owner: enemy,
            center: bonus.center,
            dependency: spec.bonus.dependency,
          },
        ]
      : []),
  ];
  const read = async () => new PlacementDocument((await copy.readRaw("Objects")).text).list();
  const existing = new Set((await read()).map((row) => row.id));
  const objects = await browse.withSnapshot(async () =>
    Promise.all(
      roster.map(async ({ type, owner, center, dependency }) => {
        let key: string | undefined;
        if (dependency) {
          const { definitions } = await browse.get({ id: type, catalogType: "Unit" });
          const choices = definitions.filter(
            (entry) =>
              entry.dependency.toLowerCase() === dependency.toLowerCase() &&
              entry.availability === "AVAILABLE_THROUGH_DEPENDENCY" &&
              entry.engineActive !== false,
          );
          if (choices.length !== 1)
            throw Error("MISSION_UNIT_DEPENDENCY_AMBIGUOUS_OR_MISSING: " + type + " " + dependency);
          key = choices[0].key;
        }
        return {
          kind: "Unit" as const,
          ...(key ? { key } : { id: type }),
          owner,
          snapToTerrain: true,
          maxSlope: 0.25,
          position: { ...center, z: 0 },
        };
      }),
    ),
  );
  const plan = await placement.addBatch({ objects });
  const result = await placement.apply(plan.id, { dryRun: false, stage: false, backup: false });
  if (!result.accepted) throw Error("MISSION_UNIT_PLACEMENT_REFUSED");
  const placed = (await read()).filter(
    (row) => row.kind === "ObjectUnit" && row.id && !existing.has(row.id),
  );
  const ids = roster.map(({ type, owner, center }) => {
    const matches = placed.filter((row) => {
      const xy = row.position?.split(",").slice(0, 2).map(Number);
      return (
        row.catalogId === type &&
        row.attributes.Player === String(owner) &&
        xy?.[0] === center.x &&
        xy?.[1] === center.y
      );
    });
    if (matches.length !== 1) throw Error("MISSION_PLACED_UNIT_BINDING_AMBIGUOUS: " + type);
    return matches[0].id!;
  });
  const units = { scout: ids[0], guard: ids[1], bonus: ids[2] };
  const triggers = new TriggerWorkspace(copy, undefined, browse.data, casc);
  const requests = gameplayRequests(spec, units, start.center, goal.center, spawn);
  const gui = await triggers.planBatch(requests);
  await triggers.applyPlan(gui.planId, false, true);
  await triggers.organize({
    folders: [...missionFolders],
    assignments: [
      ...gui.variables.map(({ id }) => ({ type: "Variable" as const, id, folder: "FUNCTIONS" })),
      ...gui.functions.map(({ id }) => ({ type: "FunctionDef" as const, id, folder: "FUNCTIONS" })),
    ],
    dryRun: false,
    stage: true,
  });
  const runtime = await triggers.generateRuntime(false, true);
  await copy.save("Triggers", { backup: false });
  return {
    units,
    routeId: route.id,
    spawn,
    contextLabel: "INITIALIZATION",
    runtimeSha256: runtime.sourceSha256,
  };
}
