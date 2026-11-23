# SC2EditorMCP for StarCraft II Maps and Mods

SC2EditorMCP is a Model Context Protocol server for building and editing StarCraft II maps and mods with the Galaxy Editor. It generates mission, melee ladder and arcade maps and edits terrain, water, objects, game Data, GUI triggers and Galaxy scripts, cutscenes, UI, and localized text.

An MCP client can work with unpacked components, import and export `.SC2Map` and `.SC2Mod` archives, and use supported tools on the open Editor document. The browser workbench and Editor toolbar chat are optional interfaces.

[Generate a map](#build-a-map-through-mcp) · [Connect an MCP client](#quick-start) · [Explore all capabilities](#capabilities-and-confirmation) · [Edit the open map](#edit-the-current-editor-document)

## Build a map through MCP

For a procedural **mission, ladder or arcade** map, describe the zones, connections and style to your MCP client. Use `world.plan_intent` for a structured brief or `world.plan` for a detailed specification, then build the plan with `world.build` and check the packed revision with `world.verify`. A different seed varies the route, crossing and facility layout. The generator supports up to 64 ground textures across eight regional palettes, blended forests, paneled laboratory floors, measured decoration, walls, automatic gates and water crossings. [World specification and working example](docs/WORLD_GENERATION.md)

Choose a mission purpose, a terrain profile and a seed. Use `mission.layout` to inspect routes, clearings and reserved areas before `mission.build` writes a packed map candidate. Layout patterns include a fork around a basin, an expedition with a side objective, a central defense hub and a river valley.

- **70 campaign style choices.** `mission.styles` lists 24 Wings of Liberty, 17 Heart of the Swarm, 20 Legacy of the Void and 9 Nova Covert Ops campaign–tileset combinations. They cover 69 distinct tilesets. Select a campaign and tileset to use its palette on an original layout. The chosen tileset must resolve through installed dependencies.
- **Automatic terrain generation.** For an existing map, `terrain.generate` offers 10 base recipes covering forest, desert, city, snow, jungle, swamp, volcanic, badlands, coastal and platform terrain. The mission builder can shape continuous heights, fit supported cliff tiers and ramps, blend ground and trail textures, and reserve space for bases and routes.
- **Water and bridges.** The river-valley layout carves a winding channel through a native water strip and checks submerged cross sections and dry banks. An optional bridge spans two dry landings. The bridge is a visual doodad. Unit traversal needs separate pathing and a gameplay test.
- **Materials and decoration.** `mission.materials` identifies texture roles such as soil, trail, rock and floor. Campaign decoration uses measured models to place vegetation and props around routes, banks and bases. Use `mission.decor_density` to compare density with campaign maps.
- **Mission revisions.** Inspect an existing map, plan and apply supported edits, resume the saved revision across sessions, or restore a named checkpoint. The mission workflow also covers gameplay setup, dependent Data mods and verification of a specific packed revision.

[Mission workflow and parameters](docs/MISSION_MCP.md) · [Terrain tools](docs/TERRAIN_MCP.md) · [Water materials](docs/TERRAIN_WATER.md)

## Quick start

Install Node.js 20 or later. From the project directory, run the following in PowerShell.

```powershell
npm ci
npm run build
$env:SC2_UI_ROOT = "C:\Maps\Arena.components"
$env:SC2_MCP_PROFILE = "workflow"
node dist/index.js
```

For offline component edits, point `SC2_UI_ROOT` at an unpacked map or mod. Use `map.import` to unpack an existing archive. For packed mission projects, point it at the workspace containing the map. Configure your MCP client with the same entry point and environment variables. The server uses stdout for MCP messages.

Choose a focused profile such as `landscape`, `data`, `map-builder` or `editor-live`. Use `modkit.capabilities` to see which modules and runtimes are available in your session. `SC2_MCP_MODULES` overrides profile selection.

Start the optional browser workbench with `npm run gui` and open `http://127.0.0.1:4312`. For a portable Windows package, use `npm run windows:portable`. [Windows setup](windows/README-WINDOWS.md) · [Workbench guide](docs/GUI_WORKBENCH.md)

## Capabilities and confirmation

| Area | What you can do |
| --- | --- |
| Map generation | Create mission, melee ladder and arcade map layouts. Generate biome transitions, variable-width trails, river crossings and functional rooms. Pack and verify the generated `.SC2Map`. [World generation](docs/WORLD_GENERATION.md) |
| Data Editor | Create or clone units and link weapons, damage effects, abilities and Actors. Configure vitals, armor, costs, cooldowns, hero progression, command cards and supported animation events. Inspect catalog references and review presentation in game. [Data guide](docs/DATA_MCP.md) |
| GUI triggers and Galaxy | Create editable triggers, folders, variables, conditions and actions. Organize, clone or edit supported graphs. Inspect and edit Galaxy source, validate references and use the optional native Editor toolkit to compile GUI triggers and export generated Galaxy. [Triggers](docs/TRIGGER_MCP.md) · [Galaxy](SCRIPT-GUIDE.md) |
| Terrain, water and lighting | Raise, flatten and smooth ground, paint and blend materials, edit visibility and supported cell flags, and create supported cliffs and ramps. Place rectangular water regions aligned to an eight-cell grid and configure water materials and lighting. [Terrain](docs/TERRAIN_MCP.md) · [Water](docs/TERRAIN_WATER.md) · [Lighting](docs/TERRAIN_LIGHTING.md) |
| Objects, regions and scenery | Place units and doodads individually or in batches, edit regions, vary models and snap objects to terrain. Compose outposts and woodland scenes with measured groups, exclusions and clear routes. Regenerate owned zones with conflict checks. [Placement](docs/BROWSE_PLACEMENT_MCP.md) · [Composition](docs/SCENE_COMPOSITION.md) |
| Maps, mods and components | Import and export MPQ archives, create supported map or mod foundations, compare reopened entries, edit component manifests, document metadata and ordered dependencies. [Archives](docs/MAP_MCP.md) · [Foundations](docs/DOCUMENT_CREATION.md) · [Component editing](docs/COMPONENT_EDITOR_PARITY.md) |
| Players, lobby and AI | Set supported player properties, slot ranges, lobby variants and game flags. Edit CustomAI metadata and validate its references. [Player settings](docs/SETTINGS.md) · [CustomAI](docs/AI_MCP.md) |
| UI and localization | Edit frames, anchors, properties, dialog templates, states and animations. Preview dialogs and manage localized strings, font styles and rich text. [UI authoring](docs/CODEX_GUIDE.md) · [Text](docs/TEXT_MCP.md) |
| Catalogs and assets | Search installed Blizzard CASC data and mounted dependencies. Resolve catalog IDs, inspect models, measure decoration and preview supported models, textures and audio. [CASC](docs/CASC.md) · [Authoring catalog](resources/authoring-catalog/README.md) |
| Cutscenes and captures | Compose cameras, shots and tracks, preview scenes and render frames. The native toolkit supports Editor screenshots and tested silent MP4 export. [Cutscenes](docs/CUTSCENE_MCP.md) · [Native Editor](docs/NATIVE_EDITOR.md) |
| Gameplay tests | Launch SC2 with the separately configured GameToolkit, issue orders, exercise abilities, capture observations and run repeatable project tests against a map revision. [Native game tools](docs/NATIVE_GAME.md) · [Project tests](docs/PROJECT_TESTS.md) |

## Edit the current Editor document

Use the `editor-live` profile for the open map. Supported tools operate through the original Editor controls for placement, Data XML, GUI triggers, layouts, localized text, resource imports and same-file Save. The optional AI toolbar button opens a chat connected to your configured MCP server. [Current-document tools](docs/EDITOR_LIVE.md) · [AI button setup](docs/AI_BUTTON_MODULE.md)

For broader component changes, the same-file refresh workflow prepares edits and reloads the same archive in the same Editor window. Reloading resets native Undo. Direct in-memory terrain brushes and GUI graph edits cover specific operations. [Component support and refresh procedure](docs/COMPONENT_EDITOR_PARITY.md)

## Verification and limits

Review the plan and diff, then save the complete group of related changes. Supported workflows check source revisions and dependencies, preserve unrelated XML, and provide backups or recovery records. Review native visuals in the Editor and test routes, combat and triggers in SC2. Cliff junctions, engine pathing, complex water bodies and rendering each have format-specific limits. [Authoring protocol](docs/AUTHORING_PROTOCOL.md) · [Transactions](docs/ARCHITECTURE.md#transactions) · [Verification matrix](docs/VERIFICATION.md)

SC2EditorMCP can use the optional native Editor integration for compilation, diagnostics and captures. [SC2EditorToolkit](https://github.com/VoVanRusLvSC2/SC2EditorToolkit)

## Development

```powershell
npm run build
npm run architecture:check
npm run docs:check-language
npm run catalog:verify
npm test
npm run lint
```

Use `npm run build:release` for distribution. Rebuild and reconnect the client after server changes. [Repository structure](docs/REPOSITORY_STRUCTURE.md) · [Publication checklist](PUBLISHING.md)

## License and credits

Original code: Copyright (c) 2026 **VoVanRusLvSC2**
(vladimir.lencmanis@gmail.com), under the [custom attribution license](LICENSE).
Projects using our code or modules must credit VoVanRusLvSC2 and identify
SC2Editor-MCP-Codex as their source in README, Credits or About, in addition to
retaining copyright and license notices. Surface Toolkit author: **vise**
(attribution provided by the project owner). Third-party components retain their
own licenses; see [credits](CREDITS.md) and [license scope](THIRD_PARTY_LICENSES.md).
