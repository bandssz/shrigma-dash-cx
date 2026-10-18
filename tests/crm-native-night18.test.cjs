'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),{parseHTML}=require('linkedom');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational');
assert(['true','false'].includes(process.env.NATIVE_UI_EXPECT_ENABLED||'true'));
const source=fs.readFileSync(path.join(runtime,'public/crm-preview/drafts.js'),'utf8'),qa='felipebandeira+codex@oaristocrata.com',enabled=(process.env.NATIVE_UI_EXPECT_ENABLED||'true')==='true';
async function fixture(brand,{email=qa,action=null,status='draft',sendAt=null,receipt='succeeded'}={}){
 const {window,document}=parseHTML('<html><body>'+['new-campaign','new-audience'].map(id=>'<button id="'+id+'"></button>').join('')+['crm-pending','campaign-editor','audience-editor','campaign-drafts','audience-draft-status','campaign-draft-status'].map(id=>'<div id="'+id+'" class="d-none"></div>').join('')+'</body></html>');
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){const o=this.querySelector('option[selected]')||this.querySelector('option');return o?(o.getAttribute('value')??o.textContent):'';},set(v){for(const o of this.querySelectorAll('option'))o.selected=(o.getAttribute('value')??o.textContent)===String(v);}});
 const userId=crypto.randomUUID(),key=crypto.randomUUID(),domain=brand==='aristo'?'oaristocrata.com':'fishermans.com.br',campaign={id:901,version:'a'.repeat(32),status,sent:0,started_at:null,send_at:sendAt,definition:{brand,name:'[QA SAB17] Agenda nativa '+brand+' fixture',subject:'QA Agenda nativa',from_email:'avisos@'+domain,reply_to:'contato@'+domain,text:'Mensagem',html:'<p>Mensagem</p>',template_id:1,list_ids:[999],initiative:{key:'qa-native-fixture',name:'QA fixture'},utm_campaign:'qa-native-fixture',send_at:sendAt}},values=new Map(),calls=[],state={brand,view:'campaigns',ticket:1};
 if(action)values.set('shrigma-crm-attempt-v1:'+userId+':'+brand,JSON.stringify({schema:1,userId,brand,route:'campaigns',key,kind:'native',action}));
 const read=async(url,b,t,options={})=>{assert.equal(b,brand);assert.equal(t,1);const q=options.method==='POST'?JSON.parse(options.body):Object.fromEntries(new URL(url,'https://synthetic.invalid').searchParams);calls.push({method:options.method||'GET',action:q.acao,key:q.idempotency_key});switch(q.acao){
  case'campanha_capacidade':return {brand,read:true,draft:true,send:false};
  case'campanha_teste_capacidade':return {brand,recovery:false,internalTest:false};
  case'campanha_catalogo':return {brand,templates:[{id:1,name:'Layout',available:true}],lists:[{id:999,name:'Teste interno',available:true}]};
  case'campanha_listar':return {brand,campaigns:[campaign]};
  case'campanha_obter':return {brand,campaign};
  case'campanha_teste_historico':return {schema:'crm-campaign-test-history-v1',contract:'crm-campaign-internal-test-v1',user_id:userId,brand,campaign_id:campaign.id,attempts:[]};
  case'campanha_nativa_capacidade':return {schema:'crm-native-internal-capability-v1',brand,enabled:true,homologation_available:true,internal_test:true,commercial:false,audience_id:'a'.repeat(36)};
  case'campanha_nativa_contexto':return {schema:'crm-native-internal-context-v1',brand,campaign_id:campaign.id,eligible:true,internal_test:true,commercial:false,list_id:999};
  case'campanha_nativa_operacao':assert.equal(q.idempotency_key,key);return {attemptKey:key,state:receipt,campaign};
  default:throw Error('UNEXPECTED:'+q.acao);
 }};
 window.ShrigmaCrmRelease={nativeScheduling:true};const ctx=vm.createContext({window,document,sessionStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},crypto:crypto.webcrypto,URLSearchParams,Intl,Date});vm.runInContext(source,ctx);
 const editor=window.ShrigmaCrmDrafts.create({state:()=>state,read,session:async()=>({authenticated:true,user:{id:userId,email,role:'manager',brands:[brand],permissions:{growth:{read:true,edit:true}},productWriteFronts:['growth']}}),availability:{nativeScheduling:true},esc:v=>String(v??''),when:v=>'horário '+v,number:String,reload:()=>{}});
 const settle=async predicate=>{for(let i=0;i<200;i++){if((!predicate||predicate())&&!editor.hasUnsaved()){await new Promise(setImmediate);return;}await new Promise(r=>setTimeout(r,2));}throw Error('UI_NOT_SETTLED');};
 await editor.load('campaigns',1);return{document,window,values,calls,editor,settle,open:async()=>{document.querySelector('[data-open-draft]').click();await settle(()=>!!document.querySelector('#campaign-editor form'));for(let i=0;i<10;i++)await new Promise(setImmediate);}};
}
for(const brand of ['aristo','fish']){
 test('native homologation remains QA-and-owner-only and immutable hold ignores browser release '+brand,async()=>{
  const qaUi=await fixture(brand);await qaUi.open();assert.equal(!!qaUi.document.querySelector('#campaign-native'),enabled);assert.equal(qaUi.calls.some(x=>x.action==='campanha_nativa_capacidade'),enabled);
  const ownerUi=await fixture(brand,{email:'felipebandeira@oaristocrata.com'});await ownerUi.open();assert.equal(!!ownerUi.document.querySelector('#campaign-native'),enabled);assert(ownerUi.calls.every(x=>x.method==='GET'));
  const analyst=await fixture(brand,{email:'analista@'+(brand==='aristo'?'oaristocrata.com':'fishermans.com.br')});await analyst.open();assert.equal(analyst.document.querySelector('#campaign-native'),null);assert(!analyst.calls.some(x=>x.action?.startsWith('campanha_nativa_')));
  assert(qaUi.calls.every(x=>x.method==='GET'));assert(analyst.calls.every(x=>x.method==='GET'));
 });
 for(const action of ['campanha_nativa_agendar','campanha_nativa_cancelar'])test('stale '+action+' keeps only same-key GET consultation '+brand,async()=>{
  const f=await fixture(brand,{action,receipt:'pending'}),buttons=[...f.document.querySelectorAll('#crm-pending button')];assert.equal(buttons.length,1);assert.match(buttons[0].textContent,/Consultar tentativa/);assert(!f.document.body.textContent.includes('Concluir cancelamento'));const saved=[...f.values];buttons[0].click();await f.settle();assert.deepEqual([...f.values],saved);assert(f.calls.some(x=>x.action==='campanha_nativa_operacao'));assert(f.calls.every(x=>x.method==='GET'));assert.equal(f.document.querySelectorAll('#crm-pending button').length,1);
 });
 test('old schedule receipt displays current draft after cancellation '+brand,async()=>{
  const f=await fixture(brand,{action:'campanha_nativa_agendar',status:'draft',sendAt:null});f.document.querySelector('#crm-pending button').click();await f.settle(()=>![...f.values.keys()].some(k=>k.startsWith('shrigma-crm-attempt-v1:')));assert.match(f.document.querySelector('#campaign-edit-status').textContent,/Rascunho · sem data de envio/);assert.doesNotMatch(f.document.querySelector('#campaign-edit-status').textContent,/Agendada/);assert(f.calls.every(x=>x.method==='GET'));
 });
 test('old cancellation receipt displays the current scheduled campaign '+brand,async()=>{
  const date=new Date(Date.now()+1800000).toISOString(),f=await fixture(brand,{action:'campanha_nativa_cancelar',status:'scheduled',sendAt:date});f.document.querySelector('#crm-pending button').click();await f.settle(()=>![...f.values.keys()].some(k=>k.startsWith('shrigma-crm-attempt-v1:')));assert.match(f.document.querySelector('#campaign-edit-status').textContent,/Agendada para/);assert(f.document.querySelector('#campaign-edit-status').textContent.includes(date));assert.doesNotMatch(f.document.querySelector('#campaign-edit-status').textContent,/sem data/);assert(f.calls.every(x=>x.method==='GET'));
 });
}
