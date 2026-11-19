import test from "node:test";
import assert from "node:assert/strict";
import { editorPlacementPresence } from "../modules/placement/editorPresence.js";
import { compactResult } from "../app/toolResults.js";

test("an empty unit layer distinguishes absent placement from unverified rendering", () => {
  const empty = editorPlacementPresence([{ kind: "ObjectDoodad" }]);
  assert.equal(empty.placedUnits, 0);
  assert.equal(empty.placedDoodads, 1);
  assert.equal(empty.unitPresence, "NO_PLACED_UNITS");
  assert.equal(empty.runtimeCreation, "NOT_INSPECTED");
  assert.match(empty.hint, /only after the map starts/);
  assert.match(empty.hint, /instead of spawning duplicates/);
  assert.deepEqual(
    (compactResult({ valid: true, editorVisibility: empty }) as any).editorVisibility,
    empty,
  );
  const present = editorPlacementPresence([{ kind: "ObjectUnit" }, { kind: "ObjectPoint" }]);
  assert.equal(present.placedUnits, 1);
  assert.equal(present.unitPresence, "PLACED_UNITS_PRESENT");
  assert.equal(present.nativeRendering, "NOT_VERIFIED");
  const unknown = editorPlacementPresence(undefined);
  assert.equal(unknown.placedUnits, null);
  assert.equal(unknown.unitPresence, "UNREADABLE_OBJECTS");
});
