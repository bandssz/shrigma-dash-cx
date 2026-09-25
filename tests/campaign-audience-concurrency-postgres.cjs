'use strict';
// Explicitly disposable CI database only. Three independent connections, no SMTP.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Client}=require('pg');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const raw=process.env.TEST_DATABASE_URL;let target;try{target=new URL(raw);}catch{}
if(process.env.CAMPAIGN_TEST_DATABASE_ISOLATED!=='1'||!target||!['localhost','127.0.0.1'].includes(target.hostname)||target.pathname!=='/campaign_audience_test'||target.username!=='synthetic'||target.password){throw Error('Requires explicitly isolated localhost campaign_audience_test with synthetic user.');}
(async()=>{
 const clients=['audience-locker','audience-scheduler','audience-observer'].map(application_name=>new Client({connectionString:raw,application_name}));
 await Promise.all(clients.map(c=>c.connect()));const [a,b,c]=clients;
 try{
  assert.equal((await a.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0,'refuse a populated database');
  for(const f of ['tests/campaign-provider-schema.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-provider.sql','n8n/growth/campaign-write-guard.sql'])await a.query(read(f));
  await a.query("INSERT INTO crm_familia_campanha VALUES('fish','week','week');INSERT INTO subscribers VALUES(3,'enabled'),(4,'enabled');INSERT INTO subscriber_lists VALUES(3,3,'confirmed')");
  const review=async()=> (await a.query('SELECT fixture_audience_review(100) v')).rows[0].v;
  const current=async()=> (await a.query('SELECT shrigma_campaign_current(100) c')).rows[0].c;
  let n=0;
  const claim=async()=> (await a.query("SELECT shrigma_campaign_store('claim',$1::jsonb) o",[JSON.stringify({actor:'ci-audience',key:'concurrent-audience-'+(++n),hash:'a'.repeat(64),brand:'fish',action:'agendar'})])).rows[0].o;
  const payload=async(v,op)=>({id:100,expectedVersion:(await current()).version,operationId:op.id,audienceReviewId:v.audience.review_id});
  async function waitBlocked(){for(let i=0;i<150;i++){const r=await c.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='audience-scheduler' AND wait_event_type='Lock'");if(r.rows[0].n)return;await new Promise(r=>setTimeout(r,20));}throw Error('Scheduler did not wait on the independent campaign lock');}
  for(const mode of ['unsubscribe','same-count-swap']){
   const v=await review(),op=await claim(),p=await payload(v,op);
   await a.query('BEGIN');await a.query('SELECT id FROM campaigns WHERE id=100 FOR UPDATE');
   const pending=b.query("SELECT shrigma_campaign_provider('schedule',$1::jsonb) c",[JSON.stringify(p)]).then(value=>({value}),error=>({error}));
   await waitBlocked();
   if(mode==='unsubscribe')await a.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=3");
   else await a.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=3 AND list_id=3;INSERT INTO subscriber_lists VALUES(4,3,'confirmed')");
   await a.query('COMMIT');const result=await pending;
   assert.equal(result.error?.message,'AUDIENCE_CHANGED',mode+' committed before recheck must reject');
   assert.equal((await current()).status,'draft');
   const stored=(await c.query('SELECT state,response FROM shrigma_campaign_operation WHERE id=$1',[op.id])).rows[0];assert.equal(stored.state,'pending');assert.equal(stored.response,null);
  }
  const v=await review(),op=await claim(),p=await payload(v,op);
  const r=(await b.query("SELECT shrigma_campaign_provider('schedule',$1::jsonb) c",[JSON.stringify(p)])).rows[0].c;
  const stored=(await c.query('SELECT state,response FROM shrigma_campaign_operation WHERE id=$1',[op.id])).rows[0];
  assert.equal(r.status,'scheduled');assert.equal(stored.state,'succeeded');assert.equal(stored.response.body.audience.eligible_count,1);assert.equal(stored.response.body.audience.review_id,v.audience.review_id);
  assert.equal((await c.query('SELECT sent,started_at FROM campaigns WHERE id=100')).rows[0].sent,0);
  console.log('PASS independent PostgreSQL sessions: locked schedule sees committed opt-out and same-count composition swap; rejects atomically, then records one current audience with schedule. No transport.');
 }finally{await Promise.allSettled(clients.map(c=>c.end()));}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
