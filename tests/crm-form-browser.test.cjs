'use strict';
// Synthetic browser contract for the form. This is not the real-account UI preview.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../services/dashboard-operational/public/crm-preview'),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let server,chrome,profile,client,origin,chromeError='',browserVersion;
class CDP{
 constructor(socket){this.socket=socket;this.next=0;this.pending=new Map();this.events=[];socket.addEventListener('message',event=>{const data=JSON.parse(String(event.data));if(data.id){const call=this.pending.get(data.id);if(!call)return;this.pending.delete(data.id);clearTimeout(call.timer);data.error?call.reject(Error(data.error.message)):call.resolve(data.result);}else for(const listener of this.events)listener(data);});socket.addEventListener('close',()=>this.fail(Error('CDP_CLOSED')));socket.addEventListener('error',()=>this.fail(Error('CDP_SOCKET_ERROR')));}
 fail(error){for(const call of this.pending.values()){clearTimeout(call.timer);call.reject(error);}this.pending.clear();}
 call(method,params={},sessionId,timeout=8000){return new Promise((resolve,reject)=>{if(this.socket.readyState!==WebSocket.OPEN){reject(Error('CDP_NOT_OPEN'));return;}const id=++this.next,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP_TIMEOUT '+method));},timeout);this.pending.set(id,{resolve,reject,timer});try{this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});}
 async evaluate(sessionId,expression){const data=await this.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(data.exceptionDetails)throw Error(data.exceptionDetails.exception?.description||data.exceptionDetails.text);return data.result.value;}
 close(){this.fail(Error('CDP_CLOSED'));this.socket.close();}
}
function fixtureHtml(brand,mode){
 return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tabler.min.css"></head><body><main class="container-xl py-3"><button id="new-campaign" type="button" class="btn btn-outline-primary">Nova campanha</button><button id="new-audience" type="button" hidden>Novo público</button>'+['crm-pending','campaign-editor','audience-editor','campaign-drafts','audience-draft-status','campaign-draft-status'].map(id=>'<div id="'+id+'"></div>').join('')+'</main><script src="/model-library.js"></script><script src="/model-import.js"></script><script src="/drafts.js"></script><script>('+browserFixture.toString()+')('+JSON.stringify(brand)+','+JSON.stringify(mode)+');</script></body></html>';
}
function browserFixture(brand,mode){
 const version='a'.repeat(32),domain=brand==='fish'?'fishermans.com.br':'oaristocrata.com',definition={brand,name:'Campanha sintética',subject:'Assunto preservado',from_email:'marca@'+domain,reply_to:'respostas@'+domain,text:'Mensagem https://'+domain+' {{ UnsubscribeURL }}',html:'<p>Mensagem preservada</p>',template_id:1,list_ids:[7],initiative:{key:'fixture',name:'Fixture'},utm_campaign:'fixture'};
 const record={id:185,version,status:'draft',sent:0,started_at:null,send_at:null,definition},state={brand,view:'campaigns',ticket:1};
 window.fixtureCommands=[];window.fixtureSaveCount=0;window.fixtureSaveGate=new Promise(resolve=>window.releaseFixtureSave=resolve);
 const read=async(url,b,t,options={})=>{
  if(b!==brand||t!==1)throw Error('FIXTURE_SCOPE');
  const p=options.method==='POST'?JSON.parse(options.body):Object.fromEntries(new URL('http://synthetic.invalid'+url).searchParams);window.fixtureCommands.push(p);
  switch(p.acao){
   case 'campanha_capacidade':return {brand,read:true,draft:true,send:false};
   case 'campanha_teste_capacidade':return {brand,internalTest:false,recovery:false,send:false};
   case 'campanha_catalogo':return {templates:[{id:1,name:'Layout original',available:true}],lists:[{id:7,name:'Lista sintética',available:true}]};
   case 'campanha_listar':return {campaigns:[record]};
   case 'campanha_obter':return {campaign:record};
   case 'campanha_teste_historico':return {schema:'crm-campaign-test-history-v1',contract:'crm-native-campaign-test-v1',user_id:'synthetic-user',brand,campaign_id:Number(p.id),attempts:[]};
   case 'campanha_nativa_capacidade':return {schema:'crm-native-internal-capability-v1',brand,enabled:true,homologation_available:true,internal_test:true,commercial:false};
   case 'campanha_previa':return {schema:'crm-campaign-preflight-v1',brand,ready:true};
   case 'campanha_criar':case 'campanha_salvar':window.fixtureSaveCount++;window.fixtureSubmitted=structuredClone(p.definition);await window.fixtureSaveGate;record.definition=p.definition;if(p.acao==='campanha_criar')record.id=186;record.version='b'.repeat(32);return {attemptKey:p.idempotency_key,state:'succeeded',campaign:record};
   default:throw Error('UNEXPECTED_FIXTURE_ACTION '+p.acao);
  }
 };
 const editor=window.ShrigmaCrmDrafts.create({state:()=>state,read,availability:{internalCampaignTest:false,recipientValidation:false,audienceCount:false},session:async()=>({authenticated:true,user:{id:'synthetic-user',email:'felipebandeira+codex@oaristocrata.com',role:'manager',brands:[brand],productWriteFronts:['growth'],permissions:{growth:{read:true,edit:true}}}}),esc:value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),when:String,number:String,reload(){}});
 window.fixtureReady=editor.load('campaigns',1).then(()=>{if(mode==='create')document.getElementById('new-campaign').click();else document.querySelector('[data-open-draft]').click();});
}
before(async()=>{
 server=http.createServer((request,response)=>{
  const url=new URL(request.url,'http://synthetic.invalid');
  if(request.method!=='GET'){response.writeHead(405).end();return;}
  if(url.pathname==='/case.html'&&['fish','aristo'].includes(url.searchParams.get('brand'))){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(fixtureHtml(url.searchParams.get('brand'),url.searchParams.get('mode')==='create'?'create':'edit'));return;}
  const allowed={'/drafts.js':'drafts.js','/model-library.js':'model-library.js','/model-import.js':'model-import.js','/tabler.min.css':'../afiliados-preview/vendor/tabler.min.css'},file=allowed[url.pathname];
  if(!file){response.writeHead(404).end();return;}
  try{const body=fs.readFileSync(path.join(root,file));response.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':'text/javascript'}).end(body);}catch{response.writeHead(500).end('FIXTURE_ASSET_UNAVAILABLE');}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 profile=fs.mkdtempSync(path.join(os.tmpdir(),'crm-form-browser-'));
 chrome=spawn(process.env.CHROME_BIN||'google-chrome',['--headless=new','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--disable-gpu','about:blank'],{stdio:['ignore','ignore','pipe']});
 chrome.stderr.on('data',data=>{chromeError=(chromeError+data.toString()).slice(-4000);});
 let startupError;chrome.on('error',error=>startupError=error);
 const file=path.join(profile,'DevToolsActivePort');for(let i=0;i<300&&!fs.existsSync(file);i++){if(startupError)throw startupError;if(chrome.exitCode!==null||chrome.signalCode!==null)throw Error('CHROME_EXIT '+chrome.exitCode+' '+chromeError);await delay(100);}
 assert.ok(fs.existsSync(file),'Chrome debugging endpoint was not ready');
 const [port,endpoint]=fs.readFileSync(file,'utf8').trim().split('\n'),socket=new WebSocket('ws://127.0.0.1:'+port+endpoint);
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});client=new CDP(socket);
 browserVersion=await client.call('Browser.getVersion');console.log(JSON.stringify({proof:'synthetic-form-browser',node:process.version,chrome:browserVersion.product,source:'branch-workspace',production:false}));
}, {timeout:45000});
after(async()=>{
 try{if(client)await client.call('Browser.close',{},undefined,2000);}catch{}
 finally{
  client?.close();const running=()=>chrome&&chrome.exitCode===null&&chrome.signalCode===null;
  if(running()){chrome.kill('SIGTERM');for(let i=0;i<50&&running();i++)await delay(100);if(running()){chrome.kill('SIGKILL');for(let i=0;i<30&&running();i++)await delay(100);}}
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(profile&&!running())fs.rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  assert.equal(Boolean(running()),false,'Chrome must exit before removing the temporary profile');
 }
}, {timeout:15000});
for(const brand of ['fish','aristo'])for(const width of [1440,390])for(const mode of ['edit','create'])test('native browser retains campaign form semantics '+brand+' '+width+' '+mode,{timeout:45000},async()=>{
 const target=await client.call('Target.createTarget',{url:'about:blank'}),attached=await client.call('Target.attachToTarget',{targetId:target.targetId,flatten:true}),session=attached.sessionId,external=[];
 const requestListener=event=>{if(event.sessionId!==session||event.method!=='Fetch.requestPaused')return;const p=event.params,url=p.request.url;const local=url.startsWith(origin+'/');if(!local)external.push(new URL(url).origin);client.call(local?'Fetch.continueRequest':'Fetch.failRequest',local?{requestId:p.requestId}:{requestId:p.requestId,errorReason:'BlockedByClient'},session).catch(()=>{});};
 client.events.push(requestListener);
 try{
  await client.call('Page.enable',{},session);await client.call('Runtime.enable',{},session);await client.call('Fetch.enable',{patterns:[{urlPattern:'*'}]},session);
  await client.call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width===390},session);
  await client.call('Page.navigate',{url:origin+'/case.html?brand='+brand+'&mode='+mode},session);
  let ready=false;for(let i=0;i<150;i++){ready=await client.evaluate(session,"Boolean(document.querySelector('#campaign-draft-form')&&window.fixtureCommands?.some(p=>p.acao==='campanha_catalogo')&&[...document.styleSheets].some(sheet=>sheet.cssRules.length>0))");if(ready)break;await delay(40);}assert.equal(ready,true,'real editor did not render');
  const before=await client.evaluate(session,"(()=>{const f=document.getElementById('campaign-draft-form');return {steps:[...f.querySelectorAll('[data-campaign-step]')].map(x=>({n:x.dataset.campaignStep,y:x.getBoundingClientRect().top})),forms:document.querySelectorAll('#campaign-draft-form').length,saves:f.querySelectorAll('button[type=submit]').length,from:document.getElementById('draft-from_email').value,reply:document.getElementById('draft-reply_to').value,lists:[...f.querySelectorAll('[name=draft-list]:checked')].map(x=>Number(x.value)),native:!!document.getElementById('campaign-native'),overflow:document.documentElement.scrollWidth>innerWidth};})()");
  assert.deepEqual(before.steps.map(x=>x.n),['1','2','3','4']);assert.ok(before.steps.every((step,index)=>index===0||step.y>before.steps[index-1].y));assert.equal(before.forms,1);assert.equal(before.saves,1);assert.equal(before.native,false);assert.equal(before.overflow,false);
  const domain=brand==='fish'?'fishermans.com.br':'oaristocrata.com';assert.equal(before.from,'marca@'+domain);assert.equal(before.reply,'respostas@'+domain);assert.deepEqual(before.lists,mode==='edit'?[7]:[]);
  if(mode==='create')await client.evaluate(session,"(()=>{const values={'draft-name':'Campanha sintética nova','draft-subject':'Assunto novo','draft-initiative-name':'Fixture nova','draft-initiative-key':'fixture-new','draft-utm':'fixture-new','draft-text':"+JSON.stringify('Mensagem nova https://'+domain+'/collections/all {{ UnsubscribeURL }}')+"};for(const [id,value]of Object.entries(values)){const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('[name=draft-list]').checked=true;})()");
  await client.evaluate(session,"document.querySelector('[data-crm-save]').click()");
  let busy;for(let i=0;i<100;i++){busy=await client.evaluate(session,"window.fixtureSaveCount===1");if(busy)break;await delay(20);}assert.equal(busy,true);
  const occupied=await client.evaluate(session,"(()=>{const f=document.getElementById('campaign-draft-form');f.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));return {busy:f.getAttribute('aria-busy'),label:f.querySelector('[data-crm-save]').textContent,disabled:[...f.querySelectorAll('button,input,textarea,select')].every(x=>x.disabled)};})()");
  assert.deepEqual(occupied,{busy:'true',label:'Salvando…',disabled:true});
  await delay(40);const submitted=await client.evaluate(session,"({count:window.fixtureSaveCount,checks:window.fixtureCommands.filter(p=>p.acao==='campanha_previa').length,definition:window.fixtureSubmitted,nativeWrites:window.fixtureCommands.filter(p=>/^campanha_nativa_/.test(p.acao)).length})");
  assert.equal(submitted.count,1);assert.equal(submitted.checks,1);assert.equal(submitted.nativeWrites,0);assert.equal(submitted.definition.from_email,before.from);assert.equal(submitted.definition.reply_to,before.reply);assert.deepEqual(submitted.definition.list_ids,[7]);assert.equal(submitted.definition.send_at,null);assert.equal(submitted.definition.subject,mode==='edit'?'Assunto preservado':'Assunto novo');if(mode==='edit')assert.equal(submitted.definition.html,'<p>Mensagem preservada</p>');else{assert.ok(submitted.definition.html.includes('href="https://'+domain+'/collections/all"'));assert.ok(submitted.definition.html.includes('{{ UnsubscribeURL }}'));}assert.equal(submitted.definition.name,mode==='edit'?'Campanha sintética':'Campanha sintética nova');
  await client.evaluate(session,'window.releaseFixtureSave()');
  let saved=false;for(let i=0;i<100;i++){saved=await client.evaluate(session,"document.getElementById('campaign-draft-form')?.getAttribute('aria-busy')==='false'&&document.getElementById('draft-name')?.value==="+JSON.stringify(mode==='edit'?'Campanha sintética':'Campanha sintética nova')+"");if(saved)break;await delay(20);}assert.equal(saved,true);
  const final=await client.evaluate(session,"({steps:document.querySelectorAll('[data-campaign-step]').length,count:window.fixtureSaveCount,native:!!document.getElementById('campaign-native')})");assert.deepEqual(final,{steps:4,count:1,native:false});
  assert.deepEqual(external,[]);console.log(JSON.stringify({proof:'synthetic-form-browser',brand,width,mode,steps:4,saves:1,postCount:1,externalRequests:0,production:false}));
 }finally{client.events=client.events.filter(listener=>listener!==requestListener);await client.call('Target.closeTarget',{targetId:target.targetId});}
});
