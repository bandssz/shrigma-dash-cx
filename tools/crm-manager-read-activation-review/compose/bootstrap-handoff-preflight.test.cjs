'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),vm=require('node:vm');
const H=require('./bootstrap-handoff-preflight.cjs'),C=require('./build-compose.cjs'),P=require('./oci-preflight.cjs'),R=require('../../crm-manager-read-credential-custody/remote-operator.cjs'),G=require('../../crm-manager-read-credential-custody/public-postcondition.cjs');
const rawInput=()=>({suffix:'0123456789ab',sources:H.sources(),intent:{schema:'crm-manager-read-runtime-intent-v1',operationId:crypto.randomUUID(),credentialIntentId:crypto.randomUUID(),action:'stage',fromPhase:'empty'},domainId:crypto.randomUUID()});const input=()=>({remotePlan:R.buildStagePlan(rawInput())});
test('split derives exact approved public bootstrap and gateway-only external handoff from real MCP request builder',()=>{
 const h=H.buildHandoff(input()),p=h.plan;assert.deepEqual(Object.keys(h.bootstrap.services),['init-volumes']);assert.equal(h.bootstrap.networks,undefined);assert.deepEqual(h.bootstrap.services['init-volumes'],p.compose.services['init-volumes']);assert.deepEqual(h.bootstrap.volumes,p.compose.volumes);assert.equal(h.easypanel.createPublicBootstrap.input.env,'');assert.deepEqual(h.easypanel.createPublicBootstrap.input.domains,[]);
 assert.deepEqual(Object.keys(h.execution.services),['gateway']);for(const k of ['source','ledger'])assert.deepEqual(h.execution.volumes[k],{external:true,name:p.compose.volumes[k].name});assert.equal(h.execution.services.gateway.depends_on,undefined);assert.equal(h.execution.services.gateway.user,'1000:1000');assert.equal(h.execution.services.gateway.volumes.find(x=>x.target==='/review').read_only,true);assert.deepEqual(Object.keys(p.sourcePins).length,9);
});
test('CI changes only declared probe command/env/network/health and retains resource, mounts, caps, labels; stage probe cannot execute runtime or connect PG',()=>{
 const h=H.buildHandoff(input()),original=structuredClone(h.plan.compose.services.gateway),actual=structuredClone(h.execution.services.gateway);for(const v of[original,actual])for(const k of['entrypoint','command','env_file','networks','network_mode','healthcheck','depends_on'])delete v[k];assert.deepEqual(actual,original);
 const g=h.execution.services.gateway;assert.equal(g.network_mode,'none');assert.equal(g.env_file,undefined);assert.equal(h.execution.networks,undefined);assert.deepEqual(g.healthcheck,{disable:true});assert.deepEqual(g.entrypoint,['timeout','-s','KILL','600']);new vm.Script(g.command[3]);assert.doesNotMatch(g.command[3],/require\(['"](?:pg|net|tls|https|child_process)/);assert.deepEqual(g.command,G.buildPublicPostcondition({remotePlan:h.remotePlan}).command);
});
test('source and original empty-stage intent mutations refuse before any Docker dispatch',()=>{
 const a=rawInput();a.sources['runtime.cjs']+='corrupt';assert.throws(()=>H.buildHandoff({remotePlan:R.buildStagePlan(a)}));
 for(const change of[{action:'activate'},{fromPhase:'staged'},{credentialIntentId:'arbitrary'}, {operationId:'arbitrary'}]){const i=rawInput();Object.assign(i.intent,change);assert.throws(()=>H.buildHandoff({remotePlan:R.buildStagePlan(i)}));}
});
test('own-ID inventory accepts exact zero/single own object and refuses multiple, wrong-ID or oversized inventory; missing OCI opt-in is closed',()=>{
 assert.equal(H.listed('','a'.repeat(64)),false);assert.equal(H.listed('a'.repeat(64),'a'.repeat(64)),true);
 for(const raw of['b'.repeat(64),'a'.repeat(64)+'\n'+'a'.repeat(64),'x'.repeat(129)])assert.throws(()=>H.listed(raw,'a'.repeat(64)),/READ_BOOTSTRAP_HANDOFF_REFUSED/);assert.throws(H.runOci,/READ_BOOTSTRAP_HANDOFF_REFUSED/);
});
