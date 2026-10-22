'use strict';
// A closed allowlist, not a recursive repository copy. The resulting directory is
// the ONLY Docker context: no Git history, private data, backend or credentials.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const FILES=[
 'index.html','growth.html','organico.html','influs.html',
 'cx/index.html','crm/index.html','organico/index.html','creators/index.html','gestao/index.html',
 ...['index','growth','organico','influs'].flatMap(p=>['js','css'].map(e=>`assets/panels/${p}.${e}`)),
 'assets/panels/entry.js','assets/panels/crm-entry.js','assets/panels/entry.css',
 'logos/icone-aristocrata.png','logos/icone-fishermans.svg','logos/icone-olivas.jpg',
 'logos/wm-aristocrata.png','logos/wm-fishermans.png','logos/wm-olivas.png'
];
const ENDPOINTS={
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/cx-dash-api-306742284c6fac1d':'cx',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/cx-dash-cache-a91f3c7e2d4b':'cache',
 'https://comunicacao-crm-panel-read.tazdb8.easypanel.host/read':'crm-read',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-teste-api-01d240f09eff8e39':'ab-blocked',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/crm-influ-api-7c41e0b93a5d8f26':'influ',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/tts-painel-api-9d3f7a1c':'tts',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/tts-acao-api-2c7e9f41':'tts-blocked',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/organico-links-utm-8f07a61f3f3c':'organico-links',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/tts-cobranca-painel-a3ac4c25d1e85399':'tts-cobranca',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/parceiros-candidatura-bc82004eb9363032':'candidaturas',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/parceiros-aprovacao-c58b68db6d3a02f0':'aprovacao',
 'https://n8n-n8n.tazdb8.easypanel.host/webhook/influs-escopo-7d79357c9b85b871':'escopo'
};
const LOGOS={
 'https://oaristocrata.com/cdn/shop/files/Mascote.png?height=96':'/logos/icone-aristocrata.png',
 'https://fishermans.com.br/cdn/shop/files/simbolo_isolado_RGB.svg':'/logos/icone-fishermans.svg',
 'https://olivasdocampo.com.br/cdn/shop/files/logo-olivas.jpg?height=96':'/logos/icone-olivas.jpg',
 'https://fishermans.com.br/cdn/shop/files/Fishermans_logo_primario_RGB.png?height=120':'/logos/wm-fishermans.png'
};
const banner='<aside id="preview-safety-banner" role="status">TESTE — dados sintéticos — escrita bloqueada</aside>';
function transform(input,file){
 let text=input;
 for(const [url,route] of Object.entries(ENDPOINTS)){
  for(const quote of ['"',"'"])text=text.split(quote+url+quote).join(`new URL('/preview-api/${route}',location.origin).href`);
 }
 for(const [url,local]of Object.entries(LOGOS))text=text.split(url).join(local);
 // The served copy permits identity introspection on localhost as well as TLS.
 // API capabilities omit dynamic operation endpoints; every write stays closed.
 if(file.endsWith('.js'))text=text.replaceAll("url.protocol!==\"https:\"",'url.protocol!=="https:"&&url.origin!==location.origin').replaceAll("url.protocol!=='https:'","url.protocol!=='https:'&&url.origin!==location.origin");
 if(file.endsWith('.html')){
  const hashes=[...text.matchAll(/<script\s*>([\s\S]*?)<\/script>/g)].map(m=>`'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  const csp=`default-src 'self'; script-src 'self' ${hashes.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'`;
  text=text.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/g,`<meta http-equiv="Content-Security-Policy" content="${csp}">`);
  text=text.replace('</head>','<link rel="stylesheet" href="/preview.css"><script src="/preview.js"></script></head>');
  text=text.replace(/(<body\b[^>]*>)/,`$1${banner}`);
 }
 if(/https:\/\/(?:n8n|comunicacao-crm-)/.test(text))throw Error('Unmapped production service literal in '+file);
 return text;
}
function build(destination){
 const out=path.resolve(destination);
 if(fs.existsSync(out)&&fs.readdirSync(out).length)throw Error('Build destination must be empty');
 fs.mkdirSync(path.join(out,'public'),{recursive:true});
 for(const file of FILES){
  const src=path.join(root,file),target=path.join(out,'public',file);
  if(fs.lstatSync(src).isSymbolicLink())throw Error('Symlink forbidden: '+file);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const buf=fs.readFileSync(src);fs.writeFileSync(target,/\.(?:html|js|css)$/.test(file)?transform(buf.toString('utf8'),file):buf);
 }
 for(const file of ['preview.js','preview.css'])fs.copyFileSync(path.join(__dirname,file),path.join(out,'public',file));
 for(const file of ['server.cjs','fixtures.cjs','Dockerfile','.dockerignore'])fs.copyFileSync(path.join(__dirname,file),path.join(out,file));
 const manifest={schema:'shrigma_dashboard_preview_artifact_v1',mode:'synthetic-read-only',files:FILES,endpointRoutes:Object.values(ENDPOINTS),inlineHashes:'recomputed from transformed inline bytes',builtFrom:'4441561',runtimeDependencies:[]};
 fs.writeFileSync(path.join(out,'artifact-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 return {files:FILES.length+7,directory:out};
}
if(require.main===module){if(!process.argv[2])throw Error('Usage: node build.cjs /absolute/empty/destination');console.log(JSON.stringify(build(process.argv[2])));}
module.exports={build,transform,FILES,ENDPOINTS};
