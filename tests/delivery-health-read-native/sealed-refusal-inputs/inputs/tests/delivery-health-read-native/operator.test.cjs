'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Readable}=require('node:stream');
const {handleDeliveryHealthOperator:handle,PAGE,API,SCRIPT}=require('./load-operator.cjs');
function fixture(route=API,body={action:'status'},method='POST'){
 const ctx={host:'manager.original.invalid',method,csrf:'original-csrf',session:'original-session'},req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method=method;req.headers={'content-type':'application/json'};
 const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(v){this.body=v;}};
 const calls=[],auth={authorize:q=>{assert.equal(q.admin,true);assert.equal(q.method,req.method);if(!q.session||req.method==='POST'&&q.csrf!=='original-csrf')throw Error('ORIGINAL_AUTH_DENIED');calls.push(q);}};
 const health={enabled:true,status:q=>({operational:false}),authorize:q=>{calls.push(q);return {authorized:true};},inspect:async q=>{calls.push(q);return {operational:false};}};
 return {req,res,ctx,auth,managerHost:ctx.host,url:new URL(route,'https://'+ctx.host),health,calls};
}
for(const route of [PAGE,SCRIPT])test('original manager GET '+route+' CSP/no-store',async()=>{const f=fixture(route,{},'GET');assert.equal(await handle(f),true);assert.equal(f.res.headers['Cache-Control'],'no-store');assert.match(f.res.headers['Content-Security-Policy'],/frame-ancestors 'none'/);assert.equal(f.calls.length,1);});
test('original POST/CSRF & exact purpose actions',async()=>{for(const body of [{action:'status'},{action:'authorize',connectionId:'existing',brand:'fish',consent:true},{action:'inspect',connectionId:'existing',brand:'fish'}]){const f=fixture(API,body);assert.equal(await handle(f),true);assert.equal(f.res.statusCode,200);if(body.action!=='status')assert.equal(f.calls.at(-1).context.csrf,'original-csrf');}});
for(const [name,change] of [['host',f=>f.ctx.host='foreign.invalid'],['native',f=>f.ctx.nativeBearer='caller'],['GET API',f=>f.req.method='GET'],['missing csrf',f=>f.ctx.csrf=null],['missing session',f=>f.ctx.session=null],['query',f=>f.url.search='?brand=fish'],['off',f=>f.health.enabled=false],['content',f=>f.req.headers['content-type']='text/plain']])test('operator rejects '+name,async()=>{const f=fixture();change(f);await assert.rejects(handle(f));assert.equal(f.res.body,undefined);});
test('extra SQL/owner/free destination/action refused',async()=>{for(const b of [{action:'inspect',connectionId:'existing',brand:'fish',sql:'SELECT 1'},{action:'authorize',connectionId:'existing',brand:'fish',consent:true,ownerId:'caller'},{action:'recover'},{action:'inspect',brand:'fish'}])await assert.rejects(handle(fixture(API,b)));});
test('bounded original readJson refuses malformed/oversized body',async()=>{for(const raw of ['{','x'.repeat(4097)]){const f=fixture(),req=Readable.from([Buffer.from(raw)]);req.method='POST';req.headers=f.req.headers;f.req=req;await assert.rejects(handle(f));}});
test('unrelated path ignored',async()=>assert.equal(await handle(fixture('/other')),false));
