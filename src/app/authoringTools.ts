import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Project } from "./project.js";
import {
  organizeProject,
  projectOrganizationSchema,
  checkProjectOrganization,
} from "./projectOrganization.js";
import { StyleCatalog, catalogQuerySchema } from "../modules/placement/styleCatalog.js";
import {
  CompositionWorkspace,
  compositionSchema,
  stylePlanSchema,
} from "../modules/placement/compositions.js";
import { projectPreflight } from "./preflight.js";
import { promises as fs } from "node:fs";
import {
  DecorPalette,
  decorMeasureSchema,
  decorPaletteSchema,
} from "../modules/placement/decorPalette.js";
import { DecorPrefabs, prefabSchema, assembleSchema } from "../modules/placement/decorPrefabs.js";
import { siteSchema, siteZone } from "../modules/placement/sitePlanner.js";
import { sceneSchema, designScene } from "../modules/placement/scenePlanner.js";
import { scenePng, sceneSurfaceReview } from "../modules/placement/sceneReview.js";
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
export function registerAuthoringTools(
  server: McpServer,
  project: Project,
  enabled: { script: boolean; terrain: boolean },
) {
  if (enabled.script) {
    server.registerTool(
      "project.organize",
      {
        description:
          "Organize a project by genre. Default target=gui creates native editor categories and preserves executable logic. Explicit target=galaxy retains legacy script scaffolding and its ownership manifest. Dry-run by default; save the complete draft group using modkit.save.",
        inputSchema: projectOrganizationSchema,
      },
      async (a) => result(await organizeProject(project.workspace, project.trigger, a)),
    );
    server.registerTool(
      "project.check",
      {
        description:
          "Check project organization and existing offline module preflight. Does not certify visuals or SC2 runtime.",
        inputSchema: z
          .object({ scope: z.enum(["organization", "all"]).default("organization") })
          .strict(),
      },
      async (a) => {
        const organization = await checkProjectOrganization(project.workspace),
          modules = a.scope === "all" ? await projectPreflight(project) : undefined;
        return result({
          valid: organization.status === "pass" && (!modules || modules.readyForEditorTest),
          organization,
          modules,
        });
      },
    );
  }
  if (enabled.terrain) {
    const catalog = new StyleCatalog(),
      compositions = new CompositionWorkspace(
        project.workspace,
        project.placement,
        project.browse,
        project.terrain,
        catalog,
      );
    const palette = new DecorPalette(project.browse, project.assets.measurements, catalog),
      prefabs = new DecorPrefabs(palette);
    const visual = async (work: () => Promise<{ pngFile?: string }>, includeImage: boolean) => {
      try {
        const value = await work();
        return {
          content: [
            ...result(value).content,
            ...(includeImage && value.pngFile
              ? [
                  {
                    type: "image" as const,
                    mimeType: "image/png",
                    data: (await fs.readFile(value.pngFile)).toString("base64"),
                  },
                ]
              : []),
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
            },
          ],
        };
      }
    };
    server.registerTool(
      "terrain.measure",
      {
        description:
          "Model passport: resolve exact target Actor -> Model -> CASC M3, scales, pivot/bottom, bind attachments and three geometry images. Defaults to placeable Doodads. representation=Actor also measures declared Unit/effect Actors without making them placeable Doodads. objectId still measures a placed doodad. Rest geometry does not certify animation, presentation, collision or a building footprint. Ambiguities return diagnostics.",
        inputSchema: decorMeasureSchema,
      },
      async (a) => visual(() => palette.measure(a), a.includeImage),
    );
    server.registerTool(
      "terrain.palette_preview",
      {
        description:
          "Visual page of the EXISTING terrain.catalog tileset palette. 1–12 doodads at shared scale, ruler, grid, dimensions and optional raw Marine comparison. Exact target IDs, missing assets and variations reported; geometry only. PNG image block by default, includeImage=false for compact metadata.",
        inputSchema: decorPaletteSchema,
      },
      async (a) => visual(() => palette.palette(a), a.includeImage),
    );
    server.registerTool(
      "terrain.scene.plan",
      {
        description:
          "Plan a whole outpost or woodland composition from bounds and scalar material/Actor IDs: focal group, open plaza, connected reserved routes, asymmetric measured support groups and coherent materials. Reuses two measured templates without per-group images and the existing owned Terrain transaction; preserves heights by default. Optional topology uses the existing qualified cliff/ramp writer. Density controls group count, never shrinks models or silently drops groups. preview=false skips the single schematic PNG. Returns the usual plan ID for apply/save, sampling diagnostics and native review viewpoints. No automatic art score or engine-pathing verdict; stale/manual changes remain guarded.",
        inputSchema: sceneSchema,
      },
      async (args) =>
        result(
          await project.workspace.withReadSet(() =>
            project.browse.withSnapshot(async () => {
              const design = await designScene(
                  args,
                  prefabs,
                  args.topology ? undefined : await project.terrain.surface(),
                ),
                plan = await project.terrain.ownedLandscape(design.intent),
                ground = sceneSurfaceReview(design, await project.terrain.state("", plan.id)),
                image = args.preview
                  ? await project.assets.measurements.writeDerived(
                      {
                        scene: "composition-v1",
                        args,
                        boxes: design.boxes,
                        routes: design.routes,
                        plaza: design.plaza,
                      },
                      "png",
                      () => scenePng(design),
                    )
                  : undefined;
              return {
                ...plan,
                ...(image ? { pngFile: image.file } : {}),
                scene: {
                  profile: args.profile,
                  zone: args.zone,
                  metrics: design.metrics,
                  groups: design.groups,
                  routes: design.routes,
                  plaza: design.plaza,
                  selection: design.selection,
                  surface: ground,
                  review: design.review,
                  performance: {
                    ...design.performance,
                    schematicCacheHit: image?.cacheHit ?? null,
                  },
                },
              };
            }),
          ),
        ),
    );
    server.registerTool(
      "terrain.site.plan",
      {
        description:
          "Plan a finished checkpoint or forest_clearing using measured asymmetric anchors, secondary groups, a reserved road and coordinated floor/accent textures. Scalar slots and textures replace member JSON. Extends the existing owned landscape transaction: terrain + Objects + ownership; manual changes and stale sources reject, height is preserved. Returns the usual terrain plan ID for apply/save and geometry previews. Native appearance, pathing and balance remain separate checks.",
        inputSchema: siteSchema,
      },
      async (args) =>
        result(
          await project.workspace.withReadSet(() =>
            project.browse.withSnapshot(async () => {
              const prefab = await prefabs.plan(
                prefabSchema.parse(
                  Object.fromEntries(
                    Object.entries(args).filter(([key]) => key in prefabSchema.shape),
                  ),
                ),
              );
              const zone = siteZone(args, prefab),
                plan = await project.terrain.ownedLandscape({ zones: [zone] });
              return {
                ...plan,
                site: {
                  zone: args.zone,
                  recipe: args.recipe,
                  purpose: zone.purpose,
                  memberCount: prefab.members.length,
                  reservedWorld: prefab.reservedWorld,
                  baseTexture: args.baseTexture,
                  pathTexture: args.pathTexture,
                  accentTexture: args.accentTexture,
                  slots: prefab.slots,
                  pngFile: prefab.pngFile,
                  topPngFile: prefab.topPngFile,
                  visualAcceptance: "not_checked",
                },
              };
            }),
          ),
        ),
    );
    server.registerTool(
      "terrain.prefab",
      {
        description:
          "Preview a measured base_entrance, service_yard, landing_pad, forest_edge, woodland_cluster, supply_cluster, checkpoint or forest_clearing. Asymmetric groups reserve an open corridor. Optional fence/light/prop/secondaryProp/tree IDs override target-verified candidates. Returns top/isometric PNGs, reserved corridor, geometric fence joins and composeArgs. terrain.site.plan combines supported finished sites with owned materials/road. No map writes.",
        inputSchema: prefabSchema,
      },
      async (a) => visual(() => prefabs.plan(a), a.includeImage),
    );
    server.registerTool(
      "terrain.assemble",
      {
        description:
          "Reconcile a named measured prefab through the normal terrain.compose transaction. Scalar recipe/anchor/clearance/slot arguments replace member JSON. Geometry keeps the reserved path clear; target terrain/water/slope, stale sources and owned IDs are checked. Dry-run by default; save returned saveFile. Engine pathing and materials still need SC2 review.",
        inputSchema: assembleSchema,
      },
      async (a) =>
        visual(
          () =>
            project.workspace.withReadSet(() =>
              project.browse.withSnapshot(async () => {
                const plan = await prefabs.plan(
                    prefabSchema.parse(
                      Object.fromEntries(
                        Object.entries(a).filter(([k]) => k in prefabSchema.shape),
                      ),
                    ),
                  ),
                  placed = await compositions.compose({
                    ...plan.composeArgs,
                    zone: a.zone,
                    maxSlope: a.maxSlope,
                    directory: a.directory,
                    dryRun: a.dryRun,
                    stage: a.stage,
                  });
                return {
                  ...placed,
                  pngFile: plan.pngFile,
                  topPngFile: plan.topPngFile,
                  reservedLocal: plan.reservedLocal,
                  reservedWorld: plan.reservedWorld,
                  prefab: a.recipe,
                  clearance: a.clearance,
                };
              }),
            ),
          a.includeImage,
        ),
    );
    server.registerTool(
      "terrain.catalog",
      {
        description:
          "Bounded reference lookup by tileset, section, query and style. Exact Actor, Model and native TerrainObject namespaces remain separate. Source observations and density hints are not target-map validation.",
        inputSchema: catalogQuerySchema,
        annotations: { readOnlyHint: true },
      },
      async (a) => result(await catalog.query(a)),
    );
    server.registerTool(
      "terrain.style",
      {
        description:
          "Inspect one style and bounded target-checked Actor shortlist. Optional condition excludes source-name wreckage hints for operational/abandoned defaults and includes curated utility roles; hints do not certify engine state. Returns composition guidance and review criteria. Read-only.",
        inputSchema: stylePlanSchema,
        annotations: { readOnlyHint: true },
      },
      async (a) => result(await compositions.style(a)),
    );
    server.registerTool(
      "terrain.compose",
      {
        description:
          "Plan or reconcile a named terrain composition. Forest/natural recipes use verified Actor scatter with terrain and reserved-path constraints. Constructed/ruin recipes require measured explicit anchor-relative members. Seed and owned object fingerprints prevent duplicates and overwriting manual edits. Dry-run by default; save complete group using returned saveFile.",
        inputSchema: compositionSchema,
      },
      async (a) => result(await compositions.compose(a)),
    );
  }
}
