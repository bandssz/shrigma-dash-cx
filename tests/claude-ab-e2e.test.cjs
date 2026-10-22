'use strict';
/* Prova ponta a ponta do A/B com transporte sintético nas duas marcas.
   Página growth.html real (bundle) em vm/linkedom → painel A/B → cliente → servidor crm-audience
   → API do painel A/B → SQL real (PGlite) → emulação do worker nativo → transporte falso.
   Capacidades, sessão de operador e transporte existem SÓ neste teste; nada é ligado no código. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {Readable}=require('node:stream'),{EventEmitter}=require('node:events'),{randomUUID}=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite'),{parseHTML}=require('linkedom');
const F=require('./ab-audience-regular-fixture.cjs'),API=require('../n8n/growth/ab-audience-panel-api.cjs');
const Client=require('../growth-ab-experiment-client.js');
const {createServer,ORIGIN}=require('../services/crm-audience/server.cjs');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'growth.html'),'utf8');
const regularSQL=fs.readFileSync(path.join(root,'n8n/growth/ab-audience-regular.sql'),'utf8');
const AB_URL='https://synthetic.invalid/ab-experiments',CAMPAIGN_URL='https://synthetic.invalid/campaigns',KEY='synthetic-manager-key';
const CAMPAIGNS={fish:[100,101],aristo:[200,201]},BASE={fish:17,aristo:16};
const tick=()=>new Promise(setImmediate);

function capabilities(brands=['fish','aristo']){
 return {endpoints:{ab_experiment:AB_URL,campaigns:CAMPAIGN_URL},
  ab_experiment:{contract_version:'crm-ab-email-v2',audience_mode:'saved-audience-v1',enabled:true,operation:true,brands},
  campaigns:{contract_version:'crm-campaign-v1',brands,audience_review:'listmonk-6.1-regular-v1',read:true,save:true,validate:true,schedule:true,cancel:true,operation:true}};
}
const payload=()=>({_painel:'growth',_escopo:'growth',gerado_em:new Date().toISOString(),crm_wa_cobertura:{inicio:'2026-06-10',fim:'2026-09-07'},crm_wa_envios:[],crm_fluxo:[],crm_conversao:[],crm_campanha:[],crm_base:[],
 crm_campanha_receita:[],crm_campanha_grupo:[],crm_diario:[],crm_intradia:[],crm_carrinho:[],crm_galho:[],crm_regra_galho:[],crm_teste:[],crm_teste_braco:[],crm_credencial:[],wa_saude:[],capabilities:capabilities()});

function inject(app,url,init){
 const u=new URL(url),headers={...init.headers,Origin:ORIGIN},raw=Object.entries(headers).flat();
 const req=Readable.from(init.body===undefined?[]:[Buffer.from(init.body)]);
 Object.assign(req,{method:init.method,url:u.pathname+u.search,headers:Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v])),rawHeaders:raw});
 return new Promise(resolve=>{const res=new EventEmitter();Object.assign(res,{destroyed:false,writableEnded:false,
  writeHead(status,h){this.status=status;this.headers=h;},end(value){this.writableEnded=true;resolve({status:this.status,body:value?JSON.parse(value):null});}});app.server.emit('request',req,res);});
}

// Web Locks compartilhado entre abas (mesma origem): exclusivo, ifAvailable devolve null.
function sharedLocks(){const held=new Set();return {held,request:async(name,options,fn)=>{if(held.has(name))return fn(null);held.add(name);try{return await fn({name});}finally{held.delete(name);}}};}

async function setup(t){
 const db=new PGlite();t.after(()=>db.close());
 const x=await F.setup(db,{prepareCases:false,beforeWorkerReady:({db})=>db.exec(regularSQL)});
 await db.query("UPDATE shrigma_panel_permission_v1 SET caps=caps||'[\"submit\"]'::jsonb WHERE principal_id='manager'");
 const experiments=API.createABPanelAPI({transaction:x.transaction,enabled:true}),unrelated={handle(){assert.fail('Rota não relacionada');}};
 const app=createServer({segments:unrelated,binding:unrelated,experiments,enabled:true,revision:'a'.repeat(40)});
 const f={db,x,app,calls:[],net:{dropPost:false,dropLookups:0},store:new Map(),locks:sharedLocks(),tabs:[]};
 f.posts=()=>f.calls.filter(c=>c.method==='POST').length;
 t.after(()=>{for(const tab of f.tabs)tab.close();});
 return f;
}

// Uma aba = um contexto vm com o growth.html real; storage e Web Locks são da origem (compartilhados).
async function openTab(f,brand){
 const {document,window}=parseHTML(html);
 const selectProto=Object.getPrototypeOf(document.querySelector('select'));
 Object.defineProperty(selectProto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 window.HTMLElement.prototype.scrollIntoView=function(){};window.HTMLElement.prototype.focus=function(){};window.HTMLElement.prototype.blur=function(){};
 window.HTMLElement.prototype.getBoundingClientRect=function(){return {top:0,width:1200,height:100};};
 for(const dialog of document.querySelectorAll('dialog')){Object.defineProperty(dialog,'open',{configurable:true,get(){return this.hasAttribute('open');}});dialog.showModal=function(){this.setAttribute('open','');};dialog.close=function(){this.removeAttribute('open');this.onclose?.();};}
 f.store.set('shrigma_k_growth',KEY);
 const storage={getItem:k=>f.store.has(k)?f.store.get(k):null,setItem:(k,v)=>f.store.set(k,String(v)),removeItem:k=>f.store.delete(k)};
 const timers=new Set();
 const fetch=async(url,init={})=>{
  const target=String(url);
  if(target.startsWith(AB_URL)){
   assert.equal(init.headers.Authorization,'Bearer '+KEY);assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');
   const input=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(new URL(target).searchParams);
   assert.ok(!Object.hasOwn(input,'k'),'chave nunca vai no corpo');const call={method:init.method,input};f.calls.push(call);
   if(init.method==='POST'&&f.net.hold)await f.net.hold;
   const r=await inject(f.app,target,init);call.status=r.status;
   if(init.method==='POST'&&f.net.dropPost){f.net.dropPost=false;throw Error('ACK perdido (sintético)');}
   if(input.method==='operation'&&r.body?.operation?.state==='completed'&&f.net.dropLookups>0){f.net.dropLookups--;throw Error('Recibo perdido (sintético)');}
   return {status:r.status,ok:r.status<300,json:async()=>r.body};
  }
  if(target.startsWith(CAMPAIGN_URL)){f.calls.push({method:init.method||'GET',campaign:true,url:target});return {status:503,ok:false,json:async()=>({error:'SYNTHETIC_CAMPAIGN_UNAVAILABLE'})};}
  const body=payload();if(target.includes('action=cache_growth'))body._cache_gerado_em=new Date().toISOString();
  return {status:200,ok:true,json:async()=>body};
 };
 const ctx=vm.createContext({document,window,Date,Intl,URL,URLSearchParams,AbortSignal,AbortController,crypto:require('node:crypto').webcrypto,TextEncoder,navigator:{locks:f.locks},console,
  Image:class{set src(x){}},localStorage:storage,location:{reload:()=>{throw Error('reload inesperado');},hash:'',search:''},history:{replaceState:()=>{}},Blob:class{constructor(p){this.text=p.join('');}},
  prompt:()=>null,confirm:()=>false,addEventListener:()=>{},setInterval:()=>1,clearInterval:()=>{},setTimeout:(fn,ms)=>{const h=setTimeout(fn,ms);timers.add(h);return h;},clearTimeout:h=>{timers.delete(h);clearTimeout(h);},structuredClone,fetch});
 for(const script of document.querySelectorAll('script')){const src=script.getAttribute('src');vm.runInContext(src?fs.readFileSync(path.join(root,src.split('?')[0]),'utf8'):script.textContent,ctx,{filename:src||'growth-inline.js'});}
 const run=c=>vm.runInContext(c,ctx);
 for(let i=0;i<20&&run('LOADING');i++)await tick();
 assert.ok(run('!!API'),'leitura sintética carregada');
 // Sessão de operador sintética (portal), só neste teste.
 run(`SHRIGMA_OPERATOR_SESSION.growth={caps:['draft','validate','submit'],label:'Gestor sintético'}`);
 run(`trocaMarca(${JSON.stringify(brand)});abrirSecaoCRM('camp')`);document.querySelector('[data-crm-campaign="tests"]').click();
 const tab={document,window,run,brand,q:s=>document.querySelector('#ab-experiment-panel '+s),close:()=>{for(const h of timers)clearTimeout(h);}};
 f.tabs.push(tab);
 const panel=document.querySelector('#ab-experiment-panel');
 assert.equal(panel.hidden,false,'painel A/B montado com a capacidade sintética: '+panel.textContent.slice(0,200));
 return tab;
}


function dialogOf(tab){const d=tab.q('dialog');if(d&&!d.__patched){d.__patched=true;d.showModal=()=>d.setAttribute('open','');d.close=()=>d.removeAttribute('open');}return d;}
async function settle(n=40){for(let i=0;i<n;i++)await tick();}
const message=tab=>tab.q('[data-abx-message]').textContent;
const detail=tab=>tab.q('[data-abx-detail]').textContent.replace(/\s+/g,' ');
async function prepare(f,tab,brand){
 await settle();const p=f.x.cases[brand].protocol;tab.q('[data-abx-new]').onclick();
 const fields={name:p.name,hypothesis:p.hypothesis,a:p.arms[0].campaign_id,b:p.arms[1].campaign_id,window_hours:24,minimum_per_arm:1,minimum_effect_pp:.1};
 for(const [name,v]of Object.entries(fields))tab.q(`[name="${name}"]`).value=v;
 tab.q('[data-abx-form]').oninput();dialogOf(tab);const pending=tab.q('[data-abx-form]').onsubmit({preventDefault(){}});
 assert.ok(dialogOf(tab).hasAttribute('open'),'confirmação humana antes de preparar: '+message(tab));tab.q('[data-abx-yes]').onclick();await pending;await settle();
 const tid=(await f.db.query('SELECT test_id FROM crm_ab_arm_v2 WHERE campaign_id=$1',[CAMPAIGNS[brand][0]])).rows[0]?.test_id;
 assert.ok(tid,brand+': preparação confirmada: '+message(tab));return tid;
}
async function review(tab){await tab.q('[data-abx-review]').onclick();await settle();}
function clickSchedule(tab){dialogOf(tab);const pending=tab.q('[data-abx-schedule]').onclick();if(!tab.q('dialog').hasAttribute('open'))return pending;
 assert.match(tab.q('[data-abx-confirm-text]').textContent,/mensagens poderão ser enviadas/);tab.q('[data-abx-yes]').onclick();tab.q('[data-abx-yes]')?.onclick?.();return pending;}
async function schedule(tab){await clickSchedule(tab);await settle();}
async function http(f,method,input){
 const init=method==='POST'?{method,headers:{Authorization:'Bearer '+KEY,'Content-Type':'application/json'},body:JSON.stringify(input)}:{method,headers:{Authorization:'Bearer '+KEY}};
 const url=new URL(AB_URL);if(method==='GET')for(const [k,v]of Object.entries(input))url.searchParams.set(k,v);
 return inject(f.app,url.href,init);
}
const scheduleOps=f=>f.calls.filter(c=>c.method==='POST'&&c.input.request_payload?.action==='schedule').length;

/* ---------- Transporte falso: recusa destino externo e conta envios ---------- */
const SENDER={fish:'contato@fishermans.com.br',aristo:'contato@oaristocrata.com'};
function fakeTransport(){
 const sent=[],refused=[];
 return {sent,refused,send(m){
  if(String(m.to).split('@')[1]!=='example.test'){refused.push(m);throw Object.assign(Error('DESTINO_EXTERNO_RECUSADO'),{code:'EXTERNAL'});}
  sent.push(m);return {accepted:true};
 },to:(filter=()=>true)=>sent.filter(filter).map(m=>m.subscriber_id).sort((a,b)=>a-b)};
}

/* ---------- Emulação do worker nativo (Listmonk 6.1 + patch regular) ----------
   Real: guardas da campanha (scheduled→running→finished), lease, quarantine, claim_live/finish
   (portão por pessoa: coorte A/B, opt-out, bloqueio, ordem, marca) e recibos em shrigma_email_dispatch.
   Emulado: a consulta nativa next-campaign-subscribers e o processo Go. De propósito a seleção é
   INGÊNUA (todas as inscrições das listas da campanha, sem coorte nem opt-out): quem barra é o SQL. */
async function tx(db,work){return db.transaction(async t=>{await t.query("SET LOCAL statement_timeout='10s'");return work(t);});}
async function heartbeat(f){const r=(await f.db.query('SELECT crm_audience_v2.regular_worker_heartbeat($1::uuid,$2,$3) result',[f.x.instance,f.x.worker,f.x.runtime])).rows[0].result;assert.equal(r.ready,true,JSON.stringify(r));}
async function quarantine(f){return tx(f.db,async t=>(await t.query('SELECT crm_audience_v2.regular_delivery_quarantine($1::integer[]) result',[[]])).rows[0].result);}
// Relógio sintético (só no PGlite do teste): desloca para trás, pelo mesmo intervalo, todos os
// instantes do experimento da marca. Equivale a esperar; o material capturado (contém send_at)
// é recapturado para refletir só a translação temporal.
async function timeTravel(f,brand,interval){
 const ids=CAMPAIGNS[brand],tid=(await f.db.query('SELECT test_id FROM crm_ab_arm_v2 WHERE campaign_id=$1',[ids[0]])).rows[0].test_id,pieces=ids.map(id=>'audience-regular-v1:'+id);
 await f.db.transaction(async t=>{
  await t.query("SET LOCAL session_replication_role='replica'");
  const shift=interval??(await t.query("SELECT (max(send_at)-clock_timestamp())+interval '1 second' AS d FROM campaigns WHERE id=ANY($1)",[ids])).rows[0].d;
  await t.query('UPDATE campaigns SET send_at=send_at-$2::interval,started_at=started_at-$2::interval,updated_at=updated_at-$2::interval WHERE id=ANY($1)',[ids,shift]);
  await t.query('UPDATE crm_audience_v2.regular_delivery_campaign SET material=crm_audience_v2.regular_delivery_material(campaign_id) WHERE campaign_id=ANY($1)',[ids]);
  await t.query('UPDATE crm_ab_experiment_v2 SET window_start=window_start-$2::interval,window_end=window_end-$2::interval WHERE test_id=$1',[tid,shift]);
  await t.query('UPDATE crm_ab_arm_v2 SET finished_at=finished_at-$2::interval WHERE test_id=$1',[tid,shift]);
  await t.query('UPDATE shrigma_email_dispatch SET reserved_at=reserved_at-$2::interval,started_at=started_at-$2::interval,accepted_at=accepted_at-$2::interval,outcome_at=outcome_at-$2::interval WHERE piece=ANY($1)',[pieces,shift]);
  await t.query('UPDATE link_clicks SET created_at=created_at-$2::interval WHERE campaign_id=ANY($1)',[ids,shift]);
 });
 if(!interval)await new Promise(r=>setTimeout(r,1100));
 return tid;
}
async function candidates(db,cid){return (await db.query('SELECT DISTINCT sl.subscriber_id id FROM subscriber_lists sl JOIN campaign_lists cl ON cl.list_id=sl.list_id WHERE cl.campaign_id=$1 ORDER BY 1',[cid])).rows.map(r=>r.id);}
async function claim(f,brand,cid,sid){
 return tx(f.db,async t=>{
  const s=(await t.query('SELECT to_jsonb(s) snap FROM subscribers s WHERE id=$1',[sid])).rows[0].snap;
  const r=(await t.query('SELECT crm_audience_v2.regular_delivery_claim_live($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10::jsonb,$11) result',
   [f.x.instance,cid,sid,randomUUID(),f.x.worker,f.x.runtime,SENDER[brand],s.email,'c'.repeat(64),JSON.stringify(s),'fixture'])).rows[0].result;
  return {...r,email:s.email};
 });
}
async function finish(f,cid,sid,grant,outcome='accepted'){return tx(f.db,async t=>(await t.query('SELECT crm_audience_v2.regular_delivery_finish($1,$2,$3::uuid,$4::uuid,$5) result',[cid,sid,grant.dispatch_id,grant.claim_token,outcome])).rows[0].result);}
async function startCampaign(f,cid){
 const ids=await candidates(f.db,cid);
 await tx(f.db,t=>t.query("UPDATE campaigns SET status='running',started_at=clock_timestamp(),to_send=$2,max_subscriber_id=$3,updated_at=clock_timestamp() WHERE id=$1 AND status='scheduled'",[cid,ids.length,Math.max(...ids)]));
 return ids;
}
// Um ciclo do worker para uma campanha: inicia, oferece cada candidato ao claim, envia só com reserva, finaliza.
async function runCampaign(f,brand,cid,transport,{beforeClaim=null,lostFinishReply=false}={}){
 await heartbeat(f);
 const ids=await startCampaign(f,cid),log=[];
 for(const sid of ids){
  if(beforeClaim)await beforeClaim(sid,cid);
  let grant;try{grant=await claim(f,brand,cid,sid);}catch(e){log.push({sid,error:e.message});break;}log.push({sid,reason:grant.reason});
  if(grant.should_send!==true)continue;
  let outcome='accepted';
  try{transport.send({brand,campaign_id:cid,from:SENDER[brand],to:grant.email,subscriber_id:sid,dispatch_id:grant.dispatch_id});}catch{outcome='outcome_unknown';}
  const done=await finish(f,cid,sid,grant,outcome);
  // Resposta do finish perdida: o worker repete o MESMO recibo; nada de nova reserva nem novo envio.
  if(lostFinishReply)assert.deepEqual(await finish(f,cid,sid,grant,outcome),done);
 }
 await tx(f.db,t=>t.query("UPDATE campaigns SET status='finished',updated_at=clock_timestamp() WHERE id=$1 AND status='running'",[cid]));
 return log;
}
const membersOf=async(db,tid)=>(await db.query('SELECT subscriber_id id,arm FROM crm_ab_member_v2 WHERE test_id=$1 ORDER BY subscriber_id',[tid])).rows;
const armOf=(members,arm)=>members.filter(m=>m.arm===arm).map(m=>m.id);
const count=async(db,sql,values=[])=>(await db.query(sql,values)).rows[0].n;
const optOut=(db,brand,sid)=>db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=$1 AND list_id=$2",[sid,BASE[brand]]);
async function campaignState(db,brand){return (await db.query('SELECT id,status::text status,sent FROM campaigns WHERE id=ANY($1) ORDER BY id',[CAMPAIGNS[brand]])).rows;}
async function brandDispatches(db,brand){return count(db,"SELECT count(*)::int n FROM shrigma_email_dispatch WHERE flow='campaign' AND (brand=$1 OR piece=ANY($2))",[brand,CAMPAIGNS[brand].map(id=>'audience-regular-v1:'+id)]);}
const rejectsTransport=async(promise,transport,label)=>{const before=transport.sent.length;await assert.rejects(promise,e=>/UNAVAILABLE|REQUIRED|SCHEDULE|CURSOR|55000/.test(e.message+e.code),label);assert.equal(transport.sent.length,before,label);};

// Prova por marca depois de enviada: variantes disjuntas, uma variante por pessoa, opt-out respeitado.
async function assertDelivered(f,brand,tid,transport,logs,excluded){
 const m=await membersOf(f.db,tid),a=armOf(m,'a'),b=armOf(m,'b'),[ca,cb]=CAMPAIGNS[brand];
 assert.ok(a.length>=1&&b.length>=1&&Math.abs(a.length-b.length)<=1,brand+': divisão 50/50');
 assert.equal(a.filter(x=>b.includes(x)).length,0,brand+': nenhuma pessoa nos dois braços');
 const sentA=transport.to(x=>x.campaign_id===ca),sentB=transport.to(x=>x.campaign_id===cb);
 assert.deepEqual(sentA,a.filter(x=>!excluded.includes(x)),brand+': braço A recebe só a variante A, menos opt-out');
 assert.deepEqual(sentB,b.filter(x=>!excluded.includes(x)),brand+': braço B recebe só a variante B, menos opt-out');
 assert.equal(sentA.filter(x=>sentB.includes(x)).length,0,brand+': ninguém recebe as duas variantes');
 const perPerson=new Map();for(const x of transport.sent.filter(x=>x.brand===brand))perPerson.set(x.subscriber_id,(perPerson.get(x.subscriber_id)||0)+1);
 assert.ok([...perPerson.values()].every(n=>n===1),brand+': no máximo um envio por pessoa');
 for(const x of excluded)assert.equal(perPerson.has(x),false,brand+': opt-out '+x+' sem envio');
 // A seleção ingênua ofereceu ao braço A todos os membros do B (e vice-versa): o SQL recusou.
 for(const x of b)assert.equal(logs[ca].find(l=>l.sid===x)?.reason,'ineligible',brand+': membro B oferecido à variante A foi recusado');
 for(const x of a)assert.equal(logs[cb].find(l=>l.sid===x)?.reason,'ineligible',brand+': membro A oferecido à variante B foi recusado');
 assert.ok(transport.sent.filter(x=>x.brand===brand).every(x=>x.from===SENDER[brand]),brand+': remetente da própria marca');
 assert.deepEqual(transport.refused,[],'nenhum destino externo');
 assert.equal(await count(f.db,"SELECT count(*)::int n FROM shrigma_email_dispatch WHERE flow='campaign' AND brand=$1 AND transport_state='accepted'",[brand]),sentA.length+sentB.length,brand+': um recibo aceito por envio');
 assert.deepEqual(await campaignState(f.db,brand),[{id:ca,status:'finished',sent:sentA.length},{id:cb,status:'finished',sent:sentB.length}]);
 assert.equal(await count(f.db,'SELECT count(*)::int n FROM crm_ab_arm_v2 WHERE test_id=$1 AND finished_at IS NOT NULL AND transport_interrupted_at IS NULL',[tid]),2);
 // Repetição depois de terminar: nenhuma nova reserva, nenhum novo envio.
 for(const x of transport.sent.filter(x=>x.brand===brand))await rejectsTransport(claim(f,brand,x.campaign_id,x.subscriber_id),transport,brand+': repetição barrada');
 return {a,b,sentA,sentB};
}


async function useBrand(tab,brand){assert.equal(tab.run(`trocaMarca(${JSON.stringify(brand)})`),true,'troca de marca liberada');await settle();
 assert.match(tab.q('h2').textContent,new RegExp(brand==='fish'?'Fishermans':'O Aristocrata'));}

test('fish e aristo: página → cliente → servidor → SQL → transporte falso; variantes disjuntas, uma por pessoa, opt-out, marca isolada e medição sem vencedora falsa',async t=>{
 const f=await setup(t),tab=await openTab(f,'fish'),transport=fakeTransport(),tid={};
 for(const brand of ['fish','aristo']){
  await useBrand(tab,brand);
  tid[brand]=await prepare(f,tab,brand);await review(tab);assert.equal(message(tab),'Ação confirmada no servidor.',brand+' conferência');
  await schedule(tab);assert.match(detail(tab),/Agendado/,brand+': '+message(tab));
 }
 assert.equal(f.calls.filter(c=>c.input.request_payload?.action==='review_saved').length,2);
 assert.equal(scheduleOps(f),2,'um POST de agendamento por marca');
 assert.equal(await count(f.db,'SELECT count(*)::int n FROM crm_audience_v2.ab_regular_pair'),2);
 assert.equal(await count(f.db,'SELECT count(*)::int n FROM crm_audience_v2.regular_delivery_campaign WHERE enabled AND NOT suspended'),4);
 assert.equal(await count(f.db,"SELECT count(*)::int n FROM shrigma_email_dispatch"),0,'agendar não envia');
 assert.ok(f.calls.every(c=>!c.campaign),'nenhuma chamada ao endpoint de campanhas');

 const fish=await membersOf(f.db,tid.fish),aristo=await membersOf(f.db,tid.aristo);
 // Opt-out depois do agendamento: X sai da base Fish antes do início; Y sai no meio do envio.
 const X=armOf(fish,'b').find(x=>aristo.some(m=>m.id===x))??armOf(fish,'b')[0],Y=armOf(fish,'a').at(-1);
 await optOut(f.db,'fish',X);

 // Só Fish chega ao horário. Aristo continua agendada e intocada.
 await timeTravel(f,'fish');assert.deepEqual(await quarantine(f),[],'material e fonte íntegros após o relógio sintético');
 await rejectsTransport(claim(f,'aristo',CAMPAIGNS.aristo[0],armOf(aristo,'a')[0]),transport,'Aristo ainda não começou: claim recusado');
 await assert.rejects(tx(f.db,t=>t.query("UPDATE campaigns SET status='running' WHERE id=$1",[CAMPAIGNS.aristo[0]])),/AB_V2_SCHEDULE_REQUIRED|SEGMENT_|55000/,'Aristo não pode começar antes do horário');
 const logs={};
 for(const cid of CAMPAIGNS.fish)logs[cid]=await runCampaign(f,'fish',cid,transport,{beforeClaim:async sid=>{if(sid===Y)await optOut(f.db,'fish',Y);}});
 assert.equal(logs[CAMPAIGNS.fish[0]].find(l=>l.sid===Y).reason,'ineligible','opt-out no meio do envio barrado no claim');
 await assertDelivered(f,'fish',tid.fish,transport,logs,[X,Y]);
 assert.deepEqual(await campaignState(f.db,'aristo'),CAMPAIGNS.aristo.map(id=>({id,status:'scheduled',sent:0})),'marca isolada: Aristo intocada pelo envio Fish');
 assert.equal(await brandDispatches(f.db,'aristo'),0);

 // Aristo: opt-out Fish de X não vale para Aristo; Z sai da base Aristo no meio do envio.
 const Z=aristo.map(m=>m.id).find(x=>x!==X&&x!==Y);
 await timeTravel(f,'aristo');assert.deepEqual(await quarantine(f),[]);
 for(const cid of CAMPAIGNS.aristo)logs[cid]=await runCampaign(f,'aristo',cid,transport,{beforeClaim:async sid=>{if(sid===Z)await optOut(f.db,'aristo',Z);}});
 await assertDelivered(f,'aristo',tid.aristo,transport,logs,[Z]);
 if(aristo.some(m=>m.id===X))assert.equal(transport.sent.filter(x=>x.brand==='aristo'&&x.subscriber_id===X).length,1,'opt-out é da marca: X ainda recebe Aristo');
 await rejectsTransport(claim(f,'fish',CAMPAIGNS.fish[0],Z),transport,'Fish encerrada não reabre para pessoa da Aristo');
 assert.deepEqual(transport.refused,[]);

 // Um clique rastreado no braço B (Fish) e a janela de 24 h termina (relógio sintético).
 const clicker=armOf(fish,'b').find(x=>x!==X);
 await f.db.query('INSERT INTO link_clicks(campaign_id,subscriber_id,created_at) VALUES($1,$2,clock_timestamp())',[CAMPAIGNS.fish[1],clicker]);
 for(const brand of ['fish','aristo'])await timeTravel(f,brand,'25 hours');
 for(const brand of ['fish','aristo']){
  const got=await http(f,'GET',{method:'get',brand,test_id:tid[brand]});assert.equal(got.status,200);
  const arms=got.body.measurement.arms,sentPer=cid=>transport.sent.filter(x=>x.campaign_id===cid).length;
  assert.deepEqual(arms.map(a=>a.native_sent),CAMPAIGNS[brand].map(sentPer),brand+': medição = contagem do transporte falso');
  assert.ok(arms.every(a=>a.finished_before_deadline===true&&a.unknown===0));
  assert.deepEqual(Object.values(got.body.measurement.integrity),[true,true,true,true,true,true],brand+': integridade');
  if(brand==='fish')assert.deepEqual(arms.map(a=>a.unique_clickers),[0,1],'clique conta só na variante atribuída');
  await useBrand(tab,brand);await tab.q('[data-abx-refresh]').onclick();await settle();
  assert.match(detail(tab),/Envios não comprovados · sem vencedora/,brand+': déficit por opt-out nunca vira vencedora');
  // Encerrar a medição pelo painel (janela terminada, dois braços finalizados).
  dialogOf(tab);const closing=tab.q('[data-abx-close]').onclick();assert.ok(tab.q('dialog').hasAttribute('open'),message(tab));tab.q('[data-abx-yes]').onclick();await closing;await settle();
  assert.equal(await count(f.db,"SELECT count(*)::int n FROM crm_ab_experiment_v2 WHERE test_id=$1 AND state='closed'",[tid[brand]]),1,brand+': '+message(tab));
 }
 assert.equal(transport.sent.length,new Set(transport.sent.map(x=>x.dispatch_id)).size);
});

test('aristo: ACK perdido no preparo e no agendamento → mesmo recibo consultado, nenhum POST repetido, envio único por pessoa',async t=>{
 const f=await setup(t);let tab=await openTab(f,'aristo');const transport=fakeTransport();
 // ACK perdido no servidor: COMMIT feito, resposta 202 (incerta). O cliente consulta o recibo.
 let saved=false;f.x.control.afterQuery=async q=>{if(q===API.SQL.save)saved=true;};
 f.x.control.afterCommit=()=>{if(saved){saved=false;f.x.control.afterCommit=null;throw Error('ACK perdido no servidor (sintético)');}};
 const tid=await prepare(f,tab,'aristo');f.x.control.afterQuery=null;
 assert.deepEqual(f.calls.filter(c=>c.method==='POST').map(c=>c.status),[202],'um único POST de preparo, com ACK perdido (202) no servidor');assert.equal(await count(f.db,'SELECT count(*)::int n FROM crm_ab_experiment_v2 WHERE test_id=$1',[tid]),1);
 await review(tab);
 // ACK perdido na rede: o POST de agendamento chega e grava; resposta e primeira consulta se perdem.
 f.net.dropPost=true;f.net.dropLookups=1;await schedule(tab);
 assert.match(message(tab),/Resultado não confirmado/,message(tab));assert.equal(scheduleOps(f),1);
 assert.equal(await count(f.db,'SELECT count(*)::int n FROM crm_audience_v2.ab_regular_pair WHERE test_id=$1',[tid]),1,'agendamento gravado apesar do ACK perdido');
 // Recarregar a página: a tentativa pendente sobrevive e só pode ser consultada.
 tab.close();tab=await openTab(f,'aristo');await settle();
 assert.equal(tab.q('[data-abx-recover]').hidden,false,'Consultar tentativa visível após recarregar');
 const before=f.posts();await tab.q('[data-abx-recover]').onclick();await settle();
 assert.equal(f.posts(),before,'consulta do recibo sem novo POST');assert.equal(scheduleOps(f),1);
 assert.match(detail(tab),/Agendado/,message(tab));
 const journal=JSON.parse(f.store.get(Client.SLOT));assert.ok(journal.operations.every(o=>o.applied===true&&o.phase==='confirmed'));
 assert.doesNotMatch(f.store.get(Client.SLOT),new RegExp(KEY+'|person\\d+@'));
 assert.equal(await count(f.db,'SELECT count(*)::int n FROM crm_audience_v2.regular_delivery_campaign'),2,'uma intenção: dois controles, não quatro');
 // Envio: cada pessoa elegível exatamente uma vez, mesmo com resposta do finish perdida.
 await timeTravel(f,'aristo');const logs={};
 for(const cid of CAMPAIGNS.aristo)logs[cid]=await runCampaign(f,'aristo',cid,transport,{lostFinishReply:true});
 await assertDelivered(f,'aristo',tid,transport,logs,[]);
 assert.equal(await brandDispatches(f.db,'fish'),0,'marca isolada');
});

test('fish: duas abas e pedidos concorrentes → uma intenção de agendamento e um envio por pessoa',async t=>{
 const f=await setup(t),tab1=await openTab(f,'fish'),transport=fakeTransport();
 const tid=await prepare(f,tab1,'fish');await review(tab1);
 const tab2=await openTab(f,'fish');await settle();
 tab2.q('[data-abx-select]').value=tid;await tab2.q('[data-abx-select]').onchange();await settle();
 assert.equal(tab2.q('[data-abx-schedule]').disabled,false,'segunda aba também pode agendar: '+message(tab2));
 // A rede segura o POST da primeira aba: a operação fica em voo, com o Web Lock e o journal pendente.
 let release;f.net.hold=new Promise(r=>release=r);
 const first=clickSchedule(tab1);
 for(let i=0;i<500&&scheduleOps(f)<1;i++)await tick();assert.equal(scheduleOps(f),1,'POST da primeira aba em voo');
 assert.equal(f.locks.held.size,1,'primeira aba segura o Web Lock');
 dialogOf(tab2);await tab2.q('[data-abx-schedule]').onclick();await settle();
 assert.equal(tab2.q('dialog').hasAttribute('open'),false,'segunda aba nem abre confirmação: tentativa pendente compartilhada');
 assert.equal(scheduleOps(f),1,'segunda aba não envia outro POST enquanto a primeira está em voo');
 f.net.hold=null;release();await first;await settle();
 assert.equal(scheduleOps(f),1,'duas abas → um único POST de agendamento');
 assert.match(detail(tab1),/Agendado/,message(tab1));
 await tab2.q('[data-abx-refresh]').onclick();await settle();assert.match(detail(tab2),/Agendado/,'segunda aba vê o mesmo agendamento');
 assert.equal(await count(f.db,'SELECT count(*)::int n FROM crm_audience_v2.ab_regular_pair WHERE test_id=$1',[tid]),1);
 assert.equal(tab2.q('[data-abx-schedule]').disabled,true,'nada mais a agendar na segunda aba');

 // Pedidos HTTP concorrentes (Aristo): mesmo operation_id duas vezes + outro operation_id.
 const aristoTab=await openTab(f,'aristo'),atid=await prepare(f,aristoTab,'aristo');await review(aristoTab);
 const rv=(await f.db.query('SELECT id FROM crm_audience_v2.ab_regular_review WHERE test_id=$1 ORDER BY checked_at DESC LIMIT 1',[atid])).rows[0].id;
 const body=operation_id=>({method:'mutate',brand:'aristo',operation_id,request_payload:{contract:'crm-ab-email-v2',action:'schedule',test_id:atid,brand:'aristo',expected_version:1,review_id:rv,confirm:'schedule_both'}});
 const [idA,idB]=[randomUUID(),randomUUID()],out=await Promise.all([http(f,'POST',body(idA)),http(f,'POST',body(idA)),http(f,'POST',body(idB))]);
 assert.deepEqual(out[0],out[1],'mesmo operation_id → mesma resposta');
 assert.deepEqual([out[0].status,out[2].status].sort(),[200,409],'dois pedidos distintos → um agendamento, uma recusa');
 assert.equal(await count(f.db,'SELECT count(*)::int n FROM crm_audience_v2.ab_regular_pair WHERE test_id=$1',[atid]),1);
 assert.equal(await count(f.db,'SELECT count(*)::int n FROM crm_audience_v2.ab_panel_request WHERE operation_id=ANY($1::uuid[])',[[idA,idB]]),2,'um recibo por operation_id');
 assert.equal(await count(f.db,'SELECT count(*)::int n FROM crm_audience_v2.regular_delivery_campaign'),4);

 await timeTravel(f,'fish');const logs={};
 for(const cid of CAMPAIGNS.fish)logs[cid]=await runCampaign(f,'fish',cid,transport);
 await assertDelivered(f,'fish',tid,transport,logs,[]);
 assert.equal(await brandDispatches(f.db,'aristo'),0,'marca isolada');
});

test('fish: conferência vencida (prazo real de até 60 s) é recusada pelo servidor; nova conferência agenda uma vez',{timeout:150000},async t=>{
 const f=await setup(t),tab=await openTab(f,'fish'),tid=await prepare(f,tab,'fish');await review(tab);
 const r=(await f.db.query('SELECT checked_at,expires_at FROM crm_audience_v2.ab_regular_review WHERE test_id=$1',[tid])).rows[0];
 assert.ok(new Date(r.expires_at)-new Date(r.checked_at)<=60000,'conferência vale no máximo 60 s');
 assert.equal(tab.q('[data-abx-schedule]').disabled,false);
 await new Promise(res=>setTimeout(res,Math.max(0,new Date(r.expires_at)-Date.now())+500));
 // O lease do worker (também de curta duração) venceu junto: o pré-voo do cliente recusa sem POST.
 await schedule(tab);assert.equal(scheduleOps(f),0,'sem worker vivo nada é enviado');assert.match(message(tab),/Nenhuma tentativa foi enviada/);
 // Worker vivo de novo; conferência continua vencida. Botão ainda habilitado (sem re-render): o servidor é quem recusa.
 await heartbeat(f);assert.equal(tab.q('[data-abx-schedule]').disabled,true,'re-render desabilita o agendamento com conferência vencida');
 tab.q('[data-abx-schedule]').disabled=false;await schedule(tab);
 assert.equal(scheduleOps(f),1,message(tab));
 assert.deepEqual(await campaignState(f.db,'fish'),CAMPAIGNS.fish.map(id=>({id,status:'draft',sent:0})),'nada agendado com conferência vencida: '+message(tab));
 assert.equal(await count(f.db,'SELECT count(*)::int n FROM crm_audience_v2.regular_delivery_campaign'),0);
 assert.equal(await count(f.db,"SELECT count(*)::int n FROM crm_ab_experiment_v2 WHERE test_id=$1 AND state='prepared'",[tid]),1);
 const refusal=JSON.parse(f.store.get(Client.SLOT)).operations.at(-1);assert.equal(refusal.phase,'rejected');assert.equal(refusal.receipt.status,409);
 assert.equal(refusal.receipt.body.error,'AB_V2_AB_REGULAR_ADMISSION_EXPIRED');
 await review(tab);await schedule(tab);
 assert.equal(scheduleOps(f),2);assert.deepEqual(await campaignState(f.db,'fish'),CAMPAIGNS.fish.map(id=>({id,status:'scheduled',sent:0})),message(tab));
 assert.equal(await count(f.db,'SELECT count(*)::int n FROM crm_audience_v2.ab_regular_pair'),1);
});

test('fish: transporte falso recusa destino externo → resultado incerto pausa as duas variantes, nada mais sai e não há vencedora',async t=>{
 const f=await setup(t),tab=await openTab(f,'fish'),transport=fakeTransport();
 const tid=await prepare(f,tab,'fish');await review(tab);await schedule(tab);assert.match(detail(tab),/Agendado/,message(tab));
 const m=await membersOf(f.db,tid),external=armOf(m,'a')[0];
 // Endereço muda para um domínio real depois do agendamento: o transporte de teste nunca entrega fora de example.test.
 await f.db.query("UPDATE subscribers SET email='pessoa'||id||'@gmail.com' WHERE id=$1",[external]);
 assert.throws(()=>transport.send({to:'alguem@gmail.com'}),/DESTINO_EXTERNO_RECUSADO/);transport.refused.length=0;
 await timeTravel(f,'fish');const logs={};
 for(const cid of CAMPAIGNS.fish)logs[cid]=await runCampaign(f,'fish',cid,transport);
 assert.deepEqual(transport.refused.map(x=>x.subscriber_id),[external],'uma tentativa externa, recusada');
 assert.deepEqual(transport.sent.filter(x=>x.campaign_id===CAMPAIGNS.fish[1]),[],'variante B não sai depois do resultado incerto na A');
 assert.ok(transport.sent.every(x=>x.subscriber_id<external),'nenhum envio depois do resultado incerto');
 assert.deepEqual(await campaignState(f.db,'fish'),CAMPAIGNS.fish.map(id=>({id,status:'paused',sent:transport.sent.filter(x=>x.campaign_id===id).length})),'as duas variantes pausadas juntas');
 assert.equal(await count(f.db,'SELECT count(*)::int n FROM crm_audience_v2.regular_delivery_campaign WHERE suspended'),2);
 assert.equal(await count(f.db,"SELECT count(*)::int n FROM shrigma_email_dispatch WHERE transport_state='outcome_unknown'"),1);
 assert.ok(logs[CAMPAIGNS.fish[1]][0]?.error,'claim da B recusado com o par pausado');
 const got=await http(f,'GET',{method:'get',brand:'fish',test_id:tid});assert.equal(got.body.measurement.integrity.transport_continuous,false);
 await tab.q('[data-abx-refresh]').onclick();await settle();assert.match(detail(tab),/Resultado ainda não confirmado/,'interrupção nunca vira vencedora');
});
