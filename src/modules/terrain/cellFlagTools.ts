import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { bytesHash } from "../../core/binaryTransactions.js";
import type { Workspace } from "../../core/workspace.js";
import { MapInfoDocument } from "../map/mapInfo.js";
import { readCellFlags, writeCellFlags } from "./surface/format/formats/cell-flags.js";
import { decodeComponent } from "./surface/core/registry.js";

const directory = z.string().max(1024).default("");
const cell = z
  .object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() })
  .strict();
const byte = z.number().int().min(0).max(255);
const terrainComponent = z.enum([
  "t3HeightMap",
  "t3SyncHeightMap",
  "t3TextureMasks",
  "t3SyncTextureInfo",
  "t3SyncCliffLevel",
  "t3SyncPathingInfo",
  "t3CellFlags",
  "t3Water",
  "t3HardTile",
  "t3FluffDoodad",
  "t3VertCol",
]);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

function index(x: number, y: number, width: number, height: number) {
  if (x >= width || y >= height) throw Error("TERRAIN_CELL_FLAGS_OUT_OF_BOUNDS: " + x + "," + y);
  return y * width + x;
}

function validateRaw(component: z.infer<typeof terrainComponent>, bytes: Buffer) {
  const parsed = decodeComponent(component, bytes);
  if (parsed.status !== "parsed" && parsed.status !== "partial")
    throw Error(
      "TERRAIN_BINARY_PROFILE_UNSUPPORTED: " + parsed.status + " " + parsed.diagnostics.join(", "),
    );
  return parsed.status;
}

export function registerTerrainBinaryTools(server: McpServer, workspace: Workspace) {
  const fileOf = (dir: string, name: string) => workspace.binary.key(path.join(dir, name));
  server.registerTool(
    "terrain.component_bytes.inspect",
    {
      description:
        "Read a small exact byte range and revision of one known binary terrain component.",
      inputSchema: z
        .object({
          directory,
          component: terrainComponent,
          offset: z.number().int().nonnegative().default(0),
          length: z.number().int().min(0).max(1024).default(32),
        })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const file = fileOf(args.directory, args.component);
      const { bytes, exists, staged } = await workspace.binary.read(file);
      if ((!exists && !staged) || args.offset + args.length > bytes.length)
        throw Error("TERRAIN_BINARY_RANGE");
      return result({
        file,
        sha256: bytesHash(bytes),
        byteLength: bytes.length,
        offset: args.offset,
        hex: bytes.subarray(args.offset, args.offset + args.length).toString("hex"),
      });
    },
  );
  server.registerTool(
    "terrain.component_bytes.apply",
    {
      description:
        "Apply a revision-guarded equal-length raw payload patch to one known binary Terrain component. Preserve the first 32 bytes. Validate the original and result profile. Opaque/ambiguous layouts refuse. Related layer and engine validation are separate. Dry run and staging default true.",
      inputSchema: z
        .object({
          directory,
          component: terrainComponent,
          expectedSha256: sha,
          offset: z.number().int().min(32),
          hex: z
            .string()
            .max(131072)
            .regex(/^(?:[a-f0-9]{2})+$/i),
          dryRun: z.boolean().default(true),
          stage: z.boolean().default(true),
        })
        .strict(),
    },
    async (args) => {
      const file = fileOf(args.directory, args.component);
      const patch = Buffer.from(args.hex, "hex");
      const transaction = await workspace.binary.apply(
        [file],
        (sources) => {
          const source = sources.get(file)!;
          if (bytesHash(source) !== args.expectedSha256)
            throw Error("TERRAIN_BINARY_REVISION_STALE");
          if (args.offset + patch.length > source.length) throw Error("TERRAIN_BINARY_RANGE");
          const profile = validateRaw(args.component, source);
          const next = Buffer.from(source);
          patch.copy(next, args.offset);
          if (validateRaw(args.component, next) !== profile)
            throw Error("TERRAIN_BINARY_PROFILE_CHANGED");
          return new Map([[file, next]]);
        },
        { dryRun: args.dryRun, stage: args.stage, backup: true },
      );
      return result({ ...transaction, enginePathingVerified: false });
    },
  );
  server.registerTool(
    "terrain.cell_flags.inspect",
    {
      description:
        "Inspect raw LFCT v101/v102 cell flags by coordinate and get the exact revision for a file edit.",
      inputSchema: z.object({ directory, cells: z.array(cell).max(256).default([]) }).strict(),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const file = fileOf(args.directory, "t3CellFlags");
      const snapshot = await workspace.binary.read(file);
      const model = readCellFlags(snapshot.bytes);
      return result({
        file,
        version: model.version,
        width: model.sizeX,
        height: model.sizeY,
        sha256: bytesHash(snapshot.bytes),
        cells: args.cells.map(({ x, y }) => ({
          x,
          y,
          value: model.types[index(x, y, model.sizeX, model.sizeY)],
        })),
        enginePathingVerified: false,
      });
    },
  );
  server.registerTool(
    "terrain.cell_flags.apply",
    {
      description:
        "Patch raw cell flags in bulk LFCT v101/v102. Mask defaults to all eight bits; all other cells, the header and trailer are preserved. Dry run and staging default true. Save via modkit.save. Engine pathing and synchronized cliff geometry require their own checks.",
      inputSchema: z
        .object({
          directory,
          expectedSha256: sha,
          cells: z
            .array(cell.extend({ value: byte, mask: byte.default(255) }))
            .min(1)
            .max(1024),
          dryRun: z.boolean().default(true),
          stage: z.boolean().default(true),
        })
        .strict(),
    },
    async (args) => {
      const file = fileOf(args.directory, "t3CellFlags"),
        mapFile = fileOf(args.directory, "MapInfo");
      const transaction = await workspace.binary.apply(
        [file, mapFile],
        (sources) => {
          const source = sources.get(file)!;
          if (bytesHash(source) !== args.expectedSha256)
            throw Error("TERRAIN_CELL_FLAGS_REVISION_STALE");
          const model = readCellFlags(source),
            map = new MapInfoDocument(sources.get(mapFile)!);
          if (map.width !== model.sizeX || map.height !== model.sizeY)
            throw Error("TERRAIN_CELL_FLAGS_SIZE_MISMATCH");
          const cells = new Set<number>();
          for (const { x, y, value, mask } of args.cells) {
            const cellIndex = index(x, y, model.sizeX, model.sizeY);
            if (cells.has(cellIndex)) throw Error("TERRAIN_CELL_FLAGS_DUPLICATE_CELL");
            cells.add(cellIndex);
            model.types[cellIndex] = (model.types[cellIndex] & ~mask) | (value & mask);
          }
          return new Map([[file, Buffer.from(writeCellFlags(model))]]);
        },
        { dryRun: args.dryRun, stage: args.stage, backup: true },
      );
      return result({ ...transaction, enginePathingVerified: false });
    },
  );
}
