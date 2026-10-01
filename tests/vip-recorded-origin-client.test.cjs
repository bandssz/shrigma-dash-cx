'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto'),C=require('../n8n/growth/vip-recorded-origin-client.js');
const event='12345678-1234-4abc-8def-1234567890ab',producer='NAmTWZ7vddQ8LX1k',revision='1c140aa6dfbe15d1cd8707ecf8476c3ff1d7df56309d640ff57578b22d716701',endpoint='https://example.invalid/webhook/alma-da-roca-vip-recorded-v2';
function storage(){const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),dump:()=>[...m.entries()]};}
function lockManager(){let tail=Promise.resolve();return {request(_name,_options,fn){const next=tail.then(fn);tail=next.catch(()=>{});return next;}};}
const crypto={randomUUID:()=>event,subtle:webcrypto.subtle};
const response=body=>({ok:true,json:async()=>structuredClone(body)}),accepted=(extra={})=>({contract:C.CONTRACT,state:'accepted',producer_id:producer,event_id:event,receipt_hash:'a'.repeat(64),accepted_at:'2026-09-29T12:00:00.000Z',newly_recorded:true,...extra});
const make=(calls,store=storage(),handler=async()=>response(accepted()),locks=lockManager(),extra={})=>({client:C.createRecordedOriginClient({source:'alma',producerId:producer,producerRevision:revision,endpoint,storage:store,crypto,locks,fetch:async(...args)=>{calls.push(args);return handler(...args);},TextEncoder,clock:()=>1,...extra}),store});

test('capability/storage failure blocks before request or journal',async()=>{
 let calls=0;for(const bad of [{storage:null},{crypto:null},{crypto:{randomUUID:()=>event,subtle:null}},{locks:null}])assert.throws(()=>C.createRecordedOriginClient({source:'alma',producerId:producer,producerRevision:revision,endpoint,storage:storage(),crypto,locks:lockManager(),fetch:async()=>{calls++;},TextEncoder,...bad}),{code:'VIP_ORIGIN_CLIENT_UNAVAILABLE'});assert.equal(calls,0);
 const broken=storage();broken.setItem=()=>{};const client=C.createRecordedOriginClient({source:'alma',producerId:producer,producerRevision:revision,endpoint,storage:broken,crypto,locks:lockManager(),fetch:async()=>{calls++;},TextEncoder,clock:()=>1});await assert.rejects(client.submit({email:'person@example.invalid',origin:'lp-alma'}),{code:'VIP_ORIGIN_STORAGE_UNAVAILABLE'});assert.equal(calls,0);
});

test('event is journaled before the only POST; storage has no email and exact ACK confirms',async()=>{
 const calls=[],{client,store}=make(calls);const out=await client.submit({email:'person@example.invalid',origin:'lp-alma-da-roca',corrected:false});assert.equal(out.state,'accepted');assert.equal(out.posted,true);assert.equal(calls.length,1);assert.equal(calls[0][1].method,'POST');assert.equal(JSON.parse(calls[0][1].body).event_id,event);
 const raw=store.dump()[0][1];assert.ok(!raw.includes('person@example.invalid'));assert.ok(!raw.includes('lp-alma-da-roca')||JSON.parse(raw).payload_fingerprint.length===64);const saved=JSON.parse(raw);assert.equal(saved.state,'confirmed');assert.equal(saved.event_id,event);assert.match(saved.payload_fingerprint,/^[0-9a-f]{64}$/);assert.equal(client.status().requires_reconcile,false);
 const otherStore=storage(),other=make([],otherStore).client;await other.submit({email:'other@example.invalid',origin:'lp-alma-da-roca',corrected:false});assert.notEqual(JSON.parse(otherStore.dump()[0][1]).payload_fingerprint,saved.payload_fingerprint);assert.ok(!otherStore.dump()[0][1].includes('other@example.invalid'));
 const again=await client.submit({email:'person@example.invalid',origin:'lp-alma-da-roca'});assert.equal(again.posted,false);await assert.rejects(client.submit({email:'other@example.invalid',origin:'other'}),{code:'VIP_ORIGIN_ATTEMPT_EXISTS'});assert.equal(calls.length,1);
});

test('lost or malformed ACK becomes uncertain; reload performs GET only and never retries POST',async()=>{
 const calls=[],store=storage();let phase='lost';let x=make(calls,store,async(url,opts)=>{if(phase==='lost')throw Error('lost');assert.equal(opts.method,'GET');assert.match(url,new RegExp('event_id='+event));return response(accepted({newly_recorded:false}));});
 await assert.rejects(x.client.submit({email:'person@example.invalid',origin:'lp-alma'}),{code:'VIP_ORIGIN_REQUEST_UNCERTAIN'});assert.equal(x.client.status().state,'uncertain');assert.equal(calls.filter(x=>x[1].method==='POST').length,1);phase='get';
 x=make(calls,store,async(url,opts)=>{assert.equal(opts.method,'GET');return response(accepted({newly_recorded:false}));});const recovered=await x.client.reconcile();assert.equal(recovered.reconciled,true);assert.equal(x.client.status().state,'confirmed');assert.equal(calls.filter(x=>x[1].method==='POST').length,1);assert.equal(calls.filter(x=>x[1].method==='GET').length,1);
 const badStore=storage(),badCalls=[],bad=make(badCalls,badStore,async()=>response(accepted({producer_id:'foreign'}))).client;await assert.rejects(bad.submit({email:'person@example.invalid',origin:'lp'}),{code:'VIP_ORIGIN_ACK_INVALID'});assert.equal(bad.status().state,'uncertain');
});

test('GET not_found keeps the same uncertain event and subsequent actions remain GET-only',async()=>{
 const calls=[],store=storage();let phase=0;let {client}=make(calls,store,async()=>{if(phase++===0)throw Error('lost');return response({contract:C.CONTRACT,state:'not_found',producer_id:producer,event_id:event});});await assert.rejects(client.submit({email:'person@example.invalid',origin:'lp'}));
 const miss=await client.reconcile();assert.equal(miss.state,'not_found');assert.equal(client.status().event_id,event);assert.equal(client.status().state,'uncertain');await client.reconcile();assert.equal(calls.filter(x=>x[1].method==='POST').length,1);assert.equal(calls.filter(x=>x[1].method==='GET').length,2);
});

test('form binding waits for confirmed receipt and turns uncertain submit into a manual GET button',async()=>{
 const listeners={},form={addEventListener:(n,f)=>listeners[n]=f},email={value:'person@example.invalid'},button={disabled:false,textContent:'Entrar'},error={textContent:''},calls=[],store=storage();let get=false,navigated=0;
 const {client}=make(calls,store,async(_url,opts)=>{if(opts.method==='POST')throw Error('lost');get=true;return response(accepted({newly_recorded:false}));});client.bindForm({form,email,button,error,origin:'lp-alma',navigate:()=>navigated++});await listeners.submit({preventDefault(){}});assert.equal(navigated,0);assert.equal(button.textContent,'Conferir inscrição anterior');assert.equal(email.disabled,true);assert.match(error.textContent,/próxima tentativa apenas consultará/);
 await listeners.submit({preventDefault(){}});assert.equal(get,true);assert.equal(navigated,1);assert.equal(calls.filter(x=>x[1].method==='POST').length,1);assert.equal(calls.filter(x=>x[1].method==='GET').length,1);
});

test('form input failure before a journal keeps correction available and makes no request',async()=>{const listeners={},form={addEventListener:(n,f)=>listeners[n]=f},email={value:'invalid',disabled:false},button={disabled:false,textContent:'Entrar'},error={textContent:''},calls=[],{client}=make(calls);client.bindForm({form,email,button,error,origin:'lp-alma',navigate:()=>assert.fail('must not navigate')});await listeners.submit({preventDefault(){}});assert.equal(calls.length,0);assert.equal(client.status(),null);assert.equal(email.disabled,false);assert.equal(button.textContent,'Entrar');assert.match(error.textContent,/Confira os dados/);});

test('shared Web Lock serializes two instances and permits exactly one POST',async()=>{
 const calls=[],store=storage(),locks=lockManager();let release;const held=new Promise(resolve=>release=resolve),handler=async()=>{await held;return response(accepted());};
 const a=make(calls,store,handler,locks).client,b=make(calls,store,handler,locks).client,p1=a.submit({email:'person@example.invalid',origin:'lp-alma'}),p2=b.submit({email:'person@example.invalid',origin:'lp-alma'});try{for(let i=0;i<20&&calls.length===0;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,1);}finally{release();}const [x,y]=await Promise.all([p1,p2]);assert.equal(x.posted,true);assert.equal(y.posted,false);assert.equal(calls.length,1);
});

test('deadline aborts a hanging request and a late response cannot confirm the journal',async()=>{
 const calls=[],store=storage();let resolveFetch,aborted=false;const late=new Promise(resolve=>resolveFetch=resolve);const {client}=make(calls,store,async(_url,opts)=>{opts.signal.addEventListener('abort',()=>aborted=true);return late;},lockManager(),{timeoutMs:100});
 await assert.rejects(client.submit({email:'person@example.invalid',origin:'lp-alma'}),{code:'VIP_ORIGIN_REQUEST_UNCERTAIN'});assert.equal(aborted,true);assert.equal(client.status().state,'uncertain');resolveFetch(response(accepted()));await new Promise(resolve=>setTimeout(resolve,10));assert.equal(client.status().state,'uncertain');assert.equal(calls.length,1);
});

test('deadline also covers a response whose JSON body never completes',async()=>{
 const calls=[],store=storage();let resolveJSON;const pending=new Promise(resolve=>resolveJSON=resolve),{client}=make(calls,store,async()=>({ok:true,json:()=>pending}),lockManager(),{timeoutMs:100});await assert.rejects(client.submit({email:'person@example.invalid',origin:'lp-alma'}),{code:'VIP_ORIGIN_REQUEST_UNCERTAIN'});assert.equal(client.status().state,'uncertain');resolveJSON(accepted());await new Promise(resolve=>setTimeout(resolve,10));assert.equal(client.status().state,'uncertain');assert.equal(calls.length,1);
});

test('deterministic refusal is terminal without a receipt or retry',async()=>{
 const calls=[],{client,store}=make(calls,storage(),async()=>response({contract:C.CONTRACT,state:'not_accepted',producer_id:producer,event_id:event,reason:'source_unavailable'}));const out=await client.submit({email:'person@example.invalid',origin:'lp-alma'});assert.equal(out.state,'not_accepted');assert.equal(client.status().state,'rejected');assert.equal(client.status().requires_reconcile,false);const saved=JSON.parse(store.dump()[0][1]);assert.equal(saved.receipt_hash,null);assert.equal(saved.result_reason,'source_unavailable');const local=await client.reconcile();assert.equal(local.state,'not_accepted');assert.equal(calls.length,1);
});

test('a journal from an earlier producer revision remains GET-reconcilable but cannot create a new POST',async()=>{const calls=[],store=storage();let first=make(calls,store,async()=>{throw Error('lost')}).client;await assert.rejects(first.submit({email:'person@example.invalid',origin:'lp-alma'}));const newer='b'.repeat(64),next=C.createRecordedOriginClient({source:'alma',producerId:producer,producerRevision:newer,endpoint,storage:store,crypto,locks:lockManager(),fetch:async(url,opts)=>{calls.push([url,opts]);return response(accepted({newly_recorded:false}));},TextEncoder,clock:()=>2});const result=await next.reconcile();assert.equal(result.state,'accepted');assert.equal(calls.filter(x=>x[1].method==='POST').length,1);assert.equal(calls.filter(x=>x[1].method==='GET').length,1);assert.equal(JSON.parse(store.dump()[0][1]).producer_revision,revision);await assert.rejects(next.submit({email:'person@example.invalid',origin:'lp-alma'}),{code:'VIP_ORIGIN_ATTEMPT_EXISTS'});assert.equal(calls.length,2);});
