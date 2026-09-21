'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
(async()=>{const db=new PGlite();await db.exec('CREATE TABLE crm_dash_chave(chave text PRIMARY KEY,painel text,dono text,ativo boolean DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos int);CREATE TABLE shrigma_template_key_v2(key_hash text,active boolean,actor text,capabilities jsonb);');
for(const file of ['panel-auth.sql','panel-operator.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../n8n/access/',file),'utf8'));
const hash=k=>createHash('sha256').update(k).digest('hex'),roles=['cx','growth','organico','influs','todos'];
for(const p of roles)await db.query('INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash) VALUES($1,$2,$2,$3)',['id-'+p,p,hash('synthetic-'+p+'-key')]);
for(const [p,a] of [['growth','growth'],['influs','influs'],['todos','growth'],['todos','influs']])await db.query('INSERT INTO shrigma_panel_permission_v1 VALUES($1,$2,$3::jsonb)',['id-'+p,a,JSON.stringify(a==='growth'?['draft','validate','submit','read_content','list_history','submission']:['creators_edit'])]);
let checks=0;const auth=async(p,a)=>(await db.query('SELECT shrigma_panel_operator_v1($1,$2) AS a',['synthetic-'+p+'-key',a])).rows[0].a;
for(const p of roles)for(const a of ['growth','influs']){const r=await auth(p,a),yes=p===a||p==='todos';assert.equal(!!r,yes);if(r)assert.equal(r.who,'panel:id-'+p);checks++;}
for(const k of ['id-growth',hash('synthetic-growth-key'),"' OR true--",'synthetic-growth-key ']){assert.equal((await db.query("SELECT shrigma_crm_operator_auth_v1($1) AS a",[k])).rows[0].a,null);checks++;}
await db.query("UPDATE crm_dash_chave SET revogada_em=now() WHERE painel='growth'");assert.equal(await auth('growth','growth'),null);checks++;
assert.equal((await db.query("SELECT shrigma_crm_operator_auth_v1('synthetic-growth-key') AS a")).rows[0].a,null);checks++;
await db.query("UPDATE crm_dash_chave SET expira_em=now()-interval '1 minute' WHERE painel='influs'");assert.equal(await auth('influs','influs'),null);checks++;
await db.query("DELETE FROM shrigma_panel_permission_v1 WHERE principal_id='id-todos' AND area='growth'");const reader=(await db.query("SELECT shrigma_crm_operator_auth_v1('synthetic-todos-key') AS a")).rows[0].a;assert(reader&&!reader.caps.includes('draft'));checks++;
await db.query('INSERT INTO shrigma_template_key_v2 VALUES($1,true,$2,$3::jsonb)',[hash('legacy-writer'),'legacy-actor',JSON.stringify(['draft'])]);assert.equal((await db.query("SELECT shrigma_crm_operator_auth_v1('legacy-writer') AS a")).rows[0].a.who,'legacy-actor');checks++;
// A late exact read-only migration cannot replace the separate operator wrapper/grants.
await db.exec(fs.readFileSync(path.join(__dirname,'../n8n/access/panel-auth.sql'),'utf8'));assert((await auth('todos','influs')).caps.includes('creators_edit'));checks++;
console.log(JSON.stringify({checks,passed:true,live_calls:0}));await db.close();})().catch(e=>{console.error(e);process.exitCode=1;});
