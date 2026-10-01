'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const vip=fs.readFileSync(path.join(__dirname,'../n8n/growth/vip-consent.sql'),'utf8');
const origin=fs.readFileSync(path.join(__dirname,'../n8n/growth/vip-recorded-origin.sql'),'utf8');
const revisions={alma:'18c89f66553290ad878585809a6de3c149f5a4e8bb79e6c14917606db3b6794c',desodorante:'e0f9fd7a28553a448439c27f00c36aeaef9df1919cbc44b16628e6448a3b2b4b'};
const producers={alma:'NAmTWZ7vddQ8LX1k',desodorante:'ywJDsgBDhZOBgoxb'};
const setupSQL=`
CREATE SCHEMA crm_audience_v2;
CREATE FUNCTION crm_audience_v2.append_only() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'AUDIENCE_HISTORY_IMMUTABLE';END$$;
CREATE TYPE subscriber_status AS ENUM('enabled','disabled','blocklisted');
CREATE TYPE subscription_status AS ENUM('unconfirmed','confirmed','unsubscribed');
CREATE TABLE subscribers(id serial PRIMARY KEY,uuid uuid UNIQUE NOT NULL,email text UNIQUE NOT NULL,name text NOT NULL,status subscriber_status NOT NULL,attribs jsonb NOT NULL DEFAULT '{}',updated_at timestamptz DEFAULT now(),UNIQUE(id,uuid));
CREATE TABLE lists(id integer PRIMARY KEY);
CREATE TABLE subscriber_lists(subscriber_id integer REFERENCES subscribers(id),list_id integer REFERENCES lists(id),meta jsonb NOT NULL DEFAULT '{}',status subscription_status NOT NULL,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(subscriber_id,list_id));
INSERT INTO lists VALUES(16),(19);
`;
const email=x=>x+'@example.invalid',event=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
async function fixture(t){
 const db=new PGlite();t.after(()=>db.close());await db.exec(setupSQL);await db.exec(vip);await db.exec(origin);return db;
}
async function configure(db,source,{enabled=false,scope=source==='alma'?'ae831c8c-318d-43ca-a809-eb5039dc51bc':'789b51cc-4f88-419c-adb4-f621bfbb31cf',coverage=new Date(Date.now()-1000).toISOString(),revision=revisions[source]}={}){
 const canonical=source==='alma'?'vip_alma':'vip_desodorante';await db.query('INSERT INTO crm_audience_v2.recorded_origin_source(canonical_origin,scope_id,producer_id,producer_revision,coverage_started_at,enabled) VALUES($1,$2,$3,$4,$5,$6)',[canonical,scope,producers[source],revision,coverage,enabled]);
}
async function enable(db,source){await db.query('UPDATE crm_audience_v2.recorded_origin_source SET enabled=true WHERE producer_id=$1',[producers[source]]);}
async function call(db,{label='person',source='alma',id=1,originValue='lp-alma-da-roca',corrected=false,revision=revisions[source]}={}){
 return (await db.query('SELECT * FROM crm_audience_v2.recorded_origin_subscribe_v2($1,$2,$3,$4,$5,$6)',[email(label),originValue,corrected,source,event(id),revision])).rows[0];
}
async function seed(db,label,{uuid='10000000-0000-4000-8000-000000000001',status='enabled',l16='confirmed',l19='confirmed'}={}){
 const s=(await db.query("INSERT INTO subscribers(uuid,email,name,status,attribs) VALUES($1,$2,'Synthetic',$3,'{\"keep\":true}') RETURNING id,uuid",[uuid,email(label),status])).rows[0];
 for(const [lid,ms]of [[16,l16],[19,l19]])if(ms)await db.query("INSERT INTO subscriber_lists(subscriber_id,list_id,status) VALUES($1,$2,$3)",[s.id,lid,ms]);return s;
}

test('installation pins the exact consent implementation and leaves zero partial DDL on drift',async t=>{
 const db=new PGlite();t.after(()=>db.close());await db.exec(setupSQL);await db.exec(vip.replace('-- Preserve upstream normalization','-- Synthetic semantic drift'));
 await assert.rejects(db.exec(origin),/RECORDED_ORIGIN_CONSENT_DRIFT/);await db.exec('ROLLBACK');assert.equal((await db.query("SELECT to_regclass('crm_audience_v2.recorded_origin_source') value")).rows[0].value,null);assert.equal((await db.query("SELECT to_regprocedure('crm_audience_v2.recorded_origin_subscribe_v2(text,text,boolean,text,uuid,text)') value")).rows[0].value,null);
});

test('install creates no fictional coverage; configured source remains OFF until explicitly enabled, then records positive receipt',async t=>{
 const db=await fixture(t);assert.deepEqual((await db.query('SELECT canonical_origin,enabled FROM crm_audience_v2.recorded_origin_source ORDER BY canonical_origin')).rows,[]);await configure(db,'alma');assert.deepEqual((await db.query('SELECT canonical_origin,enabled FROM crm_audience_v2.recorded_origin_source')).rows,[{canonical_origin:'vip_alma',enabled:false}]);
 await db.query("UPDATE crm_audience_v2.recorded_origin_source SET scope_id='ae831c8c-318d-43ca-a809-eb5039dc51bd',producer_revision=$2,coverage_started_at=date_trunc('milliseconds',clock_timestamp()-interval '2 seconds') WHERE producer_id=$1",[producers.alma,'f'.repeat(64)]);
 await db.query("UPDATE crm_audience_v2.recorded_origin_source SET scope_id='ae831c8c-318d-43ca-a809-eb5039dc51bc',producer_revision=$2,coverage_started_at=date_trunc('milliseconds',clock_timestamp()-interval '1 second') WHERE producer_id=$1",[producers.alma,revisions.alma]);
 await assert.rejects(configure(db,'desodorante',{enabled:true,coverage:new Date(Date.now()+60000).toISOString()}),/RECORDED_ORIGIN_COVERAGE_FUTURE/);
 let r=await call(db);assert.equal(r.eligible,false);assert.equal(r.reason,'source_unavailable');assert.equal(Number((await db.query('SELECT count(*) n FROM subscribers')).rows[0].n),0);
 const existing=await seed(db,'existing');await enable(db,'alma');r=await call(db,{label:'existing',id:2});assert.equal(r.eligible,true);assert.equal(r.reason,'eligible');assert.deepEqual(Object.keys(r).sort(),['accepted_at','eligible','event_id','producer_id','reason','receipt_hash']);assert.match(r.receipt_hash,/^[0-9a-f]{64}$/);
 const stored=(await db.query('SELECT subscriber_uuid,payload_hash FROM crm_audience_v2.recorded_origin_receipt')).rows[0];assert.equal(stored.subscriber_uuid,existing.uuid);assert.equal(stored.payload_hash,r.receipt_hash);assert.ok(!JSON.stringify(r).includes('example.invalid'));assert.ok(!JSON.stringify(r).includes(existing.uuid));
 const read=(await db.query('SELECT * FROM crm_audience_v2.recorded_origin_operation_v2($1,$2)',[producers.alma,event(2)])).rows[0];assert.equal(read.found,true);assert.equal(read.reason,'accepted');assert.equal(read.receipt_hash,r.receipt_hash);assert.ok(!JSON.stringify(read).includes(existing.uuid));
 await db.query("UPDATE subscribers SET uuid='10000000-0000-4000-8000-000000000099' WHERE id=$1",[existing.id]);assert.equal((await db.query('SELECT subscriber_uuid FROM crm_audience_v2.recorded_origin_receipt')).rows[0].subscriber_uuid,existing.uuid);assert.equal(Number((await db.query('SELECT count(*) n FROM crm_audience_v2.recorded_origin_receipt r JOIN subscribers s ON s.id=r.subscriber_id AND s.uuid=r.subscriber_uuid')).rows[0].n),0);
});

test('exact replay is read-equivalent but ineligible; email, origin, correction and revision drift fail closed',async t=>{
 const db=await fixture(t);await configure(db,'alma',{enabled:true});const first=await call(db,{id:3,corrected:true});assert.equal(first.eligible,true);
 const replay=await call(db,{id:3,corrected:true});assert.equal(replay.eligible,false);assert.equal(replay.reason,'replayed');assert.equal(replay.receipt_hash,first.receipt_hash);assert.equal(new Date(replay.accepted_at).getTime(),new Date(first.accepted_at).getTime());assert.equal(Number((await db.query('SELECT count(*) n FROM crm_audience_v2.recorded_origin_receipt')).rows[0].n),1);
 for(const change of [{originValue:'changed'},{corrected:false},{revision:'0'.repeat(64)},{label:'another'}])await assert.rejects(call(db,{id:3,corrected:true,...change}),/RECORDED_ORIGIN_REPLAY_MISMATCH/);
 assert.equal(Number((await db.query('SELECT count(*) n FROM crm_audience_v2.recorded_origin_receipt')).rows[0].n),1);
 const absent=(await db.query('SELECT * FROM crm_audience_v2.recorded_origin_operation_v2($1,$2)',[producers.alma,event(99)])).rows[0];assert.equal(absent.found,false);assert.equal(absent.reason,'not_found');assert.equal(absent.receipt_hash,null);
});

test('opt-out and revision/source refusal create no receipt and never reconfirm native state',async t=>{
 const db=await fixture(t);await configure(db,'alma',{enabled:true});
 for(const [n,options,reason]of [[10,{status:'blocklisted'},'subscriber_unavailable'],[11,{l16:'unsubscribed'},'list_unsubscribed'],[12,{l19:'unconfirmed'},'list_unconfirmed']]){
  await seed(db,'blocked-'+n,{uuid:`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`,...options});const r=await call(db,{label:'blocked-'+n,id:n});assert.equal(r.eligible,false);assert.equal(r.reason,reason);
 }
 let r=await call(db,{label:'revision',id:13,revision:'0'.repeat(64)});assert.equal(r.eligible,false);assert.equal(r.reason,'producer_revision_changed');
 await db.query('UPDATE crm_audience_v2.recorded_origin_source SET enabled=false WHERE producer_id=$1',[producers.alma]);r=await call(db,{label:'disabled-source',id:14});assert.equal(r.reason,'source_unavailable');
 assert.equal(Number((await db.query('SELECT count(*) n FROM crm_audience_v2.recorded_origin_receipt')).rows[0].n),0);
 const states=(await db.query("SELECT status::text FROM subscriber_lists ORDER BY subscriber_id,list_id")).rows.map(x=>x.status);assert.ok(states.includes('unsubscribed'));assert.ok(states.includes('unconfirmed'));
});

test('receipt failure rolls back subscriber/list changes; history and configured scope become immutable',async t=>{
 const db=await fixture(t);await configure(db,'alma',{enabled:true});await db.exec("CREATE FUNCTION reject_origin_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'SYNTHETIC_RECEIPT_FAILURE';END$$;CREATE TRIGGER reject_origin_receipt BEFORE INSERT ON crm_audience_v2.recorded_origin_receipt FOR EACH ROW EXECUTE FUNCTION reject_origin_receipt()");
 await assert.rejects(call(db,{label:'rollback',id:20}),/SYNTHETIC_RECEIPT_FAILURE/);assert.equal(Number((await db.query('SELECT count(*) n FROM subscribers WHERE email=$1',[email('rollback')])).rows[0].n),0);await db.exec('DROP TRIGGER reject_origin_receipt ON crm_audience_v2.recorded_origin_receipt');
 await call(db,{label:'fixed',id:21});await assert.rejects(db.query("UPDATE crm_audience_v2.recorded_origin_source SET coverage_started_at=coverage_started_at-interval '1 day' WHERE producer_id=$1",[producers.alma]),/RECORDED_ORIGIN_SCOPE_IMMUTABLE/);await assert.rejects(db.query("UPDATE crm_audience_v2.recorded_origin_source SET producer_revision=$2 WHERE producer_id=$1",[producers.alma,'f'.repeat(64)]),/RECORDED_ORIGIN_SCOPE_IMMUTABLE/);
 await assert.rejects(db.exec('UPDATE crm_audience_v2.recorded_origin_receipt SET accepted_at=accepted_at'),/AUDIENCE_HISTORY_IMMUTABLE/);await assert.rejects(db.exec('DELETE FROM crm_audience_v2.recorded_origin_receipt'),/AUDIENCE_HISTORY_IMMUTABLE/);
 await db.query('UPDATE crm_audience_v2.recorded_origin_source SET enabled=false WHERE producer_id=$1',[producers.alma]);assert.equal((await db.query('SELECT enabled FROM crm_audience_v2.recorded_origin_source WHERE producer_id=$1',[producers.alma])).rows[0].enabled,false);
});

test('PUBLIC has no tables or functions; an explicitly granted producer can call only the two definer APIs',async t=>{
 const db=await fixture(t);await configure(db,'alma',{enabled:true});await db.exec("CREATE ROLE synthetic_vip_producer;GRANT USAGE ON SCHEMA crm_audience_v2 TO synthetic_vip_producer;GRANT EXECUTE ON FUNCTION crm_audience_v2.recorded_origin_subscribe_v2(text,text,boolean,text,uuid,text),crm_audience_v2.recorded_origin_operation_v2(text,uuid) TO synthetic_vip_producer;SET ROLE synthetic_vip_producer");
 try{
  const r=await call(db,{label:'role',id:30});assert.equal(r.eligible,true);assert.equal((await db.query('SELECT * FROM crm_audience_v2.recorded_origin_operation_v2($1,$2)',[producers.alma,event(30)])).rows[0].found,true);
  await assert.rejects(db.exec('SELECT * FROM crm_audience_v2.recorded_origin_source'),/permission denied/i);await assert.rejects(db.exec('SELECT * FROM crm_audience_v2.recorded_origin_receipt'),/permission denied/i);await assert.rejects(db.query('SELECT * FROM public.shrigma_crm_vip_subscribe_v1($1,$2,$3,$4)',[email('direct'),'lp',false,'alma']),/permission denied/i);
 }finally{await db.exec('RESET ROLE');}
 const acl=(await db.query("SELECT p.proname,coalesce(bool_or(a.grantee=0 AND a.privilege_type='EXECUTE'),false) public_execute FROM pg_proc p LEFT JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a ON true WHERE p.oid IN('crm_audience_v2.recorded_origin_subscribe_v2(text,text,boolean,text,uuid,text)'::regprocedure,'crm_audience_v2.recorded_origin_operation_v2(text,uuid)'::regprocedure) GROUP BY p.proname ORDER BY p.proname")).rows;assert.ok(acl.every(x=>x.public_execute===false));
});
