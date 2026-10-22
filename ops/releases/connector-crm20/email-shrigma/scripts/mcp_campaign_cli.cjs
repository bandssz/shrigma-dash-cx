#!/usr/bin/env node
'use strict';
// Local files only. No credentials, HTTP, MCP calls or automatic retry.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const C=require('./lib/campaign-contract'),T=require('./lib/campaign-tracking');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
function fail(code){throw Error(code);}
function definition(input){const d=C.normalize(input);if(!['fish','aristo'].includes(d.brand))fail('BRAND_UNSUPPORTED');return d;}
function draftFields(d){
  if(d.html.length>200000||d.text.length>200000)fail('MCP_CONTENT_LIMIT');
  for(const key of ['name','subject','from_email','reply_to'])if(typeof d[key]!=='string'||d[key].length<1||d[key].length>500||/[\r\n\0]/.test(d[key]))fail('MCP_SHORT_TEXT_INVALID');
  return{name:d.name,subject:d.subject,from_email:d.from_email,reply_to:d.reply_to,lists:d.list_ids,template_id:d.template_id,body:d.html,altbody:d.text};
}
function initialDraft(input){const d=definition(input);return{brand:d.brand,operation_id:crypto.randomUUID(),draft:draftFields(d)};}
function recent(value,now){
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value))fail('RECEIPT_TIME_REQUIRED');
  const age=now-Date.parse(value);if(!Number.isFinite(age)||age< -30000||age>300000)fail('RECEIPT_STALE');
}
function receipt(value,now){
  if(!value||typeof value!=='object')fail('RECEIPT_REQUIRED');recent(value.received_at,now);
  const r=value.result;if(!r||typeof r!=='object'||r.refused||r.error||r.isError||r.state==='uncertain')fail('MCP_RESULT_UNCONFIRMED');return r;
}
function prepareMcp(input,receipts,now=Date.now()){
  const d=definition(input);if(!receipts||receipts.brand!==d.brand)fail('RECEIPT_BRAND');
  const campaign=receipt(receipts.campaign,now),lists=receipt(receipts.lists,now),templates=receipt(receipts.templates,now);
  if(lists.brand!==d.brand||templates.brand!==d.brand)fail('CATALOG_BRAND');recent(lists.observed_at,now);
  if(!Array.isArray(lists.lists)||!lists.lists.every(l=>Number.isSafeInteger(l.id)&&l.id>0&&Number.isSafeInteger(l.subscriber_count)&&l.subscriber_count>=0))fail('LISTS_UNCONFIRMED');
  if(new Set(lists.lists.map(l=>l.id)).size!==lists.lists.length)fail('LISTS_DUPLICATED');
  if(!Array.isArray(templates.templates)||!templates.templates.every(t=>Number.isSafeInteger(t.id)&&t.id>0&&typeof t.body==='string'))fail('TEMPLATES_UNCONFIRMED');
  if(new Set(templates.templates.map(t=>t.id)).size!==templates.templates.length)fail('TEMPLATES_DUPLICATED');
  const native=campaign.campaign;
  if(!Number.isSafeInteger(campaign.campaign_id)||campaign.campaign_id<1||[188,189,190,191].includes(campaign.campaign_id)||!uuid(campaign.revision)||campaign.content_matches_saved_revision!==true||native?.status!=='draft'||campaign.counts?.sent!==0)fail('DRAFT_NOT_PROVEN');
  if(native.send_at!==null)fail('DRAFT_ALREADY_HAS_SCHEDULE');
  if(!Array.isArray(native.lists)||JSON.stringify([...native.lists].sort((a,b)=>a-b))!==JSON.stringify(d.list_ids))fail('DRAFT_LIST_MISMATCH');
  const domain=d.brand==='fish'?'fishermans.com.br':'oaristocrata.com';
  const oldFrom=String(native.from_email??'').match(/<?([^<>\s]+@[^<>\s]+)>?$/)?.[1]?.toLowerCase();
  if(oldFrom?.split('@')[1]!==domain||String(native.reply_to??'').split('@')[1]?.toLowerCase()!==domain)fail('DRAFT_BRAND_MISMATCH');
  const catalog={brand:d.brand,current:true,lists:lists.lists.map(l=>({id:l.id,name:l.name,brand:d.brand,available:true})),templates:templates.templates.map(t=>({id:t.id,type:t.type,available:true})),initiatives:[]};
  const prepared=C.prepare(d,{catalog,tracking:T,trackingId:campaign.campaign_id,now});
  const update={brand:d.brand,operation_id:crypto.randomUUID(),campaign_id:campaign.campaign_id,revision:campaign.revision,patch:draftFields(prepared.definition)};
  const wrapper=templates.templates.find(t=>t.id===d.template_id&&t.type==='campaign');if(!wrapper)fail('TEMPLATE_UNCONFIRMED');
  return{definition:prepared.definition,update,wrapper:wrapper.body,manifest:{schema_version:'email-mcp-prepared-v1',prepared_at:new Date(now).toISOString(),scope:'local-only',brand:d.brand,campaign_id:campaign.campaign_id,expected_revision:campaign.revision,operation_id:update.operation_id,list_ids:d.list_ids,tracking_term:prepared.tracking.term,initiative_mapping:'not_provided_by_mcp',native_updated_at_available:false,native_started_at_available:false,statistics_refresh_at:lists.statistics_refresh_at??null,html_sha256:hash(prepared.definition.html),text_sha256:hash(prepared.definition.text),wrapper_sha256:hash(wrapper.body),source_receipts_sha256:hash(JSON.stringify(receipts)),remote_saved:false,scheduled:false}};
}
const load=file=>{const b=fs.readFileSync(file);if(b.length>2000000)fail('INPUT_TOO_LARGE');return JSON.parse(b.toString('utf8'));};
function saveNew(directory,files){
  const out=path.resolve(directory);if(fs.existsSync(out))fail('OUTPUT_EXISTS');fs.mkdirSync(path.dirname(out),{recursive:true});const stage=fs.mkdtempSync(path.join(path.dirname(out),'.mcp-prepare-'));
  try{for(const[name,data]of Object.entries(files))fs.writeFileSync(path.join(stage,name),data,{mode:0o600,flag:'wx'});fs.renameSync(stage,out);}catch(e){fs.rmSync(stage,{recursive:true,force:true});throw e;}
}
function main(argv){
  if(argv.length===1&&argv[0]==='--help'){console.log('Offline; não envia nem chama MCP.\n  node scripts/mcp_campaign_cli.cjs draft campanha.json --out-dir revisao-NOVA\n  node scripts/mcp_campaign_cli.cjs prepare campanha.json --receipts recibos-mcp.json --out-dir revisao-NOVA');return 0;}
  const[action,file,...options]=argv;if(!['draft','prepare'].includes(action)||!file)fail('ARGUMENTS');const flags={};
  for(let i=0;i<options.length;i+=2){if(!['--receipts','--out-dir'].includes(options[i])||!options[i+1]||Object.hasOwn(flags,options[i]))fail('ARGUMENTS');flags[options[i]]=options[i+1];}
  if(!flags['--out-dir']||(action==='prepare')!==!!flags['--receipts'])fail('ARGUMENTS');const input=load(file);
  if(action==='draft'){
    const args=initialDraft(input);saveNew(flags['--out-dir'],{'mcp-draft.json':JSON.stringify(args,null,2)+'\n'});console.log(JSON.stringify({ok:true,scope:'local-only',operation_id:args.operation_id,tracking_pending:true,remote_saved:false,scheduled:false}));
  }else{
    const r=prepareMcp(input,load(flags['--receipts']));saveNew(flags['--out-dir'],{'campaign.json':JSON.stringify(r.definition,null,2)+'\n','mcp-update.json':JSON.stringify(r.update,null,2)+'\n','body.html':r.definition.html,'text.txt':r.definition.text,'wrapper-real.html':r.wrapper,'tracking-manifest.json':JSON.stringify(r.manifest,null,2)+'\n'});console.log(JSON.stringify({ok:true,scope:'local-only',id:r.manifest.campaign_id,revision:r.update.revision,operation_id:r.update.operation_id,tracking:r.manifest.tracking_term,remote_saved:false,scheduled:false}));
  }return 0;
}
module.exports={initialDraft,prepareMcp,main};
if(require.main===module){try{process.exitCode=main(process.argv.slice(2));}catch(e){console.error(JSON.stringify({ok:false,error:'LOCAL_MCP_PREPARATION_REFUSED',message:e instanceof SyntaxError?'JSON inválido.':e.message}));process.exitCode=1;}}
