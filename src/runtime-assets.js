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
if(typeof module!=='undefined')module.exports={AssetReader,AssetWriter,assetValue,readAssetFile,readAssetBundle,readResourceManifest,resourceKoreanPath,discoverRuntimeImages,autoPatchImages};
