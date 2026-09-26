'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const P=require('../n8n/growth/campaign-snapshot-queue-patch.cjs');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const source=read('tests/sql/campaign-snapshot-before-crm22.sql').replace(/\n$/,'');
const workflow=()=>({id:P.ID,versionId:'synthetic-version',activeVersionId:'synthetic-version',active:true,nodes:[{name:P.NODE,type:'n8n-nodes-base.postgres',parameters:{operation:'executeQuery',query:source,options:{}},credentials:{postgres:{id:'synthetic'}}},{name:'Untouched',parameters:{query:'SELECT 1'}}],connections:{fixture:true},settings:{fixture:true}});
const candidate=()=>P.patch(workflow(),{expectedVersion:'synthetic-version'}).nodes[0].parameters.query;
const schema=`
CREATE TABLE campaigns(id int PRIMARY KEY,name text,from_email text,status text,to_send int,sent int,started_at timestamptz,send_at timestamptz,created_at timestamptz,tags text[]);
CREATE TABLE campaign_lists(campaign_id int,list_id int);
CREATE TABLE links(id int,url text);
CREATE TABLE link_clicks(campaign_id int,link_id int,subscriber_id int);
CREATE TABLE campaign_views(campaign_id int,subscriber_id int);
CREATE TABLE subscribers(id int,email text);
CREATE TABLE bounces(campaign_id int,type text);
CREATE TABLE crm_campanha(marca text,canal text,campanha_id int,nome text,utm_campaign text,utm_content text,tipo text,enviado_em timestamptz,publico int,enviados int,entregues int,aberturas int,abriram int,cliques int,clicaram int,hard int,soft int,complaints int,descadastros int,truncado boolean,aberturas_provedor jsonb,cliques_provedor jsonb,cliques_link jsonb,congelado boolean,coletas_ok int,coletas_total int,coletado_em timestamptz,PRIMARY KEY(marca,canal,campanha_id));
CREATE TABLE crm_campanha_utm(marca text,campanha_id int,proof text);
INSERT INTO campaigns SELECT i,'Fixture '||i,
 CASE WHEN i IN(2,6) THEN 'fixture@fishermans.com.br' WHEN i=9 THEN 'fixture@olivasdocampo.com' ELSE 'fixture@oaristocrata.com' END,
 'scheduled',10,0,NULL,now()+interval '1 day',now()-interval '40 days',ARRAY[]::text[] FROM generate_series(1,9) i;
INSERT INTO crm_campanha_utm VALUES('aristo',1,'preserve attribution');
`;
const rows=async db=>(await db.query('SELECT * FROM crm_campanha ORDER BY marca,canal,campanha_id')).rows;
test('pure patch is tied to one version and query, changes only the snapshot node',()=>{
 const w=workflow(),before=JSON.stringify(w),out=P.patch(w,{expectedVersion:w.versionId});
 assert.equal(JSON.stringify(w),before);assert.deepEqual(out.nodes[1],w.nodes[1]);assert.deepEqual(out.connections,w.connections);assert.deepEqual(out.settings,w.settings);
 assert.deepEqual({...out.nodes[0],parameters:{...out.nodes[0].parameters,query:source}},w.nodes[0]);
 assert.match(out.nodes[0].parameters.query,/^DO \$crm22_snapshot\$/);assert.match(out.nodes[0].parameters.query,/END\n\$crm22_snapshot\$;$/);
 assert.throws(()=>P.patch(w),/VERSION/);assert.throws(()=>P.patch(w,{expectedVersion:'stale'}),/VERSION/);
 assert.throws(()=>P.patch({...w,activeVersionId:'another-published-version'},{expectedVersion:w.versionId}),/PUBLISHED_VERSION/);
 assert.throws(()=>P.patch({...w,activeVersionId:null},{expectedVersion:w.versionId}),/PUBLISHED_VERSION/);
 assert.throws(()=>P.patch({...w,id:'other'},{expectedVersion:w.versionId}),/VERSION/);
 assert.throws(()=>P.patch(out,{expectedVersion:w.versionId}),/SOURCE/);
 const changed=workflow();changed.nodes[0].parameters.query+=' ';assert.throws(()=>P.patch(changed,{expectedVersion:w.versionId}),/SOURCE/);
 const repair=P.reconcileSql(source);assert.doesNotMatch(repair,/\b(?:DELETE|TRUNCATE|INSERT|ALTER|DROP)\b/i);
 assert.match(repair,/UPDATE public\.crm_campanha/);assert.doesNotMatch(repair,/UPDATE (?:public\.)?campaigns\b/);
 assert.equal(P.brandExpression(source),P.brandExpression(out.nodes[0].parameters.query));
});
test('real SQL reconciles draft/cancel/pause/deleted, preserves valid Fish queue and all rows/history/attribution',async()=>{
 const db=new PGlite();try{
  await db.exec(schema);await db.exec(source);
  const before=await rows(db);assert.equal(before.length,9);assert.ok(before.every(r=>r.tipo==='agendada'));
  await db.exec(`UPDATE campaigns SET status='draft',send_at=NULL WHERE id=1;
    UPDATE campaigns SET status='cancelled',send_at=NULL WHERE id=3;
    UPDATE campaigns SET status='paused' WHERE id=4;
    DELETE FROM campaigns WHERE id=5;
    UPDATE campaigns SET send_at=now()+interval '3 days' WHERE id=6;
    UPDATE campaigns SET from_email='fixture@other.invalid' WHERE id=7;
    UPDATE campaigns SET status='draft',sent=4 WHERE id=8;
    UPDATE campaigns SET status='draft',send_at=NULL WHERE id=9;
    UPDATE crm_campanha SET congelado=true WHERE campanha_id IN(1,6);
    INSERT INTO crm_campanha(marca,canal,campanha_id,tipo,enviados,entregues,enviado_em,congelado) VALUES
      ('aristo','email',90,'campanha',42,41,now()-interval '20 days',true),
      ('aristo','whatsapp',91,'agendada',0,0,now(),false);`);
  const nativeBefore=(await db.query('SELECT * FROM campaigns ORDER BY id')).rows;
  const sentBefore=(await db.query('SELECT * FROM crm_campanha WHERE campanha_id=90')).rows;
  const attribution=(await db.query('SELECT * FROM crm_campanha_utm')).rows;
  await db.exec(candidate());
  let after=await rows(db),byId=id=>after.find(x=>x.campanha_id===id);
  assert.equal(after.length,11);assert.equal(byId(1).tipo,'rascunho');assert.equal(byId(3).tipo,'cancelada');assert.equal(byId(4).tipo,'pausada');
  for(const id of [5,7,8])assert.equal(byId(id).tipo,'indisponivel');
  for(const id of [2,6])assert.equal(byId(id).tipo,'agendada');
  assert.equal(byId(6).enviado_em.toISOString(),nativeBefore.find(x=>x.id===6).send_at.toISOString());
  assert.equal(byId(9).tipo,'agendada','other-brand snapshot is unchanged');
  assert.equal(byId(91).tipo,'agendada','WhatsApp snapshot is unchanged');
  assert.deepEqual((await db.query('SELECT * FROM campaigns ORDER BY id')).rows,nativeBefore);
  assert.deepEqual((await db.query('SELECT * FROM crm_campanha WHERE campanha_id=90')).rows,sentBefore);
  assert.deepEqual((await db.query('SELECT * FROM crm_campanha_utm')).rows,attribution);
  assert.equal(byId(1).enviado_em.toISOString(),before.find(x=>x.campanha_id===1).enviado_em.toISOString(),'old planned date retained as history, not as a queue');
  await db.exec(candidate());after=await rows(db);assert.equal(after.length,11);assert.equal(byId(1).tipo,'rascunho');
  await db.exec("UPDATE campaigns SET status='scheduled',send_at=now()+interval '2 days' WHERE id=1");await db.exec(candidate());after=await rows(db);assert.equal(byId(1).tipo,'agendada','reschedule is restored despite old freeze');
  await db.exec("UPDATE campaigns SET status='finished',started_at=now(),sent=10 WHERE id=1");await db.exec(candidate());after=await rows(db);assert.equal(byId(1).tipo,'campanha');assert.equal(byId(1).enviados,10,'real start replaces pending snapshot with actual metrics');
 }finally{await db.close();}
});
test('SQL uses the same list fallback as the collector and missing-date schedule remains unavailable',async()=>{
 const db=new PGlite();try{
  await db.exec(schema);await db.exec(source);
  await db.exec("UPDATE campaigns SET from_email='fixture@neutral.invalid' WHERE id IN(1,2); INSERT INTO campaign_lists VALUES(1,16),(2,17); UPDATE campaigns SET send_at=NULL WHERE id=2;");
  await db.exec(candidate());const got=await rows(db);assert.equal(got.find(x=>x.campanha_id===1).tipo,'agendada');assert.equal(got.find(x=>x.campanha_id===2).tipo,'indisponivel');
 }finally{await db.close();}
});

test('snapshot refresh and reconciliation roll back together when reconciliation fails',async()=>{
 const db=new PGlite();try{
  await db.exec(schema);await db.exec(source);
  await db.exec("UPDATE campaigns SET status='draft',send_at=NULL WHERE id=1; UPDATE campaigns SET name='Changed native name' WHERE id=2;");
  const before=await rows(db);
  await db.exec(`CREATE FUNCTION fixture_reject_draft() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tipo='rascunho' THEN RAISE EXCEPTION 'synthetic_reconciliation_failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fixture_reject_draft BEFORE UPDATE ON crm_campanha FOR EACH ROW EXECUTE FUNCTION fixture_reject_draft();`);
  await assert.rejects(db.exec(candidate()),/synthetic_reconciliation_failure/);
  assert.deepEqual(await rows(db),before,'no partially refreshed snapshot escapes');
 }finally{await db.close();}
});
