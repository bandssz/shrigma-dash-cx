'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {workflow,body}=require('./maintenance-tx-popup-fixture.cjs'),p=require('../n8n/growth/maintenance-tx-popup-patch.cjs'),protocol=require('../n8n/growth/maintenance-tx-popup-protocol.cjs');
const guard=w=>({version:w.versionId,workflowHash:p.digest(w),connectionsHash:p.digest(w.connections)});
function graphRun(w,brand,b,{persist=true,throwSQL=false}={}){
 const history=[],acks=[],seen={},queue=[[p.BRANDS[brand].webhook,{body:b}]];
 const exec=(s,data)=>vm.runInNewContext('(function(){'+s+'})()',{$json:data,$input:{all:()=>[{json:data}]},$:name=>({item:{json:seen[name]}})});
 const expr=(s,data)=>exec('return '+s.replace(/^=\{\{\s*/,'').replace(/\s*\}\}$/,''),data);
 while(queue.length){const [name,data]=queue.shift(),n=w.nodes.find(x=>x.name===name);seen[name]=data;history.push(name);let out=data,branch=0;
  if(n.type.endsWith('.if'))branch=expr(n.parameters.conditions.conditions[0].leftValue,data)?0:1;
  else if(n.type.endsWith('.code')){const r=exec(n.parameters.jsCode,data);if(Array.isArray(r)){if(!r.length)continue;out=r[0].json;}else out=r.json;}
  else if(n.type.endsWith('.postgres')){if(!name.endsWith('persistir'))throw Error('unexpected SQL '+name);history.push('SQL_ATTEMPT');out=persist&&!throwSQL?{receipt:{contract:'growth-maintenance-retention-v1',event_id:'12345678-1234-1234-1234-123456789012',brand,flow:'transacional',persisted:true,authorizes_send:false,payload_hash:'a'.repeat(64)}}:{error:'private error hidden'};if(persist&&!throwSQL)history.push('SQL_COMMITTED');}
  else if(n.type.endsWith('.respondToWebhook'))acks.push({status:typeof n.parameters.options.responseCode==='string'?expr(n.parameters.options.responseCode,data):n.parameters.options.responseCode,body:expr(n.parameters.responseBody,data),after:[...history]});
  else if(n.type.endsWith('.httpRequest')){history.push('HTTP:'+name);continue;}
  for(const e of w.connections[name]?.main?.[branch]||[])queue.push([e.node,out]);
 }
 return {history,acks};
}
test('producer durable TX ACK follows committed admission exactly once, without email HTTP; WA keeps original body',()=>{
 for(const brand of ['fish','aristo']){const w=workflow(),before=structuredClone(w),q=p.patchTxProducer(w,guard(w));assert.deepEqual(w,before);const r=graphRun(q,brand,body(brand));assert.equal(r.acks.length,1);assert.equal(r.acks[0].status,200);assert.ok(r.acks[0].after.includes('SQL_COMMITTED'));assert.ok(r.history.includes('HTTP:'+p.BRANDS[brand].wa));assert.ok(!r.history.includes('HTTP:'+p.BRANDS[brand].http));assert.ok(!r.history.includes('HTTP:'+p.BRANDS[brand].subscriber));}
});
test('lost or failed SQL never returns successful ACK; malformed normalized body also responds failure once',()=>{
 const w=workflow(),q=p.patchTxProducer(w,guard(w));for(const options of [{persist:false},{throwSQL:true}]){const r=graphRun(q,'fish',body(),options);assert.equal(r.acks.length,1);assert.equal(r.acks[0].status,503);assert.equal(r.acks[0].body.persisted,false);assert.ok(!JSON.stringify(r.acks).includes('private error'));}const malformed=graphRun(q,'fish',body('fish',{authorization:'synthetic-secret'}));assert.equal(malformed.acks[0].status,503);assert.ok(!malformed.history.includes('SQL_ATTEMPT'));
});
test('legacy and zero-item NPS get original immediate ACK; popup and all unrelated original nodes unchanged',()=>{
 const w=workflow(),q=p.patchTxProducer(w,guard(w));for(const [brand,b] of [['fish',{nps:true,email:'synthetic@example.invalid',order_number:'synthetic'}],['aristo',{event_type:'enviado',template_id:999}]]){const r=graphRun(q,brand,b);assert.equal(r.acks.length,1);assert.equal(r.acks[0].status,200);assert.ok(!r.history.includes('SQL_ATTEMPT'));assert.ok(r.acks[0].after.length<=3);}
 for(const old of w.nodes){const next=q.nodes.find(n=>n.name===old.name);if(Object.values(p.BRANDS).some(b=>b.webhook===old.name)){assert.deepEqual({...next,parameters:{...next.parameters,responseMode:undefined}},{...old,parameters:{...old.parameters,responseMode:undefined}});}else assert.deepEqual(next,old);}
 assert.deepEqual(q.connections['Webhook — Recebe Evento3'],w.connections['Webhook — Recebe Evento3']);
});
test('consumer created OFF has bounded selection, gate-first preparation, exact native email transport and finish wrapper',()=>{
 const w=workflow(),c=p.buildTxConsumer(w,guard(w));assert.equal(c.active,false);assert.equal(c.nodes.filter(n=>n.type.endsWith('.scheduleTrigger')).length,1);assert.equal(c.nodes.some(n=>n.type.endsWith('.webhook')),false);
 for(const [brand,b] of Object.entries(p.BRANDS)){
  const get=name=>c.nodes.find(n=>n.name===name);assert.deepEqual(get(b.http),{...w.nodes.find(n=>n.name===b.http),id:'maintenance-tx-'+brand+'-3',retryOnFail:false});assert.equal(get(b.claim).parameters.query,'SELECT * FROM crm_maintenance_candidate.tx_claim_v1($1::uuid);');assert.ok(get(b.finish).parameters.query.includes('tx_finish_v1'));assert.ok(get('Maintenance TX '+b.label+' próximo').parameters.query.includes('tx_next_v1'));assert.equal(get(b.subscriber).retryOnFail,false);assert.ok(!JSON.stringify(get(b.cleanup)).includes(b.webhook));assert.ok(get(b.cleanup).parameters.jsonBody.includes('.replace(/\'/g,"\'\'")'));
 }
 assert.ok(!JSON.stringify(c).includes('popup-execution'));assert.equal(c.settings.saveDataErrorExecution,'none');
});
test('version/hash/graph and slice drift are refused before any patch; dynamic URLs/credentials are only copied',()=>{
 const w=workflow(),g=guard(w);for(const change of [x=>x.versionId='changed',x=>x.active=false,x=>x.connections[p.BRANDS.fish.derive].main[0].reverse(),x=>x.nodes.find(n=>n.name===p.BRANDS.fish.http).retryOnFail=true]){const d=structuredClone(w);change(d);assert.throws(()=>p.patchTxProducer(d,g),/MAINTENANCE_TX_/);}const d=structuredClone(w);d.nodes.find(n=>n.name===p.BRANDS.fish.claim).parameters.query='select 1';assert.throws(()=>p.patchTxProducer(d,guard(d)),/MAINTENANCE_TX_SQL_DRIFT/);
});
test('body projection preserves used values and scopes, drops unrelated metadata, rejects recursive secrets; JSON works across VM realms',()=>{
 const b=body('fish',{email:'SYNTHETIC@example.invalid',metadata:{source:'synthetic'},items:[{name:'Item',qty:1,external_metadata:'ignored'}]});const expected={...b,email:b.email.toLowerCase(),items:[{name:'Item',qty:1}]};delete expected.metadata;assert.deepEqual(protocol.normalizeJSON('fish',JSON.stringify(b)),expected);
 for(const secret of [{headers:{}},{extra:{api_key:'synthetic-secret'}},{items:[{name:'Item',credentials:{}}]}])assert.throws(()=>protocol.normalizeJSON('fish',JSON.stringify({...body(),...secret})),/MAINTENANCE_TX_CONTROL/);
 const code=protocol.source()+`return normalizeJSON('fish',input);`;const actual=vm.runInNewContext('(function(){'+code+'})()',{input:JSON.stringify(b),Object,JSON});assert.deepEqual(JSON.parse(JSON.stringify(actual)),expected);assert.throws(()=>protocol.normalizeJSON('aristo',JSON.stringify(body())),/MAINTENANCE_TX_SCOPE/);
});
test('mail header fields reject CRLF injection while body paragraphs retain intentional newlines',()=>{
 for(const key of ['email','name','from_email','reply_to','subject'])for(const newline of ['\r','\n'])assert.throws(()=>protocol.normalizeJSON('fish',JSON.stringify(body('fish',{[key]:key==='from_email'?'Injected'+newline+'<orders@fishermans.com.br>':String(body()[key]||'Synthetic')+newline+'Bcc: synthetic@example.invalid'}))),/MAINTENANCE_TX_(HEADER|IDENTITY)/);
 const value=body('fish',{paragraph_1:'First line\nSecond line'});assert.equal(protocol.normalizeJSON('fish',JSON.stringify(value)).paragraph_1,value.paragraph_1);
});
