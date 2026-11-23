import { promises as fs } from "node:fs";
import { projectPath } from "../../app/paths.js";
import type { TerrainSet } from "../document/codecs/flatTerrainFactory.js";
import { areaDistance, valueNoise } from "../terrain/geometry.js";
import type { TerrainArea } from "../terrain/types.js";
import { routeEdgeDistance, seedFor, type WorldLayout, type WorldSpec } from "./plan.js";
import { roomDistance, structureLayout } from "./structures.js";
import { facilityPassageDistance, facilitySpaceDistance } from "./facility.js";

type PaintMode = "blend" | "hard_zones" | "mixed" | "by_intent";
type CliffShape = "ellipse" | "volcanic" | "ridge" | "terrace" | "scarp" | "none";
type SpatialStyle = "streets" | "groves" | "temple" | "citadel" | "annex";
export interface DecorRole {
  role: string;
  label: string;
  actors: string[];
}
interface StyleEntry {
  profile: string;
  spatial?: SpatialStyle;
  cliffSet?: string;
  roles: DecorRole[];
  actors: string[];
  preferredActors?: string[];
  candidatePrefixes?: string[];
  materials: Partial<Record<"ground" | "path" | "floor" | "accent" | "scatter", string[]>>;
}
interface StyleCatalog {
  profiles: Record<string, { paint: PaintMode; cliff: CliffShape; tags: string[] }>;
  tilesets: Record<string, StyleEntry>;
}
type CliffStroke = Extract<TerrainArea, { type: "rectangle" }>;

export function campaignLandscapeEnabled(spec: WorldSpec) {
  return (
    spec.mode === "mission" &&
    (spec.landscape === "campaign" ||
      (spec.landscape === undefined &&
        spec.width >= 128 &&
        spec.width <= 160 &&
        spec.height >= 128 &&
        spec.height <= 160 &&
        spec.zones.every((zone) => !zone.actors.length && zone.distinctActors === 0)))
  );
}

export function planCampaignLandscape(
  spec: WorldSpec,
  layout: WorldLayout,
  terrainSets: TerrainSet[],
  catalog: StyleCatalog,
  structures = structureLayout(spec, layout),
) {
  const cliffSets = [...new Set(terrainSets.flatMap((s) => s.cliffs))];
  const zones = layout.zones.map((zone) => {
    const base = catalog.tilesets[zone.tileSet];
    const profile = zone.style ?? base?.profile;
    if (!profile || !catalog.profiles[profile])
      throw Error("WORLD_CAMPAIGN_STYLE_UNAVAILABLE: " + zone.tileSet);
    const preset = catalog.profiles[profile];
    const use =
      profile === base?.profile
        ? base
        : Object.values(catalog.tilesets).find((x) => x.profile === profile);
    const set = terrainSets[zone.bank];
    const isHard =
      preset.paint === "hard_zones" ||
      (preset.paint === "by_intent" && zone.biome === "engineered");
    const usable = (ids: string[] = []) => ids.filter((id) => set.textures.includes(id));
    const materials = zone.materials;
    const preferred = base?.materials;
    const ground =
      materials?.ground ??
      usable(isHard ? preferred?.floor : preferred?.ground)[0] ??
      set.textures[0];
    const road = materials?.road ?? usable(preferred?.path)[0] ?? set.textures[1] ?? ground;
    const accent = usable(preferred?.accent);
    const knownScatter = usable(preferred?.scatter);
    const scatter =
      materials?.scatter ??
      (knownScatter.length ? knownScatter : set.textures.filter((id) => !accent.includes(id)));
    return {
      id: zone.id,
      profile,
      style: preset.paint,
      spatial: use?.spatial,
      shape: preset.cliff,
      tags: preset.tags,
      roles: use?.roles ?? [],
      actors: use?.actors ?? [],
      preferredActors: use?.preferredActors ?? [],
      candidatePrefixes: use?.candidatePrefixes ?? [],
      materials: {
        ground,
        road,
        trim: materials?.trim ?? accent[0] ?? set.textures.at(-1)!,
        scatter: scatter.length ? scatter : [ground],
        accent,
      },
      cliffSet: cliffSets.indexOf(
        set.cliffs.find((id) => id === base?.cliffSet) ??
          set.cliffs.find((id) => (isHard ? /manmade/i.test(id) : /organic/i.test(id))) ??
          set.cliffs[0],
      ),
    };
  });
  const features: {
    zone: string;
    x: number;
    y: number;
    rx: number;
    ry: number;
    shape: CliffShape;
    cliffSet: number;
    strokes: CliffStroke[];
  }[] = [];
  for (const [index, zone] of zones.entries()) {
    if (
      zone.shape === "none" ||
      zone.cliffSet < 0 ||
      (layout.zones[index].biome === "engineered" &&
        (structures.embankments.length || layout.zones[index].composition))
    )
      continue;
    const seed = seedFor(spec.seed, zone.id + "/landforms");
    const random = (n: number) => (1 + valueNoise(n, 0, seed)) / 2;
    const blocks = layout.blocks.flatMap((owner, i) => (owner === index ? [i] : []));
    const columns = spec.width / 8;
    const compact = Math.min(spec.width, spec.height) <= 80;
    const count = zone.shape === "volcanic" && blocks.length >= 80 ? 2 : 1;
    for (let slot = 0; slot < count; slot++)
      for (let attempt = 0; attempt < 90; attempt++) {
        const n = 6 * (90 * slot + attempt);
        const block = blocks[Math.min(blocks.length - 1, Math.floor(random(n) * blocks.length))];
        const x = (block % columns) * 8 + 4,
          y = Math.floor(block / columns) * 8 + 4;
        const size = (radius: number) =>
          compact ? Math.max(4, 2 * Math.floor(radius / 3)) : radius;
        const rx = size(8 + 2 * Math.floor(5 * random(n + 1)));
        const ry = size(
          zone.shape === "ridge"
            ? 6 + 2 * Math.floor(3 * random(n + 2))
            : 8 + 2 * Math.floor(4 * random(n + 2)),
        );
        const points = [];
        for (let yy = y - ry - 2; yy <= y + ry + 2; yy += 2)
          for (let xx = x - rx - 2; xx <= x + rx + 2; xx += 2) points.push({ x: xx, y: yy });
        if (
          points.some(
            (p) =>
              p.x < 4 ||
              p.x > spec.width - 4 ||
              p.y < 4 ||
              p.y > spec.height - 4 ||
              layout.blocks[Math.floor(p.y / 8) * columns + Math.floor(p.x / 8)] !== index ||
              layout.zones.some(
                (z) => Math.hypot(p.x - z.center.x, p.y - z.center.y) < (compact ? 8 : 11),
              ) ||
              layout.routes.some((r) => routeEdgeDistance(p, r) < (compact ? 3 : 5)) ||
              structures.facility.grounds.some((ground) => areaDistance(ground.area, p) >= -3) ||
              structures.facility.terraces.some((t) => areaDistance(t.area, p) >= -5) ||
              structures.facility.spaces.some((space) => facilitySpaceDistance(space, p) >= -3) ||
              structures.facility.passages.some((pass) => facilityPassageDistance(pass, p) < 3) ||
              structures.edges.some((edge) => edge.area && areaDistance(edge.area, p) >= -3) ||
              structures.chambers.some((room) => roomDistance(room, p.x, p.y) <= 3) ||
              structures.crossings.some((b) => {
                const axis = b.alongY ? p.y : p.x;
                return axis >= b.start - 4 && axis <= b.start + 12;
              }) ||
              features.some(
                (f) => Math.abs(p.x - f.x) <= f.rx + 4 && Math.abs(p.y - f.y) <= f.ry + 4,
              ),
          )
        )
          continue;
        const strokes: CliffStroke[] = [];
        if (zone.shape === "terrace") {
          strokes.push({
            type: "rectangle",
            minX: x - rx,
            maxX: x + rx,
            minY: y - ry,
            maxY: y + ry,
          });
        } else {
          for (let offset = -ry; offset < ry; offset += 2) {
            const t = (offset + 1) / ry;
            const width = Math.max(2, 2 * Math.floor((rx * Math.sqrt(1 - t * t)) / 2));
            const shift = zone.shape === "scarp" ? 2 * Math.round(0.6 * t) : 0;
            strokes.push({
              type: "rectangle",
              minX: x - width + shift,
              maxX: x + width + shift,
              minY: y + offset,
              maxY: y + offset + 2,
            });
          }
        }
        features.push({
          zone: zone.id,
          x,
          y,
          rx,
          ry,
          shape: zone.shape,
          cliffSet: zone.cliffSet,
          strokes,
        });
        break;
      }
  }
  if (
    !features.length &&
    !structures.embankments.length &&
    !structures.facility.spaces.length &&
    !structures.edges.some((edge) => edge.area) &&
    zones.some((z) => z.cliffSet >= 0 && z.shape !== "none")
  )
    throw Error(
      "WORLD_CAMPAIGN_CLIFF_CLEARANCE: no landform fits outside the protected routes and sites",
    );
  return { zones, cliffSets, features, decorBudget: spec.decorBudget ?? { min: 45, max: 65 } };
}
export type CampaignLandscape = ReturnType<typeof planCampaignLandscape>;

export async function readWorldStyles(): Promise<StyleCatalog> {
  const source = await fs.readFile(
    projectPath("resources/authoring-catalog/world-mission-styles.json"),
    "utf8",
  );
  return JSON.parse(source) as StyleCatalog;
}

export async function loadCampaignLandscape(
  spec: WorldSpec,
  layout: WorldLayout,
  sets: TerrainSet[],
  structures = structureLayout(spec, layout),
) {
  if (!campaignLandscapeEnabled(spec)) return undefined;
  return planCampaignLandscape(spec, layout, sets, await readWorldStyles(), structures);
}
