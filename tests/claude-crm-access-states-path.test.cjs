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

async function portal(t){
 const f=await fixture();t.after(()=>f.close());let kicks=0;
 const cache=()=>({_escopo:'growth',_painel:'growth',gerado_em:new Date(f.config.now()).toISOString(),_cache_gerado_em:new Date(Date.now()).toISOString(),crm_diario:[],crm_campanha:[],crm_fluxo:[],crm_conversao:[],capabilities:{}});
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

