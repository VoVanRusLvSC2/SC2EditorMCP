import type { MissionPack, MissionStage } from "../../mission-sdk.js";

type Route = { from: string; to: string; width: number; trail?: { at: number; width: number }[] };
export function bindMissionStages<R extends Route>(
  mode: string,
  start: string,
  goal: string | undefined,
  connections: R[],
  pack?: MissionPack,
  stages?: MissionStage[],
): R[] {
  if (!pack && !stages) return connections;
  if (mode !== "mission") throw Error("WORLD_PACK_REQUIRES_MISSION");
  if (!stages) return connections;
  if (!pack || stages.at(-1)?.zone !== goal)
    throw Error("WORLD_STAGES_REQUIRE_PACK_AND_FINAL_OBJECTIVE");
  if (new Set(stages.map((s) => s.id)).size !== stages.length) throw Error("WORLD_DUPLICATE_STAGE");
  const routes = connections.map((r) => ({ ...r }));
  let previous = start;
  for (const stage of stages) {
    const rule = pack.mechanics.find((m) => m.id === stage.mechanic);
    if (!rule) throw Error("WORLD_UNKNOWN_MECHANIC: " + stage.mechanic);
    // Prefer a short chain of declared links. A split bridge keeps both legs.
    const parent = new Map<string, { zone: string; index: number }>();
    const queue = [previous];
    for (let i = 0; i < queue.length && !parent.has(stage.zone); i++) {
      const zone = queue[i];
      routes.forEach((r, index) => {
        const next = r.from === zone ? r.to : r.to === zone ? r.from : undefined;
        if (next && next !== previous && !parent.has(next)) {
          parent.set(next, { zone, index });
          queue.push(next);
        }
      });
    }
    for (let zone = stage.zone; zone !== previous;) {
      const leg = parent.get(zone);
      if (!leg) throw Error("WORLD_STAGE_UNREACHABLE: " + stage.id + "/" + zone);
      const route = routes[leg.index];
      route.width = Math.max(rule.approachWidth, route.width);
      if (route.trail)
        route.trail = route.trail.map((k) => ({
          ...k,
          width: Math.max(k.width, rule.approachWidth),
        }));
      zone = leg.zone;
    }
    previous = stage.zone;
  }
  return routes;
}
