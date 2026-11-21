import * as z from "zod/v4";
import { missionBuildSpecSchema } from "./buildSpec.js";
import { missionInspectInput } from "./inspect.js";
import { missionModSpecSchema } from "./modBuilder.js";
import { missionPlanInput } from "./spec.js";
import { missionVerifyInput } from "./verification.js";

const contracts = {
  terrain: {
    schema: missionBuildSpecSchema,
    sequence: [
      "mission.styles",
      "mission.materials",
      "mission.decor_density",
      "mission.layout",
      "mission.build",
      "mission.views",
    ],
    modelInputs: [
      "campaign style and terrain identity",
      "topology",
      "zone purposes",
      "native landform, material palette, light, optional campaign decor, and water material",
      "seed",
    ],
    evidence: [
      "ranked layout and native landform",
      "reserved approaches",
      "surface previews",
      "native camera frames",
    ],
  },
  project: {
    schema: missionPlanInput,
    sequence: ["mission.inspect", "mission.plan", "mission.apply", "mission.resume"],
    modelInputs: ["archive and SHA-256", "exact existing IDs", "area and intended placement diff"],
    evidence: [
      "baseline",
      "current archive and SHA-256",
      "pending plan or apply receipt",
      "test report reference",
    ],
  },
  context: {
    schema: missionInspectInput,
    sequence: ["mission.inspect"],
    modelInputs: ["current SHA-256", "optional area", "optional name or ID query"],
    evidence: [
      "placement and region identities",
      "GUI identifiers",
      "declared dependencies",
      "catalog paths",
    ],
  },
  gameplay: {
    schema: missionBuildSpecSchema.shape.gameplay.unwrap(),
    sequence: ["mission.build", "mission.verify", "project.test.report"],
    modelInputs: [
      "starting unit",
      "guard and objective text",
      "optional bonus",
      "wave composition and timing",
    ],
    evidence: ["GUI bindings", "compiled runtime hash", "native check report"],
  },
  data: {
    schema: missionModSpecSchema,
    sequence: ["mission.buildMod", "mission.resume"],
    modelInputs: ["declared dependencies", "ability and energy cost", "optional unit and speed"],
    evidence: ["packed mod and SHA-256", "catalog field readback"],
  },
  verification: {
    schema: missionVerifyInput,
    sequence: ["mission.verify", "project.test.status", "project.test.report"],
    modelInputs: ["exact map revision", "Editor checks", "optional route or counterattack probe"],
    evidence: [
      "source and tested archive hashes",
      "per-check outcomes",
      "bounded native artifacts",
    ],
  },
} as const;

export const missionContractInput = z
  .object({
    section: z
      .enum(["terrain", "project", "context", "gameplay", "data", "verification"])
      .optional(),
  })
  .strict();

export function missionContract(section?: z.output<typeof missionContractInput>["section"]) {
  if (!section) {
    return {
      version: 1,
      sections: Object.entries(contracts).map(([id, { sequence, modelInputs, evidence }]) => ({
        id,
        sequence,
        modelInputs,
        evidence,
      })),
    };
  }
  const { schema, ...summary } = contracts[section];
  return { version: 1, section, ...summary, schema: z.toJSONSchema(schema, { io: "input" }) };
}
