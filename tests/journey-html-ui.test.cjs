'use strict';
// Synthetic UI only. Network is a closed fake API; no message can leave.
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{parseHTML}=require('linkedom');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational'),engine=require(runtime+'/public/crm-preview/journey-engine.js'),Input=require(runtime+'/model-piece-input.cjs'),Library=require(path.resolve(__dirname,'../services/dashboard-operational/public/crm-preview/model-library.js'));
async function fixture({brand='aristo',onModelRead,lazyAssets=false}={}){
 const d=parseHTML('<main id="host"></main>'),host=d.document.getElementById('host');
 Object.defineProperty(d.window.HTMLInputElement.prototype,'checked',{configurable:true,get(){return this.hasAttribute('checked')},set(v){this.toggleAttribute('checked',!!v)}});
 Object.defineProperty(Object.getPrototypeOf(d.document.createElement('select')),'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value||this.querySelector('option')?.value||''},set(v){for(const o of this.querySelectorAll('option'))o.toggleAttribute('selected',o.value===String(v))}});
 const draft=engine.createDraft({brand,id:'synthetic-html-ui-'+brand}),store={schema:engine.SCHEMA,drafts:[draft],runs:[]},values=new Map(),calls=[],jobs=[];
 const session={authenticated:true,user:{id:'synthetic-ui-account',email:'felipebandeira+codex@oaristocrata.com',role:'analyst',brands:['aristo','fish'],productFronts:['growth'],productWriteFronts:['growth'],permissions:{growth:{read:true,edit:true}}}};
 const rawHtml='<style>@media(max-width:600px){h1{font-size:20px}}</style><h1>Modelo '+brand+'</h1><img src="https://cdn.shopify.com/s/files/1/test.png"><a href="https://example.invalid/track">Link</a>';
 const rascunho=Input.prepare({name:'Modelo '+brand,subject:'Assunto da peça',format:'html',content:rawHtml},brand),piece={draft_id:'d_piece_'+'a'.repeat(32),brand,channel:'email',version:1,rascunho};
 const fetchImpl=async(url,init={})=>{
  const u=new URL(url,'https://synthetic.invalid'),b=u.searchParams.get('brand')||u.searchParams.get('marca')||brand,method=init.method||'GET';calls.push({url,method,...(init.body?{body:JSON.parse(init.body)}:{})});let data,status=200;
  if(u.pathname==='/api/templates')data=u.searchParams.get('acao')==='fluxos_capacidade'?{contract:'crm-published-journey-read-v1',brand:b,read:true,readOnly:true,write:false}:{flows:[],checked_at:'2026-10-16T12:00:00Z'};
  else if(u.pathname==='/api/segments')data={segments:[]};
  else if(u.pathname==='/api/journey-lab')data={persistence:'server',userId:session.user.id,brand:b,revision:1,executes:false,store:{...store,drafts:b===brand?[draft]:[]}};
  else if(u.pathname==='/api/model-pieces'){await onModelRead?.();data={contract:'crm-model-drafts-v1',brand:b,drafts:[piece]};}
  else if(u.pathname==='/api/journey-test'&&method==='POST'){
   const p=JSON.parse(init.body);jobs.push({requestId:p.requestId,brand:p.brand,draftId:p.draftId,version:p.version,mode:'internal',recipient:'current-corporate-account',steps:[],status:'waiting',paused:false,accepted:0,uncertain:0,delivered:null,productionAudienceSelected:false,contentFormat:'html'});status=500;data={error:'synthetic response lost after accept'};
  }else if(u.pathname==='/api/journey-test')data={available:true,htmlAvailable:true,mode:'internal',productionAudienceSelected:false,tests:jobs};
  else throw Error('Unexpected synthetic path');
  return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
 };
 const sandbox={module:{exports:{}},document:d.document,ShrigmaCrmModelImport:{list:Input.list},ShrigmaCrmModels:{...Library,isolate:html=>Library.isolate(html,d.document)},URLSearchParams,AbortController,setTimeout,clearTimeout,console};
 let assetLoads=0;if(lazyAssets){sandbox.ShrigmaCrmModelImport=undefined;sandbox.ShrigmaCrmModels=undefined;sandbox.ShrigmaCrmAssetsReady=async()=>{assetLoads++;sandbox.ShrigmaCrmModelImport={list:Input.list};sandbox.ShrigmaCrmModels={...Library,isolate:html=>Library.isolate(html,d.document)};};}vm.runInNewContext(fs.readFileSync(runtime+'/public/crm-preview/journey-ui.js','utf8'),sandbox);
 const app=sandbox.module.exports.create({host,engine,serverStorage:true,availability:{internalJourneyTest:true},storage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},fetchImpl,getSession:async()=>session,uuid:()=> '33333333-3333-4333-8333-333333333333'});
 app.sync({brand,section:'regua',tab:'lab'});await app.read();
 const settle=async()=>{for(let n=0;n<300;n++){if(!app.state().busy)return;await new Promise(r=>setImmediate(r));}a.fail('UI did not settle');};
 return{get assetLoads(){return assetLoads},app,d,host,session,rawHtml,piece,calls,values,jobs,settle,q:s=>host.querySelector(s),async models(){host.querySelector('[data-lab-internal-read]').click();await settle();},select(){const s=host.querySelector('[data-lab-html-model]');s.value=piece.draft_id+':1';s.dispatchEvent(new d.window.Event('change'));}};
}
test('HTML selector preserves unsaved editor fields and the saved model stays unchanged',async()=>{
 for(const brand of ['aristo','fish']){const f=await fixture({brand});await f.models();a.equal(f.q('[data-lab-html-model] option').textContent,'Escolha o modelo desta etapa');const name=f.q('[data-lab-name]');name.value='Ainda não salvo';f.select();a.equal(f.q('[data-lab-name]').value,'Ainda não salvo');a.equal(f.q('[data-lab-html-model]').value,'');a.match(f.q('[data-lab-unsaved]').textContent,/preservados/);a.equal(f.piece.rascunho.corpo,f.rawHtml);a.equal(f.calls.filter(x=>x.method==='POST').length,0);}
});
test('responsive CSS is admitted; preview cannot load remote resources or navigate',async()=>{
 const f=await fixture();await f.models();f.select();a.equal(f.q('[data-lab-internal-html-start]').disabled,false);f.q('[data-lab-html-preview]').click();const frame=f.q('[data-lab-html-preview-host] iframe');a(frame);a.equal(frame.getAttribute('sandbox'),'');a.equal(frame.getAttribute('referrerpolicy'),'no-referrer');const html=frame.srcdoc;a.match(html,/default-src &#39;none&#39;/);a.match(html,/<body inert>/);/* linkedom template.innerHTML does not reflect mutations of template.content; real-browser proof checks removed URLs. */a.match(html,/@media/);a.equal(f.piece.rascunho.corpo,f.rawHtml);
});
test('uncertain START is recovered by GET and never repeats a POST',async()=>{
 const f=await fixture();await f.models();f.select();f.q('[data-lab-internal-html-start]').click();await f.settle();const posts=f.calls.filter(x=>x.method==='POST');a.equal(posts.length,1);a.equal(posts[0].body.action,'start_html');a.equal(Object.hasOwn(posts[0].body,'html'),false);a.equal(posts[0].body.models[0].pieceId,f.piece.draft_id);a.equal(f.jobs.length,1);a.equal([...f.values.keys()].some(k=>k.endsWith(':internal-pending')),false);a.equal(f.q('[data-lab-internal-html-start]').disabled,true);f.q('[data-lab-internal-read]').click();await f.settle();a.equal(f.calls.filter(x=>x.method==='POST').length,1);
});
test('brand change while model GET is pending discards the old brand models',async()=>{
 let release,entered;const started=new Promise(r=>entered=r),f=await fixture({onModelRead:()=>new Promise(r=>{release=r;entered();})});f.q('[data-lab-internal-read]').click();await started;f.app.sync({brand:'fish',section:'regua',tab:'lab'});release();await new Promise(r=>setImmediate(r));a.equal(f.app.state().context.brand,'fish');a.equal(f.q('[data-lab-html-model]'),null);a.equal(f.host.textContent.includes('Modelo aristo'),false);a.equal(f.calls.filter(x=>x.method==='POST').length,0);
});

test('direct laboratory entry loads shared model parser before querying HTML drafts',async()=>{const f=await fixture({lazyAssets:true});a.equal(f.assetLoads,0);await f.models();a.equal(f.assetLoads,1);f.select();a.equal(f.q('[data-lab-internal-html-start]').disabled,false);});
