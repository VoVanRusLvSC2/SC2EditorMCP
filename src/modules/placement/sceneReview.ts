import sharp from "sharp";
import type { composeScene } from "./scenePlanner.js";
import type { TerrainState } from "../terrain/operations.js";
import { segmentDistance } from "../terrain/geometry.js";

type Scene = ReturnType<typeof composeScene>;
/** A schematic for quick layout review; deliberately not presented as an engine screenshot. */
export function sceneSvg(scene: Scene) {
  const { bounds: b } = scene.args,
    width = b.maxX - b.minX,
    height = b.maxY - b.minY,
    scale = Math.min(830 / width, 550 / height);
  const x = (v: number) => 65 + (v - b.minX) * scale,
    y = (v: number) => 620 - (v - b.minY) * scale;
  const rectangle = (
    r: { minX: number; minY: number; maxX: number; maxY: number },
    fill: string,
    stroke: string,
  ) =>
    `<rect x="${x(r.minX)}" y="${y(r.maxY)}" width="${(r.maxX - r.minX) * scale}" height="${(r.maxY - r.minY) * scale}" fill="${fill}" stroke="${stroke}"/>`;
  const shape = (r: Scene["args"]["exclusions"][number], fill: string) =>
    r.type === "circle"
      ? `<circle cx="${x(r.center.x)}" cy="${y(r.center.y)}" r="${r.radius * scale}" fill="${fill}"/>`
      : rectangle(r, fill, "#d28279");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="740" viewBox="0 0 960 740"><rect width="960" height="740" fill="#111b25"/><g font-family="Arial" fill="#e3e9ed"><text x="36" y="30" font-size="20">${scene.args.zone} / ${scene.args.profile} / seed ${scene.args.seed}</text><text x="36" y="52" font-size="13">Composition schematic — measured rest bounds, not an SC2 render</text>${rectangle(b, "#283e34", "#6b8c7c")}${scene.args.exclusions.map((r) => shape(r, "#7d3738")).join("")}${scene.routes.map((r) => `<polyline points="${r.points.map((p) => `${x(p.x)},${y(p.y)}`).join(" ")}" fill="none" stroke="#b6a17a" stroke-width="${r.width * scale}" stroke-linecap="round" stroke-linejoin="round"/>`).join("")}${shape(scene.plaza, "#d1bd88")}${scene.boxes.map((r) => rectangle(r, "#5b9370", "#b5dbba")).join("")}${scene.groups.map((g, i) => `<text x="${x(g.bounds.minX)}" y="${y(g.bounds.maxY) - 6}" font-size="12" fill="${i ? "#dde7ec" : "#ffcf70"}">${i ? g.id : "FOCAL"}</text>`).join("")}<text x="36" y="661" font-size="15">${scene.metrics.groups} groups · ${scene.metrics.objects} objects · clear lane ${scene.args.clearance} world units</text><text x="36" y="685" font-size="13">Green: measured models   Sand: circulation / open plaza   Red: protected exclusions</text><text x="36" y="710" font-size="13">Review silhouette, gaps and repetition here; materials, light and movement in the actual Editor.</text></g></svg>`;
}
export async function scenePng(scene: Scene) {
  return sharp(Buffer.from(sceneSvg(scene)))
    .png()
    .toBuffer();
}

/** Sample the reserved playable space, keeping geometry separate from effective navigation. */
export function sceneSurfaceReview(scene: Scene, state: Pick<TerrainState, "heights">) {
  const b = scene.args.bounds,
    buckets = [0, 0, 0, 0],
    samples: number[] = [],
    heights: number[] = [];
  let holes = 0,
    aboveLimit = 0;
  for (let iy = 0; iy < 25; iy++)
    for (let ix = 0; ix < 25; ix++) {
      const point = {
        x: b.minX + ((ix + 0.5) / 25) * (b.maxX - b.minX),
        y: b.minY + ((iy + 0.5) / 25) * (b.maxY - b.minY),
      };
      const reserved =
        Math.hypot(point.x - scene.plaza.center.x, point.y - scene.plaza.center.y) <=
          scene.plaza.radius ||
        scene.routes.some((r) =>
          r.points
            .slice(1)
            .some((end, i) => segmentDistance(point, r.points[i], end) <= r.width / 2),
        );
      if (!reserved) continue;
      const s = state.heights.sample(point);
      samples.push(s.slope);
      heights.push(s.height);
      if (s.mask === 0) holes++;
      if (s.slope > scene.args.maxSlope) aboveLimit++;
      buckets[s.slope <= 0.1 ? 0 : s.slope <= 0.25 ? 1 : s.slope <= 0.5 ? 2 : 3]++;
    }
  return {
    scope:
      "625-grid sampled route/plaza ground; native ramp geometry, collision and engine navigation are separate",
    samples: samples.length,
    maxSlope: samples.length ? Math.max(...samples) : null,
    heightRange: heights.length ? [Math.min(...heights), Math.max(...heights)] : null,
    slopeHistogram: {
      upTo01: buckets[0],
      upTo025: buckets[1],
      upTo05: buckets[2],
      above05: buckets[3],
    },
    holes,
    aboveLimit,
    reviewRequired: !samples.length || holes > 0 || aboveLimit > 0,
  };
}
