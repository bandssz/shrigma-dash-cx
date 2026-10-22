'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),vm=require('node:vm');
const runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational'),{createAuth}=require(runtime+'/auth.cjs'),{createServer}=require(runtime+'/server.cjs'),{FIXED_DESTINATIONS}=require(runtime+'/proxy.cjs');
const HOST='gerencial.synthetic.invalid',PASS='synthetic-password-2026',STAMP='2026-10-14T03:00:00.000Z';
test('campaign copy accepts registered HTML without head and adds unsubscribe only to the copy',()=>{
 const {DOMParser,parseHTML}=require('linkedom'),{document}=parseHTML('<html><body></body></html>'),src=fs.readFileSync(runtime+'/public/crm-preview/drafts.js','utf8'),start=src.indexOf(' function campaignModelContent('),end=src.indexOf(' function renderCampaignAudience(',start),sandbox={scope:{brand:'fish'},feature:()=>false,DOMParser,document};vm.runInNewContext(src.slice(start,end),sandbox);
 const model={brand:'fish',channel:'email',content_available:true,components:{subject:'Published source',body_html:'<html><body style="color:#242424"><a href="https://fishermans.com.br">Published source content</a></body></html>'}},before=JSON.stringify(model),copy=sandbox.campaignModelContent(model);a.ok(copy.html.includes('Published source content'));a.ok(copy.html.includes('{{ UnsubscribeURL }}'));a.ok(copy.text.includes('{{ UnsubscribeURL }}'));a.ok(copy.html.includes('style="color:#242424"'));a.equal(JSON.stringify(model),before);
 model.components.body_html='<p>{{ .Tx.Customer }}</p>';a.throws(()=>sandbox.campaignModelContent(model),/MODEL_REQUIRES_JOURNEY/);
});
async function fixture(t,{fronts=['organico','influs'],brands=['aristo','fish'],hooks={},writeFronts,paidFacts=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tabler-read-')),areaHosts={growth:'crm.synthetic.invalid',organico:'organic.synthetic.invalid',influs:'influs.synthetic.invalid'},boot='synthetic-bootstrap';
 const auth=createAuth({dbPath:path.join(dir,'identity.sqlite'),managerHost:HOST,areaHosts,allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'admin@synthetic.invalid',bootstrapTokenSha256:crypto.createHash('sha256').update(boot).digest('hex'),encryptionKey:Buffer.alloc(32,8),simpleReadMode:true});await auth.completeBootstrap({email:'admin@synthetic.invalid',token:boot,password:PASS,host:HOST,origin:'https://'+HOST});
 const admin=await auth.login({email:'admin@synthetic.invalid',password:PASS,host:HOST,origin:'https://'+HOST}),ctx={host:HOST,origin:'https://'+HOST,method:'POST',cookieHeader:admin.cookie.split(';')[0],csrf:admin.csrf},user=await auth.simpleAccounts.create({context:ctx,email:'analyst@synthetic.invalid',password:PASS,jobTitle:'analista',fronts,brands,...(writeFronts?{writeFronts}:{})}),login=await auth.login({email:user.user.email,password:PASS,host:paidFacts?areaHosts.growth:HOST,origin:'https://'+(paidFacts?areaHosts.growth:HOST)});
 const paidFactsFile=path.join(dir,'paid-facts.json');if(paidFacts)fs.writeFileSync(paidFactsFile,JSON.stringify({CRM_SHOPIFY_ARISTO_CLIENT_ID:'synthetic',CRM_SHOPIFY_ARISTO_CLIENT_SECRET:'synthetic',CRM_SHOPIFY_FISH_CLIENT_ID:'synthetic',CRM_SHOPIFY_FISH_CLIENT_SECRET:'synthetic',PGPASSWORD:'synthetic'}),{mode:0o600});
 const keys={organico:'synthetic-organic-read',influs:'synthetic-influs-read'},upstreams=Object.fromEntries(['cache','influ'].map(k=>[k,new URL(FIXED_DESTINATIONS[k])])),calls=[];
 const source=brand=>({gerado_em:STAMP,coleta:{[brand]:STAMP},influs:[{marca:brand,influ:'Synthetic creator',modelo:'fixo',nicho:'Synthetic niche',comissao_pct:null}],roi:[{marca:brand,influ:'Synthetic creator',receita:null,pedidos:null,custo_lancado:null,comissao:null,patrocinio:null,investimento:null,investimento_total:null,roi:null,roi_total:null}],cupons:[{marca:brand,codigo:'SYNTHETIC',influ:null,tipo:'pendente',usos_lifetime:null,desconto_pct:null,influ_comissao_pct:null}],custos:[{marca:brand,influ:'Synthetic creator',competencia:'2026-10',fixo:25,produto:10,frete:5,patrocinio:null}],receita_cupom:[{marca:brand,codigo:'SYNTHETIC',pedidos:1,receita:40}],termos:[{marca:brand,influ:'Synthetic creator',modelo:'fixo',comissao_pct:5,vigente_desde:'2026-10-01'}],saude:[],private_customer:'synthetic-private@invalid.test'});
 const fetchImpl=async(url,o)=>{const u=new URL(url),influ=u.href.startsWith(FIXED_DESTINATIONS.influ),body=o.body?JSON.parse(o.body):null,brand=body?.marca||'aristo';calls.push({url:u.href,body});a.equal(o.headers.Cookie,undefined);a.equal(o.headers.Origin,undefined);a.equal(o.headers.Authorization,'Bearer '+keys[influ?'influs':'organico']);let value;
 if(influ){value={...source(brand),janela:{ini:body.ini,fim:body.fim}};}else value={_escopo:'organico',_cache_gerado_em:STAMP,cx_post:['aristo','fish'].map(b=>({marca:b,post_id:b+'-image',formato:'IMAGE',publicado_em:STAMP,ultima_coleta:STAMP,impulsionado:false,alcance:10,salvos:2,compartilhamentos:3,comentarios:null})),cx_story:[{marca:'aristo',story_id:'synthetic-story',publicado_em:STAMP,ultima_coleta:STAMP,alcance:10,respostas:2,saidas:3,link_clicks:4}],cx_conta_dia:[],cx_organico_receita:[]};await hooks.read?.();return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});};
 const settings={mode:'operational',simpleReadMode:true,simpleReadSources:keys,managerHost:HOST,areaHosts,allowedEmailDomains:['synthetic.invalid'],upstreamProfile:'production',upstreams,allowedUpstreamHosts:[...new Set(Object.values(upstreams).map(u=>u.hostname))],publicDir:dir,...(paidFacts?{paidFactsFile,dbPath:path.join(dir,'identity.sqlite')}:{})},server=createServer(settings,{auth,fetchImpl});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));auth.close();fs.rmSync(dir,{recursive:true,force:true});});
 const request=(url,{body,brand,host=HOST,cookie=login.cookie.split(';')[0]}={})=>new Promise((resolve,reject)=>{const bytes=body?Buffer.from(JSON.stringify(body)):null,req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method:body?'POST':'GET',headers:{Host:host,Origin:'https://'+host,Cookie:cookie,'X-CSRF-Token':login.csrf,...(brand?{'X-Shrigma-View-Brand':brand}:{}),...(bytes?{'content-type':'application/json','content-length':bytes.length}:{})}},res=>{let raw='';res.on('data',b=>raw+=b);res.on('end',()=>resolve({status:res.statusCode,body:res.headers['content-type']?.startsWith('application/json')?JSON.parse(raw):raw,headers:res.headers}));});req.on('error',reject);req.end(bytes);});
 return{request,auth,ctx,user,calls,source,login,hooks};
}
test('Tabler assets use each real front grant; shared kit aliases and health hashes are closed',async t=>{
 const f=await fixture(t);for(const front of ['organico','influs']){for(const name of ['','app.js','workspace.js','tema.css','vendor/tabler.min.css'])a.equal((await f.request('/app/'+front+'/'+name)).status,200);a.equal((await f.request('/app/'+front+'/../auth.cjs')).status,400);a.equal((await f.request('/app/'+front+'/organico-stories.js')).status,404);a.equal((await f.request('/app/'+front+'/app.js',{cookie:''})).status,401);}
 const health=await f.request('/healthz');a(health.body.workspacePublicFiles.some(r=>r.path==='/app/organico/workspace.js'));a(health.body.workspacePublicFiles.some(r=>r.path==='/app/influs/math.js'));a.equal((await f.request('/organico.html')).headers.location,'/app/organico/');a.equal((await f.request('/influs.html')).headers.location,'/app/influs/');
 const other=await fixture(t,{fronts:['afiliados']});a.equal((await other.request('/app/influs/')).status,403);a.equal((await other.request('/app/organico/')).status,403);a.equal((await f.request('/app/influs/',{host:'organic.synthetic.invalid'})).status,404);
});
test('the original read contracts keep brand, window, real fields and nulls on reload',async t=>{
 const f=await fixture(t);for(const brand of ['aristo','fish'])for(let n=0;n<2;n++){
 const r=await f.request('/api/influ',{body:{acao:'listar',marca:brand,ini:'2026-10-01',fim:'2026-10-14',pilot:false}});a.equal(r.status,200,JSON.stringify(r.body));a.equal(r.body.brand,brand);a.equal(r.body.roi[0].receita,null);a.equal(r.body.custos[0].fixo,25);a.equal(r.body.termos[0].comissao_pct,5);a.equal(r.body.coleta[brand],STAMP);a(!JSON.stringify(r.body).includes('private_customer'));
 a.match(r.headers['server-timing'],/^sourceHeaders;dur=\d+\.\d{2}, sourceBody;dur=\d+\.\d{2}, jsonParse;dur=\d+\.\d{2}, projection;dur=\d+\.\d{2}$/);a.doesNotMatch(r.headers['server-timing'],/synthetic|Bearer|private_customer/);
 const org=await f.request('/api/cache?painel=organico',{brand});a.equal(org.status,200);a.equal(org.body.cx_post.length,1);a.equal(org.body.cx_post[0].marca,brand);a.equal(org.body.cx_post[0].compartilhamentos,3);
 a.match(org.headers['server-timing'],/sourceHeaders;dur=\d+\.\d{2}/);a.match(org.headers['server-timing'],/projection;dur=\d+\.\d{2}/);
 }
 const denied=await f.request('/api/influ',{brand:'aristo',body:{acao:'listar',marca:'aristo',ini:'2026-10-01',fim:'2026-10-14',pilot:false}});a.equal(denied.status,400);
});
test('Influs nullable sums preserve unknown costs, orders and ROI; known totals remain actionable',()=>{
 const sandbox={window:{}};vm.runInNewContext(fs.readFileSync(runtime+'/public/influs-workspace/math.js','utf8'),sandbox);const G=sandbox.window.ShrigmaInflusMath,unknown=G.influKPI([{marca:'aristo',receita:null,pedidos:null,custo_lancado:null,comissao:null,patrocinio:null}],'aristo');for(const k of ['receita','investimento','roi','pedidos','custo','comissao','patrocinio'])a.equal(unknown[k],null,k);
 const known={marca:'aristo',receita:100,pedidos:2,custo_lancado:20,comissao:5,patrocinio:10},totals=G.influKPI([known],'aristo');a.equal(totals.investimento,25);a.equal(totals.roi,4);a.equal(totals.pedidos,2);a.equal(G.influKPI([known,{...known,custo_lancado:null}],'aristo').investimento,null);
});
module.exports={fixture};
test('accepted paid Home opens by HTTP to ordinary brand editors while comparison stays QA',async t=>{
 const paid=require(runtime+'/crm-paid-facts.cjs'),original=paid.create;t.mock.method(paid,'create',options=>original({...options,clientFactory:()=>({connect:async()=>{},end:async()=>{},query:async()=>({rows:[]})})}));
 const f=await fixture(t,{fronts:['growth'],brands:['fish'],writeFronts:['growth'],paidFacts:true}),host='crm.synthetic.invalid',session=await f.request('/auth/session',{host});a.equal(paid.canUse(session.body.user),false);a.equal(session.body.user.permissions.growth.edit,true);a(session.body.user.productWriteFronts.includes('growth'));
 const own=await f.request('/app/crm/restrito/inicio/?brand=fish',{host});a.equal(own.status,200,JSON.stringify(own.body));a.equal((await f.request('/app/crm/restrito/inicio/?brand=aristo',{host})).status,403);
 a.equal((await f.request('/api/crm-restricted/compras?action=home&brand=fish',{host})).status,200);a.equal((await f.request('/api/crm-restricted/compras?action=home&brand=aristo',{host})).status,403);
 for(const action of ['compare-home','compare-results'])a.equal((await f.request('/api/crm-restricted/compras?action='+action+'&brand=fish',{host})).status,403);a.equal((await f.request('/app/crm/restrito/comparacao-inicio/?brand=fish',{host})).status,403);
 const reader=await fixture(t,{fronts:['growth'],brands:['fish'],writeFronts:[],paidFacts:true});a.equal((await reader.request('/app/crm/restrito/inicio/?brand=fish',{host})).status,403);a.equal((await reader.request('/api/crm-restricted/compras?action=home&brand=fish',{host})).status,403);
});
test('CRM Home clears the prior brand synchronously even when preparation waits and authentication then fails',async()=>{
 const {parseHTML}=require('linkedom'),{window,document}=parseHTML(fs.readFileSync(runtime+'/public/crm-preview/index.html','utf8'));const proto=Object.getPrototypeOf(document.createElement('select'));Object.defineProperty(proto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 let finish;const pending=new Promise(r=>finish=r);window.ShrigmaPrepareRead=()=>pending;window.ShrigmaJourneyLabUI={instance:{hasUnsaved:()=>false},clear(){}};window.ShrigmaCrmHome={dates:()=>['2026-10-14']};
 const sandbox={window,document,location:{pathname:'/app/crm/',search:'?brand=aristo&view=home'},history:{replaceState(){}},URLSearchParams,AbortController,Intl,Date};for(const id of ['home-metrics','home-alerts','home-next','home-source'])document.getElementById(id).textContent='Prior Fish information';vm.runInNewContext(fs.readFileSync(runtime+'/public/crm-preview/app.js','utf8'),sandbox);
 for(const id of ['home-metrics','home-alerts','home-next','home-source'])a.equal(document.getElementById(id).textContent,'');finish(false);await new Promise(r=>setTimeout(r,5));a.equal(document.getElementById('error').classList.contains('d-none'),false);for(const id of ['home-metrics','home-alerts','home-next','home-source'])a.equal(document.getElementById(id).textContent,'');
});
test('CRM home attributes one brand, period and deduplicated channel grain; missing coverage is unknown',()=>{
 const H=require(runtime+'/public/crm-preview/home.js'),data={crm_attribution:{schema_version:2,coverage:[{brand:'aristo',day:'2026-10-14',checked_at:STAMP}],daily:[{marca:'aristo',dia:'2026-10-14',model:'last_click',grain:'channel',dimension:['email'],receita:100,pedidos:2},{marca:'aristo',dia:'2026-10-14',model:'last_click',grain:'piece',dimension:['email',null,null,null,null,null],receita:100,pedidos:2},{marca:'fish',dia:'2026-10-14',model:'last_click',grain:'channel',dimension:['email'],receita:999,pedidos:99},{marca:'aristo',dia:'2026-10-14',model:'last_non_direct',grain:'channel',dimension:['email'],receita:900,pedidos:90}]}};
 const result=H.summarize(data,'aristo','2026-10-14','2026-10-14');a.equal(result.revenue,100);a.equal(result.orders,2);a.equal(result.sent,null);a.equal(H.summarize(data,'fish','2026-10-14','2026-10-14').revenue,null);a.equal(H.summarize(data,'aristo','2026-10-13','2026-10-14').revenue,null);data.crm_attribution.daily.push({...data.crm_attribution.daily[0]});a.equal(H.summarize(data,'aristo','2026-10-14','2026-10-14').revenue,null);
});
test('CRM home daily health requires exact date coverage, unique rows and finite numeric fields',()=>{
 const H=require(runtime+'/public/crm-preview/home.js'),row={marca:'fish',dia:'2026-10-14',canal:'email',enviados:12,entregues:10,abriram:5,clicaram:2,hard:1,complaints:0,descadastros:1},data={crm_diario:[row]};let r=H.summarize(data,'fish','2026-10-14','2026-10-14');a.equal(r.sent,12);a.equal(r.openRate,0.5);a.equal(r.clickRate,0.2);a.equal(r.complaints,0);a.equal(r.orders,null);a.equal(H.summarize(data,'fish','2026-10-13','2026-10-14').sent,null);data.crm_diario.push({...row});a.equal(H.summarize(data,'fish','2026-10-14','2026-10-14').sent,null);data.crm_diario=[{...row,complaints:null}];a.equal(H.summarize(data,'fish','2026-10-14','2026-10-14').complaints,null);
});
test('CRM home validates calendar bounds and only shows original scheduled campaigns of the selected brand',()=>{
 const H=require(runtime+'/public/crm-preview/home.js');for(const [start,end] of [['2026-02-31','2026-03-02'],['2026-13-01','2026-13-02'],['2026-10-14','2026-10-13'],['2020-01-01','2026-10-14']])a.equal(H.dates(start,end).length,0);const r=H.summarize({crm_campanha:[{marca:'fish',nome:'Scheduled',status:'scheduled',agendado_em:STAMP},{marca:'aristo',status:'scheduled',agendado_em:STAMP},{marca:'fish',status:'draft',agendado_em:STAMP}]},'fish','2026-10-14','2026-10-14',{now:Date.parse(STAMP)-1000});a.equal(r.next.length,1);a.equal(r.next[0].nome,'Scheduled');
});
test('CRM daily totals ignore overlapping rolling snapshots and retain unknown delivery counts',()=>{
 const H=require(runtime+'/public/crm-preview/home.js'),row={marca:'fish',dia:'2026-10-14',canal:'email',janela:'1d',enviados:12,entregues:null,abriram:5,clicaram:2,hard:1,complaints:0,descadastros:1};
 const data={crm_diario:[row,{...row,janela:'7d',enviados:999},{...row,janela:'30d',enviados:9999},{...row,marca:'aristo',enviados:500}]};
 const r=H.summarize(data,'fish','2026-10-14','2026-10-14');a.equal(r.sent,12);a.equal(r.delivered,null);a.equal(r.openRate,null);a.equal(r.complaints,0);
 data.crm_diario.push({...row});a.equal(H.summarize(data,'fish','2026-10-14','2026-10-14').sent,null);
 data.crm_diario=data.crm_diario.filter(x=>x.janela!=='1d');a.equal(H.summarize(data,'fish','2026-10-14','2026-10-14').sent,null);
});
test('CRM exposes known partial revenue and independent order counts without inventing missing money',()=>{
 const H=require(runtime+'/public/crm-preview/home.js'),row={marca:'fish',dia:'2026-10-14',model:'last_click',grain:'channel',dimension:['email'],receita:null,pedidos:2};
 const data={crm_attribution:{schema_version:2,coverage:[{brand:'fish',day:'2026-10-13',checked_at:STAMP},{brand:'fish',day:'2026-10-14',checked_at:STAMP}],daily:[{...row,dia:'2026-10-13',receita:100,pedidos:1},row,{...row,marca:'aristo',receita:9000}]}};
 const r=H.summarize(data,'fish','2026-10-13','2026-10-14');a.equal(r.revenue,null);a.equal(r.knownRevenue,100);a.equal(r.attributionPartial,true);a.equal(r.orders,3);
 data.crm_attribution.coverage=[];a.equal(H.summarize(data,'fish','2026-10-13','2026-10-14').knownRevenue,null);
});
test('CRM last available window is scoped to actual daily data and never rolls forward from another brand',()=>{
 const H=require(runtime+'/public/crm-preview/home.js'),data={crm_diario:[{marca:'fish',dia:'2026-09-30',canal:'email',janela:'1d',enviados:10},{marca:'aristo',dia:'2026-10-14',canal:'email',janela:'1d',enviados:20}]};
 a.deepEqual(H.availableWindow(data,'fish','2026-10-08','2026-10-14'),{start:'2026-09-24',end:'2026-09-30'});
 a.equal(H.availableWindow(data,'aristo','2026-10-08','2026-10-14'),null);a.equal(H.availableWindow({},'fish','2026-10-08','2026-10-14'),null);
});
test('Organic last available window uses brand publication dates, excludes paid posts and preserves period length',()=>{
 const W=require(runtime+'/public/read-workspace.js'),rows=[{marca:'fish',publicado_em:'2026-09-30T15:00:00Z',impulsionado:false},{marca:'fish',publicado_em:'2026-10-14T15:00:00Z',impulsionado:true},{marca:'aristo',publicado_em:'2026-10-14T15:00:00Z',impulsionado:false}];
 a.deepEqual(W.availablePostWindow(rows,'fish','2026-10-08','2026-10-14'),{ini:'2026-09-24',fim:'2026-09-30'});a.equal(W.availablePostWindow(rows,'aristo','2026-10-08','2026-10-14'),null);a.equal(W.availablePostWindow([],'fish','2026-10-08','2026-10-14'),null);
});
test('Organic old posts cannot displace current stories or sales from the initial overview',()=>{
 const W=require(runtime+'/public/read-workspace.js'),data={cx_post:[{marca:'fish',publicado_em:'2026-09-30T15:00:00Z'}],cx_story:[{marca:'fish',publicado_em:'2026-10-14T15:00:00Z'}],cx_organico_receita:[{marca:'fish',dia:'2026-10-13'}]};
 for(const view of ['overview','stories','sales'])a.equal(W.availableOrganicWindow(data,'fish','2026-10-08','2026-10-14',view),null);
 a.deepEqual(W.availableOrganicWindow(data,'fish','2026-10-08','2026-10-14','posts'),{ini:'2026-09-24',fim:'2026-09-30'});
});
test('Compact CRM home preserves source numbers and nulls and excludes unrelated grains and private sections',()=>{
 const R=require(runtime+'/simple-dashboard-read.cjs'),H=require(runtime+'/public/crm-preview/home.js');const row={marca:'fish',dia:'2026-10-14',canal:'email',janela:'1d',enviados:12,entregues:null,abriram:5,clicaram:2,hard:1,complaints:0,descadastros:1};
 const data={brand:'fish',brands:['fish'],crm_credencial:[{secret:'must-not-be-copied'}],crm_fluxo:[{private:'not-home'}],crm_diario:[row,{...row,janela:'30d',enviados:300}],crm_attribution:{schema_version:2,coverage:[{brand:'fish',day:row.dia,checked_at:STAMP},{brand:'aristo',day:row.dia,checked_at:STAMP}],daily:[{marca:'fish',dia:row.dia,model:'last_click',grain:'channel',dimension:['email'],receita:10,pedidos:1},{marca:'fish',dia:row.dia,model:'last_click',grain:'piece',dimension:['email',null,null,null,null,null],receita:100,pedidos:10},{marca:'aristo',dia:row.dia,model:'last_click',grain:'channel',dimension:['email'],receita:999,pedidos:99}]},crm_campanha:[]};
 const small=R.projectCrmHome(data);a.equal(JSON.stringify(small).includes('must-not-be-copied'),false);a.equal(Object.hasOwn(small,'crm_fluxo'),false);a.equal(small.crm_diario.length,1);a.equal(small.crm_attribution.daily.length,1);a.equal(small.crm_attribution.coverage.length,1);a.equal(small.capabilities.send,false);a.deepEqual(H.summarize(small,'fish',row.dia,row.dia),H.summarize(data,'fish',row.dia,row.dia));a.throws(()=>R.projectCrmHome({...data,brands:['fish','aristo']}));
});
test('CRM known volume is partial and never replaces an unknown total or delivery denominator',()=>{
 const H=require(runtime+'/public/crm-preview/home.js'),row={marca:'fish',dia:'2026-10-13',canal:'email',janela:'1d',enviados:12,entregues:null};
 const r=H.summarize({crm_diario:[row,{...row,dia:'2026-10-14',enviados:null}]},'fish','2026-10-13','2026-10-14');a.equal(r.sent,null);a.equal(r.knownSent,12);a.equal(r.volumePartial,true);a.equal(r.openRate,null);
});
test('Compact CRM cannot turn a mixed legacy and rolling grain into a confirmed daily total',()=>{
 const R=require(runtime+'/simple-dashboard-read.cjs'),H=require(runtime+'/public/crm-preview/home.js'),row={marca:'fish',dia:'2026-10-14',canal:'email',enviados:12};
 const data={brand:'fish',brands:['fish'],crm_diario:[row,{...row,janela:'7d',enviados:70}],crm_campanha:[]};
 a.equal(H.summarize(data,'fish',row.dia,row.dia).sent,null);a.equal(H.summarize(R.projectCrmHome(data),'fish',row.dia,row.dia).sent,null);
 data.crm_diario=[row];a.equal(H.summarize(R.projectCrmHome(data),'fish',row.dia,row.dia).sent,12);
});
const Home=require(runtime+'/public/crm-preview/home.js'),HomeRead=require(runtime+'/simple-dashboard-read.cjs');
const homeRow=(extra={})=>({marca:'fish',dia:'2026-10-14',model:'last_click',grain:'channel',dimension:['email'],receita:100,pedidos:2,...extra});
const homeData=(daily=[homeRow()],extra={})=>({brand:'fish',brands:['fish'],crm_attribution:{schema_version:2,money_basis:'net_payment_brl',daily,coverage:[{brand:'fish',day:'2026-10-14',checked_at:STAMP}]},...extra});
test('CRM retains covered subtotals when a day is absent without promoting them to complete totals',()=>{
 const data=homeData(undefined,{crm_diario:[{marca:'fish',dia:'2026-10-14',canal:'email',janela:'1d',enviados:12}]});
 const r=Home.summarize(HomeRead.projectCrmHome(data),'fish','2026-10-14','2026-10-15');a.equal(r.revenue,null);a.equal(r.knownRevenue,100);a.equal(r.orders,null);a.equal(r.knownOrders,2);a.equal(r.sent,null);a.equal(r.knownSent,12);a.equal(r.coverage.revenueKnownDays,1);a.equal(r.coverage.covered,1);a.equal(r.volumePartial,true);a.equal(r.openRate,null);
 const independent=Home.summarize(homeData([homeRow({pedidos:null})]),'fish','2026-10-14','2026-10-14');a.equal(independent.revenue,100);a.equal(independent.orders,null);a.equal(independent.knownOrders,null);
});
test('numeric strings are converted before summing and net revenue can be negative without negative counts',()=>{
 const data=homeData([homeRow({receita:'-12.34',pedidos:'2'})],{crm_diario:[{marca:'fish',dia:'2026-10-14',canal:'email',janela:'1d',enviados:'12',entregues:'10',abriram:'5',clicaram:'2'}]});
 const r=Home.summarize(HomeRead.projectCrmHome(data),'fish','2026-10-14','2026-10-14');a.equal(r.revenue,-12.34);a.equal(r.orders,2);a.equal(r.sent,12);a.equal(r.openRate,0.5);a.equal(r.clickRate,0.2);
 data.crm_attribution.daily[0].pedidos='-2';data.crm_diario[0].enviados='2.5';const invalid=Home.summarize(data,'fish','2026-10-14','2026-10-14');a.equal(invalid.orders,null);a.equal(invalid.sent,null);a.equal(invalid.revenue,-12.34);
});
test('a missing or structurally incomplete attribution relation cannot become a covered zero',()=>{
 for(const daily of [undefined,null,[{marca:'fish',dia:'2026-10-14',receita:100}],[homeRow({dimension:[]})],[homeRow({dia:'2026-02-30'})],[homeRow({model:''})]]){const raw=homeData(daily);raw.crm_attribution.daily=daily;for(const d of [raw,HomeRead.projectCrmHome(raw)]){const r=Home.summarize(d,'fish','2026-10-14','2026-10-14');a.equal(r.revenue,null);a.equal(r.orders,null);a.equal(r.knownRevenue,null);a.equal(r.attributionAvailable,false);}}
 const empty=Home.summarize(HomeRead.projectCrmHome(homeData([])),'fish','2026-10-14','2026-10-14');a.equal(empty.revenue,0);a.equal(empty.orders,0);a.equal(empty.sent,null);
});
test('brand aliases normalize consistently and conflicting attribution markers are refused',()=>{
 const row=homeRow({marca:'fishermans'});delete row.marca;row.brand='fishermans';const d=homeData([row]);d.crm_attribution.coverage=[{marca:'fish',day:'2026-10-14',checked_at:STAMP}];const compact=HomeRead.projectCrmHome(d);a.equal(compact.crm_attribution.daily[0].marca,'fish');a.equal(compact.crm_attribution.coverage[0].brand,'fish');a.equal(Home.summarize(compact,'fish','2026-10-14','2026-10-14').revenue,100);
 d.crm_attribution.daily[0].marca='aristo';a.throws(()=>HomeRead.projectCrmHome(d),/CRM_HOME_SCOPE_UNCONFIRMED/);a.equal(Home.summarize(d,'fish','2026-10-14','2026-10-14').revenue,null);
});
test('a WhatsApp rolling window cannot suppress a legitimate email daily row',()=>{
 const d=homeData([],{crm_diario:[{marca:'fish',dia:'2026-10-14',canal:'email',enviados:12},{marca:'fish',dia:'2026-10-14',canal:'whatsapp',janela:'7d',enviados:700}]});a.equal(Home.summarize(d,'fish','2026-10-14','2026-10-14').sent,12);a.equal(Home.summarize(HomeRead.projectCrmHome(d),'fish','2026-10-14','2026-10-14').sent,12);
});
test('past scheduled campaigns never occupy the next-campaign slots',()=>{
 const now=Date.parse('2026-10-14T12:00:00Z'),past=Array.from({length:6},(_,i)=>({marca:'fish',nome:'Late '+i,status:'scheduled',agendado_em:new Date(now-(i+1)*60000).toISOString()})),future=[{marca:'fish',nome:'Next',status:'scheduled',agendado_em:new Date(now+60000).toISOString()}],r=Home.summarize({crm_campanha:[...past,...future]},'fish','2026-10-14','2026-10-14',{now});a.equal(r.overdueCount,6);a.equal(r.overdue.length,5);a.deepEqual(r.next.map(x=>x.nome),['Next']);
});
test('source clocks retain their meaning and cannot use unrelated or other-brand receipts as Shopify freshness',()=>{
 const d=homeData([],{crm_fontes:[{fonte:'listmonk_snapshot',coletado_em:'2026-10-14T11:00:00Z'},{fonte:'shopify_conversao',coletado_em:'2026-10-14T10:00:00Z'},{marca:'aristo',fonte:'shopify_conversao',coletado_em:'2099-01-01T00:00:00Z'}],crm_collection_receipt:[{brand:'fish',source:'unrelated',observed_at:'2099-01-01T00:00:00Z'},{brand:'fish',source:'legacy_conversion',observed_at:'2026-10-14T10:05:00Z'}]});d.crm_attribution.generated_at='2026-10-14T11:30:00Z';const r=Home.summarize(HomeRead.projectCrmHome(d),'fish','2026-10-14','2026-10-14');a.equal(r.sourceTimes.mail,'2026-10-14T11:00:00Z');a.equal(r.sourceTimes.shopify,'2026-10-14T10:05:00Z');a.equal(r.sourceTimes.attribution,'2026-10-14T11:30:00Z');a.notEqual(r.sourceTimes.attribution,r.sourceTimes.cache);
});
test('campaign and flow results use one last-click tuple and never claim active automation status',()=>{
 const row=homeRow({grain:'flow_piece',dimension:['email','campaign-or-flow','step'],receita:20,pedidos:1}),d=homeData([homeRow(),row]),r=Home.summarize(HomeRead.projectCrmHome(d),'fish','2026-10-14','2026-10-14');a.equal(r.revenue,100);a.equal(r.flowResults[0].knownRevenue,20);a.equal(r.flowResults[0].knownOrders,1);a.equal(Object.hasOwn(r.flowResults[0],'active'),false);
 d.crm_attribution.daily.push({...row});const invalid=Home.summarize(HomeRead.projectCrmHome(d),'fish','2026-10-14','2026-10-14');a.equal(invalid.flowResultsAvailable,false);a.equal(invalid.flowResults.length,0);a.equal(invalid.revenue,100);
});

test('known negative net flow revenue ranks before unknown revenue',()=>{const d=homeData([homeRow(),...Array.from({length:8},(_,i)=>homeRow({grain:'flow_piece',dimension:['email','unknown-'+i,'a'],receita:null})),homeRow({grain:'flow_piece',dimension:['email','refund','a'],receita:-5})]);const r=Home.summarize(d,'fish','2026-10-14','2026-10-14');a.equal(r.flowResults[0].flow,'refund');a.equal(r.flowResults[0].knownRevenue,-5);});

test('CRM registered click totals require proven 1d windows and never become unique clicks or CTR',()=>{
 const H=require(runtime+'/public/crm-preview/home.js'),row={marca:'fish',dia:'2026-10-14',canal:'email',janela:'1d',cliques:25,clicaram:2,entregues:null},data={brand:'fish',brands:['fish'],crm_diario:[row,{...row,janela:'7d',cliques:999},{...row,janela:'30d',cliques:9999},{...row,marca:'aristo',cliques:500}]};
 let r=H.summarize(HomeRead.projectCrmHome(data),'fish','2026-10-14','2026-10-14');a.equal(r.clicks,25);a.equal(r.clicked,2);a.equal(r.clickRate,null);a.equal(r.mailKnownDays.clicks,1);
 data.crm_diario[0].entregues=10;r=H.summarize(data,'fish','2026-10-14','2026-10-14');a.equal(r.clicks,25);a.equal(r.clickRate,0.2);data.crm_diario[0].cliques=100;a.equal(H.summarize(data,'fish','2026-10-14','2026-10-14').clickRate,0.2);
 r=H.summarize(data,'fish','2026-10-13','2026-10-14');a.equal(r.clicks,null);a.equal(r.knownClicks,100);a.equal(r.mailKnownDays.clicks,1);
 for(const cliques of [0,null]){r=H.summarize({crm_diario:[{...row,cliques}]},'fish','2026-10-14','2026-10-14');a.equal(r.clicks,cliques);}
 a.equal(H.summarize({crm_diario:[row,{...row}]},'fish','2026-10-14','2026-10-14').clicks,null);const legacy={...row};delete legacy.janela;a.equal(H.summarize({crm_diario:[legacy]},'fish','2026-10-14','2026-10-14').clicks,null);
});

test('CRM available window retains selected proven daily clicks even without sends or sales',()=>{
 const H=require(runtime+'/public/crm-preview/home.js'),row={marca:'fish',dia:'2026-10-15',canal:'email',janela:'1d',cliques:25,enviados:null},data={crm_diario:[row,{...row,dia:'2026-10-14',enviados:12,cliques:10}]};
 a.equal(H.availableWindow(data,'fish','2026-10-15','2026-10-15'),null);
 data.crm_diario[0].cliques=null;a.deepEqual(H.availableWindow(data,'fish','2026-10-15','2026-10-15'),{start:'2026-10-14',end:'2026-10-14'});
 data.crm_diario[0].cliques=25;delete data.crm_diario[0].janela;a.deepEqual(H.availableWindow(data,'fish','2026-10-15','2026-10-15'),{start:'2026-10-14',end:'2026-10-14'});
});
