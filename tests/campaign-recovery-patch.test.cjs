const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {patchWorkflow}=require('../n8n/growth/campaign-recovery-patch.cjs');
const load=()=>{const f=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/campaign-recovery-runtime-before.json')));for(const n of f.workflow.nodes)if(n.parameters.jsCode)n.parameters.jsCode=n.parameters.jsCode.replace('__PREVIOUS_BUNDLE__',()=>f.previousBundle);return f.workflow;};
const get=(w,n)=>w.nodes.find(x=>x.name===n);
test('recovery patch changes exactly five code bodies and preserves live auth, CORS and credentials',()=>{
 const f=load(),before=JSON.stringify(f),{workflow:w,changes}=patchWorkflow(f,{expectedVersionId:'fixture'});
 assert.equal(JSON.stringify(f),before);assert.equal(changes.length,5);
 for(const name of ['Autentica','Responde'])assert.deepEqual(get(w,name),get(f,name));
 for(const key of ['connections','settings','id','versionId','activeVersionId'])assert.deepEqual(w[key],f[key]);
 for(const n of f.nodes){const actual=get(w,n.name);assert.deepEqual({...actual,parameters:{...actual.parameters,jsCode:n.parameters.jsCode}},{...n,parameters:{...n.parameters,jsCode:n.parameters.jsCode}});}
 const c=get(w,'Entrada').parameters.jsCode;assert.ok(c.includes("'source_operation_id'"));assert.ok(c.includes('req.headers?.authorization'));assert.ok(c.includes("authHeader.slice(7)"));
 assert.match(get(w,'Despacha').parameters.jsCode,/"review","recovery_inspect","recover"/);assert.match(get(w,'Recibo erro PG').parameters.jsCode,/RECOVERY_UNAVAILABLE/);
 for(const name of ['Iniciar','Retomar'])assert.ok(get(w,name).parameters.jsCode.startsWith(fs.readFileSync(path.join(__dirname,'../n8n/growth/campaign-runtime.bundle.js'),'utf8')));
});
test('patch refuses drift, duplicate nodes, stale versions and an already patched workflow',()=>{
 for(const mutate of [w=>w.id='other',w=>w.activeVersionId='older',w=>w.nodes.push(structuredClone(get(w,'Entrada'))),...['Entrada','Despacha','Recibo erro PG','Iniciar','Retomar'].map(name=>w=>get(w,name).parameters.jsCode+='\n// drift')]){const w=load();mutate(w);assert.throws(()=>patchWorkflow(w,{expectedVersionId:'fixture'}));}
 const patched=patchWorkflow(load(),{expectedVersionId:'fixture'}).workflow;assert.throws(()=>patchWorkflow(patched,{expectedVersionId:'fixture'}));
});
test('live GET Bearer auth and POST audience field survive the narrow parser patch',()=>{
 const code=get(patchWorkflow(load(),{expectedVersionId:'fixture'}).workflow,'Entrada').parameters.jsCode;
 const run=input=>vm.runInNewContext('(function(){'+code+'})()',{$json:input})[0].json;
 const read=run({method:'GET',request:{query:{acao:'campanha_catalogo',brand:'fish'},headers:{authorization:'Bearer fixture-read'}}});assert.equal(read.key,'fixture-read');assert.equal(read._route,'auth');
 const post=run({method:'POST',request:{body:{k:'fixture-write',acao:'campanha_agendar',brand:'fish',id:1,audience_review_id:'review-fixture'}}});assert.equal(post.command.audience_review_id,'review-fixture');assert.equal(post._route,'auth');
 assert.equal(run({method:'GET',request:{query:{k:'fallback',acao:'campanha_catalogo',brand:'fish'},headers:{authorization:'wrong'}}}).response.status,401);
});

test('recovery POST is explicit and GET never invokes recovery writes',()=>{
 const code=get(patchWorkflow(load(),{expectedVersionId:'fixture'}).workflow,'Entrada').parameters.jsCode;
 const run=input=>vm.runInNewContext('(function(){'+code+'})()',{$json:input})[0].json;
 const command={acao:'campanha_recuperar',brand:'fish',id:1,expected_version:'v1',source_operation_id:'00000000-0000-4000-8000-000000000001',confirm:'recuperar',idempotency_key:'recovery-operation-001'};
 assert.equal(run({method:'POST',request:{body:{k:'fixture-write',...command}}})._route,'auth');
 assert.equal(run({method:'GET',request:{query:command,headers:{authorization:'Bearer fixture-read'}}}).response.status,405);
});
