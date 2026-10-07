'use strict';
const t=require('node:test'),a=require('node:assert/strict');
const {projectJourneyRead,journeySummary}=require('../services/dashboard-operational/crm-journey-read.cjs');
const {createNativeMcp}=require('../services/dashboard-operational/crm-native-mcp.cjs');
const {dispatchJson}=require('../services/dashboard-operational/crm-native-mcp.cjs');
const flow=(marca='fish')=>({key:'original-config',marca,nome:'Configuração original',gatilho:{evento:'cart.abandoned',chave_evento:'original-event',reentrada:'nunca',saida:['purchase.confirmed']},versao:{id:'revision-original',numero:2,ativa:false,publicada_em:'2026-10-06T12:00:00Z'},modo:'interno',etapas:[{key:'wait-original',tipo:'espera',ordem:1,espera_seg:3600,saida_para:'end-original'},{key:'end-original',tipo:'fim',ordem:2}],credential:'must-never-return'});
const snapshot=fluxos=>({status:200,body:{_escopo:'growth',_cache_gerado_em:'2026-10-07T12:00:00Z',crm_fluxo_def:{schema_version:1,generated_at:'2026-10-07T11:00:00Z',fluxos},crm_fluxo:[{marca:'fish',flow:'historic-only'}]}});
 t('native status reports actual public file pins using the original health dispatcher',async()=>{
  const calls=[],f=fixture(async q=>{calls.push(q.path);return q.path==='/auth/session'?{status:200,body:{authenticated:true,user:{role:'superadmin'}}}:{status:200,body:{nativeMcp:true,nativeBackendManifestSha256:'a'.repeat(64),journeyPresentationManifestSha256:'b'.repeat(64),journeyConfiguredRead:true,journeyPublicFiles:[{path:'growth.html',bytes:100,sha256:'c'.repeat(64),credential:'private'}]}};});
  const r=await f.mcp.call('crm_status',{},'genuine-fixture');a.deepEqual(calls,['/auth/session','/healthz']);a.equal(r.body.runtime.journeyConfiguredRead,true);a.equal(r.body.runtime.journeyPublicFiles[0].sha256,'c'.repeat(64));a.equal(JSON.stringify(r).includes('private'),false);
 });
function fixture(invoke,{brands=['fish']}={}){
 let revoked=false;const checks=[];
 const nativeConnections={authenticate(bearer,q={}){if(bearer!=='genuine-fixture'||revoked)throw Object.assign(Error('NATIVE_REVOKED'),{code:'NATIVE_REVOKED',status:401});if(q.brand&&!brands.includes(q.brand))throw Object.assign(Error('BRAND_DENIED'),{code:'BRAND_DENIED',status:403});if(q.scope&&!['crm.read'].includes(q.scope))throw Object.assign(Error('NATIVE_SCOPE_DENIED'),{code:'NATIVE_SCOPE_DENIED',status:403});checks.push(q);return {brands,scopes:['crm.read']};},context(){return {host:'master.synthetic.invalid',origin:'https://master.synthetic.invalid',csrf:'private-fixture',originalSessionOwner:'original'};}};
 return {mcp:createNativeMcp({auth:{nativeConnections},managerHost:'master.synthetic.invalid',invoke}),checks,revoke(){revoked=true;}};
}
t('brand projection preserves original transitions and rejects private fields',()=>{
 const r=projectJourneyRead(snapshot([flow(),flow('aristo')]),'fish');a.equal(r.body.definitions.length,1);a.equal(r.body.definitions[0].etapas[0].saida_para,'end-original');a.equal(r.body.definitions[0].versao.ativa,false);a.equal(JSON.stringify(r).includes('must-never-return'),false);a.equal(JSON.stringify(r).includes('aristo'),false);a.equal(r.body.authorizesSend,false);
});
t('missing definitions remain unavailable, explicit empty is distinct',()=>{
 const raw={status:200,body:{_escopo:'growth',crm_fluxo:[]}};a.equal(projectJourneyRead(raw,'fish').body.configuredCount,null);a.equal(projectJourneyRead(raw,'fish').body.source,'definitions-unavailable');a.equal(projectJourneyRead(snapshot([]),'fish').body.configuredCount,0);a.equal(projectJourneyRead(snapshot([]),'fish').body.source,'declared');
});
t('invalid selected definitions stay partial; foreign malformed definitions are excluded',()=>{
 const bad={...flow(),gatilho:null};let r=projectJourneyRead(snapshot([bad,flow('aristo')]),'fish');a.equal(r.body.source,'partial');a.equal(r.body.configuredCount,null);r=projectJourneyRead(snapshot([flow(),{...bad,marca:'aristo'}]),'fish');a.equal(r.body.source,'declared');a.equal(r.body.invalidDefinitionCount,0);
});
t('scope, unknown brands, malformed and oversized source refuse without truncation',()=>{
 a.throws(()=>projectJourneyRead({status:200,body:{_escopo:'influs'}},'fish'),{code:'JOURNEY_SCOPE_UNCONFIRMED'});a.throws(()=>projectJourneyRead(snapshot([{...flow(),marca:null}]),'fish'),{code:'JOURNEY_SCOPE_UNCONFIRMED'});a.throws(()=>projectJourneyRead(snapshot(Array.from({length:101},()=>flow())),'fish'),{code:'JOURNEY_SOURCE_LIMIT'});a.throws(()=>projectJourneyRead(snapshot([]),'olivas'),{code:'BRAND_DENIED'});
});
 t('original Master todos access retains explicit growth data scope; access never substitutes payload scope',()=>{
  const r=snapshot([flow()]);r.body._painel='todos';let p=projectJourneyRead(r,'fish',{now:()=> '2026-10-07T12:00:00Z'});a.equal(p.body.definitionState,'loaded');a.equal(p.body.definitionFreshness,'validity-not-declared');a.deepEqual(p.body.definitions[0].graph.links.map(l=>[l.fromKey,l.toKey]),[['wait-original','end-original']]);r.body._escopo='influs';a.throws(()=>projectJourneyRead(r,'fish'),{code:'JOURNEY_SCOPE_UNCONFIRMED'});delete r.body._escopo;r.body._painel='growth';a.throws(()=>projectJourneyRead(r,'fish'),{code:'JOURNEY_SCOPE_UNCONFIRMED'});r.body._escopo='growth';r.body._painel='influs';a.throws(()=>projectJourneyRead(r,'fish'),{code:'JOURNEY_SCOPE_UNCONFIRMED'});r.body._painel='todos';r.body.crm_fluxo_def.schema_version=2;p=projectJourneyRead(r,'fish');a.equal(p.body.source,'unsupported-schema');a.equal(p.body.configuredCount,null);
 });
t('native journey reader uses original dispatcher and original context; no supplied actor',async()=>{
 const calls=[];const f=fixture(async q=>{calls.push(q);return snapshot([flow()]);});const r=await f.mcp.call('crm_journey_catalog',{brand:'fish'},'genuine-fixture');a.equal(r.status,200);a.equal(calls.length,1);a.equal(calls[0].method,'GET');a.equal(calls[0].path,'/api/crm-read?action=cache_growth&painel=growth');a.equal(calls[0].context.originalSessionOwner,'original');a.equal(calls[0].body,undefined);await a.rejects(f.mcp.call('crm_journey_catalog',{brand:'fish',actor:'invented'},'genuine-fixture'),{code:'NATIVE_ARGUMENTS_INVALID'});
});
t('cross brand refusal makes no dispatcher call and revocation during read refuses result',async()=>{
 let calls=0;let f=fixture(async()=>{calls++;return snapshot([]);});await a.rejects(f.mcp.call('crm_journey_catalog',{brand:'aristo'},'genuine-fixture'),{code:'BRAND_DENIED'});a.equal(calls,0);f=fixture(async()=>{f.revoke();return snapshot([flow()]);});await a.rejects(f.mcp.call('crm_journey_catalog',{brand:'fish'},'genuine-fixture'),{code:'NATIVE_REVOKED'});
});
t('catalog source summary cannot leak definitions or replace campaign result',async()=>{
 const calls=[];const f=fixture(async q=>{calls.push(q);return q.path.startsWith('/api/campaigns')?{status:200,body:{brand:'fish',lists:[],templates:[],initiatives:[]}}:snapshot([flow()]);});const r=await f.mcp.call('crm_campaign_catalog',{brand:'fish'},'genuine-fixture');a.equal(r.body.brand,'fish');a.equal(r.body.journeySource.source,'declared');a.equal(Object.hasOwn(r.body.journeySource,'definitions'),false);a.deepEqual(calls.map(q=>[q.method,q.path]),[['GET','/api/campaigns?acao=campanha_catalogo&brand=fish'],['GET','/api/crm-read?action=cache_growth&painel=growth'],['GET','/api/segments?acao=segmentos_listar&brand=fish&offset=0&limit=50']]);a.equal(r.body.audienceWriteAdmission.status,403);a.equal(journeySummary(projectJourneyRead(snapshot([]),'fish')).configuredCount,0);
});
t('unavailable source retains catalog, revocation does not fall back',async()=>{
 let f=fixture(async q=>q.path.startsWith('/api/campaigns')?{status:200,body:{brand:'fish'}}:{status:503,body:{credential:'private'}});let r=await f.mcp.call('crm_campaign_catalog',{brand:'fish'},'genuine-fixture');a.equal(r.status,200);a.equal(r.body.journeySource.status,503);a.equal(JSON.stringify(r).includes('private'),false);f=fixture(async q=>{if(q.path.startsWith('/api/campaigns'))return {status:200,body:{brand:'fish'}};f.revoke();return snapshot([]);});await a.rejects(f.mcp.call('crm_campaign_catalog',{brand:'fish'},'genuine-fixture'),{code:'NATIVE_REVOKED'});
});
t('larger original cache read is bounded to its exact path; other reads retain limit',async()=>{
 const payload={_escopo:'growth',ignoredPadding:'x'.repeat(3*1024*1024)};
 const dispatch=(req,res)=>res.end(JSON.stringify(payload));
 const context={host:'master.synthetic.invalid',origin:'https://master.synthetic.invalid',csrf:'original-private'};
 const read=await dispatchJson(dispatch,{method:'GET',path:'/api/crm-read?action=cache_growth&painel=growth',context});a.equal(read.body.ignoredPadding.length,3*1024*1024);
 await a.rejects(dispatchJson(dispatch,{method:'GET',path:'/api/campaigns?acao=campanha_catalogo&brand=fish',context}),{code:'NATIVE_RESPONSE_LIMIT'});
 a.equal(Object.hasOwn(projectJourneyRead(read,'fish').body,'ignoredPadding'),false);
});
