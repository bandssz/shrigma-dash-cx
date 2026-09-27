'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const {createDraftApi,ENABLED}=require('../n8n/growth/journey-graph-draft-api.cjs');
const {fixture,faultPool,id}=require('./fixtures/journey-graph-runtime.cjs');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
const shortOperator=()=>{
 const source=read('n8n/access/panel-short-keys.sql'),start=source.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_panel_operator_v1(k text,a text)'),end=source.indexOf('REVOKE ALL ON FUNCTION public.shrigma_panel_operator_v1(text,text) FROM PUBLIC;',start);
 assert.ok(start>=0&&end>start);return source.slice(start,end)+'REVOKE ALL ON FUNCTION public.shrigma_panel_operator_v1(text,text) FROM PUBLIC;';
};
async function setup(t,{shortKeys=true}={}){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(read('tests/fixtures/journey-graph-auth.sql'));await db.exec(read('n8n/access/panel-operator.sql'));await db.exec(read('n8n/growth/journey-graph-store.sql'));
 if(shortKeys)await db.exec(shortOperator());
 for(const [name,area,caps]of [['manager','growth',['draft','read_content']],['reader','growth',['read_content']],['writer','growth',['draft']],['other','other',['draft','read_content']],['second','growth',['draft','read_content']]]){
  await db.query('INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash) VALUES($1,$2,$1,$3)',[name,area,hash('synthetic-'+name+'-key')]);
  await db.query("INSERT INTO shrigma_panel_permission_v1 VALUES($1,'growth',$2::jsonb)",[name,JSON.stringify(caps)]);
 }
 await db.query("UPDATE crm_dash_chave SET chave_hash_curta=$1 WHERE chave='manager'",[hash('synshort')]);
 const pool={async connect(){return {query:db.query.bind(db),release(){}};}},f=fixture(pool),other=fixture(pool,'aristo');
 const catalogFor=async({brand})=>JSON.parse(JSON.stringify(brand==='fish'?f.catalog:other.catalog));
 const api=createDraftApi({pool,catalogFor});let seq=2000;
 const make=(action,fields={},brand='fish')=>({action,brand,...(['create','save'].includes(action)?{request_id:id(seq++)}:{}),...fields});
 const call=(p,key='manager',target=api,method=['create','save'].includes(p.action)?'POST':'GET')=>target.handle({method,authorization:'Bearer synthetic-'+key+'-key',request:p});
 return {db,pool,f,other,api,catalogFor,make,call};
}
const total=async(x,table)=>Number((await x.db.query('SELECT count(*) n FROM crm_graph_candidate.'+table)).rows[0].n);
test('current short-key helper keeps the same manager and receipt; original long-key helper remains supported',async t=>{
 for(const shortKeys of [false,true]){
  const x=await setup(t,{shortKeys}),request=x.make('create',{definition:x.f.graph}),long=await x.call(request);assert.equal(long.status,201);
  const short=()=>x.api.handle({method:'POST',authorization:'Bearer synshort',request});
  const result=await short();if(shortKeys)assert.deepEqual(result,long);else{assert.equal(result.status,401);assert.equal(result.body.error,'GRAPH_UNAUTHORIZED');}
  assert.equal(await total(x,'journey'),1);assert.equal((await x.db.query('SELECT actor FROM crm_graph_candidate.operation')).rows[0].actor,'panel:manager');
  if(shortKeys){await x.db.query("UPDATE crm_dash_chave SET revogada_em=now() WHERE chave='manager'");assert.equal((await x.call(request)).status,401);assert.equal((await short()).status,401);}
 }
});
test('existing manager helper and existing caps gate each action; no legacy key, body actor or publish capability is accepted',async t=>{
 const x=await setup(t),request=x.make('create',{definition:x.f.graph});assert.equal(ENABLED,false);assert.equal(x.api.enabled,false);
 assert.equal((await x.call(x.make('catalog'),'reader')).status,200);assert.equal((await x.call(request,'reader')).status,403);
 assert.equal((await x.call(x.make('catalog'),'writer')).status,403);assert.equal((await x.call(request,'other')).status,401);assert.equal((await x.call(request,'legacy')).status,401);
 for(const extra of [{actor:'panel:manager'},{caps:['draft']},{catalog:x.f.catalog},{enabled:true},{source_ref:id(10)}])assert.equal((await x.call({...request,...extra})).status,400);
 for(const action of ['publish','pause','enroll','step','due','toString'])assert.equal((await x.call({action,brand:'fish'})).status,400);
 assert.equal((await x.call(request,'manager',x.api,'GET')).status,405);assert.equal((await x.api.handle({method:'POST',authorization:'',request})).status,401);
 assert.equal((await x.api.handle({method:'POST',authorization:'Bearer synthetic-manager-key ',request})).status,401);assert.equal(await total(x,'journey'),0);
});
test('create/save keep author from SQL, immutable revision, optimistic version and exact durable replay',async t=>{
 const x=await setup(t),request=x.make('create',{definition:x.f.graph});const first=await x.call(request);assert.equal(first.status,201);assert.equal(first.body.authorizes_publish,false);assert.equal(first.body.receipt.paused,true);
 assert.deepEqual(await x.call(request),first);assert.equal(await total(x,'journey'),1);
 const op=(await x.db.query('SELECT actor,brand FROM crm_graph_candidate.operation')).rows[0];assert.deepEqual(op,{actor:'panel:manager',brand:'fish'});
 const altered=JSON.parse(JSON.stringify(request));altered.definition.name='Another';assert.equal((await x.call(altered)).status,409);assert.equal((await x.call(request,'second')).status,409);
 const definition=JSON.parse(JSON.stringify(x.f.graph));definition.name='Second revision';const save=x.make('save',{journey_id:first.body.receipt.journey_id,expected_version:1,definition});const saved=await x.call(save);assert.equal(saved.status,200);assert.equal(saved.body.receipt.version,2);assert.equal(saved.body.receipt.revision,2);assert.deepEqual(await x.call(save),saved);
 assert.equal((await x.call({...save,request_id:id(2099)})).status,409);assert.equal(await total(x,'revision'),2);assert.equal(await total(x,'entry'),0);assert.equal(await total(x,'intent'),0);
 assert.equal((await x.db.query('SELECT enabled FROM crm_graph_candidate.control')).rows[0].enabled,false);
});
test('brand filters apply to list/get/save/catalog and identity is never taken from the definition',async t=>{
 const x=await setup(t),fish=await x.call(x.make('create',{definition:x.f.graph})),aristo=await x.call(x.make('create',{definition:x.other.graph},'aristo'));
 for(const [brand,own,other]of [['fish',fish,aristo],['aristo',aristo,fish]]){
  const list=await x.call(x.make('list',{after:null,limit:50},brand));assert.equal(list.status,200);assert.equal(list.body.journeys.length,1);assert.equal(list.body.journeys[0].journey_id,own.body.receipt.journey_id);
  const got=await x.call(x.make('get',{journey_id:own.body.receipt.journey_id},brand));assert.equal(got.body.server.brand,brand);assert.equal(got.body.definition.brand,brand);assert.equal(got.body.catalog.brand,brand);assert.equal(got.headers['Cache-Control'],'no-store');
  assert.equal((await x.call(x.make('get',{journey_id:other.body.receipt.journey_id},brand))).status,404);
  assert.equal((await x.call(x.make('save',{journey_id:other.body.receipt.journey_id,expected_version:1,definition:got.body.definition},brand))).status,404);
 }
 assert.equal((await x.call(x.make('create',{definition:x.other.graph}))).status,422);
 const dirty={...x.f.graph,journey_id:fish.body.receipt.journey_id};assert.equal((await x.call(x.make('create',{definition:dirty}))).status,422);
 assert.equal((await x.call({action:'catalog',brand:'olivas'})).status,400);
});
test('lost commit response reconciles the original historical receipt without recreating or adopting the new head',async t=>{
 const x=await setup(t),request=x.make('create',{definition:x.f.graph});let once=true;
 // The first COMMIT belongs to pre-auth read; lose only the runtime COMMIT.
 let commits=0;const api=createDraftApi({pool:faultPool(x.pool,{after:q=>q==='COMMIT'&&++commits===2&&once?(once=false,true):false}),catalogFor:x.catalogFor});
 const unknown=await x.call(request,'manager',api);assert.equal(unknown.status,202);assert.equal(unknown.body.state,'unconfirmed');assert.equal(unknown.body.retry_same_request_only,true);assert.equal(await total(x,'journey'),1);
 const reconciled=await x.call(x.make('operation',{request_id:request.request_id}));assert.equal(reconciled.status,200);assert.equal(reconciled.body.state,'succeeded');const receipt=reconciled.body.receipt;
 assert.equal(receipt.operation_id,request.request_id);assert.equal(receipt.version,1);
 const definition={...x.f.graph,name:'Updated after receipt'};await x.call(x.make('save',{journey_id:receipt.journey_id,expected_version:1,definition}));
 const historical=await x.call(x.make('operation',{request_id:request.request_id}));assert.deepEqual(historical.body.receipt,receipt);assert.equal((await x.call(x.make('get',{journey_id:receipt.journey_id}))).body.server.version,2);
 assert.deepEqual((await x.call(request)).body.receipt,receipt);assert.equal(await total(x,'journey'),1);
 assert.equal((await x.call(x.make('operation',{request_id:request.request_id}),'second')).status,404);
 assert.equal((await x.call(x.make('operation',{request_id:request.request_id},'aristo'))).status,404);
 const missing=await x.call(x.make('operation',{request_id:id(9999)}));assert.equal(missing.status,202);assert.equal(missing.body.state,'unconfirmed');assert.equal(missing.body.retry_same_request_only,true);
});
test('revoked or expired key and removed permissions are rechecked, including durable replay',async t=>{
 const x=await setup(t),request=x.make('create',{definition:x.f.graph});assert.equal((await x.call(request)).status,201);
 await x.db.query("UPDATE crm_dash_chave SET revogada_em=now() WHERE chave='manager'");assert.equal((await x.call(request)).status,401);assert.equal((await x.call(x.make('catalog'))).status,401);
 await x.db.query("UPDATE crm_dash_chave SET revogada_em=NULL,expira_em=now()-interval '1 second' WHERE chave='manager'");assert.equal((await x.call(request)).status,401);
 await x.db.query("UPDATE crm_dash_chave SET expira_em=NULL WHERE chave='manager'");await x.db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"read_content\"]' WHERE principal_id='manager'");assert.equal((await x.call(request)).status,403);assert.equal((await x.call(x.make('operation',{request_id:request.request_id}))).status,200);
 assert.equal(await total(x,'journey'),1);
});
test('authorization changes after preliminary lookup are rejected inside the write transaction before claim or mutation',async t=>{
 const x=await setup(t);let connections=0;
 const pool={async connect(){if(++connections===2)await x.db.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"read_content\"]' WHERE principal_id='manager'");return x.pool.connect();}};
 const api=createDraftApi({pool,catalogFor:x.catalogFor});const result=await x.call(x.make('create',{definition:x.f.graph}),'manager',api);assert.equal(result.status,403);assert.equal(await total(x,'journey'),0);assert.equal(await total(x,'operation'),0);
});
test('current catalog is injected and bounded; unavailable source is visible without fabrication, and backend exceptions stay sanitized',async t=>{
 const x=await setup(t);x.f.catalog.triggers[0].available=false;const catalog=await x.call(x.make('catalog'));assert.equal(catalog.status,200);assert.equal(catalog.body.catalog.triggers[0].available,false);assert.equal((await x.call(x.make('create',{definition:x.f.graph}))).status,422);
 const broken=createDraftApi({pool:x.pool,catalogFor:async()=>{throw Object.assign(Error('raw SQL and synthetic-manager-key'),{status:418,code:'sensitive provider body'});}});
 const failed=await x.call(x.make('catalog'),'manager',broken);assert.equal(failed.status,503);assert.equal(failed.body.error,'GRAPH_SERVICE_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(failed),/synthetic-manager-key|raw SQL|sensitive provider/);
 const cross=createDraftApi({pool:x.pool,catalogFor:async()=>x.other.catalog});assert.equal((await x.call(x.make('catalog'),'manager',cross)).status,503);
});
test('listing is bounded and paginated; payload accessors and credential fields never reach SQL',async t=>{
 const x=await setup(t);for(let i=0;i<3;i++)await x.call(x.make('create',{definition:{...x.f.graph,name:'Synthetic '+i}}));
 const ids=[];let after=null;do{const r=await x.call(x.make('list',{after,limit:1}));assert.equal(r.status,200);ids.push(...r.body.journeys.map(j=>j.journey_id));after=r.body.next_cursor;}while(after);assert.equal(ids.length,3);assert.equal(new Set(ids).size,3);
 assert.equal((await x.call(x.make('list',{after:null,limit:51}))).status,400);
 let accessed=false;const request={action:'catalog',brand:'fish'};Object.defineProperty(request,'actor',{enumerable:true,get(){accessed=true;return 'spoof';}});assert.equal((await x.call(request)).status,400);assert.equal(accessed,false);
 assert.equal((await x.call({action:'catalog',brand:'fish',k:'synthetic-manager-key'})).status,400);
});
