'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const {build,CONTENT,ENDPOINTS}=require('./build.cjs');
const {typeAndCsp}=require('./server.cjs');
const {inviteUrlForArea,readOnlyStyles}=require('./public/entry.js');

function withArtifact(fn){const dest=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-operational-'));try{build(dest);return fn(path.join(dest,'public'));}finally{fs.rmSync(dest,{recursive:true,force:true});}}
function sha(source){return crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');}

test('artifact contains only three team panels and management, without CX or backend files',()=>withArtifact(publicRoot=>{
 for(const entry of ['crm','organico','creators','gestao'])assert.equal(fs.existsSync(path.join(publicRoot,entry,'index.html')),true);
 for(const absent of ['cx/index.html','index.html','assets/panels/index.js','assets/panels/index.css','assets/panels/entry.js','services','n8n','.git'])assert.equal(fs.existsSync(path.join(publicRoot,absent)),false,absent);
 const manifest=JSON.parse(fs.readFileSync(path.join(path.dirname(publicRoot),'artifact-manifest.json')));
 assert.deepEqual(manifest.areas,['growth','organico','influs','todos']);
 assert.equal(manifest.publicFiles.length,27);
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
  assert.doesNotMatch(html,/type="file"|entry-key|preview-api|\/cx\//);
  assert.match(html,/connect-src 'self'/);assert.match(html,/frame-src 'self'/);
 }
 const js=fs.readFileSync(path.join(publicRoot,'entry.js'),'utf8');
 assert.match(js,/fragment\.get\('invite'\)/);assert.match(js,/fragment\.get\('bootstrap'\)/);
 assert.match(js,/history\.replaceState/);assert.match(js,/session\.uiKey/);
 assert.doesNotMatch(js,/localStorage\.setItem|sessionStorage\.setItem|fetch\(['"]https:\/\//);
}));

test('operational iframe suppresses legacy access files and unavailable write controls without changing source panels',()=>{
 const expected={
  growth:['#growth-acesso','#ab-acesso-legado','#crm-media-library-load','#crm-media .crm-media-integrated','#campaign-composer [data-ce-save]','#campaign-composer .ce-import','#control-drafts #drafts-importar','#control-drafts #draft-editor','#crm-segments-panel [data-gs="save"]'],
  organico:['#organico-acesso','#organico-acesso-bar','#ol-form','.ol-arquivar'],
  influs:['#influ-access','#i-form','.cr-edit','[data-pilot-save]','[data-cob]:not([data-cob="recarregar"])','#tts-acesso']
 };
 for(const [area,selectors]of Object.entries(expected)){
  const css=readOnlyStyles(area);
  for(const selector of selectors)assert.ok(css.includes('body.panel-embedded '+selector),area+' '+selector);
  assert.match(css,/display:none!important/);
 }
 assert.doesNotMatch(readOnlyStyles('growth'),/body\.panel-embedded #crm-media,/);
 assert.doesNotMatch(readOnlyStyles('growth'),/body\.panel-embedded #crm-media-fields/);
 assert.doesNotMatch(readOnlyStyles('growth'),/body\.panel-embedded #crm-segments-panel,/);
 assert.doesNotMatch(readOnlyStyles('growth'),/body\.panel-embedded #control-drafts,/);
 assert.ok(readOnlyStyles('growth',{embeddedOnly:false}).includes('body #crm-media-library-load'));
 assert.equal(readOnlyStyles('cx'),'');
 withArtifact(publicRoot=>{
  assert.match(fs.readFileSync(path.join(publicRoot,'entry.js'),'utf8'),/installReadOnlyPresentation\(selected\)/);
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

test('invite links match the exact production or test host for their area',()=>{
 const token='A'.repeat(43);
 const hosts={
  growth:['crm.shrigma.com.br','dashboard-op-crm.tazdb8.easypanel.host','dashboard-v4-crm.tazdb8.easypanel.host','dashboard-v5-crm.tazdb8.easypanel.host','dashboard-v6-crm.tazdb8.easypanel.host','dashboard-v7-crm.tazdb8.easypanel.host','dashboard-v8-crm.tazdb8.easypanel.host'],
  organico:['organico.shrigma.com.br','dashboard-op-organico.tazdb8.easypanel.host','dashboard-v4-organico.tazdb8.easypanel.host','dashboard-v5-organico.tazdb8.easypanel.host','dashboard-v6-organico.tazdb8.easypanel.host','dashboard-v7-organico.tazdb8.easypanel.host','dashboard-v8-organico.tazdb8.easypanel.host'],
  influs:['influs.shrigma.com.br','dashboard-op-influs.tazdb8.easypanel.host','dashboard-v4-influs.tazdb8.easypanel.host','dashboard-v5-influs.tazdb8.easypanel.host','dashboard-v6-influs.tazdb8.easypanel.host','dashboard-v7-influs.tazdb8.easypanel.host','dashboard-v8-influs.tazdb8.easypanel.host']
 };
 for(const [area,allowed]of Object.entries(hosts))for(const host of allowed){
  const url=`https://${host}/#invite=${token}`;
  assert.equal(inviteUrlForArea(url,area),url);
  for(const other of Object.keys(hosts).filter(x=>x!==area))assert.equal(inviteUrlForArea(url,other),null);
 }
 for(const host of ['dashboard-op-gerencial.tazdb8.easypanel.host','dashboard-v4-gerencial.tazdb8.easypanel.host','dashboard-v5-gerencial.tazdb8.easypanel.host','dashboard-v6-gerencial.tazdb8.easypanel.host','dashboard-v7-gerencial.tazdb8.easypanel.host','dashboard-op-other.tazdb8.easypanel.host','shrigma.com.br','evil.example'])assert.equal(inviteUrlForArea(`https://${host}/#invite=${token}`,'growth'),null);
 for(const bad of [`http://crm.shrigma.com.br/#invite=${token}`,`https://crm.shrigma.com.br/?token=${token}#invite=${token}`,`https://crm.shrigma.com.br/gestao/#invite=${token}`,`https://crm.shrigma.com.br/#invite=${token}&area=influs`])assert.equal(inviteUrlForArea(bad,'growth'),null);
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

function guardHarness(session={authenticated:true,csrf:'csrf-test'}){
 const calls=[],opens=[],listeners={};
 const origin='https://crm.shrigma.com.br';
 const browser={fetch:async(url,options)=>{
  calls.push({url:String(url),options});
  return new Response(JSON.stringify(String(url).endsWith('/auth/session')?session:{ok:true}),{status:200,headers:{'Content-Type':'application/json'}});
 },open:(...args)=>{opens.push(args);return {};}};browser.parent=browser;
 const context={window:browser,location:{origin,href:origin+'/growth.html'},navigator:{sendBeacon:()=>true},document:{addEventListener:(type,handler)=>{listeners[type]=handler;}},Request,Response,Headers,URL,URLSearchParams,FormData,HTMLFormElement:class{},console};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'public/guard.js'),'utf8'),context);
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
 assert.equal(response.status,200);assert.equal(calls.length,1);
 assert.equal(new URL(calls[0].url).searchParams.has('k'),false);
 assert.equal(calls[0].options.headers.has('Authorization'),false);
 assert.equal(calls[0].options.headers.has('X-TTS-Write-Key'),false);
 assert.equal(calls[0].options.credentials,'same-origin');
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

test('guard with no authenticated session does not transmit POST to the BFF',async()=>{
 const {browser,calls}=guardHarness({authenticated:false});
 const response=await browser.fetch('/api/ab',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"acao":"criar"}'});
 assert.equal(response.status,401);assert.equal(calls.length,1);assert.equal(calls[0].url,'/auth/session');
});
