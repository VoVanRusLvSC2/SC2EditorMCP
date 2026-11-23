import type { DecorPalette } from "../placement/decorPalette.js";
import type { PlacementObject } from "../placement/types.js";
import { areaDistance, valueNoise } from "../terrain/geometry.js";
import type { TerrainState } from "../terrain/operations.js";
import { riverDepth, roomDistance, type Structures } from "./structures.js";
import { readDoodadDescriptions } from "../browse/doodadDescriptions.js";
import type { CampaignLandscape } from "./missionLandscape.js";
import { readDecorEvidence, scenicActor } from "../placement/decorEvidence.js";
import { acceptsAutomaticDecor, type DecorCoverage } from "./decorCoverage.js";
import {
  facilityPassageDistance,
  facilitySpaceDistance,
  onFacilityStair,
  perimeterBlocks,
} from "./facility.js";
import { routeEdgeDistance, seedFor, type WorldSpec, type WorldLayout } from "./plan.js";

import { isCargoProp } from "./cargo.js";

export async function worldDecor(
  spec: WorldSpec,
  plan: WorldLayout,
  structures: Structures,
  palette: DecorPalette,
  surface: TerrainState,
  campaign?: CampaignLandscape,
  structureActors: string[] = [],
  reserved: { x: number; y: number; radius: number }[] = [],
  coverage?: DecorCoverage,
) {
  const { browse, catalog } = palette;
  const placements: PlacementObject[] = [];
  const used = [...reserved];
  const scenicTypes = new Set(structureActors);
  const evidence = coverage ? await readDecorEvidence() : undefined;
  const qualifying = new Set(
    evidence ? structureActors.filter((id) => scenicActor(evidence, id)) : [],
  );
  const backfill: (() => Promise<void>)[] = [];
  const edgeActors = new Set(structures.edges.map((edge) => edge.actor));
  const requiredDecor: { zone: string; role: string; actor: string }[] = [];
  const descriptions = campaign ? await readDoodadDescriptions() : undefined;
  const target = coverage
    ? Math.max(campaign ? 55 : 12, coverage.minimum)
    : campaign
      ? Math.floor((campaign.decorBudget.min + campaign.decorBudget.max) / 2)
      : 0;
  const measured = new Map<string, Awaited<ReturnType<DecorPalette["resolve"]>> | undefined>();
  async function measuredActor(id: string, variation: number) {
    const key = id + "/" + variation;
    if (!measured.has(key)) {
      try {
        measured.set(key, await palette.resolve({ id, variation, preview: false }));
      } catch {
        measured.set(key, undefined);
      }
    }
    return measured.get(key);
  }
  for (const [index, zone] of plan.zones.entries()) {
    const styled = campaign?.zones[index];
    const reference = coverage?.zones[index];
    const natural = zone.biome === "natural";
    const forest = (styled?.profile ?? reference?.profile) === "forest" && natural;
    if (!zone.distinctActors && !styled && !reference) continue;
    const mirror =
      spec.mode === "ladder"
        ? plan.zones.findIndex(
            (z) =>
              z.center.x + zone.center.x === spec.width &&
              z.center.y + zone.center.y === spec.height,
          )
        : -1;
    if (mirror >= 0 && mirror < index) continue;
    let candidates = [...new Set(zone.actors)];
    if (styled && !candidates.length) {
      const reference = await catalog.pack(zone.tileSet).catch(() => undefined);
      const roles = reference?.sections ?? {};
      const terms = [...new Set([zone.tileSet.replace(/Ex\d+$/, ""), ...styled.tags])].slice(0, 4);
      const explicit = [...(roles.decor ?? []), ...(roles.vegetation ?? [])].map((r) => r.id);
      const extra =
        explicit.length < 90
          ? (
              await Promise.all(
                terms.map((query) =>
                  browse.search({
                    query,
                    catalogType: "Actor",
                    doodads: {
                      kind: styled.style === "hard_zones" ? "built" : "natural",
                    },
                    limit: 32,
                  }),
                ),
              )
            ).flatMap((r) => r.results.map((r) => r.id))
          : [];
      const preferred = new Set(styled.preferredActors);
      candidates = [...new Set([...preferred, ...styled.actors, ...explicit, ...extra])].filter(
        (id) => {
          const d = descriptions?.get(id)?.description;
          return (
            (!styled.candidatePrefixes.length ||
              preferred.has(id) ||
              styled.candidatePrefixes.some((prefix) => id.startsWith(prefix))) &&
            d?.role !== "effect" &&
            !/blocker|invisible|dummy|camera|wrecked|destroyed|crashing|corpse|^lightomni|^fog|unused|^actor/i.test(
              id,
            ) &&
            (styled.style === "hard_zones" || d?.kind !== "built" || styled.style === "mixed")
          );
        },
      );
      candidates.sort((a, b) => {
        const rank = (id: string) => {
          const tags = descriptions?.get(id)?.description.biome ?? [];
          return (
            8 * Number(forest && /canopy|tree/i.test(id) && !/log|stump|roots/i.test(id)) +
            4 * Number(preferred.has(id)) +
            2 * Number(explicit.includes(id)) +
            Number(tags.some((tag) => styled.tags.includes(tag)))
          );
        };
        return rank(b) - rank(a) || seedFor(zone.decorSeed, a) - seedFor(zone.decorSeed, b);
      });
    }
    if (!styled && !candidates.length) {
      const pack = await catalog.pack(zone.tileSet).catch((error) => {
        if (!reference || !String(error).includes("CATALOG_TILESET_UNKNOWN")) throw error;
        return undefined;
      });
      const section = natural ? "vegetation" : "decor";
      const kind = natural ? "natural" : "built";
      const terms =
        zone.biome === "natural"
          ? ["tree", "fern", "forest", "shrub", "rock"]
          : [
              zone.tileSet.replace(/Ex\d+$/, ""),
              "laboratory",
              "console",
              "industrial",
              "storage",
              "lab",
            ];
      const searches = await Promise.all(
        terms.map((query) =>
          browse.search({ query, catalogType: "Actor", doodads: { kind }, limit: 32 }),
        ),
      );
      const lists = [pack?.sections[section] ?? [], ...searches.map((s) => s.results)];
      candidates = [
        ...new Set(
          Array.from({ length: Math.max(...lists.map((l) => l.length)) }, (_, i) =>
            lists.flatMap((rows) => (rows[i] ? [rows[i].id] : [])),
          ).flat(),
        ),
      ];
    }
    const referenceActors = new Set(reference?.observedActors);
    const priorityActors = new Set(styled?.preferredActors ?? reference?.preferredActors);
    if (reference && evidence && !zone.actors.length) {
      const groups = new Map<string, string[]>();
      const native = new Set(reference.nativeActors);
      const canopyNeedsEvidence =
        reference.profile && evidence.nativeCanopyProfiles.includes(reference.profile);
      const prefixes = styled?.candidatePrefixes ?? reference.candidatePrefixes;
      for (const id of new Set([...candidates, ...reference.candidates])) {
        if (!acceptsAutomaticDecor(evidence, id, natural)) continue;
        // A tileset with an explicit faction palette keeps it when adding reference candidates.
        if (
          prefixes.length &&
          !priorityActors.has(id) &&
          !prefixes.some((prefix) => id.startsWith(prefix))
        )
          continue;
        const key = evidence.actors[id]!.role;
        if (canopyNeedsEvidence && key === "canopy" && !native.has(id)) continue;
        const group = groups.get(key) ?? [];
        if (!groups.has(key)) groups.set(key, group);
        group.push(id);
      }
      const rolePriority = reference.composition?.roleOrder ?? [];
      const rows = [
        ...rolePriority.flatMap((role) => (groups.get(role) ? [groups.get(role)!] : [])),
        ...[...groups].flatMap(([role, group]) => (rolePriority.includes(role) ? [] : [group])),
      ];
      for (const group of rows)
        group.sort(
          (a, b) =>
            Number(priorityActors.has(b)) - Number(priorityActors.has(a)) ||
            Number(referenceActors.has(b)) - Number(referenceActors.has(a)) ||
            seedFor(zone.decorSeed, a) - seedFor(zone.decorSeed, b),
        );
      candidates = Array.from({ length: Math.max(0, ...rows.map((row) => row.length)) }, (_, i) =>
        rows.flatMap((row) => (row[i] === undefined ? [] : [row[i]])),
      ).flat();
    }
    const actors = new Set<string>();
    const failures: string[] = [];
    const blocks = plan.blocks.flatMap((owner, i) => (owner === index ? [i] : []));
    const composed = spec.mode === "mission";
    // Cargo comes from measured rows in storage bays or at room edges.
    const placedCargo = new Set(
      structures.facility.spaces
        .filter((space) => space.zone === zone.id)
        .flatMap((space) => space.fixtures.map((fixture) => fixture.actor))
        .filter(isCargoProp),
    );
    const room = structures.chambers.find((c) => c.id === zone.id);
    const pockets = zone.composition?.pockets;
    const grounds = structures.facility.grounds.filter((ground) => ground.bank === zone.bank);
    const localGround = grounds.find((ground) => ground.zone === zone.id);
    let interiorProps = 0;
    const placedInZone: { x: number; y: number; radius: number; role: string }[] = [];
    const interiorLimit = room?.room ? Math.ceil((room.hx * room.hy) / 12) : 5;
    const types = reference ? qualifying : scenicTypes;
    const before = types.size;
    const remaining = plan.zones.length - index;
    const shareWeight = structures.chambers.some((entry) => entry.room)
      ? blocks.length / plan.counts.slice(index).reduce((sum, count) => sum + count, 0)
      : 1 / remaining;
    const share = styled || reference ? Math.max(0, Math.ceil((target - before) * shareWeight)) : 0;
    const existingRole = new Set<string>();
    const place = async (id: string, role?: string) => {
      if (actors.has(id) || (!natural && isCargoProp(id))) return false;
      const automatic = reference && !zone.actors.length && !role;
      const placementRole = automatic ? evidence?.actors[id]?.role : undefined;
      const companions =
        natural && placementRole && ["understory", "ground_detail"].includes(placementRole)
          ? placedInZone.filter((p) => evidence!.rules[placementRole].groupWith.includes(p.role))
          : [];
      const candidateIndex =
        styled || reference ? seedFor(zone.decorSeed, id) & 0xffff : candidates.indexOf(id);
      let model = await measuredActor(id, 0);
      if (!model) {
        failures.push(id);
        return false;
      }
      if ((styled || reference) && model.variants.length > 1) {
        const variants = model.variants
          .map((file) => Number(file.match(/_(\d+)\.m3$/i)?.[1]))
          .filter((v) => Number.isFinite(v) && v > 0);
        if (variants.length)
          model = (await measuredActor(id, variants[candidateIndex % variants.length])) ?? model;
      }
      const size = model.measured.measurement.dimensions;
      const canopy = natural && size.height > 2.7 && size.width < 13;
      const scale =
        composed && natural
          ? (canopy ? 1.07 : 0.88) + 0.14 * valueNoise(candidateIndex, 0, zone.decorSeed)
          : 1;
      const bounds = model.measured.measurement.bounds;
      const radius = Math.max(
        0.5,
        scale *
          Math.hypot(
            Math.max(Math.abs(bounds.min[0]), Math.abs(bounds.max[0])),
            Math.max(Math.abs(bounds.min[1]), Math.abs(bounds.max[1])),
          ),
      );
      const repeats = composed && natural ? (canopy ? 3.8 : 2.5) : 1;
      const repetition = !natural && styled?.candidatePrefixes.length ? 1.65 : 4;
      const repetitions =
        role === "landmark"
          ? forest
            ? Math.min(6, Math.max(3, Math.ceil(blocks.length / 30)))
            : 1
          : pockets
            ? 2 + Math.floor(zone.density * 5)
            : grounds.length
              ? 1 + Math.floor(zone.density * 2)
              : styled || reference
                ? 2 +
                  Math.floor(
                    ((zone.density + 0.55) * repetition * blocks.length) / Math.max(10, share),
                  )
                : 1 + Math.floor((zone.density * repeats * blocks.length) / zone.distinctActors);
      const count =
        automatic && !pockets ? Math.min(repetitions, natural ? (canopy ? 4 : 3) : 2) : repetitions;
      let placed = 0;
      for (let i = 0; i < 256 && placed < count; i++) {
        const ordinal = i + candidateIndex * 263;
        const noise = (channel: number) => (1 + valueNoise(ordinal, channel, zone.decorSeed)) / 2;
        const block = blocks[Math.min(blocks.length - 1, Math.floor(noise(1) * blocks.length))];
        const pocket = pockets?.[(i + candidateIndex) % pockets.length];
        const angle = noise(2) * Math.PI * 2;
        const spread = pocket ? Math.sqrt(noise(3)) * (pocket.radius - Math.min(radius, 3)) : 0;
        const interior =
          composed &&
          room &&
          radius < (room.room ? 4 : 2.3) &&
          interiorProps < interiorLimit &&
          i < 110 &&
          (!room.room || i % 3 !== 2);
        const reachX = room ? Math.max(0, room.hx - radius - 1.3) : 0;
        const reachY = room ? Math.max(0, room.hy - radius - 1.3) : 0;
        const x = pocket
          ? pocket.center.x + Math.cos(angle) * spread
          : interior
            ? room.c.x + reachX * (2 * noise(2) - 1)
            : ((block % (spec.width / 8)) + noise(2)) * 8;
        const y = pocket
          ? pocket.center.y + Math.sin(angle) * spread
          : interior
            ? room.c.y + reachY * (2 * noise(3) - 1)
            : (Math.floor(block / (spec.width / 8)) + noise(3)) * 8;
        const owner = plan.blocks[Math.floor(y / 8) * (spec.width / 8) + Math.floor(x / 8)];
        if (owner !== index && (!interior || !room.room)) continue;
        const wallDistance = room ? roomDistance(room, x, y) : Infinity;
        if (placementRole && !pocket) {
          if (natural) {
            const ridge = campaign?.features.find((feature) => feature.zone === zone.id);
            if (
              placementRole === "rock" &&
              ridge &&
              i < 180 &&
              Math.hypot(x - ridge.x, y - ridge.y) > Math.max(ridge.rx, ridge.ry) + radius + 12
            )
              continue;
            if (
              i < 124 &&
              companions.length &&
              !companions.some((p) => Math.hypot(x - p.x, y - p.y) < p.radius + radius + 8)
            )
              continue;
          } else {
            const edgeDistance = localGround
              ? -areaDistance(localGround.area, { x, y })
              : Math.min(...plan.routes.map((route) => routeEdgeDistance({ x, y }, route)));
            if (localGround && edgeDistance > radius + 15) continue;
            if (
              !localGround &&
              placementRole === "light" &&
              Number.isFinite(edgeDistance) &&
              edgeDistance > radius + 9
            )
              continue;
          }
        }
        if (composed && natural && placed > 0) {
          const grove = valueNoise(x / 21, y / 21, zone.decorSeed);
          const distance = Math.hypot(x - zone.center.x, y - zone.center.y);
          if (
            grove < (canopy ? -0.02 : -0.33) ||
            distance > Math.min(spec.width, spec.height) * 0.46
          )
            continue;
        }
        // Reserve the wall rim and gate approaches. Keep service props near their room.
        if (
          room &&
          (Math.abs(wallDistance) < radius + 1.2 ||
            (placed > 0 && composed && wallDistance > (room.room ? 9 : 17)))
        )
          continue;
        if (
          structures.chambers.some(
            (other) => other !== room && other.room && roomDistance(other, x, y) < radius + 1.2,
          ) ||
          Math.min(x, y, spec.width - x, spec.height - y) < radius + 2 ||
          plan.zones.some(
            (z) =>
              Math.hypot(x - z.center.x, y - z.center.y) < radius + (composed && !natural ? 4 : 9),
          ) ||
          plan.expansions.some((p) => Math.hypot(x - p.x, y - p.y) < radius + 10) ||
          (!pocket &&
            grounds.some((ground) => areaDistance(ground.area, { x, y }) > -radius - 1)) ||
          structures.perimeter.some((edge) => perimeterBlocks(edge, { x, y }, radius + 0.5)) ||
          structures.facility.terraces.some((t) => {
            const distance = areaDistance(t.area, { x, y });
            return (
              distance > -radius - 3 &&
              (!pocket ||
                distance < radius + 1.5 ||
                t.stairs.some((stair) => onFacilityStair(stair, { x, y }, radius)))
            );
          }) ||
          structures.facility.spaces.some(
            (space) => facilitySpaceDistance(space, { x, y }) > -radius - 0.5,
          ) ||
          structures.facility.passages.some(
            (pass) => facilityPassageDistance(pass, { x, y }) < radius + 0.5,
          ) ||
          plan.routes.some((r) => routeEdgeDistance({ x, y }, r) < radius + 1) ||
          used.some((p) => Math.hypot(x - p.x, y - p.y) < p.radius + radius)
        )
          continue;
        const sample = surface.heights.sample({ x, y });
        if (sample.slope > 0.34 || riverDepth(x, y, structures) > 0.1) continue;
        if (
          (styled || reference) &&
          [
            [radius, 0],
            [-radius, 0],
            [0, radius],
            [0, -radius],
          ].some(
            ([dx, dy]) =>
              Math.abs(surface.heights.sample({ x: x + dx, y: y + dy }).height - sample.height) >
              0.8,
          )
        )
          continue;
        if (styled && role === "landmark" && i < 160) {
          const cliff = campaign?.features.find((f) => f.zone === zone.id);
          if (cliff && Math.hypot(x - cliff.x, y - cliff.y) > Math.max(cliff.rx, cliff.ry) + 12)
            continue;
        }
        const positions = [{ x, y }];
        if (mirror >= 0) {
          const reflected = { x: spec.width - x, y: spec.height - y };
          if (
            Math.hypot(x - reflected.x, y - reflected.y) < 2 * radius ||
            riverDepth(reflected.x, reflected.y, structures) > 0.1
          )
            continue;
          positions.push(reflected);
        }
        for (const [side, position] of positions.entries()) {
          placements.push({
            kind: "Doodad",
            catalogId: model.actor.id,
            variation: model.variation ?? 0,
            flags: { HeightAbsolute: "1" },
            position: { ...position, z: surface.heights.sample(position).height },
            rotation:
              ((composed && !natural ? Math.floor(noise(4) * 4) / 4 : noise(4)) * Math.PI * 2 +
                side * Math.PI) %
              (Math.PI * 2),
            ...(scale === 1 ? {} : { scale: { x: scale, y: scale, z: scale } }),
          });
          used.push({ ...position, radius });
        }
        if (placementRole) placedInZone.push({ x, y, radius, role: placementRole });
        if (interior) interiorProps++;
        placed++;
        actors.add(model.actor.id);
        scenicTypes.add(model.actor.id);
        if (evidence && scenicActor(evidence, model.actor.id)) qualifying.add(model.actor.id);
      }
      return placed > 0;
    };
    for (const rule of styled?.roles ?? []) {
      if (zone.composition && rule.role === "landmark" && zone.landmark) {
        requiredDecor.push({ zone: zone.id, role: rule.label, actor: zone.landmark.actor });
        continue;
      }
      const edge = structures.edges.find(
        (entry) =>
          entry.zone === zone.id &&
          rule.actors.includes(entry.actor) &&
          scenicTypes.has(entry.actor),
      );
      if (edge && rule.role === "support") {
        requiredDecor.push({ zone: zone.id, role: rule.label, actor: edge.actor });
        continue;
      }
      const cargo = rule.actors.find((id) => placedCargo.has(id) && !existingRole.has(id));
      if (cargo) {
        requiredDecor.push({ zone: zone.id, role: rule.label, actor: cargo });
        existingRole.add(cargo);
        continue;
      }
      const candidatesBySeed = [...rule.actors].sort(
        (a, b) => seedFor(zone.decorSeed, a) - seedFor(zone.decorSeed, b),
      );
      let found = false;
      for (const id of candidatesBySeed) {
        if (!edgeActors.has(id) && !existingRole.has(id) && (await place(id, rule.role))) {
          requiredDecor.push({ zone: zone.id, role: rule.label, actor: id });
          existingRole.add(id);
          found = true;
          break;
        }
      }
      if (!found)
        throw Error(
          "WORLD_REQUIRED_DECOR_UNAVAILABLE: " +
            zone.id +
            "/" +
            rule.label +
            " " +
            rule.actors.join(", "),
        );
    }
    let candidateCursor = 0;
    for (; candidateCursor < candidates.length; candidateCursor++) {
      const id = candidates[candidateCursor];
      if (
        styled || reference
          ? types.size - before >= share && actors.size >= zone.distinctActors
          : actors.size >= zone.distinctActors
      )
        break;
      if (
        edgeActors.has(id) ||
        ((styled || reference) && types.has(id) && actors.size >= zone.distinctActors)
      )
        continue;
      await place(id);
    }
    if (reference && coverage)
      backfill.push(async () => {
        for (
          ;
          candidateCursor < candidates.length && qualifying.size < coverage.minimum;
          candidateCursor++
        ) {
          const id = candidates[candidateCursor];
          if (!qualifying.has(id) && !edgeActors.has(id)) await place(id);
        }
      });
    if (actors.size < zone.distinctActors)
      throw Error(
        "WORLD_DECOR_QUOTA: " +
          JSON.stringify({
            zone: zone.id,
            requested: zone.distinctActors,
            placed: [...actors],
            candidates: candidates.length,
            failures: failures.slice(0, 3),
          }),
      );
  }
  for (const fill of backfill) await fill();
  const qualifyingByRole: Record<string, number> = {};
  for (const id of qualifying) {
    const role = evidence!.actors[id]!.role;
    qualifyingByRole[role] = 1 + (qualifyingByRole[role] ?? 0);
  }
  return {
    placements,
    scenicTypes: [...scenicTypes],
    requiredDecor,
    qualifyingTypes: [...qualifying],
    qualifyingByRole,
  };
}
