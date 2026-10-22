'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const {build,transform,CONTENT,ENDPOINTS,verifyCampaignAssets}=require('./build.cjs');
const {typeAndCsp}=require('./server.cjs');
const {inviteUrlForArea,readOnlyStyles,audienceDraftOperation}=require('./public/entry.compiled.js');

function withArtifact(fn){const dest=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-operational-'));try{build(dest);return fn(path.join(dest,'public'));}finally{fs.rmSync(dest,{recursive:true,force:true});}}
function sha(source){return crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');}

test('artifact contains only three team panels and management, without CX or backend files',()=>withArtifact(publicRoot=>{
 for(const entry of ['crm','organico','creators','gestao'])assert.equal(fs.existsSync(path.join(publicRoot,entry,'index.html')),true);
 for(const absent of ['cx/index.html','index.html','assets/panels/index.js','assets/panels/index.css','assets/panels/entry.js','services','n8n','.git'])assert.equal(fs.existsSync(path.join(publicRoot,absent)),false,absent);
 const manifest=JSON.parse(fs.readFileSync(path.join(path.dirname(publicRoot),'artifact-manifest.json')));
 assert.deepEqual(manifest.areas,['growth','organico','influs','todos']);
 assert.equal(manifest.publicFiles.length,30);
 assert.ok(manifest.publicFiles.includes('media-read.js'));
}));

test('build leaves original sources untouched and rewrites all literal upstream APIs',()=>{
 const root=path.resolve(__dirname,'../..'),before=Object.fromEntries(CONTENT.map(file=>[file,sha(path.join(root,file))]));
 withArtifact(publicRoot=>{
  for(const file of CONTENT.filter(x=>/\.(?:html|js)$/.test(x))){
   const text=fs.readFileSync(path.join(publicRoot,file),'utf8');
   assert.doesNotMatch(text,/https:\/\/(?:n8n(?:-n8n)?|comunicacao-[a-z-]+)\./i,file);
  }
  const growth=fs.readFileSync(path.join(publicRoot,'assets/panels/growth.js'),'utf8');
  for(const route of ['cx','cache','ab','influ','tts','tts-action','crm-read'])assert.ok(growth.includes(`/api/${route}`),route);
  for(const url of Object.keys(ENDPOINTS))assert.ok(!growth.includes(url),url);
 });
 for(const file of CONTENT)assert.equal(sha(path.join(root,file)),before[file],file);
});

test('operational CRM replaces the reviewed legacy media module with the read-only library',()=>withArtifact(publicRoot=>{
 const html=fs.readFileSync(path.join(publicRoot,'growth.html'),'utf8');
 const panel=fs.readFileSync(path.join(publicRoot,'assets/panels/growth.js'),'utf8');
 const media=fs.readFileSync(path.join(publicRoot,'media-read.js'),'utf8');
 assert.match(html,/<script src="\/media-read\.js"><\/script><script src="assets\/panels\/growth\.js\?/);
 assert.match(html,/GMediaRead\.mount\(\{marca:MARCA,api:API\}\)/);
 assert.doesNotMatch(html,/\bGMedia\.mount\b/);
 assert.doesNotMatch(panel,/\bGMedia\b|shrigma_media_upload_v1|crm-media-upload|\/api\/campaigns\/media/);
 assert.doesNotMatch(html+panel,/https:\/\/email\.shrigma\.com\.br\/admin\/campaigns\/media/);
 assert.doesNotMatch(media,/fetch\([^)]*https?:|<img|createElement\(['"]img['"]\)|FormData|sessionStorage|localStorage|Authorization|Bearer |method:\s*['"]POST['"]/);
 assert.match(media,/\/api\/campaigns_media/);
}));

test('operational build refuses unreviewed legacy media bytes instead of packaging upload handling',()=>{
 const panel=fs.readFileSync(path.resolve(__dirname,'../../assets/panels/growth.js'),'utf8');
 const start=panel.indexOf('const GMedia=(()=>{');
 assert.ok(start>=0);
 const changed=panel.slice(0,start)+'const GMedia=(()=>{/* unreviewed */'+panel.slice(start+'const GMedia=(()=>{'.length);
 assert.throws(()=>transform(changed,'assets/panels/growth.js'),/Legacy media module needs review/);
});

test('payment diagnostic is a CRM-only cookie-session page with no browser key form',()=>withArtifact(publicRoot=>{
 const html=fs.readFileSync(path.join(publicRoot,'growth-diagnostico.html'),'utf8');
 const ui=fs.readFileSync(path.join(publicRoot,'growth-diagnostic-ui.js'),'utf8');
 const growth=fs.readFileSync(path.join(publicRoot,'growth.html'),'utf8');
 assert.match(growth,/href="\/growth-diagnostico\.html">Diagnóstico de pedido pago<\/a>/);
 for(const file of ['growth-control.js','growth-delivery.js','growth-diagnostic.js','growth-diagnostic-ui.js'])assert.equal(fs.existsSync(path.join(publicRoot,file)),true,file);
 assert.match(html,/src="\/guard\.js"/);assert.match(html,/src="growth-diagnostic-ui\.js\?/);
 assert.match(html,/href="growth\.html"/);
 assert.doesNotMatch(html,/config\.js|auth-form|auth-key|type="password"|<script[^>]*src="https?:/);
 assert.doesNotMatch(ui,/CX_API_URL|shrigmaChave|shrigmaGuardaChave|shrigmaEsqueceChave|shrigmaMarcaMestra|Authorization|auth-key|auth-form|localStorage|sessionStorage/);
 assert.match(ui,/fetch\('\/api\/cx\?painel=growth',\{method:'GET'/);
 assert.match(ui,/credentials:'same-origin'/);
 assert.doesNotMatch(ui,/method:'POST'|\/api\/cx\?painel=cx/);
}));

test('payment diagnostic UI reads the approved Growth GET without transmitting a key or writing data',async()=>{
 const ui=withArtifact(publicRoot=>fs.readFileSync(path.join(publicRoot,'growth-diagnostic-ui.js'),'utf8'));
 const elements=new Map(),element=selector=>{
  if(!elements.has(selector))elements.set(selector,{value:'',hidden:false,disabled:false,textContent:'',innerHTML:'',addEventListener(){}});
  return elements.get(selector);
 };
 const calls=[];
 const context={document:{querySelector:element},GC:require('../../growth-control.js'),GDI:require('../../growth-diagnostic.js'),
  fetch:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(require('./fixtures.cjs').fixture('growth')),{status:200,headers:{'Content-Type':'application/json'}});},
  Response,AbortController,Blob,URL,Date,Intl,setTimeout,clearTimeout,setInterval:()=>0,console};
 vm.runInNewContext(ui,context);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/cx?painel=growth');
 assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.credentials,'same-origin');
 assert.equal(calls[0].options.headers.Authorization,undefined);assert.equal(calls[0].options.body,undefined);
 assert.match(element('#status').textContent,/Consulta recebida/);assert.equal(element('#result').hidden,false);
 assert.equal(typeof element('#export').onclick,'function');
});

test('the operational owner view accepts exactly CRM, Orgânico and Influs without CX',()=>withArtifact(publicRoot=>{
 const expected='panels.length===3&&new Set(panels).size===3&&["growth","organico","influs"].every(p=>panels.includes(p))';
 for(const area of ['growth','organico','influs']){
  const script=fs.readFileSync(path.join(publicRoot,'assets/panels',area+'.js'),'utf8');
  assert.ok(script.includes(expected),area);
  assert.ok(!script.includes('panels.length===4&&new Set(panels).size===4'),area);
 }
}));

test('entry uses email/password, fragment invites and same-origin CSP',()=>withArtifact(publicRoot=>{
 for(const entry of ['crm','organico','creators','gestao']){
  const html=fs.readFileSync(path.join(publicRoot,entry,'index.html'),'utf8');
  assert.match(html,/type="email"/);assert.match(html,/type="password"/);
  assert.doesNotMatch(html,/name="totp"|login-totp|bootstrap-totp|bootstrap-begin|bootstrap-secret|duas etapas|Código de verificação/);
  assert.doesNotMatch(html,/type="file"|entry-key|preview-api|\/cx\//);
  assert.match(html,/connect-src 'self'/);assert.match(html,/frame-src 'self'/);
 }
 const js=fs.readFileSync(path.join(publicRoot,'entry.js'),'utf8');
 assert.match(js,/\.get\(["']invite["']\)/);assert.match(js,/\.get\(["']bootstrap["']\)/);
 assert.match(js,/history\.replaceState/);assert.match(js,/\.uiKey/);
 assert.doesNotMatch(js,/login-totp|bootstrap-totp|bootstrap-begin|bootstrap-secret|mfa_required|\/auth\/bootstrap\/begin/);
 assert.doesNotMatch(js,/localStorage\.setItem|sessionStorage\.setItem|fetch\(['"]https:\/\//);
}));

test('login and initial admin activation send email and password without a verification code',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'public/entry.compiled.js'),'utf8');
 async function submit(hash,formId,values){
  const nodes=new Map(),handlers=new Map(),calls=[];
  const element=id=>{
   if(!nodes.has(id))nodes.set(id,{
    hidden:false,value:'',textContent:'',disabled:false,
    addEventListener(type,handler){handlers.set(`${id}:${type}`,handler);},
    focus(){},replaceChildren(){},setAttribute(){},querySelector(){return {disabled:false};}
   });
   return nodes.get(id);
  };
  const location={hash,pathname:'/',search:'',origin:'https://dashboard-v12-gerencial.tazdb8.easypanel.host'};
  const fetch=async(url,options)=>{
   calls.push({url,method:options?.method||'GET',body:options?.body&&JSON.parse(options.body)});
   if(url==='/auth/session')return new Response(JSON.stringify({authenticated:false}),{status:200});
   return new Response('{}',{status:url==='/auth/login'?401:200});
  };
  const context={window:{addEventListener(){}},document:{body:{dataset:{accessPanel:'todos'}},getElementById:element},
   location,history:{replaceState(){}},fetch,URL,URLSearchParams,Headers,AbortController,Response,setTimeout,clearTimeout};
  vm.runInNewContext(source,context);
  await new Promise(resolve=>setImmediate(resolve));
  for(const [id,value]of Object.entries(values))element(id).value=value;
  await handlers.get(`${formId}:submit`)({preventDefault(){}});
  return {calls,message:element('entry-message').textContent};
 }
 const login=await submit('','login-form',{'login-email':' FELIPEBANDEIRA@OARISTOCRATA.COM ','login-password':'example-password'});
 assert.deepEqual(login.calls.find(call=>call.url==='/auth/login'),{url:'/auth/login',method:'POST',body:{email:'felipebandeira@oaristocrata.com',password:'example-password'}});
 assert.match(login.message,/E-mail ou senha/);
 const bootstrap=await submit('#bootstrap='+'A'.repeat(43),'bootstrap-form',{
  'bootstrap-email':' FELIPEBANDEIRA@OARISTOCRATA.COM ','bootstrap-password':'example-password','bootstrap-confirm':'example-password'
 });
 assert.deepEqual(bootstrap.calls,[{url:'/auth/bootstrap/complete',method:'POST',body:{email:'felipebandeira@oaristocrata.com',token:'A'.repeat(43),password:'example-password'}}]);
 assert.match(bootstrap.message,/Entre com e-mail e senha/);
});

test('operational iframe opens only audience draft controls after a scoped presentation gate',()=>{
 const expected={
  growth:['#growth-acesso','#ab-acesso-legado','#crm-media-library-load','#crm-media .crm-media-integrated','#campaign-composer [data-ce-save]','#campaign-composer .ce-import','#control-drafts #drafts-importar','#control-drafts #draft-editor','#crm-segments-panel [data-gs="count"]','[data-crm-open-tab="control-tab-drafts"]','#crm-campaign-open'],
  organico:['#organico-acesso','#organico-acesso-bar','#ol-form','.ol-arquivar'],
  influs:['#influ-access','#i-form','.cr-edit','[data-pilot-save]','[data-cob]:not([data-cob="recarregar"])','#tts-acesso']
 };
 for(const [area,selectors]of Object.entries(expected)){
  const css=readOnlyStyles(area);
  for(const selector of selectors)assert.ok(css.includes('body.panel-embedded '+selector),area+' '+selector);
  assert.match(css,/display:none!important/);
 }
 for(const selector of ['#crm-segments-panel [data-gs="new"]','#crm-segments-panel [data-gs-fields]','#crm-segments-panel [data-gs="save"]','#crm-segments-panel [data-gs="archive"]','#crm-segments-panel [data-gs-dialog]','#crm-segments-panel .gs-shortcuts','#crm-audience-create','#crm-audience-brand-choices','#area-arvore .ga-rfm-create']){
  assert.ok(readOnlyStyles('growth').includes('body.panel-embedded:not(.dashboard-audience-draft-ready) '+selector),selector);
  assert.ok(readOnlyStyles('growth',{embeddedOnly:false}).includes('body:not(.dashboard-audience-draft-ready) '+selector),selector);
 }
 assert.doesNotMatch(readOnlyStyles('growth'),/body\.panel-embedded #crm-media,/);
 assert.doesNotMatch(readOnlyStyles('growth'),/body\.panel-embedded #crm-media-fields/);
 assert.doesNotMatch(readOnlyStyles('growth'),/body\.panel-embedded #crm-segments-panel,/);
 assert.doesNotMatch(readOnlyStyles('growth'),/body\.panel-embedded #control-drafts,/);
 assert.ok(readOnlyStyles('growth',{embeddedOnly:false}).includes('body #crm-media-library-load'));
 assert.equal(readOnlyStyles('cx'),'');
 withArtifact(publicRoot=>{
  assert.match(fs.readFileSync(path.join(__dirname,'public/entry.js'),'utf8'),/installReadOnlyPresentation\(selected\)/);
  const panel=fs.readFileSync(path.join(publicRoot,'assets/panels/growth.js'),'utf8');
  assert.match(panel,/ga-rfm-create/,'the packaged CRM includes the new RFM preset action');
  assert.match(panel,/gs-shortcuts/,'the packaged CRM includes the new condition shortcuts');
  for(const area of ['growth','organico','influs']){
   const html=fs.readFileSync(path.join(publicRoot,area+'.html'),'utf8');
   const style=html.match(/<style id="dashboard-operational-readonly">([\s\S]*?)<\/style>/);
   assert.ok(style,'direct page must carry read-only presentation: '+area);
   assert.equal(style[1],readOnlyStyles(area,{embeddedOnly:false}));
   assert.ok(html.indexOf(style[0])<html.indexOf('<script src="/guard.js"'),area);
  }
  assert.match(fs.readFileSync(path.join(publicRoot,'growth.html'),'utf8'),/id="crm-media"/);
  assert.match(fs.readFileSync(path.join(publicRoot,'organico.html'),'utf8'),/id="organico-chave-arquivo"/);
  assert.match(fs.readFileSync(path.join(publicRoot,'influs.html'),'utf8'),/id="influ-access"/);
 });
});

test('durable audience journal shape rejects malformed or unverified terminal operations',()=>{
 const key='123e4567-e89b-42d3-a456-426614174000';
 assert.equal(audienceDraftOperation({operation:null}),null);
 assert.equal(audienceDraftOperation({operation:{phase:'pending',action:'segmento_criar',operationKey:key}}).phase,'pending');
 assert.equal(audienceDraftOperation({operation:{phase:'uncertain',action:'segmento_salvar',operationKey:key}}).phase,'uncertain');
 assert.equal(audienceDraftOperation({operation:{phase:'succeeded',action:'segmento_criar',operationKey:key,receiptStatus:201,segmentId:key,segmentVersion:1}}).phase,'succeeded');
 for(const bad of [{}, {operation:{}}, {operation:{phase:'succeeded',action:'segmento_criar',operationKey:key}}, {operation:{phase:'rejected',action:'segmento_criar',operationKey:key,receiptStatus:409}}, {operation:{phase:'pending',action:'segmento_criar',operationKey:'wrong'}}])assert.equal(audienceDraftOperation(bad),undefined);
});

test('invite links match the exact host published by the authenticated service',()=>{
 const token='A'.repeat(43);
 for(const areaHosts of [
  {growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'},
  {growth:'dashboard-v12-crm.tazdb8.easypanel.host',organico:'dashboard-v12-organico.tazdb8.easypanel.host',influs:'dashboard-v12-influs.tazdb8.easypanel.host'}
 ])for(const [area,host]of Object.entries(areaHosts)){
  const url=`https://${host}/#invite=${token}`;
  assert.equal(inviteUrlForArea(url,area,areaHosts),url);
  for(const other of Object.keys(areaHosts).filter(x=>x!==area))assert.equal(inviteUrlForArea(url,other,areaHosts),null);
  assert.equal(inviteUrlForArea(url,area),null);
  assert.equal(inviteUrlForArea(url,area,{...areaHosts,[area]:'evil.example'}),null);
 }
 const production={growth:'crm.shrigma.com.br',organico:'organico.shrigma.com.br',influs:'influs.shrigma.com.br'};
 for(const host of ['dashboard-v12-gerencial.tazdb8.easypanel.host','dashboard-v12-other.tazdb8.easypanel.host','shrigma.com.br','evil.example'])assert.equal(inviteUrlForArea(`https://${host}/#invite=${token}`,'growth',production),null);
 for(const bad of [`http://crm.shrigma.com.br/#invite=${token}`,`https://crm.shrigma.com.br/?token=${token}#invite=${token}`,`https://crm.shrigma.com.br/gestao/#invite=${token}`,`https://crm.shrigma.com.br/#invite=${token}&area=influs`])assert.equal(inviteUrlForArea(bad,'growth',production),null);
});

test('an invite opens its activation form even when another account has a session cookie',()=>{
 const nodes=new Map(),listeners={};let sessionReads=0,historyReplacements=0,focused='';
 const element=id=>{
  if(!nodes.has(id))nodes.set(id,{
   hidden:false,value:'',textContent:'',required:false,disabled:false,
   focus(){focused=id;},replaceChildren(){},addEventListener(){},setAttribute(){},
   querySelector(){return {disabled:false};}
  });
  return nodes.get(id);
 };
 const document={body:{dataset:{accessPanel:'growth'}},getElementById:element};
 const location={hash:'#invite='+'A'.repeat(43),pathname:'/',search:'',origin:'https://dashboard-v12-crm.tazdb8.easypanel.host'};
 const window={addEventListener(type,handler){listeners[type]=handler;},fetch:async()=>{
  sessionReads++;return new Response(JSON.stringify({authenticated:true,user:{role:'manager',areas:['growth']}}));
 }};
 const context={window,document,location,history:{replaceState(){historyReplacements++;}},URL,URLSearchParams,Headers,AbortController,Response,setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'public/entry.compiled.js'),'utf8'),context);
 assert.equal(sessionReads,0);
 assert.equal(historyReplacements,1);
 assert.equal(element('invite-form').hidden,false);
 assert.equal(element('login-form').hidden,true);
 assert.equal(element('entry-shell').hidden,true);
 assert.equal(focused,'invite-password');
});

test('every transformed inline script has a matching CSP hash and guard loads first',()=>withArtifact(publicRoot=>{
 for(const file of ['growth.html','growth-diagnostico.html','organico.html','influs.html','crm/index.html','organico/index.html','creators/index.html','gestao/index.html']){
  const html=fs.readFileSync(path.join(publicRoot,file),'utf8');
  if(!file.includes('/'))assert.match(html.match(/<script\b[^>]*>/)?.[0]||'',/^<script src="\/guard\.js">$/);
  const csp=html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1];
  assert.equal(typeAndCsp(file,Buffer.from(html)).csp,csp,'header and meta CSP must match: '+file);
  for(const match of html.matchAll(/<script\s*>([\s\S]*?)<\/script>/g)){
   const hash=crypto.createHash('sha256').update(match[1]).digest('base64');assert.ok(csp.includes(`'sha256-${hash}'`),file);
  }
  assert.equal(csp.split('; ').find(part=>part.startsWith('img-src ')),"img-src 'self' data: blob: https://cdn.shopify.com/s/files/ https://email.shrigma.com.br/uploads/ https://cdninstagram.com/ https://*.cdninstagram.com/ https://fbcdn.net/ https://*.fbcdn.net/ https://*.ibyteimg.com/ https://*.tiktokcdn.com/ https://*.tiktokcdn-us.com/ https://*.byteimg.com/ https://*.ttwstatic.com/");
  for(const directive of ["connect-src 'self'","frame-src 'self' blob:","form-action 'self'","worker-src 'none'"])assert.ok(csp.split('; ').includes(directive),directive);
  assert.doesNotMatch(csp.split('; ').find(part=>part.startsWith('script-src ')),/https?:\/\//);
 }
}));

function guardHarness(session={authenticated:true,csrf:'csrf-test',user:{role:'superadmin',brand:null,brands:['fish','aristo'],brandAccess:'all'}}){
 const calls=[],opens=[],listeners={};
 const origin='https://crm.shrigma.com.br';
 const browser={fetch:async(url,options)=>{
  calls.push({url:String(url),options});
  return new Response(JSON.stringify(String(url).endsWith('/auth/session')?session:{ok:true}),{status:200,headers:{'Content-Type':'application/json'}});
 },dispatchEvent(){},open:(...args)=>{opens.push(args);return {};}};browser.parent=browser;
 const context={window:browser,location:{origin,href:origin+'/growth.html'},navigator:{sendBeacon:()=>true},document:{body:{dataset:{}},querySelectorAll:()=>[],addEventListener:(type,handler)=>{listeners[type]=handler;}},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail;}},Request,Response,Headers,URL,URLSearchParams,FormData,HTMLFormElement:class{},console};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'public/guard.compiled.js'),'utf8'),context);
 return {browser,calls,opens,listeners,origin};
}

test('only known HTTPS external paths open without opener or referrer',()=>{
 const {browser,opens,listeners}=guardHarness();
 const allowed=[
  'https://email.shrigma.com.br/admin/campaigns/media',
  'https://admin.shopify.com/',
  'https://admin.shopify.com/store/gwx20u-vw/orders/123456789',
  'https://fishermans.com.br/pages/seja-um-influenciador',
  'https://www.instagram.com/reel/C1Ab_2/',
  'https://instagram.com/creator.name',
  'https://www.tiktok.com/@creator.name/video/1234567890',
  'https://partner.tiktokshop.com/',
  'https://services.tiktokshop.com/open/authorize?service_id=7670181171502434055',
  'https://wa.me/5511999999999?text=Mensagem%20de%20teste'
 ];
 for(const href of allowed){
  const link={href,target:'_self',rel:'',referrerPolicy:''},event={target:{closest:()=>link},preventDefault:()=>assert.fail('allowed link blocked'),stopImmediatePropagation:()=>assert.fail('allowed link stopped')};
  listeners.click(event);
  assert.equal(link.target,'_blank',href);assert.equal(link.rel,'noopener noreferrer',href);assert.equal(link.referrerPolicy,'no-referrer',href);
  assert.ok(browser.open(href));
  assert.deepEqual(Array.from(opens.at(-1)),[href,'_blank','noopener,noreferrer']);
 }
});

test('lookalike hosts, unsafe schemes, paths and queries remain blocked',()=>{
 const {browser,opens,listeners}=guardHarness();
 const denied=[
  'http://email.shrigma.com.br/admin/campaigns/media',
  'https://email.shrigma.com.br.evil.test/admin/campaigns/media',
  'https://user@email.shrigma.com.br/admin/campaigns/media',
  'https://email.shrigma.com.br:8443/admin/campaigns/media',
  'https://email.shrigma.com.br/admin/campaigns/media?token=secret',
  'https://email.shrigma.com.br/uploads/example.png',
  'https://admin.shopify.com/store/other/orders/123456789',
  'https://www.tiktok.com/@creator.name/settings',
  'https://services.tiktokshop.com/open/authorize?service_id=other',
  'https://wa.me/5511999999999?text=hello&token=secret',
  'https://www.instagram.com/reel/C1Ab_2/?token=secret',
  'https://graph.facebook.com/v22.0/me',
  'mailto:user@example.com',
  'javascript:alert(1)'
 ];
 for(const href of denied){
  let prevented=0,stopped=0;
  const link={href,target:'_self',rel:''},event={target:{closest:()=>link},preventDefault:()=>prevented++,stopImmediatePropagation:()=>stopped++};
  listeners.click(event);
  assert.equal(prevented,1,href);assert.equal(stopped,1,href);
  assert.equal(browser.open(href),null,href);
 }
 assert.equal(opens.length,0);
});

test('guard rejects external and unknown routes before any network request',async()=>{
 const {browser,calls}=guardHarness();
 assert.equal((await browser.fetch('https://n8n.shrigma.com.br/webhook/example')).status,403);
 assert.equal((await browser.fetch('/api/unknown')).status,403);
 assert.equal(calls.length,0);
});

test('guard sends GET only to the same-origin BFF with cookie and no legacy bearer or key',async()=>{
 const {browser,calls}=guardHarness();
 const response=await browser.fetch('/api/influ?k=ui-0123456789abcdef0123456789abcdef&acao=listar',{headers:{Authorization:'Bearer ui-0123456789abcdef0123456789abcdef','X-TTS-Write-Key':'ui-0123456789abcdef0123456789abcdef'}});
 assert.equal(response.status,200);assert.equal(calls.length,2);assert.equal(calls[0].url,'/auth/session');
 assert.equal(new URL(calls[1].url).searchParams.has('k'),false);
 assert.equal(calls[1].options.headers.has('Authorization'),false);
 assert.equal(calls[1].options.headers.has('X-TTS-Write-Key'),false);
 assert.equal(calls[1].options.credentials,'same-origin');
});

test('guard admits only a same-origin GET for the opt-in media listing',async()=>{
 const {browser,calls,origin}=guardHarness();
 const key='ui-0123456789abcdef0123456789abcdef';
 const allowed=await browser.fetch('/api/campaigns_media?brand=fish&page=1&per_page=24&k='+key,{headers:{Authorization:'Bearer '+key}});
 assert.equal(allowed.status,200);assert.equal(calls.length,2);assert.equal(calls[0].url,'/auth/session');
 assert.equal(calls[1].url,origin+'/api/campaigns_media?brand=fish&page=1&per_page=24');
 assert.equal(calls[1].options.headers.has('Authorization'),false);
 assert.equal(calls[1].options.credentials,'same-origin');
 assert.equal((await browser.fetch('/api/campaigns_media',{method:'POST',body:'{}'})).status,405);
 assert.equal((await browser.fetch('/api/campaigns_media',{method:'HEAD'})).status,405);
 assert.equal((await browser.fetch('https://evil.invalid/api/campaigns_media?brand=fish')).status,403);
 assert.equal(calls.length,2);assert.equal(calls[0].url,'/auth/session');
});

test('guard obtains session and CSRF before POST, then strips nested uiKey and k',async()=>{
 const {browser,calls,origin}=guardHarness();
 const key='ui-0123456789abcdef0123456789abcdef';
 const response=await browser.fetch('/api/tts-action',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','X-TTS-Write-Key':key},body:JSON.stringify({acao:'listar',k:key,nested:{k:key,actor:key,value:'ok'}})});
 assert.equal(response.status,200);assert.equal(calls.length,2);
 assert.equal(calls[0].url,'/auth/session');assert.equal(calls[1].url,origin+'/api/tts-action');
 assert.equal(calls[1].options.headers.get('X-CSRF-Token'),'csrf-test');
 assert.equal(calls[1].options.headers.has('Authorization'),false);
 assert.equal(calls[1].options.headers.has('X-TTS-Write-Key'),false);
 assert.deepEqual(JSON.parse(calls[1].options.body),{acao:'listar',nested:{value:'ok'}});
});

test('campaign and audience receipt GET obtain session CSRF while ordinary reads stay read only',async()=>{
 const {browser,calls,origin}=guardHarness();
 const receipt=await browser.fetch('/api/campaigns?acao=campanha_operacao&brand=fish&idempotency_key=campaign-save-key-0000001');
 assert.equal(receipt.status,200);assert.equal(calls.length,2);
 assert.equal(calls[0].url,'/auth/session');
 assert.equal(calls[1].url,origin+'/api/campaigns?acao=campanha_operacao&brand=fish&idempotency_key=campaign-save-key-0000001');
 assert.equal(calls[1].options.headers.get('X-CSRF-Token'),'csrf-test');
 const read=await browser.fetch('/api/campaigns?acao=campanha_listar&brand=fish');
 assert.equal(read.status,200);assert.equal(calls.length,3);
 assert.equal(calls[2].options.headers.has('X-CSRF-Token'),false);
 const audience=await browser.fetch('/api/segments?acao=segmento_operacao&brand=fish&idempotency_key=123e4567-e89b-42d3-a456-426614174000');
 assert.equal(audience.status,200);assert.equal(calls.length,4);
 assert.equal(calls[3].url,origin+'/api/segments?acao=segmento_operacao&brand=fish&idempotency_key=123e4567-e89b-42d3-a456-426614174000');
 assert.equal(calls[3].options.headers.get('X-CSRF-Token'),'csrf-test');
});

test('guard with no authenticated session does not transmit POST to the BFF',async()=>{
 const {browser,calls}=guardHarness({authenticated:false});
 const response=await browser.fetch('/api/ab',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"acao":"criar"}'});
 assert.equal(response.status,401);assert.equal(calls.length,1);assert.equal(calls[0].url,'/auth/session');
});

test('compiled campaign assets publish browser factories without starting requests or exposing credentials',()=>withArtifact(publicRoot=>{
 const context={fetch(){assert.fail('Asset loading must not request data');}};
 for(const file of ['campaign-bff-client.js','campaign-edit.js'])vm.runInNewContext(fs.readFileSync(path.join(publicRoot,file),'utf8'),context);
 assert.equal(typeof context.ShrigmaCampaignBffClient.createCampaignBffClient,'function');
 assert.equal(typeof context.ShrigmaCampaignEdit.createCampaignEditor,'function');
 for(const factory of [context.ShrigmaCampaignBffClient,context.ShrigmaCampaignEdit])assert.equal(Object.isFrozen(factory),true);
 for(const absent of ['campaign-edit.compiled.js','campaign-ui-assets.json','crm-campaign-bff-client.cjs'])assert.equal(fs.existsSync(path.join(publicRoot,absent)),false);
 assert.deepEqual(fs.readFileSync(path.join(publicRoot,'campaign-edit.js')),fs.readFileSync(path.join(__dirname,'public/campaign-edit.compiled.js')));
 assert.notDeepEqual(fs.readFileSync(path.join(publicRoot,'campaign-edit.js')),fs.readFileSync(path.join(__dirname,'public/campaign-edit.js')));
}));

test('campaign build refuses stale sources, modified compiled bytes, extra manifest paths and symlinks',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-campaign-assets-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'campaign-ui-assets.json'))),files=['campaign-ui-assets.json',...manifest.assets.flatMap(a=>[a.source,a.compiled])];
 const reset=()=>{fs.rmSync(root,{recursive:true,force:true});fs.mkdirSync(root);for(const file of files){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.copyFileSync(path.join(__dirname,file),path.join(root,file));}};
 reset();assert.equal(verifyCampaignAssets(root).length,4);
 for(const file of ['public/campaign-edit.js','public/campaign-edit.compiled.js']){reset();fs.appendFileSync(path.join(root,file),'\n/* drift */');assert.throws(()=>verifyCampaignAssets(root),/needs regeneration/);}
 reset();const changed=structuredClone(manifest);changed.assets[0].compiled='../other.js';fs.writeFileSync(path.join(root,'campaign-ui-assets.json'),JSON.stringify(changed));assert.throws(()=>verifyCampaignAssets(root),/Invalid campaign UI manifest/);
 reset();fs.unlinkSync(path.join(root,'public/campaign-edit.compiled.js'));fs.symlinkSync(path.join(root,'public/campaign-edit.js'),path.join(root,'public/campaign-edit.compiled.js'));assert.throws(()=>verifyCampaignAssets(root),/Invalid campaign UI asset/);
});

test('writer iframe reads include session CSRF and legacy writes never reach the new DTO route',async()=>{
 const session={authenticated:true,csrf:'csrf-test',features:{campaignSubmitWrite:true},user:{role:'manager',brand:'fish',brands:['fish'],brandAccess:'single',areas:['growth'],permissions:{growth:{read:true,edit:true}}}};
 const {browser,calls,origin}=guardHarness(session);
 assert.equal((await browser.fetch('/api/campaigns?acao=campanha_listar&brand=fish',{headers:{Authorization:'Bearer ui-'+'a'.repeat(32)}})).status,200);
 assert.equal(calls.length,2);assert.equal(calls[1].url,origin+'/api/campaigns?acao=campanha_listar&brand=fish');assert.equal(calls[1].options.headers.get('X-CSRF-Token'),'csrf-test');assert.equal(calls[1].options.headers.has('Authorization'),false);
 for(const method of ['POST','PUT','PATCH','DELETE']){const refused=await browser.fetch('/api/campaigns',{method,body:'{}'});assert.equal(refused.status,403);assert.equal((await refused.json()).error,'CAMPAIGN_PORTAL_EDITOR_REQUIRED');}
 assert.equal(calls.length,2);
 const off=guardHarness({...session,features:{campaignSubmitWrite:false}});assert.equal((await off.browser.fetch('/api/campaigns',{method:'POST',body:'{"acao":"campanha_salvar"}'})).status,200);assert.equal(off.calls.length,2,'OFF keeps the existing BFF authorization behavior');
});
