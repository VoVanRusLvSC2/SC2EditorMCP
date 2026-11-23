import type { Point2, TerrainArea, TerrainOperation } from "../terrain/types.js";

type BasinInput = {
  center: Point2;
  radiusX: number;
  radiusY: number;
  bankHeight: number;
  floorHeight: number;
  surfaceHeight: number;
  bedTexture: string;
  material: { id: string; parent: string; color?: [number, number, number, number] };
  phase?: number;
};

export function planScenicBasin(input: BasinInput) {
  if (
    !(input.floorHeight < input.surfaceHeight && input.surfaceHeight < input.bankHeight) ||
    Math.min(input.radiusX, input.radiusY) < 3
  )
    throw Error("SCENIC_BASIN_REQUIRES_A_BANK_AND_SUBMERGED_FLOOR");
  const { center, radiusX, radiusY, surfaceHeight, material } = input;
  const shape = (factor: number): TerrainArea => ({
    type: "polygon",
    points: Array.from({ length: 20 }, (_, i) => {
      const angle = (i * Math.PI) / 10;
      const radius = factor * (1 + 0.09 * Math.sin(3 * angle + (input.phase ?? 0)));
      return {
        x: center.x + Math.cos(angle) * radiusX * radius,
        y: center.y + Math.sin(angle) * radiusY * radius,
      };
    }),
  });
  const bounds = {
    type: "rectangle" as const,
    minX: 8 * Math.floor((center.x - radiusX * 1.08) / 8),
    maxX: 8 * Math.ceil((center.x + radiusX * 1.08) / 8),
    minY: 8 * Math.floor((center.y - radiusY * 1.08) / 8),
    maxY: 8 * Math.ceil((center.y + radiusY * 1.08) / 8),
  };
  const interior = shape(1);
  const terrain: TerrainOperation[] = [
    { op: "height.set", area: shape(1.24), height: input.bankHeight, edgeBlend: 2.0 },
    { op: "height.set", area: interior, height: input.floorHeight, edgeBlend: 1.9 },
    {
      op: "texture.blend",
      area: shape(1.12),
      texture: input.bedTexture,
      edgeBlend: 2.2,
      strength: 0.85,
    },
  ];
  const water: TerrainOperation[] = [
    { op: "water.material", ...material, height: surfaceHeight },
    { op: "water.create", template: material.id, area: bounds },
  ];
  return { terrain, water, bounds, surfaceHeight };
}
