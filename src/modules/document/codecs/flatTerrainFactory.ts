import { parseState } from "../../terrain/operations.js";
import { inspectNativeIntegrity } from "../../terrain/nativeIntegrity.js";
import { escapeXml } from "../schemas.js";
export interface TerrainSet {
    id: string;
    textures: string[];
    cliffs: string[];
    sourcePaths: string[];
    generic?: boolean;
    unsupported?: string[];
}
export function createFlatTerrain(width: number, height: number, set: TerrainSet, texture: string, baseHeight: number, palette?: { sets: TerrainSet[]; blocks: number[] }) {
    if (!set.textures.includes(texture) || set.textures.length > 8 || !set.textures.length)
        throw new Error('DOCUMENT_INITIAL_TEXTURE_INVALID');
    const result = new Map<string, Buffer>(), vw = width + 1, vh = height + 1;
    const header = (magic: string, version: number, length: number) => { const b = Buffer.alloc(length); b.write(magic, 0, 'ascii'); b.writeUInt32LE(version, 4); return b; };
    const banks = palette?.sets ?? [set];
    if (banks.length < 1 || banks.length > 8 || banks[0].id !== set.id ||
        banks.some(bank => !bank.textures.length || bank.textures.length > 8 || bank.textures.some(id => !id || id.includes('\0'))))
        throw Error('INVALID_TERRAIN_PALETTE');
    const blocks = palette?.blocks ?? Array<number>(width * height / 64).fill(0);
    if (blocks.length !== width * height / 64 || blocks.some(bank => !Number.isInteger(bank) || bank < 0 || bank >= banks.length))
        throw Error('INVALID_TERRAIN_BLOCK_ASSIGNMENT');
    const textures = banks.flatMap(bank => [...bank.textures, ...Array<string>(8 - bank.textures.length).fill('')]);
    const layer = set.textures.indexOf(texture);
    const initialLayers = banks.map((bank, i) => i === 0 ? layer : 0);
    const bias = 9, scale = 0.0002746624, total = Math.round((baseHeight + 2 * bias) / scale), adjust = Math.max(32767, total - 65535), base = total - adjust;
    if (base < 0 || base > 65535)
        throw new Error('DOCUMENT_BASE_HEIGHT_UNREPRESENTABLE');
    const h = header('HMAP', 101, 32 + vw * vh * 6);
    h.writeUInt32LE(vw, 8);
    h.writeUInt32LE(vh, 12);
    const sync = header('SMAP', 102, 64 + vw * vh * 4);
    sync.writeUInt32LE(vw, 8);
    sync.writeUInt32LE(vh, 12);
    // Native Q12 transform: origin (0,0,0), unit scale (4096,4096,4096).
    // A zero scale passes envelope readers but cannot describe editor geometry.
    for (const offset of [28, 32, 36])
        sync.writeInt32LE(4096, offset);
    for (let i = 0; i < vw * vh; i++) {
        h.writeUInt16LE(base, 32 + i * 6);
        h.writeUInt16LE(adjust, 34 + i * 6);
        h.writeUInt16LE(1, 36 + i * 6);
        sync.writeInt16LE(Math.round(baseHeight * 256), 64 + i * 4);
        sync.writeUInt16LE(1, 66 + i * 4);
    }
    result.set('t3HeightMap', h);
    result.set('t3SyncHeightMap', sync);
    const mask = header('MASK', 102, 64 + width * height * 256);
    mask.writeUInt32LE(width * 8, 12);
    mask.writeUInt32LE(height * 8, 16);
    for (const [index, bank] of blocks.entries()) {
        const start = 64 + initialLayers[bank] * width * height * 32 + index * 2048;
        mask.fill(255, start, start + 2048);
    }
    result.set('t3TextureMasks', mask);
    const names = Buffer.from(textures.map(n => n + '\0').join('')), rt = header('RTXT', 101, 20 + names.length + width * height * 8);
    rt.writeUInt32LE(width, 8);
    rt.writeUInt32LE(height, 12);
    rt.writeUInt32LE(banks.length, 16);
    names.copy(rt, 20);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const bank = blocks[Math.floor(y / 8) * (width / 8) + Math.floor(x / 8)];
        const offset = 20 + names.length + (y * width + x) * 8;
        rt.writeUInt32LE(initialLayers[bank], offset);
        rt.writeUInt32LE(bank, offset + 4);
    }
    result.set('t3SyncTextureInfo', rt);
    const flags = header('LFCT', 102, 32 + width * height);
    flags.writeUInt32LE(width, 24);
    flags.writeUInt32LE(height, 28);
    flags.fill(2, 32);
    result.set('t3CellFlags', flags);
    const cliffs = header('CLIF', 100, 32 + width * height * 2);
    cliffs.writeUInt32LE(width, 8);
    cliffs.writeUInt32LE(height, 12);
    for (let i = 0; i < width * height; i++)
        cliffs.writeUInt16LE(0x40, 32 + i * 2);
    result.set('t3SyncCliffLevel', cliffs);
    result.set('t3HardTile', header('HRDT', 102, 28));
    result.set('t3FluffDoodad', header('DLFT', 103, 28));
    result.set('t3VertCol', header('VTCL', 104, 32));
    result.set('t3Water', header('WATR', 110, 32));
    const line = (text: string) => '        ' + text + '\r\n';
    const xml = '<?xml version="1.0" encoding="utf-8"?>\r\n<terrain version="115">\r\n' + `    <heightMap tileSet="${escapeXml(set.id)}" uvtiling="12 12 0 0" dim="${vw} ${vh}" offset="0 0 0" scale="1 1 1">\r\n` +
        line(`<cliffSetList num="${set.cliffs.length}">`) + set.cliffs.map((id, i) => line(`    <cliffSet i="${i}" name="${escapeXml(id)}"/>`)).join('') + line('</cliffSetList>') + line('<rampList num="0"/>') +
        line(`<vertData quantizeBias="${bias}" quantizeScale="${scale}" standardHeight="${baseHeight}" name="t3HeightMap"/>`) + line('<masks name="t3TextureMasks"/>') + line('<textureSetList num="8">') + Array.from({ length: 8 }, (_, i) => line(`    <textureSet i="${i}" name="${escapeXml(banks[i]?.id ?? '')}"/>`)).join('') + line('</textureSetList>') +
        line('<textureList num="64">') + Array.from({ length: 64 }, (_, i) => line(`    <texture i="${i}" name="${escapeXml(textures[i] ?? '')}"/>`)).join('') + line('</textureList>') + line(`<blockTextureSetList num="${width * height / 64}">`) + Array.from({ length: width * height / 64 }, (_, i) => line(`    <blockTextureSet i="${i}" tileSet="${blocks[i]}"/>`)).join('') + line('</blockTextureSetList>') + line(`<cliffCellList num="${width * height / 4}" numOccupied="0"/>`) + '    </heightMap>\r\n</terrain>\r\n';
    result.set('t3Terrain.xml', Buffer.from(xml));
    const state = parseState(result), integrity = inspectNativeIntegrity(result, width, height);
    if (!integrity.valid || !state.masks || !state.syncTextures || state.heights.mask(0, 0) !== 1)
        throw new Error('DOCUMENT_TERRAIN_FACTORY_INVALID');
    return result;
}
