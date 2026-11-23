import type { Point2 } from "../terrain/types.js";

export function wallSections(from: number, to: number, spacing: number) {
  if (to <= from) return [];
  const count = Math.ceil((to - from) / spacing);
  const span = (to - from) / count;
  return Array.from({ length: count }, (_, index) => ({
    from: from + index * span,
    center: from + (index + 0.5) * span,
    to: from + (index + 1) * span,
    span,
  }));
}

export function wallCourseHeight(heights: number[], tolerance = 0.18) {
  if (!heights.length || Math.max(...heights) - Math.min(...heights) > tolerance) return undefined;
  return heights.reduce((sum, height) => sum + height, 0) / heights.length;
}

export function companionPoint(anchor: Point2, angle: number, distance: number): Point2 {
  return {
    x: anchor.x + Math.cos(angle) * distance,
    y: anchor.y + Math.sin(angle) * distance,
  };
}
