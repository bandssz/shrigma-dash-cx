'use strict';
// HTTP handler + existing load/KPI/Creators functions, with authored data only.
// No sockets, upstream, database, credentials or production effects.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {Readable}=require('node:stream'),{EventEmitter}=require('node:events'),{parseHTML}=require('linkedom');
const S=require('../services/dashboard-operational/server.cjs'),P=require('../services/dashboard-operational/proxy.cjs');
const html=fs.readFileSync(require.resolve('../influs.html'),'utf8');
const refused=()=>{throw Error('SYNTHETIC_ONLY_NETWORK_REFUSED');};
for(const name of ['node:net','node:tls','node:http','node:https','node:dgram']){const mod=require(name);for(const key of ['connect','createConnection','request','get','createSocket'])if(typeof mod[key]==='function')mod[key]=refused;if(mod.Server?.prototype)mod.Server.prototype.listen=refused;}
const hosts={manager:'manager.synthetic.invalid',growth:'growth.synthetic.invalid',organico:'organic.synthetic.invalid',influs:'influ.synthetic.invalid'};
function identity(brand='aristo',role='manager',area='influs'){
 const user={id:'synthetic-'+brand,email:'reader@synthetic.invalid',role,areas:role==='superadmin'?['growth','organico','influs']:[area],brand:role==='superadmin'?null:brand,brands:role==='superadmin'?['fish','aristo']:[brand],brandAccess:role==='superadmin'?'all':'single',permissions:{[area]:{read:true,edit:false}}},calls={credential:0,fetch:0,authorization:0};
 const auth={authorize(ctx){calls.authorization++;if(ctx.area&&!user.areas.includes(ctx.area)||ctx.edit||ctx.host!==(role==='superadmin'?hosts.manager:hosts[area]))throw Object.assign(Error('AREA_DENIED'),{code:'AREA_DENIED',status:403});return user;},authorizeBrand(ctx,selection){this.authorize(ctx);if(selection!==brand)throw Object.assign(Error('BRAND_DENIED'),{code:'BRAND_DENIED',status:403});return user;},getUpstreamCredential(){calls.credential++;throw Error('NO_SYNTHETIC_CREDENTIAL');}};
 return {auth,user,calls};
}
function app(t,i,mode='synthetic'){
 const server=S.createServer({mode,managerHost:hosts.manager,areaHosts:{growth:hosts.growth,organico:hosts.organico,influs:hosts.influs},upstreams:mode==='operational'?{influ:P.FIXED_DESTINATIONS.influ}:{},allowedUpstreamHosts:mode==='operational'?[new URL(P.FIXED_DESTINATIONS.influ).hostname]:[]},{auth:i.auth,fetchImpl:async()=>{i.calls.fetch++;throw Error('NO_UPSTREAM');}});
 t.after(()=>server.removeAllListeners());assert.equal(server.listening,false);return server;
}
function request(server,body,host=hosts.influs){return new Promise(resolve=>{
 const req=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req,{url:'/api/influ',method:'POST',headers:{host,origin:'https://'+host,cookie:'synthetic=session','x-csrf-token':'synthetic-csrf','content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'}});
 const res=new EventEmitter();res.setHeader=()=>{};res.end=bytes=>{res.writableFinished=true;res.emit('finish');resolve({status:res.statusCode,body:JSON.parse(String(bytes))});};server.emit('request',req,res);
});}
const period={ini:'2026-09-01',fim:'2026-09-20'},body={acao:'listar',...period,pilot:false},relations=['roi','influs','cupons','custos','receita_cupom','termos'];
function part(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert(a>=0&&b>a,start+' exists');return html.slice(a,b);}
function consumer(server,brand='aristo',master=false){
 const {document}=parseHTML(html),calls=[],state={document,window:{},$:selector=>document.querySelector(selector),AbortController,setTimeout,clearTimeout,Date,Intl,
  INFLU:null,INFLU_SEQ:0,INFLU_READ:null,INFLU_ULTIMA:null,PER:{...period},SEC:'creators',CANAL:'parceiros',MARCA:master?'todas':brand,NICHO:'',LEITURA_INFLU_MS:35000,INFLU_API_URL:'https://'+(master?hosts.manager:hosts.influs)+'/api/influ',
  INFLU_ACCESS:{current:()=> 'ui-synthetic-read',refresh(){},reject(){assert.fail('synthetic READ should remain admitted');},author:()=>''},chaveLeitura:()=> 'ui-synthetic-read',compAtual:()=>period.fim.slice(0,7),copiaLink:refused,abrirEditor:refused,
  fetch:async(raw,init)=>{assert.equal(new URL(raw).pathname,'/api/influ');assert.equal(init.method,'POST');const parsed=JSON.parse(init.body);calls.push({body:parsed,authorization:init.headers.Authorization});const r=await request(server,parsed,master?hosts.manager:hosts.influs);return {status:r.status,ok:r.status===200,json:async()=>r.body};},
  avisoTela:(title,detail)=>{document.querySelector('#area-tabela').textContent=title+' '+detail;},renderTudo(){vm.runInContext('renderKPIs();renderCreators()',context);},roiTxt2f:n=>n==null?'—':String(n)};
 const context=vm.createContext(state);
 vm.runInContext(part('const nf=n=>','\nlet MARCA='),context);
 vm.runInContext(part('function leituraInfluLimitada(run){','\nfunction chaveEscritaInflu()'),context);
 vm.runInContext(part('async function influPost(corpo,leitura={}){','\n/* Faixa de credencial.'),context);
 vm.runInContext(part('async function carregarInflu(){','\nfunction renderTudo()'),context);
 vm.runInContext(part('function renderKPIs(){','\nconst roiTxt=v=>'),context);
 vm.runInContext(part('function renderCreators(){',"\n$('#cr-busca').oninput="),context);
 return {context,state,document,calls,load:()=>vm.runInContext('carregarInflu()',context)};
}

test('first synthetic POST/listar preserves its body window and the six UI arrays',async t=>{
 for(const [brand,role]of [['aristo','manager'],['fish','manager'],['aristo','superadmin']]){
  const i=identity(brand,role),server=app(t,i),r=await request(server,body,role==='superadmin'?hosts.manager:hosts.influs);
  assert.equal(r.status,200);for(const key of relations)assert.ok(Array.isArray(r.body[key]),key+' required by carregarInflu');assert.deepEqual(r.body.janela,period);
  assert.equal(r.body.synthetic,true);assert.equal(r.body.preview,true);assert.equal(r.body.pode_escrever,false);assert.equal(r.body.capabilities.write,false);assert.equal(i.calls.credential,0);assert.equal(i.calls.fetch,0);
  if(role==='manager'){assert.equal(r.body.brand,brand);assert.deepEqual(r.body.brands,[brand]);for(const key of relations)assert.ok(r.body[key].every(row=>row.marca===brand));if(brand==='fish')assert.ok(relations.every(key=>r.body[key].length===0));}
 }
});
test('the existing loader renders nonzero costs, commission, sponsorship and a 10% contract from synthetic HTTP',async t=>{
 const i=identity(),page=consumer(app(t,i));await page.load();assert.ok(page.state.INFLU,'load must succeed');assert.equal(page.calls.length,1);assert.deepEqual(page.calls[0].body,body);assert.equal(Object.hasOwn(page.calls[0].body,'k'),false);
 const k=vm.runInContext('G.influKPI(INFLU.roi,MARCA)',page.context);assert.equal(k.receita,300);assert.equal(k.pedidos,3);assert.equal(k.custo,20);assert.equal(k.comissao,30);assert.equal(k.patrocinio,10);assert.equal(k.investimento,50);assert.equal(k.roi,6);
 const kpis=page.document.querySelector('#area-kpis').textContent;assert.match(kpis,/R\$\s*300/);assert.match(kpis,/R\$\s*50/);assert.match(kpis,/R\$\s*10/);assert.match(kpis,/a leitura ainda não traz clientes novos/);
 const creators=page.document.querySelector('#area-creators').textContent;assert.match(creators,/TESTE · Creator sintético/);assert.match(creators,/10,0%/);assert.doesNotMatch(creators,/1000,0%/);assert.equal(i.calls.fetch,0);assert.equal(i.calls.credential,0);
});
test('synthetic manager selectors and cross-area requests cannot expose another brand or consult an upstream',async t=>{
 const i=identity('fish'),server=app(t,i);
 for(const q of [{...body,marca:'aristo'},{...body,marca:'todas'}])assert.ok([400,403].includes((await request(server,q)).status));
 const growth=identity('fish','manager','growth');assert.equal((await request(app(t,growth),body,hosts.growth)).status,403);assert.equal(i.calls.credential,0);assert.equal(i.calls.fetch,0);assert.equal(growth.calls.credential,0);assert.equal(growth.calls.fetch,0);
});
test('production sector READ remains unavailable before credential selection or fetch',async t=>{
 const i=identity(),r=await request(app(t,i,'operational'),body);assert.equal(r.status,503);assert.equal(r.body.error,'BRAND_READ_CONTRACT_NOT_READY');assert.equal(i.calls.credential,0);assert.equal(i.calls.fetch,0);
});
test('synthetic changes never admit a write action',async t=>{
 const i=identity(),r=await request(app(t,i),{acao:'salvar',marca:'aristo',influ:'creator-teste'});assert.equal(r.status,403);assert.equal(i.calls.credential,0);assert.equal(i.calls.fetch,0);
});
