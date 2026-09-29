'use strict';
// In-memory HTTP adapter; no listener, published route or scheduler.
const D=require('./ab-audience-admission-contract.cjs'),I=require('./ab-audience-admission-inspect.cjs'),H=require('./segment-audience-review.cjs');
const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===k.length&&k.every(x=>Object.hasOwn(o,x));
const response=(status,body)=>({status,headers:{'Cache-Control':'no-store'},body});
const fail=(code,status)=>Object.assign(Error(code),{code,status});
function copy(v){const text=H.canonical(v);if(Buffer.byteLength(text)>20000)throw fail('AB_ADMISSION_HTTP_SIZE',413);return JSON.parse(text);}
function parse(value){try{
 const v=copy(value);if(!exact(v,['method','request'])||v.method!=='GET')throw fail('AB_ADMISSION_HTTP_METHOD',405);
 const r=v.request;if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['headers','query','body'].includes(k))||!r.headers||typeof r.headers!=='object'||Array.isArray(r.headers)||r.body!==undefined&&!exact(r.body,[]))throw fail('AB_ADMISSION_HTTP_INPUT',400);
 const entries=Object.entries(r.headers),auth=entries.filter(([k])=>k.toLowerCase()==='authorization'),origin=entries.filter(([k])=>k.toLowerCase()==='origin');
 if(auth.length!==1||typeof auth[0][1]!=='string'||!/^Bearer [a-z0-9-]{8,128}$/.test(auth[0][1]))throw fail('SEGMENT_UNAUTHORIZED',401);
 if(origin.length>1||origin.length===1&&origin[0][1]!=='https://bandssz.github.io')throw fail('AB_ADMISSION_HTTP_ORIGIN',403);
 return {key:auth[0][1].slice(7),request:D.request(r.query)};
 }catch(e){const allowed=['AB_ADMISSION_HTTP_SIZE','AB_ADMISSION_HTTP_METHOD','AB_ADMISSION_HTTP_INPUT','AB_ADMISSION_HTTP_ORIGIN','SEGMENT_UNAUTHORIZED'];return {response:response(allowed.includes(e?.code)?e.status:400,{error:allowed.includes(e?.code)?e.code:'AB_ADMISSION_HTTP_INPUT'})};}}
const uncertain=()=>response(503,{error:'AB_ADMISSION_UNCONFIRMED'});
function project(entry,value){
 const r=copy(value);if(!exact(r,['_http','_body']))throw Error();
 if(exact(r._body,['error'])){if(!Object.hasOwn(I.ERROR_STATUS,r._body.error)||I.ERROR_STATUS[r._body.error]!==r._http)throw Error();return response(r._http,r._body);}
 const b=r._body;if(r._http!==200||!exact(b,['contract','inspection',...Object.keys(D.FLAGS)])||!b.inspection||typeof b.inspection!=='object'||Array.isArray(b.inspection))throw Error();
 const {inspection_hash,...raw}=b.inspection,sealed=D.seal(raw),p=entry.request;
 if(H.digest(sealed)!==H.digest(b)||inspection_hash!==sealed.inspection.inspection_hash||raw.brand!==p.brand||raw.test_id!==p.test_id||raw.experiment_version!==p.expected_version||raw.scope_hash!==p.expected_scope_hash||raw.review_id!==p.review_id)throw Error();
 return response(200,sealed);
}
function createAdmissionInspectionAPI({store}={}){
 if(typeof store?.execute!=='function')throw Error('AB_ADMISSION_HTTP_ADAPTER');
 return Object.freeze({enabled:false,async handle(value,{signal}={}){const entry=parse(value);if(entry.response)return entry.response;try{return project(entry,await store.execute({key:entry.key,request:entry.request,signal}));}catch{return uncertain();}}});
}
module.exports={VERSION:D.VERSION,ENABLED:false,parse,project,createAdmissionInspectionAPI};
