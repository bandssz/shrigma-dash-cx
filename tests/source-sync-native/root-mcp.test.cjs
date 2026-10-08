'use strict';
// Source-only dispatcher fixtures, never a production actor or service grant.
const test=require('node:test'),a=require('node:assert/strict');
const runtime=process.env.SOURCE_SYNC_TEST_RUNTIME||require('node:path').resolve(__dirname,'../../services/dashboard-operational');
const {createNativeMcp}=require(runtime+'/crm-native-mcp.cjs');
const host='manager.synthetic.invalid',requestId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const denied=code=>{throw Object.assign(Error(code),{code,status:403});};
function fixture(scopes=['crm.source-sync'],invoke=async()=>({status:200,body:{state:'uncertain',operational:false}})){
 let live=true,calls=[];
 const authenticate=(_token,{scope,brand}={})=>{if(!live)denied('NATIVE_AUTH_REQUIRED');if(scope&&!scopes.includes(scope))denied('NATIVE_SCOPE_DENIED');if(brand&&brand!=='fish')denied('BRAND_DENIED');return {id:'isolated-connection',userId:'isolated-master',brands:['fish'],scopes,host};};
 const auth={nativeConnections:{authenticate,context:(token,needs)=>{authenticate(token,needs);return {nativeBearer:token,host,origin:'https://'+host,csrf:'isolated-csrf'};}}};
 const mcp=createNativeMcp({auth,managerHost:host,invoke:async input=>{calls.push(input);return invoke(input,()=>{live=false;});}});
 return {mcp,calls};
}
test('existing CRM and installer scopes cannot dispatch source runs; source-only Fish grant denies Aristo first',async()=>{
 const f=fixture(['crm.read','crm.draft','crm.iam','db.inspect','db.install']);
 await a.rejects(f.mcp.call('crm_source_sync_run',{brand:'fish',requestId},'isolated-token'),e=>e.code==='NATIVE_SCOPE_DENIED');a.equal(f.calls.length,0);
 const source=fixture();await a.rejects(source.mcp.call('crm_source_sync_run',{brand:'aristo',requestId},'isolated-token'),e=>e.code==='BRAND_DENIED');a.equal(source.calls.length,0);
});
test('source tools use the same gateway dispatcher and fixed intent fields; client cannot inject key, actor or destination',async()=>{
 const f=fixture();const result=await f.mcp.call('crm_source_sync_run',{brand:'fish',requestId},'isolated-token');a.equal(result.body.state,'uncertain');a.equal(f.calls.length,1);
 a.equal(f.calls[0].method,'POST');a.equal(f.calls[0].path,'/api/source-sync');a.deepEqual(f.calls[0].body,{action:'run',brand:'fish',requestId});a.equal(f.calls[0].context.method,'POST');
 await f.mcp.call('crm_source_sync_inspect',{brand:'fish',requestId},'isolated-token');a.equal(f.calls[1].method,'GET');a.equal(f.calls[1].path,'/api/source-sync?action=inspect&brand=fish&requestId='+requestId);
 for(const property of ['idempotency_key','actor','url','bearer'])await a.rejects(f.mcp.call('crm_source_sync_run',{brand:'fish',requestId,[property]:'injected'},'isolated-token'),e=>e.code==='NATIVE_ARGUMENTS_INVALID');a.equal(f.calls.length,2);
});
test('revocation during source dispatch suppresses the response and a lost reply never repeats the dispatcher call',async()=>{
 const revoked=fixture(undefined,async(_input,revoke)=>{revoke();return {status:200,body:{state:'completed'}};});
 await a.rejects(revoked.mcp.call('crm_source_sync_inspect',{brand:'fish',requestId},'isolated-token'),e=>e.code==='NATIVE_AUTH_REQUIRED');a.equal(revoked.calls.length,1);
 const lost=fixture(undefined,async()=>{throw Object.assign(Error('NATIVE_OPERATION_UNCERTAIN'),{code:'NATIVE_OPERATION_UNCERTAIN'});});
 await a.rejects(lost.mcp.call('crm_source_sync_run',{brand:'fish',requestId},'isolated-token'),e=>e.code==='NATIVE_OPERATION_UNCERTAIN');a.equal(lost.calls.length,1);
});
