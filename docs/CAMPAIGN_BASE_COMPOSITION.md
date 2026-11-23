# Campaign base composition

## Reference coverage

The base survey read original `Objects` and `t3Terrain.xml` from the installed
SC2 CASC build 5.0.17.98745. It covered 102 maps in the stock style catalog:
40 Wings of Liberty, 27 Heart of the Swarm, 26 Legacy of the Void including its
prologue and epilogue, and 9 Nova Covert Ops. Counts include cataloged tutorials,
challenges and evolution missions. Eight story-mode packages lacked one of these
components in the local archive, including `tstory01` and the seven
`zstory*` entries.

The first pass screened for a headquarters with nearby same-owner production
or defenses, or at least three nearby resource nodes. The second pass looked
for repeated wall families and concentrated service objects to catch laboratories,
prisons and other facilities without an economy. The two filters flagged 89 maps
for base or facility cues, with 78 passing the first filter. These are candidates
from placement readback. Trigger-spawned structures and purely thematic actor
names can affect the interpretation. The examples below use concrete stock actor
families and map IDs. Proximity counts use a six-cell distance between instances
of the same actor.

| Campaign and map | Placement evidence | Generator rule |
| --- | --- | --- |
| Wings of Liberty, Engine of Destruction (`thorner03`) | 87 `SpacePlatformBarrier` sections, with 82 close to an instance of the same family. 77 `PipesCorner` and 41 `PipesLong`. | Draw the road and perimeter first. Run utility equipment along service edges, and give storage and production separate footprints. |
| Wings of Liberty, Breakout (`ttosh03a`) and Piercing the Shroud (`thorner05s`) | 19 `ChainLinkFenceStraight` pieces all have a nearby matching piece. 30 Castanar stasis tubes have nearby matches out of 32 in the map. | Use a consistent series of panels to frame a checkpoint. Group repeated equipment inside the corresponding cells or rooms. |
| Heart of the Swarm, Lab Rat (`zlab01`) and Back in the Saddle (`zlab02`) | Lab Rat has 31 tall Umojan cliff walls, 31 caps, 23 Umojan supply crates and 11 dissection tables. The next map adds repeated wall debris and intact caps. | Separate large lab rooms with galleries, give each room a floor and equipment family, and concentrate damage and debris where the story calls for it. |
| Heart of the Swarm, Old Soldiers (`zchar03`) and The Crucible (`zzerus02`) | Old Soldiers has 39 diagonal defense panels, 35 close to a matching section. The Crucible has 110 tall Zerus rocks, 105 with a close neighbor. | Alternate constructed strongpoints with natural relief. Organic bases can use rounded, blended pads enclosed by terrain and fitted decor. |
| Legacy of the Void, Forbidden Weapon (`ppurifier01`) and Purification (`ppurifier03`) | 226 `Protoss_Base_Wall_Trims` and 210 `Purifier_Energy_Pipes` in the respective maps, all with a same-family neighbor within six cells. | Repeat a small set of architectural and energy motifs along axes. Make courtyards and aisles large enough for the surrounding modules to read. |
| Legacy of the Void, Steps of the Rite (`ptaldarim01`) and Rak'Shir (`ptaldarim02`) | 183 and 184 instances of `Slayn_RockCliffTall`; Steps of the Rite also has 41 `Slayn_Temple_BigWalls`. | Fit the exterior to ledges and keep ceremonial approaches open. Use a wall or cliff assembly behind the main landmark to give it an architectural setting. |
| Nova Covert Ops, The Escape (`nova01`) and In The Enemy's Shadow (`nova07`) | The Escape has 129 interior wall panels, 58 caps and 136 Dominion crates. The mansion map has 55 glass wall pieces, 52 close to a matching piece, and separate families for canal walls and service pipes. | Draw public, working and service routes with different widths. Wall gates and glass galleries can delimit short routes without turning the whole compound into one enclosed room. |
| Nova Covert Ops, Enemy Intelligence (`nova03`) and Dark Skies (`nova08`) | 210 straight and 168 diagonal concrete wall doodads in Enemy Intelligence. Dark Skies has 89 municipal wall sections and 61 industrial pipes-and-tanks props. | Separate the urban shell from industrial bays, choose motifs by district, and use open yards between dense strips of detail. |

The survey informed the following authoring sequence.

1. Set the function, footprint, floor and desired visibility of each space before
   choosing decor. Typical roles are entrance, courtyard, command, production,
   storage, laboratory, landing and organic.
2. Lay out a wider main route and smaller service links. State exactly which
   faces the routes cross. Use unobstructed forecourts for arrivals and assembly.
3. Assign a floor and border per space. Paint passage edges with a consistent band
   and keep paved seams crisp. Use rounded, blended pads when the faction or
   biome calls for organic ground.
4. Choose enclosure by function. A storage yard can have three sides, a lab can
   use four with a framed opening, and a courtyard can be open. Use the existing
   `composition.edges` and shoreline tools for the outer terrain and facade.
5. Repeat a small number of equipment families in rows at interior edges. Use a
   dedicated row with a shifted center for asymmetric work bays. Place larger
   equipment first, then choose smaller fittings and damage for the local story.
   Crates are frequent repeatable infrastructure at active constructed sites.
   Use several lots at freight staging and loading, mixing appropriate crates,
   pallet loads and small packages. Use shorter working batches near lab benches,
   utility plant and checkpoint recesses. Face them toward the service side of
   the site and leave doorway swings, stair landings, material joints and the
   main travel lane clear. Engineered zones reserve crates and pallets for
   measured fixture rows. The automatic Umojan layout puts a batch at the
   outer corner of its storage room. Ambient scatter skips these cargo props.
   Count repeated crates as instances of a small family.
6. Keep clear volumes through circulation and the main floor. Reserve planned
   rooms and passages before the generator samples general scenery. Check the
   perimeter, floor transitions, equipment orientation and gated paths in the
   original Editor.

For a laboratory complex, give the main approach a continuous floor treatment
through the outdoor landing and interior gallery. Put the largest specialist
room at a side of the gallery. Use its depth for internal work bays, separated
by floor inlays and equipment rows. Put cargo and operations on the other side
at different setbacks. The first review should show the research volume, the
route through the site and at least one separate service entrance from the
same camera.

## Crates and service equipment

The installed object-layer sample counts crate and pallet Actor names, excluding
craters, and uses horizontal placement pivots. A cluster links neighboring
pivots within four terrain cells. The wall column counts pivots within six cells
of wall, fence or barrier Actors. These are layout observations, with neither
model footprints nor in-game reachability inferred from the distances.

| Original map | Observed placements | Application to generated sites |
| --- | --- | --- |
| Lab Rat (`zlab01`) | 27 cargo props, 23 with a neighbor and 20 near boundaries. The largest batch spans 8.0 × 4.7 cells and uses ten Umojan supply crates. | Compose a small number of stockpiles with depth against the wall. Give the largest batch an aisle on its open side. |
| Back in the Saddle (`zlab02`) | 79 cargo props, 61 with a neighbor. The largest mixed batch contains four general crates and four Haven crate props over 4.1 × 4.6 cells. The closest service cue for 29 pieces is a landing light within five cells. Other nearby cues include docking bays and wall consoles. | Pair transfer lots with docking marks, inspection equipment or a visible status light. Mix two cargo scales in an irregular footprint. |
| The Escape (`nova01`) | 146 cargo props, 123 with a neighbor and 121 near boundaries. The largest batch spans 5.8 × 7.5 cells. Smaller groups occur near lab consoles, pipes and water machinery. | Put bulk stock against the envelope. Keep smaller service batches near equipment and leave the main path clear. |
| Piercing the Shroud (`thorner05s`) | 37 cargo props, 33 with a neighbor. The connected groups have up to four pieces. Nearby equipment includes landing lights, stasis tubes, alarms and pipes. | Put small handling groups near sample processing. Leave a clear route between small groups or work bays. |
| Breakout (`ttosh03a`) | 14 of 15 crates have a neighbor. Six are nearest to a water tank within five cells and three are nearest to an exhaust pipe. | Give the utility nook a visible machine, ventilation and a short batch of maintenance supplies. |
| Dark Skies (`nova08`) | 47 cargo props, 38 with a neighbor. Three large batches mix Dominion crates, Jarban Minor crates and pallets, with examples near industrial buildings and street lights. | Stage industrial freight on compact pads. Use full and partial rows and balance larger objects with small, repeated cargo. |

## World generator input

Use `facility.spaces[].cargoBays` to furnish a corner as a group. Each entry
selects `kind` (`freight`, `specimen`, or `utility`), a wall `side`, and a
`corner` (`start` for the lower along-wall coordinate, `end` for the higher).
The resolver fits the group's measured objects together through the facility
fixture pass. A freight group uses a pair of heavy crates, a deeper staggered
row of small crates, two packages and a landing light. A specimen group uses
armored storage, supply crates and a console. A utility group uses a generator,
a vent and maintenance packages. For freight, `staggered: true` changes the depths and offsets of the heavy and small cargo. The Umojan intent planner assigns its storage
room a freight bay on the outer wall and uses the seed to choose the arrangement in larger rooms. Author a second bay when a larger site
has a distinct loading or processing area. All groups use the target map's
Actor catalog and reserve the gates, stairs, dividers and paths.

### Laboratory workstations

A placement audit of installed Lab Rat (`zlab01`) found 11 wall consoles
and two floor monitors. Ten of the 13 lie within six terrain cells of a wall,
door or wall cap Actor pivot. The map also has 11 dissection tables and one
cell table. The 12 table pivots have no table neighbor within four cells.
Some stations put the table toward the work floor and the console behind or
to the side. The map has three specimen tubes and four power conduits. Two
tubes share an equipment location with a tall power conduit. The packed
objects also contain 35 low `XelNagaHullReactorConduit` Actor instances and one
gate cable. The named reactor conduit is low floor detail, distinct in scale
from the tall Umojan power props. These measured distances use placement
pivots and do not establish object footprints or gameplay collision.

Use `facility.spaces[].workstations` with a `kind`, a room `side`, an
along-wall `offset` and an optional inward `setback`. Set `flip: true`
to reverse the along-wall relationship of the members.

| Workstation | Functional arrangement |
| --- | --- |
| `control` | Wall console, forward monitor and lateral terminal, with low cabling along the wall. |
| `experiment` | Dissection table and shorter specimen table, with a side arm and a service console. |
| `containment` | Specimen tube, local controls and a pipe and cable connection, arranged across two depths. |
| `service` | Three aligned pipe modules with a vent and an accessible terminal at the ends. |

Author `aisles` as `{from, to, width}` segments in the room's existing
coordinates. Reserve the route inside doors, through divider gaps and to
both stair landings. Fixture fitting rejects a measured prop whose horizontal
clearance overlaps an aisle. Workstation placements use the same measurement
and reservation rules as authored fixtures. Automatic facilities use
[room passports](WORLD_GENERATION.md#room-passports) and fit groups after the
planner reserves entrances, aisles and landings.

### Room composition

The [Lab Rat test-chamber frame](https://www.gamepressure.com/starcraftiiheartoftheswarm/gfx/word/346756390.jpg)
shows a dominant platform, repeated equipment near the edge and routes that
read across the room. The following authoring rule is an inference from the
frame and the installed placements. Give each room one primary activity and
place the supporting equipment along a shared wall or work surface. Reserve
the approach before placing secondary props. In a room with two floor levels,
use the raised surface for the primary station and keep the lower work surface
visually quieter.

`facility.spaces[].roomComposition` takes one `focus` and up to three smaller
`support` groups. Focus kinds are `research`, `observation` and `briefing`.
Support kinds are `bench`, `wallConsole` and `service`. The location fields
use the same side, offset, setback and flip convention as workstations. Use
this field for composed rooms. Ordinary workstation arrays remain available
for independent equipment bays. Asset scaling on a focal prop also scales its
fixture clearance. Briefing consoles stay aligned and close to the wall when
the primary display is set farther into the room. Automatic room passports fit
a primary and supporting stations to the same reserved space. A raised
observation deck can use a containment passport or an explicit observation
focus after stair landings and aisles are defined.

### Umojan relay review against Lab02

Counts come from the packed `Objects` reopened from
`Deity-Relay-Command.SC2Map` and the installed `zlab02` from the survey above.
Instances are saved `ObjectDoodad` rows. Types are distinct Actor IDs. Decal
variations sharing an Actor ID count as one type. Coordinate ranges use inclusive
minima and exclusive maxima. The stock samples are rectangular windows around
named mission markers. The full original mission also includes the tram and
spaceport.

| Area | Instances | Types | Placement evidence |
| --- | ---: | ---: | --- |
| Relay map | 1,247 | 49 | Includes the forest and exterior. |
| Relay complex, `[11,122) × [60,137)` | 802 | 23 | 452 wall caps, 183 tall cliff-wall pieces and 68 glass panels. The remaining 99 instances include 51 cargo props. |
| Relay operations, 34 × 22 | 68 | 7 | 55 instances of the three shell families above, seven crates and six devices. |
| Relay research, 42 × 36 | 138 | 14 | 118 instances of those shell families, five cargo props and 15 other props. |
| Relay main gallery, 18 × 44 | 41 | 3 | 38 trims, two floor monitors and one power-line prop. |
| Lab02 full mission | 1,212 | 90 | 432 `Decal` instances, 42 Umojan pillars and 68 one- or two-high wall panels. |
| Lab02 opening laboratory and elevator approach, `[8,90) × [84,149)` | 364 | 51 | 150 `Decal` placements, 18 Umojan pillars, three large containment chambers and three Umojan floodlights. |
| Lab02 lower containment sector, `[72,111) × [8,54)` | 101 | 34 | 20 `Decal` placements, six wall consoles, five Umojan pillars and one large containment chamber. |

Review the [original laboratory corridor](https://www.gamepressure.com/starcraftiiheartoftheswarm/gfx/word/346861656.jpg)
and [lower-level checkpoint](https://www.gamepressure.com/starcraftiiheartoftheswarm/gfx/word/346861703.jpg)
at gameplay scale. Their open routes are framed by deep walls, large built-in
assemblies, floor changes and local status lighting. The relay has crisp seams
and reserved aisles. Its sparse room centers and uniformly lit gallery need
stronger silhouettes around those open areas. Counts measure placements.
Model scale, visibility and visual coverage require an Editor view.

Use these rules when planning laboratory profiles:

- Lay out the room shell as wall bays, door frames, pillars and service recesses.
  Put the corridor's focal points at doors, junctions and turns. Keep the
  through lane and approaches clear.
- Give each room a large assembly tied to its purpose, then fit secondary
  modules to the space left around its aisles. Use a display island and
  operator positions in command, a containment chamber and monitoring
  stations in research, and a connected cargo transfer or pipe assembly in
  service. Scale the focal footprint or reduce the usable room depth when
  the room stays visually empty at gameplay scale.
- Give each working bay a floor and lighting treatment. Add low-profile
  markings at thresholds and work areas, with local indicators at consoles
  and gates. Verify the model or decal against the selected dependencies.
  Use damage or emergency lighting only where the room's condition calls for it.
- Reuse the functional roles with faction-specific assets. Umoja can use
  paneled bays, glass, cyan instrumentation and a large containment chamber.
  Castanar can emphasize repeated stasis and monitors. The installed
  `thorner05s` places 32 `CastanarStasisTube`, 17
  `CastanarStasisTubeWall` and 17 `CastanarMonitorWall` instances across the map.

Review shell, functional equipment, cargo and floor detail separately in a
wide map view and at gameplay scale. Repeated trim and cargo can account for
most placements in a room while leaving its purpose hard to read.

### Raised laboratory bays

The installed Lab Rat (`zlab01`) terrain declares `LabCliff1`, `LabCliff0`
and three native ramps joining cliff levels 1 and 2. Its saved doodads include
five Umojan catwalk ramp sections, 19 glass wall panels, 19 one-high panels
and 26 two-high panels. Use the change in level to set off a work bay, place
the stairs where its route actually arrives, and use different partitions to
divide work areas on the same floor.

Mission `facility.terraces` define raised rectangular decks on the even native
terrain grid. Each deck has `min`, `max`, at least one `stairs` entry and an
optional `faceActor`. A stair names the approached `side` and an odd absolute
`at` coordinate measured along that face. The compiler builds a one-level
cliff and a cardinal, four-cell-wide native ramp at each stair. Set
`treadActor` to add measured visual treads over the ramp while the native
terrain carries movement. Use `landscape: "campaign"` to resolve the cliff set.
Reserve the stair width and both landings before placing equipment.
Use `kind: "scenic"` for a retaining ledge in an unused apron with no stairs.
Give it an optional native `floor` material and put any decor pocket well inside
the upper surface. Keep both the cliff face and the upper rim out of circulation.

Each space may specify straight internal `partitions` with `from`, `to`,
and an `actor`. The optional `opening` uses an absolute coordinate `at`
along the wall and a `width`. The compiler keeps that opening clear in the
visible wall and the ground pathing mask. Run each divider on one deck and
keep its endpoints clear of stair approaches.

### Closed perimeters and wall faces

Define the site envelope once in `facility.grounds`. With
`grounds.perimeter`, the whole boundary receives measured sections and corner
joins. The generator cuts openings where world connections and local passages
cross the enclosure. It uses the same spans for the visible fence and the
ground pathing mask. Place the crossing through the boundary to create a gate.

Use `facility.wallFaces: "double"` when both faces of the laboratory walls
are visible. A room wall or partition may override `faces` to `"single"`
where a cliff, exterior shell or other surface covers its back. For a double
face, the two instances share the measured span and total thickness. The rear
instance rotates 180 degrees and sits across the centerline. Gate widths and
pathing still follow one wall footprint. The perimeter defaults to double faces.

### Trim at transitions

Use `grounds.floorJoints` to place a low measured floor fitting directly
over each hard change of material at least one cell long inside the facility.
The generator traces the final painted texture masks, including inside rooms,
around floor inlays and through door openings. It omits blended edges and
stops the fittings at walls, cliffs and steep changes of height. Specify a
catalog `actor` and optional `width`, `height` and `segmentLength`. These
low fittings leave the route's ground pathing mask intact.

Use narrow, straight floor bands for engineered transitions. Match the accent
across the entrance apron, gallery and room approaches. Existing space
`inlays` and passage `trim` paint the bands. Use measured `composition.edges`
for low lights, conduits or other repeated technical decor beside the bands.
Keep this hardware at the sides between entrances. The generator skips a
section when its footprint and buffer would overlap a world route or a local
facility passage. Floor markings may cross a threshold because they preserve
the clear opening. For forest or volcanic ground use a blended shoulder with
natural detail chosen for the biome.

Use industrial catalog actors for the transition hardware and review them from
the player camera. Resolve an ambiguous silhouette to its placed Actor ID
before using it as a repeated motif.

Add `facility` to a mission zone. Each `spaces` entry has its own `id`,
`role`, `center`, even `width` and `height`, and tileset-native `floor`.
Optional `trim` places a border. `shape: "ellipse"` with `blend` gives
an open organic pad. Rectangular spaces can specify a wall actor and any subset
of wall sides. For a `fixtures` row, set `actor`, `side`, `count`,
`spacing` and `inset`. An optional `offset` shifts it along the wall
and `rotation` overrides its orientation in degrees.
Use `inlays` with `min`, `max` and `floor` to paint distinct work surfaces
inside one room. The optional `grounds` rectangle defines the site with
separate `floor`, `trim` and `exterior` materials. It keeps the apron clear of
general scattering while still allowing explicitly placed decor pockets.

`passages` connect named faces with separate floor and trim. A face uses
`space`, `side` and optional lateral `offset`. A passage can bend through
orthogonal `waypoints`. Omit `to` for an exterior entry with at least one
waypoint. A `threshold` is a measured ground model spanning the opening.
A `jamb` supplies a measured actor at each flank. Existing world connections
still define mission-wide access. The compiler checks walls against that graph,
cuts the specified openings in both scene and ground pathing, and rejects
equipment placements that obstruct the passage. Floor masks, wall spans and
fixture placement use the same resolved plan. `world.build` reports the number
of wall sections and equipment objects per space.

This workflow composes the playable surface and visual architecture. A mission
that requires a functioning economy, scripted door state or actual Zerg creep
can author those systems separately through the existing gameplay and terrain
tools. The generator keeps prior room, open terrain and cliff workflows available
alongside the facility input.

Public primary references for the visual interpretation include
[Thiago Klafke's Legacy of the Void environment set](https://www.thiagoklafke.com/blog/portfolio/starcraft-ii-legacy-of-the-void/)
and [Blizzard's Nova Covert Ops compound and multiple approaches](https://news.blizzard.com/en-us/article/20372509/patch-3-8-preview-nova-the-final-missions).
