'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const runtime=process.env.SOURCE_SYNC_TEST_RUNTIME||require('node:path').resolve(__dirname,'../../services/dashboard-operational');
const {createOriginalSourceTransport,ORIGIN,REVISION}=require(runtime+'/native-source-transport.cjs');
const bearer='isolated-source-key-0000000000000000',key='isolated-source-intent-0001',body={brand:'aristo',idempotency_key:key,scheduled_for:'2026-10-07T23:00:00.000Z'};
const response=(url,value={service:'crm-shopify-sync'},extra={})=>{const r=new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json','X-CRM-Shopify-Sync-Revision':REVISION,...extra.headers}});Object.defineProperty(r,'url',{value:url});return r;};
const denied=fn=>a.rejects(fn,e=>e.code==='SOURCE_TRANSPORT_UNAVAILABLE'&&!JSON.stringify(e).includes(bearer));
test('fixed original health is anonymous and an explicit new source POST uses only the service key',async()=>{
 const calls=[],t=createOriginalSourceTransport({fetchImpl:async(url,options)=>{calls.push({url,options});return response(url);}});
 a.equal((await t({method:'GET',path:'/healthz'})).revision,REVISION);a.equal(calls[0].options.headers.Authorization,undefined);
 await t({method:'POST',path:'/v1/run',body,bearer});a.equal(calls[1].url,ORIGIN+'/v1/run');a.equal(calls[1].options.redirect,'error');a.equal(calls[1].options.headers.Authorization,'Bearer '+bearer);a.deepEqual(JSON.parse(calls[1].options.body),body);
 await t({method:'GET',path:'/v1/operations/'+key,bearer});a.equal(calls[2].options.body,undefined);
 await t({method:'GET',path:'/v1/operations/'+encodeURIComponent('isolated:source:original-key-0001'),bearer});a.equal(calls[3].url,ORIGIN+'/v1/operations/isolated%3Asource%3Aoriginal-key-0001');
});
test('caller destinations, recover, actors, query strings and unauthenticated source writes never reach transport',async()=>{
 let n=0;const t=createOriginalSourceTransport({fetchImpl:()=>{n++;throw Error('unexpected');}});
 for(const input of [{method:'POST',path:'/v1/recover',body,bearer},{method:'POST',path:'/v1/run',body},{method:'POST',path:'/v1/run',body:{...body,actor:'injected'},bearer},{method:'GET',path:'/v1/operations/'+key+'?brand=fish',bearer},{method:'GET',path:'https://untrusted.invalid/',bearer},{method:'GET',path:'/healthz',bearer},{method:'POST',path:'/v1/run',body,bearer,url:'https://untrusted.invalid/'}])await denied(()=>t(input));a.equal(n,0);
});
test('revision drift, redirected peer, non-JSON and an oversized response are refused without leaking body or key',async()=>{
 for(const make of [url=>response(url,{}, {headers:{'X-CRM-Shopify-Sync-Revision':'0'.repeat(40)}}),url=>response('https://untrusted.invalid/',{}),url=>response(url,{}, {headers:{'Content-Type':'text/html'}}),url=>response(url,{private:bearer.repeat(600)}),url=>response(url,{}, {headers:{'Content-Length':'17000'}})]){
  let n=0;const t=createOriginalSourceTransport({fetchImpl:async url=>{n++;return make(url);}});await denied(()=>t({method:'GET',path:'/v1/operations/'+key,bearer}));a.equal(n,1);
 }
});
test('uncertain original transport is sanitized and is never retried by the client',async()=>{
 let n=0;const t=createOriginalSourceTransport({fetchImpl:async()=>{n++;throw Error('upstream included '+bearer);}});await denied(()=>t({method:'POST',path:'/v1/run',body,bearer}));a.equal(n,1);
});
