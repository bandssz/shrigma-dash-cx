'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
const root=path.resolve(__dirname,'..'),endpoint='https://n8n.shrigma.com.br/webhook/synthetic-growth-templates';
const flow=(brand,key='carrinho',version=1)=>({key:brand+':'+key,brand,name:key,trigger:'Evento de teste',version,published_version:version,enabled:true,runtime_ready:true,available_steps:[],draft:{name:key,steps:[]}});
const journeys=['carrinho','pedido-recebido','pix','rastreio','nps','popup','auto-resposta'].flatMap(key=>['aristo','fish'].map(brand=>flow(brand,key)));
function boot(fetcher){
 const {document,window}=parseHTML('<section id="control-fluxos"></section>'),calls=[],timeouts=[];
 window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,width:1000,height:700});
 const context=vm.createContext({document,window,URLSearchParams,confirm:()=>false,
  AbortSignal:{timeout:ms=>{timeouts.push(ms);return new AbortController().signal;}},
  GTA:{caps:()=>({endpoint}),chaveLeitura:()=> 'synthetic-session-reader'},
  fetch:async(url,init)=>{calls.push({url,init});return fetcher(url,init,calls.length);}});
 for(const name of ['growth-canvas.js','growth-builder.js'])vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),context,{filename:name});
 const run=code=>vm.runInContext(code,context);run('GB.ctx={marca:"aristo"}');
 return {document,calls,timeouts,run,q:s=>document.querySelector(s)};
}
const response=body=>({ok:true,status:200,json:async()=>body});
async function settled(x){for(let i=0;i<30;i++){await new Promise(setImmediate);if(!x.run('GB.state.busy'))return;}assert.fail('Read did not settle');}

test('initial read failure keeps retry visible and recovers the journeys of both brands',async()=>{
 let release;
 const x=boot((url,init,n)=>n===1?new Promise((_,reject)=>release=reject):response({flows:journeys}));
 const pending=x.run('GB.load()');
 assert.equal(x.q('#builder-reload').disabled,true);assert.match(x.q('[role=status]').textContent,/Carregando/);
 release(new TypeError('synthetic blocked network request'));await pending;
 assert.match(x.q('[role=alert]').textContent,/Não foi possível confirmar a leitura/);
 assert.equal(x.q('#builder-reload').disabled,false);assert.match(x.q('#builder-reload').textContent,/Tentar novamente/);
 assert.equal(x.q('#builder-flow-picker'),null);assert.doesNotMatch(x.q('[role=status]').textContent,/Selecione/);
 x.run('GB.render({marca:"fish"});GB.render({marca:"aristo"})');assert.equal(x.calls.length,1);
 x.q('#builder-reload').click();await settled(x);
 assert.equal(x.calls.length,2);assert.equal(x.q('[role=alert]'),null);
 assert.equal(x.q('#builder-flow-picker').options.length,7);
 assert.ok([...x.q('#builder-flow-picker').options].every(o=>o.value.startsWith('aristo:')));
 assert.equal(x.run('GBC.flowKey'),'aristo:carrinho');assert.ok(x.q('#flow-viewport'));
 x.run('GB.render({marca:"fish"})');
 assert.equal(x.q('#builder-flow-picker').options.length,7);
 assert.ok([...x.q('#builder-flow-picker').options].every(o=>o.value.startsWith('fish:')));
 assert.equal(x.run('GBC.flowKey'),'fish:carrinho');assert.equal(x.calls.length,2);
 assert.deepEqual(x.timeouts,[20000,20000]);
 for(const c of x.calls){assert.equal(new URL(c.url).searchParams.get('acao'),'fluxos_listar');assert.equal(c.init.method,undefined);assert.equal(c.init.headers.Authorization,'Bearer synthetic-session-reader');assert.equal(c.init.credentials,'omit');assert.equal(c.init.redirect,'error');assert.equal(new URL(c.url).searchParams.has('k'),false);}
});

test('invalid successful response is a read failure, while an empty confirmed list remains retryable',async()=>{
 const x=boot((url,init,n)=>response(n===1?{checked_at:'synthetic'}:{flows:[]}));
 await x.run('GB.load()');assert.match(x.q('[role=alert]').textContent,/Não foi possível carregar/);
 assert.equal(x.q('#builder-reload').disabled,false);
 x.q('#builder-reload').click();await settled(x);
 assert.equal(x.q('[role=alert]'),null);assert.match(x.q('[role=status]').textContent,/Nenhuma jornada disponível/);
 assert.equal(x.q('#builder-reload').disabled,false);assert.equal(x.calls.length,2);
});

test('failed refresh and retry preserve dirty draft, layout, base version and pending operation',async()=>{
 let mode='initial';
 const x=boot(()=>{if(mode==='failed')throw new TypeError('synthetic offline');return response({flows:[flow('aristo','carrinho',mode==='initial'?1:2),flow('fish')]});});
 await x.run('GB.load()');
 x.run('GB.state.draft.name="Meu rascunho";GB.state.draft.layout={version:1,nodes:{trigger:{x:270,y:120}}};GB.state.dirty=true;GB.state.pending={id:"synthetic-existing-operation",signature:"preserve"}');
 const before=x.run('JSON.stringify({draft:GB.state.draft,base:GB.state.baseVersion,pending:GB.state.pending})');
 mode='failed';await x.run('GB.load()');
 assert.ok(x.q('#builder-flow-picker'));assert.ok(x.q('#builder-reload'));assert.ok(x.q('[role=alert]'));
 assert.equal(x.run('JSON.stringify({draft:GB.state.draft,base:GB.state.baseVersion,pending:GB.state.pending})'),before);
 mode='new-version';x.q('#builder-reload').click();await settled(x);
 assert.equal(x.run('GB.state.flows[0].version'),2);assert.equal(x.run('GB.state.dirty'),true);
 assert.equal(x.run('JSON.stringify({draft:GB.state.draft,base:GB.state.baseVersion,pending:GB.state.pending})'),before);
 assert.equal(x.q('#builder-name').value,'Meu rascunho');assert.equal(x.q('#builder-publish').disabled,true);assert.equal(x.q('#builder-toggle').disabled,true);
 assert.equal(x.calls.length,3);assert.ok(x.calls.every(c=>!c.init.method));
});

function connectSources(html){const csp=html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];return csp.split(';').find(s=>s.trim().startsWith('connect-src ')).trim().split(/\s+/).slice(1);}
test('published Growth permits its declared API origin without broadening other panels or login',()=>{
 const sources=connectSources(fs.readFileSync(path.join(root,'growth.html'),'utf8'));
 assert.deepEqual(sources,['https://n8n-n8n.tazdb8.easypanel.host',new URL(endpoint).origin]);
 for(const file of ['index.html','organico.html','influs.html','cx/index.html','crm/index.html','organico/index.html','creators/index.html','gestao/index.html'])assert.deepEqual(connectSources(fs.readFileSync(path.join(root,file),'utf8')),['https://n8n-n8n.tazdb8.easypanel.host'],file);
});

test('targeted Growth build writes only Growth artifacts and emits the matching policy',()=>{
 const files={'/fixture/growth.html':'<head><!-- PANEL_SECURITY --></head><body><!-- PANEL_CSS --><!-- PANEL_JS --></body>','/fixture/growth.js':'const synthetic=true;','/fixture/growth.css':'body{}'},writes=new Map();
 const fakeFS={mkdirSync(){},readFileSync:p=>{assert.ok(Object.hasOwn(files,p),'Unexpected read: '+p);return files[p];},writeFileSync:(p,s)=>writes.set(p,s)};
 const context={__dirname:'/fixture/tools/panel-build',process:{argv:['node','build.cjs','--panel=growth']},console:{log(){}},Buffer,
  require:name=>name==='node:fs'?fakeFS:name==='./manifest.json'?{growth:{scripts:['growth.js'],css:['growth.css']},index:{scripts:['unrelated.js'],css:[]}}:name.includes('esbuild')?{transformSync:s=>({code:s})}:require(name)};
 vm.runInNewContext(fs.readFileSync(path.join(root,'tools/panel-build/build.cjs'),'utf8'),context);
 assert.deepEqual([...writes.keys()].sort(),['/fixture/assets/panels/growth.css','/fixture/assets/panels/growth.js','/fixture/growth.html']);
 assert.deepEqual(connectSources(writes.get('/fixture/growth.html')),['https://n8n-n8n.tazdb8.easypanel.host',new URL(endpoint).origin]);
});
