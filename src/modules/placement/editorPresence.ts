import type { PlacementValidationReport } from "./types.js";

/** Static placement is distinct from runtime spawns and native 3D visibility.
 * An empty unit layer must not be diagnosed as a broken Actor or hidden layer.
 */
export function editorPlacementPresence(
  objects: readonly { kind: string }[] | undefined,
): PlacementValidationReport["editorVisibility"] {
  const placedUnits = objects?.filter((object) => object.kind === "ObjectUnit").length ?? null;
  return {
    placedObjects: objects?.length ?? 0,
    placedUnits,
    placedDoodads: objects?.filter((object) => object.kind === "ObjectDoodad").length ?? null,
    unitPresence:
      placedUnits === null
        ? "UNREADABLE_OBJECTS"
        : placedUnits === 0
          ? "NO_PLACED_UNITS"
          : "PLACED_UNITS_PRESENT",
    editorLayerState: "UNOBSERVABLE",
    nativeRendering: "NOT_VERIFIED",
    runtimeCreation: "NOT_INSPECTED",
    hint:
      placedUnits === null
        ? "Objects could not be read reliably. Resolve placement XML errors before diagnosing visibility."
        : placedUnits === 0
          ? "No ObjectUnit entries are placed in this document. Units created by triggers appear only after the map starts, not in Terrain. Inspect initialization and preplace the known starting roster with Placement tools, binding the same identities instead of spawning duplicates. Runtime waves and summons remain dynamic. Preload or layer settings cannot materialize absent objects."
          : "Placed units exist, but XML presence does not prove native 3D rendering. Check the live Units layer, terrain heights, catalog/Actor initialization and Editor diagnostics. Saved TerrainLayersVisible bits alone are not a diagnosis.",
  };
}
