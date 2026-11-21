import assert from "node:assert/strict";
import test from "node:test";
import { materialBorderSchema, readMaterialBorder } from "../modules/placement/materialBorder.js";

const options = materialBorderSchema.parse({
  bounds: { minX: 10, maxX: 22, minY: 15, maxY: 24 },
  insideTexture: "Concrete",
  outsideTexture: "Panels",
});
const expected = { minX: 9.875, maxX: 22.125, minY: 14.875, maxY: 24.125 };

function textures(inner: number) {
  return {
    textures: [
      { id: "Concrete", weight: inner },
      { id: "Panels", weight: 15 - inner },
    ],
  };
}

test("the measured material edge supplies all four sides of a non-square border", () => {
  const bounds = readMaterialBorder(
    ({ x, y }) =>
      textures(
        x >= expected.minX && x <= expected.maxX && y >= expected.minY && y <= expected.maxY
          ? 15
          : 0,
      ),
    options,
  );
  for (const side of Object.keys(expected) as (keyof typeof expected)[]) {
    assert.ok(Math.abs(bounds[side] - expected[side]) <= 1 / 16, side);
  }
});

test("the border requires a sharp material transition and a straight edge", () => {
  assert.throws(
    () =>
      readMaterialBorder(({ x, y }) => {
        const inward = Math.min(x - 10, 22 - x, y - 15, 24 - y);
        return textures(Math.max(0, Math.min(15, Math.round(7.5 + inward * 24))));
      }, options),
    /MATERIAL_BORDER_EXPECTED_SHARP_TRANSITION/,
  );
  assert.throws(
    () =>
      readMaterialBorder(
        ({ x, y }) =>
          textures(x >= (y < 20 ? 9.875 : 10.125) && x <= 22 && y >= 15 && y <= 24 ? 15 : 0),
        options,
      ),
    /MATERIAL_BORDER_EXPECTED_STRAIGHT_EDGE/,
  );
});
