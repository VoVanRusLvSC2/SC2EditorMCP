# Current-document GUI command patches

`live.trigger.patch` runs a compact edit script against the currently open
document. It reuses the existing native providers, holds one process lease for
the sequence and records every step before submission. It does not replace the
map, export/import an existing graph, reopen a checkpoint or require an advance
Save. This is a command patch; complete declarative desired-graph reconciliation
remains separate work.

Use the actual AI/Terrain/Triggers window ID and archive. The default `path`
identifies an existing trigger or function. Individual lines can override `path`
for another component of the same document. Schema arguments are checked for
every command before the first mutation. Native target/source compatibility is
then checked against the evolving current document before each step.

```text
live trigger.patch archive=Current.SC2Map windowId=123 path="MAIN/Start" saveOnComplete=true <<EDITS
bind itemIndex=1 parameterPath=2 parameterIndex=1 source=value value=9
append_action action=wait seconds=0.25 as=Pause
set_wait actionIndex=@Pause seconds=0.5
declaration_set path=FUNCTIONS/Reward view=local member=Offset field=initial value=8
EDITS
```

The block is supported by `modkit.author mode=stage`. A detailed tool call can
instead supply the same lines as `script`. Lines omit archive/windowId and all
`expected...` hashes: the adapter owns those guards. Quotes and scalar values
use the existing compact command lexer. No script is evaluated as JavaScript,
Galaxy, shell code or Custom Script.

The first bind in the example assumes parameter container 2 and its first
argument have already been inspected. Child selectors retain the existing
one-based `groupPath` and `parameterPath` semantics. An append can declare
`as=Name`; later item/action/event indexes can use `@Name`. `last` selects the
last current sibling. Aliases are scoped to owner, section and normalized group
path and are invalidated by reorder/delete/transfer.

Supported commands are `bind`, `set_integer`, `set_real`, `set_unit`, `set_point`,
`set_wait`, `set_periodic`, `append_action`, `append_event`, `append_condition`,
`edit`, `move`, `declaration_set`, `declaration_rename`, `new_declaration` and
`member_create`. Their original schemas, limits and native refusal conditions
still apply. A patch accepts 1–64 steps and watches up to 16 owner graphs, with
8192 nodes per tree and 32768 watched nodes overall.

Default parameters and signature/type/shape changes retain `needs_validation`.
The script can finish its related planned changes, but it will not automatically
Save while any such validation remains. Original provider validation, reference
review, compilation and gameplay remain separate. Verified literal edits and
fully configured Wait/Periodic primitives can complete with one native same-file
Save when `saveOnComplete=true`. It defaults to false.

## Interruption and recovery

Keep the returned `patchId`. A pending patch also returns `pendingId`; a nested
native operation's distinct ID is exposed as `nativePendingId` with a bounded
`operationResult`. Do not pass the patch ID to a native transfer/member recovery
tool that expects its own operation ID.

`live.trigger.patch_recover action=inspect` compares the saved revision and all
watched graphs with the shared journal. `action=continue` resumes only after
acknowledged steps whose recorded state still matches. A positively acknowledged
append can also be adopted after a lost follow-up observation if the complete
observed insertion, literal duration/label and unrelated watched graphs prove
that exact append. This adoption never repeats New or insertion.

An unknown native commit or Save is never replayed. Use that original operation's
recovery/inspection path. `action=release` archives the journal and releases its
guard without undoing any edits; unresolved status remains in history. Completed
records are retained privately and can be inspected by another MCP client bound
to the same process/document. Editor restarts do not inherit the old process ID
and creation identity.

The process lease excludes other MCP clients during the sequence. Pending manual
input is preserved; changes to watched graphs between steps stop the sequence.
This does not claim a native whole-document revision ID or visibility into every
unselected model reference. Signature changes can legitimately update callers
and remain unvalidated. Native Undo remains per original handler: there is no
atomic Undo group or automatic rollback of arbitrary user work.

## Bounded native acceptance

An owned original Editor 5.0.17.98310 applied five edits across a trigger and
function: two nested argument values, one appended Wait, its later duration edit
through an alias and a local initializer. A deliberately unavailable observation
stopped after the first acknowledged edit. Another client continued from the
journal. An insertion receipt integration defect was then recovered by proving
the already-created Wait, with zero repeated insertions and one same-file Save.

The exact saved fixture was reopened and passed the original generator/compiler
with zero compiler errors. The full generated Galaxy matched its previous source
after only the requested replacements: `(7, 4)` to `(9, 6)`, initializer 5 to 8
and one `Wait(0.5, c_timeGame)` insertion. All other generated logic was identical.
Evidence is retained locally under `work/live-trigger-patch-20261114/STATE.json`;
private maps, native artifacts and logs are not source deliverables.
