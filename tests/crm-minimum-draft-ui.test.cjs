'use strict';
// Execute the real editor against synthetic responses; no customer or network.
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),{parseHTML}=require('linkedom');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational'),C=require(runtime+'/campaign-write-contract.js'),source=fs.readFileSync(runtime+'/public/crm-preview/drafts.js','utf8');
async function fixture(brand,{outcome='succeeded',preflight=true,reserved=false}={}){
 const {window,document}=parseHTML('<html><body>'+['new-campaign','new-audience'].map(id=>'<button id="'+id+'"></button>').join('')+['crm-pending','campaign-editor','audience-editor','campaign-drafts','audience-draft-status','campaign-draft-status'].map(id=>'<div id="'+id+'"></div>').join('')+'</body></html>');
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){const o=this.querySelector('option[selected]')||this.querySelector('option');return o?(o.getAttribute('value')??o.textContent):'';},set(v){for(const o of this.querySelectorAll('option'))o.selected=(o.getAttribute('value')??o.textContent)===String(v);}});
 const userId=crypto.randomUUID(),state={brand,view:'campaigns',ticket:1},catalog={brand,current:true,templates:[{id:brand==='aristo'?3:1,name:'Layout da marca',type:'campaign',available:true}],lists:[]},calls=[],values=new Map(),selected=[];let saved=null,write=true,key,resolvePost;
 const read=async(url,b,t,opts={})=>{a.equal(b,brand);const p=opts.method==='POST'?JSON.parse(opts.body):Object.fromEntries(new URL(url,'https://synthetic.invalid').searchParams);calls.push(p);switch(p.acao){
  case'campanha_capacidade':return{brand,read:true,draft:write,send:false};
  case'campanha_teste_capacidade':return{brand,recovery:false,internalTest:false};
  case'campanha_catalogo':return catalog;
  case'campanha_listar':return{brand,campaigns:saved?[saved]:[]};
  case'campanha_previa':return{schema:'crm-campaign-preflight-v1',brand,ready:preflight,message:'Confira o assunto.'};
  case'campanha_criar':case'campanha_salvar':key=p.idempotency_key;if(reserved)throw Object.assign(Error('REFUSED'),{reserved:false});return new Promise(resolve=>{resolvePost=()=>{if(outcome==='succeeded'){saved={id:701,version:'a'.repeat(32),status:'draft',sent:0,started_at:null,send_at:null,definition:C.normalizeDraft(p.definition,{catalog})};resolve({attemptKey:key,state:'succeeded',campaign:saved});}else resolve({attemptKey:key,state:'pending'});};});
  case'campanha_obter':return{brand,campaign:saved};
  case'campanha_teste_historico':return{schema:'crm-campaign-test-history-v1',contract:'crm-campaign-internal-test-v1',user_id:userId,brand,campaign_id:saved.id,attempts:[]};
  case'campanha_operacao':a.equal(p.idempotency_key,key);return{attemptKey:key,state:'rejected'};
  default:throw Error('UNEXPECTED:'+p.acao);
 }};
 const ctx=vm.createContext({window,document,sessionStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},crypto:crypto.webcrypto,URLSearchParams,Date,Intl,DOMParser:window.DOMParser});vm.runInContext(source,ctx);
 const editor=window.ShrigmaCrmDrafts.create({state:()=>state,read,session:async()=>({authenticated:true,user:{id:userId,email:'synthetic-editor@invalid.test',role:'manager',brands:[brand],permissions:{growth:{read:true,edit:write}},productWriteFronts:write?['growth']:[]}}),availability:{},esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),when:String,number:String,reload(){},campaignSelected:id=>{state.campaignId=id;selected.push(id);}});
 const until=async predicate=>{for(let i=0;i<100;i++){if(predicate()){await new Promise(setImmediate);return;}await new Promise(setImmediate);}throw Error('UI_NOT_SETTLED');};
 const input=(id,value)=>{const e=document.getElementById(id);e.value=value;e.dispatchEvent(new window.Event('input',{bubbles:true}));};
 const submit=()=>document.getElementById('campaign-draft-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
 await editor.load('campaigns',1);document.getElementById('new-campaign').click();return{window,document,editor,calls,values,state,selected,input,submit,until,catalog,get saved(){return saved;},release:()=>resolvePost(),hasPost:()=>!!resolvePost,revoke:()=>{write=false;}};
}
for(const brand of ['aristo','fish']){
 test('partial definition enters only the existing authenticated draft-service proxy '+brand,()=>{
  const P=require(runtime+'/proxy.cjs'),definition=C.normalizeDraft({schema_version:C.VERSION,brand,channel:'email',name:'[TESTE] Ideia',subject:'[TESTE] Assunto',tags:[C.DRAFT_EDITOR_TAG],send_at:null},{catalog:{brand,current:true,templates:[{id:1,type:'campaign',available:true}],lists:[]}}),body={acao:'campanha_salvar',brand,definition,idempotency_key:crypto.randomUUID()};
  a.throws(()=>P.decide('campaigns','POST',new URLSearchParams(),body),e=>e.code==='FIELD_DENIED');a.throws(()=>P.decide('campaigns','POST',new URLSearchParams(),body,{crmCampaignSubmitWrite:true}),e=>e.code==='FIELD_DENIED');a.equal(P.decide('campaigns','POST',new URLSearchParams(),body,{crmCampaignDraftService:true}).action,'campanha_salvar');
  a.throws(()=>P.decide('campaigns','POST',new URLSearchParams(),{...body,definition:{...definition,tags:[]}},{crmCampaignDraftService:true}),e=>e.code==='FIELD_DENIED');a.throws(()=>P.decide('campaigns','POST',new URLSearchParams(),{...body,definition:{...definition,send_at:new Date(Date.now()+1800000).toISOString()}},{crmCampaignDraftService:true}),e=>e.code==='FIELD_DENIED');
 });
 test('minimum fields, real blocking save and reopen preserve the original draft '+brand,async()=>{
  const f=await fixture(brand),form=f.document.getElementById('campaign-draft-form');a.deepEqual([...form.querySelectorAll('[required]')].map(e=>e.id),['draft-name','draft-subject']);a(f.document.getElementById('draft-reply_to').hasAttribute('readonly'));
  f.input('draft-name','[TESTE] Ideia mínima '+brand);f.input('draft-subject','[TESTE] Assunto');f.submit();await f.until(f.hasPost);a.equal(f.document.getElementById('campaign-editor').getAttribute('aria-busy'),'true');a.equal(form.querySelector('[data-crm-save]').textContent,'Salvando…');a([...form.querySelectorAll('button,input,textarea,select')].every(e=>e.disabled));f.submit();a.equal(f.calls.filter(x=>x.acao==='campanha_criar').length,1);
  f.release();await f.until(()=>!f.editor.hasUnsaved());a.equal(f.saved.id,701);a.deepEqual(f.saved.definition.list_ids,[]);a.equal(f.saved.definition.html,'');a.equal(f.saved.definition.text,'');a.equal(f.saved.definition.reply_to,'contato@'+C.BRANDS[brand]);a.equal(f.saved.definition.utm_campaign,C.draftSlug(f.saved.definition.name));a.equal(f.state.campaignId,701);a.match(f.document.getElementById('campaign-drafts').textContent,/Ideia mínima/);
  await f.editor.load('campaigns',1);a.equal(f.document.getElementById('draft-name').value,f.saved.definition.name);a.equal(f.document.getElementById('draft-subject').value,f.saved.definition.subject);a.equal(f.document.querySelectorAll('[name=draft-list]:checked').length,0);
 });
 test('uncertain save then original GET refusal retains edits and restores only current WRITE '+brand,async()=>{
  const f=await fixture(brand,{outcome:'pending'});f.input('draft-name','[TESTE] Mantido');f.input('draft-subject','[TESTE] Assunto mantido');f.submit();await f.until(f.hasPost);f.release();await f.until(()=>f.document.getElementById('campaign-editor').getAttribute('aria-busy')==='false');a(f.document.getElementById('draft-name').disabled);f.document.querySelector('#crm-pending button').click();await f.until(()=>!f.values.size);a(f.editor.hasUnsaved());a.equal(f.document.getElementById('draft-name').value,'[TESTE] Mantido');a.equal(f.document.getElementById('draft-name').disabled,false);a.equal(f.calls.filter(x=>x.acao==='campanha_criar').length,1);a.equal(f.calls.filter(x=>x.acao==='campanha_operacao').length,1);a.match(f.document.getElementById('campaign-edit-status').textContent,/Não foi salvo/);f.document.querySelector('[data-crm-discard]').click();a.equal(f.editor.hasUnsaved(),false);
 });
 test('revocation after uncertain save preserves content and blocks another save '+brand,async()=>{
  const f=await fixture(brand,{outcome:'pending'});f.input('draft-name','[TESTE] Revogado');f.input('draft-subject','[TESTE] Mantido');f.submit();await f.until(f.hasPost);f.release();await f.until(()=>f.document.getElementById('campaign-editor').getAttribute('aria-busy')==='false');f.revoke();f.document.querySelector('#crm-pending button').click();await f.until(()=>!f.values.size);a.equal(f.document.getElementById('draft-name').value,'[TESTE] Revogado');a(f.document.querySelector('[data-crm-save]').disabled);a(f.editor.hasUnsaved());a.equal(f.calls.filter(x=>x.acao==='campanha_criar').length,1);
 });
 for(const failure of ['preflight','reserved'])test('refusal retains fields and dirty state '+failure+' '+brand,async()=>{
  const f=await fixture(brand,{preflight:failure!=='preflight',reserved:failure==='reserved'});f.input('draft-name','[TESTE] Não salvo');f.input('draft-subject','[TESTE] Assunto');f.submit();await f.until(()=>f.document.getElementById('campaign-editor').getAttribute('aria-busy')==='false');a(f.editor.hasUnsaved());a.equal(f.document.getElementById('draft-name').value,'[TESTE] Não salvo');a.equal(f.values.size,0);a.equal(f.calls.filter(x=>x.acao==='campanha_criar').length,failure==='reserved'?1:0);
 });
}
