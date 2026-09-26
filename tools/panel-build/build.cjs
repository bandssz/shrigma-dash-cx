/* Keep sources readable; publish classic-script bundles in their original order.
   No modules, identifier mangling, dependency fetching, or runtime configuration. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const esbuild=require('../campaign-runtime-build/node_modules/esbuild');
const root=path.resolve(__dirname,'../..'),manifest=require('./manifest.json'),check=process.argv.includes('--check');
// A targeted build leaves other panels and the shared login artifacts untouched.
const panelArg=process.argv.find(a=>a.startsWith('--panel=')),panel=panelArg?.slice('--panel='.length);
if(panelArg&&!Object.hasOwn(manifest,panel))throw Error('Unknown panel: '+panel);
const out=path.join(root,'assets/panels');if(!check)fs.mkdirSync(out,{recursive:true});
const hash=s=>crypto.createHash('sha256').update(s).digest('hex').slice(0,12);
const size=s=>({raw:Buffer.byteLength(s),gzip:zlib.gzipSync(s,{level:9}).length});
const proof={};let drift=false;
function output(file,text){if(check){if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==text){console.error('Outdated panel artifact: '+path.relative(root,file));drift=true;}}else fs.writeFileSync(file,text);}
for(const [page,{css,scripts}] of Object.entries(manifest)){
 if(panel&&page!==panel)continue;
 const sourceJS=scripts.map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n;\n');
 const sourceCSS=css.map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n');
 const js=esbuild.transformSync(sourceJS,{loader:'js',target:'es2022',minifyWhitespace:true,minifySyntax:true,minifyIdentifiers:false,legalComments:'inline',charset:'utf8'}).code;
 const style=esbuild.transformSync(sourceCSS,{loader:'css',target:'es2022',minify:true,legalComments:'inline',charset:'utf8'}).code;
 output(path.join(out,page+'.js'),js);output(path.join(out,page+'.css'),style);
 const file=path.join(root,page+'.html');let html=fs.readFileSync(file,'utf8');
 const inlineHashes=[...html.matchAll(/<script\s*>([\s\S]*?)<\/script>/g)].map(m=>"'sha256-"+crypto.createHash('sha256').update(m[1]).digest('base64')+"'");
 const connectSources='https://n8n-n8n.tazdb8.easypanel.host'+(page==='growth'?' https://n8n.shrigma.com.br':'');
 const csp="default-src 'self'; script-src 'self' "+inlineHashes.join(' ')+"; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src "+connectSources+"; font-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'";
 const security='<!-- PANEL_SECURITY --><meta http-equiv="Content-Security-Policy" content="'+csp+'">';
 if(!html.includes('<!-- PANEL_SECURITY -->'))html=html.replace('</head>','<!-- PANEL_SECURITY -->\n</head>');
 html=html.replace(/<!-- PANEL_SECURITY -->(?:<meta[^>]+>)?/,security);
 const cssTag=`<!-- PANEL_CSS --><link rel="stylesheet" href="assets/panels/${page}.css?v=${hash(style)}">`;
 const jsTag=`<!-- PANEL_JS --><script src="assets/panels/${page}.js?v=${hash(js)}"></script>`;
 html=html.replace(/<!-- PANEL_CSS -->(?:<link[^>]+>)?/,cssTag);
 if(!html.includes('<!-- PANEL_JS -->'))html=html.replace('</body>','<!-- PANEL_JS -->\n</body>');
 html=html.replace(/<!-- PANEL_JS -->(?:<script[^>]+><\/script>)?/,jsTag);
 output(file,html);
 proof[page]={js:{source:size(sourceJS),distributed:size(js),requests_before:scripts.length,requests_after:1},css:{source:size(sourceCSS),distributed:size(style),requests_after:1},html:size(html)};
}
// Separate public URLs share generated assets, never credentials or an authenticated session.
if(!panel||panel==='growth'){
const entryJS=esbuild.transformSync(['config.js','panel-entry.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n;\n'),{loader:'js',target:'es2022',minifyWhitespace:true,minifySyntax:true,minifyIdentifiers:false,charset:'utf8'}).code;
const entryCSS=esbuild.transformSync(fs.readFileSync(path.join(root,'panel-entry.css'),'utf8'),{loader:'css',minify:true}).code;
const crmEntryJS=esbuild.transformSync(['config.js','crm-entry.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n;\n'),{loader:'js',target:'es2022',minifyWhitespace:true,minifySyntax:true,minifyIdentifiers:false,charset:'utf8'}).code;
if(!panel){output(path.join(out,'entry.js'),entryJS);output(path.join(out,'entry.css'),entryCSS);}
output(path.join(out,'crm-entry.js'),crmEntryJS);
for(const [folder,area,label] of [['cx','cx','CX/CS'],['crm','growth','CRM'],['organico','organico','Orgânico'],['creators','influs','Influs & Afiliados'],['gestao','todos','Gestão geral']]){
 if(panel&&folder!=='crm')continue;
 const entryPanel=area;
 const entryScript=area==='growth'?'crm-entry.js':'entry.js',entryCode=area==='growth'?crmEntryJS:entryJS;
 const dir=path.join(root,folder);if(!check)fs.mkdirSync(dir,{recursive:true});
 const html=`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; connect-src https://n8n-n8n.tazdb8.easypanel.host; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>${label} · Shrigma</title><link rel="stylesheet" href="../assets/panels/entry.css?v=${hash(entryCSS)}"></head>
<body data-access-panel="${entryPanel}"><section id="entry-login" class="entry-login"><div class="entry-card"><div class="entry-brand">Shrigma</div><p class="entry-eyebrow">${entryPanel==='todos'?'Acesso exclusivo de Felipe':'Painel da área'}</p><h1>${label}</h1><p>${entryPanel==='todos'?'Entre com sua chave mestre para acessar as áreas de operação.':entryPanel==='growth'?'Entre com sua chave CRM.':'Use a credencial individual da sua área para consultar o painel.'}</p><form id="entry-form"><fieldset id="entry-fields"><label for="entry-key">Chave de acesso</label><input id="entry-key" type="password" autocomplete="off" spellcheck="false" maxlength="128" required>${entryPanel==='growth'?'':'<label for="entry-file">Ou importar arquivo de acesso</label><input id="entry-file" type="file" accept="application/json,.json">'}<button type="submit">Entrar</button></fieldset><button id="entry-cancel" type="button" class="entry-cancel" hidden>Cancelar espera</button><p id="entry-message" role="status" aria-live="polite"></p></form><p>A chave fica apenas nesta aba. Ao fechar ou sair, entre novamente.</p></div></section><section id="entry-shell" hidden><header class="entry-bar"><span id="entry-area"></span><nav id="entry-nav" aria-label="Áreas disponíveis" hidden></nav><div class="entry-session"><span id="entry-owner"></span><button id="entry-logout" type="button">Sair</button></div></header><div id="entry-frame"></div></section><script src="../assets/panels/${entryScript}?v=${hash(entryCode)}"></script></body></html>\n`;
 output(path.join(dir,'index.html'),html);
}
}
if(drift)process.exit(1);
console.log(JSON.stringify({check,panels:proof}));
