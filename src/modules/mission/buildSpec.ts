import * as z from "zod/v4";
import { dependencySchema } from "../document/schemas.js";
import { projectIdSchema } from "./spec.js";
import { gameplaySchema } from "./gameplay.js";
import { campaignStyleId } from "./campaignStyles.js";

const size = z.number().int().min(64).max(256).multipleOf(8);
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/);
const zone = z.object({ id, radius: z.number().int().min(5).max(24) }).strict();
const actor = z
  .object({
    actor: z.string().min(1).max(260),
    variation: z.number().int().min(0).max(9999).default(0),
  })
  .strict();

export const missionBuildSpecSchema = z
  .object({
    version: z.literal(2),
    mode: z.literal("create"),
    intent: z.string().trim().min(1).max(1000),
    name: z.string().trim().min(1).max(160),
    seed: z.number().int().min(0).max(2_147_483_647),
    map: z.object({ width: size, height: size }).strict(),
    dependencies: dependencySchema.default({
      mode: "standard",
      expansion: "void",
      campaign: false,
    }),
    terrain: z
      .object({
        tileSet: z.string().min(1).max(128),
        styleCampaign: campaignStyleId.optional(),
        materialsFromStyle: z.boolean().optional(),
        profile: z.enum(["wetland", "highland"]).optional(),
        landform: z.enum(["riverTerraces", "splitRidge"]).optional(),
        cliffEdge: z.enum(["natural", "engineered"]).optional(),
        bridge: z.boolean().optional(),
        lighting: z.string().trim().min(1).max(128).optional(),
        initialTexture: z.string().min(1).max(128).optional(),
        trailTexture: z.string().min(1).max(128).optional(),
        accentTexture: z.string().min(1).max(128).optional(),
        detailTexture: z.string().min(1).max(128).optional(),
        baseSurface: z
          .object({
            zone: z.enum(["start", "objective", "bonus"]),
            floorTexture: z.string().min(1).max(128).optional(),
            trimTexture: z.string().min(1).max(128).optional(),
            trimBorder: z.enum(["inner", "outer", "both"]).optional(),
          })
          .strict()
          .optional(),
        water: z
          .object({ parent: z.string().min(1).max(128) })
          .strict()
          .optional(),
      })
      .strict(),
    decor: z
      .object({
        style: z.enum(["floodedRuins", "riverShrine", "ridgeRuins"]),
        landmark: actor,
        ruins: actor,
        vegetation: actor,
      })
      .strict()
      .optional(),
    campaignDecor: z.boolean().optional(),
    decorDensity: z.enum(["standard", "lush"]).optional(),
    gameplay: gameplaySchema.optional(),
    layout: z
      .object({
        pattern: z.enum(["basinFork", "expedition", "defenseHub", "riverValley"]).optional(),
        start: zone,
        objective: zone,
        bonus: zone.optional(),
        routeWidth: z.number().int().min(4).max(16).default(6),
        variantCount: z.number().int().min(1).max(12).default(6),
      })
      .strict(),
  })
  .strict()
  .superRefine(({ layout, gameplay, terrain, decor, campaignDecor, decorDensity }, ctx) => {
    if (terrain.bridge && layout.pattern !== "riverValley")
      ctx.addIssue({
        code: "custom",
        path: ["terrain", "bridge"],
        message: "The bridge requires a river valley",
      });
    if (decorDensity && !campaignDecor)
      ctx.addIssue({
        code: "custom",
        path: ["decorDensity"],
        message: "Decor density requires campaign decor",
      });
    if (layout.pattern === "riverValley" && (terrain.profile !== "wetland" || !terrain.water))
      ctx.addIssue({
        code: "custom",
        path: ["layout", "pattern"],
        message: "A river valley requires the wetland profile and a water material",
      });
    if (campaignDecor && (!terrain.styleCampaign || layout.pattern !== "riverValley" || decor))
      ctx.addIssue({
        code: "custom",
        path: ["campaignDecor"],
        message:
          "Campaign decor requires a campaign reference and a river valley, without explicit decor",
      });
    if (terrain.cliffEdge && !terrain.landform)
      ctx.addIssue({
        code: "custom",
        path: ["terrain", "cliffEdge"],
        message: "A cliff edge requires a native landform",
      });
    if (terrain.baseSurface?.zone === "bonus" && !layout.bonus)
      ctx.addIssue({
        code: "custom",
        path: ["terrain", "baseSurface", "zone"],
        message: "A bonus base surface requires a bonus zone",
      });
    if (
      terrain.baseSurface &&
      !terrain.materialsFromStyle &&
      (!terrain.baseSurface.floorTexture || !terrain.baseSurface.trimTexture)
    )
      ctx.addIssue({
        code: "custom",
        path: ["terrain", "baseSurface"],
        message: "A base needs floor and trim textures or automatic style materials",
      });
    if (
      terrain.baseSurface?.floorTexture &&
      terrain.baseSurface.floorTexture === terrain.baseSurface.trimTexture
    )
      ctx.addIssue({
        code: "custom",
        path: ["terrain", "baseSurface", "trimTexture"],
        message: "Base trim must use a distinct texture",
      });
    if (
      terrain.landform &&
      terrain.profile !== (terrain.landform === "riverTerraces" ? "wetland" : "highland")
    )
      ctx.addIssue({
        code: "custom",
        path: ["terrain", "landform"],
        message: "The native landform requires a matching terrain profile",
      });
    if (terrain.detailTexture && !terrain.profile)
      ctx.addIssue({
        code: "custom",
        path: ["terrain", "detailTexture"],
        message: "A detail texture requires a terrain profile",
      });
    if (gameplay?.bonus && !layout.bonus)
      ctx.addIssue({
        code: "custom",
        path: ["gameplay", "bonus"],
        message: "A bonus objective requires a bonus zone",
      });
    const ids = [layout.start.id, layout.objective.id, ...(layout.bonus ? [layout.bonus.id] : [])];
    if (new Set(ids.map((id) => id.toLowerCase())).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["layout"], message: "Zone IDs must be unique" });
  });

export const missionBuildInput = z
  .object({
    projectId: projectIdSchema,
    spec: missionBuildSpecSchema,
    layoutId: z
      .string()
      .regex(/^layout_[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

export type MissionBuildSpec = z.output<typeof missionBuildSpecSchema>;
