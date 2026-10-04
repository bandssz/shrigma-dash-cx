'use strict';
/* Frente 5 — leitura de Orgânico e Influs pelo portal real (artefato construído: página + guard.js + bundle
   publicado), servidor createServer real com auth SQLite descartável. Sem rede: só o servidor em processo.
   Operacional: o gestor de uma marca ainda não tem contrato de leitura por marca nesses setores; a tela precisa
   dizer isso sem virar "vazio", sem repetir a consulta, sem cair para a API viva e sem exibir agregado. */
const test=require('node:test'),assert=require('node:assert/strict');
const denied=()=>{throw Error('TEST_REAL_NETWORK_DENIED');};
for(const name of ['node:http','node:https']){const m=require(name);m.request=denied;m.get=denied;}
const net=require('node:net');net.connect=denied;net.createConnection=denied;net.Server.prototype.listen=denied;require('node:tls').connect=denied;globalThis.fetch=denied;
const {fixture,hosts}=require('./helpers/crm-managed-read-auth-fixture.cjs');
const {transport,panel}=require('./helpers/claude-portal-pages.cjs');
const S=require('../services/dashboard-operational/server.cjs'),P=require('../services/dashboard-operational/proxy.cjs'),B=require('../services/dashboard-operational/crm-manager-read-bridge.cjs');
const manifest={schema:P.DYNAMIC_MANIFEST_SCHEMA,sourceRevision:P.REVIEWED_DYNAMIC.sourceRevision,routes:{campaigns:B.DESTINATIONS.campaigns,campaigns_media:B.DESTINATIONS.campaigns_media}};

async function portal(t){
 const f=await fixture();t.after(()=>f.close());const upstream=[];
 const app=S.createServer({...f.config,mode:'operational',upstreamProfile:'production',crmManagedReadUi:true,upstreams:Object.fromEntries(Object.entries(B.DESTINATIONS).map(([k,v])=>[k,new URL(v)])),allowedUpstreamHosts:[...new Set(Object.values(B.DESTINATIONS).map(v=>new URL(v).hostname))],dynamicRouteManifest:manifest,publicDir:__dirname},
  {auth:f.auth,fetchImpl:async url=>{upstream.push(String(url));assert.fail('nenhuma origem deve ser consultada para o gestor sem contrato: '+url);},managedCrmRuntime:{kick:async()=>{},close:async()=>{}}});
 t.after(()=>app.removeAllListeners());
 return {f,http:transport(app),upstream};
}
async function manager(p,area,brand){
 const email=`${area}.${brand}@synthetic.invalid`,i=p.f.invite(email,area,brand);await p.f.accept(i);
 const login=await p.f.auth.login({email,password:'synthetic-manager-password-2026',host:hosts[area],origin:'https://'+hosts[area]});
 return login.cookie.split(';')[0];
}
const numbers=x=>(x.q('#area-kpis')?.textContent||'')+(x.q('#area-tabela')?.textContent||'');

for(const brand of ['fish','aristo']){
 test(brand+': Orgânico do gestor sem contrato por marca diz "aguardando validação", não repete, não cai para a API viva e não exibe agregado',async t=>{
  const p=await portal(t),cookie=await manager(p,'organico',brand);
  const x=await panel(p.http,{host:hosts.organico,cookie,page:'organico.html'});
  const reads=x.requests.filter(r=>r.path?.startsWith('/api/'));
  assert.deepEqual(reads.map(r=>[r.path,r.status,r.error]),[['/api/cache?painel=organico',503,'BRAND_READ_CONTRACT_NOT_READY']],'uma consulta, sem nova tentativa e sem /api/cx');
  const aviso=x.q('#aviso-carga').textContent;
  assert.match(aviso,/Leitura da sua marca aguardando validação/);assert.match(aviso,/Nenhum dado foi exibido, e isso não significa ausência de resultados/);
  assert.equal(x.q('#aviso-carga #btn-retry'),null,'sem botão de repetir uma leitura que não existe');
  assert.doesNotMatch(aviso,/A consulta falhou|demorou/);assert.equal(x.run('API'),null,'nenhum payload aplicado');
  assert.ok(x.messages.some(m=>m.data?.type==='shrigma:brand-read-unavailable'&&m.data.code==='BRAND_READ_CONTRACT_NOT_READY'),'a entrada recebe o aviso do contrato');
  assert.deepEqual(p.upstream,[]);
 });
 test(brand+': Influs do gestor sem contrato por marca diz "aguardando validação" sem tabela, sem KPI e sem repetir',async t=>{
  const p=await portal(t),cookie=await manager(p,'influs',brand);
  const x=await panel(p.http,{host:hosts.influs,cookie,page:'influs.html'});
  const reads=x.requests.filter(r=>r.path==='/api/influ');
  assert.equal(reads.length,1,'uma leitura, sem nova tentativa');assert.equal(reads[0].status,503);assert.equal(reads[0].error,'BRAND_READ_CONTRACT_NOT_READY');
  const tela=x.q('#area-tabela').textContent;
  assert.match(tela,/Leitura da sua marca aguardando validação/);assert.match(tela,/isso não significa ausência de resultados/);
  assert.doesNotMatch(tela,/HTTP 503|Falha ao carregar/);assert.equal(x.q('#area-tabela #btn-retry'),null);
  assert.equal(x.q('#area-kpis').textContent.trim(),'','nenhum KPI (nem zero) sem leitura');assert.equal(x.run('INFLU'),null);
  assert.ok(x.messages.some(m=>m.data?.type==='shrigma:brand-read-unavailable'));assert.deepEqual(p.upstream,[]);
 });
}
