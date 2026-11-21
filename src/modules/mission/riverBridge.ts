import type { Workspace } from "../../core/workspace.js";
import { ModelMeasurements } from "../assets/measurement.js";
import type { BrowseWorkspace } from "../browse/workspace.js";
import type { CascWorkspace } from "../casc/workspace.js";
import { DecorPalette } from "../placement/decorPalette.js";
import { PlacementWorkspace } from "../placement/workspace.js";
import type { TerrainOperation } from "../terrain/types.js";
import type { TerrainWorkspace } from "../terrain/workspace.js";
import type { MissionBuildSpec } from "./buildSpec.js";
import { routeSamples, type MissionLayout } from "./layout.js";
import { riverSection } from "./river.js";

export function planRiverBridge(layout: MissionLayout, trail: string) {
  if (!layout.river) throw Error("MISSION_BRIDGE_REQUIRES_RIVER");
  const y = Math.round((layout.playable.minY + layout.playable.maxY) / 2);
  const { x, halfWidth } = riverSection(layout.river, y);
  const left = { x: x - halfWidth - 1.5, y };
  const right = { x: x + halfWidth + 1.5, y };
  const west = { x: Math.max(layout.playable.minX + 3, left.x - 10), y };
  const east = routeSamples(layout.routes[0].points).reduce((a, b) =>
    Math.abs(a.y - y) <= Math.abs(b.y - y) ? a : b,
  );
  const operations: TerrainOperation[] = [
    [west, left],
    [right, east],
  ].map((points) => ({
    op: "texture.blend",
    area: { type: "corridor", points, width: 6 },
    texture: trail,
    edgeBlend: 2.4,
    strength: 0.94,
  }));
  return {
    left,
    right,
    operations,
    clearance: {
      type: "rectangle" as const,
      minX: west.x,
      minY: Math.min(y, east.y) - 3,
      maxX: east.x,
      maxY: Math.max(y, east.y) + 3,
    },
  };
}

export async function placeRiverBridge(
  copy: Workspace,
  browse: BrowseWorkspace,
  casc: CascWorkspace,
  terrain: TerrainWorkspace,
  crossing: ReturnType<typeof planRiverBridge>,
  campaign: MissionBuildSpec["terrain"]["styleCampaign"],
  waterLevel: number,
) {
  const palette = new DecorPalette(browse, new ModelMeasurements(copy, casc));
  const names =
    campaign === "hots"
      ? ["ZerusLogBridge", "Aiur_Temple_Bridge_Destructible", "KorhalBridge"]
      : ["MarSaraBridge", "KorhalBridge", "MarSaraBridgeLong", "Tarsonis_Bridge_Horizontal"];
  const { left, right } = crossing;
  const { sampleGround } = await terrain.surface();
  const landings = [left, right].map(sampleGround);
  if (
    landings.some(
      (point) =>
        point.height < waterLevel + 0.4 ||
        point.hidden ||
        point.nativeMeshHole ||
        point.slope > 0.36,
    )
  )
    throw Error("MISSION_BRIDGE_EXPECTED_DRY_LANDINGS");
  const span = right.x - left.x + 0.7;
  const failures: string[] = [];
  for (const id of names) {
    let model;
    try {
      model = await palette.resolve({ id, variation: 0, preview: false });
    } catch (error) {
      failures.push(id + ": " + (error instanceof Error ? error.message : String(error)));
      continue;
    }
    const { dimensions, center } = model.measured.measurement;
    const alongX = dimensions.width >= dimensions.depth;
    const scale = span / Math.max(dimensions.width, dimensions.depth);
    const width = Math.min(dimensions.width, dimensions.depth) * scale;
    if (scale < 0.38 || scale > 2 || width < 2 || width > 12) continue;
    const rotation = alongX ? 0 : Math.PI / 2;
    const position = {
      x: (left.x + right.x) / 2 - (alongX ? center[0] : -center[1]) * scale,
      y: left.y - (alongX ? center[1] : center[0]) * scale,
      z: Math.max(...landings.map((point) => point.height)) + 0.08,
    };
    const placement = new PlacementWorkspace(copy, browse);
    placement.terrain = terrain;
    const plan = await placement.addBatch({
      objects: [
        {
          kind: "Doodad",
          key: model.actor.key,
          position,
          rotation,
          scale,
          variation: model.variation,
          snapToTerrain: false,
        },
      ],
    });
    const applied = await placement.apply(plan.id, { dryRun: false, stage: false, backup: false });
    if (!applied.accepted) throw Error("MISSION_BRIDGE_APPLY_REFUSED");
    return { actor: model.actor.id, position, left, right, span, width, scale, rotation };
  }
  throw Error("MISSION_BRIDGE_NO_FITTED_MODEL: " + failures.join(" | "));
}
