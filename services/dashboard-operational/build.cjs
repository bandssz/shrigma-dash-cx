'use strict';
// Publish a closed, static frontend allowlist. The source tree and backend stay out
// of the artifact; the BFF owns all sessions, credentials and upstream requests.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const root=path.resolve(__dirname,'../..');
const CONTENT=[
 'growth.html','organico.html','influs.html',
 ...['growth','organico','influs'].flatMap(p=>['js','css'].map(ext=>`assets/panels/${p}.${ext}`)),
 'logos/icone-aristocrata.png','logos/icone-fishermans.svg','logos/icone-olivas.jpg',
 'logos/wm-aristocrata.png','logos/wm-fishermans.png','logos/wm-olivas.png'
];
const ENTRIES={crm:{area:'growth',label:'CRM'},organico:{area:'organico',label:'Orgânico'},creators:{area:'influs',label:'Influs & Afiliados'},gestao:{area:'todos',label:'Gestão geral'}};
const ENDPOINTS={
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/cx-dash-api-306742284c6fac1d':'cx',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/cx-dash-cache-a91f3c7e2d4b':'cache',
 'https://comunicacao-crm-panel-read.tazdb8.easypanel.host/read':'crm-read',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-teste-api-01d240f09eff8e39':'ab',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-influ-api-7c41e0b93a5d8f26':'influ',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/tts-painel-api-9d3f7a1c':'tts',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/tts-acao-api-2c7e9f41':'tts-action',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/organico-links-utm-8f07a61f3f3c':'organico-links',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/tts-cobranca-painel-a3ac4c25d1e85399':'tts-cobranca',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/parceiros-candidatura-bc82004eb9363032':'candidaturas',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/parceiros-aprovacao-c58b68db6d3a02f0':'aprovacao',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/influs-escopo-7d79357c9b85b871':'escopo'
};
const DYNAMIC_ROUTES=['templates','campaigns','segments','campaign_audience','ab_experiment','journey_graph','journey_graph_lifecycle'];
const LOGOS={
 'https://oaristocrata.com/cdn/shop/files/Mascote.png?height=96':'/logos/icone-aristocrata.png',
 'https://fishermans.com.br/cdn/shop/files/simbolo_isolado_RGB.svg':'/logos/icone-fishermans.svg',
 'https://olivasdocampo.com.br/cdn/shop/files/logo-olivas.jpg?height=96':'/logos/icone-olivas.jpg',
 'https://fishermans.com.br/cdn/shop/files/Fishermans_logo_primario_RGB.png?height=120':'/logos/wm-fishermans.png'
};
const LEGACY_MASTER_CHECK='panels.length===4&&new Set(panels).size===4&&["cx","growth","organico","influs"].every(p=>panels.includes(p))';
const OPERATIONAL_MASTER_CHECK='panels.length===3&&new Set(panels).size===3&&["growth","organico","influs"].every(p=>panels.includes(p))';
const CSP_BASE="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-src 'self' blob:; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";
function cspFor(html){
 const hashes=[...html.matchAll(/<script\s*>([\s\S]*?)<\/script>/gi)].map(m=>`'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
 return `script-src 'self' ${hashes.join(' ')}; ${CSP_BASE}`;
}
function putCsp(html,file){
 const csp=cspFor(html);
 if(!/<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*">/i.test(html))throw Error('Missing CSP meta: '+file);
 return html.replace(/<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*">/gi,`<meta http-equiv="Content-Security-Policy" content="${csp}">`);
}
function transform(input,file){
 let output=input;
 if(/^assets\/panels\/(?:growth|organico|influs)\.js$/.test(file)){
  if(output.split(LEGACY_MASTER_CHECK).length!==2)throw Error('Master role contract changed: '+file);
  output=output.replace(LEGACY_MASTER_CHECK,OPERATIONAL_MASTER_CHECK);
 }
 for(const [url,route] of Object.entries(ENDPOINTS)){
  const replacement=`new URL('/api/${route}',location.origin).href`;
  for(const quote of ['"',"'",'`'])output=output.split(quote+url+quote).join(replacement);
 }
 for(const [url,local]of Object.entries(LOGOS))output=output.split(url).join(local);
 if(file.endsWith('.html')){
  output=putCsp(output,file);
  const firstScript=output.search(/<script\b/i),headEnd=output.search(/<\/head>/i);
  if(headEnd<0||firstScript>=0&&firstScript<headEnd)throw Error('Guard cannot load before content scripts: '+file);
  output=output.replace(/<\/head>/i,'<script src="/guard.js"></script></head>');
 }
 if(/https:\/\/(?:n8n(?:-n8n)?|comunicacao-[a-z-]+)\./i.test(output))throw Error('Unmapped upstream URL: '+file);
 return output;
}
function safeCopy(source,destination){
 const from=path.join(root,source),stat=fs.lstatSync(from);
 if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid public source: '+source);
 fs.mkdirSync(path.dirname(destination),{recursive:true});
 const bytes=fs.readFileSync(from);
 fs.writeFileSync(destination,/\.(?:html|js|css)$/.test(source)?transform(bytes.toString('utf8'),source):bytes);
}
function build(destination){
 if(!destination)throw Error('Usage: node build.cjs /absolute/empty/destination');
 const out=path.resolve(destination);
 if(fs.existsSync(out)&&fs.readdirSync(out).length)throw Error('Destination must be empty');
 fs.mkdirSync(out,{recursive:true});
 const publicRoot=path.join(out,'public');
 for(const file of CONTENT)safeCopy(file,path.join(publicRoot,file));
 const template=fs.readFileSync(path.join(__dirname,'public/entry.html'),'utf8');
 if(!template.includes('__PANEL__')||!template.includes('__LABEL__'))throw Error('Entry template markers missing');
 for(const [folder,{area,label}]of Object.entries(ENTRIES)){
  const html=template.replaceAll('__PANEL__',area).replaceAll('__LABEL__',label);
  const target=path.join(publicRoot,folder,'index.html');fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,putCsp(html,target));
 }
 for(const file of ['entry.js','entry.css','guard.js']){
  const from=path.join(__dirname,'public',file);
  if(fs.lstatSync(from).isSymbolicLink())throw Error('Symlink forbidden: '+file);
  fs.copyFileSync(from,path.join(publicRoot,file));
 }
 const manifest={schema:'shrigma_dashboard_operational_artifact_v1',mode:'cookie-session-bff',areas:Object.values(ENTRIES).map(x=>x.area),publicFiles:[...CONTENT,...Object.keys(ENTRIES).map(x=>`${x}/index.html`),'entry.js','entry.css','guard.js'],fixedApiRoutes:[...new Set(Object.values(ENDPOINTS))],dynamicApiRoutes:DYNAMIC_ROUTES};
 fs.writeFileSync(path.join(out,'artifact-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 return {directory:out,files:manifest.publicFiles.length,areas:manifest.areas};
}
if(require.main===module)console.log(JSON.stringify(build(process.argv[2])));
module.exports={build,transform,CONTENT,ENTRIES,ENDPOINTS,DYNAMIC_ROUTES,cspFor};
