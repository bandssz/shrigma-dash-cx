'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../services/dashboard-operational/public/entry.js'),'utf8');
function element(){return {children:[],textContent:'',disabled:false,hidden:false,listeners:{},append(...children){this.children.push(...children);},setAttribute(){},addEventListener(name,handler){this.listeners[name]=handler;}};}
const text=node=>[node.textContent,...node.children.map(text)].filter(Boolean).join(' | ');
const manager={id:'synthetic-id',email:'manager@synthetic.invalid',role:'manager',status:'active',brand:'fish',brands:['fish'],brandAccess:'single',areas:['growth'],permissions:{growth:{read:true,edit:true}},requestedAccess:'edit',crmAccess:{state:'ready',ready:true,canRenew:true,expired:false,renewalPhase:null},crmWriter:{state:'ready',canApprove:true,canRenew:true}};
const unavailable={available:false,reason:'BRAND_TEMPLATE_OWNERSHIP_NOT_READY'};
function rows(){
 const start=source.indexOf(' function crmAccessLabel('),end=source.indexOf(' async function saveAccessRequest(');assert.ok(start>=0&&end>start);
 const context={document:{createElement:element},AREAS:{growth:{label:'CRM'},organico:{label:'Orgânico'},influs:{label:'Influs'}},saveAccessRequest(){},revoke(){}};
 vm.runInNewContext(source.slice(start,end)+'\nglobalThis.renderUser=userRow;',context);
 return user=>context.renderUser(user);
}

test('physical WRITER ready does not advertise or offer content write when the BFF ownership contract is unavailable',()=>{
 const render=rows();
 for(const brand of ['fish','aristo']){
  const result=text(render({...manager,brand,brands:[brand],campaignContentAccess:unavailable}));
  assert.match(result,/Conteúdo em leitura · criação, edição e agendamento aguardam validação/);
  assert.doesNotMatch(result,/Edição de campanhas ativa|Edição ativa|Aprovar edição|Renovar edição/);
  assert.match(result,/Renovar acesso CRM/);assert.match(result,/CRM pronto/);assert.match(result,/Nível solicitado/);assert.match(result,/Revogar acesso/);
 }
});

test('a requested content edit stays pending without publishing provider details or changing reader readiness',()=>{
 const render=rows();
 for(const state of ['requested','provisioning','ready','renewing']){
  const result=text(render({...manager,permissions:{growth:{read:true,edit:false}},crmWriter:{...manager.crmWriter,state},campaignContentAccess:{available:false,reason:'private-canary'}}));
  assert.match(result,/criação, edição e agendamento aguardam validação/);
  assert.doesNotMatch(result,/private-canary|Edição de campanhas ativa|Aprovar edição|Renovar edição/);
  assert.match(result,/Renovar acesso CRM/);assert.match(result,/CRM pronto/);
 }
});

test('isolated legacy DTO absent or explicitly admitted retains existing writer approval and renewal controls',()=>{
 const render=rows();
 for(const campaignContentAccess of [undefined,{available:true}]){
  const result=text(render({...manager,...(campaignContentAccess?{campaignContentAccess}:{})}));
  assert.match(result,/Edição de campanhas ativa/);assert.match(result,/Aprovar edição de campanhas/);assert.match(result,/Renovar edição de campanhas/);assert.match(result,/Renovar acesso CRM/);
  assert.doesNotMatch(result,/criação, edição e agendamento aguardam validação/);
 }
});

test('the content restriction belongs only to the CRM manager and does not classify master as pending',()=>{
 const render=rows(),master={...manager,role:'superadmin',brand:null,brands:['fish','aristo'],brandAccess:'all',areas:['growth','organico','influs'],permissions:{growth:{read:true,edit:false},organico:{read:true,edit:false},influs:{read:true,edit:false}},campaignContentAccess:unavailable};
 const result=text(render(master));assert.match(result,/Todas as marcas/);assert.doesNotMatch(result,/criação, edição e agendamento aguardam validação|Aprovar edição|Renovar edição|Renovar acesso CRM/);
 const other=text(render({...manager,areas:['organico'],permissions:{organico:{read:true,edit:false}},campaignContentAccess:unavailable}));
 assert.doesNotMatch(other,/criação, edição e agendamento aguardam validação/);
});

test('forged approval/renew handler calls cannot POST when content metadata is closed, while legacy admission still works',async()=>{
 for(const [name,startMarker,endMarker,action] of [
  ['approveCampaignWriter',' async function approveCampaignWriter(',' async function renewCampaignWriter(','crm_writer_approve'],
  ['renewCampaignWriter',' async function renewCampaignWriter(',' async function renewCrm(','crm_writer_renew']
 ]){
  const start=source.indexOf(startMarker),end=source.indexOf(endMarker,start);assert.ok(start>=0&&end>start);
  for(const available of [false,true,undefined]){
   let calls=0,loads=0;const context={busy:false,session:{user:{role:'superadmin'}},requested:'todos',adminMessage:{textContent:''},loadUsers:async()=>{loads++;},post:async(url,body)=>{calls++;assert.equal(url,'/auth/users');assert.equal(JSON.stringify(body),JSON.stringify({action,userId:manager.id}));return {response:{ok:true,status:202},data:{state:'provisioning'}};}};
   vm.runInNewContext(source.slice(start,end)+`\nglobalThis.invoke=${name};`,context);
   const button={disabled:false},user={...manager,...(available===undefined?{}:{campaignContentAccess:{available,reason:'private-canary'}})};
   await context.invoke(user,button);
   assert.equal(calls,available===false?0:1);assert.equal(loads,calls);assert.equal(button.disabled,false);assert.doesNotMatch(context.adminMessage.textContent,/private-canary|Edição de campanhas ativa/);
  }
 }
});

test('READ renewal and pending access reconciliation remain available under the separate content gate',async()=>{
 const start=source.indexOf(' async function loadUsers('),end=source.indexOf(" $('admin-crm-reconcile').addEventListener(",start);assert.ok(start>=0&&end>start);
 for(const [crmAccess,crmWriter,hidden] of [
  [{...manager.crmAccess},{...manager.crmWriter},true],
  [{...manager.crmAccess,ready:false},{...manager.crmWriter},false],
  [{...manager.crmAccess,state:'provisioning',ready:false},{...manager.crmWriter},false],
  [{...manager.crmAccess},{...manager.crmWriter,state:'provisioning'},false],
  [{...manager.crmAccess,renewalPhase:'prepare_uncertain'},{...manager.crmWriter},false]
 ]){
  const button={hidden:null},list={replaceChildren(){}},context={$:id=>id==='admin-crm-reconcile'?button:list,request:async()=>({response:{ok:true},data:{users:[{...manager,crmAccess,crmWriter,campaignContentAccess:unavailable}]}}),userRow:()=>({})};
  vm.runInNewContext(source.slice(start,end)+'\nglobalThis.refresh=loadUsers;',context);await context.refresh();assert.equal(button.hidden,hidden);
 }
 const renewStart=source.indexOf(' async function renewCrm('),renewEnd=source.indexOf(' async function saveAccessRequest(',renewStart);
 let calls=0;const context={busy:false,session:{user:{role:'superadmin'}},requested:'todos',adminMessage:{textContent:''},loadUsers:async()=>{},post:async(url,body)=>{calls++;assert.equal(url,'/auth/users');assert.equal(JSON.stringify(body),JSON.stringify({action:'crm_renew',userId:manager.id}));return {response:{ok:true,status:202},data:{}};}};
 vm.runInNewContext(source.slice(renewStart,renewEnd)+'\nglobalThis.invoke=renewCrm;',context);
 await context.invoke({...manager,campaignContentAccess:unavailable},{disabled:false});assert.equal(calls,1);assert.match(context.adminMessage.textContent,/Renovação solicitada para leitura/);
});
