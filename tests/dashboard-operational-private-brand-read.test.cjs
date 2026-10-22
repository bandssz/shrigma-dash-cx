'use strict';
// Only injected synthetic auth and fetch. No credentials, sockets or database.
const test=require('node:test'),assert=require('node:assert/strict');
const B=require('../services/dashboard-operational/crm-manager-read-bridge.cjs');
const A=require('../services/dashboard-operational/crm-audience-read-bridge.cjs');
const T=require('../services/dashboard-operational/crm-template-read-bridge.cjs');
const host='crm.synthetic.invalid';
for(const [name,module,route,action,brandField] of [['campaign',B,'campaigns','campanha_catalogo','brand'],['audience',A,'segments','publicos_listas','brand'],['template',T,'templates','listar','marca']]){
 test(name+': a private context cannot select a foreign or missing brand before authorization and transport',async()=>{
  let proofs=0,credentials=0,fetches=0;
  const auth={managedCrmReadAuthorization(){proofs++;throw Error('Synthetic authorization should not run');},getUpstreamCredential(){credentials++;throw Error('Synthetic credential should not run');}};
  const upstreams=Object.fromEntries(Object.entries(module.DESTINATIONS).map(([k,v])=>[k,new URL(v)]));
  const bridge=(module.createManagedReadBridge||module.createAudienceReadBridge||module.createTemplateReadBridge)({auth,upstreams,enabled:true},{fetchImpl:async()=>{fetches++;throw Error('Synthetic transport should not run');}});
  for(const brand of ['fish',undefined]){
   const context={host,method:'GET',...(brand?{brand}:{})};
   await assert.rejects(bridge.read({context,route,method:'GET',query:new URLSearchParams({acao:action,[brandField]:'aristo'}),origin:'https://'+host}),e=>e.status===403);
  }
  assert.deepEqual({proofs,credentials,fetches},{proofs:0,credentials:0,fetches:0});
  // A context getter must not choose one query brand and another auth brand.
  // The subject grants Fish; the copied ctx has to be the checked ctx.
  const proof={userId:'11111111-1111-4111-8111-111111111111',owner:'fish@synthetic.invalid',lifecycleId:'22222222-2222-4222-8222-222222222222',lifecycleVersion:1,principalId:'dcrm-'+'a'.repeat(32),generation:1,expiresAt:Date.now()+86400000,credentialMac:'b'.repeat(64),slot:'crm-panel-read',caps:['read_content','list_history','submission']};
  const subjectAuth={managedCrmReadAuthorization(ctx){if(ctx.brand!=='fish')throw Error('Synthetic subject grants only Fish');return proof;},getUpstreamCredential(ctx){if(ctx.brand!=='fish')throw Error('Synthetic subject grants only Fish');return 'a'.repeat(64);}};
  const subjectBridge=(module.createManagedReadBridge||module.createAudienceReadBridge||module.createTemplateReadBridge)({auth:subjectAuth,upstreams,enabled:true},{fetchImpl:async()=>{fetches++;throw Error('Synthetic foreign transport');}});
  let reads=0;const switching={host,method:'GET'};Object.defineProperty(switching,'brand',{enumerable:true,get:()=>reads++===0?'aristo':'fish'});
  await assert.rejects(subjectBridge.read({context:switching,route,method:'GET',query:new URLSearchParams({acao:action,[brandField]:'aristo'}),origin:'https://'+host}),e=>e.status===503);
  assert.equal(reads,1);assert.equal(fetches,0);
 });
}
