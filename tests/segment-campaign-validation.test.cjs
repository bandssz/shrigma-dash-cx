'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const F=require('./segment-campaign-binding-fixture.cjs'),B=require('../n8n/growth/segment-campaign-binding.cjs'),Counter=require('../n8n/growth/segment-audience-listmonk.cjs'),API=require('../n8n/growth/segment-campaign-binding-api.cjs');
async function setup(t,rule={op:'in_list',list_id:101}){
 const db=new PGlite();t.after(()=>db.close());const f=await F.setup(db,{countProvider:Counter.countAudience});
 await db.exec("UPDATE shrigma_panel_permission_v1 SET caps=caps||'[\"validate\"]'::jsonb WHERE principal_id='manager'");
 const a=await f.createAudience('fish','validation-audience',rule),i=await f.inspect('fish',100,a);assert.equal(i.status,200);
 assert.equal((await f.bind(i.body.intent)).status,201);const b=await f.bound(100),api=API.createCampaignBindingAPI({store:f.service});
 const request={acao:B.ACTIONS.validate,brand:'fish',campaign_id:100,expected_campaign_version:b.campaign_version,expected_binding_version:b.binding_version,expected_binding_hash:b.binding_hash};
 const call=(p=request,key='synthetic-manager-key')=>api.handle({method:'POST',request:{headers:{Authorization:'Bearer '+key},body:p}});
 return {...f,a,request,call};
}
test('read-only validation is revision-bound, requires live validate permission and never calls legacy audience review',async t=>{
 const f=await setup(t),before=await f.current(100),r=await f.call();assert.equal(r.status,200);
 assert.equal(r.body.validation.audience.eligible_count,1);assert.equal(r.body.validation.authorizes_send,false);
 assert.deepEqual(r.body.validation.content,{ok:false,error:'CAMPAIGN_CONTENT_INVALID'});
 assert.equal(r.body.validation.binding.audience_id,f.a.id);assert.equal(r.body.validation.binding.audience_revision,1);
 assert.equal(Date.parse(r.body.validation.expires_at)-Date.parse(r.body.validation.checked_at),60000);
 assert.deepEqual(await f.current(100),before);assert.equal(f.trace.some(q=>q.text.includes("'review'")),false);
 assert.equal((await f.call({...f.request,expected_binding_hash:'f'.repeat(64)})).status,409);
 assert.equal((await f.call({...f.request,expected_binding_version:0})).status,400);
 assert.equal((await f.call({...f.request,definition:{}})).status,400);
 assert.equal((await f.call(f.request,'synthetic-reader-key')).status,403);
 await f.db.exec("UPDATE shrigma_panel_permission_v1 SET caps='[\"draft\",\"read_content\"]' WHERE principal_id='manager'");
 assert.equal((await f.call()).status,403);
});
test('unconnected facts remain unknown, while genuine opt-out can prove zero; neither authorizes sends',async t=>{
 const f=await setup(t,{op:'condition',field:'purchase.count',operator:'eq',value:0});
 const r=await f.call();assert.equal(r.status,200);assert.deepEqual(r.body.validation.audience,{source_confirmed:false,eligible_count:null,unknown_reason:'external_source_unavailable'});
 await f.db.exec("UPDATE subscribers SET status='blocklisted'");
 const empty=await f.call();assert.equal(empty.status,200);assert.deepEqual(empty.body.validation.audience,{source_confirmed:true,eligible_count:0,unknown_reason:null});
 assert.equal(empty.body.validation.authorizes_selection,false);
});
test('validation reauthorizes after its final clock query',async t=>{
 const f=await setup(t);f.control.beforeQuery=async(q,_p,tx)=>{if(q===B.SQL.clock)await tx.query("UPDATE shrigma_panel_permission_v1 SET caps='[\"read_content\",\"draft\"]' WHERE principal_id='manager'");};
 assert.equal((await f.call()).status,403);
});
test('bound immutable revision survives a newer audience head; archive, list policy drift and expired catalog block it',async t=>{
 const f=await setup(t);const hash=(await f.call()).body.validation.binding.definition_hash;
 const edit=await f.call; // The audience API retains its own operation protocol.
 const result=await f.api.handle({method:'POST',request:{headers:{Authorization:'Bearer synthetic-manager-key'},body:{acao:'segmento_salvar',brand:'fish',id:f.a.id,expected_version:1,definition:{...f.a.definition,rule:{op:'in_list',list_id:17}},idempotency_key:'newer-audience-head',expected_catalog_hash:f.catalogHashes.fish}}});assert.equal(result.status,200);
 const old=await edit();assert.equal(old.status,200);assert.equal(old.body.validation.binding.definition_hash,hash);assert.equal(old.body.validation.audience.eligible_count,1);
 await f.db.exec("UPDATE lists SET optin='single' WHERE id=101");assert.equal((await edit()).status,409);
 await f.db.exec("UPDATE lists SET optin='double' WHERE id=101; UPDATE crm_audience_v2.config SET checked_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '6 minutes' WHERE brand='fish'");assert.equal((await edit()).status,503);
 await f.refresh('fish');await f.db.exec("UPDATE crm_audience_v2.audience SET archived=true WHERE id='"+f.a.id+"'");assert.equal((await edit()).status,409);
});
