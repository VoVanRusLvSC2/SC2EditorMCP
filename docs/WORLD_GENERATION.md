# Procedural world generation

The MCP client turns the user's description into a versioned world specification. The server resolves installed palettes and compiles the layout, materials, structures, objects, lobby and triggers into a packed SC2Map. Use a profile with the mission module enabled.

## Forest and laboratory

Pass this input to `world.plan`. Anchors run west to east and south to north. The generator assigns each 8 × 8 terrain block to a zone. Influence changes the amount of land a zone attracts. Optional `areaBlocks.min` and `max` reject layouts outside the requested budget.

```json
{
  "spec": {
    "version": 1, "name": "Forest and Umojan Laboratory", "mode": "mission",
    "seed": 42, "width": 128, "height": 128,
    "zones": [
      {"id":"Forest","biome":"natural","tileSet":"BelShir","anchor":{"x":0.36,"y":0.17},"distinctActors":20,"density":0.65},
      {"id":"Approach","biome":"engineered","tileSet":"UmojaEx3","anchor":{"x":0.42,"y":0.65}},
      {"id":"Laboratory","biome":"engineered","tileSet":"UmojaEx3","anchor":{"x":0.68,"y":0.81},"distinctActors":20,"density":0.4}
    ],
    "connections": [
      {"from":"Forest","to":"Approach","kind":"bridge"},
      {"from":"Approach","to":"Laboratory","kind":"door"}
    ],
    "starts":["Forest"], "objective":"Laboratory"
  }
}
```

1. Inspect the plan's palettes, zone areas, room entrances and crossings. Change the seed to vary the result or move anchors to constrain it.
2. Pass the returned `planId` to `world.build`. The receipt includes the archive path, SHA-256 revision, painted texture IDs, distinct placed actors per zone and two diagnostic preview PNGs.
3. Pass `planId` and `revision` to `world.verify`. Add `editor: true` for load, compilation and save/reopen. Add `game: true` for ground-route checks. Set `run: true` to execute a ready test plan and use `project.test.status` and `project.test.report` to read the outcome. Native checks require configured local runtimes. The terrain previews show height and texture distribution. Game camera captures use the native testing workflow.

## Terrain and objects

Up to eight installed tilesets contribute up to eight layers each. One block selects one bank. Neighboring blocks can use different palettes. Inspect `paintedTextures` for the number of distinct materials actually used. Shared IDs and short palettes reduce that number.

Natural zones blend material weights and vary elevation with seeded noise. Engineered zones paint floor panels with straight seams. Zone material overrides accept palette texture IDs for `ground`, `road`, `trim` and `scatter`. For decoration, give the generator an explicit `actors` list or let it search the installed style and catalog. `distinctActors` sets the required number of different actors. A build fails if it cannot fit that quota. Density controls additional instances.

A bridge connection carves a straight water channel with a passable crossing and a fitted bridge model. Engineered rooms can have walls, openings and proximity-operated depot gates. Both walls and riverbanks contribute to the ground pathing mask.

## Gameplay

| Mode | Required zones | Generated rules |
| --- | --- | --- |
| mission | One start and a separate objective | Move the starting Marine to the objective to win. |
| ladder | Two rotationally symmetric starts and matching zones and routes | Melee initialization, starting bases, a natural expansion per side, minerals and geysers. Use roads or bridge crossings. Competitive balance requires playtesting. |
| arcade | Two starts and a separate control point | Each side has a Marine. The first side to accumulate 30 game seconds of exclusive control wins. |

The three modes provide starting rules for further editing in the Editor or through the trigger tools. Width and height are multiples of eight from 64 to 256. Plans and build attempts are stored under `.sc2mcp-output/world` inside the configured workspace.
