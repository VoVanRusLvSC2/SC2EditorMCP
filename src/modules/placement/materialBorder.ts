import * as z from "zod/v4";
import type { TerrainWorkspace } from "../terrain/workspace.js";
import type { Point2 } from "../terrain/types.js";
import { measuredMemberGeometry } from "./compositionGeometry.js";
import type { DecorModel, DecorPalette } from "./decorPalette.js";

const coordinate = z.number().min(0).max(256);
const box = z
  .object({ minX: coordinate, minY: coordinate, maxX: coordinate, maxY: coordinate })
  .strict()
  .refine(
    (a) => a.maxX - a.minX >= 4 && a.maxY - a.minY >= 4,
    "The site must be at least four cells wide in both directions",
  );
const texture = z.string().trim().min(1).max(128);
export const materialBorderSchema = z
  .object({
    bounds: box,
    insideTexture: texture,
    outsideTexture: texture.optional(),
    widthScale: z.number().min(0.5).max(1).default(1),
  })
  .strict()
  .refine(
    (a) => a.insideTexture !== a.outsideTexture,
    "The border must separate different textures",
  );

type Bounds = z.output<typeof box>;
type Surface = Awaited<ReturnType<TerrainWorkspace["surface"]>>;
type Args = z.output<typeof materialBorderSchema>;
type MaterialSample = Pick<ReturnType<Surface["sample"]>, "textures">;
const round = (n: number) => Math.round(n * 10000) / 10000;
const rotate = ({ x, y }: Point2, angle: number): Point2 => ({
  x: x * Math.cos(angle) - y * Math.sin(angle),
  y: x * Math.sin(angle) + y * Math.cos(angle),
});

/** A designed rectangle anchors the search, with readback on three lines per side. */
export function readMaterialBorder(sample: (point: Point2) => MaterialSample, args: Args): Bounds {
  const { bounds: b, insideTexture, outsideTexture } = args;
  const step = 1 / 16;
  function edge(at: number, side: -1 | 1, start: number, end: number, vertical: boolean) {
    const hits = [0.2, 0.5, 0.8].map((fraction) => {
      const along = start + (end - start) * fraction;
      const probes = Array.from({ length: 13 }, (_, index) => {
        const across = at + side * (index - 6) * step;
        const { textures } = sample(vertical ? { x: across, y: along } : { x: along, y: across });
        const weight = (id: string) => textures?.find((t) => t.id === id)?.weight ?? 0;
        return {
          across,
          inner: weight(insideTexture),
          outer: outsideTexture ? weight(outsideTexture) : 0,
        };
      });
      const firstOutside = probes.findIndex((p) => p.inner < 8);
      if (
        firstOutside < 1 ||
        probes[0].inner < 12 ||
        probes.at(-1)!.inner > 3 ||
        probes[firstOutside - 1].inner - probes[firstOutside].inner < 6 ||
        probes.slice(firstOutside).some((p) => p.inner >= 8) ||
        (outsideTexture && probes[firstOutside].outer < 8)
      )
        throw Error("MATERIAL_BORDER_EXPECTED_SHARP_TRANSITION");
      return (probes[firstOutside - 1].across + probes[firstOutside].across) / 2;
    });
    if (Math.max(...hits) - Math.min(...hits) > step + 1e-8)
      throw Error("MATERIAL_BORDER_EXPECTED_STRAIGHT_EDGE");
    return round(hits[1]);
  }
  return {
    minX: edge(b.minX, -1, b.minY, b.maxY, true),
    maxX: edge(b.maxX, 1, b.minY, b.maxY, true),
    minY: edge(b.minY, -1, b.minX, b.maxX, false),
    maxY: edge(b.maxY, 1, b.minX, b.maxX, false),
  };
}

export async function measureBorderKit(palette: DecorPalette) {
  const id = "DOM_GroundTrims";
  const straight = await palette.resolve({ id, variation: 1, preview: false });
  const corner = await palette.resolve({ key: straight.actor.key, variation: 4, preview: false });
  for (const piece of [straight, corner]) {
    const dimensions = piece.measured.measurement.dimensions;
    if (piece.footprint.length || dimensions.height > 0.1)
      throw Error("MATERIAL_BORDER_EXPECTED_LOW_TRIM_WITHOUT_FOOTPRINT_LINK");
  }
  return { straight, corner };
}

export function fitMaterialBorder(
  surface: Surface,
  args: Args,
  { straight, corner }: Awaited<ReturnType<typeof measureBorderKit>>,
) {
  const bounds = readMaterialBorder(surface.sample, args);
  const w = args.widthScale;
  const straightBounds = straight.measured.measurement.bounds;
  const cornerBounds = corner.measured.measurement.bounds;
  const width = straightBounds.max[0] - straightBounds.min[0];
  const depth = straightBounds.max[1] - straightBounds.min[1];
  const elbow = {
    x: (cornerBounds.max[0] - width / 2) * w,
    y: (cornerBounds.min[1] + width / 2) * w,
  };
  const corners = [
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.minY },
  ].map((joint, i) => {
    const angle = (i * Math.PI) / 2;
    const world = (p: Point2) => {
      const offset = rotate({ x: p.x - elbow.x, y: p.y - elbow.y }, angle);
      return { x: joint.x + offset.x, y: joint.y + offset.y };
    };
    return {
      position: world({ x: 0, y: 0 }),
      angle,
      incoming: world({ x: cornerBounds.min[0] * w, y: elbow.y }),
      outgoing: world({ x: elbow.x, y: cornerBounds.max[1] * w }),
    };
  });
  const maxSlope = 0.16;
  function piece(model: DecorModel, rotation: number, position: Point2, lengthScale: number) {
    const { min, max } = model.measured.measurement.bounds;
    const geometry = measuredMemberGeometry(position, 0, {
      offset: { x: 0, y: 0 },
      rotation,
      scale: 1,
      boundsFrame: "member",
      horizontalBounds: {
        minX: min[0] * w,
        maxX: max[0] * w,
        minY: min[1] * lengthScale,
        maxY: max[1] * lengthScale,
      },
    });
    const samples = [position, ...geometry.corners].map(surface.sample);
    const elevations = samples.map((s) => s.height);
    if (
      samples.some(
        (s) => !s.mask || s.hidden || s.nativeMeshHole || s.water?.length || s.slope > maxSlope,
      ) ||
      Math.max(...elevations) - Math.min(...elevations) > 0.1
    )
      throw Error("MATERIAL_BORDER_REQUIRES_CONTINUOUS_FLAT_SUPPORT");
    return {
      kind: "Doodad" as const,
      key: model.actor.key,
      variation: model.variation!,
      position: { ...position, z: 0 },
      rotation,
      scale: { x: w, y: lengthScale, z: 1 },
      maxSlope,
      snapToTerrain: true,
    };
  }
  const objects = corners.map((c) => piece(corner, c.angle, c.position, w));
  for (const [i, c] of corners.entries()) {
    const from = c.outgoing,
      to = corners[(i + 1) % corners.length].incoming;
    const delta = { x: to.x - from.x, y: to.y - from.y };
    const length = Math.hypot(delta.x, delta.y);
    if (length < 1.5) throw Error("MATERIAL_BORDER_TOO_SHORT_FOR_TRIM_KIT");
    const rotation = Math.atan2(delta.y, delta.x) - Math.PI / 2;
    const count = Math.max(1, Math.round(length / depth));
    const lengthScale = (length / count + 0.025) / depth;
    const pivot = rotate(
      {
        x: ((straightBounds.min[0] + straightBounds.max[0]) / 2) * w,
        y: ((straightBounds.min[1] + straightBounds.max[1]) / 2) * lengthScale,
      },
      rotation,
    );
    for (let index = 0; index < count; index++) {
      const t = (index + 0.5) / count;
      objects.push(
        piece(
          straight,
          rotation,
          {
            x: from.x + delta.x * t - pivot.x,
            y: from.y + delta.y * t - pivot.y,
          },
          lengthScale,
        ),
      );
    }
  }
  return { bounds, objects };
}
