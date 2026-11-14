# Live GUI trigger completion

The requested end state is chat authoring in the currently open Editor document,
including while its AI panel remains open, followed by native Save to that same
archive. A checkpoint, external graph replacement or automatic reopen is not a
substitute. This checklist tracks the complete request; a passing subset does not
complete the goal.

1. **Declarations and functions:** create and edit global/local variables,
   types, arrays, initial values, function parameters and return values. Preserve
   reference identity when renaming; detect uses before destructive changes.
   Current addition: global/local variables, function parameters, native type
   choices and return types through original controls; native variable/function/
   action-definition/trigger creation. Literal numeric/Boolean initial values and
   enabled array controls are supported. Comprehensive use checking, safe
   deletion, arbitrary typed initializers, complete callback and
   verified reference signatures remain open.
   Native Rename now supports global/local/parameter declarations and functions;
   it preserves the native object and reports changed labels, then requires use/
   compilation validation. Complete use inventory before destructive changes
   remains open.
2. **Existing graphs:** read and edit events, conditions and nested actions in
   existing systems. Preserve unrelated branches and manual changes. Existing
   nested binding/edit/move operations are implemented. A complete declarative
   desired-graph reconciliation remains open. `live.trigger.patch` now supplies
   a journalled compact command sequence, fresh guards, one process lease and
   optional same-file Save. Custom function
   bodies now use the same nested action/binding operations; named custom action
   definitions can be called by exact native origin. Not all event/condition
   definition kinds are covered by these direct operations.
3. **Text and localization:** names, descriptions, grammar and localized text
   references without lost keys or locales. The separate current-document Text
   provider exists; complete GUI text integration and library import coverage
   remain open.
4. **Reliable application:** fresh document/model checks, native Undo grouping
   where supported, interrupted-operation inspection/recovery and no blind
   replay. Existing transfer recovery and stale guards are retained. Complete
   cross-operation transaction/recovery coverage remains open; no atomic Undo
   guarantee is made. Local/parameter creation now retains a shared journal and
   native completion marker across reconnects and immutable adapter upgrades.
   Command patches now retain a shared cursor, stop on changed watched graphs,
   resume after acknowledged steps and can adopt a positively acknowledged append
   after proving its exact current insertion. Unknown commits/Saves never replay;
   generic unknown-operation resolution and an atomic native Undo group remain open.
5. **Concise authoring:** common complex systems use high-level commands which
   produce ordinary editable GUI, rather than requiring many low-level calls.
   Existing typed library creation/income recipes remain. Rich variable/function
   recipes and declarative existing-system reconciliation remain open. A compact
   `live trigger.patch <<TAG` block now edits existing systems without caller-
   supplied native hashes or repeated target arguments.

Acceptance must include nested loops, arrays, custom functions, runtime event
registration and a subsequent edit of an existing system, followed by original
Save, reopen and native compilation. The AI panel must not require manual closure,
workspace changes or advance Save. Preserve the source/user document during
development checks. Compiler acceptance and whole-map gameplay remain separate.

Retained local development evidence for declaration/function work is in the isolated
`work/publication/live-gui-graph-20261114/work/declaration-*.json` and
`work/function-*.json` files. These are
bounded native observations, not a full completion certificate. No source maps,
runtime binaries or private Toolkit code belong in the source commit.

The 2026-11-14 function fixture passed same-file native Save, reopen and original
generation/compilation with zero compiler errors. Its exported function computes
`(Base * Factor) + Bonus`, using two parameters and a local initialized to 5;
an ordinary Map Initialization trigger calls it with 7 and 4 and calls a custom
action with a local variable. Compiler acceptance is not a gameplay assertion.
The native Integer parameter's Use Reference option changed in the GUI, but the
generator still emitted a value parameter; that option is not proof of reference
semantics. The original disabled array control was refused before mutation.

The subsequent native Rename fixture changed a referenced local, parameter and
called function, then passed same-file Save/reopen/original compile. Saved
`Triggers` bytes were identical; only the three existing name values changed
in the English TriggerStrings, retaining their resource keys. This establishes
reference identity for this fixture, not comprehensive use analysis of all maps.

A subsequent five-step command patch passed injected interruption/recovery,
same-file Save/reopen and original compilation. It changed two nested arguments
and a local initializer and added/edited one Wait through an alias. No insertion
was replayed. The complete generated Galaxy was identical outside those exact
requested changes. See [command patches](LIVE_TRIGGER_PATCH.md) for scope and
`work/live-trigger-patch-20261114/STATE.json` for private local evidence.
