'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const B=require('./build-preflight.cjs'),O=require('./observe.cjs');
const runtimeRoot=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../runtime');
const plan=B.buildPreflight({suffix:'012345abcdef',runtimeRoot}),meta={...plan};delete meta.json;
function row(role='installer'){const init=role==='prepare_volume';return{id:'1'.repeat(64),project:meta.composeProjectName,service:role,image:O.IMAGE,state:init?'exited':'running',exitCode:0,oomKilled:false,health:init?'none':'healthy',memory:init?67108864:268435456,memorySwap:init?67108864:268435456,nanoCpus:init?100000000:250000000,pidsLimit:init?16:32,readOnly:true,capDrop:['ALL'],capAdd:init?['CHOWN']:null,securityOpt:['no-new-privileges'],networkMode:'none',user:init?'0:0':'1000:1000',init:true,proofVolume:meta.volumeName,portBindingsCount:0,mountCount:1,tmpfsCount:init?0:1,reviewTmpfsConfigured:!init};}
test('normalized Compose and closed Docker evidence prove only resources and health',()=>{const c=JSON.parse(plan.json);c.name=meta.composeProjectName;assert.equal(O.verifyConfig(c,meta,JSON.parse(plan.json)),true);assert.equal(O.inspect(row(),meta,'installer'),'ready');assert.equal(O.inspect(row('prepare_volume'),meta,'prepare_volume'),'ready');assert.equal(O.verifyVolume({name:meta.volumeName,purpose:'crm-manager-native-preflight',exclusive:meta.composeProjectName,project:meta.composeProjectName},meta),true);});
test('closed observer rejects secrets/extra fields, wrong ownership and any resource weakening',()=>{for(const change of [v=>v.env='RAW_CANARY',v=>v.id='x',v=>v.project='foreign',v=>v.memory=536870912,v=>v.memorySwap=-1,v=>v.pidsLimit=0,v=>v.capAdd=['DAC_OVERRIDE'],v=>v.networkMode='bridge',v=>v.proofVolume='foreign',v=>v.mountCount=3]){const r=row();change(r);assert.throws(()=>O.inspect(r,meta,'installer'),e=>e.message==='NATIVE_PREFLIGHT_OBSERVATION_REFUSED');}const c=JSON.parse(plan.json);c.name=meta.composeProjectName;c.services.installer.environment.PGPASSWORD='RAW_CANARY';assert.throws(()=>O.verifyConfig(c,meta,JSON.parse(plan.json)));});
test('failed or incomplete runtime cannot become positive proof; parsing stays bounded and generic',()=>{for(const r of [{...row(),state:'exited'},{...row(),oomKilled:true},{...row(),health:'unhealthy'}])assert.equal(O.inspect(r,meta,'installer'),'failed');assert.equal(O.inspect({...row(),health:'starting'},meta,'installer'),'waiting');assert.throws(()=>O.parse('x'.repeat(524289)),e=>e.message==='NATIVE_PREFLIGHT_OBSERVATION_REFUSED');assert.throws(()=>O.parse('{"password":"RAW_CANARY"'),e=>!e.message.includes('CANARY'));});

test('normalized environment key order is irrelevant; exact key set and values remain mandatory',()=>{
 const original=JSON.parse(plan.json),c=JSON.parse(plan.json);c.name=meta.composeProjectName;
 const expected=original.services.installer.environment;assert.deepEqual(Object.keys(expected),['NODE_PATH','NODE_OPTIONS']);
 c.services.installer.environment={NODE_OPTIONS:expected.NODE_OPTIONS,NODE_PATH:expected.NODE_PATH};
 assert.equal(O.verifyConfig(c,meta,original),true);
 for(const change of [e=>{e.PGPASSWORD='SYNTHETIC_RAW_CANARY';},e=>{e.NODE_PATH='/foreign';},e=>{e.NODE_OPTIONS='--max-old-space-size=512';},e=>{delete e.NODE_PATH;}]){
  const bad=JSON.parse(JSON.stringify(c));change(bad.services.installer.environment);
  assert.throws(()=>O.verifyConfig(bad,meta,original),e=>e.message==='NATIVE_PREFLIGHT_OBSERVATION_REFUSED');
 }
});

test('native Mounts and HostConfig.Tmpfs are separate exact projections; old two-mount fixture is refused',()=>{
 assert.equal(Object.keys(row()).length,24);assert.equal(O.inspect(row(),meta,'installer'),'ready');
 assert.equal(O.inspect(row('prepare_volume'),meta,'prepare_volume'),'ready');
 for(const change of [v=>{v.mountCount=2;},v=>{v.tmpfsCount=0;},v=>{v.tmpfsCount=2;},v=>{v.reviewTmpfsConfigured=false;},v=>{delete v.tmpfsCount;},v=>{delete v.reviewTmpfsConfigured;},v=>{v.reviewTmpfsConfigured='true';},v=>{v.tmpfsCount='1';},v=>{v.tmpfsPaths=['/foreign'];}]){
  const v=row();change(v);assert.throws(()=>O.inspect(v,meta,'installer'),e=>e.message==='NATIVE_PREFLIGHT_OBSERVATION_REFUSED');
 }
 for(const change of [v=>{v.tmpfsCount=1;},v=>{v.reviewTmpfsConfigured=true;},v=>{v.mountCount=2;}]){
  const v=row('prepare_volume');change(v);assert.throws(()=>O.inspect(v,meta,'prepare_volume'),e=>e.message==='NATIVE_PREFLIGHT_OBSERVATION_REFUSED');
 }
});
