'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),{retryRead}=require('../tools/production-release/read-retry.cjs'),{currentHead,awaitChild,publicationFailure}=require('../tools/production-release/publish-ci.cjs');
const env={GITHUB_REPOSITORY:'bandssz/shrigma-dash-cx',GITHUB_REF:'refs/heads/main',GITHUB_TOKEN:'synthetic-ci-token',GITHUB_SHA:'a'.repeat(40)};
test('current main read retries a transient body reset once and preserves its exact SHA lease',async()=>{
 let reads=0,waits=0,checks=0;await currentHead({env,fetchImpl:async()=>{reads++;return {status:200,json:async()=>{if(reads===1)throw Object.assign(new TypeError('private URL must not escape'),{cause:{code:'ECONNRESET'}});return {object:{sha:env.GITHUB_SHA}};}};},wait:async ms=>{a.equal(ms,500);waits++;},validate:()=>checks++});a.equal(reads,2);a.equal(waits,1);a(checks>=5);
});
test('permission, changed SHA, malformed JSON and validation failures are never retried',async()=>{
 for(const response of [{status:403},{status:200,json:async()=>({object:{sha:'b'.repeat(40)}})},{status:200,json:async()=>{throw new SyntaxError('private response');}}]){let reads=0;await a.rejects(()=>currentHead({env,fetchImpl:async()=>{reads++;return response;},wait:async()=>a.fail('no retry')}));a.equal(reads,1);}
 let reads=0;await a.rejects(()=>retryRead(async()=>reads++,{validate:()=>{throw new a.AssertionError({message:'expired receipt'});}}));a.equal(reads,0);
});
test('second network failure or a window expiring during the backoff fails closed',async()=>{
 let reads=0,waits=0;await a.rejects(()=>retryRead(async()=>{reads++;throw Object.assign(Error('private'),{code:'UND_ERR_SOCKET'});},{wait:async()=>waits++}),{code:'UND_ERR_SOCKET'});a.equal(reads,2);a.equal(waits,1);
 reads=0;let expired=false;await a.rejects(()=>retryRead(async()=>{reads++;throw Object.assign(Error('private'),{code:'ECONNRESET'});},{wait:async()=>{expired=true;},validate:()=>a.equal(expired,false,'expired receipt')}),/expired receipt/);a.equal(reads,1);
});
test('waiting for the maintenance child keeps the parent event loop responsive',async()=>{
 let timerRan=false;const timer=setTimeout(()=>{timerRan=true;},5);await awaitChild(process.execPath,['-e','setTimeout(()=>process.exit(0),50)'],{stdio:'ignore'});clearTimeout(timer);a.equal(timerRan,true);
 await a.rejects(()=>awaitChild(process.execPath,['-e','process.exit(1)'],{stdio:'ignore'}),/MAINTENANCE_INSTALL_WINDOW_UNCONFIRMED/);
 await a.rejects(()=>awaitChild('unavailable-synthetic-command',[],{stdio:'ignore'}),/MAINTENANCE_INSTALL_WINDOW_UNCONFIRMED/);
});
test('failure diagnostics admit only fixed names and transport codes',()=>{
 const error=Object.assign(new TypeError('https://secret.invalid/private-token'),{cause:{code:'UND_ERR_SOCKET',message:'private'},status:3});const receipt=publicationFailure(error);a.equal(receipt.errorName,'TypeError');a.equal(receipt.causeCode,'UND_ERR_SOCKET');a.equal(receipt.subprocessExit,3);a(!JSON.stringify(receipt).includes('private'));a(!JSON.stringify(receipt).includes('secret.invalid'));
 const other=publicationFailure({name:'private',code:'private',message:'private',cause:{code:'private'}});a.equal(other.errorName,null);a.equal(other.causeCode,null);a.equal(other.code,'PUBLICATION_STEP_FAILED');
});
