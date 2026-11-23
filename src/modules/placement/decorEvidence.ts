import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { projectPath } from "../../app/paths.js";

export interface PlacementRule {
  placement: "cluster" | "layout" | "manual";
  layer: string;
  where: string[];
  groupWith: string[];
  clear: string[];
  pattern: string;
}
export interface ActorGuide {
  role: string;
  kind: "natural" | "built" | "creature";
  evidence: string;
  states?: string[];
  tilesets?: string[];
  biomes?: string[];
  factions?: string[];
  size?: string;
}
interface MissionDecor {
  name?: string;
  campaign?: string;
  mapRole?: string;
  tileset?: string;
  profile?: string;
  status: "measured" | "missing_objects";
  source: string;
  instances?: number;
  types?: number;
  roles?: Record<string, { types: number; instances: number }>;
  actors?: Record<string, number>;
}

let cache: ReturnType<typeof load> | undefined;
async function load() {
  const [archive, policies] = await Promise.all([
    readFile(projectPath("resources/authoring-catalog/decor-evidence.json.gz")),
    readFile(projectPath("resources/authoring-catalog/style_rules/decor_composition.json"), "utf8"),
  ]);
  const raw = gunzipSync(archive, { maxOutputLength: 8 * 1024 * 1024 });
  const atlas = JSON.parse(raw.toString("utf8")) as {
    version: number;
    sourceCommit: string;
    actors: Record<string, ActorGuide | undefined>;
    missions: Record<string, MissionDecor | undefined>;
  };
  const composition = JSON.parse(policies) as {
    version: number;
    rules: Record<string, PlacementRule>;
    referenceTilesets: Record<string, string[] | undefined>;
    nativeCanopyProfiles: string[];
    profiles: Record<string, { roleOrder: string[]; composition: string } | undefined>;
  };
  if (atlas.version !== 1 || composition.version !== 1) throw Error("DECOR_EVIDENCE_VERSION");
  return {
    ...atlas,
    ...composition,
    revision: createHash("sha256").update(raw).update(policies).digest("hex"),
  };
}

export function readDecorEvidence() {
  return (cache ??= load().catch((error: unknown) => {
    cache = undefined;
    throw error;
  }));
}

export type DecorEvidence = Awaited<ReturnType<typeof readDecorEvidence>>;

export function scenicActor(evidence: DecorEvidence, id: string) {
  const actor = evidence.actors[id];
  return (
    actor &&
    evidence.rules[actor.role] &&
    evidence.rules[actor.role].placement !== "manual" &&
    !actor.states?.some((state) => ["damaged", "burning", "abandoned", "infested"].includes(state))
  );
}

export async function queryMissionDecor(
  id: string | undefined,
  query: string,
  offset: number,
  limit: number,
) {
  const evidence = await readDecorEvidence();
  const needle = query.toLowerCase();
  const summary = ({ actors: _actors, ...mission }: MissionDecor) => mission;
  if (!id) {
    const matches = Object.entries(evidence.missions).flatMap(([id, mission]) =>
      mission &&
      [id, mission.name, mission.campaign, mission.tileset, mission.mapRole]
        .join(" ")
        .toLowerCase()
        .includes(needle)
        ? [{ id, ...summary(mission) }]
        : [],
    );
    return {
      total: matches.length,
      offset,
      items: matches.slice(offset, offset + limit),
      nextOffset: offset + limit < matches.length ? offset + limit : null,
    };
  }
  const mission = Object.hasOwn(evidence.missions, id) ? evidence.missions[id] : undefined;
  if (!mission) throw Error("DECOR_REFERENCE_UNKNOWN: " + id);
  const matches = Object.entries(mission.actors ?? {}).filter(([id]) =>
    id.toLowerCase().includes(needle),
  );
  matches.sort(([a, an], [b, bn]) => bn - an || a.localeCompare(b));
  const items = matches.slice(offset, offset + limit).map(([id, count]) => ({
    id,
    count,
    ...evidence.actors[id],
    eligible: Boolean(scenicActor(evidence, id)),
  }));
  return {
    mission: { id, ...summary(mission) },
    total: matches.length,
    offset,
    items,
    nextOffset: offset + limit < matches.length ? offset + limit : null,
    compositionRules: Object.fromEntries(
      [...new Set(items.map((item) => item.role))].flatMap((role) =>
        role ? [[role, evidence.rules[role]]] : [],
      ),
    ),
  };
}
