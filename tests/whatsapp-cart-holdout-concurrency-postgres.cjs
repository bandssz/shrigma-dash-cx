/* Real independent PostgreSQL sessions; empty disposable holdout_test DB only.
 * Synthetic candidates, no HTTP, customer data, dispatch or production access. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Client}=require('pg');
const one=async(c,q,p=[])=>(await c.query(q,p)).rows[0];
const key=c=>c.subscriber_id+'|'+c.cart_ref+'|'+c.piece;
const candidate=id=>({subscriber_id:id,cart_ref:'synthetic-cart-'+id,cart_at:new Date(Date.now()-3600000).toISOString(),phone:'55119'+String(id).padStart(8,'0'),piece:'carrinho-30min'});
const gate=async(c,rows,brand='aristo')=>(await one(c,'SELECT growth_wa_cart_holdout_gate_v1($1,$2::jsonb) AS d',[brand,JSON.stringify(rows)])).d;
const md5=s=>crypto.createHash('md5').update(s).digest('hex');
(async()=>{
 if(process.env.HOLDOUT_TEST_DATABASE_ISOLATED!=='1'||!process.env.TEST_DATABASE_URL)throw Error('Explicit isolated holdout test database required');
 const a=new Client({connectionString:process.env.TEST_DATABASE_URL}),b=new Client({connectionString:process.env.TEST_DATABASE_URL}),observer=new Client({connectionString:process.env.TEST_DATABASE_URL});
 let pending,waits=0;
 function queue(fn){assert.equal(pending,undefined);pending=fn().then(value=>({value}),error=>({error}));}
 async function receive(){const r=await pending;pending=undefined;if(r.error)throw r.error;return r.value;}
 async function locked(pid){
  for(let i=0;i<100;i++){
   await observer.query('SELECT pg_stat_clear_snapshot()');
   const r=await one(observer,'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid]);
   if(r?.wait_event_type==='Lock'){waits++;return;}
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.fail('Expected actual lock wait in an independent PostgreSQL session');
 }
 const count=async(table)=>(await one(observer,'SELECT count(*)::int AS n FROM '+table)).n;
 try{
  await a.connect();await b.connect();await observer.connect();
  for(const c of [a,b,observer])await c.query("SET statement_timeout='8s';SET lock_timeout='5s';SET timezone='UTC'");
  assert.match((await one(a,'SELECT current_database() AS name')).name,/^holdout_test(?:_[a-z0-9]+)?$/,'reserved disposable database name required');
  assert.equal((await one(a,"SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).n,0,'test database must start empty');
  const pidA=(await one(a,'SELECT pg_backend_pid() AS pid')).pid,pidB=(await one(b,'SELECT pg_backend_pid() AS pid')).pid;
  assert.notEqual(pidA,pidB);
  await a.query('CREATE TABLE shrigma_send_log(brand text,channel text,flow text,ref text,piece text,wamid text)');
  await a.query(fs.readFileSync(path.join(__dirname,'../n8n/growth/whatsapp-cart-holdout.sql'),'utf8'));
  assert.equal((await one(a,'SELECT enrollment_enabled FROM growth_wa_cart_holdout_run')).enrollment_enabled,false);
  await a.query("UPDATE growth_wa_cart_holdout_run SET enrollment_enabled=true,starts_at=now()-interval '2 hours',enrollment_ends_at=now()+interval '7 days'");

  // The second session sees the first cart's committed arm, even if its input
  // identity differs. It must not create a spare unit for the losing phone.
  const original=candidate(1),changed={...original,subscriber_id:9001,phone:'5511999999999'};
  await a.query('BEGIN');const first=await gate(a,[original]);
  queue(()=>gate(b,[changed]));await locked(pidB);await a.query('COMMIT');
  assert.deepEqual((await receive())[key(changed)],first[key(original)]);
  assert.equal(await count('growth_wa_cart_holdout_journey'),1);
  assert.equal(await count('growth_wa_cart_holdout_unit'),1);
  assert.equal(await count('growth_wa_cart_holdout_eligibility'),1);

  // Reversed overlapping batches cannot deadlock. Transaction serialization
  // happens before candidate-level locks, and retries preserve all decisions.
  const batch=[candidate(2),candidate(3),candidate(4)];
  await b.query('BEGIN');const decisions=await gate(b,batch);
  queue(()=>gate(a,[...batch].reverse()));await locked(pidA);await b.query('COMMIT');
  assert.deepEqual(await receive(),decisions);
  assert.equal(await count('growth_wa_cart_holdout_journey'),4);
  assert.equal(await count('growth_wa_cart_holdout_unit'),4);

  // The other brand can proceed while Aristo holds its enrollment transaction.
  await a.query('BEGIN');await gate(a,[candidate(5)]);
  assert.equal((await gate(b,[candidate(5)],'fish'))[key(candidate(5))].arm==='outside_experiment',false);
  await a.query('COMMIT');

  // Find a deterministic synthetic holdout and keep its transaction open.
  const salt=(await one(a,'SELECT allocation_salt FROM growth_wa_cart_holdout_run')).allocation_salt;
  let held;
  for(let i=100;i<10000;i++){
   const c=candidate(i),unit=md5(salt+'|aristo|'+c.phone);
   if(parseInt(md5('bucket|'+unit).slice(0,8),16)%10000<500){held=c;break;}
  }
  assert.ok(held);
  await a.query('BEGIN');assert.equal((await gate(a,[held]))[key(held)].send,false);
  queue(()=>b.query('UPDATE growth_wa_cart_holdout_run SET enrollment_enabled=false'));
  await locked(pidB);await a.query('COMMIT');await receive();
  const t24={...held,piece:'carrinho-24h'},newCart={...held,cart_ref:'synthetic-after-stop'};
  assert.equal((await gate(b,[t24]))[key(t24)].send,false);
  assert.equal((await gate(a,[newCart]))[key(newCart)].arm,'outside_experiment');
  assert.equal(await count('growth_wa_cart_holdout_journey'),7);

  // Protocol updates wait for an in-flight gate, then reject changes after any
  // enrollment. A stop uses enrollment_enabled; no retroactive window changes.
  await a.query('BEGIN');await gate(a,[t24]);
  queue(()=>b.query("UPDATE growth_wa_cart_holdout_run SET enrollment_ends_at=enrollment_ends_at+interval '1 day'"));
  await locked(pidB);await a.query('COMMIT');
  await assert.rejects(receive(),/HOLDOUT_PROTOCOL_ALREADY_ENROLLED/);
  assert.equal(await count('shrigma_send_log'),0,'holdout does not reserve or send');
  assert.equal(waits,4);
  console.log('PASS WhatsApp holdout PostgreSQL concurrency: 4 real lock waits, stable cart identity, reversed batches, independent brands, stop preserves control and protocol stays frozen. Synthetic only.');
 }finally{
  await Promise.allSettled([a.query('ROLLBACK'),b.query('ROLLBACK')]);if(pending)await pending;
  await Promise.allSettled([a.end(),b.end(),observer.end()]);
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
