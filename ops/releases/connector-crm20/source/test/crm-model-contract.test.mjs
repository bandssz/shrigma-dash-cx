import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {Crm} from '../src/crm.mjs';

const require=createRequire(import.meta.url),root=process.env.CRM_GATEWAY_SOURCE;
for(const brand of ['aristo','fish'])test('connector saves and rereads the actual CRM model contract '+brand,{skip:!root},async()=>{
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('crm-qa');");
 const user={id:'connector-qa',login:'editor-qa-'+brand+'@shrigma.com.br',brand,active:true,crm:true};
 const crmUser={id:'crm-qa',email:user.login,role:'manager',permissions:{growth:{read:true,edit:true}},productWriteFronts:['growth']};
 const api=require(root+'/simple-crm-model-pieces.cjs').create({db,authorize:()=>crmUser}),calls=[];
 const session={cookie:'__Host-shrigma_sid=synthetic',csrf:'synthetic-csrf',userId:crmUser.id,email:user.login};
 const client=new Crm({store:{user:()=>user,credentials:()=>({crm:session})},fetchImpl:async(raw,options)=>{
  const url=new URL(raw);calls.push({path:url.pathname,method:options.method});assert.equal(url.origin,'https://crm.shrigma.com.br');assert.equal(url.pathname,'/api/model-pieces');assert.equal(options.headers.Cookie,session.cookie);
  const context={method:options.method};
  const result=options.method==='POST'?api.append({context,brand,body:JSON.parse(options.body)}):api.read({context,brand,query:url.searchParams});
  return Response.json(result,{status:options.method==='POST'?201:200});
 }});
 try{
  const html='<p>Olá {{ .Subscriber.FirstName }} {{ .Subscriber.LastName }}</p><a href="{{ .UnsubscribeURL }}">Sair</a>',key='6d913059-2be8-47f3-8da2-431b01d31814';
  const saved=await client.call('crm_model_save',{brand,name:'[QA] chat',subject:'Olá',html,idempotency_key:key},user.id);
  assert.equal(saved.operation.state,'completed');const id=saved.operation.response.body.draft_id;assert.match(id,/^d_piece_[a-f0-9]{32}$/);
  const reopened=await client.call('crm_model_get',{brand,id},user.id);assert.equal(reopened.drafts[0].rascunho.corpo,html);
  const receipt=await client.call('crm_model_operation',{brand,idempotency_key:key},user.id);assert.deepEqual(receipt,saved);
  assert.equal(db.prepare('SELECT count(*) n FROM crm_model_piece_v1').get().n,1);assert.deepEqual(calls.map(x=>x.method),['POST','GET','GET']);
 }finally{db.close();}
});
