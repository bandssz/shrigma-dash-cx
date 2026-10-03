'use strict';
// Executor real com autenticação e biblioteca sintéticas: nenhum socket ou serviço.
const test=require('node:test'),assert=require('node:assert/strict');
const {createMediaExecutor,canonicalFilename,filenameParts,UUID}=require('../services/crm-campaign/media.cjs');
const {AUTH_SQL}=require('../services/crm-campaign/transport.cjs');

const ORIGIN='https://synthetic.invalid',KEY='synthetic-media-read';
const LOWER_OPERATION='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UPPER_OPERATION='AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const SHA='a'.repeat(64);
const INTERRUPTED={status:503,body:{error:'MEDIA_INTERRUPTED',message:'A consulta da biblioteca foi interrompida.',posted:false}};
const item=filename=>({id:1,filename,url:ORIGIN+'/uploads/'+filename,content_type:'image/png',meta:{width:2,height:3}});
const page=(results,{number=1,total=results.length,perPage=24}={})=>({status:200,body:{data:{results,total,page:number,per_page:perPage}}});
function reader(list){
 let authCalls=0;
 const pool={async query(sql,args){assert.equal(sql,AUTH_SQL);assert.deepEqual(args,[KEY]);authCalls++;return {rows:[{auth:{actor:'synthetic-reader',caps:['read_content']}}]};}};
 const native={origin:ORIGIN,list,upload:async()=>assert.fail('a leitura não pode iniciar upload')};
 return {execute:createMediaExecutor({pool,native}),authCalls:()=>authCalls};
}
const request=(input,interrupted=()=>false)=>({key:KEY,method:'GET',input,interrupted});

test('biblioteca interrompida antes da primeira página retorna 503 sem consultar a origem',async()=>{
 let lists=0;
 const fixture=reader(async()=>{lists++;assert.fail('consulta iniciada após interrupção');});
 const result=await fixture.execute(request({brand:'fish',page:1,per_page:24},()=>true));
 assert.deepEqual(result,INTERRUPTED);assert.equal(lists,0);assert.equal(fixture.authCalls(),1);
});

test('interrupção entre páginas encerra o scan com 503 após uma única consulta',async()=>{
 let interrupted=false,lists=0;
 const fixture=reader(async input=>{
  lists++;assert.deepEqual(input,{page:1,perPage:1,query:''});
  interrupted=true;
  return page([item(canonicalFilename('aristo',LOWER_OPERATION,SHA,'png'))],{number:1,total:2,perPage:1});
 });
 const result=await fixture.execute(request({brand:'fish',page:1,per_page:1},()=>interrupted));
 assert.deepEqual(result,INTERRUPTED);assert.equal(lists,1);assert.equal(fixture.authCalls(),1);
});

test('UUID maiúsculo do Aristo é excluído da biblioteca Fish e mantém recuperação exata',async()=>{
 assert.equal(UUID.test(UPPER_OPERATION),true);
 const filename=canonicalFilename('aristo',UPPER_OPERATION,SHA,'png'),calls=[];
 assert.deepEqual(filenameParts(filename),{brand:'aristo',operation_id:UPPER_OPERATION,sha256:SHA,ext:'png'});
 assert.equal(filenameParts(filename.replace('crm-aristo-','crm-ARISTO-')),null);
 assert.equal(filenameParts(filename.replace(SHA,SHA.toUpperCase())),null);
 const fixture=reader(async input=>{calls.push(input);return page([item(filename)],{perPage:input.perPage});});
 const library=await fixture.execute(request({brand:'fish',page:1,per_page:24}));
 assert.equal(library.status,200);assert.equal(library.body.brand,'fish');assert.deepEqual(library.body.items,[]);assert.equal(library.body.next_page,null);
 const recovery=await fixture.execute(request({brand:'aristo',operation_id:UPPER_OPERATION,filename,sha256:SHA}));
 assert.equal(recovery.status,200);assert.equal(recovery.body.state,'found');assert.equal(recovery.body.brand,'aristo');
 assert.equal(recovery.body.operation_id,UPPER_OPERATION);assert.equal(recovery.body.filename,filename);assert.equal(recovery.body.sha256,SHA);assert.equal(recovery.body.media.filename,filename);
 assert.deepEqual(calls,[{page:1,perPage:24,query:''},{page:1,perPage:50,query:filename}]);assert.equal(fixture.authCalls(),2);
});
