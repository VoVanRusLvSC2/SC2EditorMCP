import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Workspace } from "../core/workspace.js";
import { createMapInfo } from "../modules/document/codecs/mapInfoFactory.js";
import { readVersion, versionMarker } from "../modules/document/codecs/metadata.js";
import { RegionWorkspace } from "../modules/placement/regions.js";

test("native regions create and reshape with stable IDs and grouped stale revision checks", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sc2-regions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = (name: string) => path.join(root, name);
  await fs.writeFile(file("MapInfo"), createMapInfo(96, 96, "Agria", 4, 10));
  await fs.writeFile(
    file("MapInfo.version"),
    versionMarker("mapi", { major: 5, minor: 0, patch: 17, build: 98745 }, 10, 1),
  );
  await fs.writeFile(
    file("ComponentList.SC2Components"),
    '<Components><DataComponent Type="mapi">MapInfo</DataComponent></Components>',
  );
  const region = new RegionWorkspace(new Workspace(root));
  const initial = await region.inspect("");
  const operations = [
    {
      op: "create",
      name: "West & North",
      shape: { type: "rectangle", minX: 10, minY: 11, maxX: 15, maxY: 19 },
    },
    { op: "create", name: "Hill", shape: { type: "circle", x: 53, y: 46, radius: 5 } },
  ] as const;
  const preview = await region.apply({
    expectedSha256: initial.sha256,
    operations: [...operations],
  });
  assert.deepEqual(preview.createdIds, [1, 2]);
  assert.deepEqual((await region.inspect("")).regions, []);
  await region.apply({
    expectedSha256: initial.sha256,
    operations: [...operations],
    dryRun: false,
    stage: false,
    backup: false,
  });
  const saved = await region.inspect("");
  assert.deepEqual(
    saved.regions.map(({ id, name }) => [id, name]),
    [
      [1, "West & North"],
      [2, "Hill"],
    ],
  );
  assert.deepEqual(saved.regions[0].shapes[0].fields, { quad: "10,15,11,19" });
  assert.equal(readVersion(await fs.readFile(file("Regions.version"))).entryCount, 2);
  assert.match(
    await fs.readFile(file("ComponentList.SC2Components"), "utf8"),
    /Type="regi">Regions/,
  );
  await assert.rejects(
    region.apply({
      expectedSha256: initial.sha256,
      operations: [{ op: "update", id: 1, name: "Stale" }],
    }),
    /STALE_REGION_REVISION/,
  );
  await region.apply({
    expectedSha256: saved.sha256,
    operations: [
      {
        op: "update",
        id: 1,
        name: "West Guard",
        shape: { type: "circle", x: 30, y: 31, radius: 4 },
      },
    ],
    dryRun: false,
    stage: false,
    backup: false,
  });
  const after = await region.inspect("");
  assert.equal(after.regions[0].id, 1);
  assert.deepEqual(after.regions[0].shapes[0], {
    type: "circle",
    fields: { center: "30,31", radius: "4" },
  });
  assert.deepEqual(after.regions[1], saved.regions[1]);
  await fs.writeFile(file("MapScript.galaxy"), "region r = RegionFromId(2);");
  await assert.rejects(
    region.apply({ expectedSha256: after.sha256, operations: [{ op: "delete", id: 2 }] }),
    /REGION_HAS_LITERAL_SCRIPT_REFERENCE/,
  );
  await fs.writeFile(file("MapScript.galaxy"), "");
  const removed = await region.apply({
    expectedSha256: after.sha256,
    operations: [{ op: "delete", id: 2 }],
    dryRun: false,
    stage: false,
    backup: false,
  });
  assert.deepEqual(removed.deletedIds, [2]);
  const final = await region.inspect("");
  assert.deepEqual(final.regions, [after.regions[0]]);
  assert.equal(readVersion(await fs.readFile(file("Regions.version"))).entryCount, 1);
  await assert.rejects(
    region.apply({
      expectedSha256: final.sha256,
      operations: [
        { op: "create", name: "Out", shape: { type: "circle", x: 95, y: 31, radius: 4 } },
      ],
    }),
    /REGION_OUTSIDE_MAP/,
  );
});
