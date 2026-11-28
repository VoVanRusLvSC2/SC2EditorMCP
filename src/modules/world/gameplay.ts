import type { GuiRequest, GuiCall, GuiValue } from "../trigger/authoring.js";
import type { WorldSpec } from "./plan.js";
import type { Point2 } from "../terrain/types.js";

const int = (value: number): GuiValue => ({ kind: "literal", type: "int", value });
const fixed = (value: number): GuiValue => ({ kind: "literal", type: "fixed", value });
const preset = (name: string): GuiValue => ({ kind: "preset", name });
const variable = (name: string): GuiValue => ({ kind: "variable", name });
const call = (name: string, args: Record<string, GuiValue>): GuiValue => ({
  kind: "call",
  function: name,
  args,
});
const action = (name: string, args: Record<string, GuiValue> = {}): GuiCall => ({
  kind: "Action",
  function: name,
  args,
});
const event = (name: string, args: Record<string, GuiValue> = {}): GuiCall => ({
  kind: "Event",
  function: name,
  args,
});
const comparison = (val1: GuiValue, op: string, val2: GuiValue): GuiCall => ({
  kind: "Condition",
  function: "Comparison",
  args: { val1, op: preset(op), val2 },
});
const finish = (player: number, win: boolean) =>
  action("GameOver", {
    player: int(player),
    type: preset(win ? "victory" : "defeat"),
    showDialog: preset("show"),
    showScore: preset("show"),
  });

type StageBinding = {
  title: string;
  point: Point2;
  seconds: number;
  radius: number;
  conditions?: GuiCall[];
  onComplete?: GuiCall[];
};

export function stageTriggers(id: number, stages: StageBinding[]): GuiRequest[] {
  if (!id || !stages.length) throw Error("WORLD_GAMEPLAY_BINDINGS");
  const phase = "WorldStageIndex",
    elapsed = "WorldStageTime",
    objective = "WorldStageObjective";
  const assign = (name: string, val: GuiValue) =>
    action("SetVariable", { var: variable(name), val });
  const title = (value: string): GuiValue => ({ kind: "text", value });
  const tick = event("TriggerAddEventTimePeriodic", { dur: fixed(1), timeType: preset("game") });
  const requests: GuiRequest[] = [
    {
      create: { identifier: "WorldStageSetup" },
      variables: [
        { name: phase, type: "int", initial: int(0) },
        { name: elapsed, type: "int", initial: int(0) },
        { name: objective, type: "objective" },
      ],
      calls: [
        event("TriggerAddEventMapInit"),
        action("ObjectiveCreate", {
          name: title(stages[0].title),
          description: title(""),
          state: preset("Active"),
          primary: preset("primary"),
        }),
        assign(objective, call("ObjectiveLastCreated", {})),
      ],
    },
  ];
  // One timer per mission. Evaluate in reverse order so a tick can advance only once.
  const steps: GuiCall[] = stages.map((stage, index) => {
    const distance = call("DistanceBetweenPoints", {
      p1: call("UnitGetPosition", { u: { kind: "unit", objectId: id } }),
      p2: call("Point", { x: fixed(stage.point.x), y: fixed(stage.point.y) }),
    });
    const advance = stages[index + 1]
      ? action("ObjectiveSetName", {
          objective: variable(objective),
          text: title(stages[index + 1].title),
        })
      : finish(1, true);
    const inside: GuiCall = {
      kind: "Action",
      function: "IfThenElse",
      args: {},
      children: [
        { role: "if", call: comparison(distance, "lt", fixed(stage.radius)) },
        ...(stage.conditions ?? []).map((call) => ({ role: "if", call })),
        {
          role: "then",
          call: assign(
            elapsed,
            call("ArithmeticInt", { val1: variable(elapsed), op: preset("plus"), val2: int(1) }),
          ),
        },
        {
          role: "then",
          call: {
            kind: "Action",
            function: "IfThenElse",
            args: {},
            children: [
              { role: "if", call: comparison(variable(elapsed), "gt", int(stage.seconds - 1)) },
              { role: "then", call: assign(phase, int(index + 1)) },
              { role: "then", call: assign(elapsed, int(0)) },
              ...(stage.onComplete ?? []).map((call) => ({ role: "then", call })),
              { role: "then", call: advance },
            ],
          },
        },
        { role: "else", call: assign(elapsed, int(0)) },
      ],
    };
    return {
      kind: "Action",
      function: "IfThenElse",
      args: {},
      children: [
        { role: "if", call: comparison(variable(phase), "eq", int(index)) },
        { role: "then", call: inside },
      ],
    };
  });
  requests.push(
    { create: { identifier: "WorldStageTick" }, calls: [tick, ...steps.reverse()] },
    {
      create: { identifier: "WorldStageDefeat" },
      calls: [
        event("TriggerAddEventUnitDied", { u: { kind: "unit", objectId: id } }),
        comparison(variable(phase), "lt", int(stages.length)),
        assign(phase, int(stages.length)),
        finish(1, false),
      ],
    },
  );
  return requests;
}

export function worldTriggers(
  mode: WorldSpec["mode"],
  units: number[],
  goal?: Point2,
): GuiRequest[] {
  if (mode === "ladder")
    return [
      {
        create: { identifier: "WorldMeleeInitialization" },
        calls: [
          event("TriggerAddEventMapInit"),
          ...["MeleeInitResources", "MeleeInitUnits", "MeleeInitAI", "MeleeInitOptions"].map((n) =>
            action(n),
          ),
        ],
      },
    ];
  if (!goal || !units.length) throw Error("WORLD_GAMEPLAY_BINDINGS");
  const point = call("Point", { x: fixed(goal.x), y: fixed(goal.y) });
  const tick = event("TriggerAddEventTimePeriodic", { dur: fixed(1), timeType: preset("game") });
  const distance = (id: number) =>
    call("DistanceBetweenPoints", {
      p1: call("UnitGetPosition", { u: { kind: "unit", objectId: id } }),
      p2: point,
    });
  return units.map((id, i) => {
    const player = i + 1,
      opponent = units[1 - i],
      score = "WorldControlScore" + player;
    const calls: GuiCall[] = [tick, comparison(distance(id), "lt", fixed(5))];
    if (mode === "mission") {
      calls.push(finish(player, true));
      return { create: { identifier: "WorldReachObjective" }, calls };
    }
    calls.push(
      comparison(distance(opponent), "gt", fixed(5)),
      action("SetVariable", {
        var: variable(score),
        val: call("ArithmeticInt", { val1: variable(score), op: preset("plus"), val2: int(1) }),
      }),
      {
        kind: "Action",
        function: "IfThenElse",
        args: {},
        children: [
          { role: "if", call: comparison(variable(score), "gt", int(29)) },
          { role: "then", call: finish(player, true) },
          { role: "then", call: finish(2 - i, false) },
        ],
      },
    );
    return {
      create: { identifier: "WorldControl" + player },
      variables: [{ name: score, type: "int", initial: int(0) }],
      calls,
    };
  });
}
