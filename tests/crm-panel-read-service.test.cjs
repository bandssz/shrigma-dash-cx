'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{gunzipSync}=require('node:zlib');
const {createServer,QUERY,ORIGIN,acceptsGzip}=require('../services/crm-panel-read/server.cjs'),{config}=require('../services/crm-panel-read/main.cjs');
const identity={schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',allowedPanels:['growth']};
async function fixture(t,{query=async()=>({rows:[{status_code:200,body:identity}]}),enabled=true,...options}={}){
 const calls=[],app=createServer({pool:{query:async(...args)=>{calls.push(args);return query(...args);}},revision:'a'.repeat(40),enabled,...options});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.stop());
 const request=({path='/read?action=identity&painel=growth',method='GET',headers={}}={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:app.server.address().port,path,method,headers:{Authorization:'Bearer synthetic-reader-key',Origin:ORIGIN,...headers}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{const bytes=Buffer.concat(chunks),raw=res.headers['content-encoding']==='gzip'?gunzipSync(bytes):bytes;resolve({status:res.statusCode,headers:res.headers,bytes:bytes.length,body:raw.length?JSON.parse(raw):null});});});req.on('error',reject);req.end();});
 return {app,calls,request};
}
test('one parameterized query preserves manager identity and short credentials without n8n or key in URL',async t=>{
 const x=await fixture(t),r=await x.request();assert.equal(r.status,200);assert.deepEqual(r.body,identity);assert.equal(x.calls.length,1);assert.equal(x.calls[0][0],QUERY);assert.deepEqual(x.calls[0][1],['Bearer synthetic-reader-key',ORIGIN,'{"action":"identity","painel":"growth"}']);assert.equal(r.headers['access-control-allow-origin'],ORIGIN);assert.match(r.headers['cache-control'],/no-store/);assert.equal(x.app.pending(),0);
});
test('origins, methods, duplicate query keys and query credentials are refused before database access',async t=>{
 const x=await fixture(t);
 for(const [opts,status] of [[{headers:{Origin:'https://foreign.test'}},403],[{method:'POST'},405],[{headers:{Authorization:'Bearer bad'}},401],[{path:'/read?action=identity&painel=growth&k=secret'},400],[{path:'/read?action=identity&action=cache_growth'},400],[{path:'/read?action=identity&painel=cx'},400],[{path:'/other'},404]])assert.equal((await x.request(opts)).status,status);
 assert.equal(x.calls.length,0);const r=await x.request({method:'OPTIONS'});assert.equal(r.status,204);assert.equal(x.calls.length,0);
});
test('large cached payload uses gzip only when accepted and keeps every byte of the JSON',async t=>{
 const body={_escopo:'growth',_painel:'growth',crm_campanha:[{name:'x'.repeat(20000)}],crm_fluxo:[],crm_conversao:[],_cache_gerado_em:'2026-09-29T12:00:00Z'},x=await fixture(t,{query:async()=>({rows:[{status_code:200,body}]})});
 const r=await x.request({path:'/read?action=cache_growth&painel=growth',headers:{'Accept-Encoding':'gzip, deflate'}});assert.deepEqual(r.body,body);assert.equal(r.headers['content-encoding'],'gzip');assert.ok(r.bytes<1000);assert.equal((await x.request({headers:{'Accept-Encoding':'gzip;q=0'}})).headers['content-encoding'],undefined);assert.equal(acceptsGzip('gzip;q=0.0'),false);
});
test('revocation and database errors retain safe status without raw query, key or error detail',async t=>{
 const denied=await fixture(t,{query:async()=>({rows:[{status_code:401,body:{erro:'chave de acesso ausente ou incorreta'}}]})});assert.equal((await denied.request()).status,401);
 const failed=await fixture(t,{query:async()=>{throw Error('private synthetic-reader-key SQL');}}),r=await failed.request();assert.equal(r.status,503);assert.equal(r.headers['retry-after'],'5');assert.deepEqual(r.body,{erro:'consulta indisponível'});
});
test('timed out queries keep their admission slot until they settle; a burst does not grow the pool queue',async t=>{
 let release;const held=new Promise(r=>release=r),x=await fixture(t,{query:()=>held,deadlineMs:25,maxPending:1});
 const first=x.request();await new Promise(r=>setTimeout(r,10));assert.equal((await x.request()).status,503);assert.equal((await first).status,503);assert.equal(x.calls.length,1);assert.equal(x.app.pending(),1);
 release({rows:[{status_code:200,body:identity}]});await new Promise(setImmediate);assert.equal(x.app.pending(),0);assert.equal((await x.request()).status,200);
});
test('disabled service has a health check and preflight but cannot query the database',async t=>{
 const x=await fixture(t,{enabled:false});assert.equal((await x.request()).status,503);assert.equal((await x.request({path:'/healthz'})).body.enabled,false);assert.equal((await x.request({method:'OPTIONS'})).status,204);assert.equal(x.calls.length,0);
});
test('configuration only accepts the dedicated role, bounded pool and explicit enablement',()=>{
 const env={PGHOST:'comunicacao_postgres',PGDATABASE:'listmonk',PGUSER:'crm_panel_reader',PGPASSWORD:'synthetic-password',CRM_READ_REVISION:'a'.repeat(40)};assert.equal(config(env).enabled,false);assert.equal(config(env).pg.max,4);assert.equal(config(env).pg.statement_timeout,8000);assert.equal(config({...env,CRM_READ_ENABLED:'true'}).enabled,true);for(const PGPORT of ['bad','0','65536','1.5'])assert.throws(()=>config({...env,PGPORT}));assert.throws(()=>config({...env,PGUSER:'postgres'}));assert.throws(()=>config({...env,PGPASSWORD:''}));assert.throws(()=>config({...env,CRM_READ_REVISION:'main'}));
});
