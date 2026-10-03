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
