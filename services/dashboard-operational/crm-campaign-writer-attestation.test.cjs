'use strict';
// Synthetic responses only. No HTTP socket, real environment or credential.
const test=require('node:test'),assert=require('node:assert/strict');
const A=require('./crm-campaign-writer-attestation.cjs');
const BEARER='a'.repeat(64),OWNER="o'reilly+crm@example.test",PRINCIPAL='dcrmw-'+'b'.repeat(32);
const CAPS=['read_content','draft','validate','submit'];
const input=()=>({bearer:BEARER,owner:OWNER,principalId:PRINCIPAL});
const identity=()=>({schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',owner:OWNER,allowedPanels:['growth'],permissions:{growth:{who:'panel:'+PRINCIPAL,label:OWNER,caps:[...CAPS]},influs:null}});
function response(value,{raw,status=200,url=A.IDENTITY_URL,redirected=false,type='basic',headers={},chunks,read,cancel}={}){
 const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(raw===undefined?JSON.stringify(value):raw);
 const blocks=chunks||[bytes];let position=0;const stats={reads:0,cancels:0,releases:0};
 const reader={read:async()=>{stats.reads++;return read?read():position<blocks.length?{done:false,value:blocks[position++]}:{done:true,value:undefined};},cancel:()=>{stats.cancels++;return cancel?cancel():Promise.resolve();},releaseLock:()=>stats.releases++};
 return {status,ok:status>=200&&status<300,url,redirected,type,headers:new Headers({'content-type':'application/json; charset=utf-8',...headers}),body:{getReader:()=>reader,cancel:()=>reader.cancel()},stats};
}
const refused=error=>{
 assert.ok(error instanceof A.CampaignWriterAttestationError);assert.equal(error.code,'CAMPAIGN_WRITER_ATTESTATION_REFUSED');assert.equal(error.message,'CAMPAIGN_WRITER_ATTESTATION_REFUSED');
 for(const privateValue of [BEARER,OWNER,PRINCIPAL,'RAW_ERROR_SENTINEL','RAW_BODY_SENTINEL'])assert.ok(!JSON.stringify(error).includes(privateValue));
 assert.equal(Object.hasOwn(error,'cause'),false);assert.equal(Object.hasOwn(error,'body'),false);return true;
};
test('import is dormant and exports only its explicit private proof API',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),module={exports:{}};
 const context={module,exports:module.exports,require:name=>{assert.equal(name,'node:perf_hooks');return require(name);},Uint8Array,Object,Error,Set};
 for(const key of ['fetch','process','setTimeout','AbortController'])Object.defineProperty(context,key,{get(){throw Error('IMPORT_SIDE_EFFECT');}});
 vm.runInNewContext(fs.readFileSync(require.resolve('./crm-campaign-writer-attestation.cjs'),'utf8'),context);
 assert.deepEqual(Object.keys(module.exports).sort(),['CampaignWriterAttestationError','IDENTITY_URL','MAX_RESPONSE_BYTES','TIMEOUT_MS','verifyCampaignWriterCredential']);
 assert.equal(module.exports.IDENTITY_URL,'https://comunicacao-crm-panel-read.tazdb8.easypanel.host/read?action=identity&painel=growth');
 assert.equal(module.exports.MAX_RESPONSE_BYTES,8192);assert.equal(module.exports.TIMEOUT_MS,5000);
});
test('exact private identity returns only frozen expected owner/principal/writer caps from fixed GET',async()=>{
 let calls=0,options;const r=response(identity());const proof=await A.verifyCampaignWriterCredential(input(),{fetchImpl:async(url,opts)=>{calls++;assert.equal(url,A.IDENTITY_URL);options=opts;return r;}});
 assert.equal(calls,1);assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');assert.ok(options.signal instanceof AbortSignal);assert.equal(options.headers.Authorization,'Bearer '+BEARER);assert.equal(options.headers.Accept,'application/json');assert.equal(options.headers['Accept-Encoding'],'identity');
 assert.deepEqual(proof,{owner:OWNER,principalId:PRINCIPAL,caps:CAPS});assert.equal(Object.isFrozen(proof),true);assert.equal(Object.isFrozen(proof.caps),true);assert.ok(!JSON.stringify(proof).includes(BEARER));assert.equal(r.stats.cancels,1);
});
test('native Response stream is decoded without cloning or unbounded body methods',async()=>{
 const r=new Response(JSON.stringify(identity()),{status:200,headers:{'Content-Type':'application/json'}});Object.defineProperty(r,'url',{value:A.IDENTITY_URL});r.clone=()=>{throw Error('clone forbidden');};r.text=()=>{throw Error('text forbidden');};r.json=()=>{throw Error('json forbidden');};r.arrayBuffer=()=>{throw Error('arrayBuffer forbidden');};
 assert.deepEqual(await A.verifyCampaignWriterCredential(input(),{fetchImpl:async()=>r}),{owner:OWNER,principalId:PRINCIPAL,caps:CAPS});
});
test('malformed or widened private input and options refuse before fetch without evaluating accessors',async()=>{
 let calls=0,getters=0;const fetchImpl=async()=>{calls++;return response(identity());};
 for(const change of [{bearer:'short'},{bearer:'A'.repeat(64)},{bearer:'Bearer '+BEARER},{bearer:BEARER+'\n'},{owner:'External@outside.test'},{owner:'not-email'},{owner:'x\n@example.test'},{owner:'x@localhost'},{owner:'x@-invalid.test'},{owner:'a'.repeat(65)+'@example.test'},{principalId:'legacy'},{principalId:'dcrmw-'+'B'.repeat(32)},{url:'https://example.test'},{area:'growth'},{slot:'crm-panel-read'},{operationId:'not-allowed'}])await assert.rejects(A.verifyCampaignWriterCredential({...input(),...change},{fetchImpl}),refused);
 for(const invalid of [null,[],Object.create(null),{...input(),[Symbol('extra')]:true}])await assert.rejects(A.verifyCampaignWriterCredential(invalid,{fetchImpl}),refused);
 const accessor={...input()};Object.defineProperty(accessor,'bearer',{enumerable:true,get(){getters++;return BEARER;}});await assert.rejects(A.verifyCampaignWriterCredential(accessor,{fetchImpl}),refused);
 for(const opts of [null,[],{fetchImpl:null},{fetchImpl,timeoutMs:1},{fetchImpl,url:'https://example.test'}])await assert.rejects(A.verifyCampaignWriterCredential(input(),opts),refused);
 assert.equal(calls,0);assert.equal(getters,0);
});
test('input bindings are snapshotted before awaiting the origin',async()=>{
 const source=input();const proof=await A.verifyCampaignWriterCredential(source,{fetchImpl:async()=>{source.owner='other@example.test';source.principalId='dcrmw-'+'c'.repeat(32);source.bearer='c'.repeat(64);return response(identity());}});
 assert.deepEqual(proof,{owner:OWNER,principalId:PRINCIPAL,caps:CAPS});
});
test('the read principal namespace cannot be used as a campaign writer',async()=>{
 let calls=0;await assert.rejects(A.verifyCampaignWriterCredential({...input(),principalId:'dcrm-'+'b'.repeat(32)},{fetchImpl:async()=>{calls++;return response(identity());}}),refused);
 assert.equal(calls,0);
 const v=identity();v.permissions.growth.who='panel:dcrm-'+'b'.repeat(32);
 await assert.rejects(A.verifyCampaignWriterCredential(input(),{fetchImpl:async()=>response(v)}),refused);
});
test('redirects, anonymous/non-success replies, foreign URL and headers refuse and cancel body',async()=>{
 for(const opts of [{status:301},{status:302},{status:303},{status:307},{status:308},{status:401},{status:403},{status:500},{status:201},{status:204},{redirected:true},{url:'https://example.test/read'},{url:A.IDENTITY_URL+'&extra=1'},{url:'http://comunicacao-crm-panel-read.tazdb8.easypanel.host/read?action=identity&painel=growth'},{type:'opaqueredirect'},{type:'opaque'},{headers:{'content-type':'text/html'}},{headers:{'content-type':'application/json; charset=latin1'}},{headers:{'content-encoding':'gzip'}},{headers:{'content-length':'8193'}},{headers:{'content-length':'1, 1'}},{headers:{'content-length':'NaN'}},{headers:{'content-length':'1'}}]){
  const r=response(identity(),opts);await assert.rejects(A.verifyCampaignWriterCredential(input(),{fetchImpl:async()=>r}),refused);assert.equal(r.stats.cancels,1);
 }
});
test('identity schema rejects anonymous/master/extra areas, cross owner and cross principal',async()=>{
 for(const patch of [{schema:'other'},{role:'anonymous'},{role:'master'},{panel:'todos'},{panel:'influs'},{owner:'other@example.test'},{allowedPanels:['growth','influs']},{allowedPanels:['influs']},{allowedPanels:[]},{allowedPanels:'growth'},{preview:true},{synthetic:true},{extra:'RAW_BODY_SENTINEL'},{permissions:undefined}])await assert.rejects(A.verifyCampaignWriterCredential(input(),{fetchImpl:async()=>response({...identity(),...patch})}),refused);
 for(const value of [null,[],true,'identity'])await assert.rejects(A.verifyCampaignWriterCredential(input(),{fetchImpl:async()=>response(value)}),refused);
 for(const patch of [{growth:null},{influs:{}},{influs:{caps:['read_creators']}},{organico:null},{extra:null}]){const v=identity();v.permissions={...v.permissions,...patch};await assert.rejects(A.verifyCampaignWriterCredential(input(),{fetchImpl:async()=>response(v)}),refused);}
 for(const patch of [{who:'panel:dcrmw-'+'c'.repeat(32)},{who:'panel:legacy'},{label:'other@example.test'},{extra:'RAW_BODY_SENTINEL'}]){const v=identity();v.permissions.growth={...v.permissions.growth,...patch};await assert.rejects(A.verifyCampaignWriterCredential(input(),{fetchImpl:async()=>response(v)}),refused);}
});
test('caps must be exactly four ordered writer permissions; read, media or widened grants refuse',async()=>{
 for(const caps of [[],['read_content'],['read_content','draft','validate'],['read_content','list_history','submission'],['read_content','draft','validate','submit','edit_content'],['read_content','draft','draft','submit'],['submit','validate','draft','read_content'],['draft','validate','submit','crm_send'],'read_content,draft,validate,submit',null]){
  const value=identity();value.permissions.growth.caps=caps;await assert.rejects(A.verifyCampaignWriterCredential(input(),{fetchImpl:async()=>response(value)}),refused);
 }
});
test('size bounds, strict UTF-8, malformed JSON and malformed stream parts fail closed',async()=>{
 const valid=Buffer.from(JSON.stringify(identity()));
 const bad=[response(identity(),{raw:'{broken RAW_BODY_SENTINEL'}),response(identity(),{raw:Buffer.concat([valid,Buffer.from([0xc3])])}),response(identity(),{raw:Buffer.from([0xff,0xfe])}),response(identity(),{chunks:[Buffer.alloc(4096,32),Buffer.alloc(4097,32)]}),response(identity(),{read:async()=>({done:'yes',value:valid})}),response(identity(),{read:async()=>({done:false,value:'RAW_BODY_SENTINEL'})}),response(identity(),{read:async()=>({done:true,value:valid})})];
 for(const r of bad){await assert.rejects(A.verifyCampaignWriterCredential(input(),{fetchImpl:async()=>r}),refused);assert.equal(r.stats.cancels,1);}
 const exact=response(identity(),{raw:Buffer.concat([valid,Buffer.alloc(A.MAX_RESPONSE_BYTES-valid.length,32)]),headers:{'content-length':String(A.MAX_RESPONSE_BYTES)}});assert.deepEqual(await A.verifyCampaignWriterCredential(input(),{fetchImpl:async()=>exact}),{owner:OWNER,principalId:PRINCIPAL,caps:CAPS});
 const chunked=response(identity(),{chunks:Array.from(valid,value=>Uint8Array.of(value)),headers:{'content-length':String(valid.length)}});assert.equal((await A.verifyCampaignWriterCredential(input(),{fetchImpl:async()=>chunked})).principalId,PRINCIPAL);
});
test('overridden typed-array bounds/conversion cannot smuggle an oversized response',async()=>{
 const valid=Buffer.from(JSON.stringify(identity())),huge=new Uint8Array(A.MAX_RESPONSE_BYTES+1);huge.set(valid);huge.fill(32,valid.length);Object.defineProperty(huge,'byteLength',{value:1});
 const r=response(identity(),{chunks:[huge]});await assert.rejects(A.verifyCampaignWriterCredential(input(),{fetchImpl:async()=>r}),refused);assert.equal(r.stats.cancels,1);
 const bytes=new Uint8Array(valid);bytes.valueOf=()=>Buffer.alloc(A.MAX_RESPONSE_BYTES+1);const safe=response(identity(),{chunks:[bytes]});assert.equal((await A.verifyCampaignWriterCredential(input(),{fetchImpl:async()=>safe})).principalId,PRINCIPAL);
});
test('zero-byte immediate stream cannot starve the absolute deadline',async()=>{
 const r=response(identity(),{read:async()=>({done:false,value:new Uint8Array(0)})}),started=Date.now();await assert.rejects(A.verifyCampaignWriterCredential(input(),{fetchImpl:async()=>r}),refused);assert.ok(r.stats.reads<=A.MAX_RESPONSE_BYTES+1);assert.ok(Date.now()-started<2000);assert.equal(r.stats.cancels,1);
});
test('raw transport/header/read/cancel errors never become returned error details',async()=>{
 const raw=()=>{throw Error(BEARER+' '+OWNER+' '+PRINCIPAL+' RAW_ERROR_SENTINEL');};
 await assert.rejects(A.verifyCampaignWriterCredential(input(),{fetchImpl:raw}),refused);
 const header=response(identity());header.headers={get:raw};await assert.rejects(A.verifyCampaignWriterCredential(input(),{fetchImpl:async()=>header}),refused);assert.equal(header.stats.cancels,1);
 const read=response(identity(),{read:raw,cancel:raw});await assert.rejects(A.verifyCampaignWriterCredential(input(),{fetchImpl:async()=>read}),refused);assert.equal(read.stats.cancels,1);
});
test('async violations of synchronous response methods are observed without raw unhandled rejection',()=>{
 const {spawnSync}=require('node:child_process'),modulePath=require.resolve('./crm-campaign-writer-attestation.cjs');
 for(const mode of ['headers','getReader','releaseLock']){
  const code=`'use strict';
   const A=require(${JSON.stringify(modulePath)}),mode=${JSON.stringify(mode)},sentinel='ASYNC_METHOD_RAW_CANARY';
   const owner='manager@example.test',principalId='dcrmw-'+ 'b'.repeat(32),bearer='a'.repeat(64);
   const identity={schema:'shrigma_access_identity_v1',role:'manager',panel:'growth',owner,allowedPanels:['growth'],permissions:{growth:{who:'panel:'+principalId,label:owner,caps:['read_content','draft','validate','submit']},influs:null}};
   let used=false;const reader={read:async()=>used?{done:true,value:undefined}:(used=true,{done:false,value:Buffer.from(JSON.stringify(identity))}),cancel:()=>Promise.resolve(),releaseLock:()=>mode==='releaseLock'?Promise.reject(Error(sentinel)):undefined};
   const body={getReader:()=>mode==='getReader'?Promise.reject(Error(sentinel)):reader,cancel:()=>Promise.resolve()};
   const response={status:200,ok:true,redirected:false,url:A.IDENTITY_URL,type:'basic',headers:{get:name=>mode==='headers'?Promise.reject(Error(sentinel)):name==='content-type'?'application/json':null},body};
   (async()=>{let refused=false;try{await A.verifyCampaignWriterCredential({bearer,owner,principalId},{fetchImpl:async()=>response});}catch(e){refused=e instanceof A.CampaignWriterAttestationError&&e.code==='CAMPAIGN_WRITER_ATTESTATION_REFUSED';}
    if(refused!==(mode!=='releaseLock'))process.exitCode=2;await new Promise(resolve=>setImmediate(resolve));})();`;
  const result=spawnSync(process.execPath,['-e',code],{env:{},encoding:'utf8',timeout:2000});
  assert.equal(result.status,0);assert.equal(result.signal,null);assert.equal((result.stderr||'').includes('ASYNC_METHOD_RAW_CANARY'),false);assert.equal((result.stdout||'').includes('ASYNC_METHOD_RAW_CANARY'),false);
 }
});
test('absolute five-second deadline covers fetch and stalled body without waiting for cancel',async()=>{
 let fetchSignal,bodySignal;const r=response(identity(),{read:()=>new Promise(()=>{}),cancel:()=>new Promise(()=>{})});const started=Date.now();
 await Promise.all([
  assert.rejects(A.verifyCampaignWriterCredential(input(),{fetchImpl:async(url,options)=>{fetchSignal=options.signal;return new Promise(()=>{});}}),refused),
  assert.rejects(A.verifyCampaignWriterCredential(input(),{fetchImpl:async(url,options)=>{bodySignal=options.signal;return r;}}),refused)
 ]);
 const elapsed=Date.now()-started;assert.ok(elapsed>=A.TIMEOUT_MS-50);assert.ok(elapsed<A.TIMEOUT_MS+1500);assert.equal(fetchSignal.aborted,true);assert.equal(bodySignal.aborted,true);assert.equal(r.stats.cancels,1);
});
