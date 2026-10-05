'use strict';
// Apoio dos testes do listener services/crm-template-read: liga a ponte real do
// portal (crm-template-read-bridge.cjs) ao listener local. A ponte continua com
// o destino fixo; só o transporte é desviado para 127.0.0.1. Auth sintética.
const assert=require('node:assert/strict'),X=require('./claude-template-read-fixture.cjs');
const B=require('../services/dashboard-operational/crm-template-read-bridge.cjs');
const EXPIRES=Date.now()+86400000,NOW=()=>Date.now(),HOST='dashboard-v24-crm.tazdb8.easypanel.host';
const identities=Object.freeze({
 fish:Object.freeze({userId:'11111111-1111-4111-8111-111111111111',owner:'gestor@oaristocrata.com',lifecycleId:'22222222-2222-4222-8222-222222222222',principalId:X.PRINCIPAL,credential:X.KEY,credentialMac:'d'.repeat(64)}),
 aristo:Object.freeze({userId:'33333333-3333-4333-8333-333333333333',owner:'gestor-aristo@oaristocrata.com',lifecycleId:'44444444-4444-4444-8444-444444444444',principalId:X.ARISTO_PRINCIPAL,credential:X.ARISTO_KEY,credentialMac:'e'.repeat(64)})
});
const proof=brand=>{assert.ok(Object.hasOwn(identities,brand),'marca sintética explícita');const {credential,...identity}=identities[brand];return {...identity,lifecycleVersion:1,generation:1,expiresAt:EXPIRES,slot:'crm-panel-read',caps:['read_content','list_history','submission']};};
function chain(port,credential,brand){
 assert.ok(Object.hasOwn(identities,brand),'marca sintética explícita');
 assert.equal(credential,identities[brand].credential,'credencial própria da identidade sintética');
 const calls=[],authCalls={proof:0,credential:0};
 const authorize=ctx=>{assert.equal(ctx.method,'GET');assert.equal(ctx.area,'growth');assert.equal(ctx.edit,false);assert.equal(ctx.brand,brand);return identities[brand];};
 const fetchImpl=async(url,init)=>{
  const target=new URL(String(url));if(target.href.split('?')[0]!==B.DESTINATIONS['template-read'])throw Error('destino inesperado');
  calls.push(target.search);
  const r=await fetch(`http://127.0.0.1:${port}/template-read${target.search}`,{method:init.method,headers:init.headers,redirect:'manual',signal:init.signal});
  return {status:r.status,redirected:false,url:'',type:'basic',headers:r.headers,body:r.body};
 };
 const bridge=B.createTemplateReadBridge({auth:{managedCrmReadAuthorization(ctx){authorize(ctx);authCalls.proof++;return proof(brand);},getUpstreamCredential(ctx){authorize(ctx);assert.equal(ctx.slot,'crm-panel-read');authCalls.credential++;return credential;}},upstreams:{'template-read':new URL(B.DESTINATIONS['template-read'])},enabled:true},{fetchImpl,now:NOW});
 const read=query=>bridge.read({context:{method:'GET',host:HOST,brand},route:'templates',method:'GET',query:new URLSearchParams(query),origin:'https://'+HOST});
 return {read,calls,authCalls};
}
// GET direto ao listener (sem ponte), para provar o que ele mesmo recusa.
async function get(port,search,headers={}){const r=await fetch(`http://127.0.0.1:${port}/template-read${search}`,{headers});return {status:r.status,text:await r.text()};}
module.exports={chain,get,proof};
