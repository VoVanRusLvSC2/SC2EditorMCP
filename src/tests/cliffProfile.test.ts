import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {TerrainDescriptor,HeightMap} from '../modules/terrain/document.js';
import {parseTerrainXml} from '../modules/terrain/surface/format/terrain-params.js';
import {nativeCliffSyncLevels,nativeCliffFineLevels,nativeCliffFineSyncLevels} from '../modules/terrain/cliffProfile.js';

test('one-level cliff sync profile matches original native cells for all 12 non-saddle orientations',async()=>{
 const root='src/tests/fixtures/terrain-native/city/',read=async(name:string)=>gunzipSync(await fs.readFile(root+name+'.gz'));
 const [xml,h,c]=await Promise.all(['t3Terrain.xml','t3HeightMap','t3SyncCliffLevel'].map(read)),descriptor=new TerrainDescriptor(xml.toString('utf8')),height=new HeightMap(h,descriptor),w=height.width-1;
 const parsed=parseTerrainXml(descriptor.source),level=(x:number,y:number)=>h.readUInt16LE(32+(y*(w+1)+x)*6+4)&255;
 let checked=0;const shapes=new Set<string>(),finePatterns=new Map<string,Set<string>>();
 for(const cell of parsed.cliffCells??[]){
  if(cell.flags!==1)continue;const x=cell.index%(w/2)*2,y=Math.floor(cell.index/(w/2))*2;
  if((parsed.ramps??[]).some(r=>{const m=r.frames.mid;return m&&Math.abs(x+1-m.center[0])<6&&Math.abs(y+1-m.center[1])<6;}))continue;
  const values=[];for(let dy=0;dy<3;dy++)for(let dx=0;dx<3;dx++)values.push(level(x+dx,y+dy));
  const lo=Math.min(...values),hi=Math.max(...values);if(lo<1||hi-lo!==1)continue;
  const corners=[level(x,y),level(x+2,y),level(x+2,y+2),level(x,y+2)],key=corners.map(v=>v-lo).join('');if(key==='0000'||key==='1111')continue;
  const actual=[];for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++)actual.push(c.readUInt16LE(32+((y+dy)*w+x+dx)*2));
  assert.deepEqual(nativeCliffSyncLevels(corners),actual,'native cell '+x+','+y+' pattern '+key);shapes.add(key);checked++;
  const patterns=finePatterns.get(key)??new Set<string>();patterns.add(values.map(v=>v-lo).join(''));finePatterns.set(key,patterns);
 }
 assert.equal(checked,396);assert.equal(shapes.size,12);
 for(const [key,observed]of finePatterns){const corners=[...key].map(v=>Number(v)+1),selected=nativeCliffFineLevels(corners).map(v=>v-1).join('');assert.ok(observed.has(selected),'selected fine pattern was not observed natively: '+key);}
});

test('measured saddle corners retain low HMAP centers and high CLIF and SMAP centers',async()=>{
 const fixture=JSON.parse(await fs.readFile('src/tests/fixtures/terrain-native/cliff-saddle-reference.json','utf8'));
 assert.equal(fixture.cases.length,4);
 for(const c of fixture.cases){
  assert.deepEqual(nativeCliffSyncLevels(c.corners),c.syncCliff,c.id);
  assert.deepEqual(nativeCliffFineLevels(c.corners),c.levels,c.id);
  const levels=nativeCliffFineSyncLevels(c.corners),high=Math.max(...c.corners);
  assert.equal(levels[4],high);assert.equal(c.levels[4],high-1);
  assert.ok(Math.abs(c.syncHeight[4]/256-(c.bases[4]+(high-1)*2))<.04,'native center height '+c.id);
  assert.ok(c.flags.every((v:number)=>(v&1)===1));
 }
});

test('level zero cliff profiles match the twelve measured Steps of the Rite orientations',()=>{
 // Installed ptaldarim01.SC2Map, terrain v115. Each row records coarse cell
 // origin, LL/LR/UR/UL corners, row-major HMAP/SMAP labels and CLIF words.
 const samples=[
  ['44,48', '0001', '000100110', [0,0,64,0]],
  ['120,54','0010', '000001011', [0,0,0,64]],
  ['46,50', '0011', '000111111', [0,0,64,64]],
  ['136,78','0100', '011001000', [0,64,0,0]],
  ['40,38', '0110', '011011011', [0,64,0,64]],
  ['76,62', '0111', '011111111', [64,64,64,64]],
  ['26,10', '1000', '110100000', [64,0,0,0]],
  ['26,4',  '1001', '110110110', [64,0,64,0]],
  ['60,70', '1011', '110111111', [64,64,64,64]],
  ['24,10', '1100', '111111000', [64,64,0,0]],
  ['22,10', '1101', '111111110', [64,64,64,64]],
  ['76,90', '1110', '111111011', [64,64,64,64]],
 ] as const;
 for(const [source,corners,labels,syncCliff] of samples){
  const coarse=[...corners].map(Number),fine=[...labels].map(Number);
  assert.deepEqual(nativeCliffSyncLevels(coarse),syncCliff,source);
  assert.deepEqual(nativeCliffFineLevels(coarse),fine,source);
  assert.deepEqual(nativeCliffFineSyncLevels(coarse),fine,source);
 }
});

test('unmeasured level zero saddles and multi-level joins fail',()=>{
 for(const corners of [[1,3,3,1],[0,2,2,0],[0,1,0,1],[1,0,1,0]])assert.throws(()=>nativeCliffSyncLevels(corners),/UNSUPPORTED/);
 assert.deepEqual(nativeCliffSyncLevels([0,0,0,0]),[0,0,0,0]);
 assert.deepEqual(nativeCliffSyncLevels([1,1,1,1]),[64,64,64,64]);
 assert.deepEqual(nativeCliffSyncLevels([1,2,2,2]),[128,128,128,128]);
});
