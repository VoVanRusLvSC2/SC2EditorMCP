import { promises as fs } from "node:fs";
import path from "node:path";
import * as z from "zod/v4";
import { Workspace } from "../../core/workspace.js";
import { DataDocument } from "../data/document.js";
import type { DataField, DataNativeFieldSpec } from "../data/types.js";
import { dependencySchema } from "../document/schemas.js";
import type { MissionBuildProviders } from "./buildMap.js";
import { prepareMissionCatalog } from "./appearance.js";
import { projectIdSchema } from "./spec.js";

const catalogId = z.string().regex(/^[A-Za-z0-9_]{1,128}$/);
export const missionModSpecSchema = z
  .object({
    version: z.literal(1),
    intent: z.string().trim().min(1).max(1000),
    name: z.string().trim().min(1).max(160),
    dependencies: dependencySchema.default({
      mode: "standard",
      expansion: "liberty",
      campaign: false,
    }),
    ability: z
      .object({
        id: catalogId,
        costIndex: z.number().int().min(0).max(31).default(0),
        energy: z.number().min(0).max(10000),
      })
      .strict(),
    unit: z
      .object({ id: catalogId, speed: z.number().positive().max(64) })
      .strict()
      .optional(),
  })
  .strict();

export const missionModInput = z
  .object({
    projectId: projectIdSchema,
    spec: missionModSpecSchema,
  })
  .strict();
type MissionModSpec = z.output<typeof missionModSpecSchema>;
const flatten = (fields: DataField[]): DataField[] =>
  fields.flatMap((field) => [field, ...flatten(field.children)]);

export async function buildMissionMod(
  workspace: Workspace,
  providers: MissionBuildProviders,
  spec: MissionModSpec,
  attempt: string,
) {
  const output = workspace.resolveUserPath(".sc2mcp-output");
  await fs.mkdir(output, { recursive: true });
  const staging = await fs.mkdtemp(path.join(output, "mission-mod-"));
  const key = (file: string) => path.relative(workspace.root, file).replaceAll("\\", "/");
  const directory = key(path.join(staging, "mod"));
  const archive = key(path.join(attempt, "candidate.SC2Mod"));
  try {
    const foundation = await providers.document.plan({
      kind: "mod",
      destination: directory,
      name: spec.name,
      dependencies: spec.dependencies,
    });
    await providers.document.create(foundation.id, false);
    const copy = new Workspace(path.join(staging, "mod"));
    const { data } = await prepareMissionCatalog(
      copy,
      providers.casc,
      foundation,
      await providers.catalogFiles(),
    );
    async function override(
      domain: "Unit" | "Abil",
      id: string,
      catalog: string,
      sourcePaths: string[],
      targetPath: string,
      fields: DataNativeFieldSpec[],
      desired: number,
    ) {
      const source = await data.metadataEntry(domain, id);
      if (!source.available || new Set(source.matches.map((match) => match.ctype)).size !== 1)
        throw Error("MISSION_MOD_BASE_TYPE_UNCONFIRMED: " + domain + ":" + id);
      const ctype = source.matches[0].ctype;
      const { objects } = await data.resolveFields({
        id,
        domain,
        fields: sourcePaths,
      });
      const resolved = sourcePaths.filter((entry) =>
        objects.some((object) => object.effective?.fields[entry]?.value !== undefined),
      );
      if (resolved.length !== 1)
        throw Error(
          "MISSION_MOD_FIELD_UNCONFIRMED: " + domain + ":" + id + "." + sourcePaths.join(","),
        );
      const file = "Base.SC2Data/GameData/" + catalog + "Data.xml";
      await data.apply({
        file,
        operations: [{ op: "object.create", id, ctype, fields }],
        dryRun: false,
        stage: false,
        backup: false,
      });
      const document = new DataDocument((await copy.readRaw(file)).text);
      const value = flatten(
        document.objects().find((object) => object.id === id)?.fields ?? [],
      ).find((field) => field.path === targetPath)?.value;
      if (Number(value) !== desired) throw Error("MISSION_MOD_FIELD_READBACK_FAILED");
      return { id, domain, path: targetPath, value: desired, file };
    }

    const { ability, unit } = spec;
    // Unindexed rows in a base catalog allocate their position. An override
    // addresses that position explicitly so it updates the existing slot.
    const index = ability.costIndex;
    const indexed = "Cost[" + index + "].Vital[Energy]";
    const energyField: DataNativeFieldSpec = {
      name: "Cost",
      index,
      children: [{ name: "Vital", index: "Energy", value: ability.energy }],
    };
    const authored = [
      await override(
        "Abil",
        ability.id,
        "Abil",
        index === 0 ? [indexed, "Cost.Vital[Energy]"] : [indexed],
        indexed,
        [energyField],
        ability.energy,
      ),
    ];
    if (unit)
      authored.push(
        await override(
          "Unit",
          unit.id,
          "Unit",
          ["Speed"],
          "Speed",
          [{ name: "Speed", value: unit.speed }],
          unit.speed,
        ),
      );
    const result = await providers.map.export(directory, archive, false, false);
    if (!("verification" in result) || !result.verification.reopened)
      throw Error("MISSION_MOD_ARCHIVE_VERIFICATION_REQUIRED");
    return { archive, authored, entryCount: result.verification.entryCount };
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
