'use strict';
// Actual generated portal assets, synthetic session and DOM; no socket or DB.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {parseHTML}=require('linkedom');
const {createCampaignBffClient}=require('../services/dashboard-operational/public/campaign-bff-client.js');
const {createCampaignEditor}=require('../services/dashboard-operational/public/campaign-edit.compiled.js');
const session=flag=>({authenticated:true,uiKey:'ui-'+'a'.repeat(32),csrf:'c'.repeat(43),features:{campaignSubmitWrite:true,...(flag===undefined?{}:{campaignCreate:flag})},user:{role:'manager',brand:'fish',brands:['fish'],brandAccess:'single',areas:['growth'],permissions:{growth:{read:true,edit:true}}}});
const command={brand:'fish',idempotency_key:'corporate_ui_create_0001',definition:{brand:'fish',send_at:null}};
const pending=row=>({status:202,body:{schema:'crm-campaign-bff-operation-v1',action:row.action,attemptKey:row.attemptKey,state:'pending',campaign:null,validation:null}});
function clientFixture(flag){let state=session(flag);const rows=new Map(),calls=[],key=s=>s.uiKey+':'+s.brand,client=createCampaignBffClient({getSession:()=>state,readJournal:s=>rows.get(key(s))??null,writeJournal:(s,row)=>rows.set(key(s),structuredClone(row)),request:async q=>{calls.push(q);return pending(rows.get('ui-'+'a'.repeat(32)+':fish'));}});return{rows,calls,client,setFlag:flag=>{state=session(flag);}};}

test('compiled client forbids new CREATE when corporate capability is false before journal or POST; legacy/ON remain compatible',async()=>{
 const off=clientFixture(false);await assert.rejects(off.client.create(command),{code:'CAMPAIGN_BFF_DENIED'});assert.equal(off.calls.length,0);assert.equal(off.rows.size,0);
 for(const flag of [true,undefined]){const f=clientFixture(flag);assert.equal((await f.client.create(command)).state,'pending');assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'POST');assert.equal(f.calls[0].path,'/auth/campaign-create');}
});

test('turning new CREATE OFF retains an existing scoped intent and permits only its GET receipt with the same key',async()=>{
 const f=clientFixture(true);await f.client.create(command);const prior=structuredClone(f.rows.values().next().value);f.setFlag(false);await f.client.consult('fish');await f.client.create(command);assert.deepEqual(f.calls.map(v=>v.method),['POST','GET','GET']);assert.equal(f.calls.slice(1).every(v=>v.path==='/auth/campaign-create?brand=fish&idempotency_key='+command.idempotency_key),true);assert.deepEqual(f.rows.values().next().value,prior);
 await assert.rejects(f.client.create({...command,idempotency_key:'corporate_ui_next_0002'}),{code:'CAMPAIGN_BFF_PENDING'});assert.equal(f.calls.length,3);
});

test('compiled editor hides and disables new/create while OFF and keeps legacy/ON new-draft navigation',async()=>{
 for(const flag of [false,true,undefined]){
  const {document,window}=parseHTML(fs.readFileSync(path.join(__dirname,'../services/dashboard-operational/public/entry.html'),'utf8'));
  const dialog=document.getElementById('entry-campaign-dialog');dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;};window.HTMLElement.prototype.focus=function(){};
  for(const select of document.querySelectorAll('select'))Object.defineProperty(select,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},set(value){for(const o of this.querySelectorAll('option'))o.toggleAttribute('selected',o.value===String(value));}});
  const values=new Map(),calls=[],state=session(flag),controller=createCampaignEditor({document,getSession:()=>state,createClient:createCampaignBffClient,storage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},locks:{request:async(name,options,fn)=>fn({name})},request:async q=>{calls.push(q);assert.equal(q.method,'GET');const u=new URL(q.path,'https://synthetic.invalid');return{status:200,body:u.searchParams.get('acao')==='campanha_catalogo'?{brand:'fish',current:true,lists:[],templates:[]}:{campaigns:[]}};}});
  assert.equal(await controller.open(),true);const button=document.getElementById('campaign-new'),create=document.getElementById('campaign-create');assert.equal(button.hidden,flag===false);assert.equal(button.disabled,flag===false);assert.equal(create.hidden,true);
  button.click();assert.equal(create.hidden,flag===false);assert.equal(calls.some(v=>v.method==='POST'),false);assert.equal(values.size,0);if(flag===false)assert.match(document.getElementById('campaign-status').textContent,/criação.*indisponível/);controller.close();
 }
});
