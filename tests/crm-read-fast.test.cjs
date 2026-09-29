'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const W=require('../n8n/growth/crm-read-fast-workflow.cjs');
const SQL=fs.readFileSync(path.join(__dirname,'../n8n/growth/crm-read-fast.sql'),'utf8');
const AUTH=fs.readFileSync(path.join(__dirname,'../n8n/access/panel-auth.sql'),'utf8'),OPERATOR=fs.readFileSync(path.join(__dirname,'../n8n/access/panel-operator.sql'),'utf8'),SHORT=fs.readFileSync(path.join(__dirname,'../n8n/access/panel-short-keys.sql'),'utf8');
test('candidate is inactive, CRM-only and contains no Code or shared workflow mutation',()=>{
 const w=W.buildWorkflow({postgresCredential:{id:'fixture-id',name:'fixture postgres'}});
 assert.equal(w.active,false);for(const n of w.nodes.filter(n=>n.type==='n8n-nodes-base.webhook')){assert.equal(n.typeVersion,2,'installed n8n 2.0.2 webhook contract');assert.match(n.webhookId,/^[a-f0-9-]{36}$/);}assert.equal(W.PATH,'crm-panel-read-v1');assert.deepEqual(w.nodes.map(n=>n.type).sort(),['n8n-nodes-base.postgres','n8n-nodes-base.respondToWebhook','n8n-nodes-base.respondToWebhook','n8n-nodes-base.webhook','n8n-nodes-base.webhook'].sort());
 assert.equal(w.nodes.some(n=>n.type==='n8n-nodes-base.code'),false);assert.equal(w.nodes.filter(n=>n.type==='n8n-nodes-base.webhook').every(n=>n.parameters.path===W.PATH),true);
 assert.equal(w.settings.saveDataSuccessExecution,'none');assert.equal(w.settings.saveDataErrorExecution,'none');
});
test('Postgres call is parameterized and response keeps fixed CORS and dynamic SQL status',()=>{
 const w=W.buildWorkflow({postgresCredential:{id:'fixture-id',name:'fixture postgres'}}),pg=w.nodes.find(n=>n.type==='n8n-nodes-base.postgres'),responses=w.nodes.filter(n=>n.type==='n8n-nodes-base.respondToWebhook');
 assert.equal(pg.parameters.query,'SELECT status_code,body FROM public.shrigma_crm_read_fast_v1($1::text,$2::text,$3::jsonb)');assert.match(pg.parameters.options.queryReplacement,/authorization/);assert.match(pg.parameters.options.queryReplacement,/JSON\.stringify/);assert.doesNotMatch(pg.parameters.query,/\{\{/);
 for(const n of responses){const h=n.parameters.options.responseHeaders.entries;assert.ok(h.some(x=>x.name==='Access-Control-Allow-Origin'&&x.value===W.ORIGIN));assert.ok(h.some(x=>x.name==='Cache-Control'&&x.value==='no-store, private'));}
 assert.equal(responses.find(n=>n.name==='Resposta CRM').parameters.options.responseCode,'={{ $json.status_code }}');
});
test('SQL preserves authoritative auth, exact master identity and a fixed Growth cache row',()=>{
 assert.match(SQL,/shrigma_panel_auth_v1\(k,'growth','header'\)/);assert.match(SQL,/shrigma_panel_operator_v1\(k,'growth'\)/);assert.match(SQL,/shrigma_panel_operator_v1\(k,'influs'\)/);
 assert.match(SQL,/jsonb_build_array\('cx','growth','organico','influs'\)/);assert.match(SQL,/WHERE c\.painel='growth'/);assert.doesNotMatch(SQL,/WHERE c\.painel\s*=\s*p_/);
 assert.match(SQL,/count\(\*\) FROM jsonb_object_keys\(p_query\)/);assert.match(SQL,/p_query='null'::jsonb/);assert.match(SQL,/coalesce\(p_query->>'action',''\)/);assert.match(SQL,/REVOKE ALL ON FUNCTION public\.shrigma_crm_read_fast_v1/);
 assert.doesNotMatch(SQL,/GRANT\s+/i);assert.match(SQL,/CRM_READ_FAST_AUTH_DRIFT/);assert.match(SQL,/CRM_READ_FAST_CACHE_DRIFT/);
});
test('credential reference is mandatory and never serialized from an absent value',()=>{assert.throws(()=>W.buildWorkflow(),/credential/);});
test('real SQL enforces exact queries, authoritative identities and cache isolation',async t=>{
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE FUNCTION public.sha256(bytea) RETURNS bytea LANGUAGE sql IMMUTABLE AS 'SELECT $1';CREATE TABLE public.crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL,dono text NOT NULL,ativo boolean NOT NULL DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer NOT NULL DEFAULT 0);CREATE TABLE public.shrigma_template_key_v2(actor text,capabilities jsonb,key_hash text,active boolean);`);
 await db.exec(AUTH);await db.exec(OPERATOR);await db.exec(SHORT);
 await db.exec(`CREATE TABLE public.dash_payload_cache(painel text PRIMARY KEY,payload jsonb NOT NULL,gerado_em timestamptz NOT NULL,bytes bigint,origem_ms bigint);REVOKE ALL ON public.dash_payload_cache FROM PUBLIC;`);
 const put=async(key,panel,expires=null)=>{await db.query("INSERT INTO public.crm_dash_chave(chave,painel,dono,chave_hash,expira_em) VALUES($1,$2,$3,encode(sha256(convert_to($4,'UTF8')),'hex'),$5)",['principal-'+key,panel,'Fixture '+panel,key,expires]);};
 await put('manager-growth-key','growth');await put('master-growth-key','todos');await put('expired-growth-key','growth','2020-01-01T00:00:00Z');
 await db.query("UPDATE public.crm_dash_chave SET chave_hash_curta=encode(sha256(convert_to($1,'UTF8')),'hex') WHERE chave='principal-manager-growth-key'",['short-growth-key']);
 await db.query("UPDATE public.crm_dash_chave SET chave_hash_curta=encode(sha256(convert_to($1,'UTF8')),'hex') WHERE chave='principal-expired-growth-key'",['short-expired-key']);
 const principals=(await db.query('SELECT chave,painel FROM public.crm_dash_chave')).rows;for(const r of principals.filter(r=>r.painel!=='growth'||!r.chave.includes('expired'))){await db.query("INSERT INTO public.shrigma_panel_permission_v1(principal_id,area,caps) VALUES($1,'growth','[\"draft\"]')",[r.chave]);if(r.painel==='todos')await db.query("INSERT INTO public.shrigma_panel_permission_v1(principal_id,area,caps) VALUES($1,'influs','[\"read_creators\"]')",[r.chave]);}
 await db.query("INSERT INTO public.dash_payload_cache VALUES('growth',$1::jsonb,'2026-09-29T12:00:00Z',10,1)",[JSON.stringify({_escopo:'growth',crm_campanha:[],crm_fluxo:[],crm_conversao:[]})]);
 await db.exec(SQL);
 const read=async(auth,query,origin=null)=>(await db.query('SELECT * FROM public.shrigma_crm_read_fast_v1($1,$2,$3::jsonb)',[auth,origin,JSON.stringify(query)])).rows[0];
 for(const query of [null,[],{action:null,painel:'growth'},{action:'identity',painel:'growth',extra:1},{action:'identity'},{action:'identity',painel:'cx'}])assert.equal((await read('Bearer manager-growth-key',query)).status_code,400,JSON.stringify(query));
 for(const auth of [null,'manager-growth-key','bearer manager-growth-key','Bearer unknown-growth-key','Bearer expired-growth-key','Bearer short-expired-key'])assert.equal((await read(auth,{action:'identity',painel:'growth'})).status_code,401,String(auth));
 assert.equal((await read('Bearer manager-growth-key',{action:'identity',painel:'growth'},'https://wrong.invalid')).status_code,403);
 const manager=await read('Bearer manager-growth-key',{action:'identity',painel:'growth'});assert.equal(manager.status_code,200);assert.equal(manager.body.role,'manager');assert.deepEqual(manager.body.allowedPanels,['growth']);assert.deepEqual(manager.body.permissions.growth.caps,['draft']);assert.equal(manager.body.permissions.influs,null);
 const short=await read('Bearer short-growth-key',{action:'identity',painel:'growth'});assert.equal(short.status_code,200);assert.equal(short.body.role,'manager');assert.deepEqual(short.body.permissions.growth.caps,['draft']);
 assert.equal((await read('Bearer short-growth-wrong',{action:'identity',painel:'growth'})).status_code,401);
 const master=await read('Bearer master-growth-key',{action:'identity',painel:'growth'});assert.equal(master.status_code,200);assert.equal(master.body.role,'master');assert.deepEqual(master.body.allowedPanels,['cx','growth','organico','influs']);assert.deepEqual(master.body.permissions.growth.caps,['draft']);assert.deepEqual(master.body.permissions.influs.caps,['read_creators']);
 const cache=await read('Bearer manager-growth-key',{action:'cache_growth',painel:'growth'});assert.equal(cache.status_code,200);assert.equal(cache.body._escopo,'growth');assert.equal(cache.body._painel,'growth');assert.equal(cache.body._cache_gerado_em,'2026-09-29T12:00:00+00:00');
 await db.query("DELETE FROM public.dash_payload_cache WHERE painel='growth'");assert.equal((await read('Bearer manager-growth-key',{action:'cache_growth',painel:'growth'})).status_code,503);
 await db.exec("CREATE OR REPLACE FUNCTION public.shrigma_panel_operator_v1(k text,a text) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$SELECT NULL::jsonb$$;");
 await assert.rejects(db.exec(SQL),/CRM_READ_FAST_OPERATOR_DRIFT/);
 await db.exec(SHORT);await db.exec('GRANT EXECUTE ON FUNCTION public.shrigma_panel_auth_v1(text,text,text) TO PUBLIC');
 await assert.rejects(db.exec(SQL),/CRM_READ_FAST_AUTH_DRIFT/);
});
