import type { TerrainWorkspace } from "../terrain/workspace.js";
import type { Point2, TerrainOperation } from "../terrain/types.js";
import { routeSamples, type MissionLayout } from "./layout.js";

type Route = MissionLayout["routes"][number];
type Repair = { routeId: string; at: Point2; radius: number };

export async function checkAndRepairMissionRoutes(
  terrain: TerrainWorkspace,
  routes: Route[],
  level: number,
) {
  const maxAllowedSlope = 0.25,
    maxRepairs = 4;
  const repairs: Repair[] = [];
  const check = async () => {
    const surface = await terrain.surface();
    return routes.map((route) => {
      const samples = routeSamples(route.points).map((point) => ({
        point,
        sample: surface.sample(point),
      }));
      const blocked = samples.find(
        ({ sample }) => sample.mask === 0 || sample.hidden || sample.water?.length,
      );
      if (blocked)
        throw Error(
          "MISSION_ROUTE_HIDDEN_OR_WET: " + route.id + " " + JSON.stringify(blocked.point),
        );
      return {
        route,
        count: samples.length,
        maxSlope: Math.max(...samples.map(({ sample }) => sample.slope)),
        steep: samples
          .filter(({ sample }) => sample.slope > maxAllowedSlope)
          .map(({ point }) => point),
      };
    });
  };
  let checked = await check();
  const corrections: TerrainOperation[] = [];
  for (const { route, steep } of checked) {
    const radius = Math.min(3.5, route.width / 2);
    for (const at of steep) {
      if (
        repairs.some(
          (repair) =>
            repair.routeId === route.id &&
            Math.hypot(repair.at.x - at.x, repair.at.y - at.y) <= radius - 1.25,
        )
      )
        continue;
      if (repairs.length >= maxRepairs)
        throw Error("MISSION_ROUTE_REPAIR_BUDGET_EXCEEDED: " + route.id);
      repairs.push({ routeId: route.id, at, radius });
      corrections.push({
        op: "height.set",
        height: level,
        edgeBlend: 1,
        area: { type: "circle", center: at, radius },
      });
    }
  }
  if (corrections.length) {
    const plan = await terrain.plan({ operations: corrections });
    if (!plan.valid) throw Error("MISSION_ROUTE_REPAIR_PLAN_INVALID");
    const applied = await terrain.apply(plan.id, { dryRun: false, stage: false, backup: false });
    if (!applied.accepted) throw Error("MISSION_ROUTE_REPAIR_REFUSED");
    checked = await check();
    const failed = checked.find((route) => route.steep.length > 0);
    if (failed) throw Error("MISSION_ROUTE_REPAIR_STILL_STEEP: " + failed.route.id);
  }
  return {
    repairs,
    routeChecks: checked.map(({ route, count, maxSlope }) => ({
      id: route.id,
      samples: count,
      maxSlope,
    })),
  };
}
