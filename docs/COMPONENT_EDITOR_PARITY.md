# Direct component editing comparison

This comparison covers file authoring and packed-map publication. The external
reference is erivgout/sc2-map-editor-mcp at
[17caee9](https://github.com/erivgout/sc2-map-editor-mcp/tree/17caee9736ab669b4a6decc79c8dc2f50cd4e6b6).
The [upstream capability matrix](https://github.com/erivgout/sc2-map-editor-mcp/blob/17caee9736ab669b4a6decc79c8dc2f50cd4e6b6/docs/capabilities.md)
and registered tools were checked against the starting SC2EditorMCP revision
`5cd9e83`.

| Area | Starting coverage | Added in this revision |
| --- | --- | --- |
| Component manifest | Foundation generation and automatic registration by individual writers | `document.components.inspect/apply` resolves payloads and adds, edits type/path/locale or removes a declaration by exact revision. Removal keeps the files. |
| Existing document metadata | DocumentInfo and dependency resolution for foundations; no generic update | `document.metadata.inspect/apply` changes supported single-value fields and ordered map/mod dependencies. A supported H2CS v8 header updates with DocumentInfo in the same group. Unsupported present headers refuse dependency changes. |
| Existing GUI triggers | Read, organize and graft action/event graphs; native rename separately | `trigger.graph.edit` changes a localized label, clones a trigger and its owned subgraph, or deletes it while retaining shared nodes. Names and parameter strings with recognized keys follow a clone. Cloning shares named definitions and global state. |
| Terrain component bytes | Native brushes, cliffs, ramps, pathing masks, road groups and decoded raw inspection | `terrain.cell_flags.inspect/apply` edits LFCT 101/102 flags by cell and mask. `terrain.component_bytes.inspect/apply` supports guarded equal-length payload edits for known binary profiles. The header and unsupported opaque layouts are preserved. |
| Exact lobby range | Individual native player creation/settings and separate attribute edits | `settings.plan` operation `player.slots` sets v39 Users to 1..count and synchronizes the selected Player attribute's zero-based defaults. Neutral and hostile records are preserved. Optional AI disabling retains record IDs. Competing Player attributes require an exact ID. |
| Placed objects and regions | Existing typed place/move/delete and exact-revision region create/update/delete | Already covered. Region deletion checks literal references. |
| MPQ, catalogs, Galaxy, strings, layouts | Guarded read/write, local/CASC dependencies and archive reopen checks | Existing writers remain the normal entry points. |

A GUI clone or delete changes `Triggers`. Regenerate `MapScript.galaxy` using
`trigger.generate_runtime` where supported, or the original Editor compile
workflow. Opaque ScriptCode owners and ambiguous folder ownership refuse.
Delete retains localized entries that another source may still refer to.
Raw terrain edits require separate validation of synchronized layers, rendered
results and engine pathing. Generic WATR body semantics are outside this scope.

## Apply components to the open map

Select the same-file refresh workflow for the exact packed map and Terrain
window. A clean document can stay open during preparation and inspection.

1. Call `live.refresh.prepare` with `mode="same_file_refresh"`.
2. Run the new tools through `live.refresh.call`. Save each complete draft
   group in the prepared component directory with `modkit.save`, or use the
   existing module save command.
3. Call `live.refresh.changes` to list saved component hashes and staged
   changes before publication. It also reports if the source archive revision
   drifted. This inspection never publishes the package.
4. Call `live.refresh.apply` once. After preflight, the native Editor releases
   the archive, the adapter publishes at the original path, and the same
   Editor frame reopens the document. Native Undo is reset by that reload.
   For changed triggers use the established runtime generation or compile
   snapshot/adoption path before publishing.

The open archive can be locked by the original Editor. The existing direct
current-document providers handle their supported Data, object, trigger and UI
operations without a file reload. [Editor lifecycle and recovery](EDITOR_LIVE.md)

The portable readiness/Close provider supports the exact original x64
5.0.17.98745 executable and English menus. It uses window messages for this
refresh route and starts from a clean document. The existing 5.0.17.98310
provider and its separate current-document tools retain their own scope.

## Qualification on an owned test map

On 2026-11-21 an existing packed test map was extracted, edited, packed and
reopened. The original Editor 5.0.17.98745 generated and compiled the cloned GUI
trigger. The final archive passed original load, save and reopen in a private
Toolkit 1.2.0-rc.1 worker.

A separate live refresh changed DocumentInfo and two-dimensional cell flags
on a map already open in another owned Editor 5.0.17.98745 process. While edits
were staged and saved to the component workspace, the open archive hash stayed
at its original revision. The refreshed result retained the archive path,
process and Terrain window, and both changed components were read back from the
published archive. The checked input fixture was preserved.
