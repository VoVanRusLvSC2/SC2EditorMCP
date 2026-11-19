# SC2EditorMCP

MCP tools and a local workbench for authoring StarCraft II maps and mods.
Create Data objects, GUI triggers, layouts and landscape compositions through
compact commands, with shared validation, source guards and grouped saves.

TypeScript implements the authoring server; native adapters handle archives,
installed-game resources and supported operations in the original SC2 Editor.

[Quick start](#quick-start) · [Open Editor](#edit-the-current-editor-document) ·
[Modules](#modules) · [Development](#development) · [Verification](docs/VERIFICATION.md)

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

## Modules

| Module | Scope | Documentation |
| --- | --- | --- |
| Editor live | Supported current-document providers, recovery and same-file Save/refresh | [Editor live](docs/EDITOR_LIVE.md) |
| UI | Layout frames, properties, anchors, states, animations | [UI guide](docs/CODEX_GUIDE.md) |
| Text | Localization, Font Styles and rich text | [Text](docs/TEXT_MCP.md) |
| Cutscene | Scenes, cameras, shots and animation tracks | [Cutscene](docs/CUTSCENE_MCP.md) |
| Data | Native Catalog XML, references and batch edits | [Data](docs/DATA_MCP.md) |
| AI | CustomAI metadata and bounded authoring | [AI](docs/AI_MCP.md) |
| Browse / Placement | Available assets, dependencies, Unit/Doodad/ObjectPoint plans | [Browse / Placement](docs/BROWSE_PLACEMENT_MCP.md) |
| Terrain / composition | Height, materials, measured decor groups, reserved routes, water and lighting | [Terrain API](docs/TERRAIN_MCP.md), [scene composition](docs/SCENE_COMPOSITION.md) |
| CASC | Installed-game MNDX/BLTE reads, search, byte/semantic cache and metadata mounts | [CASC](docs/CASC.md) |
| Settings | Map attributes, native game variants, v39 players and game options | [Settings](docs/SETTINGS.md) |
| Document | Fresh empty dependent/extension mods and Arcade map foundations | [Document](docs/DOCUMENT_CREATION.md) |
| Map | MPQ import/export, MapInfo and template-based creation | [Map](docs/MAP_MCP.md) |
| Script | Galaxy and bounded GUI trigger authoring | [Script](SCRIPT-GUIDE.md), [Trigger](docs/TRIGGER_MCP.md) |
| Native checks | Original Editor compilation/capture and separately configured private game tests | [Editor](docs/NATIVE_EDITOR.md), [Game](docs/NATIVE_GAME.md) |

## Authoring workflow

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
