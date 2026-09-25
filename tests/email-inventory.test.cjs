const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const inventory=require('../n8n/growth/email-inventory.cjs'),{patch}=require('../n8n/growth/email-inventory-patch.cjs');
const stamp='2026-09-25T12:00:00Z';
const row=(more={})=>({brand:'fish',flow_key:'fish:carrinho',piece:'carrinho-30min',template_id:'60',published_version:3,flow_enabled:true,step_enabled:true,runtime_ready:true,...more});
test('email inventory exposes only public configuration and never infers delivery or activation',()=>{
 const x=inventory([row({email:'never@example.invalid',secret:'do-not-project',raw:{}})],stamp);
 assert.deepEqual(Object.keys(x[0]).sort(),['key','brand','flow_key','piece','template_id','published_version','enabled','runtime_ready','checked_at'].sort());
 assert.equal(x[0].enabled,true);assert.equal(inventory([row({step_enabled:false})],stamp)[0].enabled,false);assert.equal(inventory([row({runtime_ready:false})],stamp)[0].runtime_ready,false);
});
test('inventory rejects duplicates, malformed flags, wrong brand, missing version and oversized snapshots',()=>{
 for(const rows of [[row(),row()],[row({brand:'cx'})],[row({flow_key:'aristo:carrinho'})],[row({step_enabled:'true'})],[row({published_version:null})],Array(201).fill(row())])assert.throws(()=>inventory(rows,stamp));
 assert.throws(()=>inventory([], 'bad'));assert.deepEqual(inventory([],stamp),[]);
});
test('patch refuses unrelated or unpublished workflow versions before editing',()=>{
 for(const w of [{id:'cx'},{id:'3p35uZWGCZJEigiv',versionId:'1',activeVersionId:'2',nodes:[]},{id:'3p35uZWGCZJEigiv',versionId:'1',activeVersionId:'1',nodes:[]}])assert.throws(()=>patch(w,{expectedVersionId:'1'}));
});
test('published email query excludes merged journeys and tests while preserving paused stages',async()=>{
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');const db=new PGlite();
 try{
 await db.exec('CREATE TABLE shrigma_flow_definition(key text,brand text,published jsonb,published_version int,enabled bool,runtime_ready bool,binding jsonb)');
 const steps=[{piece:'carrinho-30min',channel:'email',template_id:'60',enabled:true},{piece:'carrinho-1h',channel:'email',template_id:'61',enabled:false},{piece:'test',channel:'email',template_id:'62',enabled:true,is_test:true},{piece:'wa',channel:'whatsapp',enabled:true}];
 for(const [key,brand,binding] of [['fish:carrinho','fish',{}],['aristo:carrinho','aristo',{}],['fish:archived','fish',{merged_into:'fish:carrinho'}],['olivas:carrinho','olivas',{}]])await db.query('INSERT INTO shrigma_flow_definition VALUES($1,$2,$3,3,true,true,$4)',[key,brand,{steps},binding]);
 const fragment=fs.readFileSync(path.join(__dirname,'../n8n/growth/email-inventory-query.sql'),'utf8');const raw=(await db.query('SELECT '+fragment)).rows[0].email_steps;
 const result=inventory(raw,stamp);assert.equal(result.length,4);assert.equal(result.filter(r=>r.enabled).length,2);assert.equal(result.some(r=>r.piece==='test'),false);
 }finally{await db.close();}
});
test('fresh observer patch changes only two projections and keeps graph/credentials/settings intact',()=>{
 const before=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/email-inventory-before.json')));before.nodes[0].credentials={postgres:{id:'synthetic',name:'Fixture'}};
 const untouched=JSON.stringify(before),after=patch(before,{expectedVersionId:'fixture'});assert.equal(JSON.stringify(before),untouched);
 const restore=structuredClone(after);for(let i=0;i<before.nodes.length;i++)restore.nodes[i].parameters=before.nodes[i].parameters;assert.deepEqual(restore,before);
 const previous={captured_at:stamp,email_steps:[row()],previous:{}};
 const code=after.nodes.find(n=>n.name==='Build snapshot').parameters.jsCode;
 const result=vm.runInNewContext('(function(){'+code+'})()',{$input:{all:()=>[]},$:name=>({all:()=>[],first:()=>({json:previous})})});
 assert.equal(result[0].json.snapshot.email_steps.length,1);assert.equal(result[0].json.snapshot.email_steps[0].brand,'fish');assert.equal(result[0].json.snapshot.workflows.length,0);
 const drift=structuredClone(before);drift.nodes[0].parameters.query+=' ';assert.throws(()=>patch(drift,{expectedVersionId:'fixture'}));assert.throws(()=>patch(after,{expectedVersionId:'fixture'}));
});
