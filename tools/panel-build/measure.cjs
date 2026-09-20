/* Reproducible cold-document comparison, excluding API payloads, images and fonts. */
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),zlib=require('node:zlib');
const root=path.resolve(__dirname,'../..'),baseline=process.argv[2];
if(!baseline)throw Error('Usage: node tools/panel-build/measure.cjs <baseline-commit>');
const read=(file,old)=>old?cp.execFileSync('git',['show',baseline+':'+file],{cwd:root}):fs.readFileSync(path.join(root,file));
function measure(page,old){
 const html=read(page+'.html',old),source=html.toString();
 const attr=(tag,key)=>tag.match(new RegExp('\\b'+key+'=["\\\']([^"\\\']+)["\\\']','i'))?.[1];
 const scripts=[...source.matchAll(/<script\b[^>]*>/gi)].map(x=>attr(x[0],'src')).filter(Boolean);
 const styles=[...source.matchAll(/<link\b[^>]*>/gi)].filter(x=>attr(x[0],'rel')==='stylesheet').map(x=>attr(x[0],'href'));
 const local=files=>files.filter(f=>!/^https?:|^\/\//.test(f));
 const files=[page+'.html',...local(scripts),...local(styles)].map(x=>x.split('?')[0]);
 const bytes=files.map(f=>read(f,old));
 return {raw_bytes:bytes.reduce((a,b)=>a+b.length,0),gzip_bytes:bytes.reduce((a,b)=>a+zlib.gzipSync(b,{level:9}).length,0),script_requests:local(scripts).length,stylesheet_requests:local(styles).length,external_font_stylesheets:styles.filter(x=>x.includes('fonts.googleapis.com')).length};
}
const panels={};for(const page of Object.keys(require('./manifest.json'))){const before=measure(page,true),after=measure(page,false);panels[page]={before,after,gzip_reduction_percent:+((1-after.gzip_bytes/before.gzip_bytes)*100).toFixed(1)};}
console.log(JSON.stringify({baseline,method:'HTML + local CSS/JS, gzip level 9 per response; excludes API, images, font responses and warm-cache effects',panels},null,2));
