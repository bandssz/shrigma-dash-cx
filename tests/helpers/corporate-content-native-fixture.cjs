'use strict';
// Disposable native READ/content profile. The original SQL/gateway decides
// readiness; no content-authority response or business receipt is fabricated.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Readable}=require('node:stream'),{EventEmitter}=require('node:events');
const {PGlite}=require('@electric-sql/pglite');
const G=require('../../services/crm-campaign/server.cjs'),T=require('../../services/crm-campaign/transport.cjs');
const read=p=>fs.readFileSync(path.join(__dirname,'../..',p),'utf8');
async function nativeContentFixture(t,f,{ownershipReady=true}={}){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec('CREATE TABLE public.crm_dash_chave(chave text PRIMARY KEY,painel text NOT NULL,dono text,ativo boolean DEFAULT true,revogada_em timestamptz,ultimo_uso timestamptz,usos integer DEFAULT 0);CREATE TABLE public.shrigma_template_key_v2(key_hash text,active boolean,actor text,capabilities jsonb);');
 for(const p of ['n8n/access/panel-auth.sql','n8n/access/panel-operator.sql','n8n/access/panel-short-keys.sql','tests/campaign-provider-schema.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-recovery.sql','n8n/growth/campaign-template-ownership.sql','n8n/growth/campaign-provider.sql','n8n/growth/campaign-write-guard.sql'])await db.exec(read(p));
 await db.exec('CREATE ROLE central_leitor NOLOGIN;ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO central_leitor;');await db.exec(read('tools/crm-manager-writer-review/writer-provision-v1.sql'));
 await db.exec(read('n8n/growth/crm-campaign-gateway-role.sql'));await db.exec(read('n8n/growth/crm-campaign-content-authority.sql'));
 if(!ownershipReady)await db.exec('ALTER TABLE shrigma_template_email_registry DISABLE TRIGGER shrigma_campaign_template_registry_guard_v1');
 let authorityQueries=0,businessEffects=0;
 const pool={query:async(sql,args=[])=>{if(sql===T.CONTENT_AUTHORITY_SQL)authorityQueries++;if(sql===T.EFFECT_SQL)businessEffects++;await db.exec('SET ROLE crm_campaign_api');try{return await db.query(sql,args);}finally{await db.exec('RESET ROLE');}}};
 const gateway=G.createServer({pool,enabled:true,revision:'synthetic-native-content-profile',native:async()=>{throw Error('NO_NATIVE_BUSINESS_HTTP');}});t.after(()=>gateway.server.removeAllListeners());
 async function registerReader(id){
  const binding=f.auth.managedCrmJournal.readBinding(id),slot=f.db.prepare("SELECT encrypted_key FROM upstream_credentials WHERE user_id=? AND slot='crm-panel-read'").get(id),owner=f.db.prepare('SELECT email FROM users WHERE id=?').get(id).email;
  assert.ok(binding);assert.ok(slot);const key=f.decrypt(slot.encrypted_key);
  await db.query("INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash,expira_em) VALUES($1,'growth',$2,$3,$4)",[binding.principalId,owner,crypto.createHash('sha256').update(key).digest('hex'),new Date(binding.expiresAt).toISOString()]);
  await db.query("INSERT INTO shrigma_panel_permission_v1 VALUES($1,'growth',$2::jsonb)",[binding.principalId,JSON.stringify(['read_content','list_history','submission'])]);
  return key;
 }
 const fetch=async(value,options={})=>{
  const url=new URL(value),headers=Object.fromEntries(new Headers(options.headers)),body=options.body;
  return new Promise(resolve=>{const req=Readable.from(body===undefined?[]:[Buffer.from(body)]);Object.assign(req,{url:url.pathname+url.search,method:options.method||'GET',headers,rawHeaders:Object.entries(headers).flat(),socket:{remoteAddress:'127.0.0.1'}});const res=new EventEmitter();const out={};res.writeHead=(status,h)=>{res.statusCode=status;Object.assign(out,h);};res.end=bytes=>{res.writableEnded=true;res.writableFinished=true;res.emit('finish');const response=new Response(bytes,{status:res.statusCode,headers:out});Object.defineProperty(response,'url',{value:url.href});resolve(response);};res.destroy=()=>resolve(new Response('{}',{status:503,headers:{'content-type':'application/json'}}));gateway.server.emit('request',req,res);});
 };
 return{db,fetch,registerReader,get authorityQueries(){return authorityQueries;},get businessEffects(){return businessEffects;}};
}
module.exports={nativeContentFixture};
