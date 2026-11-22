import { createFlatTerrain, type TerrainSet } from "../document/codecs/flatTerrainFactory.js";
import { parseState } from "../terrain/operations.js";
import { riverDepth, roomDistance, shorelineWeight, structureLayout } from "./structures.js";
import { areaDistance, valueNoise } from "../terrain/geometry.js";
import { editNativeGeometry } from "../terrain/nativeGeometry.js";
import type { CampaignLandscape } from "./missionLandscape.js";
import { facilityPassageDistance, facilitySpaceDistance } from "./facility.js";
import { routeEdgeDistance, smoothstep, type WorldSpec, type WorldLayout } from "./plan.js";

export function compileWorldSurface(
  spec: WorldSpec,
  plan: WorldLayout,
  sets: TerrainSet[],
  campaign?: CampaignLandscape,
  structures = structureLayout(spec, plan),
) {
  if (
    sets.length !== plan.sets.length ||
    sets.some((s, i) => s.id !== plan.sets[i] || s.generic || s.unsupported?.length)
  )
    throw Error("WORLD_UNRESOLVED_PALETTE");
  const { width, height } = spec;
  const facilityMaterials = (bank: number, floor: string, trim: string | undefined) => {
    const floorSlot = sets[bank].textures.indexOf(floor);
    const trimSlot = trim ? sets[bank].textures.indexOf(trim) : floorSlot;
    if (floorSlot < 0 || trimSlot < 0)
      throw Error("WORLD_FACILITY_MATERIAL_UNAVAILABLE: " + (floorSlot < 0 ? floor : trim));
    return { floorSlot, trimSlot };
  };
  const facilitySpaces = structures.facility.spaces.map((space) => ({
    space,
    ...facilityMaterials(space.bank, space.floor, space.trim),
    inlays: space.inlays.map(({ min, max, floor }) => ({
      area: { type: "rectangle" as const, minX: min.x, minY: min.y, maxX: max.x, maxY: max.y },
      slot: facilityMaterials(space.bank, floor, undefined).floorSlot,
    })),
  }));
  const facilityPassages = structures.facility.passages.map((pass) => ({
    pass,
    ...facilityMaterials(pass.bank, pass.floor, pass.trim),
  }));
  const facilityGrounds = structures.facility.grounds.map((ground) => ({
    ...ground,
    ...facilityMaterials(ground.bank, ground.floor, ground.trim),
    exteriorSlot: facilityMaterials(ground.bank, ground.exterior, undefined).floorSlot,
  }));
  const terraceMaterials = structures.facility.terraces.flatMap((terrace) =>
    terrace.floor
      ? [{ ...terrace, slot: facilityMaterials(terrace.bank, terrace.floor, undefined).floorSlot }]
      : [],
  );
  const blocks = plan.blocks.map((zone) => plan.zones[zone].bank);
  const mainSet = campaign ? { ...sets[0], cliffs: campaign.cliffSets } : sets[0];
  const files = createFlatTerrain(width, height, mainSet, sets[0].textures[0], 4, { sets, blocks });
  const state = parseState(files);
  const masks = state.masks!,
    sync = state.syncTextures!;
  const paletteRoles = plan.zones.map((zone, i) => {
    const textures = sets[zone.bank].textures;
    const slot = (id: string) => {
      const n = textures.indexOf(id);
      if (n < 0) throw Error("WORLD_MATERIAL_UNAVAILABLE: " + zone.id + "/" + id);
      return n;
    };
    const styled = campaign?.zones[i];
    const preferred = styled?.materials ?? zone.materials;
    const engineering =
      styled?.style === "hard_zones" || (styled?.style !== "blend" && zone.biome === "engineered");
    const accents = styled?.materials.accent.map(slot) ?? [];
    const mixed = styled?.style === "mixed";
    const slots = preferred?.scatter?.map(slot) ?? textures.map((_, i) => i);
    if (preferred?.ground) {
      const base = slot(preferred.ground);
      return {
        base,
        slots,
        engineering,
        featheredForest: styled?.profile === "forest" && zone.biome === "natural",
        mixed,
        accents,
        roadEdge: zone.materials?.roadEdge ? slot(zone.materials.roadEdge) : undefined,
        road: slot(preferred.road ?? textures[Math.min(1, textures.length - 1)]),
        trim: slot(preferred.trim ?? textures.at(-1)!),
      };
    }
    return {
      base: undefined,
      slots,
      engineering,
      mixed,
      accents,
      roadEdge: zone.materials?.roadEdge ? slot(zone.materials.roadEdge) : undefined,
      road: slot(preferred?.road ?? textures[Math.min(1, textures.length - 1)]),
      trim: slot(preferred?.trim ?? textures.at(-1)!),
    };
  });
  const shorelines = structures.crossings.filter((b) => b.route.shoreline);
  const shoreSlots = shorelines.map((b) =>
    plan.zones.map((zone) => {
      const styles = b.route.shoreline!;
      const id = zone.biome === "natural" ? styles.naturalRock : styles.builtRock;
      const slot = sets[zone.bank].textures.indexOf(id);
      if (
        slot < 0 &&
        plan.blocks.some(
          (owner, block) =>
            plan.zones[owner] === zone &&
            shorelineWeight(
              b,
              ((block % (width / 8)) + 0.5) * 8,
              (Math.floor(block / (width / 8)) + 0.5) * 8,
            ) > 0,
        )
      )
        throw Error("WORLD_SHORE_MATERIAL_UNAVAILABLE: " + zone.id + "/" + id);
      return slot;
    }),
  );
  const used = new Set<string>();
  const zoneAt = (x: number, y: number) =>
    plan.zones[
      plan.blocks[
        (Math.min(height / 8 - 1, Math.floor(y / 8)) * width) / 8 +
          Math.min(width / 8 - 1, Math.floor(x / 8))
      ]
    ];
  function distanceToRoad(x: number, y: number) {
    let distance = Infinity;
    for (const route of plan.routes)
      distance = Math.min(distance, routeEdgeDistance({ x, y }, route));
    return distance;
  }
  for (let y = 0; y <= height; y++)
    for (let x = 0; x <= width; x++) {
      const mirror =
        spec.mode === "ladder" && (y > height / 2 || (y === height / 2 && x > width / 2));
      const sx = mirror ? width - x : x,
        sy = mirror ? height - y : y;
      const zone = zoneAt(sx, sy);
      const relief =
        zone.biome === "natural" ? zone.relief * valueNoise(sx / 10, sy / 10, zone.terrainSeed) : 0;
      const road = distanceToRoad(sx, sy);
      const blend = Math.max(
        0,
        Math.min(
          1,
          road / 4,
          (Math.hypot(sx - zone.center.x, sy - zone.center.y) - 8) / 3,
          ...plan.expansions.map((p) => (Math.hypot(sx - p.x, sy - p.y) - 8) / 3),
        ),
      );
      const old = state.heights.z(x, y);
      const bankRelief = shorelines.reduce((lift, b) => {
        const weight = shorelineWeight(b, sx, sy);
        const irregular = 0.8 + 0.48 * valueNoise(sx / 6, sy / 6, b.seed);
        return (
          lift +
          weight * irregular * smoothstep(road / 3) * (zone.biome === "engineered" ? 1.35 : 0.55)
        );
      }, 0);
      state.sync!.delta(
        x,
        y,
        state.heights.setZ(x, y, 4 + relief * blend + bankRelief - riverDepth(x, y, structures)) -
          old,
      );
    }
  for (const feature of campaign?.features ?? [])
    for (const area of feature.strokes)
      editNativeGeometry(state, {
        op: "cliff.paint",
        area,
        parameters: { level: 2, cliffSet: feature.cliffSet },
      });
  for (const edge of structures.edges) {
    if (!edge.area) continue;
    const cliffSet = campaign?.zones.find((zone) => zone.id === edge.zone)?.cliffSet ?? -1;
    if (cliffSet < 0) throw Error("WORLD_EDGE_CLIFF_SET_UNAVAILABLE: " + edge.zone);
    editNativeGeometry(state, {
      op: "cliff.paint",
      area: edge.area,
      parameters: { level: 2, cliffSet },
    });
  }
  const terraces = structures.facility.terraces.map((t) => {
    const cliffSet = campaign?.zones.find((zone) => zone.id === t.zone)?.cliffSet ?? -1;
    if (cliffSet < 0) throw Error("WORLD_FACILITY_CLIFF_SET_UNAVAILABLE: " + t.id);
    editNativeGeometry(state, {
      op: "cliff.paint",
      area: t.area,
      parameters: { level: 2, cliffSet },
    });
    return { ...t, cliffSet };
  });
  for (const bank of structures.embankments) {
    const cliffSet = campaign?.zones.find((zone) => zone.id === bank.zone)?.cliffSet ?? -1;
    if (cliffSet < 0) throw Error("WORLD_EMBANKMENT_CLIFF_SET_UNAVAILABLE: " + bank.zone);
    for (const step of bank.steps)
      for (const area of [step.area, ...step.wings])
        editNativeGeometry(state, {
          op: "cliff.paint",
          area,
          parameters: { level: step.level, cliffSet },
        });
    for (const step of bank.steps)
      editNativeGeometry(state, {
        op: "ramp.create",
        parameters: {
          center: step.center,
          direction: bank.direction,
          lowerLevel: step.level - 1,
          cliffSet,
        },
      });
    if (bank.lift > 0) {
      const top = bank.steps.at(-1)!;
      const { area, center, level } = top;
      for (let y = area.minY - 4; y <= area.maxY + 4; y++)
        for (let x = area.minX - 4; x <= area.maxX + 4; x++) {
          if (x < 0 || x > width || y < 0 || y > height) continue;
          const old = state.heights.z(x, y);
          const onTerrace = (state.heights.mask(x, y) & 255) >= level;
          const along = bank.alongY ? y - center.y : x - center.x;
          const lateral = bank.alongY ? x - center.x : y - center.y;
          const onRamp = Math.abs(along) <= 2 && Math.abs(lateral) <= 2;
          const weight = onRamp
            ? Math.max(0, Math.min(1, (old - 4 - (level - 2) * 2) / 2))
            : Number(onTerrace);
          if (weight > 0)
            state.sync!.delta(x, y, state.heights.setZ(x, y, old + bank.lift * weight) - old);
        }
    }
  }
  for (const t of terraces)
    for (const stair of t.stairs)
      editNativeGeometry(state, {
        op: "ramp.create",
        parameters: {
          center: stair.center,
          direction: stair.direction,
          lowerLevel: 1,
          cliffSet: t.cliffSet,
        },
      });
  const rooms = structures.chambers.flatMap((room) => {
    if (!room.room) return [];
    const textures = sets[room.bank].textures;
    const floor = textures.indexOf(room.room.floor);
    const trim = room.room.trim ? textures.indexOf(room.room.trim) : floor;
    if (floor < 0 || trim < 0) throw Error("WORLD_ROOM_MATERIAL_UNAVAILABLE: " + room.id);
    return [{ ...room, floor, trim }];
  });
  const featureDistance = (x: number, y: number, id: string) => {
    let closest = Infinity;
    for (const f of campaign?.features ?? []) {
      if (f.zone !== id) continue;
      const distance = (Math.hypot((x - f.x) / f.rx, (y - f.y) / f.ry) - 1) * Math.min(f.rx, f.ry);
      if (Math.abs(distance) < Math.abs(closest)) closest = distance;
    }
    return closest;
  };
  const weights = new Int16Array(8);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const reflect = spec.mode === "ladder" && y >= height / 2;
      const zone = zoneAt(reflect ? width - 1 - x : x, reflect ? height - 1 - y : y),
        textures = sets[zone.bank].textures;
      const zoneIndex = plan.zones.indexOf(zone);
      const roles = paletteRoles[zoneIndex];
      const cell = { x: x + 0.5, y: y + 0.5 };
      const terraceSlot = terraceMaterials.find(
        (terrace) => terrace.bank === zone.bank && areaDistance(terrace.area, cell) >= 0,
      )?.slot;
      let groundDist = -Infinity;
      const ground = facilityGrounds.find((g) => g.bank === zone.bank);
      const localGround = facilityGrounds.reduce((closest, g) => {
        if (g.bank !== zone.bank) return closest;
        const d = areaDistance(g.area, cell);
        if (d <= groundDist) return closest;
        groundDist = d;
        return g;
      }, ground);
      const localSpaces = facilitySpaces.filter(
        (f) => f.space.bank === zone.bank && facilitySpaceDistance(f.space, cell) >= -1,
      );
      const localPasses = facilityPassages.filter(
        (p) => p.pass.bank === zone.bank && facilityPassageDistance(p.pass, cell) <= 1,
      );
      let shoreSlot = -1,
        shoreBlend = 0;
      for (const [i, bank] of shorelines.entries()) {
        const weight = shorelineWeight(bank, x + 0.5, y + 0.5);
        if (shoreSlots[i][zoneIndex] < 0 || weight <= shoreBlend) continue;
        shoreSlot = shoreSlots[i][zoneIndex];
        shoreBlend = weight;
      }
      const room = rooms.find((entry) => roomDistance(entry, x + 0.5, y + 0.5) < 0);
      const constructed = rooms.some((entry) => entry.bank === zone.bank);
      const paving = zone.composition?.pavingRadius;
      const onPad =
        room !== undefined ||
        (!zone.facility &&
          (paving !== undefined
            ? Math.max(Math.abs(x + 0.5 - zone.center.x), Math.abs(y + 0.5 - zone.center.y)) <
              paving
            : roles.engineering &&
              (!roles.mixed ||
                Math.max(Math.abs(x + 0.5 - zone.center.x), Math.abs(y + 0.5 - zone.center.y)) <
                  12)));
      const cellRoadEdge = distanceToRoad(x + 0.5, y + 0.5);
      const refineEdge =
        roles.base !== undefined &&
        (roles.featheredForest
          ? Math.abs(cellRoadEdge) < 6
          : cellRoadEdge > -0.75 && cellRoadEdge < 3);
      const totals = new Uint16Array(8);
      const ridgeEdge = roles.accents.length
        ? featureDistance(x + 0.5, y + 0.5, zone.id)
        : Infinity;
      for (let dy = 0; dy < 8; dy++)
        for (let dx = 0; dx < 8; dx++) {
          const rawX = x + (dx + 0.5) / 8,
            rawY = y + (dy + 0.5) / 8;
          const px = reflect ? width - rawX : rawX,
            py = reflect ? height - rawY : rawY;
          const roadEdge = refineEdge ? distanceToRoad(rawX, rawY) : cellRoadEdge;
          const point = { x: rawX, y: rawY };
          let facilitySpace: (typeof localSpaces)[number] | undefined;
          let padEdge = Infinity;
          for (const candidate of localSpaces) {
            const edge = facilitySpaceDistance(candidate.space, point);
            if (!(edge >= 0)) continue;
            facilitySpace = candidate;
            padEdge = edge;
            break;
          }
          let facilityPass: (typeof localPasses)[number] | undefined;
          let passageEdge = Infinity;
          for (const candidate of localPasses) {
            const edge = facilityPassageDistance(candidate.pass, point);
            if (!(edge <= 0)) continue;
            facilityPass = candidate;
            passageEdge = edge;
            break;
          }
          const border = facilitySpace?.space.role === "landing" ? 1.25 : 0.75;
          let inlaySlot: number | undefined;
          if (facilitySpace) {
            for (const { area, slot } of facilitySpace.inlays) {
              if (!(areaDistance(area, point) >= 0)) continue;
              inlaySlot = slot;
              break;
            }
          }
          const facilitySlot =
            inlaySlot ??
            (facilitySpace && padEdge <= border
              ? facilitySpace.trimSlot
              : facilitySpace?.floorSlot);
          if (facilityPass || (facilitySpace && !facilitySpace.space.blend)) {
            const slot = facilityPass
              ? passageEdge >= -0.62
                ? facilityPass.trimSlot
                : facilityPass.floorSlot
              : facilitySlot!;
            weights.fill(0);
            weights[slot] = 15;
            masks.setQuantizedWeights(x * 8 + dx, y * 8 + dy, weights);
            totals[slot] += 15;
            continue;
          }
          let index: number,
            mix = 0,
            next: number | undefined;
          if (room) {
            index = roomDistance(room, rawX, rawY) >= -1 ? room.trim : room.floor;
          } else if (terraceSlot !== undefined) {
            index = terraceSlot;
          } else if (localGround) {
            const yardEdge = areaDistance(localGround.area, point);
            index =
              roadEdge <= 0
                ? roles.road
                : yardEdge < 0
                  ? localGround.exteriorSlot
                  : yardEdge < 0.95
                    ? localGround.trimSlot
                    : localGround.floorSlot;
          } else if (roles.featheredForest && roles.base !== undefined && !facilitySpace) {
            paintForestTexel(
              masks,
              totals,
              weights,
              x * 8 + dx,
              y * 8 + dy,
              px,
              py,
              roadEdge,
              roles.base,
              roles.slots,
              roles.road,
              zone.terrainSeed,
              shoreSlot,
              shoreBlend * (0.78 + 0.18 * valueNoise(px / 4, py / 4, zone.terrainSeed + 4)),
            );
            continue;
          } else if (roadEdge <= 0 && (!zone.composition || onPad))
            index = onPad && roadEdge >= -0.56 ? (roles.roadEdge ?? roles.road) : roles.road;
          else if (constructed && onPad) index = roles.base ?? roles.slots[0];
          else if (onPad) {
            const panelWidth = 5 + ((zone.terrainSeed >>> 0) % 4);
            const panelHeight = 6 + ((zone.terrainSeed >>> 4) % 4);
            const u = px - zone.center.x + width,
              v = py - zone.center.y + height;
            const seam = u % panelWidth < 0.25 || v % panelHeight < 0.25;
            const panelX = Math.floor(u / panelWidth),
              panelY = Math.floor(v / panelHeight);
            const accent = roles.slots[(panelX + 3 * panelY) % roles.slots.length];
            index =
              roles.base !== undefined
                ? seam
                  ? roles.trim
                  : valueNoise(panelX / 2, panelY / 2, zone.terrainSeed) > 0.3
                    ? accent
                    : roles.base
                : seam
                  ? roles.trim
                  : accent;
          } else if (roles.base !== undefined) {
            const broad = valueNoise(px / 13, py / 13, zone.terrainSeed);
            const detail = valueNoise(px / 3, py / 3, zone.terrainSeed + 1);
            const field = (broad + 1) * 0.5 * roles.slots.length;
            index = roles.base;
            next = roles.slots[Math.min(roles.slots.length - 1, Math.floor(field))];
            mix = Math.round(
              15 * Math.min(0.7, Math.max(0, 0.27 + Math.abs(broad) * 0.47 + detail * 0.19)),
            );
          } else {
            const field =
              (valueNoise(px / 6, py / 6, zone.terrainSeed) + 1) * 0.5 * (roles.slots.length - 1);
            const layer = Math.floor(field);
            index = roles.slots[layer];
            next = roles.slots[Math.min(layer + 1, roles.slots.length - 1)];
            mix = Math.round((field - layer) * 15);
          }
          if (
            !onPad &&
            roles.accents.length &&
            ridgeEdge >= 0 &&
            ridgeEdge < 5 &&
            roadEdge > 2.25
          ) {
            const heat = valueNoise(px / 5, py / 5, zone.terrainSeed + 30);
            if (heat > 0.07) {
              next =
                roles.accents[
                  Math.min(roles.accents.length - 1, Math.floor(heat * roles.accents.length))
                ];
              mix = Math.round(12 * Math.min(1, (1 - ridgeEdge / 5) * (0.55 + heat)));
            }
          }
          if (
            roles.base !== undefined &&
            !onPad &&
            roadEdge > 0 &&
            roadEdge < 2.25 &&
            !zone.composition
          ) {
            const edgeNoise = valueNoise(px / 2.8, py / 2.8, zone.terrainSeed);
            next = roles.road;
            mix = Math.round(
              15 * Math.min(0.95, Math.max(0, 1 - roadEdge / 2.25 + 0.18 * edgeNoise)),
            );
          }
          if (zone.composition && !onPad && roadEdge < 2.2) {
            next = roles.road;
            mix = Math.round(Math.max(mix * 0.45, 9 * smoothstep((2.2 - roadEdge) / 3)));
          }
          next ??= index;
          const facilityWeight = facilitySpace
            ? Math.round(15 * smoothstep(padEdge / facilitySpace.space.blend))
            : 0;
          const shoreWeight = shoreSlot < 0 || onPad ? 0 : Math.round(15 * shoreBlend);
          const blendedShore = Math.round((shoreWeight * (15 - facilityWeight)) / 15);
          const remaining = 15 - blendedShore - facilityWeight;
          const accentWeight = Math.round((remaining * mix) / 15);
          for (let l = 0; l < 8; l++) {
            const weight =
              (l === index ? remaining - accentWeight : 0) +
              (l === next ? accentWeight : 0) +
              (l === shoreSlot ? blendedShore : 0) +
              (l === facilitySlot ? facilityWeight : 0);
            weights[l] = weight;
            totals[l] += weight;
          }
          masks.setQuantizedWeights(x * 8 + dx, y * 8 + dy, weights);
        }
      const dominant = totals.indexOf(Math.max(...totals));
      sync.set(x, y, zone.bank * 8 + dominant);
      textures.forEach((id, layer) => {
        if (totals[layer]) used.add(id);
      });
    }
  return { files, paintedTextures: [...used].sort() };
}

function paintForestTexel(
  masks: NonNullable<ReturnType<typeof parseState>["masks"]>,
  totals: Uint16Array,
  weights: Int16Array,
  tx: number,
  ty: number,
  x: number,
  y: number,
  roadEdge: number,
  base: number,
  scatter: number[],
  road: number,
  seed: number,
  shoreSlot: number,
  shoreBlend: number,
) {
  const broad = valueNoise(x / 17, y / 17, seed);
  const detail = valueNoise(x / 6, y / 6, seed + 1);
  const field = (1 + broad * 0.78 + detail * 0.22) * 0.5 * (scatter.length - 1);
  const slot = Math.floor(field);
  const edgeNoise = valueNoise(x / 6, y / 6, seed + 2);
  const t = Math.max(0, Math.min(1, (roadEdge + 1.25 + 0.75 * edgeNoise) / 6));
  const rockWeight = shoreSlot < 0 ? 0 : Math.round(15 * shoreBlend);
  const trailWeight = Math.round((15 - rockWeight) * (1 - t * t * (3 - 2 * t)));
  const grassWeight = 15 - rockWeight - trailWeight;
  const scatterWeight = Math.round(grassWeight * (0.32 + 0.12 * broad + 0.12 * detail));
  const adjacentWeight = Math.round(scatterWeight * (field - slot));
  const a = scatter[slot],
    b = scatter[Math.min(slot + 1, scatter.length - 1)];
  for (let l = 0; l < 8; l++) {
    const weight =
      (l === road ? trailWeight : 0) +
      (l === shoreSlot ? rockWeight : 0) +
      (l === base ? grassWeight - scatterWeight : 0) +
      (l === a ? scatterWeight - adjacentWeight : 0) +
      (l === b ? adjacentWeight : 0);
    weights[l] = weight;
    totals[l] += weight;
  }
  masks.setQuantizedWeights(tx, ty, weights);
}
