'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{gunzipSync}=require('node:zlib'),{Client,Pool}=require('pg');
const {createServer,ORIGIN}=require('../services/crm-panel-read/server.cjs');

const ROOT=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_PANEL_READ_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');

const owner=new Pool({connectionString:uri,max:4,statement_timeout:20000,connectionTimeoutMillis:3000,application_name:'crm-panel-read-owner-proof'});
let restricted,app;
const exec=sql=>owner.query(sql);
async function request(pathname,key,{gzip=true}={}){
 return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:app.server.address().port,path:pathname,method:'GET',headers:{Authorization:`Bearer ${key}`,Origin:ORIGIN,...(gzip?{'Accept-Encoding':'gzip'}:{})}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{try{const wire=Buffer.concat(chunks),raw=res.headers['content-encoding']==='gzip'?gunzipSync(wire):wire;resolve({status:res.statusCode,headers:res.headers,wire:wire.length,raw:raw.length,body:raw.length?JSON.parse(raw):null});}catch(e){reject(e);}});});req.on('error',reject);req.end();});
}

(async()=>{const proof={postgres:null,loopback:true,nondefault_port:u.port!=='5432',role:{nologin_before_proof:false,restricted:false,connection_limit:null,memberships_zero:false,explicit_grants_exact:false},http:{manager:false,short:false,master:false,cache_gzip:false,fresh_revocation:false},direct_tables_denied:false,production_changed:false,sends:0};try{
 proof.postgres=(await owner.query("SELECT current_setting('server_version') v")).rows[0].v;assert.match(proof.postgres,/^17\.10/);
 await exec('CREATE EXTENSION pgcrypto');
 await exec("CREATE FUNCTION public.sha256(bytea) RETURNS bytea LANGUAGE sql IMMUTABLE PARALLEL SAFE AS 'SELECT digest($1,''sha256'')'");
 await exec(`CREATE TABLE public.crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL,dono text NOT NULL,ativo boolean NOT NULL DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer NOT NULL DEFAULT 0);CREATE TABLE public.shrigma_template_key_v2(actor text,capabilities jsonb,key_hash text,active boolean);`);
 for(const file of ['n8n/access/panel-auth.sql','n8n/access/panel-operator.sql','n8n/access/panel-short-keys.sql'])await exec(read(file));
 await exec(`CREATE TABLE public.dash_payload_cache(painel text PRIMARY KEY,payload jsonb NOT NULL,gerado_em timestamptz NOT NULL,bytes bigint,origem_ms bigint);REVOKE ALL ON public.dash_payload_cache FROM PUBLIC;`);
 const put=async(key,panel,expires=null)=>owner.query("INSERT INTO public.crm_dash_chave(chave,painel,dono,chave_hash,expira_em) VALUES($1,$2,$3,encode(sha256(convert_to($4,'UTF8')),'hex'),$5)",['principal-'+key,panel,'Fixture '+panel,key,expires]);
 await put('manager-growth-key','growth');await put('master-growth-key','todos');await put('revoked-growth-key','growth');
 await owner.query("UPDATE public.crm_dash_chave SET chave_hash_curta=encode(sha256(convert_to($1,'UTF8')),'hex') WHERE chave='principal-manager-growth-key'",['short-growth-key']);
 for(const row of (await owner.query('SELECT chave,painel FROM public.crm_dash_chave')).rows){await owner.query("INSERT INTO public.shrigma_panel_permission_v1 VALUES($1,'growth','[\"draft\"]')",[row.chave]);if(row.painel==='todos')await owner.query("INSERT INTO public.shrigma_panel_permission_v1 VALUES($1,'influs','[\"read_creators\"]')",[row.chave]);}
 const payload={_escopo:'growth',crm_campanha:[{id:'fixture',name:'x'.repeat(20000)}],crm_fluxo:[],crm_conversao:[]};
 await owner.query("INSERT INTO public.dash_payload_cache VALUES('growth',$1::jsonb,'2026-09-29T12:00:00Z',$2,1)",[JSON.stringify(payload),Buffer.byteLength(JSON.stringify(payload))]);
 await exec(read('n8n/growth/crm-read-fast.sql'));await exec(read('n8n/growth/crm-panel-reader-role.sql'));
 const attrs=(await owner.query("SELECT rolcanlogin,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconnlimit FROM pg_roles WHERE rolname='crm_panel_reader'")).rows[0];assert.deepEqual(attrs,{rolcanlogin:false,rolsuper:false,rolinherit:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false,rolconnlimit:4});proof.role.nologin_before_proof=true;proof.role.connection_limit=attrs.rolconnlimit;
 assert.equal((await owner.query("SELECT count(*)::int n FROM pg_auth_members WHERE roleid='crm_panel_reader'::regrole OR member='crm_panel_reader'::regrole")).rows[0].n,0);proof.role.memberships_zero=true;
 const grants=(await owner.query("SELECT routine_schema,routine_name,privilege_type FROM information_schema.role_routine_grants WHERE grantee='crm_panel_reader' ORDER BY 1,2,3")).rows;assert.deepEqual(grants,[{routine_schema:'public',routine_name:'shrigma_crm_read_fast_v1',privilege_type:'EXECUTE'}]);
 assert.equal((await owner.query("SELECT count(*)::int n FROM information_schema.role_table_grants WHERE grantee='crm_panel_reader'")).rows[0].n,0);assert.equal((await owner.query("SELECT count(*)::int n FROM information_schema.column_privileges WHERE grantee='crm_panel_reader'")).rows[0].n,0);proof.role.explicit_grants_exact=true;
 const deniedUri=new URL(uri);deniedUri.username='crm_panel_reader';deniedUri.password='local-proof-only';const denied=new Client({connectionString:deniedUri.href,connectionTimeoutMillis:1000});await assert.rejects(denied.connect(),e=>e.code==='28000');
 await exec("ALTER ROLE crm_panel_reader LOGIN PASSWORD 'local-proof-only'");
 restricted=new Pool({connectionString:deniedUri.href,max:4,statement_timeout:8000,connectionTimeoutMillis:3000,application_name:'crm-panel-read-http-proof'});restricted.on('error',()=>{});
 assert.equal((await restricted.query('SELECT current_user role')).rows[0].role,'crm_panel_reader');proof.role.restricted=true;
 for(const sql of ['SELECT * FROM public.crm_dash_chave','SELECT * FROM public.dash_payload_cache','SELECT * FROM public.shrigma_panel_permission_v1','UPDATE public.crm_dash_chave SET ativo=false'])await assert.rejects(restricted.query(sql),e=>e.code==='42501');proof.direct_tables_denied=true;
 app=createServer({pool:restricted,revision:'a'.repeat(40),enabled:true,deadlineMs:9000});await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
 const identityPath='/read?action=identity&painel=growth',cachePath='/read?action=cache_growth&painel=growth';
 const manager=await request(identityPath,'manager-growth-key');assert.equal(manager.status,200);assert.equal(manager.body.role,'manager');assert.deepEqual(manager.body.allowedPanels,['growth']);proof.http.manager=true;
 const short=await request(identityPath,'short-growth-key');assert.equal(short.status,200);assert.equal(short.body.role,'manager');proof.http.short=true;
 const master=await request(identityPath,'master-growth-key');assert.equal(master.status,200);assert.equal(master.body.role,'master');assert.deepEqual(master.body.allowedPanels,['cx','growth','organico','influs']);assert.deepEqual(master.body.permissions.influs.caps,['read_creators']);proof.http.master=true;
 const cached=await request(cachePath,'manager-growth-key');assert.equal(cached.status,200);assert.equal(cached.headers['content-encoding'],'gzip');assert.ok(cached.wire<cached.raw);assert.equal(cached.body._escopo,'growth');assert.equal(cached.body.crm_campanha[0].name.length,20000);proof.http.cache_gzip=true;
 assert.equal((await request(identityPath,'revoked-growth-key')).status,200);await owner.query("UPDATE public.crm_dash_chave SET revogada_em=clock_timestamp() WHERE chave='principal-revoked-growth-key'");assert.equal((await request(identityPath,'revoked-growth-key')).status,401);proof.http.fresh_revocation=true;
 console.log(JSON.stringify(proof));
}finally{if(app)await app.stop();if(restricted)await restricted.end();await owner.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
