'use strict';
// Isolated current-owner composition. No production key, identity, SQL or network.
const test=require('node:test'),a=require('node:assert/strict'),path=require('node:path');
const {fixture,originalResponse,DatabaseSync,settingsFromEnv,runtime,origin}=require('./root-fixture.cjs');
const {environmentForOriginalMasterTemplateRead}=require(path.join(runtime,'server.cjs'));
test('browser READ and native catalog preserve the exact original owner, brand and record',async t=>{
 const f=await fixture(t),r=await f.browser('GET','/api/templates?acao=listar&marca=fish&canal=email&offset=0&limit=20');
 a.equal(r.status,200);a.equal(r.body.contract,'crm-template-read-v1');a.equal(r.body.brand,'fish');a.equal(r.body.total,1);a.equal(r.body.templates[0].id,'42');a.equal(r.body.templates[0].components.body_html,'<p>Isolated content</p>');
 a.equal(f.calls.length,1);a.equal(f.calls[0].method,'GET');a.equal(f.calls[0].url,'https://n8n.shrigma.com.br/webhook/crm-template-api-242c0db6ddb8?acao=listar&marca=fish&canal=email');
 const native=(await f.rpc()).value.result.structuredContent;a.equal(native.status,200);a.equal(native.body.total,1);a.equal(native.body.readOnly,true);a.equal(native.body.templates[0].id,'42');a.equal(JSON.stringify(native).includes('Isolated content'),false);
 for(const secret of [f.key,f.issued.token,f.ctx.cookieHeader,f.ctx.csrf])a.equal(JSON.stringify({r,native}).includes(secret),false);
});
test('disabled flag and all other template actions refuse before any original request',async t=>{
 const disabled=await fixture(t,{enabled:false});a.notEqual((await disabled.rpc()).value.result?.structuredContent?.status,200);a.notEqual((await disabled.browser('GET','/api/templates?acao=listar&marca=fish&canal=email')).status,200);a.equal(disabled.calls.length,0);
 const f=await fixture(t);for(const p of ['acao=historico&marca=fish&draft_id=sample','acao=submissao&marca=fish&submission_id=sample','acao=rascunho&marca=fish','acao=listar&marca=todas&canal=email','acao=listar&marca=fish&marca=aristo&canal=email','acao=listar&marca=fish&canal=whatsapp','acao=listar&marca=fish&canal=email&actor=admin'])a.notEqual((await f.browser('GET','/api/templates?'+p)).status,200);
 a.notEqual((await f.browser('POST','/api/templates?acao=listar&marca=fish&canal=email',{})).status,200);a.equal(f.calls.length,0);
});
test('expiry and native revocation during template READ discard the response',async t=>{
 for(const kind of ['expiry','native']){const f=await fixture(t);f.override(u=>{
  if(kind==='expiry'){const db=new DatabaseSync(f.dbPath);db.prepare('UPDATE campaign_writer_attestation_v1 SET expires_at=1 WHERE user_id=?').run(f.user.id);db.close();}
  else f.auth.nativeConnections.revoke({context:f.ctx,connectionId:f.issued.connection.id});
  return originalResponse({templates:[],consultado_em:'2026-10-08T15:00:00Z'},u);
 });a.notEqual((await f.rpc()).value.result?.structuredContent?.status,200);a.equal(f.calls.length,1);}
});
test('aggregate capabilities preserve published journey READ and expose no template writing',async t=>{
 const f=await fixture(t),r=await f.browser('GET','/api/crm-read?action=cache_growth&painel=growth');a.equal(r.status,200,JSON.stringify(r));
 a.equal(r.body.capabilities.templates.read_content,true);a.equal(r.body.capabilities.templates.read_contract,'crm-template-read-v1');a.equal(r.body.capabilities.endpoints.templates,origin+'/api/templates');a.equal(r.body.capabilities.workflows.published_read,true);
 for(const k of ['draft','validate','submit','submit_email','list_history'])a.equal(r.body.capabilities.templates[k],false);
 const session=await f.browser('GET','/auth/session');a.equal(session.body.features.templateRead,true);a.equal(session.body.features.crmIndividualAccessUnavailable,true);
 const published=(await f.rpc('fish','crm_journey_catalog')).value.result.structuredContent;a.equal(published.status,200);a.equal(published.body.source,'original-published-definitions');
});
test('template opt-in projection is immutable and requires the existing original profile',async t=>{
 const f=await fixture(t),preserved={...f.env};delete preserved.DASHBOARD_CRM_MASTER_TEMPLATE_READ;const before=JSON.stringify(preserved),next=environmentForOriginalMasterTemplateRead({DASHBOARD_CRM_MASTER_TEMPLATE_READ:'enabled'},preserved);
 a.equal(JSON.stringify(preserved),before);a.equal(next.DASHBOARD_ENCRYPTION_KEY,preserved.DASHBOARD_ENCRYPTION_KEY);a.equal(next.DASHBOARD_UPSTREAMS,preserved.DASHBOARD_UPSTREAMS);a.equal(settingsFromEnv(next).crmMasterTemplateRead,true);
 for(const changes of [{DASHBOARD_CRM_PUBLISHED_JOURNEY_READ:'disabled'},{DASHBOARD_CRM_CAMPAIGN_WRITER_PROFILE:undefined},{DASHBOARD_CRM_MANAGED_READ:'enabled'}])a.throws(()=>environmentForOriginalMasterTemplateRead({DASHBOARD_CRM_MASTER_TEMPLATE_READ:'enabled'},{...preserved,...changes}));
 a.throws(()=>environmentForOriginalMasterTemplateRead({DASHBOARD_CRM_MASTER_TEMPLATE_READ:'implicit'},preserved));
});
test('native status verifies only its admitted brand without exporting email bodies',async t=>{
 const f=await fixture(t),r=(await f.rpc('fish','crm_status')).value.result.structuredContent;a.equal(r.status,200);a.equal(r.body.features.templateRead,true);a.equal(r.body.templateSources.length,1);a.equal(r.body.templateSources[0].brand,'fish');a.equal(r.body.templateSources[0].status,200);a.equal(r.body.templateSources[0].total,1);a.equal(JSON.stringify(r).includes('Isolated content'),false);
 a.equal(f.calls.filter(c=>c.url.includes('acao=listar')).length,1);a.equal(f.calls.some(c=>c.method!=='GET'),false);
});
