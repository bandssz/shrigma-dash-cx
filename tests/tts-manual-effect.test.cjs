'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../n8n/tiktok/manual-decision.cjs'),{createRuntime}=require('../n8n/tiktok/manual-decision-runtime.cjs'),{createEffect}=require('../n8n/tiktok/manual-decision-effect.cjs');
const M=createRuntime(C),E=createEffect(C,M),{SCHEMA,MIGRATION,id,request}=require('./tts-manual-decision-postgres.cjs');
const utility={url:'https://sql.example.invalid/webhook/fixture',key:'synthetic-key',keyField:'k',queryField:'q',argsField:'args'};
const makeRequest=p=>M.request(p,'synthetic-token',{base:'https://open-api.tiktokglobalshop.com',appKey:'synthetic-app',cipher:'synthetic-shop',timestamp:1,sign:()=> 'a'.repeat(64)});
async function setup(){const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();await db.exec(SCHEMA);await db.exec(MIGRATION);await db.exec("UPDATE crm_tts_manual_control_v1 SET enabled=true,eligible_from=clock_timestamp()");await db.exec("INSERT INTO crm_tts_amostra(marca,application_id,status,is_approvable,approve_expira_em,decisao) VALUES('fish','1','PENDING',true,clock_timestamp()+interval '1 day','fila_manual')");const p=request(1),rows=await db.query(C.query('claim',p).sql,C.query('claim',p).parameters);return {db,p:C.witness(rows.rows[0].result,p,'reserved')};}
const dispatch=async(db,o)=>{const b=JSON.parse(o.body);assert.equal(b.k,utility.key);assert.equal(b.q,'SELECT public.crm_tts_manual_store_v1($1::text,$2::jsonb) AS result');assert.equal(b.args[0],'dispatch');return {statusCode:200,body:JSON.stringify((await db.query(b.q,b.args)).rows)};};
test('two simultaneous effect invocations share the dispatch CAS; only its fresh winner reaches the provider stub',async()=>{
 const {db,p}=await setup();let reached,release,count=0;const providerReached=new Promise(r=>reached=r),hold=new Promise(r=>release=r);
 const http=async o=>{assert.equal(o.disableFollowRedirect,true);assert.equal(o.returnFullResponse,true);if(o.url===utility.url)return dispatch(db,o);count++;reached();await hold;return {statusCode:200,body:'{"code":0,"request_id":"synthetic"}'};};
 try{const first=E.execute(p,utility,{http,makeRequest});await providerReached;const second=await E.execute(p,utility,{http,makeRequest});assert.equal(second.response.status,503);assert.equal(count,1);release();const a=await first;assert.equal(a.finish.receipt.kind,'accepted');assert.equal(count,1);}finally{release?.();await db.close();}
});
test('lost dispatch response or a contradictory utility receipt never reaches HTTP; restart cannot regain dispatch',async()=>{
 for(const shape of ['lost','empty','wrongstatus','extra']){const {db,p}=await setup();let sends=0;try{
 const first=await E.execute(p,utility,{makeRequest,http:async o=>{if(o.url!==utility.url){sends++;throw Error('unexpected provider');}const r=await dispatch(db,o);if(shape==='lost')throw Error('synthetic loss');if(shape==='empty')r.body='';if(shape==='wrongstatus')r.statusCode=201;if(shape==='extra')r.body=JSON.stringify([...JSON.parse(r.body),{}]);return r;}});assert.equal(first.response.status,503);
 const second=await E.execute(p,utility,{makeRequest,http:async o=>{if(o.url===utility.url)return dispatch(db,o);sends++;throw Error('unexpected provider');}});assert.equal(second.response.status,503);assert.equal(sends,0);
 }finally{await db.close();}}
});
test('effect rejects altered origin, body and headers after dispatch without leaking raw errors or sending provider traffic',async()=>{
 for(const alter of [r=>({...r,url:'https://other.invalid/review'}),r=>({...r,body:'{}'}),r=>({...r,headers:{...r.headers,authorization:'unapproved'}})]){const {db,p}=await setup();let sends=0;try{const r=await E.execute(p,utility,{makeRequest:p=>alter(makeRequest(p)),http:async o=>{if(o.url===utility.url)return dispatch(db,o);sends++;throw Error('secret URL');}});assert.equal(r.finish.receipt.kind,'outcome_unknown');assert.equal(sends,0);assert.doesNotMatch(JSON.stringify(r),/secret URL|unapproved/);}finally{await db.close();}}
});
