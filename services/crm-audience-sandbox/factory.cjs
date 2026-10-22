'use strict';
// A disposable HTTP exercise of the real audience store/API. The only database
// is PGlite in a dedicated volume; no outbound client or background task exists.
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {PGlite}=require('@electric-sql/pglite');
const Fixture=require('../../tests/segment-audience-store-fixture.cjs');
const Audience=require('../../n8n/growth/segment-audience-store.cjs');
const API=require('../../n8n/growth/segment-audience-api.cjs');
const Contract=require('../../n8n/growth/segment-audience-contract.js');
const {createServer:audienceHTTP}=require('../crm-audience/server.cjs');
const {fixture}=require('../dashboard-operational/fixtures.cjs');

const PUBLIC_ORIGIN='https://dashboard-crm-sandbox-20261002.tazdb8.easypanel.host';
const SCHEMA='crm-audience-sandbox-state-v1';
const SOURCE_FILES=Object.freeze([
 'services/crm-audience-sandbox/factory.cjs',
 'services/crm-audience-sandbox/main.cjs',
 'services/crm-audience-sandbox/package-lock.json',
 'services/crm-audience/server.cjs',
 'services/dashboard-operational/fixtures.cjs',
 'tests/segment-audience-store-fixture.cjs',
 'tests/fixtures/journey-graph-auth.sql',
 'n8n/access/panel-short-keys.sql',
 'n8n/growth/campaign-provider.sql',
 'n8n/growth/segment-audience-store.sql',
 'n8n/growth/segment-audience-store.cjs',
 'n8n/growth/segment-audience-api.cjs',
 'n8n/growth/segment-audience-review.cjs',
 'n8n/growth/segment-audience-contract.js',
 'n8n/growth/segment-shopify-facts.cjs',
 'n8n/growth/segment-shopify-rfm.cjs',
 'n8n/growth/segment-recorded-origin.cjs'
]);
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const same=(a,b)=>crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
const fail=()=>{throw Error('CRM_SANDBOX_STATE_INVALID');};
const safeSource=()=>({currency:null,timezone:null,shop_id:null,fields:Object.keys(Contract.FIELDS).map(key=>({key,available:false,source_hash:null})),products:[],origins:[]});
const expectedCaps={writer:['draft','read_content'],reader:['read_content']};
function pins(){
 const root=path.resolve(__dirname,'../..');
 return Object.fromEntries(SOURCE_FILES.map(name=>[name,sha(fs.readFileSync(path.join(root,name)))]));
}
function validateSettings({root,owner,publicOrigin,revision,credentials}){
 if(typeof root!=='string'||!path.isAbsolute(root)||typeof owner!=='string'||!/^[a-z0-9._%+-]{1,100}@synthetic\.invalid$/.test(owner)||publicOrigin!==PUBLIC_ORIGIN||typeof revision!=='string'||!/^[a-f0-9]{40}$/.test(revision)||!credentials||!['writer','reader'].every(k=>typeof credentials[k]==='string'&&/^[a-f0-9]{64}$/.test(credentials[k]))||credentials.writer===credentials.reader)throw Error('CRM_SANDBOX_CONFIG');
 const s=fs.lstatSync(root);if(!s.isDirectory()||s.isSymbolicLink())fail();
}
function writePrivate(file,value){
 const fd=fs.openSync(file,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function readPrivate(file){
 const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)!==0)fail();
 return JSON.parse(fs.readFileSync(file,'utf8'));
}
function authRows(db){return db.query("SELECT chave,painel,dono,ativo,revogada_em,expira_em,chave_hash,chave_hash_curta FROM public.crm_dash_chave ORDER BY chave");}
async function functionDigest(db){
 const r=await db.query("SELECT n.nspname,p.proname,pg_catalog.pg_get_functiondef(p.oid) AS definition FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='crm_audience_v2' OR (n.nspname='public' AND p.proname IN ('shrigma_panel_operator_v1','shrigma_campaign_list_brand')) ORDER BY n.nspname,p.proname,p.oid::text");
 return sha(JSON.stringify(r.rows));
}
async function verifyDatabase(db,owner,credentials,manifest){
 const rows=(await authRows(db)).rows;
 if(rows.length!==2)fail();
 for(const kind of ['reader','writer']){
  const row=rows.find(r=>r.chave==='sandbox-'+kind);
  if(!row||row.painel!=='growth'||row.dono!==owner||row.ativo!==true||row.revogada_em!==null||row.expira_em!==null||row.chave_hash!==sha(credentials[kind])||row.chave_hash_curta!==null)fail();
 }
 const grants=(await db.query('SELECT principal_id,area,caps FROM public.shrigma_panel_permission_v1 ORDER BY principal_id')).rows;
 if(grants.length!==2||grants.some(g=>g.area!=='growth'||!['sandbox-reader','sandbox-writer'].includes(g.principal_id)||JSON.stringify(g.caps)!==JSON.stringify(expectedCaps[g.principal_id.slice(8)])))fail();
 const config=(await db.query('SELECT brand,enabled,base_list_id,catalog FROM crm_audience_v2.config ORDER BY brand')).rows;
 if(config.length!==2||config.some(c=>!['aristo','fish'].includes(c.brand)||c.enabled!==true||c.base_list_id!==(c.brand==='fish'?17:16)||!isDeepStrictEqual(c.catalog,safeSource())))fail();
 const functions=await functionDigest(db);
 if(manifest&&functions!==manifest.functionDigest)fail();
 return functions;
}
async function seed(db,owner,credentials){
 await Fixture.setup(db,{enabled:true,countProvider:null,timeoutMs:1000});
 await db.transaction(async tx=>{
  await tx.query('DELETE FROM public.shrigma_panel_permission_v1');
  await tx.query('DELETE FROM public.crm_dash_chave');
  for(const brand of ['fish','aristo'])await tx.query("UPDATE crm_audience_v2.config SET catalog=$2::jsonb,revision=revision+1,checked_at=pg_catalog.clock_timestamp()-interval '1 second',expires_at=pg_catalog.clock_timestamp()+interval '4 minutes' WHERE brand=$1",[brand,JSON.stringify(safeSource())]);
 });
 await db.transaction(async tx=>{
  for(const kind of ['writer','reader']){
   await tx.query('INSERT INTO public.crm_dash_chave(chave,painel,dono,chave_hash) VALUES($1,$2,$3,$4)',['sandbox-'+kind,'growth',owner,sha(credentials[kind])]);
   await tx.query('INSERT INTO public.shrigma_panel_permission_v1(principal_id,area,caps) VALUES($1,$2,$3::jsonb)',['sandbox-'+kind,'growth',JSON.stringify(expectedCaps[kind])]);
  }
 });
}
function json(res,status,body){
 res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Connection':'close'});
 res.end(JSON.stringify(body));
}
function duplicate(req,name){return req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()===name).length;}
async function createSandbox({root,owner,publicOrigin=PUBLIC_ORIGIN,revision,credentials}={}){
 validateSettings({root,owner,publicOrigin,revision,credentials});
 const contents=fs.readdirSync(root).sort();
 const fresh=contents.length===0;
 if(!fresh&&contents.join(',')!=='manifest.json,pgdata')fail();
 const dataPath=path.join(root,'pgdata');
 if(fresh)fs.mkdirSync(dataPath,{mode:0o700});
 else if(!fs.lstatSync(dataPath).isDirectory()||fs.lstatSync(dataPath).isSymbolicLink())fail();
 const db=new PGlite(dataPath);
 let manifest;
 try{
  // PGlite session settings do not survive a process restart; the real store
  // requires this bounded transaction boundary on every boot.
  await db.exec("SET statement_timeout='20s'");
  if(fresh){
   await seed(db,owner,credentials);
   const functionDigestValue=await verifyDatabase(db,owner,credentials,null);
   manifest={schema:SCHEMA,revision,owner,publicOrigin,sourcePins:pins(),functionDigest:functionDigestValue,credentialPins:{writer:sha(credentials.writer),reader:sha(credentials.reader)}};
   writePrivate(path.join(root,'manifest.json'),manifest);
  }else{
   manifest=readPrivate(path.join(root,'manifest.json'));
   if(manifest.schema!==SCHEMA||manifest.revision!==revision||manifest.owner!==owner||manifest.publicOrigin!==publicOrigin||JSON.stringify(manifest.sourcePins)!==JSON.stringify(pins())||manifest.credentialPins?.writer!==sha(credentials.writer)||manifest.credentialPins?.reader!==sha(credentials.reader))fail();
   await verifyDatabase(db,owner,credentials,manifest);
  }
 }catch(error){await db.close();throw error;}
 const transaction=work=>db.transaction(async tx=>work({query:(sql,values=[])=>tx.query(sql,values)}));
 const refreshCatalog=async({query,brand})=>{
  const result=await query("UPDATE crm_audience_v2.config SET checked_at=pg_catalog.clock_timestamp()-interval '1 second',expires_at=pg_catalog.clock_timestamp()+interval '4 minutes' WHERE brand=$1 AND enabled=true AND base_list_id=$2 AND catalog=$3::jsonb RETURNING brand",[brand,brand==='fish'?17:16,JSON.stringify(safeSource())]);
  if(result.rows?.length!==1)fail();
 };
 const store=Audience.createAudienceStore({transaction,countProvider:null,refreshCatalog,timeoutMs:10000});
 const api=API.createAudienceAPI({store});
 const inner=audienceHTTP({segments:api,binding:{handle:async()=>({status:503,body:{error:'CRM_SANDBOX_ROUTE_DENIED'}})},revision,enabled:true,bindingEnabled:false,regularEnabled:false,maxInFlight:2,operationTimeoutMs:12000});
 let closing=false;
 const authorized=async req=>{
  if(duplicate(req,'authorization')!==1||typeof req.headers.authorization!=='string'||!/^Bearer [a-f0-9]{64}$/.test(req.headers.authorization))return false;
  const offered=req.headers.authorization.slice(7);
  const kind=same(offered,credentials.writer)?'writer':same(offered,credentials.reader)?'reader':null;
  if(!kind)return null;
  const rows=(await db.query('SELECT operator,live_count,live_actor FROM crm_audience_v2.authenticate($1::text)',[offered])).rows;
  const auth=rows[0];return rows.length===1&&auth.live_count===1&&auth.live_actor==='panel:sandbox-'+kind&&auth.operator?.who===auth.live_actor&&auth.operator?.label===owner&&JSON.stringify(auth.operator.caps)===JSON.stringify(expectedCaps[kind])?kind:null;
 };
 const server=http.createServer({maxHeaderSize:8192,requestTimeout:15000,headersTimeout:10000},async(req,res)=>{
  let url;try{url=new URL(req.url,'http://crm-sandbox.invalid');}catch{return json(res,400,{error:'CRM_SANDBOX_REQUEST'});}
  if(req.method==='GET'&&url.pathname==='/healthz'&&!url.search)return json(res,closing?503:200,{service:'crm-audience-sandbox',synthetic:true,sourceRevision:revision,ready:!closing});
  if(closing)return json(res,503,{error:'CRM_SANDBOX_STOPPING'});
  if(req.headers.origin!==undefined||duplicate(req,'origin')>0)return json(res,403,{error:'CRM_SANDBOX_ORIGIN'});
  if(url.pathname==='/segments')return inner.server.emit('request',req,res);
  if(!['/identity','/dashboard'].includes(url.pathname))return json(res,404,{error:'CRM_SANDBOX_ROUTE'});
  if(req.method!=='GET'||req.headers['content-length']!==undefined||req.headers['transfer-encoding']!==undefined)return json(res,405,{error:'CRM_SANDBOX_METHOD'});
  if(url.pathname==='/identity'&&url.search||url.pathname==='/dashboard'&&url.search!==''&&url.search!=='?painel=growth')return json(res,400,{error:'CRM_SANDBOX_QUERY'});
  try{
   const kind=await authorized(req);
   if(!kind)return json(res,401,{error:'CRM_SANDBOX_UNAUTHORIZED'});
   if(url.pathname==='/identity')return json(res,200,{schema:'crm-audience-sandbox-identity-v1',role:'manager',panel:'growth',owner,allowedPanels:['growth'],capabilities:expectedCaps[kind],synthetic:true});
   if(kind!=='reader')return json(res,403,{error:'CRM_SANDBOX_READ_CREDENTIAL_REQUIRED'});
   const dashboard=fixture('growth');
   dashboard.capabilities={...dashboard.capabilities,endpoints:{segments:publicOrigin+'/segments'},segments:{contract_version:Contract.VERSION,brands:['fish','aristo'],read:true,save:true,operation:true,count:false,send:false}};
   return json(res,200,dashboard);
  }catch{return json(res,503,{error:'CRM_SANDBOX_UNAVAILABLE'});}
 });
 server.maxRequestsPerSocket=1;
 server.on('clientError',(_error,socket)=>{if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
 return Object.freeze({server,sourceRevision:revision,publicOrigin,close:async()=>{closing=true;await Promise.all([inner.stop(),new Promise((resolve,reject)=>{if(!server.listening)return resolve();server.close(e=>e?reject(e):resolve());server.closeIdleConnections();})]);await db.close();}});
}
module.exports={createSandbox,PUBLIC_ORIGIN,SOURCE_FILES,safeSource,pins};
