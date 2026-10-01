'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom'),{webcrypto}=require('node:crypto'),F=require('../n8n/growth/vip-recorded-origin-form.cjs');
const clientSource=fs.readFileSync(path.resolve(__dirname,'../n8n/growth/vip-recorded-origin-client.js'),'utf8'),event='12345678-1234-4abc-8def-1234567890ab';
const legacy=`\n(function(){\nvar CONFIG={origem:'lp-fixture'};\nvar GRUPO='https://example.invalid/group';\nvar emailOk=function(v){return /^[^\\s@]+@[^\\s@]+\\.[a-z]{2,}$/i.test(v.trim())};\nvar gate=document.getElementById('almaGate');\nvar gBtn=document.getElementById('almaBtn');\nvar gEmail=document.getElementById('almaEmail');\nvar gErr=document.getElementById('almaEmailErr');\ngate.addEventListener('submit',function(ev){\nev.preventDefault();\ngErr.textContent='';gEmail.setAttribute('aria-invalid','false');\nif(document.getElementById('almaEmpresa').value){location.href=GRUPO;return}\nvar email=gEmail.value.trim();\nif(!emailOk(email)){gErr.textContent='Confira';return}\ngBtn.disabled=true;gBtn.textContent='Abrindo';\nvar dados=new URLSearchParams();\ndados.set('form_type','customer');dados.set('utf8','✓');\ndados.set('contact[email]',email);\ndados.set('contact[tags]','grupo-vip, alma-da-roca-espera');\ntry{fetch('/contact',{method:'POST',body:dados,keepalive:true}).catch(function(){})}catch(e){}\ntry{fetch('https://example.invalid/webhook/fixture-vip',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email,origem:CONFIG.origem})}).catch(function(){})}catch(e){}\nsetTimeout(function(){location.href=GRUPO},350);\n});\n})();\n`;
const html=`<!doctype html><html><body><form id="almaGate"><input id="almaEmpresa"><input id="almaEmail"><span id="almaEmailErr"></span><button id="almaBtn">Entrar</button></form><script>${legacy}</script></body></html>`;
const target={htmlSha256:F.sha(html),source:'alma',producerId:'fixture-producer',producerRevision:'a'.repeat(64),legacyPath:'fixture-vip',path:'fixture-vip-recorded-v2',scriptSha256:F.sha(legacy)};
function storage(){const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),dump:()=>[...m.entries()]};}
function locks(){let tail=Promise.resolve();return {request(_n,_o,fn){const p=tail.then(fn);tail=p.catch(()=>{});return p;}};}
function boot(output,store,calls,mode='accepted',adjust=()=>{}){
 const {document,window:dom}=parseHTML(output.html),location={href:''};const fetch=async(url,options={})=>{const text=String(url),method=options.method||'GET',journal=store.dump()[0]?.[1]||null;calls.push({url:text,method,journal});if(text==='/contact')return {ok:true,json:async()=>({})};if(new URL(text).pathname.endsWith('/'+target.path)){if(method==='POST'&&mode==='lost')throw Error('lost');const id=method==='POST'?JSON.parse(options.body).event_id:new URL(text).searchParams.get('event_id');return {ok:true,json:async()=>({contract:'crm-recorded-origin-receipt-v1',state:'accepted',producer_id:target.producerId,event_id:id,receipt_hash:'b'.repeat(64),accepted_at:'2026-09-29T12:00:00.000Z',newly_recorded:method==='POST'})};}return {ok:true,json:async()=>[]};};
 const ctx={document,location,URL,URLSearchParams,TextEncoder,AbortController,crypto:{randomUUID:()=>event,subtle:webcrypto.subtle},navigator:{locks:locks()},localStorage:store,fetch,setInterval:()=>1,clearInterval:()=>{},setTimeout,clearTimeout,Date,Math,console};ctx.window=ctx;ctx.globalThis=ctx;ctx.Event=dom.Event;adjust(ctx);vm.createContext(ctx);const scripts=[...output.html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(x=>x[1]);vm.runInContext(scripts.find(x=>x.includes('var VipRecordedOriginClient=')),ctx);vm.runInContext(scripts.find(x=>x.includes('var recordedOrigin=VipRecordedOriginClient.')),ctx);return {ctx,document,location};
}
async function submit(x){x.document.getElementById('almaGate').dispatchEvent(new x.ctx.Event('submit',{bubbles:true,cancelable:true}));for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));}

test('portable form transform journals before isolated Shopify POST and redirects only after ACK from the v2 route',async()=>{const output=F.transformPinnedForm(html,clientSource,target),store=storage(),calls=[],page=boot(output,store,calls);page.document.getElementById('almaEmail').value='person@example.invalid';await submit(page);const origin=calls.filter(x=>x.url.includes(target.path));assert.equal(origin.filter(x=>x.method==='POST').length,1);assert.equal(calls.filter(x=>{try{return new URL(x.url).pathname.endsWith('/'+target.legacyPath)}catch{return false}}).length,0);assert.equal(calls.filter(x=>x.url==='/contact').length,1);assert.ok(calls.find(x=>x.url==='/contact').journal);assert.ok(origin[0].journal);assert.match(page.location.href,/^https:/);assert.ok(!store.dump()[0][1].includes('person@example.invalid'));assert.ok(!output.html.includes('setTimeout(function(){location.href=GRUPO},350)'));assert.equal(output.endpoint_path,target.path);assert.throws(()=>F.patchRecordedOriginForm(html,clientSource),/HTML_DRIFT/);});

test('lost ACK and reload perform GET only and never repeat either POST',async()=>{const output=F.transformPinnedForm(html,clientSource,target),store=storage(),calls=[],first=boot(output,store,calls,'lost');first.document.getElementById('almaEmail').value='person@example.invalid';await submit(first);assert.equal(first.location.href,'');assert.equal(first.document.getElementById('almaEmail').disabled,true);assert.equal(JSON.parse(store.dump()[0][1]).state,'uncertain');const second=boot(output,store,calls);assert.equal(second.document.getElementById('almaBtn').textContent,'Conferir inscrição anterior');await submit(second);const origin=calls.filter(x=>x.url.includes(target.path));assert.equal(origin.filter(x=>x.method==='POST').length,1);assert.equal(origin.filter(x=>x.method==='GET').length,1);assert.equal(calls.filter(x=>x.url==='/contact').length,1);assert.match(second.location.href,/^https:/);});

test('HTML, script and client drift fail closed',()=>{assert.throws(()=>F.transformPinnedForm(html+' ',clientSource,target),/HTML_DRIFT/);assert.throws(()=>F.transformPinnedForm(html,clientSource+' ',target),/CLIENT/);assert.throws(()=>F.transformPinnedForm(html,clientSource,{...target,scriptSha256:'0'.repeat(64)}),/SCRIPT_DRIFT/);});

test('initialization failures prevent native form navigation and give a visible unavailable state',async()=>{
 const output=F.transformPinnedForm(html,clientSource,target);
 for(const kind of ['no-locks','storage-denied','corrupt-journal']){
  const store=storage(),calls=[];
  if(kind==='corrupt-journal')store.setItem('crm.vip.recorded-origin.alma','broken');
  const page=boot(output,store,calls,'accepted',ctx=>{
   if(kind==='no-locks')ctx.navigator.locks=null;
   if(kind==='storage-denied')Object.defineProperty(ctx,'localStorage',{get(){throw Error('denied');}});
  });
  const ev=new page.ctx.Event('submit',{bubbles:true,cancelable:true});
  page.document.getElementById('almaGate').dispatchEvent(ev);
  assert.equal(ev.defaultPrevented,true);assert.equal(calls.length,0);assert.equal(page.location.href,'');
  assert.equal(page.document.getElementById('almaBtn').disabled,true);
  assert.equal(page.document.getElementById('almaEmail').disabled,true);
  assert.match(page.document.getElementById('almaEmailErr').textContent,/Nenhuma nova inscrição foi enviada/);
 }
});
