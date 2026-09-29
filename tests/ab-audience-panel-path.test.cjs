'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Readable}=require('node:stream'),{EventEmitter}=require('node:events');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite'),{parseHTML}=require('linkedom');
const F=require('./ab-audience-regular-fixture.cjs'),API=require('../n8n/growth/ab-audience-panel-api.cjs');
const Client=require('../growth-ab-experiment-client.js'),UI=require('../growth-ab-experiment-ui.js');
const {createServer,ORIGIN}=require('../services/crm-audience/server.cjs');
const sql=fs.readFileSync(path.resolve(__dirname,'../n8n/growth/ab-audience-regular.sql'),'utf8');
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function inject(app,url,init){
 const u=new URL(url),headers={...init.headers,Origin:ORIGIN},raw=Object.entries(headers).flat();
 const req=Readable.from(init.body===undefined?[]:[Buffer.from(init.body)]);
 Object.assign(req,{method:init.method,url:u.pathname+u.search,headers:Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v])),rawHeaders:raw});
 return new Promise(resolve=>{const res=new EventEmitter();Object.assign(res,{destroyed:false,writableEnded:false,
  writeHead(status,headers){this.status=status;this.headers=headers;},end(value){this.writableEnded=true;resolve({status:this.status,body:value?JSON.parse(value):null});}});app.server.emit('request',req,res);});
}
async function setup(t,brand){
 const db=new PGlite();t.after(()=>db.close());const x=await F.setup(db,{prepareCases:false,beforeWorkerReady:({db})=>db.exec(sql)});
 await db.query("UPDATE shrigma_panel_permission_v1 SET caps=caps||'[\"submit\"]'::jsonb WHERE principal_id='manager'");
 const experiments=API.createABPanelAPI({transaction:x.transaction,enabled:true}),unrelated={handle(){assert.fail('Unrelated route');}};
 const app=createServer({segments:unrelated,binding:unrelated,experiments,enabled:true,revision:'a'.repeat(40)});
 const {document,window}=parseHTML('<html><body><div id="root"></div></body></html>'),values=new Map(),calls=[];let n=9000,key='synthetic-manager-key',busy=false;
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 const f={db,x,app,document,window,values,calls,brand,failReceipt:false,setKey:v=>key=v};
 f.storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const locks={request:async(k,o,fn)=>{if(busy)return fn(null);busy=true;try{return await fn({});}finally{busy=false;}}};
 f.client=()=>Client.create({brand,endpoint:'https://synthetic.invalid/ab-experiments',getKey:()=>key,audienceMode:true,locks,storage:f.storage,uuid:()=>uuid(++n),fetch:async(url,init)=>{
  assert.equal(init.headers.Authorization,'Bearer '+key);assert.ok(!init.body||!Object.hasOwn(JSON.parse(init.body),'k'));
  const input=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(new URL(url).searchParams);calls.push({method:init.method,input});
  const r=await inject(app,url,init);if(f.failReceipt&&input.method==='operation'&&r.body?.operation?.state==='completed')throw Error('Lost receipt');
  return {status:r.status,json:async()=>r.body};
 }});
 f.mount=()=>{f.ui?.destroy();f.clientInstance=f.client();f.ui=UI.mount({element:document.querySelector('#root'),brand,client:f.clientInstance,storage:f.storage,getKeyIdentity:()=>key,uuid:()=>x.cases[brand].protocol.test_id,
  reviewer:{pending:()=>false,consult:async()=>{},reviewSaved:async()=>{},review:async()=>assert.fail('Saved audience review must use integrated API')}});
  const dialog=document.querySelector('dialog');dialog.showModal=()=>dialog.setAttribute('open','');dialog.close=()=>dialog.removeAttribute('open');return f.ui;};
 t.after(()=>f.ui?.destroy());f.q=s=>document.querySelector(s);f.posts=()=>calls.filter(c=>c.method==='POST').length;
 return f;
}
async function prepare(f){
 f.mount();await f.ui.ready;assert.equal(f.ui.state.caps.audience_mode,'saved-audience-v1');
 const p=f.x.cases[f.brand].protocol;f.q('[data-abx-new]').onclick();
 for(const [name,v]of Object.entries({name:p.name,hypothesis:p.hypothesis,a:p.arms[0].campaign_id,b:p.arms[1].campaign_id,window_hours:24,minimum_per_arm:1,minimum_effect_pp:.1}))f.q(`[name="${name}"]`).value=v;
 f.q('[data-abx-form]').oninput();const pending=f.q('[data-abx-form]').onsubmit({preventDefault(){}});assert.ok(f.q('dialog').hasAttribute('open'));
 f.q('[data-abx-yes]').onclick();await pending;assert.equal(f.ui.state.selected?.state,'prepared',f.ui.state.error);return p;
}
for(const brand of ['fish','aristo'])test(brand+': DOM → journal → HTTP → saved audience → reviewed pair → one atomic schedule',async t=>{
 const f=await setup(t,brand);await prepare(f);assert.equal(f.posts(),1);
 await f.q('[data-abx-review]').onclick();assert.equal(f.ui.state.review?.mode,'saved-audience',f.ui.state.error);assert.equal(f.posts(),2);
 assert.ok(Date.parse(f.ui.state.review.expires_at)-Date.parse(f.ui.state.review.checked_at)<=60000);
 let pending=f.q('[data-abx-schedule]').onclick();assert.match(f.q('[data-abx-confirm-text]').textContent,/mensagens poderão ser enviadas/);
 f.q('[data-abx-no]').onclick();await pending;assert.equal(f.posts(),2);
 pending=f.q('[data-abx-schedule]').onclick();f.q('[data-abx-yes]').onclick();f.q('[data-abx-yes]').onclick();await pending;
 assert.equal(f.ui.state.selected?.state,'scheduled',f.ui.state.error);assert.equal(f.posts(),3);assert.equal(f.clientInstance.inspect().pending,null);
 const state=(await f.db.query("SELECT (SELECT count(*) FROM crm_audience_v2.ab_regular_pair)::int pairs,(SELECT count(*) FROM crm_audience_v2.regular_delivery_campaign)::int controls,(SELECT count(*) FROM shrigma_email_dispatch)::int dispatches")).rows[0];
 assert.deepEqual(state,{pairs:1,controls:2,dispatches:0});
 assert.doesNotMatch(f.values.get(Client.SLOT),/synthetic-manager-key|person\d+@|<html|Subscriber/);
});
test('lost schedule receipt survives reload and lookup recovers it with no second POST',async t=>{
 const f=await setup(t,'fish');await prepare(f);await f.q('[data-abx-review]').onclick();f.failReceipt=true;
 const pending=f.q('[data-abx-schedule]').onclick();f.q('[data-abx-yes]').onclick();await pending;
 assert.equal(f.clientInstance.inspect().pending?.phase,'unknown');const count=f.posts();f.mount();await f.ui.ready;assert.equal(f.ui.contextStatus().pending,true);
 f.failReceipt=false;await f.q('[data-abx-recover]').onclick();assert.equal(f.posts(),count);assert.equal(f.ui.state.selected.state,'scheduled');assert.equal(f.clientInstance.inspect().pending,null);
});
test('prepared pair cancels together; another brand cannot cancel the retained experiment',async t=>{
 const f=await setup(t,'fish'),p=await prepare(f),client=f.clientInstance;
 const raw={method:'mutate',brand:'aristo',operation_id:uuid(9900),request_payload:{contract:p.contract,action:'cancel',test_id:p.test_id,brand:'aristo',expected_version:1,confirm:'cancel_both'}};
 const denied=await inject(f.app,'https://synthetic.invalid/ab-experiments',{method:'POST',headers:{Authorization:'Bearer synthetic-manager-key','Content-Type':'application/json'},body:JSON.stringify(raw)});assert.equal(denied.status,409);
 const pending=f.q('[data-abx-cancel]').onclick();f.q('[data-abx-yes]').onclick();await pending;assert.equal(f.ui.state.selected.state,'cancelled',f.ui.state.error);
 assert.equal((await f.db.query("SELECT count(*)::int n FROM campaigns WHERE id IN(100,101) AND status='cancelled'")).rows[0].n,2);
 assert.equal(client.inspect().pending,null);
});

test('scheduled pair cancels before starting and OFF keeps the original operation lookup available',async t=>{
 const f=await setup(t,'aristo');await prepare(f);await f.q('[data-abx-review]').onclick();let pending=f.q('[data-abx-schedule]').onclick();f.q('[data-abx-yes]').onclick();await pending;
 pending=f.q('[data-abx-cancel]').onclick();f.q('[data-abx-yes]').onclick();await pending;assert.equal(f.ui.state.selected.state,'cancelled',f.ui.state.error);
 const rows=(await f.db.query("SELECT c.status,ctl.suspended FROM campaigns c JOIN crm_audience_v2.regular_delivery_campaign ctl ON ctl.campaign_id=c.id ORDER BY c.id")).rows;
 assert.equal(rows.length,2);assert.ok(rows.every(x=>x.status==='cancelled'&&x.suspended));
 const disabled=API.createABPanelAPI({transaction:f.x.transaction,enabled:false}),prior=JSON.parse(f.values.get(Client.SLOT)).operations.at(-1);
 const read=await disabled.handle({method:'GET',request:{headers:{Authorization:'Bearer synthetic-manager-key'},query:{method:'operation',brand:'aristo',operation_id:prior.id,action:'cancel'}}});
 assert.equal(read.status,200);assert.equal(read.body.operation.state,'completed');
});


test('failure after paired scheduling rolls back both campaigns and all nested receipts; recovery does not POST',async t=>{
 const f=await setup(t,'fish');await prepare(f);await f.q('[data-abx-review]').onclick();
 f.x.control.afterQuery=async(q,values)=>{if(q===API.SQL.save&&values[3]==='schedule')throw Error('Synthetic failure before outer COMMIT');};
 const pending=f.q('[data-abx-schedule]').onclick();f.q('[data-abx-yes]').onclick();await pending;
 assert.equal(f.clientInstance.inspect().pending?.phase,'unknown');const count=f.posts();
 const state=(await f.db.query("SELECT (SELECT count(*) FROM campaigns WHERE id IN(100,101) AND status='draft')::int drafts,(SELECT count(*) FROM crm_audience_v2.ab_regular_pair)::int pairs,(SELECT count(*) FROM crm_audience_v2.regular_delivery_campaign)::int controls,(SELECT count(*) FROM crm_audience_v2.ab_regular_request)::int nested,(SELECT count(*) FROM crm_audience_v2.ab_panel_request WHERE action='schedule')::int outer_receipts")).rows[0];
 assert.deepEqual(state,{drafts:2,pairs:0,controls:0,nested:0,outer_receipts:0});
 f.x.control.afterQuery=null;await f.q('[data-abx-recover]').onclick();assert.equal(f.posts(),count);assert.equal(f.clientInstance.inspect().pending?.phase,'unknown');
});

test('deterministic rejection has an exact receipt and late authorization loss rolls back the lifecycle',async t=>{
 const f=await setup(t,'aristo'),p=await prepare(f),headers={Authorization:'Bearer synthetic-manager-key','Content-Type':'application/json'};
 const payload={method:'mutate',brand:'aristo',operation_id:uuid(9950),request_payload:{contract:p.contract,action:'review_saved',test_id:p.test_id,brand:'aristo',expected_version:99}};
 const send=body=>inject(f.app,'https://synthetic.invalid/ab-experiments',{method:'POST',headers,body:JSON.stringify(body)});
 const denied=await send(payload);assert.equal(denied.status,409);assert.deepEqual(await send(payload),denied);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM crm_audience_v2.ab_panel_request WHERE operation_id=$1',[payload.operation_id])).rows[0].n,1);
 f.x.control.afterQuery=async(q,values,tx)=>{if(q===API.SQL.lifecycle)await tx.query("UPDATE shrigma_panel_permission_v1 SET caps=caps-'submit' WHERE principal_id='manager'");};
 const operation_id=uuid(9951),cancel=await send({method:'mutate',brand:'aristo',operation_id,request_payload:{contract:p.contract,action:'cancel',test_id:p.test_id,brand:'aristo',expected_version:1,confirm:'cancel_both'}});
 assert.equal(cancel.status,403);assert.equal((await f.db.query("SELECT count(*)::int n FROM campaigns WHERE id IN(200,201) AND status='draft'")).rows[0].n,2);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM crm_audience_v2.ab_panel_request WHERE operation_id=$1',[operation_id])).rows[0].n,0);
});
