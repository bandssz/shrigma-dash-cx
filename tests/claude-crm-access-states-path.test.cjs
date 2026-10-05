'use strict';
/* Frente 4 — cadastro e estados de acesso pelo portal real, de ponta a ponta e sem rede:
   master (Gestão geral) convida pelo formulário → gestor aceita pelo link → login → painel CRM servido pelo
   portal (growth.html + guard.js + bundle) → emissor sintético prepara/confirma → renovação → expiração →
   revogação. A cada passo, o rótulo que o master vê é comparado com a leitura efetiva do gestor e com o que a
   tela do gestor diz. Servidor: createServer real com auth SQLite descartável (crm-managed-read-auth-fixture);
   emissor de credenciais: o cliente sintético do mesmo fixture (prepare/commit), como nos testes do Codex. */
const test=require('node:test'),assert=require('node:assert/strict');
const denied=()=>{throw Error('TEST_REAL_NETWORK_DENIED');};
for(const name of ['node:http','node:https']){const m=require(name);m.request=denied;m.get=denied;}
const net=require('node:net');net.connect=denied;net.createConnection=denied;net.Server.prototype.listen=denied;require('node:tls').connect=denied;globalThis.fetch=denied;
const {fixture,hosts}=require('./helpers/crm-managed-read-auth-fixture.cjs');
const {transport,shell,panel,until}=require('./helpers/claude-portal-pages.cjs');
const S=require('../services/dashboard-operational/server.cjs'),P=require('../services/dashboard-operational/proxy.cjs'),B=require('../services/dashboard-operational/crm-manager-read-bridge.cjs');
const GrowthAccess=require('../growth-access.js');
const manifest={schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:B.DESTINATIONS.campaigns,campaigns_media:B.DESTINATIONS.campaigns_media}};
const OWNER_PASSWORD='synthetic-owner-password-2026',MANAGER_PASSWORD='synthetic-manager-password-2026',DAY=86400000;

test('master: sessão local expira após lista e convite carregados; 401 limpa a administração e orienta novo login sem apagar tentativa uncertain',async t=>{
 const p=await portal(t),s=await master(p),email='admin-idle-expiry@synthetic.invalid';
 s.el('admin-email').value=email;s.select('admin-area','growth');s.select('admin-brand','fish');s.select('admin-access','edit');
 await s.submit('admin-invite-form');
 await until(()=>!s.el('admin-invite-result').hidden&&rowOf(s,email),'lista e convite carregados');
 const rowsBefore=s.el('admin-users').children.length,postsBefore=s.calls.filter(c=>c.path==='/auth/users'&&c.method==='POST').length;
 assert.equal(rowsBefore,2);assert.notEqual(s.el('admin-invite-link').value,'');
 const journalKey='shrigma_campaign_bff_v1:synthetic-idle-review:fish',intent=JSON.stringify({phase:'uncertain',operationId:'synthetic-unknown-ack'});
 s.values.set(journalKey,intent);
 p.f.advance(31*60*1000);
 s.el('entry-manage').click();s.el('entry-manage').click();
 await until(()=>s.calls.some(c=>c.path==='/auth/users'&&c.status===401),'sessão local recusada');
 await until(()=>!s.el('entry-login').hidden,'orientação de novo login');
 assert.match(s.el('entry-message').textContent,/Sua sessão expirou.*Entre novamente/);
 assert.equal(s.el('entry-shell').hidden,true);assert.equal(s.el('admin-panel').hidden,true);assert.equal(s.el('entry-manage').hidden,true);
 assert.equal(s.el('admin-users').children.length,0);assert.equal(s.el('admin-crm-reconcile').hidden,true);
 assert.equal(s.el('admin-invite-result').hidden,true);assert.equal(s.el('admin-invite-link').value,'');
 assert.equal(s.values.get(journalKey),intent,'não apaga nem repete uma tentativa de campanha');
 assert.equal(s.calls.filter(c=>c.path==='/auth/users'&&c.method==='POST').length,postsBefore);
 // Reauthentication uses the existing owner/password; no reset, extra invite or grant.
 await s.login(p.f.config.bootstrapAdminEmail);
 s.el('entry-manage').click();await until(()=>rowOf(s,email),'lista atual após novo login');
 assert.equal(s.el('admin-users').children.length,rowsBefore);assert.equal(s.el('admin-invite-result').hidden,true);
 assert.equal(s.el('admin-invite-link').value,'');assert.equal(s.values.get(journalKey),intent);
 assert.equal(s.calls.filter(c=>c.path==='/auth/users'&&c.method==='POST').length,postsBefore);

 // The same literal route handles every local admin POST, including expiry inside a submit.
 for(const scenario of ['invite','revoke-invite','access_request','revoke-user']){
  const xp=await portal(t),xs=await master(xp),xe='idle-'+scenario+'@synthetic.invalid';
  xs.el('admin-email').value=xe;xs.select('admin-area','growth');xs.select('admin-brand','fish');xs.select('admin-access','edit');
  await xs.submit('admin-invite-form');await until(()=>!xs.el('admin-invite-result').hidden&&rowOf(xs,xe),'convite da ação '+scenario);
  if(scenario==='access_request'||scenario==='revoke-user'){
   const link=new URL(xs.el('admin-invite-link').value);
   await xp.f.accept({token:link.hash.slice('#invite='.length),host:link.hostname});await refresh(xs);
   assert.match(label(xs,xe),/Ativo/);
  }
  const identityState=()=>xp.f.inspect(d=>({users:d.prepare('SELECT id,state FROM users ORDER BY id').all(),grants:d.prepare('SELECT user_id,area,can_read,can_edit FROM grants ORDER BY user_id,area').all(),requests:d.prepare('SELECT user_id,requested_access FROM access_requests ORDER BY user_id').all()}));
  const before=identityState(),posts=xs.calls.filter(c=>c.path==='/auth/users'&&c.method==='POST').length;
  xs.values.set(journalKey,intent);xp.f.advance(31*60*1000);
  if(scenario==='invite'){
   xs.el('admin-email').value='second-'+xe;xs.select('admin-area','growth');xs.select('admin-brand','fish');xs.select('admin-access','edit');await xs.submit('admin-invite-form');
  }else if(scenario==='access_request'){
   const row=rowOf(xs,xe),select=row.querySelector('select');select.value='read';
   select.dispatchEvent(new xs.window.Event('change',{bubbles:true}));
   [...row.querySelectorAll('button')].find(b=>b.textContent==='Salvar').click();
  }else [...rowOf(xs,xe).querySelectorAll('button')].find(b=>b.textContent==='Revogar acesso').click();
  await until(()=>xs.calls.some(c=>c.path==='/auth/users'&&c.method==='POST'&&c.status===401),'POST local recusado '+scenario);
  await until(()=>!xs.el('entry-login').hidden,'login após POST '+scenario);
  const refused=xs.calls.filter(c=>c.path==='/auth/users'&&c.method==='POST').at(-1);
  assert.equal(refused.body.action,scenario.startsWith('revoke-')?'revoke':scenario);assert.equal(refused.status,401);
  assert.equal(xs.el('entry-shell').hidden,true);assert.equal(xs.el('admin-panel').hidden,true);assert.equal(xs.el('entry-manage').hidden,true);
  assert.equal(xs.el('admin-users').children.length,0);assert.equal(xs.el('admin-crm-reconcile').hidden,true);
  assert.equal(xs.el('admin-invite-result').hidden,true);assert.equal(xs.el('admin-invite-link').value,'');
  assert.match(xs.el('entry-message').textContent,/Sua sessão expirou.*Entre novamente/);
  assert.equal(xs.values.get(journalKey),intent);assert.deepEqual(identityState(),before);
  assert.equal(xs.calls.filter(c=>c.path==='/auth/users'&&c.method==='POST').length,posts+1,'nenhum retry automático');
 }
 t.diagnostic('GET users + 4 POST administrativos locais: 401, UI limpa, uncertain preservado, identidade sem efeito e nenhum replay');

});


async function portal(t,cacheExtra=()=>({})){
 const f=await fixture();t.after(()=>f.close());let kicks=0;
 const cache=()=>({_escopo:'growth',_painel:'growth',gerado_em:new Date(f.config.now()).toISOString(),_cache_gerado_em:new Date(Date.now()).toISOString(),crm_diario:[],crm_campanha:[],crm_fluxo:[],crm_conversao:[],capabilities:{},...cacheExtra()});
 const upstream=[];
 const app=S.createServer({...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,upstreams:Object.fromEntries(Object.entries(B.DESTINATIONS).map(([k,v])=>[k,new URL(v)])),allowedUpstreamHosts:[...new Set(Object.values(B.DESTINATIONS).map(v=>new URL(v).hostname))],dynamicRouteManifest:manifest,publicDir:__dirname},
  {auth:f.auth,fetchImpl:async(url,init)=>{upstream.push({url:String(url),authorization:init?.headers?.Authorization});assert.equal(String(url).split('?')[0],B.DESTINATIONS['crm-read']);return new Response(JSON.stringify(cache()),{status:200,headers:{'content-type':'application/json'}});},
   managedCrmRuntime:{kick:async()=>{kicks++;},close:async()=>{}}});
 t.after(()=>app.removeAllListeners());
 return {f,app,http:transport(app),upstream,kicks:()=>kicks};
}
const rowOf=(s,email)=>[...s.document.querySelectorAll('#admin-users .user-row')].find(r=>r.querySelector('strong')?.textContent===email);
const label=(s,email)=>rowOf(s,email)?.querySelector('small')?.textContent||'';
const buttons=(s,email)=>[...(rowOf(s,email)?.querySelectorAll('button')||[])].map(b=>b.textContent);
async function master(p){const s=shell(p.http,{host:hosts.manager,area:'gestao',confirm:()=>true,password:OWNER_PASSWORD});await s.login(p.f.config.bootstrapAdminEmail);
 assert.equal(s.el('entry-manage').hidden,false);s.el('entry-manage').click();await until(()=>!s.el('admin-panel').hidden&&s.calls.some(c=>c.path==='/auth/users'),'gestão de acessos');return s;}
async function refresh(s){const before=s.calls.filter(c=>c.path==='/auth/users'&&c.method==='GET').length;s.el('admin-crm-reconcile').hidden?(s.el('entry-manage').click(),s.el('entry-manage').click()):s.el('admin-crm-reconcile').click();
 await until(()=>s.calls.filter(c=>c.path==='/auth/users'&&c.method==='GET').length>before,'lista atualizada');}
// Leitura efetiva do gestor, pela tela: o painel CRM servido pelo portal.
async function managerView(p,cookie){
 const x=await panel(p.http,{host:hosts.growth,cookie});
 const cache=x.requests.find(r=>r.path?.startsWith('/api/crm-read?action=cache_growth'))||x.requests.find(r=>r.path==='/auth/session'&&x.messages.some(m=>m.data?.type==='shrigma:session-expired'))&&{status:401,error:'SESSION_REQUIRED'};
 return {x,status:cache.status,error:cache.error,alert:x.qa('[role=alert]').map(e=>e.textContent).join(' ').trim(),stamp:x.q('#atualizado-em').textContent,messages:x.messages.map(m=>m.data?.type)};
}

test('convite → aceite → preparação → pronto → renovação → expiração → revogação: o estado mostrado ao master bate com a leitura do gestor e a tela orienta sem prometer acesso',async t=>{
 const p=await portal(t),email='gestora.fish@synthetic.invalid';
 // 1. Master convida pelo formulário: e-mail, setor, marca e nível solicitado.
 let s=await master(p);
 s.input('admin-email',email);s.select('admin-area','growth');s.select('admin-brand','fish');s.select('admin-access','edit');await s.submit('admin-invite-form');
 await until(()=>!s.el('admin-invite-result').hidden||/Não foi possível/.test(s.el('admin-message').textContent),'convite criado');
 const invite=s.calls.find(c=>c.method==='POST'&&c.path==='/auth/users'&&c.body?.action==='invite');
 assert.deepEqual(invite.body,{action:'invite',email,brand:'fish',role:'manager',areas:['growth'],permissions:{growth:{read:true,edit:false}},requestedAccess:'edit'},'convite começa em leitura; edição só solicitada');
 assert.match(s.el('admin-message').textContent,/Convite de leitura criado para CRM · Fishermans\. A edição ficou solicitada e aguarda validação individual\./);
 const link=new URL(s.el('admin-invite-link').value);assert.equal(link.hostname,hosts.growth);
 await until(()=>rowOf(s,email),'linha do convite');assert.equal(label(s,email),'CRM · Fishermans · Conteúdo em leitura · criação, edição e agendamento aguardam validação · Convite pendente · CRM aguarda aceite');
 assert.ok(!buttons(s,email).includes('Renovar acesso CRM'));

 // 2. Gestor abre o link, cria a senha e entra. O shell não promete dados.
 const g=shell(p.http,{host:hosts.growth,area:'crm',hash:link.hash.slice(1),password:MANAGER_PASSWORD});await g.acceptInvite();await g.login(email);
 assert.equal(g.el('entry-shell').hidden,false);assert.equal(g.el('entry-brand').textContent,'Fishermans');assert.equal(g.el('entry-campaign-open').hidden,true);
 const user=p.f.inspect(d=>d.prepare('SELECT id FROM users WHERE email=?').get(email));
 const pending=async(step,cookie=g.cookie())=>{const v=await managerView(p,cookie);assert.equal(v.status,503,step);assert.equal(v.error,'CRM_ACCESS_NOT_READY',step);
  assert.match(v.alert,new RegExp(GrowthAccess.ACESSO_CRM_PENDENTE.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),step);assert.equal(v.stamp,'Dados indisponíveis',step);assert.doesNotMatch(v.alert,/HTTP 503/,step);return v;};
 await pending('preparando');
 await refresh(s);assert.equal(label(s,email),'CRM · Fishermans · Conteúdo em leitura · criação, edição e agendamento aguardam validação · Ativo · CRM preparando acesso');assert.equal(s.el('admin-crm-reconcile').hidden,false);assert.ok(p.kicks()>=1,'conferir acessos aciona o provisionamento');

 // 3. Emissor prepara (confirmação ainda pendente): continua sem leitura e sem promessa.
 const op=p.f.queued(user.id),client=p.f.client(),prepared=await p.f.prepare(client,op);
 await refresh(s);assert.match(label(s,email),/CRM preparando acesso$/);await pending('aguardando confirmação');
 // 4. Confirmado: pronto ⇔ o gestor lê.
 await p.f.commit(client,op,prepared.prepared);await refresh(s);
 assert.match(label(s,email),/Ativo · CRM pronto$/);assert.equal(s.el('admin-crm-reconcile').hidden,true);assert.ok(buttons(s,email).includes('Renovar acesso CRM'));

 let v=await managerView(p,g.cookie());assert.equal(v.status,200);assert.equal(v.alert,'');assert.match(v.stamp,/^Dados de /);

 // 5. Renovação solicitada: a leitura continua; o botão não aparece duas vezes.
 rowOf(s,email).querySelector('button[aria-label^="Renovar acesso CRM"]').click();await until(()=>/Renovação solicitada para leitura/.test(s.el('admin-message').textContent),'renovação');
 assert.match(label(s,email),/CRM pronto · renovação solicitada$/);assert.ok(!buttons(s,email).includes('Renovar acesso CRM'));
 v=await managerView(p,g.cookie());assert.equal(v.status,200,'renovação pendente preserva a leitura');

 // 6. Expira antes de a renovação concluir: ninguém lê; o rótulo diz expirado e a renovação pendente.
 p.f.advance(15*DAY);s=await master(p);await until(()=>rowOf(s,email),'linha');
 assert.match(label(s,email),/CRM acesso expirado · renovação solicitada$/);assert.ok(!buttons(s,email).includes('Renovar acesso CRM'));
 const g2=shell(p.http,{host:hosts.growth,area:'crm',password:MANAGER_PASSWORD});await g2.login(email);await pending('expirado',g2.cookie());
 // 7. A renovação pendente conclui depois da expiração: volta a ler.
 const renewal=p.f.renewal(user.id),rp=await p.f.prepare(client,renewal.operation_id);await p.f.commit(client,renewal.operation_id,rp.prepared);
 await refresh(s);assert.match(label(s,email),/Ativo · CRM pronto$/);v=await managerView(p,g2.cookie());assert.equal(v.status,200);

 // 8. Revogação com confirmação do CRM pendente: o portal fecha na hora; o rótulo não diz "revogado no CRM".
 rowOf(s,email).querySelectorAll('button')[[...rowOf(s,email).querySelectorAll('button')].findIndex(b=>b.textContent==='Revogar acesso')].click();
 await until(()=>/revogado/.test(s.el('admin-message').textContent),'revogação');
 assert.match(s.confirms.at(-1),/A revogação do CRM será confirmada antes de um novo convite/);
 assert.equal(s.el('admin-message').textContent,'Acesso ao portal revogado. A confirmação da revogação no CRM está pendente.');
 assert.match(label(s,email),/Revogado · CRM revogação pendente$/);assert.equal(s.el('admin-crm-reconcile').hidden,false);
 v=await managerView(p,g2.cookie());assert.equal(v.status,401);assert.ok(v.messages.includes('shrigma:session-expired'),'o painel avisa a entrada que a sessão terminou');assert.doesNotMatch(v.stamp,/^Dados de /);
 // Nova entrada do gestor revogado: recusada, sem prometer acesso.
 const g3=shell(p.http,{host:hosts.growth,area:'crm',password:MANAGER_PASSWORD});await g3.login(email);
 assert.equal(g3.el('entry-shell').hidden,true);t.diagnostic('mensagem ao gestor revogado: '+g3.el('entry-message').textContent);
 // Só leituras do cache saíram para a origem, sempre com a credencial individual e nunca durante preparação/expiração/revogação.
 assert.ok(p.upstream.every(u=>u.url.startsWith(B.DESTINATIONS['crm-read'])));
});

test('última consulta válida → acesso CRM expirado: retira dados anteriores, preserva intenção uncertain e recupera só após nova leitura válida',async t=>{
 let campaignName='synthetic-first-read';
 const p=await portal(t,()=>({crm_campanha:[{marca:'fish',canal:'email',tipo:'enviada',campanha_id:1,nome:campaignName,enviado_em:new Date().toISOString(),enviados:100,entregues:98,abriram:30,clicaram:10,hard:2,complaints:0,coletado_em:new Date().toISOString()}]})),email='leitura-expira.fish@synthetic.invalid',invite=p.f.invite(email);await p.f.accept(invite);
 const client=p.f.client(),op=p.f.queued(invite.userId),prepared=await p.f.prepare(client,op);await p.f.commit(client,op,prepared.prepared);
 // The portal session remains valid when only the CRM read credential expires.
 p.f.advance(14*DAY-5*60000);const login=await p.f.login(email);
 const journalKey='shrigma_campaign_bff_v1:'+login.uiKey+':fish',intent=JSON.stringify({phase:'uncertain',fixtureOnly:true,operationId:'synthetic-unknown-ack'}),values=new Map([[journalKey,intent]]);
 const x=await panel(p.http,{host:hosts.growth,cookie:login.cookie.split(';')[0],values});
 assert.equal(x.run('API!==null'),true);assert.match(x.q('#atualizado-em').textContent,/^Dados de /);assert.notEqual(x.q('#area-kpis').textContent,'');
 x.run("setCanal('email');CRMWorkspace.setReport('email');abrirSecaoCRM('resultados')");assert.match(x.q('#tab-camp tbody').textContent,/synthetic-first-read/);
 // Read-only renders in inactive sections must also be withdrawn, while editor nodes survive.
 const editor=x.q('#campaign-composer');x.q('#control-templates').textContent='synthetic-loaded-template';
 const preview=x.document.createElement('dialog');preview.id='message-preview-dialog';preview.textContent='synthetic-loaded-preview';x.document.body.append(preview);
 x.run("GC.conteudo={fixtureOnly:true};GC.conteudoEm='synthetic-loaded-time';GC.historicos={fixtureOnly:true};GC.historicosRascunho={fixtureOnly:true};GC.readTicket={fixtureOnly:true};globalThis.REVIEW_OLD_TICKET=GC.readTicket;GC.carregando='listar'");
 x.run("ULT.camp=[{nome:'synthetic-export-row'}];ULT.conv=[{peca:'synthetic-export-row'}]");
 await p.f.refreshAdmin();p.f.auth.renewManagedCrm({context:p.f.context,userId:invite.userId});const renewal=p.f.renewal(invite.userId);
 const calls=p.upstream.length;p.f.advance(10*60000);await x.run('carregar()');
 const last=x.requests.filter(r=>r.path?.startsWith('/api/crm-read?action=cache_growth')).at(-1);
 assert.equal(last.status,503);assert.equal(last.error,'CRM_ACCESS_NOT_READY');assert.equal(p.upstream.length,calls);
 assert.equal(x.run('API'),null);assert.equal(x.run('AB_PROVA_LEITURA'),null);assert.equal(x.run('ULT.camp.length+ULT.conv.length'),0);
 assert.equal(x.q('#message-preview-dialog'),null);assert.equal(x.run('GC.conteudo'),null);assert.equal(x.run('GC.conteudoEm'),null);assert.equal(x.run('Object.keys(GC.historicos).length+Object.keys(GC.historicosRascunho).length'),0);
 assert.equal(x.run('GC.readTicket'),null);assert.equal(x.run('GC.carregando'),null);assert.equal(x.run('GC.finishRead(REVIEW_OLD_TICKET)'),null,'an old read completion cannot restore its cache');
 assert.equal(x.q('#area-kpis').textContent,'');assert.equal(x.q('#fontes').textContent,'');assert.equal(x.q('#control-templates').textContent,'');assert.equal(x.q('#tab-camp tbody').textContent,'');
 assert.ok(x.qa('main>.sec').every(el=>el.style.display==='none'&&el.hasAttribute('inert')));
 assert.equal(x.q('#campaign-composer'),editor);assert.equal(values.get(journalKey),intent);
 assert.equal(x.q('#atualizado-em').textContent,'Dados indisponíveis');assert.equal(x.q('#atualizado-em').title,'');
 assert.match(x.qa('[role=alert]').map(el=>el.textContent).join(' '),/Nenhum dado do CRM está sendo exibido/);assert.doesNotMatch(x.q('#faixa-alertas').textContent,/continuam na tela|exibindo dados/);
 x.run("setCanal('email');abrirSecaoCRM('resultados');render()");assert.equal(x.q('#tab-camp tbody').textContent,'');assert.ok(x.qa('main>.sec').every(el=>el.style.display==='none'));
 const rp=await p.f.prepare(client,renewal.operation_id);await p.f.commit(client,renewal.operation_id,rp.prepared);
 campaignName='synthetic-new-read';
 await x.run('carregar()');assert.equal(x.run('API!==null'),true);assert.match(x.q('#atualizado-em').textContent,/^Dados de /);assert.equal(x.q('#faixa-alertas').textContent,'');
 assert.ok(x.qa('main>.sec').every(el=>el.style.display!=='none'&&!el.hasAttribute('inert')));assert.equal(x.q('#campaign-composer'),editor);assert.equal(values.get(journalKey),intent);
 assert.match(x.q('#tab-camp tbody').textContent,/synthetic-new-read/);assert.doesNotMatch(x.q('#tab-camp tbody').textContent,/synthetic-first-read/);assert.equal(p.upstream.length,calls+1);
 assert.equal(x.q('#message-preview-dialog'),null);assert.equal(x.run('GC.conteudo'),null);
 assert.ok(x.requests.every(r=>r.method==='GET'),'the panel never resends or clears the uncertain campaign');
});
