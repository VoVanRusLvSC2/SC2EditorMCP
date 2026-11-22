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
