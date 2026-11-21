# Mission authoring

## Contract for the planner

The LLM selects the scene's intent, terrain character, connections, focal
points and visual references. The MCP compiles those choices into existing
terrain and placement operations. For creation, start at `mission.contract`
and `mission.layout`. For an existing map, get the exact revision and object
context with `mission.inspect`, then use owned zone tools for local changes.
Keep the intent and selected seed with the revision so another session can
resume it without rebuilding the map. Review each candidate with the same
native cameras before changing the local rule or accepting the revision.

Create and edit share the material, geometry, measured model and placement
modules. Current profiles cover specific terrain families and qualified native
cliff and ramp shapes. Additional families belong in the generators, with
their own transition and placement constraints and reviewed reference views.

Call mission.contract for the short index, then select a section to get its
JSON Schema, tool sequence and available evidence. Terrain, project state,
context, gameplay, Data and verification each have a separate entry. Use
the actual MCP tool schema for the request envelope. The compiler also
validates references and cross-field constraints when planning.

For a new map, choose the terrain profile, map purpose, route pattern, zone
purposes, dependency set and seed. Use mission.layout to see the generated
coordinates, reserved lanes and review views. Pass the selected layout
ID and the original spec to mission.build. The spec stays with the project
so a later session can recover the same design and exact revision.

For an existing map, start with mission.inspect and the archive SHA-256.
Use a rectangle and a name or ID query to keep the planner's context small.
The result includes native placement IDs and coordinates, GUI names and
IDs, declared dependencies and local Data catalog paths. XML components
above the bounded reader's limit are labelled too_large.

## Persisted mission edits

Open SC2EditorMCP with SC2_UI_ROOT set to a workspace containing a packed
SC2Map. The workflow, map-builder and all profiles expose mission.resume,
mission.plan and mission.apply. A custom module selection can include mission.

1. Call mission.inspect for the confirmed archive revision. Call mission.plan
   with projectId, the workspace-relative sourceArchive, its SHA-256 as
   baseSha256, and a MissionSpec. This records the baseline revision, saves
   the pending plan and returns the placement diff under missionProject.plan.
2. Call mission.apply with projectId and the returned plan.id. The working
   copy is repacked and reopened by the archive adapter. The candidate
   path and digest appear in missionProject.current.
3. In a new process with the same workspace, call mission.resume with
   projectId. Its response recovers the current archive, phase, pending plan,
   most recent apply receipt and any linked acceptance report. For later
   edits, omit sourceArchive and use current.sha256 as baseSha256.

A MissionSpec v1 example:

    {
      "version": 1,
      "intent": "Mark the basin for later route tests",
      "edits": [
        {
          "op": "ensurePoint",
          "name": "BasinReference",
          "position": { "x": 103, "y": 46, "z": 0 }
        }
      ]
    }

ensurePoint creates a Normal ObjectPoint if the name is absent, and checks
the exact name, type and coordinates if it is present. movePoint takes an
existing objectId and position. moveDoodad takes an exact objectId, an
expectedActor, a destination and an area with minX, minY, maxX and maxY.
Both the original and destination positions must be in the specified area.
The move preserves the object ID, actor, variation and other attributes.
Conflicting names, actor mismatches and duplicate targets require a revised
plan. The current placement compiler requires a readable neutral Objects
component and accepts up to 32 edits.

The latest applied plan can be retried by ID. Planning the same already
satisfied point again against the current hash yields no_change on apply.
A different successful planning request replaces the pending plan. A stale
base hash or externally modified current archive causes an error.

The candidate and receipt become current together in a state file under
.sc2mcp-mission/<projectId>. After a crash before publication, apply
rebuilds from the verified base in a fresh working copy. An interrupted
attempt can leave private files under the same project directory.
Archive reopening confirms stored components. Native Editor loading and
gameplay have their own checks.

## Create an original landscape

Use `mission.styles` to discover the tilesets observed in Wings of Liberty,
Heart of the Swarm, Legacy of the Void and Nova Covert Ops. A campaign reference
supplies palette data for an original layout. Set `terrain.styleCampaign`
and `terrain.tileSet` to pin it. New maps resolve the actual tileset through
their declared, installed dependencies.

`mission.materials` returns material roles and reviewed texture descriptions.
It infers simple roles from descriptive names and leaves unknown numbered
slots unclassified. Set `terrain.materialsFromStyle=true` to fill material
roles from these records. Explicit texture IDs override the defaults.
The reviewed Jarban Minor palette includes ground, trail, vegetation, rock,
floor and trim; the descriptions are reusable without loading the DDS previews.

`layout.pattern=riverValley` uses the wetland profile and a declared water
material. It routes approaches along one bank, carves a continuous meandering
channel through a native water strip and fits optional cliff terraces on the
far bank. The build checks submerged cross sections and dry side boundaries
after creating the water. `campaignDecor=true` selects and measures local
doodads for the banks, canopy, cliff toes and base from the chosen campaign
palette with catalog fallbacks. Highlights, clustering and clearance rely on
the generated terrain and measured models.
The build receipt reports the time spent selecting and placing doodads,
finishing surface textures and fitting trim in `creation.decorTiming`.
The two main areas sit in oval clearings, with straight material seams on any
engineered floor inside. Natural cliff contours follow the native two-cell
grid and keep local openings aligned with their ramps.
Ramp landings receive an elongated, feathered material pass that preserves the
native ramp mesh and visibility data.

Set `decorDensity=lush` to seed inland groves and undergrowth as well as banks.
The density scales with playable area. The builder interleaves candidates from
both banks and varies measured stock plants and their scale. Ground support,
ramps, routes, pads and spacing can lower the achieved count.
`mission.decor_density` estimates authored doodads per 32×32 and scales the
campaign quartiles to a requested full map size. It uses main missions and
excludes named pathing helpers. A whole-map count includes quiet areas and
concentrated set pieces, and foliage generated by the engine is outside it.

Use `mission.checkpoint` with `action=list`, `save`, or `restore` to
name and revisit a retained packed revision. Save and restore require
`projectId`, `name`, and `expectedSha256` of the current revision. Resolve
any pending plan first. Restoring updates the mission's current revision
pointer. Older packed files and the initial source stay available.

Pass MissionSpec version 2 with mode=create to mission.layout. Select a layout
ID, or omit it when calling mission.build to use the highest-ranked layout.

- basinFork builds an original short approach and a longer bypass around a
  central basin. A bonus zone on the bypass gives the player a reason to detour.
- expedition builds a through route with a junction and an optional dead-end
  detour to a bonus zone.
- defenseHub builds a central start area approached from three directions.
  An optional outpost adds a fourth connection.

Specify the family in layout.pattern. Omitting it selects basinFork. Vary the
family for different route graphs, the terrain and decor for different visual
identities, and the seed for variations within a family.

The original layouts use design principles from these mapmaking references.

- Short and exposed routes, wider alternatives and side areas that reward map
  control. [Blizzard ladder map notes](https://news.blizzard.com/en-us/article/9575574/new-maps-for-2013-ladder-season-3)
- Multiple meaningful approaches, geometry-based timing and defensive
  chokepoints. [Blizzard ladder overview](https://news.blizzard.com/en-us/article/21776216/new-ladder-maps-for-season-2-2018)
- Alternating pressure and exploration for campaign pacing.
  [Blizzard editor panel](https://news.blizzard.com/en-us/article/994844/starcraft-ii-custom-maps-and-editor-panel)

The builder creates a fresh Arcade foundation, terrain and registered points.
Use terrain.tileSet and optional initialTexture, trailTexture and accentTexture
from the selected dependency set. Select terrain.profile=wetland for rounded
shoreline shelves and textured banks. Select highland for stronger shoulder
relief and rocky accents. A terrain.detailTexture controls the secondary
ground cover. Both profiles vary relief and material masks reproducibly within
the writer's altitude limits, and reserve clear route centers and zone pads.
An optional water.parent selects an installed Water entry. The native water
layer uses an eight-cell grid. The wetland profile expands tile coverage
only where it clears the approaches, then shapes the visible shoreline
with ground height inside the coverage. Optional decor.style=floodedRuins
uses three exact Doodad Actor selectors in decor.landmark, decor.ruins and
decor.vegetation. The builder measures their bounds and fits the composition
around reserved routes and zone centers. The sightline exclusion is a horizontal
clearance rule. Review the native frames for actual visibility and framing.

Set `terrain.landform=riverTerraces` with the wetland profile for elongated
banks and a one-tier native terrace with an east-facing ramp. Use
`terrain.landform=splitRidge` with the highland profile for directional ridges,
a two-tier mesa and two independently fitted ramps. `mission.layout` returns
the cliffs, ramp centers and protected landings. It rejects layouts where the
terrain cuts intersect reserved travel, zone pads or the water reservation.

The default `terrain.cliffEdge=natural` staggers the cliff shoulders and
retains a straight face immediately around each ramp. Use
`terrain.cliffEdge=engineered` for straight terraces and square corners.

The wetland and highland profiles feather materials by height, slope and
world-space variation. Doodad clusters guide where the ground gets a localized
wash of rock or ground cover. A paved base can sit inside the same landscape.
Set `terrain.baseSurface` to a zone (`start`, `objective` or `bonus`) and
two distinct textures (`floorTexture` and `trimTexture`) from the active
palette. The builder puts a straight painted border directly across the seam
between the floor and the surrounding terrain. It fits inside the zone pad.
Optionally set `terrain.baseSurface.trimBorder` to `inner`, `outer` or
`both`. The builder reads the painted mask, fits straight and corner
`DOM_GroundTrims` to the selected seams, and uses a thinner inner border.
It verifies support and returns the fitted bounds and section counts.
For an existing component map, `terrain.material_border.plan` runs the
same fitting rule and returns a placement plan without editing materials.

Use materials that visually support the objects above them, keep the routes
readable, and check the material seams from the intended gameplay camera.
[Blizzard mapmaking guide](https://news.blizzard.com/en-us/article/20097658/mastering-mapmaking-part-one)
[Terrain Editor texture brushes](https://s2editor-guides.readthedocs.io/New_Tutorials/02_Terrain_Editor/020_Terrain_Layer/)
[World Machine material masks](https://www.world-machine.com/features.php)

Set `terrain.lighting` to an exact CLight ID available in the declared
dependencies. The builder sets the global terrain light in the map's local Data
layer. `decor.style=riverShrine` and `ridgeRuins` cluster the three selected
Actors around their respective terrain features and prefer a stable terrace
for the main landmark. Placement checks the measured footprint and reserves
ramp landings. The actual water component is authored after the decoration.
The build receipt includes the read-back native cliff and ramp counts.

To assemble the three Actor selectors, use `browse.search` with
`doodads: {}` and an English appearance query for each role. Search the
dependencies intended for the new map, then measure the shortlisted models.
[Doodad search examples](BROWSE_PLACEMENT_MCP.md#find-doodads-by-appearance)

mission.build saves texture and height PNG previews and a revision-bound
creation receipt with the measured build time. It samples approaches and applies one bounded local height
repair for supported steep cells, then rechecks all affected routes.
Water, hidden terrain and invalid masks require a different layout.
The layout is repeatable for a fixed spec and generator version. Fresh
document headers have their own identity and creation timestamp.

### Author gameplay

The mission generator writes five editable GUI folders. A single
`Map Initialization` event in `INITIALIZATION` runs the eventless setup
triggers in `GAMEPLAY`, `MAIN OBJECTIVES` and `CINEMATIC` in sequence.
`FUNCTIONS` holds the shared conditions and state.

Add gameplay to the creation spec to turn the zones into a playable objective.
A minimal example uses these fields.

    {
      "scout": "Thor",
      "capture": { "guard": "Zergling", "title": "Secure the relay" },
      "bonus": { "guard": "Zergling", "title": "Clear the ruins" },
      "wave": {
        "unit": "Zergling",
        "count": 3,
        "delay": 4,
        "hold": 22,
        "title": "Hold the relay"
      }
    }

The compiler binds the authored preplaced units to editable GUI triggers.
The player secures the objective by killing its guard. After delay game
seconds a single squad attacks the objective. The player wins after the
hold timer and loses if the starting unit dies first. The optional side
objective needs a bonus zone in the layout. An explicit wave.route must
end at the objective. When a local mod overlays a starting or guard unit,
select the dependency with scoutDependency, capture.dependency or
bonus.dependency by its exact package basename.

### Build a dependent Data mod

Call mission.buildMod with a fresh projectId and a version 1 spec containing
intent, name, ability with id and energy, and optionally unit with id and
speed. Ability costIndex defaults to zero. Dependencies default to the
Liberty mod. The builder confirms the inherited class and field, authors
the local override, reads it back, and exports a packed SC2Mod. The archive
and its Data overrides are available through mission.resume.

For a test map, place an unpacked component view of the exact mod revision
under the workspace's Mods directory. Reference that package in the map
spec's custom dependencies. The native game needs the corresponding packed
mod in its SC2 dependency search location. Retain both hashes in test evidence.

## Verify the exact current revision

Pass projectId and the current SHA-256 to mission.verify. Select editor={} for
load and save/reopen. The builder's gameplay receipt supplies the GUI compile
context. For other maps, pass the actual contextLabel to request compilation.
With a generated map, game={unitType:"Marine"} adds a separate fixture test for
each route leg and three game cameras. Add counterattack=true to check the
authored guard death, exact spawned cohort and its movement into the objective
area using a private combat fixture. The test observes a bounded interval
after guard death. The complete playthrough still supplies victory evidence.
Set editor.nativeSavedGame=true to launch the exact archive produced by native
save/reopen. Set run=true to queue a ready suite, then poll project.test.status
and project.test.report. mission.resume recovers the persisted report reference
and identifies a report for an older map revision as stale.

mission.views queues native Editor captures for the start, junction and goal.
Choose overview for the wide composition view. Sculpted terrain profiles
include that view by default.
Poll editor.job for the native camera readback and PNG. Consecutive confirmed
captures can reuse the same loaded map and requested rendering backend.

The default Native Editor Toolkit release pin remains the published package.
To use a compatible local Toolkit 1.2.0-rc.1 build, set SC2_NATIVE_MCP_PATH to
its SC2NativeMCP executable and SC2_NATIVE_TOOLKIT_VERSION=1.2.0-rc.1. The
transport checks the advertised API contract and native protocol before
submitting operations.
