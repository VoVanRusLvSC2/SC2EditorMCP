# Fast whole-location composition

Use `terrain.scene.plan` for a coordinated outpost or woodland, rather than
building a location with unrelated scatter calls. It extends measured prefabs,
the existing terrain/material generator and owned landscape transactions.

```text
terrain scene.plan zone=west_outpost profile=outpost tileset=Agria rect=8,8,120,120 baseTexture=AgriaDirt pathTexture=AgriaDirtRoad accentTexture=AgriaGrass density=standard seed=42
```

The texture names above are examples. Inspect the actual map palette and target
dependencies; do not invent assets or change dependencies just to make a recipe
pass. Mount the declared catalog metadata once per workflow session when needed.
Scalar `fence`, `light`, `prop`, `secondaryProp` and `tree` override automatic
selection with verified Actor IDs. No member JSON is necessary.

One command plans a focal gate/clearing, asymmetric support groups, an open
staging plaza, a connected travel spine and service approaches, coordinated base
and accent materials. `detailTexture` optionally adds a smaller secondary patch.
There are three, five or seven groups for `density=sparse|standard|rich`. These
are layout options, not beauty scores. Models are never silently reduced or
groups dropped to force a fit. Large trees and structures require larger bounds.
Only two templates are resolved; repeated groups reuse their measurements and
do not generate individual images. Woodland support uses `woodland_cluster`: five
nonaligned measured trees and three smaller rock anchors, rather than rows of
repeated forest-edge trees. Group positions and facing also vary deterministically.

Heights are preserved. Optional `topology` forwards qualified cliff/ramp intent
to the existing native geometry writer; its format and junction limits still
apply. Optional `lighting` assigns an existing dependency-ready Light ID in the
same transaction, including catalog/component registration and dependency guards.
Omitting it preserves existing lighting. Lighting is global to the map, not
regional; choose it deliberately. This command does not generate water bodies or
invent biome topology. Use the existing supported terrain tools for those forms.

`exclusions` reserve resource areas and manual features. Measured model bounds
and complete route strokes avoid them; material operations also preserve that
ground. Main-route/plaza conflicts reject rather than paint an incomplete road.
Qualified topology with protected areas is conservative and may require an
explicit reviewed landscape intent. Existing unowned objects are preserved by
the owned transaction but are not automatically treated as measured obstacles:
declare their reserved space. AABB clearance is not an engine footprint.

The plan returns the usual Terrain `id`. Plan mode does not write map components.
`modkit.author mode=stage|save` uses existing `terrain.apply` and `terrain.save`.
The location owns two named zones: the supplied zone and `<zone>_plaza`.
Regeneration retains normal stale-source and manual-edit conflicts. Inspect or
refine them with `terrain.landscape.inspect` / `terrain.landscape.zone.plan`.
Do not create a new scene name merely to evade an ownership conflict.

For an open Editor use the supported current-document/same-file workflow.
Offline plan/save is not direct in-memory application. Do not write the archive
behind an open document or claim this recipe adds a new live Terrain backend.

## Review with a bounded cost

The default output includes one cached schematic PNG with measured model bounds,
routes, protected areas and the staging plaza. `preview=false` skips this image.
The schematic is explicitly not an SC2 screenshot. The receipt retains template
resolution time, candidate count, object/group counts, rest-bounds coverage,
material count and a sampled slope histogram for routes/plaza. Coverage measures
geometry rectangles, not canopy opacity, texture patch size or navigation.

Review the actual Editor overview, approach and focal views returned in
`scene.review.views`. Use the existing native capture and
`project.test.review`/`project.test.observe` workflow on the final artifact.
Evaluate five dimensions from 0 to 10 with a concrete image-bound reason:

| Dimension | Look for |
| --- | --- |
| Gameplay readability | Visible units, clear approach and room for combat |
| Large forms | Focal hierarchy, meaningful edges and an interesting silhouette |
| Materials | Functional ground regions and convincing transitions |
| Decoration | Scale, related groups, deliberate gaps and limited repetition |
| Lighting | Readable contrast, coherent atmosphere and visible important objects |

Never turn counts, a successful plan or a generated PNG into an automatic 7/10.
If a view fails, change its responsible region and review the affected views;
do not rerun every accepted check. Qualify reference-map statistics by genre and
biome. More trees, cliff coverage or texture layers is not inherently better.
Engine navigation, building placement and model playback remain native checks.

Development coverage: `src/tests/sceneComposition.test.ts` exercises complete
routes, measured bounds, exclusions, deterministic hierarchy, one-command save
expansion, lighting registration, preservation and guarded regeneration. Existing
decor/landscape tests cover the reused primitives. Asset availability and native
appearance must still be checked on the target installation and map.

Local qualification on 2026-11-18 resolved installed Agria models and planned a
five-group, 41-object woodland with three actual palette materials. In one
persistent MCP session the first plan plus schematic took 35.7 seconds; the
second plan without a schematic took 11.2 seconds. Existing on-disk caches were
present; this is not a clean-install benchmark or an Editor/game launch time.
The reserved-ground sample found no holes or above-limit slopes in that case.
The schematic was inspected for cluster shape and circulation; no native visual
rating or gameplay acceptance is inferred. Private receipts are retained in
`work/scene-composition-final-20261118.jsonl`.
