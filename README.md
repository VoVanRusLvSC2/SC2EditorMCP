# SC2EditorMCP

MCP tools and a local workbench for authoring StarCraft II maps and mods.
Create Data objects, GUI triggers, layouts and landscape compositions through
compact commands, with shared validation, source guards and grouped saves.

TypeScript implements the authoring server; native adapters handle archives,
installed-game resources and supported operations in the original SC2 Editor.

[Capabilities](#capabilities-and-confirmation) · [Quick start](#quick-start) ·
[Open Editor](#edit-the-current-editor-document) · [Development](#development) ·
[Verification](docs/VERIFICATION.md)

The public project name is **SC2EditorMCP**. The existing repository URL,
`sc2editor-mcp` protocol identifier, environment variables and tool names remain
compatible; the historical source and license attribution are retained.

## Quick start

Requires Node.js 20+ for the source distribution. Run these commands from the
project directory in PowerShell:

```powershell
npm ci
npm run build
$env:SC2_UI_ROOT = "C:\Maps\Arena.components"
$env:SC2_MCP_PROFILE = "workflow"
node dist/index.js
```

`SC2_UI_ROOT` points to an existing unpacked map/mod component directory.
Use `map.import` to unpack an MPQ archive before offline authoring. stdout is
reserved for MCP traffic; configure your MCP client to launch the same entry point
and pass these environment variables.

Choose a focused profile such as `data`, `landscape`, `script` or `editor-live`
when appropriate. `SC2_MCP_MODULES` overrides profile selection.
`modkit.capabilities` reports the active configuration and runtime availability.

The optional web workbench starts with `npm run gui` at
`http://127.0.0.1:4312`. For Windows packaging use `npm run windows:portable`.
See [MCP and portable setup](windows/README-WINDOWS.md) and the
[workbench guide](docs/GUI_WORKBENCH.md).

## Edit the current Editor document

Select `SC2_MCP_PROFILE=editor-live` for current-document tools. Supported providers
reuse the original Editor controls for placement, Data XML, GUI trigger operations,
UI layouts, localized text, resource imports and same-file Save. Each provider has
its own limits and recovery rules; see [current-document editing](docs/EDITOR_LIVE.md).

Regional terrain brushes and complete arbitrary GUI graph replacement still need
additional direct providers. The accepted same-file refresh workflow can prepare
broader component changes, then reload the same archive in the same Editor window;
it resets native Undo and preserves pending-buffer guards. It is distinct from
editing the document continuously in memory.

Current-document work defaults to the open map. A checkpoint/Save As copy is an
explicitly selected alternative, documented in the [legacy live guide](docs/LIVE_EDITOR.md).
Unknown native outcomes require inspection or recovery, never blind replay.

## Build a map through MCP

Use `mission.contract` to discover the planner inputs. Call `mission.layout`
to review reserved routes and the selected relief, then `mission.build` to
create a packed candidate. `mission.resume` returns the saved revision and
receipts across MCP sessions. The river terrace and split ridge combine
continuous height shaping with native cliff tiers and cardinal ramps. Natural
cliff edges, feathered terrain materials and paved pads with crisp trim can
coexist on one map. The builder selects materials from the installed tileset,
assigns the selected light, places measured decoration and writes water after placement. Review
matching native 3D views through `mission.views` or `editor.capture`.
[Mission workflow](docs/MISSION_MCP.md)

`mission.styles` lists observed palettes from Wings of Liberty, Heart of the
Swarm, Legacy of the Void and Nova Covert Ops. `mission.materials` supplies
texture roles from names and reviewed descriptions. The `riverValley`
layout combines a continuous native river, cliff terraces, dry approaches
and an optional decorated base in one new map.

`mission.decor_density` compares authoring density with campaign main missions.
Use `decorDensity: "lush"` with campaign decor for inland groves and undergrowth.
`mission.checkpoint` names and restores verified archive revisions.

## Capabilities and confirmation

Reviewed against the public server registrations, implementation and retained
evidence on **2026-11-20**. The all-module public source registers **448 MCP tool
definitions**. This is an implementation inventory, not 448 individually certified
Editor operations. Profiles, configured runtimes and the connected server revision
determine which tools a client can use. Inspect `modkit.capabilities`; focused
profiles additionally expose `modkit.tools` for discovery and activation.
The [inventory record](docs/verification/capability-inventory-2026-11-20.json)
includes all registered names and the README command/link checks.

**Available** below means implemented authoring or an implemented optional native
adapter. Linked native records qualify specific fixtures, builds and observations;
their dates do not become current-runtime acceptance merely because this table was
reviewed. Offline file authoring and direct editing of an open document have
different coverage. The [current-document section](#edit-the-current-editor-document)
describes that boundary.

| Capability | Commands / entry points | Implemented scope and confirmation |
| --- | --- | --- |
| Create, duplicate and edit units | `data.unit.copy`, `data.unit.configure`, `data.plan` | **Available.** Catalog creation/cloning, fields, links and linked main Actors; more than read-only diagnostics. [Data guide](docs/DATA_MCP.md), [unit/Actor observations](docs/verification/native-combat-main-actor-2026-10-22.json). |
| Weapons, damage and characteristics | `data.plan`, `data.spell.configure` | **Available.** Weapon/effect objects, damage, attack links, vitals, speed and armor through typed operations/recipes. Arbitrary source/model combinations still need validation. [Data guide](docs/DATA_MCP.md). |
| Abilities, effects and progression | `data.spell`, `data.ability.target`, `data.hero.learn`, `data.hero.veterancy` | **Available.** Supported ability/effect graphs, costs, cooldowns, command cards, XP/levels and charges. [Data recipes](docs/DATA_MCP.md), [concurrent cast/cancel/recovery evidence](docs/verification/focused-data-lifecycle-2026-10-26.json). |
| Main Actor animations and presentation | `data.actor.ability_animation`, `data.presentation.check`, `data.unit.presentation` | **Available.** Main-unit cast/channel/finish events and bounded model/event/weapon review. Model/sequence resolution does not prove playback or sound. [Native animation observations](docs/verification/main-actor-animation-2026-10-22.json). |
| Editable GUI triggers | `trigger.plan`, `trigger.organize`, `trigger.import_revised`, `live.trigger.create`, `live.trigger.patch` | **Available; default for new logic.** Real GUI elements/folders, typed variables, calls, control flow and supported library/import/live edits. [Trigger guide](docs/TRIGGER_MCP.md), [native GUI/game scenarios](docs/verification/native-gui-matrix-current-2026-10-25.json). Universal conversion and arbitrary live graph replacement are not claimed. |
| Galaxy source authoring | `script.plan`, `script.apply`, `script.validate`, `script.save` | **Available when requested.** Source/symbol/reference inspection, guarded file/function/body edits and initialization connections. Static checks are separate from the original compiler. [Script guide](SCRIPT-GUIDE.md). |
| Original Editor compilation | `editor.check`, `editor.call` | **Available with the native Toolkit.** Original GUI-to-Galaxy compilation, generated Galaxy export and compiler diagnostics on private saved inputs. [Native Editor](docs/NATIVE_EDITOR.md), [saved-artifact GUI evidence](docs/verification/native-gui-matrix-current-2026-10-25.json). |
| Terrain height and materials | `terrain.plan`, `terrain.paint`, `terrain.blend`, `terrain.landscape.plan` | **Available.** Height brushes, smoothing/noise/flattening, texture rules, visibility, owned zones and protected routes. [Terrain API](docs/TERRAIN_MCP.md), [native preservation/passage/building checks](docs/verification/focused-terrain-ownership-2026-10-26.json). |
| Cliffs and ramps | `terrain.cliff.paint`, `terrain.cliff.repair`, `terrain.ramp.create`, `terrain.ramp.place` | **Available for qualified geometry.** Native topology and measured donor transfer; owned synthesis has two-cell rectangular cliff strokes and cardinal width-four ramps. Unsupported junctions refuse. No general engine pathing/collision rebuild. [Terrain API](docs/TERRAIN_MCP.md), [cardinal ramp evidence](docs/verification/native-ramp-enum-2026-10-24.json). |
| Place units and decorations | `placement.addUnit`, `placement.addDoodad`, `placement.addBatch`, `placement.setVariations` | **Available.** Actual placed objects, transforms/removal, seeded layouts, terrain snapping and source guards. Starting rosters belong in `Objects`; runtime spawns are not visible there before play. [Placement guide](docs/BROWSE_PLACEMENT_MCP.md), [native variation evidence](docs/verification/native-placement-variations-2026-10-24.json). |
| Landscape composition | `terrain.scene.plan`, `terrain.compose`, `terrain.landscape.zone.plan` | **Available.** Measured groups, focal/support hierarchy, clear routes/plazas, exclusions and owned regeneration. Scene profiles currently cover outpost/woodland. Schematics do not establish finished art. [Scene composition](docs/SCENE_COMPOSITION.md). |
| Water and lighting | `terrain.water.plan`, `terrain.lighting.plan`, `lighting.inspect` | **Available within supported formats.** Flat water regions, native water/light bindings and selected lighting fields. Complex shorelines, all water states and renderer parity remain limited. [Water](docs/TERRAIN_WATER.md), [lighting](docs/TERRAIN_LIGHTING.md). |
| UI layouts and dialogs | `ui.apply`, `ui.apply_template`, `ui.upsert_state_group`, `ui.upsert_animation`, `ui.preview_dialogs` | **Available.** Frames, properties, anchors, templates, styles, states, animations and previews; supported current layouts also use `live.ui.author`. [UI guide](docs/CODEX_GUIDE.md), [native dialog lifecycle evidence](docs/verification/focused-ui-lifecycle-2026-10-26.json). |
| Localization and text | `text.context`, `text.apply`, `text.validate`, `live.text.author` | **Available.** Localized strings, supported tables, font styles and rich text. Native save can remove inactive locale files in the recorded case; inspect component comparisons. [Text guide](docs/TEXT_MCP.md), [locale finding](docs/verification/focused-ui-lifecycle-2026-10-26.json). |
| Installed Blizzard CASC and assets | `casc.read_text`, `casc.read_bytes`, `casc.search`, `browse.search`, `assets.inspect`, `assets.measure`, `assets.preview` | **Available.** Installed-game reads, build-specific caches, dependency mounts, catalog lookup and supported M3/DDS/audio inspection/preview. Missing/encrypted/unsupported payloads remain explicit. [CASC guide](docs/CASC.md), [cache/dependency evidence](docs/verification/casc-order-2026-10-23.json). |
| MPQ maps/mods and foundations | `map.import`, `map.export`, `map.create`, `document.create` | **Available.** MPQ extraction, reopened entry-hash comparison, template-based maps and supported fresh document foundations. Arbitrary resize or a universally complete clean-map generator is not claimed. [Map guide](docs/MAP_MCP.md), [document guide](docs/DOCUMENT_CREATION.md). |
| Map screenshots and previews | `map.preview`, `editor.capture`, `editor.job` | **Available.** Fast ModKit previews and original Editor viewport/whole-map/region PNGs through the optional native adapter. [Native camera and frame evidence](docs/verification/native-editor-110-scoped-2026-10-28.json). A region crop is not a controlled camera view. |
| Cutscene authoring and export | `cutscene.compose`, `cutscene.apply`, `cutscene.export`, `cutscene.preview`, `cutscene.render` | **Available.** Native scene documents, cameras, shots, tracks, resource registration and a WebGL preview/frame path. Custom preview parity and every browser/scene variant remain unverified. [Cutscene guide](docs/CUTSCENE_MCP.md). |
| Native cutscene video | `editor.call` with `sc2_export_video` | **Available through the Toolkit.** Recorded original scene load/seek/frame and silent MP4 export; inspect the exact schema with `editor.tools`. Audio export and all FaceFX/assets/arguments remain open. [Native guide](docs/NATIVE_EDITOR.md), [fixture record](docs/verification/toolkit-update-2026-10-21.json). |
| Launch SC2 and test gameplay | `game.attach`, `game.call`, `game.action`, `project.test.run` | **Available with separately configured private GameToolkit.** Actual game launch, units/orders/abilities, diagnostics, camera/capture, events, UI and repeatable declared tests. Uses private instrumented copies; delivered maps do not require them. [Game guide](docs/NATIVE_GAME.md), [reusable test system](docs/PROJECT_TESTS.md). |
| Players, variants and game options | `settings.plan`, `settings.apply`, `settings.save` | **Available.** Supported map attributes/variants, player fields and native option flags with source-preserving edits. [Settings guide](docs/SETTINGS.md). |
| CustomAI metadata | `ai.context`, `ai.apply` | **Available within the observed schema.** Metadata/reference authoring and validation; not universal autonomous strategy generation. [AI guide](docs/AI_MCP.md). |

### Diffs, backups, recovery and shared-object protection

These safeguards are implemented, not merely planned:

- XML edits preserve unrelated source spans and unknown fields. Typed Data links
  and reference checks guard supported rename/delete operations.
- Plans/drafts retain content snapshots, dependency read sets and complete coupled
  groups. Stale sources, changed manual work and incomplete saves refuse.
- Module diff/discard/save operations, backups, supported rollback, owned-landscape
  preimages and a persistent transaction recovery journal cover their respective
  workflows. This is not an arbitrary whole-project time-travel history.
- External dependency catalogs remain read-only participants; recipes create
  local derivatives where supported. Owned terrain/decor regeneration detects
  manual conflicts. Neither mechanism guarantees every possible shared-object use.
- Static validation is built into supported authoring paths. Native compilation,
  rendered review and gameplay checks are additional explicit steps, not automatic
  proof from a successful XML write.

See [transaction architecture](docs/ARCHITECTURE.md#transactions),
[transaction/recovery regressions](src/tests/recoveryTransactions.test.ts),
[dependency guards](src/tests/dependencyTransactions.test.ts) and
[owned landscape rules](docs/LANDSCAPE_OWNERSHIP.md). A sequential MCP batch keeps
earlier committed changes if a later step fails; it is not an atomic batch Undo.

## Authoring workflow

[Direct component editing and same-file Editor refresh](docs/COMPONENT_EDITOR_PARITY.md)

Start with the [authoring protocol](docs/AUTHORING_PROTOCOL.md) and
[compact commands](docs/MCP_AUTHORING_SCRIPT.md). Keep one MCP process for a workflow,
group related edits and save complete transaction groups. New gameplay logic
defaults to native GUI triggers and real folders. Hand-authored Galaxy requires
an explicit request; existing code is preserved during targeted repairs.

Preplace known starting bases, resources, armies and permanent guards through
Placement tools so they are visible in Terrain. Use runtime creation for waves,
reinforcements, summons and other dynamic spawns.

The [reference catalog](resources/authoring-catalog/README.md),
[measured decor workflow](docs/DECOR_VISUAL_WORKFLOW.md), [agent rules](AGENTS.md)
and [project skills](.agents/skills/README.md) are maintained authoring inputs.
For preparation reuse and grouped edits see [performance](docs/PERFORMANCE.md).

## Verification and limits

Static validation, native compilation, saved-component readback, rendered appearance
and gameplay are separate results. The [acceptance matrix](docs/VERIFICATION.md)
records tested scope; it does not claim universal engine compatibility.

Cliff/ramp combinations, engine pathing regeneration, complex water and complete
renderer parity remain limited. A composition schematic or ModKit preview does
not prove native visuals, navigation or balance. Detailed versioned findings belong
in subsystem guides and [the changelog](CHANGELOG.md).

Native checks use separately configured, pinned runtimes. Private SC2GameToolkit
sources and instrumented maps are excluded from ordinary distribution.

## Development

```powershell
npm run build
npm run architecture:check
npm run docs:check-language
npm run catalog:verify
npm test
npm run lint
```

Run targeted regressions during development; use `npm run build:release` for
distribution. Rebuild and reconnect MCP to load changed server code.

[Architecture](docs/ARCHITECTURE.md) · [review and refactoring priorities](docs/ARCHITECTURE_REVIEW_2026-11-19.md) ·
[repository structure](docs/REPOSITORY_STRUCTURE.md) · [publication checklist](PUBLISHING.md)

## License and credits

Original code: Copyright (c) 2026 **VoVanRusLvSC2**
(vladimir.lencmanis@gmail.com), under the [custom attribution license](LICENSE).
Projects using our code or modules must credit VoVanRusLvSC2 and identify
SC2Editor-MCP-Codex as their source in README, Credits or About, in addition to
retaining copyright and license notices. Surface Toolkit author: **vise**
(attribution provided by the project owner). Third-party components retain their
own licenses; see [credits](CREDITS.md) and [license scope](THIRD_PARTY_LICENSES.md).
