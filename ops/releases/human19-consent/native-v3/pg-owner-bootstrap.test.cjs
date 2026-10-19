'use strict';
// Synthetic PG17.10 only. No endpoint or credential of production is mounted.
const {test,after}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {createFixture,closeAll}=require('/delta/native-transition-fixture.cjs');
after(closeAll);
test('five exact installed definitions admit the v3 replacement and compatible return on isolated PG17.10',async()=>{
 const f=await createFixture(process.env.SHRIGMA_LOCAL_TEST_DB);
 await f.admin.query(fs.readFileSync('/delta/native-recovery-install.prepared.sql','utf8'));
 await f.admin.query("ALTER TABLE public.subscriber_lists ADD COLUMN meta jsonb NOT NULL DEFAULT '{}',ADD COLUMN created_at timestamptz,ADD COLUMN updated_at timestamptz");
 const baseline=JSON.parse(fs.readFileSync('/v3/baseline.json','utf8'));
 for(const pin of baseline.functions){
  const r=(await f.admin.query("SELECT md5(prosrc) body_md5,encode(sha256(convert_to(pg_get_functiondef(oid),'UTF8')),'hex') definition_sha256 FROM pg_proc WHERE oid=to_regprocedure($1)",[JSON.parse(fs.readFileSync('/consent/native-v3-admission.actual.safe.json')).admission.functions.find(x=>x.signature.startsWith('crm_audience_v2.'+pin.name+'(')).signature])).rows[0];
  a.equal(r.body_md5,pin.originalBodyMd5,pin.name+' body');a.equal(r.definition_sha256,pin.originalDefinitionSha256,pin.name+' definition');
 }
 const before=await f.admin.query("SELECT count(*)::integer n FROM pg_proc WHERE pronamespace='crm_audience_v2'::regnamespace");
 try{await f.admin.query(fs.readFileSync('/v3/install.owner.sql','utf8'));}catch(e){console.log(JSON.stringify({sqlstate:e.code,position:e.position,internalPosition:e.internalPosition,where:e.where,detail:e.detail}));await f.admin.query('ROLLBACK');throw e;}
 const afterInstall=await f.admin.query("SELECT count(*)::integer n FROM pg_proc WHERE pronamespace='crm_audience_v2'::regnamespace");a.equal(afterInstall.rows[0].n,before.rows[0].n);
 await f.admin.query(fs.readFileSync('/v3/return-compatible.owner.sql','utf8'));
 a.equal((await f.admin.query("SELECT count(*)::integer n FROM pg_proc WHERE pronamespace='crm_audience_v2'::regnamespace")).rows[0].n,before.rows[0].n);
 a.equal(crypto.createHash('sha256').update(fs.readFileSync('/v3/install.owner.sql')).digest('hex'),baseline.installSha256);
});
