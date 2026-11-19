# Architecture and portability review

Reviewed the current local implementation on 2026-11-19. This is a scoped source
review, not a line-by-line correctness audit or certification of the private DLLs.
It updates the priorities in [the architecture plan](ARCHITECTURE_REFACTOR_PLAN.md).

## Assessment

Keep the TypeScript modular monolith and native adapters. A language rewrite,
microservices or another independent map writer would add migration risk without
addressing the main authoring delays. Existing codecs, generators, source guards,
transactions, retained bridges and compact commands are valuable foundations.

The inspected live tree has 502 production TypeScript files and approximately
77,866 physical lines, including embedded source and imported codecs; 304 files
are under `src/tests`. These counts are inventory, not coverage. Static relative
value-import checking after type erasure passed with no cycles or forbidden
boundary imports. Dynamic imports and external runtime internals are outside it.

Maintainability is uneven. Several orchestration files still combine contracts,
planning, native interaction and recovery. A large test inventory does not remove
that coupling. Working source, Git publication and the running MCP process are
also distinct states: editing or committing source does not reload an old server.

## Restructure behind the existing commands

| Priority | Current boundary | Next bounded change | Contract to preserve |
| --- | --- | --- | --- |
| 1 | `editorLive/triggers.ts`, about 2,290 lines | Extract request contracts, graph reading and native edit operations behind the existing facade | One operation gate, shared pending IDs, original handlers, no unknown replay |
| 2 | `data/workspace.ts`, about 2,159 lines | Separate candidate planning/validation from transaction orchestration, using existing catalog repository and reference graph | One final graph and coupled save; inherited/manual XML and source revisions |
| 3 | `app/authoringScript.ts`, about 1,418 lines | Move domain command compilation into small typed handlers; keep dispatch and cross-command grouping central | Same grammar, aliases, defaults, grouping and error boundaries |
| 4 | `terrain/workspace.ts`, about 1,069 lines | Move owned-landscape coordination behind narrow terrain, placement and catalog ports | One complete source/read set, deterministic seeds, ownership and exclusions |

Line counts describe where to inspect, not automatic split thresholds. Extract
one responsibility at a time and compare full outputs. Do not split one feature
transaction into independently saved parts. The existing Script/GUI graph and
Data recipes should remain the implementation, not be replaced by a parallel IR.

The intended dependency direction remains:

```text
Chat / MCP / GUI
    -> compact command compiler and shared executor
    -> domain planning and validation
    -> guarded document transactions
    -> current-Editor / archive / asset / native-test adapters
```

Pure domain helpers should not import the MCP SDK or control windows. Application
orchestration chooses an application adapter; it must not silently fall back to a
different map. Editor-native acceptance remains separate from static validation.

## Transfer to another computer

There is already a portable Windows builder and application-relative resource
resolution. Improve that path rather than copying the developer directory or
requiring the same drive letter.

1. Define one release inventory for application files, generated catalogs,
   notices, agent instructions and native helpers. The portable builder currently
   enumerates scripts, runtime registries and npm packages manually; source/npm
   dependency changes can drift from those lists.
2. Build an immutable versioned application directory. Keep maps, caches, pending
   operation journals, credentials and private test runtimes outside it. Reuse
   the existing per-user transfer store and native-runtime ownership mechanisms.
3. Put application revision and catalog/native API compatibility in the release
   manifest and expose that identity in status. Existing runtime pins/checks
   remain authoritative; this is consolidation, not evidence they are absent.
4. Verify startup, bounded tool discovery and one representative offline plan
   from the packaged directory at a different path, without source-tree fallback.
   Record native Editor integration separately on a machine with SC2 installed.
5. Update versions by switching the configured application directory and
   reconnecting MCP after pending operations are resolved. Preserve journals;
   never hot-swap a native worker with an uncertain mutation.

Private GameToolkit sources and instrumented maps remain outside distribution.
The existing privacy gate is useful but is not binary reverse-engineering
protection. This review did not build a portable release or test another machine.

## Implemented performance changes

- UI hookup preparation now buckets descendant paths by their top-level template
  once, instead of filtering all frames separately for every root. Encoded path
  segments remain distinct from display names. Source/cache isolation is retained.
- Data consumer discovery records processed file identities. A file with no links
  or diagnostics is still processed; saved/staged fallback no longer reads/parses
  it again. Tracked reads, directory freshness and source hashing remain enabled.
- Catalog ID accumulation appends to owned arrays instead of repeatedly copying
  each prior bucket. Declaration order and duplicate ambiguity remain unchanged.

Local warm synthetic measurements compare saved pre-change source against the
changed implementation using the same dependencies and full output equality:

| Preparation | Fixture | Before | After |
| --- | --- | --- | --- |
| UI template hookup index | 600 roots, 10,200 frames | about 270 ms | about 16 ms |
| Data consumer scan | 182 saved and modified staged consumers without links | about 190 ms, 365 reads | about 94 ms, 182 reads |

These are preparation measurements, not whole-map speed promises. Empty/staged
consumer behavior is intentionally stressed; maps with few drafts gain less.
UI has 12 warm samples per implementation; Data has five. Local benchmark source,
baseline snapshots and exact samples are under `work/architecture-20261119` in the
isolated development worktree. Native rendering and gameplay were not exercised.

The updated local application built successfully. All 58 selected regressions
passed across Data, consumer preparation, UI resolution/layouts, shared dispatch
and dependency transactions. Scoped ESLint, Prettier and diff whitespace checks
passed. Architecture and maintained-documentation language checks also passed.
This is the changed-scope result, not a full-suite or native acceptance claim.

## Remaining optimization priorities

Measure cold startup, asset preparation, native commit and Save separately using
the existing telemetry. Preserve bounded caches and fresh source validation. Prefer
one retained process and one complete feature plan to many small round trips.
Only add lazy imports or further caching when measurements identify a cost; do
not skip stale guards, compilation or diagnostics to improve a headline number.

For faster attractive maps, reusable authored compositions and actual Editor
feedback remain necessary. Algorithmic speed and clean architecture alone do not
establish visual quality, animation playback or gameplay balance.
