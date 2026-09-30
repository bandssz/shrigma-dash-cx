'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const {build,CONTENT,ENDPOINTS}=require('./build.cjs');
const {inviteUrlForArea}=require('./public/entry.js');

function withArtifact(fn){const dest=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-operational-'));try{build(dest);return fn(path.join(dest,'public'));}finally{fs.rmSync(dest,{recursive:true,force:true});}}
function sha(source){return crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');}

test('artifact contains only three team panels and management, without CX or backend files',()=>withArtifact(publicRoot=>{
 for(const entry of ['crm','organico','creators','gestao'])assert.equal(fs.existsSync(path.join(publicRoot,entry,'index.html')),true);
 for(const absent of ['cx/index.html','index.html','assets/panels/index.js','assets/panels/index.css','assets/panels/entry.js','services','n8n','.git'])assert.equal(fs.existsSync(path.join(publicRoot,absent)),false,absent);
 const manifest=JSON.parse(fs.readFileSync(path.join(path.dirname(publicRoot),'artifact-manifest.json')));
 assert.deepEqual(manifest.areas,['growth','organico','influs','todos']);
 assert.equal(manifest.publicFiles.length,22);
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

test('invite links match the exact production or test host for their area',()=>{
 const token='A'.repeat(43);
 const hosts={growth:['crm.shrigma.com.br','dashboard-op-crm.tazdb8.easypanel.host'],organico:['organico.shrigma.com.br','dashboard-op-organico.tazdb8.easypanel.host'],influs:['influs.shrigma.com.br','dashboard-op-influs.tazdb8.easypanel.host']};
 for(const [area,allowed]of Object.entries(hosts))for(const host of allowed){
  const url=`https://${host}/#invite=${token}`;
  assert.equal(inviteUrlForArea(url,area),url);
  for(const other of Object.keys(hosts).filter(x=>x!==area))assert.equal(inviteUrlForArea(url,other),null);
 }
 for(const host of ['dashboard-op-gerencial.tazdb8.easypanel.host','dashboard-op-other.tazdb8.easypanel.host','shrigma.com.br','evil.example'])assert.equal(inviteUrlForArea(`https://${host}/#invite=${token}`,'growth'),null);
 for(const bad of [`http://crm.shrigma.com.br/#invite=${token}`,`https://crm.shrigma.com.br/?token=${token}#invite=${token}`,`https://crm.shrigma.com.br/gestao/#invite=${token}`,`https://crm.shrigma.com.br/#invite=${token}&area=influs`])assert.equal(inviteUrlForArea(bad,'growth'),null);
});

test('every transformed inline script has a matching CSP hash and guard loads first',()=>withArtifact(publicRoot=>{
 for(const file of ['growth.html','organico.html','influs.html']){
  const html=fs.readFileSync(path.join(publicRoot,file),'utf8');
  assert.ok(html.indexOf('<script src="/guard.js"')<html.indexOf('<script>'));
  const csp=html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1];
  for(const match of html.matchAll(/<script\s*>([\s\S]*?)<\/script>/g)){
   const hash=crypto.createHash('sha256').update(match[1]).digest('base64');assert.ok(csp.includes(`'sha256-${hash}'`),file);
  }
  assert.match(csp,/connect-src 'self'/);assert.doesNotMatch(csp,/https:\/\//);
 }
}));

function guardHarness(session={authenticated:true,csrf:'csrf-test'}){
 const calls=[];
 const origin='https://crm.shrigma.com.br';
 const browser={fetch:async(url,options)=>{
  calls.push({url:String(url),options});
  return new Response(JSON.stringify(String(url).endsWith('/auth/session')?session:{ok:true}),{status:200,headers:{'Content-Type':'application/json'}});
 },open:()=>({})};browser.parent=browser;
 const context={window:browser,location:{origin,href:origin+'/growth.html'},navigator:{sendBeacon:()=>true},document:{addEventListener:()=>{}},Request,Response,Headers,URL,URLSearchParams,FormData,HTMLFormElement:class{},console};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'public/guard.js'),'utf8'),context);
 return {browser,calls,origin};
}

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
