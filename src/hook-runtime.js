(function(){
  'use strict';
  const nativeFetch=window.fetch,sourceCache=new Map();let entries=new Map(),ready=false,images=0,lua=0;
  const status=(message,error=false)=>{console[error?'warn':'info']('[JP Korean] '+message);const draw=()=>{let badge=document.getElementById('jp-korean-status');if(!badge){badge=document.createElement('div');badge.id='jp-korean-status';badge.style.cssText='position:fixed;left:8px;top:8px;z-index:2147483647;padding:6px 10px;background:#111d;color:#fff;font:12px sans-serif;pointer-events:none';document.documentElement.appendChild(badge);}badge.textContent=message;};if(document.documentElement)draw();else document.addEventListener('DOMContentLoaded',draw,{once:true});};
  const locationOf=value=>{try{const u=new URL(typeof value==='string'?value:value.url||String(value),location.href);if(!['appstatic.mahjongsoul.com','appstaticbk.mahjongsoul.com'].includes(u.hostname)||!/^\/v[^/]+\/jp\/resources\/ab\/WebGL\/DXT\//.test(u.pathname))return null;return u;}catch{return null;}};
  let root='/v4/jp/resources/ab/WebGL/DXT/',krRoot='https://appstatic.mahjongsoul.com/v4/en/resources/ab/WebGL/DXT/';
  const download=async(name,size)=>{const url=krRoot+encodeURIComponent(name),manifest=name==='bundle_info_so.majset';if(manifest)sourceCache.delete(url);if(!sourceCache.has(url))sourceCache.set(url,(async()=>{const response=await Reflect.apply(nativeFetch,window,[url,{credentials:'omit',cache:manifest?'no-cache':'force-cache'}]);if(!response.ok)throw Error('KR download HTTP '+response.status);const bytes=await response.arrayBuffer();if(size!==undefined&&size!==bytes.byteLength)throw Error('KR manifest file size mismatch');return bytes;})());try{return await sourceCache.get(url);}catch(e){sourceCache.delete(url);throw e;}};
  const aliasFor=async p=>{const data=assetEncoder.encode('jakhon-beta11:'+p.name+':'+(p.sources||[]).slice().sort().join('|')+':'+(p.modules||[]).join('|'));const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),b=>b.toString(16).padStart(2,'0')).join('');if(p.name.length<8||assetEncoder.encode(p.name).length!==p.name.length)throw Error('Unsupported bundle name');return 'k11'+hash.repeat(Math.ceil(p.name.length/64)).slice(0,p.name.length-3);};
  const luaEntries=jp=>{const names=new Set(['LangMgr.lua','GameMgr.lua','UI_Notice.lua','GatewayFetcher.lua']),found=new Map();for(const a of jp.assetInfos){const base=a.assetPath.split('/').at(-1).replace(/\.bytes$/,'');if(!names.has(base))continue;const name=jp.bundleInfos[a.ownerBundleIndex]?.name;if(!name)continue;if(!found.has(name))found.set(name,{name,modules:[],mode:'lua'});found.get(name).modules.push(base);}return [...found.values()];};
  const prepare=async data=>{
    const jpFile=readAssetBundle(data),manifestObject=jpFile.objects.find(o=>jpFile.types[o.typeIndex].id===114&&Array.isArray(jpFile.read(o).bundleInfos));if(!manifestObject)throw Error('JP manifest missing');const jp=jpFile.read(manifestObject);let kr=null;
    try{kr=readResourceManifest(await download('bundle_info_so.majset'));}catch(e){status('beta.11 · 한국어 리소스 목록을 받지 못해 이미지 원본 유지: '+e.message,true);}
    const list=luaEntries(jp),krSizes=kr?new Map(kr.bundleInfos.map(b=>[b.name,b.fileSize])):new Map();
    if(kr)for(const p of discoverRuntimeImages(jp,kr))list.push({...p,mode:'image',sourceSizes:p.sources.map(n=>krSizes.get(n))});
    const byName=new Map();for(const p of list){if(byName.has(p.name))throw Error('Overlapping Lua/image bundle');p.alias=await aliasFor(p);byName.set(p.name,p);}
    entries=new Map(list.map(p=>[p.alias,p]));for(const b of jp.bundleInfos){const p=byName.get(b.name);if(p)b.name=p.alias;}
    manifestObject.changed=true;ready=true;
    console.info('[JP Korean] Runtime resource mapping',list.filter(p=>p.mode==='image').map(p=>({jpBundle:p.name,krBundles:p.sources,matches:p.matches})));
    status('한국어 패치 beta.11 · 최신 경로 자동 연결 '+list.filter(p=>p.mode==='image').length+'개 묶음');return rewriteBundle(data,()=>jpFile.save()).buffer;
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
      console.info('[JP Korean] Auto image patch',p.paths[0],patched.changed+' objects');status('한국어 패치 beta.11 · 자동 이미지 교체 '+images+'개 / 공지는 일본어');return makeResponse(response,patched.bytes);
    }catch(e){console.warn('[JP Korean] Original resource retained',p?.paths?.[0]||file,e.message);return makeResponse(response,original);}
  };
  const NativeXHR=window.XMLHttpRequest;
  window.XMLHttpRequest=new Proxy(NativeXHR,{construct(target,args){const xhr=Reflect.construct(target,args),open=xhr.open;let p=null;xhr.open=function(method,value,...rest){const url=locationOf(value);p=url?entries.get(decodeURIComponent(url.pathname.slice(root.length))):null;if(p){url.pathname=root+encodeURIComponent(p.name);value=url.href;}return Reflect.apply(open,this,[method,value,...rest]);};xhr.addEventListener('readystatechange',()=>{if(xhr.readyState!==4||xhr.status!==200||xhr.responseType!=='arraybuffer'||!p)return;if(p.mode==='lua'){try{Object.defineProperty(xhr,'response',{configurable:true,value:patchBundle(xhr.response,p.modules).buffer});}catch(e){console.warn('[JP Korean] XHR original retained',e.message);}}});return xhr;}});
  status('한국어 패치 beta.11 · 최신 JP/KR 리소스 목록 대기');
  setTimeout(()=>{if(!ready)status('beta.11 · 리소스 자동 연결 미적용: 실행 권한·리소스 형식 확인 필요',true);},90000);
})();
