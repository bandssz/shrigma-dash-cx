/* Keep sources readable; publish classic-script bundles in their original order.
   No modules, identifier mangling, dependency fetching, or runtime configuration. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const esbuild=require('../campaign-runtime-build/node_modules/esbuild');
const root=path.resolve(__dirname,'../..'),manifest=require('./manifest.json'),check=process.argv.includes('--check');
const out=path.join(root,'assets/panels');if(!check)fs.mkdirSync(out,{recursive:true});
const hash=s=>crypto.createHash('sha256').update(s).digest('hex').slice(0,12);
const size=s=>({raw:Buffer.byteLength(s),gzip:zlib.gzipSync(s,{level:9}).length});
const proof={};let drift=false;
function output(file,text){if(check){if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==text){console.error('Outdated panel artifact: '+path.relative(root,file));drift=true;}}else fs.writeFileSync(file,text);}
for(const [page,{css,scripts}] of Object.entries(manifest)){
 const sourceJS=scripts.map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n;\n');
 const sourceCSS=css.map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n');
 const js=esbuild.transformSync(sourceJS,{loader:'js',target:'es2022',minifyWhitespace:true,minifySyntax:true,minifyIdentifiers:false,legalComments:'inline',charset:'utf8'}).code;
 const style=esbuild.transformSync(sourceCSS,{loader:'css',target:'es2022',minify:true,legalComments:'inline',charset:'utf8'}).code;
 output(path.join(out,page+'.js'),js);output(path.join(out,page+'.css'),style);
 const file=path.join(root,page+'.html');let html=fs.readFileSync(file,'utf8');
 const cssTag=`<!-- PANEL_CSS --><link rel="stylesheet" href="assets/panels/${page}.css?v=${hash(style)}">`;
 const jsTag=`<!-- PANEL_JS --><script src="assets/panels/${page}.js?v=${hash(js)}"></script>`;
 html=html.replace(/<!-- PANEL_CSS -->(?:<link[^>]+>)?/,cssTag);
 if(!html.includes('<!-- PANEL_JS -->'))html=html.replace('</body>','<!-- PANEL_JS -->\n</body>');
 html=html.replace(/<!-- PANEL_JS -->(?:<script[^>]+><\/script>)?/,jsTag);
 output(file,html);
 proof[page]={js:{source:size(sourceJS),distributed:size(js),requests_before:scripts.length,requests_after:1},css:{source:size(sourceCSS),distributed:size(style),requests_after:1},html:size(html)};
}
if(drift)process.exit(1);
console.log(JSON.stringify({check,panels:proof}));
