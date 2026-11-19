import test from "node:test";
import assert from "node:assert/strict";
import { CrossFileResolver } from "../core/resolver.js";

test("cross-file metadata reuses exact source while keeping file identity, caller edits and fresh reads separate", async () => {
  let layout =
    '<Desc><Include path="Included.SC2Layout"/><Frame type="Frame" name="Template"><Frame type="Frame" name="Child"><Handle val="ChildHandle"/></Frame></Frame></Desc>';
  let style = '<StyleFile><Style name="Example" font="GameFont"/></StyleFile>';
  let reads = 0;
  const read = async (file: string) => {
    reads++;
    return file.endsWith(".SC2Style") ? style : layout;
  };
  const first = await CrossFileResolver.build(
    ["One.SC2Layout", "Two.SC2Layout"],
    ["Test.SC2Style"],
    read,
  );
  assert.equal(first.resolveTemplate("One/Template", "Two.SC2Layout").file, "One.SC2Layout");
  assert.equal(first.resolveTemplate("Two/Template", "One.SC2Layout").file, "Two.SC2Layout");
  assert.equal(first.templateProvidesHookup("One/Template", "Two.SC2Layout", "Child"), true);
  const entry = first.layouts.get("one.sc2layout")!;
  entry.includes.length = 0;
  entry.handles.clear();
  entry.templates.clear();
  entry.templateFramePaths.clear();
  first.styles.clear();
  const next = await CrossFileResolver.build(["One.SC2Layout"], ["Test.SC2Style"], read);
  assert.equal(reads, 5);
  assert.deepEqual(next.layouts.get("one.sc2layout")!.includes, ["Included.SC2Layout"]);
  assert.equal(next.resolveTemplate("Template", "One.SC2Layout").found, true);
  assert.equal(next.resolveFrameReference("$ChildHandle"), true);
  assert.equal(next.hasStyle("Example"), true);
  layout = layout.replace('name="Child"', 'name="Other"');
  style = style.replace('name="Example"', 'name="NewStyle"');
  const changed = await CrossFileResolver.build(["One.SC2Layout"], ["Test.SC2Style"], read);
  assert.equal(changed.templateProvidesHookup("Template", "One.SC2Layout", "Child"), false);
  assert.equal(changed.templateProvidesHookup("Template", "One.SC2Layout", "Other"), true);
  assert.equal(changed.hasStyle("Example"), false);
  assert.equal(changed.hasStyle("NewStyle"), true);
});

test("template hookup indexing keeps nested paths inside the exact top-level owner", async () => {
  const source =
    '<Desc><Frame name="A"><Frame name="Child"><Frame name="Deep"/></Frame></Frame>' +
    '<Frame name="AB"><Frame name="Child"/><Frame name="Other"/></Frame>' +
    '<Frame name="Empty"/><Frame name="Escaped/Root~"><Frame name="Child/Name~"/></Frame></Desc>';
  const resolver = await CrossFileResolver.build(["Owners.SC2Layout"], [], async () => source);
  const entry = resolver.layouts.get("owners.sc2layout")!;
  assert.deepEqual(
    [...entry.templateFramePaths],
    [
      ["A", new Set(["Child", "Child/Deep"])],
      ["AB", new Set(["Child", "Other"])],
      ["Empty", new Set()],
      ["Escaped/Root~", new Set(["Child~1Name~0"])],
    ],
  );
  assert.equal(resolver.templateProvidesHookup("Owners/A", "", "Other"), false);
  assert.equal(resolver.templateProvidesHookup("Owners/AB", "", "Child/Deep"), false);
  assert.equal(resolver.templateProvidesHookup("Owners/A", "", "Child/Deep"), true);
});
