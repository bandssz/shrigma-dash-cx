'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const O=require('../n8n/growth/maintenance-tx-observation.cjs'),P=require('../n8n/growth/maintenance-tx-popup-protocol.cjs');
const sql=fs.readFileSync(require.resolve('../n8n/growth/maintenance-tx-observation.sql'),'utf8');
const copy=v=>JSON.parse(JSON.stringify(v)),guard=w=>({version:w.versionId,workflowHash:O.digest(w),connectionsHash:O.digest(w.connections)});
function body(brand='fish',event='confirmado'){return {email:'pii-sentinel@example.invalid',name:'PRIVATE PERSON SENTINEL',from_email:'orders@'+(brand==='fish'?'fishermans.com.br':'oaristocrata.com'),reply_to:'PRIVATE_REPLY@example.invalid',subject:'PRIVATE SUBJECT SENTINEL',order_id:'PRIVATE ORDER SENTINEL',event_type:event,template_id:P.MAP[brand][event],items:[{name:'PRIVATE ITEM SENTINEL',qty:2,price:'PRIVATE PRICE SENTINEL'}],order_url:'https://example.invalid/PRIVATE-URL-SENTINEL'};}
function workflow(){
 const nodes=[],connections={};
 for(const [brand,suffix,wa]of [['fish','Fishermans','→ WhatsApp Fish (WA · Transacional EfSf4rTJb3krbBV2)'],['aristo','Aristocrata','→ WhatsApp Aristo (transacional em sombra)']]){
  const derive='Derivar Rastreio — '+suffix,email='Verifica se cliente existe'+(brand==='fish'?'1':''),pg='R4 reserva exclusiva '+(brand==='fish'?'Fish':'Aristo');
  nodes.push({id:'derive-'+brand,name:derive,type:'n8n-nodes-base.code',position:[0,brand==='fish'?100:500],parameters:{jsCode:'return $input.all();'}},
   {id:'email-'+brand,name:email,type:'n8n-nodes-base.httpRequest',position:[100,100],parameters:{method:'POST',url:'https://example.invalid/api/tx'}},
   {id:'wa-'+brand,name:wa,type:'n8n-nodes-base.httpRequest',position:[100,800],parameters:{method:'POST',url:'https://example.invalid/wa'}},
   {id:'pg-'+brand,name:pg,type:'n8n-nodes-base.postgres',typeVersion:2.6,position:[100,1000],parameters:{query:'SELECT 1'},credentials:{postgres:{id:'synthetic-reference',name:'Synthetic'}}});
  connections[derive]={main:[[{node:email,type:'main',index:0},{node:wa,type:'main',index:0}]]};
 }
 nodes.push({id:'hook',name:'Existing immediate ACK',type:'n8n-nodes-base.webhook',position:[-100,0],parameters:{httpMethod:'POST',responseMode:'onReceived',path:'synthetic'}},{id:'popup',name:'Original popup',type:'n8n-nodes-base.code',position:[0,2000],parameters:{jsCode:'return $input.all();'}});
 return {id:O.TARGET,name:'Synthetic original',versionId:'fixture-v1',activeVersionId:'fixture-v1',active:true,nodes,connections,settings:{executionOrder:'v1',saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveManualExecutions:false},tags:[],pinData:{}};
}
const codeRun=(source,json)=>vm.runInNewContext('(function(){'+source+'})()',{$json:json,Object,JSON});
const exprRun=(source,json)=>vm.runInNewContext(source.replace(/^=\{\{\s*/,'').replace(/\s*\}\}$/,''),{$json:json});
test('all twelve mapped inputs prove normalization, with only allowlisted field/type names and no values',()=>{
 for(const brand of ['fish','aristo'])for(const event of Object.keys(P.MAP[brand])){
  const b=body(brand,event),original=copy(b),r=O.observe(brand,b);assert.equal(r.verdict,'accepted');assert.equal(r.reason,'ok');assert.equal(r.event_type,event);assert.equal(r.brand,brand);assert.equal(r.normalizer_sha256,O.NORMALIZER_SHA256);assert.deepEqual(b,original);
  assert.ok(r.fields.some(f=>f.stage==='normalized'&&f.path==='items[].qty'&&f.type==='number'));assert.ok(r.fields.every(f=>O.PATHS.includes(f.path)&&O.TYPES.includes(f.type)));
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE|pii-sentinel|@|https:|orders@|2[,.}]/);assert.deepEqual(O.recordInput(brand,r),r);
 }
});
test('rejected events expose only fixed error codes; unknown names/event text, secrets and header values are discarded',()=>{
 for(const [extra,reason] of [[{authorization:'PRIVATE SECRET'},'control'],[{subject:'PRIVATE\r\nHEADER'},'header'],[{items:{PRIVATE:'body'}},'items'],[{email:17},'identity'],[{event_type:'PRIVATE EVENT'},'scope']]){
  const r=O.observe('fish',{...body(),...extra});assert.equal(r.verdict,'rejected');assert.equal(r.reason,reason);assert.ok(r.fields.every(f=>f.stage==='input'));assert.doesNotMatch(JSON.stringify(r),/PRIVATE|pii-sentinel|@/);
 }
 const extra=O.observe('fish',{...body(),private_customer_note:'PRIVATE NOTE'});assert.equal(extra.unknown_fields,true);assert.equal(extra.verdict,'accepted');assert.ok(!extra.fields.some(f=>f.path.includes('private')));
 assert.equal(O.observeJSON('fish','{"private":"').reason,'json');assert.equal(O.observeJSON('fish','x'.repeat(131073)).reason,'body');
 const hostile={toJSON(){throw Error('PRIVATE ERROR');}};assert.doesNotMatch(JSON.stringify(O.observe('fish',hostile)),/PRIVATE ERROR/);
});
test('Code runs without require/crypto/structuredClone and SQL projection sanitizes a continued node error',()=>{
 const w=workflow(),p=O.buildObservation(w,guard(w));
 for(const brand of ['fish','aristo']){
  const code=p.patch.nodes.find(n=>n.name==='TX Input Probe '+brand),pg=p.patch.nodes.find(n=>n.name===code.name+' count');
  const r=copy(codeRun(code.parameters.jsCode,{body:body(brand)}).json);assert.deepEqual(r,O.observe(brand,body(brand)));
  assert.deepEqual(JSON.parse(exprRun(pg.parameters.options.queryReplacement,r)[0]),r);
  for(const leaked of [{error:'PRIVATE ERROR',body:body(brand)},body(brand),{...r,fields:[{stage:'input',path:'PRIVATE EMAIL',type:'string'}]}]){
   const args=exprRun(pg.parameters.options.queryReplacement,leaked),clean=JSON.parse(args[0]);assert.equal(clean.reason,'unconfirmed');assert.deepEqual(clean.fields,[]);assert.doesNotMatch(args[0],/PRIVATE|pii-sentinel|@/);
  }
 }
});
test('patch preserves every original node, settings, ACK and old edge order; v1 observation is last and adds no transport',()=>{
 const w=workflow(),before=copy(w),p=O.buildObservation(w,guard(w));assert.deepEqual(w,before);assert.deepEqual(p.patch.nodes.slice(0,w.nodes.length),w.nodes);assert.deepEqual(p.patch.settings,w.settings);
 const added=p.patch.nodes.slice(w.nodes.length),max=Math.max(...w.nodes.map(n=>n.position[1]));assert.equal(added.length,4);assert.ok(added.every(n=>n.position[1]>max&&n.retryOnFail===false&&n.onError==='continueRegularOutput'));assert.deepEqual(added.map(n=>n.type).sort(),['n8n-nodes-base.code','n8n-nodes-base.code','n8n-nodes-base.postgres','n8n-nodes-base.postgres']);
 for(const [name,c]of Object.entries(w.connections)){assert.deepEqual(p.patch.connections[name].main[0].slice(0,2),c.main[0]);assert.equal(p.patch.connections[name].main[0].length,3);}
 assert.equal(p.review.applied,false);assert.equal(p.review.transport_added,false);assert.equal(p.review.observation_may_be_skipped,true);assert.deepEqual(p.restore,Object.fromEntries(['name','nodes','connections','settings'].map(k=>[k,w[k]])));
 const published={...p.patch,versionId:'fixture-probe',activeVersionId:'fixture-probe'};assert.deepEqual(O.restoreObservation(published,guard(published),p),p.restore);
 const changed=copy(published);changed.nodes[0].parameters.jsCode='changed';assert.throws(()=>O.restoreObservation(changed,guard(changed),p),/SOURCE_DRIFT/);
});
test('unknown ordering, retention, version, position and source paths fail before a candidate is returned',()=>{
 for(const mutate of [w=>delete w.settings.executionOrder,w=>w.settings.executionOrder='v0',w=>w.settings.saveDataErrorExecution='all',w=>w.settings.saveExecutionProgress=true,w=>w.active=false,w=>w.activeVersionId='old',w=>w.nodes[0].position=[0,NaN],w=>w.connections['Derivar Rastreio — Fishermans'].main[0].reverse(),w=>w.nodes[0].name='renamed']){const w=workflow();mutate(w);assert.throws(()=>O.buildObservation(w,guard(w)),/SOURCE_DRIFT/);}
 const w=workflow(),g=guard(w);w.nodes[0].parameters.jsCode='changed';assert.throws(()=>O.buildObservation(w,g),/SOURCE_DRIFT/);
 const original=workflow(),p=O.buildObservation(original,guard(original));assert.throws(()=>O.buildObservation(p.patch,guard(p.patch)),/SOURCE_DRIFT/);
});
async function dbFor(t){const db=new PGlite();t.after(()=>db.close());await db.exec(sql);return db;}
const record=(db,p)=>db.query('SELECT crm_tx_input_probe.record_v1($1::jsonb) AS observed',[JSON.stringify(p)]);
test('SQL persists only aggregate counts/types, is atomic, and never touches the CART schema',async t=>{
 const db=await dbFor(t),r=O.observe('fish',body());await record(db,r);await record(db,r);await record(db,O.observe('aristo',body('aristo')));
 const rows=(await db.query('SELECT * FROM crm_tx_input_probe.outcome ORDER BY brand')).rows;assert.equal(rows.length,2);assert.equal(Number(rows.find(x=>x.brand==='fish').observations),2);
 const fields=(await db.query('SELECT * FROM crm_tx_input_probe.field_type')).rows;assert.ok(fields.length);assert.ok(fields.every(x=>O.PATHS.includes(x.path)));assert.doesNotMatch(JSON.stringify({rows,fields}),/PRIVATE|pii-sentinel|@|https:/);
 assert.equal((await db.query("SELECT to_regnamespace('crm_maintenance_candidate') AS schema")).rows[0].schema,null);
 assert.equal((await db.query("SELECT count(*) n FROM pg_proc p WHERE p.pronamespace='crm_tx_input_probe'::regnamespace AND EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')")).rows[0].n,0);
 assert.match(sql,/lock_timeout='250ms'/);assert.doesNotMatch(sql,/crm_maintenance_candidate\.|public\.(subscribers|templates)|\bGRANT\b/);
 const allowed=sql.match(/allowed text\[\]:=ARRAY\[([^]+?)\];/)[1].match(/'[^']+'/g).map(x=>x.slice(1,-1));assert.deepEqual(allowed,O.PATHS);
});
test('SQL rejects arbitrary values/paths/types and duplicate shapes before counters change',async t=>{
 const db=await dbFor(t),r=O.observe('fish',body());
 const invalid=[{...r,email:'PRIVATE EMAIL'},{...r,reason:'PRIVATE ERROR'},{...r,event_type:'PRIVATE EVENT'},{...r,fields:[{stage:'input',path:'PRIVATE FIELD',type:'string'}]},{...r,fields:[{stage:'input',path:'email',type:'PRIVATE TYPE'}]},{...r,fields:[r.fields[0],r.fields[0]]},{...r,fields:[{...r.fields[0],value:'PRIVATE VALUE'}]},{...r,brand:'olivas'}];
 for(const bad of invalid)await assert.rejects(record(db,bad),/TX_PROBE_INPUT/);assert.equal(Number((await db.query('SELECT count(*) n FROM crm_tx_input_probe.outcome')).rows[0].n),0);
});
test('counter write failure rolls back this observation only; same connection remains usable',async t=>{
 const db=await dbFor(t),r=O.observe('fish',body());await record(db,r);
 await db.exec("CREATE FUNCTION crm_tx_input_probe.synthetic_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'SYNTHETIC_FAILURE';END$$;CREATE TRIGGER synthetic_fail BEFORE UPDATE ON crm_tx_input_probe.field_type FOR EACH ROW EXECUTE FUNCTION crm_tx_input_probe.synthetic_fail()");
 await assert.rejects(record(db,r),/SYNTHETIC_FAILURE/);assert.equal(Number((await db.query('SELECT observations FROM crm_tx_input_probe.outcome')).rows[0].observations),1);assert.equal((await db.query('SELECT 1 n')).rows[0].n,1);
});
