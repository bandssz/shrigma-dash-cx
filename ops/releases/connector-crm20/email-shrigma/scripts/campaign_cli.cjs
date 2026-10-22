#!/usr/bin/env node
/* Offline preparation only. Uses the exact Growth contract and tracking modules. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const C=require('./lib/campaign-contract'),T=require('./lib/campaign-tracking');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const load=(f,max=2000000)=>{const b=fs.readFileSync(f);if(b.length>max)throw Error(`Arquivo acima de ${max} bytes.`);return JSON.parse(b.toString('utf8'));};
function scope(def){if(!['fish','aristo'].includes(def?.brand))throw Error('Esta skill aceita somente Fishermans (fish) e O Aristocrata (aristo).');}
function panelJSON(def){const body=JSON.stringify(def,null,2)+'\n';if(Buffer.byteLength(body,'utf8')>800000)throw Error('JSON de saída acima do limite de 800 KB do painel.');return body;}
function recent(v,now){if(typeof v!=='string'||!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(v))throw Error('Snapshot exige read_at com fuso.');const age=now-Date.parse(v);if(!Number.isFinite(age)||age< -30000||age>5*60e3)throw Error('Releia os snapshots; a consulta deve ter até cinco minutos.');}
function prepare(def,snapshot,catalog,now=Date.now()){
 scope(def);if(snapshot.brand!==def.brand)throw Error('Snapshot não corresponde à marca da definição.');
 recent(snapshot.read_at,now);recent(catalog.read_at,now);
 const c=snapshot.campaign;if(!c||c.status!=='draft'||c.sent!==0||c.started_at!==null||!c.updated_at)throw Error('Exige snapshot real de rascunho ainda não iniciado, com updated_at.');
 const r=C.prepare(def,{catalog,tracking:T,trackingId:c.id,now});
 panelJSON(r.definition);
 const lists=(c.lists||[]).map(v=>Number(v.id??v)).sort((a,b)=>a-b);
 if(JSON.stringify(lists)!==JSON.stringify(r.definition.list_ids))throw Error('Listas do rascunho nativo diferem da definição. Reconciliar antes do preparo.');
 return {...r,manifest:{schema_version:'email-prepared-v1',policy:C.VERSION,prepared_at:new Date(now).toISOString(),scope:'local-only',brand:r.definition.brand,campaign_id:c.id,expected_updated_at:c.updated_at,list_ids:r.definition.list_ids,initiative:r.definition.initiative,utm_campaign:r.definition.utm_campaign,tracking_term:r.tracking.term,initiative_mapping:catalog.initiatives?.some(i=>i.utm_campaign===r.definition.utm_campaign&&i.key===r.definition.initiative.key)?'confirmed_in_supplied_catalog':'pending_registration',html_sha256:hash(r.definition.html),text_sha256:hash(r.definition.text),definition_sha256:hash(JSON.stringify(r.definition)),remote_saved:false,scheduled:false}};
}
function main(argv){
 if(argv.length===1&&argv[0]==='--help'){console.log('Local, sem rede/envio:\n  node scripts/campaign_cli.cjs normalize campanha.json\n  node scripts/campaign_cli.cjs prepare campanha.json --snapshot rascunho.json --catalog catalogo.json --out-dir revisao-NOVA');return 0;}
 const [action,file,...opts]=argv;if(!file||!['normalize','prepare'].includes(action))throw Error('Use --help para os comandos disponíveis.');
 const input=load(file,800000);scope(input);const def=C.normalize(input);panelJSON(def);
 if(action==='normalize'){if(opts.length)throw Error('normalize não recebe opções extras.');process.stdout.write(panelJSON(def));return 0;}
 const flags={};for(let i=0;i<opts.length;i+=2){if(!['--snapshot','--catalog','--out-dir'].includes(opts[i])||!opts[i+1]||Object.hasOwn(flags,opts[i]))throw Error('Opções inválidas ou repetidas.');flags[opts[i]]=opts[i+1];}
 if(Object.keys(flags).length!==3)throw Error('Informe --snapshot, --catalog e --out-dir.');
 const out=path.resolve(flags['--out-dir']);if(fs.existsSync(out))throw Error('Diretório de saída já existe; use uma revisão nova.');
 const r=prepare(def,load(flags['--snapshot']),load(flags['--catalog']));
 const parent=path.dirname(out);fs.mkdirSync(parent,{recursive:true});const stage=fs.mkdtempSync(path.join(parent,'.campaign-stage-'));
 try{for(const [name,body] of Object.entries({'campaign.json':panelJSON(r.definition),'body.html':r.definition.html,'text.txt':r.definition.text,'tracking-manifest.json':JSON.stringify(r.manifest,null,2)+'\n'}))fs.writeFileSync(path.join(stage,name),body,{flag:'wx',mode:0o600});fs.renameSync(stage,out);}catch(e){fs.rmSync(stage,{recursive:true,force:true});throw e;}
 console.log(JSON.stringify({ok:true,directory:out,scope:'local-only',id:r.manifest.campaign_id,tracking:r.tracking,initiative_mapping:r.manifest.initiative_mapping,remote_saved:false,scheduled:false}));return 0;
}
module.exports={prepare,main};
if(require.main===module){try{process.exitCode=main(process.argv.slice(2));}catch(e){console.error(JSON.stringify({ok:false,error:e.code||'PREPARE_FAILED',message:e instanceof SyntaxError?'JSON inválido.':e.message}));process.exitCode=1;}}
