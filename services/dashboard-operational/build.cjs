'use strict';
// Publish a closed, static frontend allowlist. The source tree and backend stay out
// of the artifact; the BFF owns all sessions, credentials and upstream requests.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {readOnlyStyles}=require('./public/entry.js');

const root=path.resolve(__dirname,'../..');
const CONTENT=[
 'growth.html','organico.html','influs.html',
 'growth-diagnostico.html','growth-control.js','growth-delivery.js','growth-diagnostic.js','growth-diagnostic-ui.js',
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
const DYNAMIC_ROUTES=['templates','campaigns','campaigns_media','segments','campaign_audience','ab_experiment','journey_graph','journey_graph_lifecycle'];
const LOGOS={
 'https://oaristocrata.com/cdn/shop/files/Mascote.png?height=96':'/logos/icone-aristocrata.png',
 'https://fishermans.com.br/cdn/shop/files/simbolo_isolado_RGB.svg':'/logos/icone-fishermans.svg',
 'https://olivasdocampo.com.br/cdn/shop/files/logo-olivas.jpg?height=96':'/logos/icone-olivas.jpg',
 'https://fishermans.com.br/cdn/shop/files/Fishermans_logo_primario_RGB.png?height=120':'/logos/wm-fishermans.png'
};
const LEGACY_MASTER_CHECK='panels.length===4&&new Set(panels).size===4&&["cx","growth","organico","influs"].every(p=>panels.includes(p))';
const OPERATIONAL_MASTER_CHECK='panels.length===3&&new Set(panels).size===3&&["growth","organico","influs"].every(p=>panels.includes(p))';
// The public source bundles image upload and legacy credential handling. Remove
// exactly the reviewed module from the operational artifact before packaging.
// PR221 adds the reviewed legacy-file label/count and boolean validation.
// Keep exact removal pinned; its upload/credential code never enters the pack.
const LEGACY_MEDIA_SHA256='e63d92ac55847cd708cd56374d2967668e4fa7a99599231a7aa2681c96d6a854';
function removeLegacyMedia(source){
 const startToken='const GMedia=(()=>{',endToken=';const CampaignTracking=';
 const start=source.indexOf(startToken),end=source.indexOf(endToken,start);
 if(start<0||end<0||source.indexOf(startToken,start+1)!==-1||source.indexOf(endToken,end+1)!==-1)throw Error('Legacy media module contract changed');
 const old=source.slice(start,end+1);
 if(crypto.createHash('sha256').update(old).digest('hex')!==LEGACY_MEDIA_SHA256||!old.includes('module.exports=GMedia'))throw Error('Legacy media module needs review');
 const clean=source.slice(0,start)+source.slice(end+1);
 if(/\bGMedia\b/.test(clean))throw Error('Legacy media reference remains');
 return clean;
}
// Images are public assets already used by the panels. Meta serves signed thumbnails
// from region-specific subdomains, so only its two CDN suffixes need subdomain matching.
const IMAGE_SOURCES='https://cdn.shopify.com/s/files/ https://email.shrigma.com.br/uploads/ https://cdninstagram.com/ https://*.cdninstagram.com/ https://fbcdn.net/ https://*.fbcdn.net/ https://*.ibyteimg.com/ https://*.tiktokcdn.com/ https://*.tiktokcdn-us.com/ https://*.byteimg.com/ https://*.ttwstatic.com/';
const CSP_BASE=`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${IMAGE_SOURCES}; connect-src 'self'; font-src 'self'; frame-src 'self' blob:; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`;
function cspFor(html){
 const hashes=[...html.matchAll(/<script\s*>([\s\S]*?)<\/script>/gi)].map(m=>`'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
 return `script-src 'self' ${hashes.join(' ')}; ${CSP_BASE}`;
}
function putCsp(html,file){
 const csp=cspFor(html);
 if(!/<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*">/i.test(html))throw Error('Missing CSP meta: '+file);
 return html.replace(/<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*">/gi,`<meta http-equiv="Content-Security-Policy" content="${csp}">`);
}
function transformDiagnosticUi(source){
 const start=source.indexOf('  async function load(explicitKey){');
 const end=source.indexOf("  $('#start').value=brDay();",start);
 const submit="  $('#auth-form').onsubmit=e=>{e.preventDefault();const key=$('#auth-key').value.trim();if(key)load(key);};\n";
 if(start<0||end<0||source.indexOf('  async function load(explicitKey){',start+1)!==-1||!source.includes(submit))throw Error('Diagnostic request contract changed');
 const load=`  async function load(){
    if(loading)return;
    loading=true;$('#refresh').disabled=true;$('#status').textContent='Consultando o CRM…';
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
    try{
      const response=await fetch('/api/cx?painel=growth',{method:'GET',headers:{Accept:'application/json'},credentials:'same-origin',signal:controller.signal,redirect:'error',cache:'no-store'});
      if(response.status===401)throw new Error('session_expired');
      if(!response.ok)throw new Error('http_'+response.status);
      const next=await response.json();
      if(!next||next._escopo!=='growth'||!Array.isArray(next.crm_campanha)||!Array.isArray(next.crm_fluxo)||!Array.isArray(next.crm_conversao))throw new Error('wrong_scope');
      api=next;receivedAt=new Date().toISOString();failed=false;
      $('#status').textContent='Consulta recebida. Os horários de cada fonte estão indicados abaixo.';
    }catch(e){
      failed=true;
      $('#status').textContent=e.message==='session_expired'?'Sua sessão terminou. Entre novamente no CRM.':e.message==='wrong_scope'?'A resposta não confirmou o escopo Growth. Nenhum dado novo foi aplicado.':e.name==='AbortError'?'A consulta excedeu 20 segundos. Nenhuma alteração foi realizada.':'Não foi possível consultar o CRM. Nenhuma alteração foi realizada.';
    }finally{clearTimeout(timeout);loading=false;$('#refresh').disabled=false;render();}
  }
`;
 const output=(source.slice(0,start)+load+source.slice(end)).replace(submit,'');
 if(/\b(?:shrigmaChave|shrigmaGuardaChave|shrigmaEsqueceChave|shrigmaMarcaMestra|CX_API_URL|Authorization|auth-key|auth-form)\b/.test(output))throw Error('Legacy diagnostic credential remains');
 return output;
}
function bindOperationalBrand(source,file){
 const contracts={
  'growth.html':{anchor:"let API=null,MARCA='todas',CANAL='todos',SEC='visao',METRICA='receita',CMP=true,LOADING=false;",render:'if(API)render();'},
  'organico.html':{anchor:"let API=null,MARCA='todas',PER=G.preset('mes',HOJE),CMP=true,SEC='grade',AGREG='semana',FILTRO='todos';",render:'if(API)render();'},
  'influs.html':{anchor:"let MARCA='todas', SEC='creators';",render:"if(typeof INFLU!=='undefined'&&INFLU)renderTudo();"}
 };
 const contract=contracts[file];if(!contract)return source;
 if(source.split(contract.anchor).length!==2||source.includes("'shrigma:brand-access'"))throw Error('Operational brand presentation contract changed: '+file);
 const listener=`\n// The BFF authorizes the brand; this listener only keeps the visible panel in that scope.\nwindow.addEventListener('shrigma:brand-access',event=>{\n const scope=event.detail;if(scope?.brandAccess!=='single'||!['fish','aristo'].includes(scope.brand))return;\n MARCA=scope.brand;document.querySelectorAll('#seg-marca button').forEach(button=>button.classList.toggle('ativo',button.dataset.marca===MARCA));\n pintaMarca();${contract.render}\n});\n`;
 return source.replace(contract.anchor,contract.anchor+listener);
}
function transform(input,file){
 let output=bindOperationalBrand(input,file);
 if(file==='growth-diagnostic-ui.js')output=transformDiagnosticUi(output);
 if(file==='growth-diagnostico.html'){
  const auth=/<section class="panel" id="auth" hidden>[\s\S]*?<\/section>\n/;
  if(!auth.test(output)||!/<script src="config\.js\?[^\"]+"><\/script>/.test(output)||!output.includes('</head>'))throw Error('Legacy diagnostic page contract changed');
  output=output.replace(auth,'').replace(/<script src="config\.js\?[^\"]+"><\/script>\n/,'');
  output=output.replace('#auth-form{max-width:540px}#auth-key{width:100%;margin-bottom:10px}','');
  output=output.replace('</head>','<meta http-equiv="Content-Security-Policy" content=""></head>');
  if(/\b(?:config\.js|auth-key|auth-form|Chave de leitura)\b/.test(output))throw Error('Legacy diagnostic access remains');
 }
 if(file==='growth.html'){
  const oldJourney='GFU.render({...ctx,workflowsModel:';
  if(output.split(oldJourney).length!==2)throw Error('Observed journey binding changed');
  output=output.replace(oldJourney,'GFU.render({...ctx,observedOnly:true,workflowsModel:');
  const oldIntro='<h2>Veja a jornada inteira, do preparo à entrega.</h2><p>Jornadas reúne as configurações existentes.';
  if(output.split(oldIntro).length!==2)throw Error('Observed journey heading changed');
  output=output.replace(oldIntro,'<h2>Consulte as jornadas observadas da marca.</h2><p>Jornadas mostra as mensagens registradas. O histórico não declara gatilhos, esperas nem sequência de execução.');
  const target='<div class="crm-home-heading"><h2>Resumo do período</h2></div>';
  if(output.split(target).length!==2)throw Error('CRM diagnostic navigation anchor changed');
  output=output.replace(target,target+'<p><a class="btn sec" href="/growth-diagnostico.html">Diagnóstico de pedido pago</a></p>');
  const mount='GMedia.mount({marca:MARCA,api:API});',panelScript='<script src="assets/panels/growth.js?';
  if(output.split(mount).length!==2||output.split(panelScript).length!==2)throw Error('CRM media mount contract changed');
  output=output.replace(mount,'GMediaRead.mount({marca:MARCA,api:API});');
  output=output.replace(panelScript,'<script src="/media-read.js"></script>'+panelScript);
 }
 if(file==='assets/panels/growth.js')output=removeLegacyMedia(output);
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
  const area=file.slice(0,-'.html'.length),css=readOnlyStyles(area,{embeddedOnly:false});
  if(file!=='growth-diagnostico.html'){
   if(!css||output.includes('id="dashboard-operational-readonly"'))throw Error('Missing or duplicate read-only panel presentation: '+file);
   output=output.replace(/<\/head>/i,`<style id="dashboard-operational-readonly">${css}</style></head>`);
  }
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
function verifyCampaignAssets(directory=__dirname){
 const inputs=[['crm-campaign-bff-client.cjs','public/campaign-bff-client.js','campaign-bff-client.js'],['public/campaign-edit.js','public/campaign-edit.compiled.js','campaign-edit.js'],['public/entry.js','public/entry.compiled.js','entry.js'],['public/guard.js','public/guard.compiled.js','guard.js']];
 const read=file=>{const from=path.join(directory,file),stat=fs.lstatSync(from);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid campaign UI asset');return fs.readFileSync(from);};
 const bytes=read('campaign-ui-assets.json');if(bytes.length>4096)throw Error('Invalid campaign UI manifest');
 const manifest=JSON.parse(bytes.toString('utf8'));
 if(Object.keys(manifest).sort().join(',')!=='assets,esbuildVersion,schema'||manifest.schema!=='shrigma_campaign_ui_assets_v1'||manifest.esbuildVersion!=='0.28.2'||!Array.isArray(manifest.assets)||manifest.assets.length!==inputs.length)throw Error('Invalid campaign UI manifest');
 return inputs.map(([source,compiled,publicName],index)=>{
  const asset=manifest.assets[index];if(!asset||Object.keys(asset).sort().join(',')!=='compiled,compiledSha256,publicName,source,sourceSha256'||asset.source!==source||asset.compiled!==compiled||asset.publicName!==publicName||!['sourceSha256','compiledSha256'].every(key=>/^[a-f0-9]{64}$/.test(asset[key])))throw Error('Invalid campaign UI manifest');
  const input=read(source),output=read(compiled);
  if(crypto.createHash('sha256').update(input).digest('hex')!==asset.sourceSha256||crypto.createHash('sha256').update(output).digest('hex')!==asset.compiledSha256)throw Error('Campaign UI asset needs regeneration');
  return {publicName,bytes:output};
 });
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
 for(const file of ['entry.css','media-read.js']){
  const from=path.join(__dirname,'public',file);
  if(fs.lstatSync(from).isSymbolicLink())throw Error('Symlink forbidden: '+file);
  fs.copyFileSync(from,path.join(publicRoot,file));
 }
 for(const asset of verifyCampaignAssets())fs.writeFileSync(path.join(publicRoot,asset.publicName),asset.bytes);
 const manifest={schema:'shrigma_dashboard_operational_artifact_v1',mode:'cookie-session-bff',areas:Object.values(ENTRIES).map(x=>x.area),publicFiles:[...CONTENT,...Object.keys(ENTRIES).map(x=>`${x}/index.html`),'entry.js','entry.css','guard.js','media-read.js','campaign-edit.js','campaign-bff-client.js'],fixedApiRoutes:[...new Set(Object.values(ENDPOINTS))],dynamicApiRoutes:DYNAMIC_ROUTES};
 fs.writeFileSync(path.join(out,'artifact-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 return {directory:out,files:manifest.publicFiles.length,areas:manifest.areas};
}
if(require.main===module)console.log(JSON.stringify(build(process.argv[2])));
module.exports={build,transform,bindOperationalBrand,CONTENT,ENTRIES,ENDPOINTS,DYNAMIC_ROUTES,cspFor,verifyCampaignAssets};
