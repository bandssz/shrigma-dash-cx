'use strict';
// Portal corporativo de ponta a ponta, sem navegador real: artefato construído por
// services/dashboard-operational/build.cjs (crm/index.html com CSP + entry.js,
// campaign-edit.js e campaign-bff-client.js compilados), login pelo formulário, cookie
// de sessão e CSRF reais, servidor real (auth SQLite descartável + BFF de campanhas) do
// fixture dashboard-operational-campaign-submit, origem com o serviço real de campanhas
// sobre armazenamento sintético. Escritor admitido pela fábrica do fixture
// (installCampaignWriter); nenhuma capacidade montada à mão. Rede só em 127.0.0.1.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {parseHTML}=require('linkedom');
const {fixture,hosts,command}=require('./dashboard-operational-campaign-submit.test.cjs');
const {build}=require('../services/dashboard-operational/build.cjs');
const PASSWORD='Synthetic campaign manager password 2026!';
let built;function artifact(){if(!built){const d=fs.mkdtempSync(path.join(os.tmpdir(),'shell-artifact-'));built=build(path.join(d,'out')).directory;}return built;}
async function until(check,label,ms=8000){const end=Date.now()+ms;while(!check()){if(Date.now()>end)assert.fail('não estabilizou: '+label);await new Promise(r=>setTimeout(r,5));}}
function shell(f,{area='crm',cookie:initialCookie='',values=new Map(),loseAck=null}={}){
 const pub=path.join(artifact(),'public'),html=fs.readFileSync(path.join(pub,area,'index.html'),'utf8'),{document,window:w}=parseHTML(html);
 let focus=document.body;Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focus});w.HTMLElement.prototype.focus=function(){focus=this;};
 Object.defineProperty(w.HTMLInputElement.prototype,'checked',{configurable:true,get(){return this.hasAttribute('checked');},set(v){this.toggleAttribute('checked',Boolean(v));}});
 for(const select of document.querySelectorAll('select'))Object.defineProperty(select,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},set(v){for(const o of this.querySelectorAll('option'))o.toggleAttribute('selected',o.value===String(v));}});
 const dialog=document.getElementById('entry-campaign-dialog');Object.defineProperty(dialog,'open',{configurable:true,get:()=>dialog.hasAttribute('open')});dialog.showModal=function(){this.setAttribute('open','');};dialog.close=function(){this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));};
 const host=hosts.growth,originUrl='https://'+host,calls=[];let cookie=initialCookie;
 const context={document,location:new URL(originUrl+'/'),history:{replaceState(){}},navigator:{locks:{request(name,options,cb){if(typeof options==='function')cb=options;return Promise.resolve(cb({name,mode:'exclusive'}));}},clipboard:{writeText:async()=>{}}},localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},Date,URL,URLSearchParams,Headers,AbortController,TextEncoder,Event:w.Event,crypto:crypto.webcrypto,setTimeout,clearTimeout,confirm:()=>false,addEventListener:w.addEventListener.bind(w)};
 context.window=context;context.parent=context;const sandbox=vm.createContext(context);
 const realm=v=>{sandbox.__e=JSON.stringify(v);try{return vm.runInContext('JSON.parse(__e)',sandbox);}finally{delete sandbox.__e;}};
 context.fetch=async(value,options={})=>{
  const url=new URL(value,originUrl);assert.equal(url.origin,originUrl);assert.equal(options.credentials,'same-origin');
  const headers=new Headers(options.headers);assert.equal(headers.has('authorization'),false);
  const method=options.method||'GET',body=options.body===undefined?undefined:JSON.parse(options.body);
  const ctx={cookie,csrf:headers.get('x-csrf-token')||undefined,origin:method==='GET'?null:originUrl,metadata:{'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty'}};const r=method==='POST'?await f.post(host,url.pathname+url.search,body,ctx):await f.get(host,url.pathname+url.search,ctx);
  const set=r.headers['set-cookie'];if(set)cookie=set[0].split(';')[0];
  calls.push({method,path:url.pathname+url.search,status:r.status,body,csrf:headers.get('x-csrf-token'),cookie:!!ctx.cookie});
  // ACK perdido: o servidor respondeu (e gravou); o navegador não recebe a resposta.
  if(loseAck&&loseAck(method,body,r))throw new TypeError('synthetic lost ACK');
  return {status:r.status,ok:r.status>=200&&r.status<300,json:async()=>realm(r.json??{})};
 };
 for(const src of [...document.querySelectorAll('script[src]')].map(n=>n.getAttribute('src')))vm.runInContext(fs.readFileSync(path.join(pub,src.replace(/^\//,'')),'utf8'),sandbox,{filename:src});
 const el=id=>document.getElementById(id);
 return {document,window:w,dialog,calls,values,el,cookie:()=>cookie,input(id,v){const e=el(id);e.value=v;e.dispatchEvent(new w.Event('input',{bubbles:true}));},confirm(){const e=el('campaign-confirm');e.checked=true;e.dispatchEvent(new w.Event('change',{bubbles:true}));},
  async login(email){await until(()=>calls.some(c=>c.path==='/auth/session')&&!el('entry-login').hidden,'tela de entrada');el('login-email').value=email;el('login-password').value=PASSWORD;await el('login-form').onsubmit?.({preventDefault(){}})??el('login-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await until(()=>!el('entry-shell').hidden||calls.some(c=>c.path==='/auth/login'&&c.status!==200),'login');}};
}
const posts=s=>s.calls.filter(c=>c.method==='POST'&&c.path==='/api/campaigns');
const deliveries=f=>f.inspect(db=>db.prepare('SELECT * FROM crm_campaign_delivery_v1').all());
async function openEditor(s,ready=()=>!s.el('campaign-validate').disabled){s.el('entry-campaign-open').click();await until(()=>s.dialog.open&&/Campanha 7/.test(s.el('campaign-state').textContent)&&ready(),'editor aberto');}

test('escritor admitido: login pelo formulário → Editar campanhas → salvar, conferir, agendar e cancelar pelo BFF real, com cookie e CSRF',async t=>{
 const f=await fixture(t);await f.manager('writer@synthetic.invalid');
 const s=shell(f);await s.login('writer@synthetic.invalid');
 assert.equal(s.el('entry-brand').textContent,'Fishermans');assert.equal(s.el('entry-campaign-open').hidden,false);assert.equal(s.el('entry-campaign-open').textContent,'Editar campanhas');
 assert.equal(s.document.getElementById('entry-campaign-note')?.hidden??true,true,'sem aviso de espera para o escritor pronto');
 assert.match(s.document.querySelector('iframe').src,/growth\.html\?embed=1$/);
 await openEditor(s);s.input('campaign-subject','Assunto pelo portal corporativo');
 for(const action of ['save','validate','schedule','cancel']){
  if(action==='schedule'||action==='cancel'){assert.equal(s.el('campaign-'+action).disabled,true,action+' exige a confirmação marcada');s.confirm();}
  assert.equal(s.el('campaign-'+action).disabled,false,action);s.el('campaign-'+action).click();
  await until(()=>f.origin.effects[action]===1&&!s.el('campaign-consult').disabled,action);
 }
 assert.match(s.el('campaign-status').textContent,/Cancelamento confirmado/);
 assert.deepEqual(f.origin.effects,{save:1,validate:1,schedule:1,cancel:1,create:0});
 const p=posts(s);assert.equal(p.length,4);assert.ok(p.every(c=>c.status===200&&c.csrf&&c.cookie));assert.equal(new Set(p.map(c=>c.body.idempotency_key)).size,4);
 assert.deepEqual(p.map(c=>c.body.acao),['campanha_salvar','campanha_validar','campanha_agendar','campanha_cancelar']);
 assert.equal(f.calls.filter(c=>c.method==='POST').length,4);assert.ok(f.calls.every(c=>c.actor==='panel:dcrmw-'+'1'.repeat(32)),'origem recebe só o escritor individual');
 assert.equal(deliveries(f).length,4,'cada POST tem intenção gravada no BFF');
 assert.equal(f.origin.row().status,'cancelled');
});

test('escritor: ACK do agendar perdido → a tela preserva a tentativa, clique repetido não reenvia; recarregar reconcilia pela leitura do recibo, sem POST',async t=>{
 const f=await fixture(t);await f.manager('writer@synthetic.invalid');let lost=0;
 const s=shell(f,{loseAck:(method,body)=>method==='POST'&&body?.acao==='campanha_agendar'&&++lost===1});await s.login('writer@synthetic.invalid');
 await openEditor(s);
 s.el('campaign-validate').click();await until(()=>/Público conferido/.test(s.el('campaign-status').textContent)&&!s.el('campaign-consult').disabled,'conferência');
 s.confirm();await until(()=>!s.el('campaign-schedule').disabled,'agendar liberado');s.el('campaign-schedule').click();await until(()=>lost===1&&/não foi confirmada/.test(s.el('campaign-status').textContent),'ACK perdido');
 assert.match(s.el('campaign-status').textContent,/Preserve a tentativa e consulte seu resultado; não repita o pedido/);
 assert.equal(f.origin.row().status,'scheduled','o serviço gravou');assert.equal(f.origin.effects.schedule,1);
 const key=posts(s).find(c=>c.body.acao==='campanha_agendar').body.idempotency_key;
 s.confirm();s.el('campaign-schedule').click();await new Promise(r=>setTimeout(r,50));assert.equal(posts(s).filter(c=>c.body.acao==='campanha_agendar').length,1,'clique repetido não reenvia');
 // Recarregar: mesma sessão (cookie) e mesmo armazenamento local.
 const r=shell(f,{cookie:s.cookie(),values:s.values});await until(()=>!r.el('entry-shell').hidden,'sessão restaurada');
 await openEditor(r,()=>/scheduled/.test(r.el('campaign-state').textContent));
 assert.equal(posts(r).length,0,'recarregar não reenvia');
 const reads=r.calls.filter(c=>c.path.startsWith('/auth/campaign-delivery'));assert.ok(reads.length>=1,'reconciliação pela leitura do recibo');
 assert.ok(reads.every(c=>c.method==='GET'&&c.csrf&&new URL(c.path,'https://x').searchParams.get('idempotency_key')===key),'mesma chave, só GET');
 assert.equal(r.el('campaign-schedule').disabled,true);assert.equal(f.origin.effects.schedule,1);assert.equal(f.calls.filter(c=>c.method==='POST').length,2);
 r.el('campaign-consult').click();await new Promise(res=>setTimeout(res,100));assert.equal(posts(r).length,0);assert.equal(f.origin.effects.schedule,1);
});

test('edição aprovada sem escritor pronto: CRM em leitura, aviso explica a espera, nenhuma edição oferecida e POST forjado recusado',async t=>{
 const f=await fixture(t);await f.manager('reader@synthetic.invalid',{writer:false});
 const s=shell(f);await s.login('reader@synthetic.invalid');
 assert.match(s.document.querySelector('iframe').src,/growth\.html\?embed=1$/,'leitura do CRM preservada');
 assert.equal(s.el('entry-campaign-open').hidden,true);
 const note=s.document.getElementById('entry-campaign-note');assert.ok(note,'aviso presente');assert.equal(note.hidden,false);assert.equal(note.getAttribute('role'),'status');
 assert.match(note.textContent,/aguardando validação · CRM em leitura/);assert.match(note.title,/Nada pode ser salvo ou agendado/);assert.doesNotMatch(note.textContent,/ativa|liberad/i);
 s.el('entry-campaign-open').click();await new Promise(r=>setTimeout(r,30));assert.equal(s.dialog.open,false);
 const session=await f.get(hosts.growth,'/auth/session',{cookie:s.cookie(),origin:null});const row=f.origin.row();
 const forged=await f.post(hosts.growth,'/api/campaigns',command('salvar',row,'forged-portal-key-000001',{definition:row.definition}),{cookie:s.cookie(),csrf:session.json.csrf});
 assert.equal(forged.status,403);assert.deepEqual(f.origin.effects,{save:0,validate:0,schedule:0,cancel:0,create:0});assert.equal(f.calls.length,0);
});

test('edição desligada (somente leitura): sem botão e sem aviso de espera; leitura do CRM preservada e POST recusado',async t=>{
 const f=await fixture(t,{enabled:false});await f.manager('reader@synthetic.invalid',{writer:false});
 const s=shell(f);await s.login('reader@synthetic.invalid');
 assert.match(s.document.querySelector('iframe').src,/growth\.html\?embed=1$/);assert.equal(s.el('entry-campaign-open').hidden,true);
 assert.equal(s.document.getElementById('entry-campaign-note')?.hidden??true,true,'leitura simples não ganha aviso de edição pendente');
 const session=await f.get(hosts.growth,'/auth/session',{cookie:s.cookie(),origin:null});const row=f.origin.row();
 const forged=await f.post(hosts.growth,'/api/campaigns',command('salvar',row,'forged-portal-key-000002',{definition:row.definition}),{cookie:s.cookie(),csrf:session.json.csrf});
 assert.ok([403,503].includes(forged.status),String(forged.status));assert.deepEqual(f.origin.effects,{save:0,validate:0,schedule:0,cancel:0,create:0});
});

test('edição expira com agendamento sem confirmação: o aviso diz que a tentativa está preservada e não será repetida; nada é reenviado',async t=>{
 const f=await fixture(t);await f.manager('writer@synthetic.invalid');let lost=0;
 const s=shell(f,{loseAck:(method,body)=>method==='POST'&&body?.acao==='campanha_agendar'&&++lost===1});await s.login('writer@synthetic.invalid');
 await openEditor(s);s.el('campaign-validate').click();await until(()=>/Público conferido/.test(s.el('campaign-status').textContent)&&!s.el('campaign-consult').disabled,'conferência');
 s.confirm();await until(()=>!s.el('campaign-schedule').disabled,'agendar liberado');s.el('campaign-schedule').click();await until(()=>lost===1&&/não foi confirmada/.test(s.el('campaign-status').textContent),'ACK perdido');
 const journal=()=>[...s.values.entries()].filter(([k])=>k.startsWith('shrigma_campaign_bff_v1:')),before=JSON.stringify(journal());
 const sent=f.calls.filter(c=>c.method==='POST').length;
 f.advance(14*86400000+1);
 const e=shell(f,{values:s.values});await e.login('writer@synthetic.invalid');
 assert.equal(e.el('entry-campaign-open').hidden,true);const note=e.document.getElementById('entry-campaign-note');
 assert.equal(note.hidden,false);assert.equal(note.getAttribute('role'),'status');
 assert.equal(note.textContent,'Edição de campanhas aguardando validação · tentativa sem confirmação preservada, não será repetida');
 assert.match(note.title,/não será enviada de novo.*conferir o resultado antes de qualquer nova ação/);assert.doesNotMatch(note.textContent,/\bativa\b|liberad|agendad/i);
 assert.equal(JSON.stringify(journal()),before,'diário intacto');assert.equal(f.calls.filter(c=>c.method==='POST').length,sent,'nada reenviado');assert.equal(f.origin.effects.schedule,1);
});
