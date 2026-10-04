'use strict';
/* Frente 4 — intenção de campanha pendente quando a edição expira, pelo portal real (artefato construído,
   entrada + editor compilados) contra o fixture dashboard-operational-campaign-submit (servidor real em
   127.0.0.1, auth SQLite descartável, origem sintética do serviço de campanhas). Rede só em loopback. */
const test=require('node:test'),assert=require('node:assert/strict');
const {shell,until}=require('./helpers/claude-portal-pages.cjs');
/* Intenção de campanha pendente quando a edição expira: o escritor agenda, a resposta se perde, a edição expira
   antes da conferência. Nada é apagado nem reenviado; quando a edição volta, a tela reconcilia pela leitura. */
test('edição expira com um agendamento sem confirmação: a intenção fica preservada, nada é reenviado e a volta da edição reconcilia sem POST',async t=>{
 const {fixture:campaignFixture,hosts:H}=require('./dashboard-operational-campaign-submit.test.cjs');
 const {IDENTITY_URL}=require('../services/dashboard-operational/crm-campaign-writer-attestation.cjs');
 const PASSWORD='Synthetic campaign manager password 2026!',CAPS=['read_content','draft','validate','submit'];
 const f=await campaignFixture(t),email='writer@synthetic.invalid',person=await f.manager(email);
 const values=new Map();let lost=0;
 const s=shell(f,{host:H.growth,area:'crm',values,password:PASSWORD,loseAck:(method,body)=>method==='POST'&&body?.acao==='campanha_agendar'&&++lost===1});
 await s.login(email);s.el('entry-campaign-open').click();await until(()=>s.dialog.open&&/Campanha 7/.test(s.el('campaign-state').textContent)&&!s.el('campaign-validate').disabled,'editor');
 s.el('campaign-validate').click();await until(()=>/Público conferido/.test(s.el('campaign-status').textContent)&&!s.el('campaign-consult').disabled,'conferência');
 s.check('campaign-confirm');await until(()=>!s.el('campaign-schedule').disabled,'agendar');s.el('campaign-schedule').click();
 await until(()=>lost===1&&/não foi confirmada/.test(s.el('campaign-status').textContent),'ACK perdido');
 const journal=()=>[...values.entries()].filter(([k])=>k.startsWith('shrigma_campaign_bff_v1:'));
 const before=journal();assert.equal(before.length,1);assert.equal(JSON.parse(before[0][1]).phase,'uncertain');
 const posts=()=>f.calls.filter(c=>c.method==='POST').length,sent=posts();assert.equal(f.origin.effects.schedule,1);

 // A edição expira (14 dias). Nova entrada: sem botão de edição, nenhuma chamada nova à origem, diário intacto.
 f.advance(14*86400000+1);
 const e=shell(f,{host:H.growth,area:'crm',values,password:PASSWORD});await e.login(email);
 assert.equal(e.el('entry-shell').hidden,false,'a leitura continua');assert.equal(e.el('entry-campaign-open').hidden,true,'edição expirada não abre o editor');
 assert.deepEqual(journal(),before,'a intenção pendente não é apagada nem alterada');assert.equal(posts(),sent,'nada reenviado');
 assert.equal((await f.post(H.growth,'/api/campaigns',{acao:'campanha_agendar',brand:'fish',id:7,idempotency_key:'expired-writer-probe-0001'},{cookie:e.cookie(),csrf:'x',origin:'https://'+H.growth})).status>=400,true);
 assert.equal(posts(),sent,'POST com a edição expirada não chega à origem');

 // A edição volta (nova credencial individual atestada): o editor reconcilia a mesma tentativa só por leitura.
 const identityFetch=async(url,options)=>{assert.equal(url,IDENTITY_URL);assert.equal(options.headers.Authorization,'Bearer '+person.bearer);
  const r=new Response(JSON.stringify({schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',owner:email,allowedPanels:['growth'],permissions:{growth:{who:'panel:'+person.principalId,label:email,caps:CAPS},influs:null}}),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:IDENTITY_URL});return r;};
 const adminLogin=await f.post(H.manager,'/auth/login',{email:f.config.bootstrapAdminEmail,password:PASSWORD});assert.equal(adminLogin.status,200);
 const {session}=require('./dashboard-operational-campaign-submit.test.cjs'),admin=session(adminLogin);
 await f.auth().installCampaignWriter({context:{host:H.manager,origin:'https://'+H.manager,method:'POST',cookieHeader:admin.cookie,csrf:admin.csrf},userId:person.userId,bearer:person.bearer,principalId:person.principalId,expiresAt:f.config.now()+14*86400000,fetchImpl:identityFetch});
 const r=shell(f,{host:H.growth,area:'crm',values,password:PASSWORD});await r.login(email);assert.equal(r.el('entry-campaign-open').hidden,false);
 r.el('entry-campaign-open').click();await until(()=>r.dialog.open&&/scheduled/.test(r.el('campaign-state').textContent),'reconciliação pela leitura');
 assert.equal(posts(),sent,'voltar a editar não reenvia o agendamento');assert.equal(f.origin.effects.schedule,1);
 assert.equal(r.calls.filter(c=>c.method==='POST'&&c.path==='/api/campaigns').length,0);
 const after=journal();assert.ok(after.every(([,v])=>!['pending','uncertain'].includes(JSON.parse(v).phase)),'a tentativa foi conciliada: '+JSON.stringify(after));
});
