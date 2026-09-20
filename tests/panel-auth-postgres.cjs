'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
(async()=>{
 const db=new PGlite();await db.exec(`CREATE TABLE crm_dash_chave(chave text PRIMARY KEY,painel text,dono text,ativo boolean DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer DEFAULT 0);CREATE TABLE shrigma_template_key_v2(key_hash text,active boolean,actor text,capabilities jsonb);`);
 await db.exec(fs.readFileSync(path.join(__dirname,'../n8n/access/panel-auth.sql'),'utf8'));
 const digest=x=>createHash('sha256').update(x).digest('hex');const panels=['cx','growth','organico','influs','todos'];
 for(const p of panels)await db.query('INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash) VALUES($1,$2,$3,$4)',['id-'+p,p,'Synthetic '+p,digest('synthetic-'+p+'-reader-key')]);
 let checks=0;
 const auth=async(k,p,t='header')=>(await db.query('SELECT * FROM shrigma_panel_auth_v1($1,$2,$3)',[k,p,t])).rows;
 for(const principal of panels)for(const target of panels){const rows=await auth('synthetic-'+principal+'-reader-key',target);assert.equal(rows.length,principal==='todos'||principal===target?1:0,principal+' -> '+target);checks++;}
 for(const k of ['synthetic-growth-reader-key!',' SYNTHETIC-growth-reader-key','id-growth',digest('synthetic-growth-reader-key'),"' OR true--"]){assert.equal((await auth(k,'growth')).length,0);checks++;}
 assert.equal((await auth('synthetic-growth-reader-key','growth','legacy')).length,0);checks++;
 await db.query("UPDATE crm_dash_chave SET revogada_em=now() WHERE painel='cx'");assert.equal((await auth('synthetic-cx-reader-key','cx')).length,0);checks++;
 await db.query("UPDATE crm_dash_chave SET expira_em=now()-interval '1 minute' WHERE painel='organico'");assert.equal((await auth('synthetic-organico-reader-key','organico')).length,0);checks++;
 const a=(await db.query("SELECT shrigma_template_auth_v2('synthetic-growth-reader-key') a")).rows[0].a;
 assert(a&&Array.isArray(a.caps)&&!a.caps.some(c=>['draft','submit','activate','schedule'].includes(c)));checks++;
 assert.equal((await db.query("SELECT shrigma_template_auth_v2('synthetic-influs-reader-key') a")).rows[0].a,null);checks++;
 await db.query('INSERT INTO crm_dash_chave(chave,painel,dono) VALUES($1,$2,$3)',['legacy-reader-key','cx','Synthetic legacy']);assert.equal((await auth('legacy-reader-key','cx','legacy')).length,1);checks++;
 console.log(JSON.stringify({checks,passed:true,live_calls:0,commercial_writes:0}));await db.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
