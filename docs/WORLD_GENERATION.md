# Procedural world generation

The MCP client turns the user's description into a versioned world specification. The server resolves installed palettes and compiles the layout, materials, structures, objects, lobby and triggers into a packed SC2Map. Use a profile with the mission module enabled.

## Generate from one brief

The MCP client translates the user's description once into the input for
`world.plan_intent`. Describe map size and mode, relative zone positions,
biomes and tilesets, the links between zones, and start/objective roles. For
a constructed site, describe its purpose and the rooms it needs. The developer
tool schema accepts that design directly. The client makes the plan and build
calls in the same workflow and returns the build receipt and previews.

For example, request a medium campaign mission with a dense Bel'Shir forest
in the south, a trail across a river, and an active Umojan laboratory in the
north with a raised work bay. Keep the two palettes within 16 texture slots.
The client can submit:

```json
{
  "seed": 197,
  "intent": {
    "version": 1, "name": "Forest and Laboratory",
    "mode": "mission", "width": 144, "height": 144, "textureBudget": 16,
    "zones": [
      {"id": "Forest", "biome": "natural", "tileSet": "BelShir", "sector": "south"},
      {"id": "Lab", "biome": "engineered", "tileSet": "UmojaEx3",
       "sector": "north", "layout": "lab", "raised": true,
       "rooms": ["lab", "storage", "command", "production"]}
    ],
    "links": [{"from": "Forest", "to": "Lab", "kind": "bridge"}],
    "starts": ["Forest"], "objective": "Lab"
  }
}
```

Use `world.build` with the resulting `planId`. For variations, reuse the same
intent and pass another seed. Compare the plotted route, bridge location and
room adjacency in the returned plan before reviewing surface and native Editor
views. `textureBudget` caps the distinct texture IDs in the selected banks.
The build reports the IDs actually painted. The standard mission scenery budget
still applies. Use mission `decorBudget` for a narrower range within 45-65
and per-zone `distinctActors` for minimum measured decor variety. The build
receipt includes elapsed milliseconds for each stage.

- Organic routes can wind and change width. Forest terrain blends across each
  trail's shoulders. A mission bridge between natural and engineered ground
  places a cardinal crossing and reserves both landings before laying out the
  site. One independent river is supported by the mission planner.
- An engineered Umojan site defaults to a laboratory. An engineered city-style
  site defaults to a city. Either purpose can be requested explicitly. A lab has
  a wider gallery and direct or service passages between functional rooms. A
  city reserves a main street, a public courtyard and adjoining functional lots
  with wider public space and narrower service links. Style and tile set drive
  ground and decor. UmojaEx3 has fitted walls, perimeter and purpose-specific
  fixtures. Its generated storage room uses a two-depth freight group with a
  landing light at an outer corner. Manual facilities can use the same
  [cargo bay presets](CAMPAIGN_BASE_COMPOSITION.md#world-generator-input).
  Other palettes currently get site and floor geometry plus catalog
  decor, with fitted architecture supplied by the detailed input when needed.
- In a ladder brief, pair opposite zones with `mirrorOf` and specify matching
  links. A zone in the center can serve as a shared waypoint. Starts and
  expansions use the existing symmetric melee generator.
- Arcade accepts paired starts and an objective and uses the existing point
  control rules. Automatic facility interiors and raised work bays use mission
  mode. Active sites are supported by the intent planner. The detailed
  `world.plan` remains available for authored geometry and assets.

## Forest and laboratory

Pass this input to `world.plan`. Anchors run west to east and south to north. The generator assigns each 8 × 8 terrain block to a zone. Influence changes the amount of land a zone attracts. Optional `areaBlocks.min` and `max` reject layouts outside the requested budget.

```json
{
  "spec": {
    "version": 1, "name": "Forest and Umojan Laboratory", "mode": "mission",
    "landscape": "campaign", "seed": 42, "width": 144, "height": 144,
    "zones": [
      {"id":"Forest","biome":"natural","tileSet":"BelShir","anchor":{"x":0.363,"y":0.137},"density":0.65},
      {"id":"Entry","biome":"engineered","tileSet":"UmojaEx3","anchor":{"x":0.363,"y":0.565},
       "wallActor":"UmojanLabGlassWallPanel","room":{"width":26,"height":24,"floor":"UmojaEx3_1","trim":"UmojaEx3_4"}},
      {"id":"Laboratory","biome":"engineered","tileSet":"UmojaEx3","anchor":{"x":0.774,"y":0.565},
       "wallActor":"DOM_LabGlassWalls","room":{"width":32,"height":28,"floor":"UmojaEx3_5","trim":"UmojaEx3_4","doorActor":"UmojanLabDoors02"}}
    ],
    "connections": [
      {"from":"Forest","to":"Entry","kind":"bridge","bankBoundary":true,"raisedBank":true},
      {"from":"Entry","to":"Laboratory","kind":"door","width":6}
    ],
    "starts":["Forest"], "objective":"Laboratory"
  }
}
```

1. Inspect the plan's palettes, zone areas, room entrances and crossings. Change the seed to vary the result or move anchors to constrain it.
2. Pass the returned `planId` to `world.build`. The receipt includes the archive path, SHA-256 revision, painted texture IDs, distinct placed actors per zone and two diagnostic preview PNGs.
3. Pass `planId` and `revision` to `world.verify`. Add `editor: true` for load, compilation and save/reopen. Add `game: true` for ground-route checks. Set `run: true` to execute a ready test plan and use `project.test.status` and `project.test.report` to read the outcome. Native checks require configured local runtimes. The terrain previews show height and texture distribution. Game camera captures use the native testing workflow.

## Campaign composition

Automatic missions with both dimensions from 128 to 160 cells use campaign composition by default. Set `landscape: "campaign"` to select it explicitly on other supported sizes. Set `landscape: "custom"` for the existing terrain and decor controls. Specs with explicit `actors` or `distinctActors` keep custom composition unless opted in.

The campaign registry maps each tileset to a landscape profile. A zone can select another profile with `style`, such as `lava`, `forest`, `interior` or `zerg`. The plan reports material roles, reserved connections, native cliff features and required decor roles. Natural profiles blend ground and use tapered cliff strokes on the native two-cell grid. Engineered profiles use defined floor seams. Mixed profiles combine pads with blended exterior material. Decorative shelves stay outside the required ground route, room entrances and water crossings.

The default decor budget is 45-65 unique Actor IDs per map. The planner aims for 55 and counts repeated or shared Actors once. Each required role must place a catalog-resolved, measured candidate. The build receipt records the chosen Actor for every role, the unique count and the number of native cliff cells. Set `decorBudget` to narrow the range within 45-65. If placements cannot meet that range or a required role, the build returns the unmet constraint.

## Landscape composition rules

For bases with several independent courts, rooms and service links, specify a
zone `facility`. See [campaign base composition](CAMPAIGN_BASE_COMPOSITION.md)
for the stock placement evidence, authoring sequence and input fields.

- Paint campaign forest trail shoulders with continuous ground, understory and
  dirt weights on both sides. Keep the material field continuous across terrain
  cells and use irregular trail edges at forest scale. Use rounded natural
  shelves and leave space between canopy groups so the route and relief read
  clearly.
- Give engineered interiors room-sized footprints. A zone's optional `room`
  specifies an even `width` and `height` in terrain cells, a tileset-native
  `floor` and an optional hard-edged `trim`. Walls bound the footprint and
  connections determine the openings. Each floor or trim texel uses one material.
- For an open mission site, a zone's optional `landmark` names an installed
  doodad `actor` and an `offset` from the zone center in terrain coordinates.
  The build sets the landmark on the terrain and reserves its measured
  footprint from procedural decor. Use an offset to leave the arrival point
  and its approach free.
- Run corridors between room openings. Use optional connection `waypoints` in
  absolute terrain coordinates for orthogonal segments and turns. The zone
  anchors determine the ends. Corridor paint stops at each room footprint.
- For an elevated mission facility across water, use `raisedBank: true` on a
  straight campaign `bridge` with `bankBoundary: true`. The engineered shore rises
  on both sides of the landing, and a native ramp aligns with the crossing.
  A single raised level with a wall actor uses one straight face at the
  waterline. Continue the same trim on both sides and around the ramp entrance.
  Use `bankRise: 2` for a compact double ledge at the waterline. Put the two
  faces four terrain cells apart on either side of the bridge. Set both ramps
  back within the central opening so their native meshes have room to join.
  Keep the first room behind the upper ramp. One raised shore is supported
  per map.
- Dress engineered cliff faces with measured, tileset-compatible wall modules.
  `bankWallActor` fits the continuous retaining panels around the bridge opening.
  `bankCliffActors` adds wall fixtures to the vertical faces on both levels.
  Align these props with the finished cliff height and the face normal.
  Cap the exposed material join at the crest and finish the bridge landing with
  a hard-edged paving material. Assign the framed single ramp's river band to
  the facility's original palette so the same road material reaches the bridge.
  Keep the ramps and landings clear of furniture.
- Use `bankLift` for a modest additional height on the top terrace and grade
  it into the existing native ramp. `materials.roadEdge` paints a narrow border
  along both edges of engineered travel lanes, including the ramp approach.
- Resolve the facility floor, walls and decor from installed tilesets and
  compatible actor families. Keep doors and raised access clear of props.
  Give rooms distinct floor materials and prop groupings. Umoja interiors can
  use the light `UmojaEx3_1` and `UmojaEx3_3` and the dark `UmojaEx3_5`
  surface from the same tileset. Optional `room.doorActor` fits a decorative
  door to the room's door openings. This visual door has no scripted behavior.
  Rooms without that override use the normal generated gate.

## Whole-facility layout recommendations

Review the full dry footprint of a facility before adding props. Each sector
needs a function, an approach, a boundary and a silhouette visible in the Editor
overview. Use the same perimeter construction and floor palette across the
facility. Vary the room depth, courtyard shape and equipment groups by function.

### KSP Empire comparison

The local *KSP Empire, Mission 1* reference uses Tarsonis and BattleStation
palettes. Its object layer contains 89 `DOM_GroundTrims`, 30
`BattleStation_Line_Decals` and 104 `SpacePlatformBarrier` instances. Most
of the ground trims and line decals are aligned to the principal axes, with
several concentrations in the southern industrial band. The platform modules
also concentrate in that band. Use runs of walls, floor edges and recurring
infrastructure to connect new layouts, with wider spaces at the destinations.

The current Deity Bel'Shir–Umoja visual study is 144 × 144. Entry, Research and
Observation occupy 2,288 of the 12,040 dry terrace cells (19%). The route
envelopes add 479 cells outside the rooms, for 23% combined coverage. The
40-cell-wide strip west of Entry is open terrace with freestanding props
and provides space for a service and logistics wing. The bridge, raised
edge and marked approach define the arrival. Organize the rest of the terrace
into distinct buildings, working yards, connectors and open spaces.

### Proposed Bel'Shir–Umoja campus

| Position | Architectural role | Composition |
| --- | --- | --- |
| South edge and bridgehead | Arrival court and security | Keep the one-level retaining wall and the marked ramp. Open the approach into a shallow forecourt. Frame the sightline with two compact service volumes and put the airlock on the far side. |
| West | Logistics and maintenance | Use a long bay and a shorter annex to form an L-shaped loading court. Run a side lane to the rear. Group crates, utility equipment and canopy supports along the bays. |
| Centre | Concourse and distribution | Lead the marked approach to one clear junction. Give it a route to the research wing, a route to logistics and a narrower service connection to the back. Keep a direct sightline from the entrance to this junction. |
| East | Research and testing | Pair the dark, deeper research hall with a pale support room and a contained outdoor test court. Connect buildings through door thresholds or a short gallery. Use equipment and lighting to distinguish the court and hall. |
| North | Observation and utilities | Use a shallow observation gallery overlooking the court, with a compact utility yard behind it. Join the rear service route to the west wing so the north reads as part of the facility. |
| South of the river | Bel'Shir approach | Use two canopy groups, an irregular path and an open view of the bridge. Use riverside vegetation and rock groups to frame the forest shore. Keep the forest and engineered sides distinct in material and shape. |

For this prototype, start the dry-terrace review at roughly 40% building
footprints, 30% purposeful exterior yards, 20% paths and perimeter access,
and 10% quiet margins. These are composition targets for this map. A loading
court or open test field counts as a designed place when its edges, access and
anchor equipment make its role legible. Keep the largest clearings at the
bridgehead and within the working courts.

### Facility condition and replacement surfaces

Default the whole facility to `operational` unless the brief specifies another
condition. Apply it across the plan, including service yards, secondary
entrances, perimeter infrastructure and the rear service route. Show the
facility in operation through readable work zones, lighting at doors and
junctions, equipment positioned for its purpose, and clear loading and
maintenance routes. Give each open area a role in that network. Use the same
condition when selecting assets for its wings and courts. Apply an explicitly
requested abandoned or damaged condition coherently across the site.

Give a catalog `TerrainObject` or structural doodad a replacement
footprint when its mesh forms the visible floor, deck or platform. Place and
align the module first. Derive the hide mask from the surface it covers at
its final position, orientation and scale. Select complete terrain cells
inside that coverage using the finished mesh outline and support seams.
Plain props standing on a floor use the ordinary ground placement workflow.

Use `terrain.hide` or `surface.hide` to set the authored ground-visibility flag
for the replacement footprint. Use `terrain.show` to restore that footprint
where its coverage ends after a move or removal. Retain the cutouts owned by other active replacements. Track
the module and its cutout together so a move or regeneration updates both.
Inspect the mask with `terrain.visibility.inspect` and check the module from above and at
a low angle for exposed holes, overlapping surfaces and perimeter gaps.
Validate walking and collision separately with the intended game profile.
See [terrain operation details](TERRAIN_MCP.md#operation-batch).

Plan the site in this order.

1. Choose the facility condition. Draw the usable outline, arrival route,
   junction, rear service loop and terrace margins. Give each large free area
   a role relative to those routes.
2. Fit building shells and courtyard edges. Use connected wings, annexes and
   bays with at least one change in massing along each principal sightline.
3. Assign the Umoja floor hierarchy. Use pale shared circulation, a dark
   research interior, distinct work surfaces at courts and a consistent
   border on continuous routes. Fit cliff fixtures and architectural trim to
   the same alignment as the walls and door openings.
4. Place large equipment and set pieces by room or yard role. Use smaller
   props around those anchors and leave working clearances. Budget 45–65
   unique decor types across the map and reuse related assets where they
   establish a consistent facility.
5. Sketch a footprint overlay for the spec and check it against the rooms,
   routes and palette blocks returned by `world.plan`. Use named area budgets
   and measured doorway and approach clearances. For future generator work,
   include each sector's role, dimensions, connections and coverage in the
   plan. Review the whole facility in the Editor, then check the bridgehead,
   junction and both wings at closer scale.


## Slayn and Tal'darim landscape review

Use the installed campaign maps *Steps of the Rite* (`ptaldarim01`) and
*Rak'Shir* (`ptaldarim02`) as references for relief and composition. Their
original minimaps show irregular shelves, cuts in the plateau and narrow
connections between larger areas. Both maps use Slayn as the main tileset.

| Map | Terrain size | Native ramps | Registered cliff cells | Doodad types |
| --- | --- | ---: | ---: | ---: |
| Steps of the Rite | 200 × 200 | 10 | 3,321 | 54 |
| Rak'Shir | 200 × 160 | 13 | 1,503 | 56 |
| Crimson Rift, first visual study | 144 × 144 | 0 | 76 | 55 |

Use these counts as comparative evidence. The original maps have different
dimensions and playable layouts. The two original maps each contain over
180 instances of `Slayn_RockCliffTall`, plus repeated cliff spires, grasses
and architectural trim. The Crimson Rift overview reads as a broad flat
shore, followed by one sharply bounded fork in the paving and mostly isolated
props. Its map-sized relief and the edge of the river dominate the silhouette.

For an original, base-free Tal'darim exploration map, set the composition
in this order.

1. Shape two or three connected elevations and leave a substantial visible
   cut or ravine. Fit passes to the terrain and give the arrival, side visits
   and final sanctuary distinct heights or enclosures.
2. Reserve the main trail from the forest and use branches of different
   lengths and character. Let a ridge conceal each destination until its
   approach opens out. Use the route to reveal a landmark from a controlled
   sightline. Keep the bridge or crossing short and integrate its landings
   into the surrounding rock profile.
3. Build landmark silhouettes from clusters of relevant scenery. Fit dark
   pillars, cliff modules and tall rocks to the cliff edges. Group grasses,
   rubble and small fittings at their bases. Leave the route and the centre
   of ceremonial clearings legible.
4. Use earth and rock for continuous exterior ground. Place Slayn brick
   floors, inlays and aligned trim at thresholds and ritual areas. Use
   restrained red accents at the sanctuary, with a separate colour cue
   for the terrazine site. Reserve the largest architectural silhouette
   for the objective.
5. Review the whole map in the Editor with the prop layer visible and
   inspect the arrival, side sites and last approach at player scale.
   Use the route's height changes, enclosure and sightlines to judge the
   composition. Track the number of unique actors as a separate metric.

### Biome joins, paths and perimeter detail

The LLM expresses the layout in `world.plan` using the same terrain coordinate
system as `waypoints`. A mission connection can include a `trail` array of
`{at, width}` knots. Use strictly increasing positions from 0 to 1, measured
along the route. Width is measured in terrain cells. The compiler interpolates
widths and uses the resulting edge for painting, relief and decor clearance.
A bridge retains its declared `width` through the physical crossing.

A mission bridge with `bankBoundary: true` can use a sculpted `shoreline` with
`reach`, `naturalRock`, `builtRock` and `rockActors`. The two material IDs
resolve in their respective texture banks. The compiler varies and grades the
bank, blends its texture weights and fits repeated rock models on both shores.

An engineered mission zone can specify `composition` with `edges`, decor
`pockets` and an optional `pavingRadius`. Each edge specifies `points`, an
installed `actor` and its target `spacing`, `height` and `depth`. Add a signed
`ledge` to an axis-aligned run on the native two-cell grid to raise the terrain
on that side. The compiler checks route clearance, fits measured models along
the run and reserves their footprints. Set `roughness` from 0 to 1 for stable
seeded variation in rocky runs. Each decor pocket has a `center` and
`radius`. Use them at thresholds and around landmarks to keep open ground
between groups. The build receipt reports the actual placed count per edge
segment. The separate decor budget counts unique types across the map.

- Shape the biome join as a sequence of spaces. At a forest-to-Slayn
  crossing, let the forest soil become stony at the approach, repeat the
  shoreline rock family on both banks, and tuck vegetation into the lower
  shelves. Introduce masonry at the raised landing or gate. Where two
  texture banks meet, bring each bank's earth and rock materials up to the
  join and align the bank change with a shaped ledge or overlapping scenery.
- Give a natural trail a width profile along its length. Use narrow sections
  between rocks or trees, broader ground at forks and landings, and tapered
  transitions into clearings. Vary the two soft shoulders independently where
  terrain permits. Derive paint and decor clearance from the same local
  profile. Use aligned edges and a consistent width for paved corridors on
  engineered ground.
- Place repeated wall and cliff pieces along the sides of constructed areas,
  along exposed ledges, and at relevant map edges. Follow the contour and
  reserve openings for arrivals and routes. A long perimeter can use on the
  order of 100 instances from a few compatible families. Scale that count to
  the length and spacing of the runs and track it separately from actor types.
- Compose each destination around a primary silhouette. Set retaining pieces
  and wall runs first, place grouped supports and fixtures at thresholds, and
  put small details at their feet. Keep the centre of a clearing open around
  its focal point. Review edge runs, trail widths and the biome seam from the
  same player-scale angles before increasing incidental decor density.

## Terrain and objects

Up to eight installed tilesets contribute up to eight layers each. One block selects one bank. Neighboring blocks can use different palettes. Inspect `paintedTextures` for the number of distinct materials actually used. Shared IDs and short palettes reduce that number.

Natural zones blend material weights and vary elevation with seeded noise. Engineered zones paint floor panels with straight seams. Zone material overrides accept palette texture IDs for `ground`, `road`, `trim` and `scatter`. Set `ground` for a dominant material with local accents. Natural zones blend this material into trail shoulders. Engineered zones use `trim` for panel seams and selected `scatter` textures for accent panels. For decoration, give the generator an explicit `actors` list or let it search the installed style and catalog. `distinctActors` sets the required number of different actors. A build fails if it cannot fit that quota. Density controls additional instances. Mission forests cluster repeated canopy and understory actors and keep routes clear. Mission laboratory props align with the architecture and leave clearance along the walls and at gates.

A bridge connection carves a straight water channel with a passable crossing and a fitted bridge model. In a mission, set `bankBoundary: true` on a bridge between two biomes to align the palette boundary with the far bank. Engineered rooms can have walls, openings and proximity-operated depot gates. Use `wallActor` to select an installed, measurable doodad for a room perimeter. Segments follow that perimeter and leave space for the planned openings. Both walls and riverbanks contribute to the ground pathing mask. Ground units use the Editor default height with a terrain-relative offset of zero. Doodads use the sampled surface height in absolute mode.

## Gameplay

| Mode | Required zones | Generated rules |
| --- | --- | --- |
| mission | One start and a separate objective | Move the starting Marine to the objective to win. |
| ladder | Two rotationally symmetric starts and matching zones and routes | Melee initialization, starting bases, a natural expansion per side, minerals and geysers. Use roads or bridge crossings. Competitive balance requires playtesting. |
| arcade | Two starts and a separate control point | Each side has a Marine. The first side to accumulate 30 game seconds of exclusive control wins. |

The three modes provide starting rules for further editing in the Editor or through the trigger tools. Width and height are multiples of eight from 64 to 256. Plans and build attempts are stored under `.sc2mcp-output/world` inside the configured workspace.
