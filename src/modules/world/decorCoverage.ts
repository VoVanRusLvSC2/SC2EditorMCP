import { readDecorEvidence, scenicActor, type DecorEvidence } from "../placement/decorEvidence.js";
import { readWorldStyles } from "./missionLandscape.js";
import type { WorldLayout } from "./plan.js";

export async function selectDecorCoverage(layout: WorldLayout, reference: string) {
  const [evidence, registry] = await Promise.all([readDecorEvidence(), readWorldStyles()]);
  const stock = Object.entries(evidence.missions).flatMap(([id, mission]) =>
    mission?.status === "measured" && mission.actors && mission.tileset
      ? [{ ...mission, id, actors: mission.actors, tileset: mission.tileset }]
      : [],
  );
  const references = stock.filter((map) => map.mapRole !== "test");
  const named = stock.filter((map) => map.id === reference);
  if (reference !== "auto" && !named.length)
    throw Error("WORLD_DECOR_REFERENCE_UNAVAILABLE: " + reference);
  const zones = layout.zones.map((zone) => {
    const tileSet = zone.tileSet;
    const family = evidence.referenceTilesets[tileSet] ?? [];
    const variant = tileSet.replace(/Ex\d+$/, "");
    const profile = zone.style ?? registry.tilesets[tileSet]?.profile;
    const exact = references.filter((map) => map.tileset === tileSet);
    const related = references.filter(
      (map) =>
        family.includes(map.tileset) ||
        (map.tileset !== tileSet && map.tileset.replace(/Ex\d+$/, "") === variant),
    );
    const similar =
      profile && profile !== "generic" ? references.filter((map) => map.profile === profile) : [];
    const compatible = (id: string) =>
      scenicActor(evidence, id) &&
      evidence.actors[id]?.kind === (zone.biome === "natural" ? "natural" : "built");
    const group = named.length
      ? named
      : exact.some((map) => Object.keys(map.actors).some(compatible))
        ? exact
        : related.some((map) => Object.keys(map.actors).some(compatible))
          ? related
          : similar;
    const compare = group
      .map((map) => ({
        mission: map.id,
        name: map.name,
        tileset: map.tileset,
        observedTypes: map.types ?? Object.keys(map.actors).length,
        actors: Object.keys(map.actors).filter(compatible),
        mapRole: map.mapRole,
      }))
      .filter((map) => map.actors.length)
      .sort(
        (a, b) =>
          b.actors.length - a.actors.length ||
          b.observedTypes - a.observedTypes ||
          a.mission.localeCompare(b.mission),
      )[0];
    const supporting = named.length ? named : [...new Set([...group, ...exact, ...related])];
    const candidates = new Set(
      supporting.flatMap((map) => Object.keys(map.actors).filter(compatible)),
    );
    const observedActors = [...candidates];
    const nativeActors = [
      ...new Set([
        ...[...exact, ...related].flatMap((map) => Object.keys(map.actors)),
        ...Object.entries(evidence.actors).flatMap(([id, actor]) =>
          actor?.tilesets?.includes(tileSet) ? [id] : [],
        ),
      ]),
    ];
    const tags = profile
      ? (registry.profiles[profile]?.tags.filter((tag) => tag !== "any") ?? [])
      : [];
    for (const [id, actor] of Object.entries(evidence.actors))
      if (
        actor &&
        compatible(id) &&
        (actor.tilesets?.includes(tileSet) ||
          (zone.biome === "natural" &&
            actor.biomes?.some((tag) => tags.includes(tag) && tag !== "rock")))
      )
        candidates.add(id);
    return {
      id: zone.id,
      profile,
      composition: profile ? evidence.profiles[profile] : undefined,
      candidates: [...candidates],
      observedActors,
      nativeActors,
      preferredActors: registry.tilesets[tileSet]?.preferredActors ?? [],
      candidatePrefixes: registry.tilesets[tileSet]?.candidatePrefixes ?? [],
      trainingSources: supporting
        .filter((map) => map.mapRole === "challenge" || map.mapRole === "evolution")
        .map((map) => ({ mission: map.id, role: map.mapRole })),
      reference: compare && {
        mission: compare.mission,
        name: compare.name,
        tileset: compare.tileset,
        match: named.length
          ? "requested"
          : group === exact
            ? "tileset"
            : group === related
              ? "family"
              : "style",
        mapRole: compare.mapRole,
        observedTypes: compare.observedTypes,
        eligibleTypes: compare.actors.length,
      },
    };
  });
  const minimum = Math.max(0, ...zones.map((zone) => zone.reference?.eligibleTypes ?? 0));
  if (reference !== "auto" && !minimum)
    throw Error("WORLD_DECOR_REFERENCE_NO_COMPATIBLE_TYPES: " + reference);
  return { revision: evidence.revision, minimum, zones };
}

export type DecorCoverage = Awaited<ReturnType<typeof selectDecorCoverage>>;

const siteProps = new Set(["fixture", "utility", "light", "yard_prop"]);

export function acceptsAutomaticDecor(evidence: DecorEvidence, id: string, natural: boolean) {
  const actor = evidence.actors[id];
  if (!actor || !scenicActor(evidence, id)) return false;
  return natural
    ? actor.kind === "natural" && evidence.rules[actor.role].placement === "cluster"
    : actor.kind === "built" && siteProps.has(actor.role);
}
