'use strict';
// Actual compiled portal, same-origin HTTP handler, original Master session/CSRF.
// Synthetic SQLite users and issuer adapters only; no real provider/network effects.
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,hosts}=require('./corporate-writer-fixture.cjs');
const {transport,shell,until}=require('./helpers/claude-portal-pages.cjs');
const S=require('../services/dashboard-operational/server.cjs'),P=require('../services/dashboard-operational/proxy.cjs');
async function setup(t,{loseAck,values=new Map(),member=true}={}){
 const f=await fixture(t);let id=null;if(member){id=await f.manager();f.auth.setRequestedAccess({context:f.context,userId:id,requestedAccess:'read'});}
 const read=P.FIXED_DESTINATIONS['crm-read'],campaign=P.REVIEWED_DYNAMIC.routes.campaigns;
 const runtime={kick:async()=>{f.auth.fulfillManagedCampaignWriterRequests();for(const operation of f.auth.managedCampaignWriterJournal.pending(8))await f.coordinator.run(operation);f.auth.reconcileUserProfileUpdates();},close:async()=>{}};
 const settings={...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,crmManagedWriter:{...f.config.crmManagedWriter,provisionerToken:'S'.repeat(43)},upstreams:{'crm-read':read,campaigns:campaign},allowedUpstreamHosts:[new URL(read).hostname,new URL(campaign).hostname],dynamicRouteManifest:{schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:campaign}},crmCorporateCreate:true};
 const app=S.createServer(settings,{auth:f.auth,managedCrmRuntime:runtime,fetchImpl:()=>{throw Error('NO_UPSTREAM_BUSINESS');}});t.after(()=>app.removeAllListeners());const http=transport(app);
 const make=()=>shell(http,{host:hosts.manager,area:'gestao',cookie:f.context.cookieHeader,loseAck,values}),ui=make();await ui.ready();await until(()=>!ui.el('entry-shell').hidden,'Master shell');
 const manage=async(x=ui)=>{x.el('entry-manage').click();await until(()=>!x.el('admin-panel').hidden&&x.document.querySelector('.user-row'),'actual managers');};await manage();
 return {f,id,http,ui,make,manage,runtime};
}
const row=(a,id=a.id)=>[...a.ui.document.querySelectorAll('.user-row')].find(r=>r.querySelector('[data-user-profile="'+id+'"]'));
const form=a=>a.ui.document.querySelector('[data-user-profile="'+a.id+'"]');
const field=(form,name)=>form.querySelector('[data-profile-field="'+name+'"]');
const submit=(a,form)=>form.dispatchEvent(new a.ui.window.Event('submit',{cancelable:true}));
const updates=ui=>ui.calls.filter(c=>c.method==='POST'&&c.body?.action==='update');
const dbrow=(a)=>a.f.auth.users({context:a.f.context}).find(u=>u.id===a.id);

test('compiled initial signup directly chooses Leitura or Edição and records one signed Master authorization without an approval step',async t=>{
 const a=await setup(t,{member:false}),ui=a.ui;
 assert.equal(ui.el('admin-access').querySelector('option[value="read"]').textContent,'Leitura');assert.equal(ui.el('admin-access').querySelector('option[value="edit"]').textContent,'Edição');assert.doesNotMatch(ui.el('admin-panel').textContent,/Solicitar edição|Nível solicitado|Edição é uma solicitação/);
 ui.input('admin-email','analyst@fishermans.com.br');ui.select('admin-brand','aristo');ui.select('admin-access','edit');await ui.submit('admin-invite-form');await ui.submit('admin-invite-form');
 await until(()=>!ui.el('admin-invite-result').hidden,'actual invitation');const calls=ui.calls.filter(c=>c.body?.action==='invite');assert.equal(calls.length,1);assert.equal(calls[0].body.requestedAccess,'edit');assert.equal(calls[0].body.brand,'aristo');assert.equal(calls[0].body.permissions.growth.edit,false);
 const id=a.f.db.prepare('SELECT id FROM users WHERE email=?').get('analyst@fishermans.com.br').id;assert.ok(a.f.db.prepare('SELECT authority_mac FROM crm_writer_request_authority_v1 WHERE user_id=?').get(id));assert.equal(a.f.db.prepare('SELECT can_edit FROM grants WHERE user_id=?').get(id).can_edit,0);assert.match(ui.el('admin-message').textContent,/Convite com Edição criado/);assert.doesNotMatch(ui.el('admin-message').textContent,/Edição ativa|solicitada/);assert.equal(ui.calls.some(c=>c.body?.action==='crm_writer_approve'),false);assert.equal(a.f.events.length,0);
});

test('compiled existing-user editor directly applies Edição once, preserves password and browser journal, and does not advertise closed content',async t=>{
 const values=new Map(),a=await setup(t,{values}),before=a.f.db.prepare('SELECT password_hash FROM users WHERE id=?').get(a.id).password_hash;
 values.set('shrigma_campaign_bff_v1:'+a.f.master.uiKey+':fish',JSON.stringify({schema:'crm-campaign-bff-client-v1',brand:'fish',action:'campanha_validar',attemptKey:'synthetic_preserved_attempt_fish',command:{acao:'campanha_validar',brand:'fish',id:7,expected_version:'a'.repeat(32),idempotency_key:'synthetic_preserved_attempt_fish'},phase:'uncertain'}));const storage=[...values];
 const editor=form(a);assert.ok(editor);assert.equal(field(editor,'email').value,'manager@oaristocrata.com');assert.equal(field(editor,'area').value,'growth');assert.equal(field(editor,'brand').value,'fish');field(editor,'access').value='edit';submit(a,editor);submit(a,editor);
 await until(()=>updates(a.ui).length===1&&a.ui.el('admin-message').textContent.startsWith('Edição configurada'),'effective edit choice');await until(()=>dbrow(a).permissions.growth.edit===true,'attested writer');
 assert.equal(updates(a.ui)[0].status,200);assert.match(updates(a.ui)[0].body.expectedRevision,/^[a-f0-9]{64}$/);assert.equal(a.f.db.prepare('SELECT password_hash FROM users WHERE id=?').get(a.id).password_hash,before);assert.equal(a.f.db.prepare('SELECT count(*) n FROM user_profile_updates_v1').get().n,0);assert.deepEqual([...values],storage);assert.equal(a.ui.calls.some(c=>c.body?.action==='crm_writer_approve'),false);
 // Real content gate still refuses admission independently of native credential readiness.
 assert.doesNotMatch(row(a).textContent,/Edição de campanhas ativa/);assert.match(row(a).textContent,/criação, edição e agendamento aguardam validação/);
});

test('compiled profile edit blocks old scope and recovers the same new invitation only after confirmed READ revocation',async t=>{
 const a=await setup(t),editor=form(a);field(editor,'email').value='updated@fishermans.com.br';field(editor,'area').value='organico';field(editor,'brand').value='aristo';field(editor,'access').value='read';submit(a,editor);
 await until(()=>updates(a.ui).length===1&&a.ui.el('admin-users').textContent.includes('acesso anterior está bloqueado'),'actual pending transfer');assert.equal(updates(a.ui)[0].status,202);assert.equal(dbrow(a).status,'disabled');assert.equal(dbrow(a).email,'manager@oaristocrata.com');assert.equal(a.ui.document.querySelector('[data-user-action="update-finish"]'),null);assert.equal(a.ui.el('admin-crm-reconcile').hidden,false);
 a.f.confirmReadRevoke(a.id);a.ui.el('admin-crm-reconcile').click();await until(()=>a.ui.document.querySelector('[data-user-action="update-finish"]'),'confirmed new invitation');assert.equal(dbrow(a).email,'updated@fishermans.com.br');assert.equal(dbrow(a).brand,'aristo');assert.deepEqual(dbrow(a).areas,['organico']);assert.equal(dbrow(a).permissions.organico.edit,false);
 a.ui.document.querySelector('[data-user-action="update-finish"]').click();await until(()=>!a.ui.el('admin-invite-result').hidden,'recovered invitation');const first=a.ui.el('admin-invite-link').value;assert.match(first,/^https:\/\/organico\.shrigma\.com\.br\/#invite=/);assert.match(a.ui.el('admin-message').textContent,/Cadastro atualizado/);assert.equal(updates(a.ui).length,1);
 a.ui.el('admin-invite-hide').click();a.ui.document.querySelector('[data-user-action="update-finish"]').click();await until(()=>!a.ui.el('admin-invite-result').hidden,'same invitation recovery');assert.equal(a.ui.el('admin-invite-link').value,first);assert.equal(a.f.db.prepare('SELECT count(*) n FROM invites WHERE user_id=? AND used_at IS NULL').get(a.id).n,1);assert.equal(updates(a.ui).length,1);
});

test('lost update ACK and reload do not replay mutation; stale form refusal refreshes actual fields honestly',async t=>{
 let lose=true;const a=await setup(t,{loseAck:(method,body)=>lose&&method==='POST'&&body?.action==='update'}),editor=form(a);field(editor,'brand').value='aristo';submit(a,editor);
 await until(()=>updates(a.ui).length===1&&a.ui.el('admin-message').textContent.includes('nenhuma alteração foi reenviada'),'lost ACK');assert.equal(dbrow(a).status,'disabled');assert.equal(updates(a.ui).length,1);
 lose=false;const reload=a.make();await reload.ready();await until(()=>!reload.el('entry-shell').hidden,'reloaded authenticated Master');await a.manage(reload);assert.equal(updates(reload).length,0);assert.match(reload.el('admin-users').textContent,/acesso anterior está bloqueado/);
 const b=await setup(t),stale=form(b);b.f.auth.setRequestedAccess({context:b.f.context,userId:b.id,requestedAccess:'read'});field(stale,'brand').value='aristo';submit(b,stale);await until(()=>updates(b.ui).length===1&&b.ui.el('admin-message').textContent.includes('cadastro mudou'),'stale snapshot rejection');assert.equal(updates(b.ui)[0].status,409);assert.equal(dbrow(b).brand,'fish');assert.equal(dbrow(b).status,'active');assert.equal(b.f.db.prepare('SELECT count(*) n FROM user_profile_updates_v1').get().n,0);
});

test('compiled pending editor corrects the destination without another native revoke and preserves the blocked old scope',async t=>{
 const a=await setup(t),first=form(a);field(first,'email').value='pending@fishermans.com.br';field(first,'brand').value='aristo';submit(a,first);
 await until(()=>updates(a.ui).length===1&&a.ui.el('admin-message').textContent.includes('Alteração registrada'),'pending transfer');assert.equal(dbrow(a).status,'disabled');const count=a.f.db.prepare("SELECT count(*) n FROM crm_manager_operations_v1 WHERE kind='revoke'").get().n;
 const editor=form(a);assert.ok(editor);assert.equal(field(editor,'email').value,'pending@fishermans.com.br');assert.match(editor.parentElement.textContent,/Corrigir alteração pendente/);field(editor,'email').value='corrected@fishermans.com.br';submit(a,editor);
 await until(()=>updates(a.ui).length===2&&a.ui.el('admin-message').textContent.includes('Alteração registrada'),'corrected intention');assert.equal(a.f.db.prepare("SELECT count(*) n FROM crm_manager_operations_v1 WHERE kind='revoke'").get().n,count);assert.equal(dbrow(a).email,'manager@oaristocrata.com');assert.equal(dbrow(a).status,'disabled');assert.match(a.ui.el('admin-users').textContent,/acesso anterior está bloqueado/);
 a.f.confirmReadRevoke(a.id);a.ui.el('admin-crm-reconcile').click();await until(()=>dbrow(a).email==='corrected@fishermans.com.br'&&a.ui.document.querySelector('[data-user-action="update-finish"]'),'actual corrected invitation');assert.equal(updates(a.ui).length,2);assert.equal(dbrow(a).permissions.growth.edit,false);
});
