"use strict";
// UI mechanism only: the BFF owns identity and private binding.
// The same-origin guard provides genuine session refresh and updates its CSRF cache.
// Capability alone never grants READ; current availability must confirm the own slot.
// current/reject use presentation references only; no cookie/actor/credential is created.
// Integration: explicit Afiliados resolves prepareSelection(UI brand), then ready(brand)
// and read({ini,fim},{signal}). Selection alone never grants READ or probes business data.
// Legacy /api/tts and WRITE code stay untouched. Do not reuse this reference for thumbnails/WRITE.
const CONTRACT = Object.freeze({
  schema:'shrigma-affiliate-read-availability-v1', route:'/api/affiliate-read',
  availabilityMethod:'GET', readMethod:'POST', credentials:'same-origin', deadlineMs:35000, write:false,
  requestFields:Object.freeze(['brand','ini','fim','expected_binding']),
  availabilityFields:Object.freeze(['schema','brand','readLinked','binding','readOnly']),
  feature:'features.affiliateRead', bindingType:'lowercase-hex64-public-version-HMAC',
  expectedBindingAuthenticates:false, sessionRefreshBeforeAndAfter:true,
});
const plain=x=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const brands=['fish','aristo'];
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(x);
const uiRef=x=>typeof x==='string'&&/^ui-[a-f0-9]{16,128}$/.test(x);
const bindingRef=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const fail=(code,status=0)=>Object.assign(new Error(code),{code,status});
function sessionContext(state) {
  const u=state?.user;
  if(!plain(state)||state.authenticated!==true||state.features?.affiliateRead!==true||!plain(u)||!uuid(u.id)||
    !uiRef(state.uiKey)||typeof state.csrf!=='string'||!state.csrf) return null;
  const manager=u.role==='manager'&&Array.isArray(u.brands)&&new Set(u.brands).size===u.brands.length&&u.brands.every(b=>['fish','aristo','olivas'].includes(b))&&(u.brandAccess==='single'&&u.brands.length===1&&u.brands[0]===u.brand||u.brandAccess==='multiple'&&u.brand===null&&u.brands.length>=2&&u.brands.length<=3);
  const master=u.role==='superadmin'&&u.brandAccess==='all'&&u.brand===null&&Array.isArray(u.brands)&&u.brands.length===2&&new Set(u.brands).size===2&&brands.every(b=>u.brands.includes(b));
  if(!manager&&!master)return null;
  return {principalId:u.id,role:u.role,brands:manager?[...u.brands]:[...brands],uiReference:state.uiKey,
    // Kept privately in page memory; never returned/logged/transmitted by this adapter.
    signature:JSON.stringify([u.id,u.role,u.brandAccess,u.brand,[...u.brands].sort(),state.uiKey,state.csrf])};
}
function period(p) {
  const day=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x;
  if(!plain(p)||Object.keys(p).sort().join(',')!=='fim,ini'||!day(p.ini)||!day(p.fim)||p.ini>p.fim)throw fail('AFFILIATE_WINDOW_INVALID',400);
  return {ini:p.ini,fim:p.fim};
}
function create({fetchImpl,getSession,refreshSession,onInvalidate=()=>{}}={}) {
  if(![fetchImpl,getSession,refreshSession,onInvalidate].every(x=>typeof x==='function'))throw fail('AFFILIATE_GUARD_INTERFACE_REQUIRED');
  let signature=null,session=null,bound=null,epoch=0,blocked=null,disposed=false,readySequence=0,activeReady=null;
  const pending=new Set();
  const key=x=>JSON.stringify([x.sessionSignature,x.brand,x.binding]);
  function notify(){try{onInvalidate({code:'AFFILIATE_READ_INVALIDATED',epoch});}catch(_){}}
  function invalidate(except){bound=null;epoch++;for(const c of pending)if(c!==except)c.abort();notify();}
  function sync(except){
    let next=null;if(!disposed)try{next=sessionContext(getSession());}catch(_){}
    const sig=next?.signature||null;
    if(sig!==signature){
      const hadContext=signature!==null||bound!==null;
      signature=sig;bound=null;epoch++;for(const c of pending)if(c!==except)c.abort();if(hadContext)notify();
    }
    session=next;return next;
  }
  function current(role){sync();return role==='read'&&bound&&key(bound)!==blocked?bound.reference:'';}
  function reject(role,expectedReference){
    sync();if(role!=='read'||!bound||bound.reference!==expectedReference)return false;
    blocked=key(bound);invalidate();return true;
  }
  function dispose(){if(disposed)return;disposed=true;signature=null;session=null;invalidate();}
  function operation(options){
    if(!plain(options)||Object.keys(options).some(k=>k!=='signal')||options.signal!==undefined&&
      (!options.signal||typeof options.signal.addEventListener!=='function'||typeof options.signal.aborted!=='boolean'))throw fail('AFFILIATE_READ_OPTIONS_INVALID',400);
    const controller=new AbortController();let timedOut=false;
    const cancel=()=>controller.abort();options.signal?.addEventListener('abort',cancel,{once:true});if(options.signal?.aborted)cancel();
    const timeout=setTimeout(()=>{timedOut=true;cancel();},CONTRACT.deadlineMs);pending.add(controller);
    const abortError=()=>fail(timedOut?'AFFILIATE_READ_TIMEOUT':'AFFILIATE_READ_ABORTED');
    const bounded=promise=>new Promise((resolve,rejectPromise)=>{
      const aborted=()=>rejectPromise(abortError());if(controller.signal.aborted){aborted();return;}
      controller.signal.addEventListener('abort',aborted,{once:true});
      Promise.resolve(promise).then(resolve,rejectPromise).finally(()=>controller.signal.removeEventListener('abort',aborted));
    });
    return {controller,bounded,abortError,check(){if(controller.signal.aborted)throw abortError();},
      close(){clearTimeout(timeout);pending.delete(controller);options.signal?.removeEventListener('abort',cancel);}};
  }
  async function fetchJson(url,method,body,op){
    op.check();let r;
    try{r=await op.bounded(fetchImpl(url,{method,headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),credentials:'same-origin',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:op.controller.signal}));}
    catch(_){op.check();throw fail('AFFILIATE_READ_UNAVAILABLE',502);}
    if(r?.status===401||r?.status===403){
      // Do not revoke a later binding on behalf of an obsolete operation.
      throw fail('AFFILIATE_ACCESS_REJECTED',r.status);
    }
    if(!r?.ok)throw fail('AFFILIATE_READ_UNAVAILABLE',[429,500,502,503,504].includes(r?.status)?r.status:502);
    try{return await op.bounded(r.json());}catch(_){op.check();throw fail('AFFILIATE_RESPONSE_INVALID',502);}
  }
  async function context(brand,op){
    op.check();try{await op.bounded(refreshSession({signal:op.controller.signal}));}
    catch(_){op.check();throw fail('AFFILIATE_SESSION_UNCONFIRMED',401);}
    const s=sync(op.controller);if(!s||!s.brands.includes(brand))return null;
    const data=await fetchJson(CONTRACT.route+'?brand='+brand,'GET',null,op);
    if(sync(op.controller)?.signature!==s.signature)throw fail('AFFILIATE_READ_REPLACED');
    if(!plain(data)||Object.keys(data).sort().join(',')!=='binding,brand,readLinked,readOnly,schema'||data.schema!==CONTRACT.schema||data.brand!==brand||data.readOnly!==true||
      typeof data.readLinked!=='boolean'||(data.readLinked?!bindingRef(data.binding):data.binding!==null))throw fail('AFFILIATE_AVAILABILITY_INVALID',502);
    return data.readLinked?{brand,binding:data.binding,sessionSignature:s.signature,uiReference:s.uiReference}:null;
  }
  async function prepareSelection(requestedBrand,options={}){
    if(disposed)return null;
    sync();const op=operation(options);
    try{
      op.check();try{await op.bounded(refreshSession({signal:op.controller.signal}));}
      catch(_){op.check();throw fail('AFFILIATE_SESSION_UNCONFIRMED',401);}
      const s=sync(op.controller);if(!s)return null;
      if(requestedBrand==='olivas'&&s.role==='superadmin'&&getSession()?.user?.viewBrands?.includes('olivas')){if(bound)invalidate(op.controller);return 'olivas';}
      const selected=s.role==='manager'&&s.brands.length===1?s.brands[0]:s.brands.includes(requestedBrand)?requestedBrand:s.brands[0];
      if(bound&&bound.brand!==selected)invalidate(op.controller);
      return selected;
    }finally{op.close();}
  }
  async function ready(brand,options={}){
    if(!brands.includes(brand))throw fail(brand==='olivas'?'AFFILIATE_BRAND_CONTRACT_NOT_READY':'AFFILIATE_BRAND_REQUIRED',brand==='olivas'?503:400);
    if(disposed)return false;
    // A fresh check of the same session/source binding must not invalidate valid UI cache.
    sync();if(bound&&bound.brand!==brand)invalidate();
    if(activeReady)activeReady.abort();const sequence=++readySequence,op=operation(options);activeReady=op.controller;
    try{
      const found=await context(brand,op);
      if(sequence!==readySequence||disposed)throw fail('AFFILIATE_READ_REPLACED');
      if(!found||key(found)===blocked){if(bound)invalidate(op.controller);return false;}
      if(bound&&key(bound)===key(found))return true;
      if(bound)invalidate(op.controller);else epoch++;
      bound={...found,reference:'affiliate-session:'+found.uiReference+':'+epoch};return true;
    }catch(e){if(sequence===readySequence&&bound)invalidate(op.controller);throw e;}
    finally{if(activeReady===op.controller)activeReady=null;op.close();}
  }
  async function read(request,options={}){
    const p=period(request);sync();const captured=bound;
    if(disposed||!captured||key(captured)===blocked)throw fail('AFFILIATE_READ_NOT_READY',403);
    const op=operation(options);
    const unchanged=found=>found&&key(found)===key(captured)&&bound?.reference===captured.reference;
    try{
      const before=await context(captured.brand,op);
      if(!unchanged(before)){invalidate(op.controller);throw fail('AFFILIATE_BINDING_REPLACED');}
      const data=await fetchJson(CONTRACT.route,'POST',{brand:captured.brand,ini:p.ini,fim:p.fim,expected_binding:captured.binding},op);
      const after=await context(captured.brand,op);
      if(!unchanged(after)){invalidate(op.controller);throw fail('AFFILIATE_BINDING_REPLACED');}
      if(!plain(data)||data.error||data.erro||data.brandAccess!=='single'||data.brand!==captured.brand||!Array.isArray(data.brands)||
        data.brands.length!==1||data.brands[0]!==captured.brand||!plain(data.janela)||data.janela.ini!==p.ini||data.janela.fim!==p.fim)throw fail('AFFILIATE_RESPONSE_UNSCOPED',502);
      return data;
    }catch(e){if(e.code==='AFFILIATE_ACCESS_REJECTED')reject('read',captured.reference);throw e;}
    finally{op.close();}
  }
  return Object.freeze({prepareSelection,ready,current,reject,read,sync:()=>{sync();},dispose});
}
module.exports={create,CONTRACT};
