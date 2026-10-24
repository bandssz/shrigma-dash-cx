'use strict';
const fs=require('node:fs'),Q=require('./whatsapp-queue.cjs');
const fail=(code,status=503)=>{throw Object.assign(Error(code),{code,status});};
function create({auth,file,sourceRevision,clientFactory,now=Date.now}){
 const authorize=(context,brand,write=false)=>auth.whatsAppCampaignAuthority(context,brand,write);
 const driver=()=>{const m=JSON.parse(fs.readFileSync('/app/native-backend/manifest.json'));return require('./native-pg-driver.cjs').loadPGDriver(m.pgDriverManifestSha256);};
 async function session(profile,work,write=false){let c;try{c=clientFactory?clientFactory(profile):new (driver().Client)({...profile,application_name:'shrigma-wa-w2',connectionTimeoutMillis:3000,query_timeout:5000});await c.connect();await c.query(write?"BEGIN; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='500ms'":"BEGIN READ ONLY; SET LOCAL statement_timeout='3s'");const v=await work(c);await c.query(write?'COMMIT':'ROLLBACK');return v;}catch(e){if(c)await c.query('ROLLBACK').catch(()=>{});if(/^WA_[A-Z0-9_]+$/.test(e.code||''))throw e;fail('WA_QUEUE_DATABASE_UNAVAILABLE');}finally{profile.password='';if(c)await c.end().catch(()=>{});}}
 const database=(slot,fn,write=true)=>{if(!auth.nativeWorkerVault)fail('WA_QUEUE_VAULT_UNAVAILABLE');return session(slot==='producer'?auth.nativeWorkerVault.producerConnection():auth.nativeWorkerVault.executorConnection(),fn,write);};
 let config;
 const read=fn=>{if(!config){if(file!=='/run/secrets/crm-shopify-paid-facts.json')fail('WA_CONTACT_PROFILE_UNAVAILABLE');const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let raw;try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size>4096||(st.mode&0o077))fail('WA_CONTACT_PROFILE_UNAVAILABLE');raw=JSON.parse(fs.readFileSync(fd));}finally{fs.closeSync(fd);}if(typeof raw.PGPASSWORD!=='string'||!raw.PGPASSWORD)fail('WA_CONTACT_PROFILE_UNAVAILABLE');config={host:'comunicacao_postgres',port:5432,database:'listmonk',user:'crm_shopify_sync',password:raw.PGPASSWORD};}return session({...config},fn,false);};
 async function audience(input,brand){
  if(input.kind==='csv'){const p=require('./whatsapp-csv-preview.cjs').previewCsv(input.csv);if(!p.ok||p.rowResults.some(x=>x.status==='invalid'))fail('WA_CSV_INVALID',400);const rows=p.rows.map(r=>({telefone:r.telefone,primeiro_nome:r.primeiro_nome,kit:r.kit}));if(!rows.length)fail('WA_AUDIENCE_EMPTY',400);return {rows,observedAtUtc:new Date(now()).toISOString(),consent:'do arquivo importado'};}
  return read(async c=>{const rows=(await c.query("SELECT phone,opt_in_fonte,atualizado_em FROM public.shrigma_wa_contato WHERE brand=$1 AND opt_in_em IS NOT NULL AND opt_out_em IS NULL ORDER BY phone LIMIT 5001",[brand])).rows;if(rows.length>5000)fail('WA_AUDIENCE_PAGE_REQUIRED',409);if(rows.some(r=>!/^[1-9][0-9]{7,14}$/.test(r.phone)))fail('WA_CONTACT_PHONE_INVALID',409);return {rows:rows.map(r=>({telefone:r.phone,primeiro_nome:'',kit:''})),observedAtUtc:new Date(now()).toISOString(),consent:'opt-in registrado, sem opt-out'};});
 }
 const queue=Q.create({database,authorize,sourceRevision,now,audience,connection:(context,brand)=>auth.whatsAppConnectionStore().resolveMessages({context,brand})});
 async function readCampaigns(args){
  const value=await queue.read(args),ids=value.records.flatMap(r=>r.tasks.filter(t=>t.providerId).map(t=>t.providerId));
  const rows=ids.length?await read(async c=>(await c.query("SELECT wamid,status,ocorreu_em,recebido_em FROM public.shrigma_wa_status WHERE brand=$1 AND wamid=ANY($2::text[])",[args.brand,ids])).rows):[];
  authorize(args.context,args.brand);return {...value,records:value.records.map(r=>({...r,tasks:r.tasks.map(t=>{const s=rows.filter(x=>x.wamid===t.providerId);return {...t,delivered:s.some(x=>['delivered','read'].includes(x.status)),read:s.some(x=>x.status==='read'),failed:s.some(x=>x.status==='failed'),statusObservedAtUtc:s.map(x=>new Date(x.recebido_em).toISOString()).sort().at(-1)||null};})}))};
 }
 return Object.freeze({...queue,read:readCampaigns,authorize});
}
async function handle({req,res,url,ctx,service,sendJson,readJson}){
 if(url.pathname!=='/api/whatsapp-campaigns')return false;
 let value;
 if(req.method==='GET'){if([...url.searchParams.keys()].some(k=>!['brand','campaignId'].includes(k))||url.searchParams.size!==new Set(url.searchParams.keys()).size||!url.searchParams.has('brand'))fail('WA_INPUT_INVALID',400);value=await service.read({context:ctx,...Object.fromEntries(url.searchParams)});}
 else if(req.method==='POST'){
  if(url.search||req.headers['content-encoding']||req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')fail('WA_INPUT_INVALID',400);
  const body=await readJson(req,1100000),keys={save:'brand,campaignId,expectedRevision,draft',count:'brand,campaignId',test:'brand,campaignId,expectedRevision',schedule:'brand,campaignId,expectedRevision,runAt',cancel:'brand,campaignId,expectedRevision'};
  if(!body||Object.getPrototypeOf(body)!==Object.prototype)fail('WA_INPUT_INVALID',400);const {action,...args}=body;
  if(!Object.hasOwn(keys,action)||Object.keys(args).sort().join()!==keys[action].split(',').sort().join())fail('WA_INPUT_INVALID',400);
  value=await service[action]({context:ctx,...args});
 }else fail('WA_METHOD_DENIED',405);
 sendJson(req,res,200,value);return true;
}
module.exports={create,handle};
