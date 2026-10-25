// ==UserScript==
// @name         JakhonHangle JP Unity (Experimental)
// @namespace    local.jakhonhangle.unity
// @version      2.0.0-beta.12
// @description  Runtime JP/KR resource discovery and Korean UI images, Korean text and Yostar login labels; JP server announcements retained.
// @license      MIT
// @homepageURL  https://github.com/mabinewb/jakhonhangle-jp-unity
// @downloadURL  https://gist.githubusercontent.com/mabinewb/e919e5a07216e5ff546be8789b070755/raw/JakhonHangle_JP_Unity.user.js
// @updateURL    https://gist.githubusercontent.com/mabinewb/e919e5a07216e5ff546be8789b070755/raw/JakhonHangle_JP_Unity.user.js
// @match        https://game.mahjongsoul.com/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @noframes
// ==/UserScript==

(function(){
'use strict';
/* UnityFS reader: supports uncompressed and raw LZ4 blocks; rejects other codecs. */
function rewriteBundle(input, mutate, extractOnly = false) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let cursor = 0;
  const string = () => { const start = cursor; while (cursor < bytes.length && bytes[cursor]) cursor++; if (cursor >= bytes.length) throw Error('Invalid UnityFS string'); return decoder.decode(bytes.subarray(start, cursor++)); };
  if (string() !== 'UnityFS') throw Error('Not a UnityFS bundle');
  const version = view.getUint32(cursor); cursor += 4;
  string(); string();
  const sizePosition = cursor;
  const declaredSize = Number(view.getBigUint64(cursor)); cursor += 8;
  const infoCompressedSize = view.getUint32(cursor); cursor += 4;
  const infoSize = view.getUint32(cursor); cursor += 4;
  const flags = view.getUint32(cursor); cursor += 4;
  if (declaredSize !== bytes.length || version < 7 || flags & ~0x2ff) throw Error('Unsupported UnityFS header');
  cursor = Math.ceil(cursor / 16) * 16;
  const headerEnd = cursor;
  const decompress = (data, size, mode) => {
    mode &= 63;
    if (mode === 0) { if (data.length !== size) throw Error('Bad raw block'); return data.slice(); }
    if (mode !== 2 && mode !== 3) throw Error('Unsupported compression');
    const out = new Uint8Array(size);
    let i = 0, o = 0;
    const extra = () => { let sum = 0, n; do { if (i >= data.length) throw Error('Truncated LZ4'); n = data[i++]; sum += n; } while (n === 255); return sum; };
    while (i < data.length) {
      const token = data[i++];
      const literals = (token >> 4) + ((token >> 4) === 15 ? extra() : 0);
      if (i + literals > data.length || o + literals > size) throw Error('Bad LZ4 literal');
      out.set(data.subarray(i, i + literals), o); i += literals; o += literals;
      if (i === data.length) break;
      if (i + 2 > data.length) throw Error('Truncated LZ4 offset');
      const distance = data[i++] | data[i++] << 8;
      const length = (token & 15) + ((token & 15) === 15 ? extra() : 0) + 4;
      if (!distance || distance > o || o + length > size) throw Error('Bad LZ4 match');
      for (let n = 0; n < length; n++) { out[o] = out[o - distance]; o++; }
    }
    if (o !== size) throw Error('Wrong LZ4 size');
    return out;
  };
  const infoStart = flags & 128 ? bytes.length - infoCompressedSize : cursor;
  const info = decompress(bytes.subarray(infoStart, infoStart + infoCompressedSize), infoSize, flags);
  const iv = new DataView(info.buffer);
  const count = iv.getUint32(16);
  if (!count || count > 65536 || 20 + count * 10 > info.length) throw Error('Bad block table');
  let total = 0;
  for (let n = 0; n < count; n++) total += iv.getUint32(20 + n * 10);
  cursor = flags & 128 ? headerEnd : headerEnd + infoCompressedSize;
  if (flags & 512) cursor = Math.ceil(cursor / 16) * 16;
  let payload = new Uint8Array(total);
  let offset = 0;
  for (let n = 0; n < count; n++) {
    const pos = 20 + n * 10, size = iv.getUint32(pos), packed = iv.getUint32(pos + 4), mode = iv.getUint16(pos + 8);
    payload.set(decompress(bytes.subarray(cursor, cursor + packed), size, mode), offset);
    offset += size; cursor += packed;
  }
  const replacement = mutate(payload);
  if (extractOnly) return payload;
  let tail = info.slice(20 + count * 10);
  if (replacement && replacement !== payload) {
    const directory = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    if (directory.getUint32(0) !== 1 || directory.getBigUint64(4) !== 0n || Number(directory.getBigUint64(12)) !== total) throw Error('Cannot resize a multi-file bundle');
    payload = replacement;
    total = payload.length;
    directory.setBigUint64(12, BigInt(total));
  }
  const newInfo = new Uint8Array(30 + tail.length), nv = new DataView(newInfo.buffer);
  nv.setUint32(16, 1); nv.setUint32(20, total); nv.setUint32(24, total); nv.setUint16(28, 0);
  newInfo.set(tail, 30);
  const output = new Uint8Array(headerEnd + newInfo.length + total), ov = new DataView(output.buffer);
  output.set(bytes.subarray(0, headerEnd));
  ov.setBigUint64(sizePosition, BigInt(output.length));
  ov.setUint32(sizePosition + 8, newInfo.length); ov.setUint32(sizePosition + 12, newInfo.length); ov.setUint32(sizePosition + 16, 64);
  output.set(newInfo, headerEnd); output.set(payload, headerEnd + newInfo.length);
  return output;
}
function patchBundle(input, mode = 'main') {
 return rewriteBundle(input, payload => {
  const encoder = new TextEncoder(), decoder = new TextDecoder(), total = payload.length;
  const pv = new DataView(payload.buffer);
  let changed = 0;
  const modules = Array.isArray(mode) ? mode : mode === 'main' ? ['LangMgr.lua', 'GameMgr.lua'] : mode === 'notice' ? ['UI_Notice.lua'] : mode === 'gateway' ? ['GatewayFetcher.lua'] : [];
  if (!modules.length) throw Error('Unknown patch mode');
  for (const moduleName of modules) {
  const marker = encoder.encode(moduleName);
  for (let p = 4; p + marker.length + 8 < payload.length; p++) {
    if (pv.getUint32(p - 4, true) !== marker.length || !marker.every((b, n) => payload[p + n] === b)) continue;
    const lengthPosition = Math.ceil((p + marker.length) / 4) * 4;
    const length = pv.getUint32(lengthPosition, true), start = lengthPosition + 4;
    if (length < 100 || length > 262144 || start + length > total) continue;
    const key = encoder.encode('wrelupqezdfrqdsd');
    const sourceBytes = payload.slice(start, start + length).map((b, n) => b ^ key[n % key.length]);
    const source = decoder.decode(sourceBytes);
    let modified;
    if (moduleName === 'LangMgr.lua') {
    if (!source.startsWith('LangMgr={}function LangMgr.Init()')) continue;
    modified = source.replace(/local b=function\(c\).*?end end;if GameMgr\.Inst\.prefer_language==''then/, "local b=function(c)return c==ELangStr.Kr end;if GameMgr.Inst.prefer_language==''then");
    modified = modified.replace("GameMgr.Inst.prefer_language=GameMgr.GetItem('prefer_language',false,'')", "GameMgr.Inst.prefer_language=ELangStr.Kr;");
    modified = modified.replace('then GameMgr.Inst.prefer_language=GameMgr.Inst.client_language end;GameMgr.SetItem', 'then GameMgr.Inst.prefer_language=ELangStr.Kr end;GameMgr.SetItem');
    modified = modified.replace('LangMgr.client_language=GameMgr.Inst.client_language;', 'GamePlatformInfo.prefer_language=ELangStr.Jp;LangMgr.client_language=GameMgr.Inst.client_language;');
    if (modified === source || !modified.includes('GameMgr.Inst.prefer_language=ELangStr.Kr;')) throw Error('Language source changed');
    } else if (moduleName === 'GameMgr.lua') {
      // C# keeps the JP image/atlas locale. Only Lua text preferences use Korean.
      const before = 'self.prefer_language=GamePlatformInfo.prefer_language';
      if (source.split(before).length !== 2) throw Error('GameMgr language assignment changed');
      modified = source.replace(before, 'self.prefer_language=ELangStr.Kr');
    } else {
      // Server-owned announcements and upgrade metadata must use the JP locale.
      // These two modules use prefer_language only for server locale selection.
      const before = 'GameMgr.Inst.prefer_language';
      const expected = moduleName === 'UI_Notice.lua' ? 6 : 5;
      if (source.split(before).length - 1 !== expected) throw Error(moduleName + ': locale source changed');
      modified = source.split(before).join('GameMgr.Inst.client_language');
    }
    const replacement = encoder.encode(modified);
    if (replacement.length > length) throw Error('Replacement exceeds original size');
    for (let n = 0; n < length; n++) payload[start + n] = (n < replacement.length ? replacement[n] : 32) ^ key[n % key.length];
    changed++;
  }
  }
  if (changed !== modules.length) throw Error('Expected ' + modules.length + ' language modules, got ' + changed);
 });
}
function patchManifest(input, original, alias) {
 return patchManifestList(input, [{ name: original, alias }]);
}
function patchManifestList(input, pairs) {
 return rewriteBundle(input, payload => {
  for (const {name:original, alias} of pairs) {
  const encoder = new TextEncoder(), before = encoder.encode(original), after = encoder.encode(alias);
  if (before.length !== after.length) throw Error('Alias length mismatch');
  let count = 0;
  for (let i = 0; i <= payload.length - before.length; i++) {
   if (payload[i] === before[0] && before.every((b, n) => payload[i + n] === b)) { payload.set(after, i); count++; i += before.length - 1; }
  }
  if (count !== 1) throw Error('Manifest version changed: expected one bundle name');
  }
 });
}

// BC3/DXT5 -> RGBA32. Leave all sprite geometry and unrelated objects intact.
function decodeBC3(input, width, height) {
  const cols = Math.ceil(width / 4), rows = Math.ceil(height / 4);
  if (input.length !== cols * rows * 16) throw Error('Invalid texture data length');
  const result = new Uint8Array(width * height * 4);
  const rgb = word => [((word >> 11) * 255 + 15) / 31 | 0, (((word >> 5) & 63) * 255 + 31) / 63 | 0, ((word & 31) * 255 + 15) / 31 | 0];
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) {
    const p = (by * cols + bx) * 16;
    const alpha = [input[p], input[p + 1]];
    if (alpha[0] > alpha[1]) {
      for (let i = 1; i <= 6; i++) alpha[i + 1] = ((7 - i) * alpha[0] + i * alpha[1]) / 7 | 0;
    } else {
      for (let i = 1; i <= 4; i++) alpha[i + 1] = ((5 - i) * alpha[0] + i * alpha[1]) / 5 | 0;
      alpha[6] = 0; alpha[7] = 255;
    }
    const c0 = rgb(input[p + 8] | input[p + 9] << 8), c1 = rgb(input[p + 10] | input[p + 11] << 8);
    const colors = [c0, c1, c0.map((v, i) => (2 * v + c1[i]) / 3 | 0), c0.map((v, i) => (v + 2 * c1[i]) / 3 | 0)];
    const bits = (input[p + 12] | input[p + 13] << 8 | input[p + 14] << 16 | input[p + 15] << 24) >>> 0;
    // 48 alpha bits fit exactly in an IEEE double integer.
    let abits = 0;
    for (let i = 0; i < 6; i++) abits += input[p + 2 + i] * 2 ** (8 * i);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const px = bx * 4 + x, py = by * 4 + y, n = y * 4 + x;
      if (px >= width || py >= height) continue;
      const color = colors[bits >>> (2 * n) & 3], out = (py * width + px) * 4;
      result[out] = color[0]; result[out + 1] = color[1]; result[out + 2] = color[2];
      result[out + 3] = alpha[Math.floor(abits / 2 ** (3 * n)) % 8];
    }
  }
  return result;
}

const assetCommonStrings={"0":"AABB","5":"AnimationClip","19":"AnimationCurve","34":"AnimationState","49":"Array","55":"Base","60":"BitField","69":"bitset","76":"bool","81":"char","86":"ColorRGBA","96":"Component","106":"data","111":"deque","117":"double","124":"dynamic_array","138":"FastPropertyName","155":"first","161":"float","167":"Font","172":"GameObject","183":"Generic Mono","196":"GradientNEW","208":"GUID","213":"GUIStyle","222":"int","226":"list","231":"long long","241":"map","245":"Matrix4x4f","256":"MdFour","263":"MonoBehaviour","277":"MonoScript","288":"m_ByteSize","299":"m_Curve","307":"m_EditorClassIdentifier","331":"m_EditorHideFlags","349":"m_Enabled","359":"m_ExtensionPtr","374":"m_GameObject","387":"m_Index","395":"m_IsArray","405":"m_IsStatic","416":"m_MetaFlag","427":"m_Name","434":"m_ObjectHideFlags","452":"m_PrefabInternal","469":"m_PrefabParentObject","490":"m_Script","499":"m_StaticEditorFlags","519":"m_Type","526":"m_Version","536":"Object","543":"pair","548":"PPtr<Component>","564":"PPtr<GameObject>","581":"PPtr<Material>","596":"PPtr<MonoBehaviour>","616":"PPtr<MonoScript>","633":"PPtr<Object>","646":"PPtr<Prefab>","659":"PPtr<Sprite>","672":"PPtr<TextAsset>","688":"PPtr<Texture>","702":"PPtr<Texture2D>","718":"PPtr<Transform>","734":"Prefab","741":"Quaternionf","753":"Rectf","759":"RectInt","767":"RectOffset","778":"second","785":"set","789":"short","795":"size","800":"SInt16","807":"SInt32","814":"SInt64","821":"SInt8","827":"staticvector","840":"string","847":"TextAsset","857":"TextMesh","866":"Texture","874":"Texture2D","884":"Transform","894":"TypelessData","907":"UInt16","914":"UInt32","921":"UInt64","928":"UInt8","934":"unsigned int","947":"unsigned long long","966":"unsigned short","981":"vector","988":"Vector2f","997":"Vector3f","1006":"Vector4f","1015":"m_ScriptingClassIdentifier","1042":"Gradient","1051":"Type*","1057":"int2_storage","1070":"int3_storage","1083":"BoundsInt","1093":"m_CorrespondingSourceObject","1121":"m_PrefabInstance","1138":"m_PrefabAsset","1152":"FileSize","1161":"Hash128","1169":"RenderingLayerMask","1188":"fixed_array","1200":"EntityId","1209":"LoadableObjectId","1226":"LoadableSceneId"};

// Runtime Unity serialized-file v22 codec. Schemas are read from each file.
const assetDecoder = new TextDecoder(), assetEncoder = new TextEncoder();
class AssetReader {
  constructor(bytes) { this.b=bytes;this.v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);this.p=0; }
  align(n=4){this.p=Math.ceil(this.p/n)*n;}
  raw(n){if(!Number.isSafeInteger(n)||n<0||this.p+n>this.b.length)throw Error('Asset data bounds');const b=this.b.subarray(this.p,this.p+n);this.p+=n;return b;}
  num(method,n){if(this.p+n>this.b.length)throw Error('Asset number bounds');const v=this.v[method](this.p,true);this.p+=n;return v;}
  i(){return this.num('getInt32',4);} u(){return this.num('getUint32',4);} long(){return this.num('getBigInt64',8);}
  zero(){let start=this.p;while(this.p<this.b.length&&this.b[this.p])this.p++;if(this.p===this.b.length)throw Error('Asset string bounds');return assetDecoder.decode(this.b.subarray(start,this.p++));}
  string(){const s=assetDecoder.decode(this.raw(this.i()));this.align();return s;}
}
class AssetWriter {
  constructor(){this.b=new Uint8Array(1024);this.p=0;}
  need(n){if(this.p+n>this.b.length){const b=new Uint8Array(Math.max(this.p+n,this.b.length*2));b.set(this.b);this.b=b;}return new DataView(this.b.buffer);}
  raw(b){this.need(b.length);this.b.set(b,this.p);this.p+=b.length;}
  num(method,n,value){this.need(n)[method](this.p,value,true);this.p+=n;}
  i(v){this.num('setInt32',4,v);} u(v){this.num('setUint32',4,v);} long(v){this.num('setBigInt64',8,BigInt(v));}
  align(n=4){const end=Math.ceil(this.p/n)*n;this.need(end-this.p);this.b.fill(0,this.p,end);this.p=end;}
  string(s){const b=assetEncoder.encode(s);this.i(b.length);this.raw(b);this.align();}
  finish(){return this.b.slice(0,this.p);}
}
const assetNumbers={SInt8:['Int8',1],UInt8:['Uint8',1],char:['Uint8',1],short:['Int16',2],SInt16:['Int16',2],'unsigned short':['Uint16',2],UInt16:['Uint16',2],int:['Int32',4],SInt32:['Int32',4],'unsigned int':['Uint32',4],UInt32:['Uint32',4],'Type*':['Uint32',4],'long long':['BigInt64',8],SInt64:['BigInt64',8],'unsigned long long':['BigUint64',8],UInt64:['BigUint64',8],FileSize:['BigUint64',8],float:['Float32',4],double:['Float64',8],bool:['Uint8',1]};
function assetValue(node,io,value,writing=false){
  const scalar=assetNumbers[node.type];let result=value,align=!!(node.flags&0x4000);
  if(scalar){if(writing)io.num('set'+scalar[0],scalar[1],scalar[0].startsWith('Big')?BigInt(value):value);else result=io.num('get'+scalar[0],scalar[1]);}
  else if(node.type==='string'){if(writing)io.string(value);else result=io.string();}
  else if(node.type==='TypelessData'){if(writing){io.i(value.length);io.raw(value);}else result=io.raw(io.i());}
  else if(node.children[0]?.type==='Array'){
    const array=node.children[0],sub=array.children[1];align ||= !!(array.flags&0x4000);
    const n=writing?value.length:io.i();if(n<0||!Number.isSafeInteger(n))throw Error('Invalid asset array');
    if(writing)io.i(n);
    if(['UInt8','char','SInt8'].includes(sub.type)&&!(sub.flags&0x4000)){if(writing)io.raw(value instanceof Uint8Array?value:Uint8Array.from(value));else result=io.raw(n);}
    else {if(!writing){if(n>io.b.length-io.p)throw Error('Invalid asset array bounds');result=[];}for(let i=0;i<n;i++){const v=assetValue(sub,io,writing?value[i]:undefined,writing);if(!writing)result.push(v);}}
  }else if(node.children.length){if(!writing)result={};for(const child of node.children){const v=assetValue(child,io,writing?value[child.name]:undefined,writing);if(!writing)result[child.name]=v;}}
  else {if(node.size<0)throw Error('Unsupported asset field '+node.type);if(writing)io.raw(value);else result=io.raw(node.size);}
  if(align)io.align();return result;
}
function readAssetFile(bytes){
  const r=new AssetReader(bytes),header=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(header.getUint32(8)!==22||bytes[16]!==0)throw Error('Unsupported serialized asset format');
  const metadataSize=header.getUint32(20),dataOffset=Number(header.getBigInt64(32));
  if(Number(header.getBigInt64(24))!==bytes.length||dataOffset>bytes.length)throw Error('Asset file size mismatch');
  r.p=48;r.zero();r.i();if(!r.num('getUint8',1))throw Error('Asset schemas missing');
  const types=[],typeCount=r.i();if(typeCount<0||typeCount>bytes.length)throw Error('Asset type count');
  for(let t=0;t<typeCount;t++){
    const id=r.i();r.raw(1);const script=r.num('getInt16',2);if(id===114)r.raw(16);const hash=Array.from(r.raw(16)).join(',');
    const count=r.i(),stringLength=r.i(),nodes=[];if(count<1||count*32>bytes.length-r.p)throw Error('Asset schema bounds');
    for(let i=0;i<count;i++){r.raw(2);const level=r.num('getUint8',1);r.raw(1);const ty=r.u(),name=r.u(),size=r.i();r.i();const flags=r.i();r.raw(8);nodes.push({level,ty,name,size,flags,children:[]});}
    const strings=r.raw(stringLength),str=offset=>{if(offset>>>31){const s=assetCommonStrings[offset&0x7fffffff];if(s===undefined)throw Error('Unknown Unity common string');return s;}if(offset>=strings.length)throw Error('Schema string bounds');let end=offset;while(end<strings.length&&strings[end])end++;return assetDecoder.decode(strings.subarray(offset,end));};
    const stack=[];for(const node of nodes){node.type=str(node.ty);node.name=str(node.name);stack.length=node.level;if(node.level)stack[node.level-1].children.push(node);stack.push(node);}
    const deps=r.i();r.raw(deps*4);types.push({id,hash,root:nodes[0]});
  }
  const countPosition=r.p,objectCount=r.i();r.align();const tableStart=r.p,objects=[];
  if(objectCount<0||objectCount*24>bytes.length-r.p)throw Error('Asset object table bounds');
  for(let i=0;i<objectCount;i++){const id=r.long(),start=Number(r.long())+dataOffset,size=r.u(),typeIndex=r.i();if(start<dataOffset||start+size>bytes.length||!types[typeIndex])throw Error('Asset object bounds');objects.push({id,typeIndex,start,size,raw:bytes.subarray(start,start+size)});}
  const tableEnd=r.p,byId=new Map(objects.map(o=>[String(o.id),o]));
  const read=o=>{if(!o.tree){const rr=new AssetReader(o.raw);o.tree=assetValue(types[o.typeIndex].root,rr);if(rr.p!==o.raw.length)throw Error('Asset schema byte count mismatch');}return o.tree;};
  const save=()=>{
    const tableBytes=objects.length*24,metaEnd=48+metadataSize,delta=tableBytes-(tableEnd-tableStart),newDataOffset=Math.ceil((metaEnd+delta)/16)*16;
    let pos=0;const encoded=objects.map(o=>{pos=Math.ceil(pos/8)*8;const start=pos;let data=o.raw;if(o.changed){const w=new AssetWriter();assetValue(types[o.typeIndex].root,w,o.tree,true);data=w.finish();}pos+=data.length;return {o,start,data};});
    const out=new Uint8Array(newDataOffset+pos);out.set(bytes.subarray(0,tableStart));const v=new DataView(out.buffer);v.setInt32(countPosition,objects.length,true);
    let cursor=tableStart;for(const {o,start,data} of encoded){v.setBigInt64(cursor,o.id,true);v.setBigInt64(cursor+8,BigInt(start),true);v.setUint32(cursor+16,data.length,true);v.setInt32(cursor+20,o.typeIndex,true);cursor+=24;out.set(data,newDataOffset+start);}
    out.set(bytes.subarray(tableEnd,metaEnd),cursor);v.setUint32(20,metadataSize+delta);v.setBigInt64(24,BigInt(out.length));v.setBigInt64(32,BigInt(newDataOffset));return out;
  };
  return {bytes,types,objects,byId,read,save};
}
function readAssetBundle(data){return readAssetFile(rewriteBundle(data,()=>{},true));}
function readResourceManifest(data){const f=readAssetBundle(data);for(const o of f.objects)if(f.types[o.typeIndex].id===114){const t=f.read(o);if(Array.isArray(t.assetInfos)&&Array.isArray(t.bundleInfos))return t;}throw Error('Resource manifest schema not found');}
function resourceKoreanPath(path){return path.replaceAll('/jp/','/en_kr/').replace(/_jp(?=[_.])/g,'_en_kr');}
function discoverRuntimeImages(jp,kr){
  const lookup=new Map(kr.assetInfos.map(a=>[a.assetPath,a])),byFile=new Map(),bundles=new Map();
  for(const a of kr.assetInfos)if(a.assetPath.includes('/en_kr/')){const key=a.assetPath.split('/').at(-1);if(!byFile.has(key))byFile.set(key,[]);byFile.get(key).push(a);}
  for(const a of jp.assetInfos){if(!a.assetPath.includes('/jp/')||!/(?:\.png|\.jpe?g|_config\.json)$/i.test(a.assetPath))continue;const target=resourceKoreanPath(a.assetPath);let b=lookup.get(target),method='exact';
    if(!b){const candidates=byFile.get(target.split('/').at(-1))||[];let best=-1,winners=[];for(const candidate of candidates){const aa=target.split('/').reverse(),bb=candidate.assetPath.split('/').reverse();let score=0;while(score<Math.min(aa.length,bb.length)&&aa[score]===bb[score])score++;if(score>best){best=score;winners=[candidate];}else if(score===best)winners.push(candidate);}if(winners.length===1){b=winners[0];method='moved-path';}}
    if(!b)continue;const name=jp.bundleInfos[a.ownerBundleIndex]?.name,source=kr.bundleInfos[b.ownerBundleIndex]?.name;if(!name||!source)continue;if(!bundles.has(name))bundles.set(name,{name,sources:new Set(),paths:[],matches:[]});const p=bundles.get(name);p.sources.add(source);p.paths.push(a.assetPath);p.matches.push({jp:a.assetPath,kr:b.assetPath,method});}
  return [...bundles.values()].map(p=>({...p,sources:[...p.sources]}));
}
function cloneAsset(v){if(v instanceof Uint8Array)return v;if(Array.isArray(v))return v.map(cloneAsset);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,cloneAsset(x)]));return v;}
function autoPatchImages(original,sources){
  const jp=readAssetBundle(original),kr=sources.map(readAssetBundle),classOf=(f,o)=>f.types[o.typeIndex].id;
  const textures=new Map(),sprites=new Map(),jpTextures=jp.objects.filter(o=>classOf(jp,o)===28),jpSprites=jp.objects.filter(o=>classOf(jp,o)===213);
  for(const f of kr)for(const o of f.objects){const id=classOf(f,o);if(id===213){const tree=f.read(o);if(!sprites.has(tree.m_Name))sprites.set(tree.m_Name,{f,o,tree});}if(id===28){const tree=f.read(o),name=resourceKoreanPath(tree.m_Name.replace(/_jp(?=[_.]|$)/g,'_en_kr'));if(!textures.has(name))textures.set(name,{f,o,tree});}}
  const spriteTextureIds=new Set(jpSprites.map(o=>String(jp.read(o).m_RD.texture.m_PathID)));
  const identity=jp.read(jp.objects.find(o=>classOf(jp,o)===142)).m_Name;
  let changed=0;const imports=new Map(),destType=jp.types.findIndex(t=>t.id===28);
  const importTexture=(f,id)=>{
    const cacheKey=kr.indexOf(f)+':'+id;if(imports.has(cacheKey))return imports.get(cacheKey);
    const src=f.byId.get(String(id));if(!src||classOf(f,src)!==28||destType<0||f.types[src.typeIndex].hash!==jp.types[destType].hash)throw Error('Texture schema changed');
    const tree=cloneAsset(f.read(src));if(tree.m_StreamData?.path)throw Error('External texture stream');
    const sourceIdentity=f.read(f.objects.find(o=>classOf(f,o)===142)).m_Name;
    let oid=14695981039346656037n;for(const byte of assetEncoder.encode(identity+':KR:'+sourceIdentity+':'+id)){oid=BigInt.asUintN(64,(oid^BigInt(byte))*1099511628211n);}oid=BigInt.asIntN(64,oid);
    while(oid===0n||jp.byId.has(String(oid)))oid=BigInt.asIntN(64,oid+1n);tree.m_Name='kr_patch_'+tree.m_Name;
    const object={id:oid,typeIndex:destType,tree,changed:true,raw:new Uint8Array()};jp.objects.push(object);jp.byId.set(String(oid),object);imports.set(cacheKey,oid);return oid;
  };
  for(const o of jpSprites){const before=jp.read(o),entry=sprites.get(before.m_Name);if(!entry)continue;const {f,tree:source}=entry;
    if(jp.types[o.typeIndex].hash!==f.types[entry.o.typeIndex].hash)continue;
    if(before.m_PixelsToUnits!==source.m_PixelsToUnits||before.m_Pivot.x!==source.m_Pivot.x||before.m_Pivot.y!==source.m_Pivot.y||source.m_SpriteAtlas.m_PathID!==0n||source.m_RD.texture.m_FileID!==0||source.m_RD.alphaTexture.m_PathID!==0n||source.m_RD.secondaryTextures?.length)continue;
    const tree=cloneAsset(source),sx=before.m_Rect.width/source.m_Rect.width,sy=before.m_Rect.height/source.m_Rect.height;if(!Number.isFinite(sx)||!Number.isFinite(sy)||sx<=0||sy<=0)continue;
    if(sx!==1||sy!==1){const rd=tree.m_RD,vd=rd.m_VertexData,ch=vd.m_Channels;if(ch[0].stream!==0||ch[0].offset!==0||ch[0].format!==0||ch[0].dimension!==3||ch.slice(1).some(c=>c.stream===0&&c.dimension))continue;
      vd.m_DataSize=vd.m_DataSize.slice();const v=new DataView(vd.m_DataSize.buffer,vd.m_DataSize.byteOffset,vd.m_DataSize.byteLength);for(let i=0;i<vd.m_VertexCount;i++){v.setFloat32(i*12,v.getFloat32(i*12,true)*sx,true);v.setFloat32(i*12+4,v.getFloat32(i*12+4,true)*sy,true);}
      rd.uvTransform.x/=sx;rd.uvTransform.z/=sy;for(const sub of rd.m_SubMeshes)for(const k of ['m_Center','m_Extent']){sub.localAABB[k].x*=sx;sub.localAABB[k].y*=sy;}
      for(const k of ['x','y']){const scale=k==='x'?sx:sy;tree.m_Offset[k]*=scale;rd.textureRectOffset[k]*=scale;}for(const k of ['x','y','z','w'])tree.m_Border[k]*=(k==='x'||k==='z'?sx:sy);
    }
    tree.m_Rect.width=before.m_Rect.width;tree.m_Rect.height=before.m_Rect.height;tree.m_RD.texture={m_FileID:0,m_PathID:importTexture(f,source.m_RD.texture.m_PathID)};o.tree=tree;o.changed=true;changed++;
  }
  // Standalone Texture2D users have no Sprite reference; match their names as well.
  for(const o of jpTextures){const old=jp.read(o),key=resourceKoreanPath(old.m_Name.replace(/_jp(?=[_.]|$)/g,'_en_kr')),entry=textures.get(key);if(!entry||spriteTextureIds.has(String(o.id)))continue;
    if(jp.types[o.typeIndex].hash!==entry.f.types[entry.o.typeIndex].hash||entry.tree.m_StreamData?.path)continue;
    const tree=cloneAsset(entry.tree);tree.m_Name=old.m_Name;
    if(tree.m_Width!==old.m_Width||tree.m_Height!==old.m_Height){if(![4,12].includes(tree.m_TextureFormat)||tree.m_MipCount!==1)continue;const pixels=tree.m_TextureFormat===4?tree['image data']:decodeBC3(tree['image data'],tree.m_Width,tree.m_Height),out=new Uint8Array(old.m_Width*old.m_Height*4);for(let y=0;y<old.m_Height;y++)for(let x=0;x<old.m_Width;x++){const sx=Math.min(tree.m_Width-1,Math.floor((x+.5)*tree.m_Width/old.m_Width)),sy=Math.min(tree.m_Height-1,Math.floor((y+.5)*tree.m_Height/old.m_Height));out.set(pixels.subarray((sy*tree.m_Width+sx)*4,(sy*tree.m_Width+sx)*4+4),(y*old.m_Width+x)*4);}tree.m_TextureFormat=4;tree.m_Width=old.m_Width;tree.m_Height=old.m_Height;tree.m_CompleteImageSize=out.length;tree['image data']=out;}
    o.tree=tree;o.changed=true;changed++;
  }
  if(!changed)return {bytes:new Uint8Array(original),changed:0};const rebuilt=jp.save();return {bytes:rewriteBundle(original,()=>rebuilt),changed};
}

// Only translate known presentation labels in the Yostar web SDK root.
// Never inspect/change input values, form actions, links, handlers, or SDK state.
function installLoginTranslation(doc = document) {
  const labels = new Map(Object.entries({
    'メールアドレス': '이메일 주소',
    '認証コード': '인증 코드',
    '送信': '전송',
    'ログイン': '로그인',
    'その他のログイン方法': '다른 로그인 방법',
    'キャンセル': '취소',
    'アカウント作成': '계정 만들기',
    '連携しているゲームアカウントが見つかりませんでした。新しいアカウントを作成しますか？': '연동된 게임 계정을 찾을 수 없습니다. 새 계정을 만드시겠습니까?',
    'メールアドレスを入力してください': '이메일 주소를 입력해 주세요',
    '正しいメールアドレスを入力してください': '올바른 이메일 주소를 입력해 주세요',
    '認証コードを入力してください': '인증 코드를 입력해 주세요',
    '正しい認証コードを入力してください': '올바른 인증 코드를 입력해 주세요',
    '送信しました': '전송했습니다',
    '確認': '확인',
    '戻る': '뒤로',
    '閉じる': '닫기',
    '再送信': '다시 전송',
    'アカウントを切り替えますか？': '계정을 전환하시겠습니까?',
    '利用規約': '이용약관',
    'プライバシーポリシー': '개인정보 처리방침',
    '規約確認': '약관 확인',
    'アカウント連携': '계정 연동',
    '連携': '연동',
    '未連携': '연동 안 됨',
    'Eメール': '이메일'
  }));
  const translate = text => {
    if (typeof text !== 'string') return text;
    const clean = text.trim(), replacement = labels.get(clean);
    return replacement ? text.replace(clean, replacement) : text;
  };
  let queued = false;
  const scan = () => {
    queued = false;
    const root = doc.getElementById('web-sdk-root');
    if (!root) return;
    const walker = doc.createTreeWalker(root, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement || node.parentElement.closest('input,textarea,script,style,[contenteditable="true"]')) continue;
      const next = translate(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
    }
    for (const element of root.querySelectorAll('[placeholder],[aria-label],[title]')) {
      for (const attribute of ['placeholder', 'aria-label', 'title']) {
        const old = element.getAttribute(attribute), next = translate(old);
        if (old !== next) element.setAttribute(attribute, next);
      }
    }
  };
  const Observer = doc.defaultView.MutationObserver;
  const observer = new Observer(() => {
    if (!queued) { queued = true; queueMicrotask(scan); }
  });
  const start = () => {
    observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder','aria-label','title'] });
    scan();
  };
  if (doc.documentElement) start(); else doc.addEventListener('DOMContentLoaded', start, { once: true });
  return () => observer.disconnect();
}
function installPageTitle(doc = document) {
  const label = '작혼';
  const update = () => { if (doc.head && doc.title !== label) doc.title = label; };
  const start = () => {
    if (!doc.head) return;
    const observer = new doc.defaultView.MutationObserver(update);
    observer.observe(doc.head, { childList: true, subtree: true, characterData: true });
    update();
  };
  if (doc.head) start(); else doc.addEventListener('DOMContentLoaded', start, { once: true });
}

installLoginTranslation(); installPageTitle();
(function(){
  'use strict';
  const nativeFetch=window.fetch,sourceCache=new Map();let entries=new Map(),ready=false,images=0,lua=0;
  const status=(message,error=false)=>{console[error?'warn':'info']('[JP Korean] '+message);const draw=()=>{let badge=document.getElementById('jp-korean-status');if(!badge){badge=document.createElement('div');badge.id='jp-korean-status';badge.style.cssText='position:fixed;left:8px;top:8px;z-index:2147483647;padding:6px 10px;background:#111d;color:#fff;font:12px sans-serif;pointer-events:none';document.documentElement.appendChild(badge);}badge.textContent=message;};if(document.documentElement)draw();else document.addEventListener('DOMContentLoaded',draw,{once:true});};
  const locationOf=value=>{try{const u=new URL(typeof value==='string'?value:value.url||String(value),location.href);if(!['appstatic.mahjongsoul.com','appstaticbk.mahjongsoul.com'].includes(u.hostname)||!/^\/v[^/]+\/jp\/resources\/ab\/WebGL\/DXT\//.test(u.pathname))return null;return u;}catch{return null;}};
  let root='/v4/jp/resources/ab/WebGL/DXT/',krRoot='https://appstatic.mahjongsoul.com/v4/en/resources/ab/WebGL/DXT/';
  const download=async(name,size)=>{const url=krRoot+encodeURIComponent(name),manifest=name==='bundle_info_so.majset';if(manifest)sourceCache.delete(url);if(!sourceCache.has(url))sourceCache.set(url,(async()=>{const response=await Reflect.apply(nativeFetch,window,[url,{credentials:'omit',cache:manifest?'no-cache':'force-cache'}]);if(!response.ok)throw Error('KR download HTTP '+response.status);const bytes=await response.arrayBuffer();if(size!==undefined&&size!==bytes.byteLength)throw Error('KR manifest file size mismatch');return bytes;})());try{return await sourceCache.get(url);}catch(e){sourceCache.delete(url);throw e;}};
  const aliasFor=async p=>{const data=assetEncoder.encode('jakhon-beta12:'+p.name+':'+(p.sources||[]).slice().sort().join('|')+':'+(p.modules||[]).join('|'));const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),b=>b.toString(16).padStart(2,'0')).join('');if(p.name.length<8||assetEncoder.encode(p.name).length!==p.name.length)throw Error('Unsupported bundle name');return 'k12'+hash.repeat(Math.ceil(p.name.length/64)).slice(0,p.name.length-3);};
  const luaEntries=jp=>{const names=new Set(['LangMgr.lua','GameMgr.lua','UI_Notice.lua','GatewayFetcher.lua']),found=new Map();for(const a of jp.assetInfos){const base=a.assetPath.split('/').at(-1).replace(/\.bytes$/,'');if(!names.has(base))continue;const name=jp.bundleInfos[a.ownerBundleIndex]?.name;if(!name)continue;if(!found.has(name))found.set(name,{name,modules:[],mode:'lua'});found.get(name).modules.push(base);}return [...found.values()];};
  const prepare=async data=>{
    const jpFile=readAssetBundle(data),manifestObject=jpFile.objects.find(o=>jpFile.types[o.typeIndex].id===114&&Array.isArray(jpFile.read(o).bundleInfos));if(!manifestObject)throw Error('JP manifest missing');const jp=jpFile.read(manifestObject);let kr=null;
    try{kr=readResourceManifest(await download('bundle_info_so.majset'));}catch(e){status('beta.12 · 한국어 리소스 목록을 받지 못해 이미지 원본 유지: '+e.message,true);}
    const list=luaEntries(jp),krSizes=kr?new Map(kr.bundleInfos.map(b=>[b.name,b.fileSize])):new Map();
    if(kr)for(const p of discoverRuntimeImages(jp,kr))list.push({...p,mode:'image',sourceSizes:p.sources.map(n=>krSizes.get(n))});
    const byName=new Map();for(const p of list){if(byName.has(p.name))throw Error('Overlapping Lua/image bundle');p.alias=await aliasFor(p);byName.set(p.name,p);}
    entries=new Map(list.map(p=>[p.alias,p]));for(const b of jp.bundleInfos){const p=byName.get(b.name);if(p)b.name=p.alias;}
    manifestObject.changed=true;ready=true;
    console.info('[JP Korean] Runtime resource mapping',list.filter(p=>p.mode==='image').map(p=>({jpBundle:p.name,krBundles:p.sources,matches:p.matches})));
    status('한국어 패치 beta.12 · 최신 경로 자동 연결 '+list.filter(p=>p.mode==='image').length+'개 묶음');return rewriteBundle(data,()=>jpFile.save()).buffer;
  };
  const makeResponse=(response,body)=>{const headers=new Headers(response.headers);headers.delete('content-encoding');headers.delete('content-length');headers.delete('etag');return new Response(body,{status:response.status,statusText:response.statusText,headers});};
  window.fetch=async function(...args){
    const url=locationOf(args[0]);if(!url)return Reflect.apply(nativeFetch,this,args);
    if(url.pathname.endsWith('/bundle_info_so.majset')){root=url.pathname.slice(0,-'bundle_info_so.majset'.length);krRoot='https://appstatic.mahjongsoul.com'+root.replace('/jp/','/en/');}
    const file=decodeURIComponent(url.pathname.slice(root.length)),p=entries.get(file),manifest=file==='bundle_info_so.majset';
    if(p){url.pathname=root+encodeURIComponent(p.name);args[0]=args[0] instanceof Request?new Request(url.href,args[0]):url.href;}
    const response=await Reflect.apply(nativeFetch,this,args);if(!response.ok||(!p&&!manifest))return response;
    const original=await response.arrayBuffer();try{
      if(manifest)return makeResponse(response,await prepare(original));
      if(p.mode==='lua'){const patched=patchBundle(original,p.modules);lua++;return makeResponse(response,patched);}
      const sources=await Promise.all(p.sources.map((n,i)=>download(n,p.sourceSizes[i]))),patched=autoPatchImages(original,sources);images+=patched.changed;
      console.info('[JP Korean] Auto image patch',p.paths[0],patched.changed+' objects');status('한국어 패치 beta.12 · 자동 이미지 교체 '+images+'개 / 공지는 일본어');return makeResponse(response,patched.bytes);
    }catch(e){console.warn('[JP Korean] Original resource retained',p?.paths?.[0]||file,e.message);return makeResponse(response,original);}
  };
  const NativeXHR=window.XMLHttpRequest;
  window.XMLHttpRequest=new Proxy(NativeXHR,{construct(target,args){const xhr=Reflect.construct(target,args),open=xhr.open;let p=null;xhr.open=function(method,value,...rest){const url=locationOf(value);p=url?entries.get(decodeURIComponent(url.pathname.slice(root.length))):null;if(p){url.pathname=root+encodeURIComponent(p.name);value=url.href;}return Reflect.apply(open,this,[method,value,...rest]);};xhr.addEventListener('readystatechange',()=>{if(xhr.readyState!==4||xhr.status!==200||xhr.responseType!=='arraybuffer'||!p)return;if(p.mode==='lua'){try{Object.defineProperty(xhr,'response',{configurable:true,value:patchBundle(xhr.response,p.modules).buffer});}catch(e){console.warn('[JP Korean] XHR original retained',e.message);}}});return xhr;}});
  status('한국어 패치 beta.12 · 최신 JP/KR 리소스 목록 대기');
  setTimeout(()=>{if(!ready)status('beta.12 · 리소스 자동 연결 미적용: 실행 권한·리소스 형식 확인 필요',true);},90000);
})();

})();
