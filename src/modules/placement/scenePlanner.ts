import * as z from "zod/v4";
import { performance } from "node:perf_hooks";
import { prefabSchema, type DecorPrefabs } from "./decorPrefabs.js";
import type { DecorModel } from "./decorPalette.js";
import { measuredMemberGeometry } from "./compositionGeometry.js";
import { checkGroupClearance } from "./groupClearance.js";
import { seededRandom } from "./planner.js";
import { measuredObjects, type MeasuredSurface } from "./measuredGroups.js";
import { exclusion } from "./locationSchemas.js";
import { landscapeZoneSchema } from "../terrain/landscapeOwnership.js";
import { nativeTopologyIntentSchema } from "../terrain/schemas.js";
import { corridorWithinArea, segmentDistance } from "../terrain/geometry.js";
import type { LocationRoute } from "./types.js";

const rect = z
  .object({
    minX: z.number().finite(),
    minY: z.number().finite(),
    maxX: z.number().finite(),
    maxY: z.number().finite(),
  })
  .strict();
export const sceneSchema = z
  .object({
    zone: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,41}$/),
    tileset: z.string().min(1).max(128),
    profile: z.enum(["outpost", "woodland"]),
    bounds: rect.refine(
      (r) => r.maxX - r.minX >= 24 && r.maxY - r.minY >= 24,
      "Scene sides must be at least 24 world units; measured groups may need more room",
    ),
    baseTexture: z.string().min(1).max(128),
    pathTexture: z.string().min(1).max(128),
    accentTexture: z.string().min(1).max(128).optional(),
    detailTexture: z.string().min(1).max(128).optional(),
    lighting: z.string().min(1).max(255).optional(),
    density: z.enum(["sparse", "standard", "rich"]).default("standard"),
    clearance: z.number().min(3).max(12).default(6),
    seed: z.number().int().default(42),
    maxSlope: z.number().min(0).max(4).default(0.5),
    exclusions: z
      .array(exclusion)
      .max(30)
      .default([])
      .refine(
        (rows) => rows.every((r) => r.type !== "rectangle" || (r.minX < r.maxX && r.minY < r.maxY)),
        "Exclusion rectangles require ordered nonempty bounds",
      ),
    topology: nativeTopologyIntentSchema.optional(),
    fence: prefabSchema.shape.fence,
    light: prefabSchema.shape.light,
    prop: prefabSchema.shape.prop,
    secondaryProp: prefabSchema.shape.secondaryProp,
    tree: prefabSchema.shape.tree,
    preview: z.boolean().default(true),
  })
  .strict();
export type SceneArgs = z.infer<typeof sceneSchema>;
type Layout = Awaited<ReturnType<DecorPrefabs["layout"]>>;
type Template = Pick<Layout["layout"], "members" | "reserved">;
type Point = { x: number; y: number };
type Rect = z.infer<typeof rect>;
const envelope = (points: Point[]): Rect => ({
  minX: Math.min(...points.map((p) => p.x)),
  minY: Math.min(...points.map((p) => p.y)),
  maxX: Math.max(...points.map((p) => p.x)),
  maxY: Math.max(...points.map((p) => p.y)),
});
const overlaps = (a: Rect, b: Rect, gap = 0) =>
  a.minX < b.maxX + gap && a.maxX > b.minX - gap && a.minY < b.maxY + gap && a.maxY > b.minY - gap;

/** Test the entire swept route, including round caps, against protected ground. */
export function routeInExclusion(
  route: LocationRoute,
  e: SceneArgs["exclusions"][number],
): boolean {
  if (e.type === "circle")
    return route.points
      .slice(1)
      .some((p, i) => segmentDistance(e.center, route.points[i], p) <= e.radius + route.width / 2);
  const bounds = envelope([...route.points, { x: e.minX, y: e.minY }, { x: e.maxX, y: e.maxY }]);
  try {
    checkGroupClearance(
      {
        position: { x: (e.minX + e.maxX) / 2, y: (e.minY + e.maxY) / 2 },
        corners: [
          { x: e.minX, y: e.minY },
          { x: e.maxX, y: e.minY },
          { x: e.minX, y: e.maxY },
          { x: e.maxX, y: e.maxY },
        ],
      },
      {
        type: "rectangle",
        minX: bounds.minX - 1,
        minY: bounds.minY - 1,
        maxX: bounds.maxX + 1,
        maxY: bounds.maxY + 1,
      },
      [route],
      [],
    );
    return false;
  } catch (error) {
    if (!String(error).includes("IN_RESERVED_ROUTE")) throw error;
    return true;
  }
}

/** Deterministic hierarchy first, bounded search second. Never shrink models to force a fit. */
export function composeScene(
  input: z.input<typeof sceneSchema>,
  focal: Template,
  support: Template,
  surface?: MeasuredSurface,
) {
  const a = sceneSchema.parse(input),
    b = a.bounds,
    width = b.maxX - b.minX,
    height = b.maxY - b.minY;
  const centerX = (b.minX + b.maxX) / 2,
    inset = a.clearance / 2 + 1,
    random = seededRandom(a.seed);
  if (width < a.clearance * 4 || height < a.clearance * 4)
    throw Error("SCENE_CLEARANCE_TOO_LARGE_FOR_BOUNDS");
  const area = { type: "rectangle" as const, ...b },
    road: LocationRoute = {
      points: [
        { x: centerX, y: b.minY + inset },
        { x: centerX, y: b.maxY - inset },
      ],
      width: a.clearance,
      texture: a.pathTexture,
      flatten: false,
      edgeBlend: 0.6,
    };
  const plaza = {
    type: "circle" as const,
    center: { x: centerX, y: b.minY + height * 0.23 },
    radius: a.clearance * 0.65,
  };
  if (a.exclusions.some((e) => routeInExclusion(road, e)))
    throw Error(
      "SCENE_MAIN_ROUTE_IN_EXCLUSION: move the scene bounds or use an explicit landscape intent for a different route",
    );
  try {
    const p = plaza.center,
      r = plaza.radius;
    checkGroupClearance(
      {
        position: p,
        corners: [
          { x: p.x - r, y: p.y - r },
          { x: p.x + r, y: p.y - r },
          { x: p.x - r, y: p.y + r },
          { x: p.x + r, y: p.y + r },
        ],
      },
      area,
      [],
      a.exclusions,
    );
  } catch (error) {
    if (!String(error).includes("IN_EXCLUSION")) throw error;
    throw Error("SCENE_PLAZA_IN_EXCLUSION: move the scene bounds or use explicit landscape zones");
  }
  if (
    a.topology?.cliffs.some((c) =>
      a.exclusions.some((e) =>
        e.type === "rectangle"
          ? overlaps(c.area, e)
          : Math.hypot(
              e.center.x - Math.max(c.area.minX, Math.min(c.area.maxX, e.center.x)),
              e.center.y - Math.max(c.area.minY, Math.min(c.area.maxY, e.center.y)),
            ) <= e.radius,
      ),
    ) ||
    (a.topology?.ramps.length && a.exclusions.length)
  )
    throw Error(
      "SCENE_TOPOLOGY_EXCLUSION_REVIEW_REQUIRED: use the existing guarded topology tools for a protected layout",
    );
  const exclusions = [...a.exclusions, plaza],
    routes = [road],
    occupied: Rect[] = [],
    roles: Array<{ id: string; role: string; bounds: Rect; members: number; anchor: Point }> = [];
  const groups: z.infer<typeof landscapeZoneSchema>["config"]["groups"] = [];
  const fit = (
    id: string,
    role: string,
    template: Template,
    candidates: Array<{ anchor: Point; angle: number }>,
    connect: boolean,
  ) => {
    let attempts = 0;
    for (const candidate of candidates) {
      attempts++;
      const group = {
        id,
        anchor: candidate.anchor,
        angle: candidate.angle,
        maxSlope: a.maxSlope,
        members: template.members,
      };
      let boxes: Rect[], branch: LocationRoute | undefined;
      if (connect) {
        const r = template.reserved[0];
        // Supply groups approach from local negative Y. Their apron stays clear.
        if (!r) throw Error("SCENE_SUPPORT_APRON_REQUIRED");
        const c = Math.cos(candidate.angle),
          s = Math.sin(candidate.angle),
          rx = (r.minX + r.maxX) / 2,
          ry = (r.minY + r.maxY) / 2;
        const endpoint = {
          x: candidate.anchor.x + c * rx - s * ry,
          y: candidate.anchor.y + s * rx + c * ry,
        };
        branch = {
          points: [{ x: centerX, y: endpoint.y }, endpoint],
          width: a.clearance,
          texture: a.pathTexture,
          flatten: false,
          edgeBlend: 0.6,
        };
        if (
          !corridorWithinArea(area, branch.points, branch.width) ||
          Math.abs(endpoint.x - centerX) < a.clearance ||
          a.exclusions.some((e) => routeInExclusion(branch!, e))
        )
          continue;
      }
      try {
        if (surface) measuredObjects(group, surface);
        const activeRoutes = branch ? [...routes, branch] : routes;
        boxes = group.members.map((m) =>
          checkGroupClearance(
            measuredMemberGeometry(group.anchor, group.angle, m),
            area,
            activeRoutes,
            exclusions,
          ),
        );
        if (boxes.some((r) => occupied.some((o) => overlaps(r, o, 0.65)))) continue;
        if (branch)
          for (const old of groups)
            for (const member of old.members)
              checkGroupClearance(
                measuredMemberGeometry(old.anchor, old.angle, member),
                area,
                [branch],
                a.exclusions,
              );
      } catch (error) {
        if (
          !/LANDSCAPE_GROUP_(OUTSIDE_ZONE|IN_RESERVED_ROUTE|IN_EXCLUSION)|COMPOSITION_MEMBER_(UNSUITABLE_GROUND|BOUNDS_UNSUITABLE_GROUND|OUTSIDE_TERRAIN)/.test(
            String(error),
          )
        )
          throw error;
        continue;
      }
      occupied.push(...boxes);
      groups.push(group);
      if (branch) routes.push(branch);
      roles.push({
        id,
        role,
        bounds: envelope(
          boxes.flatMap((r) => [
            { x: r.minX, y: r.minY },
            { x: r.maxX, y: r.maxY },
          ]),
        ),
        members: group.members.length,
        anchor: group.anchor,
      });
      return attempts;
    }
    throw Error(
      `SCENE_MEASURED_GROUP_DOES_NOT_FIT: ${id}; enlarge bounds, reduce density or choose smaller verified models. No model was scaled and no group was silently dropped.`,
    );
  };
  const focalShift = (random() - 0.5) * 0.035;
  let attempts = fit(
    "focal",
    a.profile === "outpost" ? "gate and asymmetric perimeter" : "clearing and canopy silhouette",
    focal,
    [0.58, 0.65, 0.72, 0.51, 0.79].map((y) => ({
      anchor: { x: centerX, y: b.minY + height * (y + focalShift) },
      angle: 0,
    })),
    false,
  );
  const count = { sparse: 2, standard: 4, rich: 6 }[a.density],
    handed = random() < 0.5 ? -1 : 1;
  for (let i = 0; i < count; i++) {
    const side = (i % 2 === 0 ? -1 : 1) * handed,
      desiredY = [0.28, 0.77, 0.83, 0.38, 0.55, 0.15][i];
    const angle = i % 2 === 0 ? 0 : Math.PI;
    const supportBounds = envelope(
      support.members.flatMap((m) => measuredMemberGeometry({ x: 0, y: 0 }, angle, m).corners),
    );
    const candidates: Array<{ anchor: Point; angle: number; rank: number }> = [];
    for (const x of [0.12, 0.2, 0.28, 0.35])
      for (const y of [0.12, 0.23, 0.34, 0.45, 0.56, 0.67, 0.78, 0.89]) {
        const fraction = side < 0 ? x : 1 - x,
          center = {
            x: b.minX + width * (fraction + (random() - 0.5) * 0.035),
            y: b.minY + height * (y + (random() - 0.5) * 0.035),
          };
        candidates.push({
          anchor: {
            x: center.x - (supportBounds.minX + supportBounds.maxX) / 2,
            y: center.y - (supportBounds.minY + supportBounds.maxY) / 2,
          },
          angle,
          rank: Math.abs(y - desiredY) + Math.abs(x - 0.21) * 0.4 + random() * 0.015,
        });
      }
    candidates.sort((x, y) => x.rank - y.rank);
    attempts += fit(
      `support${i + 1}`,
      a.profile === "outpost" ? "utility bay with approach apron" : "secondary forest framing",
      support,
      candidates,
      a.profile === "outpost",
    );
  }
  const patches = [a.accentTexture, a.detailTexture].flatMap((texture, i) =>
    texture
      ? [
          {
            texture,
            wavelength: Math.min(width, height) * (i ? 0.12 : 0.25),
            threshold: i ? 0.25 : -0.05,
            transition: 0.5,
            strength: i ? 0.35 : 0.55,
          },
        ]
      : [],
  );
  const zone = landscapeZoneSchema.parse({
    id: a.zone,
    purpose:
      a.profile === "outpost"
        ? "Outpost: clear approach, focal gate, asymmetric utility bays and open staging plaza"
        : "Woodland: open travel lane and clearing, staggered canopy framing and quiet gaps",
    condition: "operational",
    config: {
      locationType: a.profile === "outpost" ? "militaryBase" : "forest",
      area: { ...area, z: 0 },
      objectCount: 0,
      seed: a.seed,
      maxSlope: a.maxSlope,
      exclusionZones: exclusions,
      groups,
      terrain: {
        style: a.profile === "outpost" ? "city" : "forest",
        heightMode: "preserve",
        textureMode: "generate",
        edgeBlend: 1,
        protectedAreas: a.exclusions,
        materials: { base: a.baseTexture, ...(patches.length ? { patches } : {}) },
        routes,
        ...(a.topology ? { topology: a.topology } : {}),
      },
    },
  });
  const plazaZone = landscapeZoneSchema.parse({
    id: a.zone + "_plaza",
    dependsOn: [a.zone],
    purpose: "Open staging space, distinct material and room to read units",
    config: {
      locationType: "custom",
      area: { ...plaza, center: { ...plaza.center, z: 0 } },
      objectCount: 0,
      terrain: {
        style: "city",
        heightMode: "preserve",
        textureMode: "generate",
        edgeBlend: 1,
        materials: { base: a.pathTexture },
      },
    },
  });
  const occupiedArea = occupied.reduce((sum, r) => sum + (r.maxX - r.minX) * (r.maxY - r.minY), 0);
  return {
    args: a,
    intent: { zones: [zone, plazaZone], ...(a.lighting ? { lighting: a.lighting } : {}) },
    groups: roles,
    routes,
    plaza,
    boxes: occupied,
    metrics: {
      groups: groups.length,
      objects: occupied.length,
      materialCount: new Set(
        [a.baseTexture, a.pathTexture, a.accentTexture, a.detailTexture].filter(Boolean),
      ).size,
      measuredBoundsCoverage: occupiedArea / (width * height),
      placementCandidatesTried: attempts,
      routeClearance: a.clearance,
    },
    review: {
      visualAcceptance: "not_checked",
      engineNavigation: "not_checked",
      lighting: a.lighting
        ? `assigned ${a.lighting}; review in the target Editor`
        : "preserved; review in the target Editor",
      views: [
        {
          name: "overview",
          at: { x: centerX, y: (b.minY + b.maxY) / 2 },
          purpose: "silhouette, hierarchy, repetition and gaps",
        },
        { name: "approach", at: plaza.center, purpose: "unit readability and focal reveal" },
        {
          name: "focal",
          at: roles[0].anchor,
          purpose: "model scale, joins and material transitions",
        },
      ],
      rubric: [
        "gameplay readability",
        "large forms and silhouette",
        "material placement and transitions",
        "decor hierarchy and negative space",
        "lighting and atmosphere",
      ],
      scope:
        "Measured rest bounds and planned circulation. No beauty score, collision or engine movement verdict.",
      findings: [
        ...(occupiedArea / (width * height) < 0.04
          ? [
              {
                code: "SPARSE_MEASURED_COVERAGE",
                detail:
                  "This footprint is large relative to the selected models. Review intentional empty space; use smaller purpose-specific zones or additional designed regions instead of blindly increasing scatter.",
              },
            ]
          : []),
        ...(count > 2
          ? [
              {
                code: "REPEATED_SUPPORT_MOTIF",
                detail:
                  "Support groups share a measured motif. Review repetition at gameplay scale and refine selected owned groups where their purpose differs.",
              },
            ]
          : []),
      ],
    },
  };
}

/** Resolve each template once; repeated groups reuse measurements and create no individual PNGs. */
export async function designScene(
  input: z.input<typeof sceneSchema>,
  prefabs: Pick<DecorPrefabs, "layout">,
  surface?: MeasuredSurface,
) {
  const started = performance.now(),
    a = sceneSchema.parse(input);
  const common = {
    tileset: a.tileset,
    clearance: a.clearance,
    seed: a.seed,
    ...(a.fence ? { fence: a.fence } : {}),
    ...(a.light ? { light: a.light } : {}),
    ...(a.prop ? { prop: a.prop } : {}),
    ...(a.secondaryProp ? { secondaryProp: a.secondaryProp } : {}),
    ...(a.tree ? { tree: a.tree } : {}),
  };
  const resolved = new Map<string, Promise<DecorModel>>();
  const focal = await prefabs.layout(
    {
      ...common,
      recipe: a.profile === "outpost" ? "checkpoint" : "forest_clearing",
    },
    resolved,
  );
  const support = await prefabs.layout(
    {
      ...common,
      recipe: a.profile === "outpost" ? "supply_cluster" : "woodland_cluster",
    },
    resolved,
  );
  return {
    ...composeScene(a, focal.layout, support.layout, surface),
    selection: [...focal.slots, ...support.slots].map((s) => ({
      role: s.name,
      id: s.decor.actor.id,
      key: s.decor.actor.key,
      assetSha256: s.decor.measured.sha256,
    })),
    performance: {
      designMs: Math.round(performance.now() - started),
      templatesResolved: 2,
      perGroupImages: 0,
    },
  };
}
