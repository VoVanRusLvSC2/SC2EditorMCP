# Mission authoring and extension SDK v1

SC2EditorMCP plans and builds maps. Its optional [SC2EditorToolkit backend](https://github.com/VoVanRusLvSC2/SC2EditorToolkit) runs the original Editor for native compilation, Data diagnostics, captures and save/reopen verification.

## Connect mission objectives to the map

Pass an ordered `stages` list to either `world.plan_intent` or `world.plan`. This example uses four named zones connected in order. Set the start to Entry and the objective to Exit. The last stage must reference the objective.

```json
[
  {"id":"RestorePower","zone":"PowerStation","mechanic":"Power","title":"Power the crane"},
  {"id":"LoadCargo","zone":"Loader","mechanic":"Load","title":"Hold the loading point"},
  {"id":"Evacuate","zone":"Exit","mechanic":"Leave","title":"Reach extraction"}
]
```

A mechanic reserves a minimum paved approach width in map units along a shortest chain of declared links from the preceding stage. Trail samples on those links also respect the minimum. Other links keep their widths. Optional landforms shape the open objective site itself. A levelPad flattens the work surface, an overlook raises it by 1.5 world units and a sunkenYard lowers it by one. Each has a six-cell blended shoulder. Incompatible overlapping pads and river intersections are rejected. The terrain, structure clearance and route test planner consume the resulting geometry. Doors, ramps and bridge assets still need a route check in the game for the intended unit.

Each stage names one mechanic from the selected pack. The builder emits editable GUI triggers and a visible objective. The starting mission Marine must remain inside the radius for the specified consecutive one-second game ticks. Leaving or failing a condition resets that counter. Completing the last stage wins. Losing the Marine ends the mission in defeat. The example presents the loading activity as a timed objective. A separate transport, a crane animation, enemy waves and alternative endings require additional gameplay authoring.

## Supply a pack

The public entry point is `sc2editor-mcp/mission-sdk`. Build the project with `npm run build`. An external extension can install the local built checkout as a file dependency. The repository includes a [working JavaScript extension](../examples/mission-sdk/ore-yard.mjs). Choose one source per plan.

- Inline data: set `missionPack` on the spec or intent.
- Local JSON: pass workspace-relative `packFile` beside `spec` or `intent`.
- Trusted code: set the server environment variable `SC2_MISSION_PLUGINS` to a JSON object mapping IDs to absolute local module paths. For example, configure `{"OreYard":"D:/dev/SC2EditorMCP/examples/mission-sdk/ore-yard.mjs"}`. Pass `plugin: "OreYard"` beside the spec or intent. A code plugin runs with the server's permissions. Only the server operator configures these paths.

A module exports a default `defineMissionPlugin({ apiVersion: 1, id, createPack })`. The callback receives the seed, map dimensions and zone IDs. It returns a validated pack containing named mechanics and measured facings. The host freezes the resolved values in the hashed plan. Building that plan does not execute the extension again. Restart the server after changing plugin code. Independent clients can create JSON packs with `defineMissionPack` and use the same contract.

A mechanic declares `id`, `seconds`, `radius` and `approachWidth`. Optional `conditions` and `onComplete` accept typed GUI Condition and Action trees from the existing Trigger API. These compile against the installed SC2 libraries. Use immediate on-completion actions for predictable ordering. The example adds a chat notification and widens the cargo approach on larger maps. Unknown mechanics, duplicate IDs and incompatible API versions fail before the plan is saved.

## Face and mount measured models

A facing entry is keyed by exact Actor ID and variation. It supplies `frontDegrees` counterclockwise from east at native rotation zero, `standOff` in map cells, `height` in world units and a required observation source. Fixture rows can use the measured minimum wall inset and mounting height. The room dresser uses the corrected yaw when fitting and packing model bounds. Explicit fixture rotation is already a native placement rotation and takes precedence. The same Actor's other variations need their own measurements.

A mission zone landmark can set `faceZone` to another zone ID. Its measured front points toward that zone's actual generated center. Unknown front and coincident target produce a planning/build error. Without a requested direction the existing landmark behavior applies.

The initial five variation-zero profiles use numeric observations from [TeamAntioch's measured facing strip](https://github.com/TeamAntioch/sc2-adjutant/blob/69140d7e91edf27a8bfdc2765be69c051935daf6/packages/core/data/doodad-facings.json). For another model, set its rotation to zero in an Editor test scene, mark east, inspect the visible front, measure a wall offset and record the camera/evidence in the pack.

## Rebuild around manual edits

1. Keep the original `world.build` plan ID and archive revision. Edit a copy of the map. Save its workspace path and SHA-256.
2. Revise the design, keeping the seed and dimensions, and run the ordinary plan and build calls. Keep this second generator revision too.
3. Call `world.rebuild` with `basePlanId`, `baseRevision`, `planId`, `generatedRevision`, `editedArchive` and `editedSha256`. The result is a separate packed, reopened archive. Compare its receipts under `rebuild.kept` and `rebuild.updated`.
4. Run `world.verify` against the returned plan ID and merged revision. For the next iteration use the latest pure generator output as baseline and the merged, edited map as the new manual input.

The reconciler compares all eligible archive members on private copies. Disjoint doodad edits in Objects use original XML nodes and native IDs. Ambiguous IDs or concurrent changes to the same placement require review. Concurrent terrain-family or script-family changes require manual reconciliation. Changes to ground near a retained prop may still require visual and pathing checks. The world generator recomputes the candidate before merging, so this feature preserves editor work without promising incremental generation time. Archive reopen, Editor compilation and gameplay victory are recorded separately.
