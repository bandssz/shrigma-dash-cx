'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{webcrypto}=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const C=require('../n8n/growth/vip-recorded-origin-client.js'),P=require('../n8n/growth/vip-recorded-origin-patch.cjs');
const {setupRecordedComponent,rule}=require('./segment-recorded-origin-fixture.cjs');
function memory(){const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,String(v)),dump:()=>[...m.values()].join('')};}
function mutex(){let tail=Promise.resolve();return {request(_name,_options,fn){const next=tail.then(fn);tail=next.catch(()=>{});return next;}};}
for(const target of Object.values(P.TARGETS))test(target.source+': browser POST commits the real receipt; lost ACK is recovered by GET before audience selection',async t=>{
 const db=new PGlite();t.after(()=>db.close());const x=await setupRecordedComponent(db),calls=[],store=memory();assert.equal(x.tier,'component-pglite-no-install-guard');
 await db.exec('UPDATE crm_audience_v2.recorded_origin_source SET enabled=false');
 await db.query('UPDATE crm_audience_v2.recorded_origin_source SET producer_revision=$2 WHERE producer_id=$1',[target.producerId,target.producerRevision]);
 await db.query('UPDATE crm_audience_v2.recorded_origin_source SET enabled=true WHERE producer_id=$1',[target.producerId]);await db.query("SELECT crm_audience_v2.refresh_native_catalog('aristo')");
 const fetch=async(url,options)=>{
  calls.push(options.method);
  if(options.method==='POST'){
   const b=JSON.parse(options.body);await db.query('SELECT * FROM crm_audience_v2.recorded_origin_subscribe_v2($1,$2,$3,$4,$5,$6)',[b.email,b.origem,b.corrigido,target.source,b.event_id,target.producerRevision]);throw Error('synthetic lost ACK after commit');
  }
  const event=new URL(url).searchParams.get('event_id'),r=(await db.query('SELECT * FROM crm_audience_v2.recorded_origin_operation_v2($1,$2)',[target.producerId,event])).rows[0];assert.equal(r.found,true);
  const body={contract:C.CONTRACT,state:'accepted',producer_id:r.producer_id,event_id:r.event_id,receipt_hash:r.receipt_hash,accepted_at:new Date(r.accepted_at).toISOString(),newly_recorded:false};
  return {ok:true,json:async()=>body};
 };
 const config={source:target.source,producerId:target.producerId,producerRevision:target.producerRevision,endpoint:'https://example.test/webhook/'+target.path,storage:store,crypto:webcrypto,locks:mutex(),fetch};
 const first=C.createRecordedOriginClient(config);await assert.rejects(first.submit({email:'person1@example.test',origin:'synthetic-form'}));assert.equal(first.status().state,'uncertain');
 const reopened=C.createRecordedOriginClient(config);assert.equal((await reopened.reconcile()).state,'accepted');assert.deepEqual(calls,['POST','GET']);assert.doesNotMatch(store.dump(),/person1@example[.]test/);
 const leaf=rule(target.source==='alma'?'vip_alma':'vip_desodorante');assert.equal((await x.count(leaf)).eligible_count,1);await x.rebind('aristo',leaf);await x.f.approve();assert.equal(await x.match('aristo',1),true);
 await db.exec("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=16");assert.equal(await x.match('aristo',1),false);assert.equal((await x.count(leaf)).eligible_count,0);
 assert.equal((await db.query('SELECT count(*)::int n FROM crm_audience_v2.recorded_origin_receipt')).rows[0].n,1);assert.equal((await db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
});
