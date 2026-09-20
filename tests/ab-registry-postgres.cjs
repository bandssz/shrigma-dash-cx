'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const SCHEMA=`CREATE TABLE crm_teste(teste_id text PRIMARY KEY,marca text NOT NULL,canal text NOT NULL,nome text NOT NULL,hipotese text NOT NULL,variavel text NOT NULL,metrica_primaria text NOT NULL,efeito_minimo numeric,criado_em timestamptz NOT NULL DEFAULT now(),iniciado_em timestamptz,encerrado_em timestamptz,vencedor text,conclusao text,status text NOT NULL DEFAULT 'rascunho');
 CREATE TABLE crm_teste_braco(teste_id text NOT NULL REFERENCES crm_teste(teste_id) ON DELETE CASCADE,braco text NOT NULL,campanha_id integer,utm_term text NOT NULL,descricao text,PRIMARY KEY(teste_id,braco));
 INSERT INTO crm_teste(teste_id,marca,canal,nome,hipotese,variavel,metrica_primaria,status) VALUES('historical','fish','email','fixture','fixture','assunto','ctor','rodando');
 INSERT INTO crm_teste_braco VALUES('historical','a',NULL,'a',NULL),('historical','b',NULL,'b',NULL);`;
const SQL=fs.readFileSync(path.join(__dirname,'../n8n/growth/ab-registry.sql'),'utf8');
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function input(n,id='fixture-'+n){const req={acao:'criar',expected_version:0,teste:{teste_id:id,marca:'fish',canal:'email',nome:'Fixture only',hipotese:'Descriptive comparison',variavel:'assunto',metrica_primaria:'ctor',efeito_minimo:1},bracos:[{braco:'a',campanha_id:null,utm_term:'a',descricao:null},{braco:'b',campanha_id:null,utm_term:'b',descricao:''}]};return {actor_sha256:'a'.repeat(64),operation_id:uuid(n),action:'criar',teste_id:id,request_payload:req};}
function close(n,id,version){return {actor_sha256:'a'.repeat(64),operation_id:uuid(n),action:'encerrar',teste_id:id,request_payload:{acao:'encerrar',expected_version:version,teste:{teste_id:id,status:'inconclusivo',vencedor:null,conclusao:'manual descriptive note'},bracos:null}};}
async function suite(db){
 const run=async(mode,p)=>(await db.query('SELECT crm_ab_registry_v1($1,$2::jsonb) AS result',[mode,JSON.stringify(p)])).rows[0].result;
 const record=id=>run('record',{actor_sha256:'a'.repeat(64),teste_id:id});
 await db.exec(SCHEMA);const historical=(await db.query("SELECT to_jsonb(t) AS row FROM crm_teste t WHERE teste_id='historical'")).rows[0].row;
 await db.exec(SQL);await db.exec(SQL);let h=(await record('historical')).body.record;assert.equal(h.teste.registry_version,0);delete h.teste.registry_version;assert.deepEqual(h.teste,historical);
 assert.equal((await run('operation',input(1))).body.operation.state,'missing');
 let p=input(1),saved=await run('write',p);assert.equal(saved.status,200);assert.equal(saved.body.version,1);assert.equal(saved.body.record.bracos.length,2);
 // Lost response recovers the exact durable receipt; identical replay has no new mutation.
 assert.deepEqual(await run('write',p),saved);assert.deepEqual((await run('operation',p)).body.operation.response,saved);
 assert.equal((await run('operation',{...p,actor_sha256:'b'.repeat(64)})).body.operation.state,'missing');
 assert.equal((await run('operation',{...p,action:'encerrar'})).body.operation.state,'missing');
 assert.equal((await run('write',{...p,actor_sha256:'b'.repeat(64)})).body.code,'operation_identity_conflict');
 assert.equal((await run('write',{...p,request_payload:{...p.request_payload,teste:{...p.request_payload.teste,nome:'changed'}}})).body.code,'operation_identity_conflict');
 assert.equal((await run('write',input(2,p.teste_id))).body.code,'record_exists');assert.deepEqual((await record(p.teste_id)).body.record,saved.body.record);
 assert.equal((await run('write',close(3,p.teste_id,0))).body.code,'version_conflict');assert.equal((await run('write',close(4,'missing',0))).body.code,'record_missing');
 const closed=await run('write',close(5,p.teste_id,1));assert.equal(closed.body.version,2);assert.equal(closed.body.record.teste.status,'inconclusivo');assert.equal(closed.body.record.teste.vencedor,null);
 assert.deepEqual(closed.body.record.bracos,saved.body.record.bracos);assert.deepEqual(await run('write',close(5,p.teste_id,1)),closed);
 assert.equal((await run('write',close(6,p.teste_id,2))).body.code,'record_not_running');
 assert.equal((await run('write',close(7,'historical',0))).body.version,1,'legacy baseline can be closed once with explicit version0; no retroactive freeze asserted');
 for(const q of ["UPDATE crm_teste SET nome='legacy overwrite' WHERE teste_id='historical'","DELETE FROM crm_teste_braco WHERE teste_id='historical'","INSERT INTO crm_teste_braco VALUES('historical','c',NULL,'c',NULL)","DELETE FROM crm_teste WHERE teste_id='historical'"])await assert.rejects(db.exec(q),/AB_REGISTRY_MANAGED_WRITE_REQUIRED/);
 // A terminal receipt cannot authorize direct DML through a leftover session marker.
 for(const marker of ['', 'not-a-uuid', uuid(1)]){await db.query("SELECT set_config('shrigma.ab_operation_v1',$1,false)",[marker]);await assert.rejects(db.exec("UPDATE crm_teste SET nome='bypass' WHERE teste_id='fixture-1'"),/AB_REGISTRY_MANAGED_WRITE_REQUIRED/);}
 // Roll back both the record and receipt when final storage fails.
 await db.exec(`CREATE FUNCTION fail_ab_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.state='completed' THEN RAISE EXCEPTION 'synthetic receipt failure';END IF;RETURN NEW;END$$; CREATE TRIGGER fail_receipt BEFORE UPDATE ON crm_ab_operation_v1 FOR EACH ROW EXECUTE FUNCTION fail_ab_receipt();`);
 await assert.rejects(run('write',input(8)),/synthetic receipt failure/);assert.equal((await record('fixture-8')).body.record,null);assert.equal((await run('operation',input(8))).body.operation.state,'missing');await db.exec('DROP TRIGGER fail_receipt ON crm_ab_operation_v1');
 const quote=input(9);quote.request_payload.teste.nome="fixture'; DELETE FROM crm_teste; --";assert.equal((await run('write',quote)).body.record.teste.nome,quote.request_payload.teste.nome);
 for(const req of [{...input(10).request_payload,expected_version:'0'},{...input(10).request_payload,bracos:[input(10).request_payload.bracos[0],input(10).request_payload.bracos[0]]},{...input(10).request_payload,teste:{...input(10).request_payload.teste,efeito_minimo:true}}])await assert.rejects(run('write',{...input(10),request_payload:req}));
 await assert.rejects(run('write',{...close(11,'fixture-9',1),request_payload:{...close(11,'fixture-9',1).request_payload,teste:{...close(11,'fixture-9',1).request_payload.teste,status:'conclusivo',vencedor:'a'}}}),/AB_INVALID_CLOSE/);
 await db.exec(SQL);assert.deepEqual((await run('operation',input(1))).body.operation.response,saved);
 await db.exec('CREATE ROLE synthetic_ab_reader; SET ROLE synthetic_ab_reader');await assert.rejects(record('historical'),/permission denied/);await db.exec('RESET ROLE');
 console.log('PASS A/B registry SQL: atomic record/arms/receipt, same identity replay, CAS, legacy baseline, direct-write fence, rollback, preserved history and restricted execution; no experimental allocation or transport.');
}
module.exports={SCHEMA,SQL,uuid,input,close,suite};
if(require.main===module)(async()=>{const {PGlite}=require('@electric-sql/pglite');const db=new PGlite();try{await suite(db);}finally{await db.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
