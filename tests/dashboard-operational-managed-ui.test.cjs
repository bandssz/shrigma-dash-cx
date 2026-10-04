'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../services/dashboard-operational/public/entry.js'),'utf8');
function element(){return {children:[],textContent:'',append(...children){this.children.push(...children);},setAttribute(){},addEventListener(){}};}
const text=node=>[node.textContent,...node.children.map(text)].filter(Boolean).join(' | ');
const manager={id:'synthetic-id',email:'manager@synthetic.invalid',role:'manager',status:'active',areas:['growth'],permissions:{growth:{read:true,edit:false}},requestedAccess:'read'};
test('manager list displays readiness and pending revocation without exposing private fields or changing legacy rows',()=>{
 const start=source.indexOf(' function crmAccessLabel('),end=source.indexOf(' async function saveAccessRequest(');assert.ok(start>=0&&end>start);
 const context={document:{createElement:element},AREAS:{growth:{label:'CRM'},organico:{label:'Orgânico'}},saveAccessRequest(){},revoke(){}};
 vm.runInNewContext(source.slice(start,end)+'\nglobalThis.renderUser=userRow;',context);
 const render=user=>text(context.renderUser(user));
 for(const [state,ready,label] of [['awaiting_accept',false,'CRM aguarda aceite'],['provisioning',false,'CRM preparando acesso'],['ready',true,'CRM pronto'],['ready',false,'CRM acesso pendente'],['revoking',false,'CRM revogação pendente'],['revoked',false,'CRM revogado'],['failed',false,'CRM indisponível']]){
  const result=render({...manager,crmAccess:{state,ready,namespaceId:'private-namespace',principalId:'private-principal',bearer:'private-bearer',generation:3}});
  assert.ok(result.includes(label));assert.doesNotMatch(result,/private-namespace|private-principal|private-bearer/);
 }
 assert.equal(render(manager),'manager@synthetic.invalid | CRM · Somente leitura · Ativo | Nível solicitado | Somente leitura | Edição geral do painel (pendente) | Salvar | Revogar acesso');
 for(const user of [{...manager,role:'superadmin'},{...manager,areas:['organico']},{...manager,areas:['growth','organico']}])assert.doesNotMatch(render({...user,crmAccess:{state:'ready',ready:true}}),/CRM pronto/);
  assert.doesNotMatch(render({...manager,crmAccess:{state:'private-unrecognized-error'}}),/private-unrecognized/);
 for(const state of ['__proto__','constructor','toString'])assert.doesNotMatch(render({...manager,crmAccess:{state}}),/\[object Object\]|function/);
});
test('revocation reports the backend acknowledgement and does not declare a pending CRM revocation complete',async()=>{
 const start=source.indexOf(' async function revoke('),end=source.indexOf(" $('admin-copy').addEventListener(");assert.ok(start>=0&&end>start);
 for(const [data,expected] of [[{crmRevocationPending:true},'A confirmação da revogação no CRM está pendente.'],[{crmRevocationPending:false},'Acesso ao portal e ao CRM revogado.'],[{},'Revogue também a chave individual no serviço de origem']]){
  let confirmation='',calls=0;const context={session:{user:{role:'superadmin'}},requested:'todos',window:{confirm(value){confirmation=value;return true;}},post:async(url,body)=>{assert.equal(url,'/auth/users');assert.equal(body.action,'revoke');calls++;return {response:{ok:true},data};},loadUsers:async()=>{},inviteResult:{hidden:false},inviteLink:{value:'synthetic-invite'},adminMessage:{textContent:''}};
  vm.runInNewContext(source.slice(start,end)+'\nglobalThis.revokeUser=revoke;',context);
  const button={disabled:false};await context.revokeUser({...manager,crmAccess:{state:'ready',ready:true}},button);
  assert.equal(calls,1);assert.ok(context.adminMessage.textContent.includes(expected));assert.match(confirmation,/confirmada antes de um novo convite/);assert.equal(context.inviteLink.value,'');assert.equal(context.inviteResult.hidden,true);assert.equal(button.disabled,false);
 }
});
test('pending-access action is restricted to the manager view and requests reconciliation without private inputs',async()=>{
 const start=source.indexOf(" $('admin-crm-reconcile').addEventListener("),end=source.indexOf(' manage.addEventListener(',start);assert.ok(start>=0&&end>start);
 for(const [role,requested,ok,expectedCalls] of [['superadmin','todos',true,1],['superadmin','todos',false,1],['manager','todos',true,0],['superadmin','growth',true,0]]){
  let click,calls=0,loads=0;const button={disabled:false,addEventListener(name,handler){assert.equal(name,'click');click=handler;}},context={busy:false,session:{user:{role}},requested,$:id=>{assert.equal(id,'admin-crm-reconcile');return button;},adminMessage:{textContent:''},loadUsers:async()=>{loads++;},post:async(url,body)=>{calls++;assert.equal(url,'/auth/users');assert.deepEqual(Object.keys(body),['action']);assert.equal(body.action,'crm_reconcile');return {response:{ok},data:{privateError:'private-canary'}};}};
  vm.runInNewContext(source.slice(start,end),context);await click();assert.equal(calls,expectedCalls);assert.equal(button.disabled,false);assert.doesNotMatch(context.adminMessage.textContent,/private-canary|CRM pronto|concluíd/i);
  assert.equal(loads,expectedCalls&&ok?1:0);
 }
});
test('pending list includes an uncertain renewal without exposing managed state on legacy users',async()=>{
 const start=source.indexOf(' async function loadUsers('),end=source.indexOf(" $('admin-crm-reconcile').addEventListener(",start);assert.ok(start>=0&&end>start);
 for(const [user,expectedHidden] of [[manager,true],[{...manager,crmAccess:{state:'ready',ready:true}},true],[{...manager,crmAccess:{state:'ready',ready:false}},false],[{...manager,crmAccess:{state:'ready',ready:true,renewalPhase:'prepare_uncertain'}},false],[{...manager,crmAccess:{state:'ready',ready:false,expired:true,renewalPhase:'commit_uncertain'}},false],[{...manager,crmAccess:{state:'provisioning',ready:false}},false],[{...manager,crmAccess:{state:'revoking',ready:false}},false],[{...manager,role:'superadmin',crmAccess:{state:'ready',ready:false}},true]]){
  const button={hidden:null},list={replaceChildren(){}},context={$:id=>id==='admin-crm-reconcile'?button:list,request:async()=>({response:{ok:true},data:{users:[user]}}),userRow:()=>({})};
  vm.runInNewContext(source.slice(start,end)+'\nglobalThis.refresh=loadUsers;',context);await context.refresh();assert.equal(button.hidden,expectedHidden);
 }
});
test('manual renewal is offered only for the eligible active CRM manager and reports persisted renewal phases',()=>{
 const start=source.indexOf(' function crmAccessLabel('),end=source.indexOf(' async function saveAccessRequest(');assert.ok(start>=0&&end>start);
 const context={document:{createElement:element},AREAS:{growth:{label:'CRM'},organico:{label:'Orgânico'}},saveAccessRequest(){},revoke(){}};vm.runInNewContext(source.slice(start,end)+'\nglobalThis.renderUser=userRow;',context);
 const access={state:'ready',ready:true,canRenew:true,expired:false,renewalPhase:null},eligible={...manager,crmAccess:access};
 assert.match(text(context.renderUser(eligible)),/Renovar acesso CRM/);
 for(const user of [{...eligible,role:'superadmin'},{...eligible,status:'invited'},{...eligible,status:'disabled'},{...eligible,areas:['organico']},{...eligible,areas:['growth','organico']},{...eligible,permissions:{growth:{read:true,edit:true}}},...['ready','canRenew'].map(key=>({...eligible,crmAccess:{...access,[key]:false}})),{...eligible,crmAccess:{...access,expired:true}},{...eligible,crmAccess:{...access,renewalPhase:'queued'}}])assert.doesNotMatch(text(context.renderUser(user)),/Renovar acesso CRM/);
 for(const [phase,label] of [['queued','renovação solicitada'],['prepare_uncertain','renovação aguardando confirmação'],['prepared','renovação em validação'],['attested','renovação em confirmação'],['commit_uncertain','renovação aguardando confirmação'],['committed','renovação finalizando']]){
  const result=text(context.renderUser({...eligible,crmAccess:{...access,canRenew:false,renewalPhase:phase}}));assert.ok(result.includes(label));assert.doesNotMatch(result,/Renovar acesso CRM/);
 }
 const expired=text(context.renderUser({...eligible,crmAccess:{...access,canRenew:false,ready:false,expired:true,renewalPhase:'commit_uncertain'}}));assert.match(expired,/CRM acesso expirado · renovação aguardando confirmação/);
 assert.doesNotMatch(text(context.renderUser({...eligible,crmAccess:{...access,renewalPhase:'private-canary'}})),/private-canary/);
});
test('manual renewal sends one closed request, refreshes uncertain outcomes and never announces readiness from 202',async()=>{
 const start=source.indexOf(' async function renewCrm('),end=source.indexOf(' async function saveAccessRequest(',start);assert.ok(start>=0&&end>start);
 for(const result of [{response:{ok:true,status:202},data:{ok:true}},{response:{ok:false,status:409},data:{error:'CRM_RENEWAL_PENDING'}},{response:{ok:false,status:409},data:{error:'CRM_ACCESS_EXPIRED',raw:'private-canary'}},null]){
  let calls=0,loads=0;const context={busy:false,session:{user:{role:'superadmin'}},requested:'todos',adminMessage:{textContent:''},loadUsers:async()=>{loads++;},post:async(url,body)=>{calls++;assert.equal(url,'/auth/users');assert.deepEqual(Object.keys(body),['action','userId']);assert.equal(body.action,'crm_renew');assert.equal(body.userId,manager.id);if(!result)throw Error('private-canary');return result;}};
  vm.runInNewContext(source.slice(start,end)+'\nglobalThis.renew=renewCrm;',context);const button={disabled:false};await context.renew({...manager,crmAccess:{canRenew:true}},button);
  assert.equal(calls,1);assert.equal(loads,1);assert.equal(button.disabled,false);assert.doesNotMatch(context.adminMessage.textContent,/private-canary|CRM pronto|concluíd|renovado/i);
  assert.match(context.adminMessage.textContent,result?.response.ok?/Renovação solicitada/:result?.data.error==='CRM_RENEWAL_PENDING'?/Já há uma renovação pendente/:/Não foi possível confirmar/);
 }
 for(const override of [{busy:true},{session:{user:{role:'manager'}}},{requested:'growth'}]){
  let calls=0;const context={busy:false,session:{user:{role:'superadmin'}},requested:'todos',...override,post:async()=>{calls++;}};vm.runInNewContext(source.slice(start,end)+'\nglobalThis.renew=renewCrm;',context);await context.renew({...manager,crmAccess:{canRenew:true}},{disabled:false});assert.equal(calls,0);
 }
});
