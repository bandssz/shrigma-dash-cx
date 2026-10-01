'use strict';
// Explicit disposable loopback database only. No credential discovery or sends.
const assert=require('node:assert/strict'),fs=require('node:fs'),{Pool}=require('pg'),{parseHTML}=require('linkedom');
const F=require('./segment-campaign-binding-fixture.cjs'),S=require('../n8n/growth/segment-audience-store.cjs'),B=require('../n8n/growth/segment-campaign-binding.cjs'),Counter=require('../n8n/growth/segment-audience-listmonk.cjs'),A=require('../n8n/growth/segment-audience-contract.js');
const {createTransaction}=require('../services/crm-audience/transaction.cjs'),{createServer}=require('../services/crm-audience/server.cjs');
const SegmentUI=require('../growth-segment-ui.js'),BindingUI=require('../growth-campaign-audience-ui.js'),Campaign=require('../campaign-contract.js'),Tracking=require('../n8n/growth/campaign-tracking.js');
const uri=process.env.TEST_DATABASE_URL,u=new URL(uri||'http://invalid');
if(process.env.CRM_AUDIENCE_TEST_ISOLATED!=='1'||u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.pathname!=='/listmonk'||!u.port||u.port==='5432')throw Error('ISOLATED_DATABASE_REQUIRED');
const owner=new Pool({connectionString:uri,max:4,statement_timeout:10000}),db={query:(q,p)=>owner.query(q,p),exec:q=>owner.query(q),transaction:async work=>{const c=await owner.connect();try{await c.query('BEGIN');const r=await work(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
let pool,app,transaction;const activeUIs=[];
const source=brand=>({currency:null,timezone:null,shop_id:null,fields:Object.keys(A.FIELDS).filter(key=>key!=='signup.recorded_origin').map(key=>({key,available:key.startsWith('email.'),source_hash:key.startsWith('email.')?Counter.engagementSourceHash(brand,key):null})),products:[],origins:[]});
const until=async predicate=>{for(let n=0;n<3000;n++){if(predicate())return;await new Promise(r=>setTimeout(r,2));}throw Error('DOM_DID_NOT_SETTLE');};
(async()=>{try{
 const info=(await db.query("SELECT current_database() AS db,current_setting('server_version_num')::int AS version,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','v','m','S')) AS existing")).rows[0];assert.equal(info.db,'listmonk');assert.equal(info.version,170010);assert.equal(info.existing,0);
 const fixture=await F.setup(db);await db.exec("ALTER TABLE subscribers ADD COLUMN email text;CREATE TABLE campaign_views(subscriber_id integer,campaign_id integer,created_at timestamptz);CREATE TABLE link_clicks(subscriber_id integer,campaign_id integer,created_at timestamptz);UPDATE shrigma_panel_permission_v1 SET caps=caps||'[\"validate\"]'::jsonb WHERE principal_id='manager'");
 await db.exec(fs.readFileSync(require.resolve('../n8n/growth/segment-runtime-access.sql'),'utf8'));
 assert.equal((await db.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='crm_audience_api'")).rows[0].rolcanlogin,false);
 await db.exec('ALTER ROLE crm_audience_api LOGIN'); // Local trust-auth fixture only.
 for(const brand of ['fish','aristo']){
  await db.query("UPDATE crm_audience_v2.config SET catalog=$2::jsonb,checked_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '6 minutes' WHERE brand=$1",[brand,JSON.stringify(source(brand))]);
  const id=brand==='fish'?100:200,current=await fixture.current(id),domain=brand==='fish'?'fishermans.com.br':'oaristocrata.com',definition={...current.definition,html:`<a href="https://${domain}/products/synthetic">Produto</a> {{ UnsubscribeURL }}`,text:`https://${domain}/products/synthetic {{ UnsubscribeURL }}`};
  const catalog=(await db.query('SELECT shrigma_campaign_catalog($1) AS value',[brand])).rows[0].value,ready=Campaign.prepare(definition,{catalog,tracking:Tracking,trackingId:id});
  await db.transaction(async c=>{await c.query("SELECT set_config('shrigma.campaign_writer',$1,true)",[String(id)]);await c.query('UPDATE campaigns SET body=$2,altbody=$3 WHERE id=$1',[id,ready.definition.html,ready.definition.text]);});
 }
 const roleURI=new URL(uri);roleURI.username='crm_audience_api';pool=new Pool({connectionString:roleURI.href,max:4,statement_timeout:10000});const rawTransaction=createTransaction({pool});transaction=Object.assign(async(...args)=>{try{return await rawTransaction(...args);}catch(e){console.error('SYNTHETIC_TRANSACTION_ERROR',e.code,e.message);throw e;}},{drain:rawTransaction.drain});
 const refreshCatalog=({query,brand})=>query('SELECT crm_audience_v2.refresh_native_catalog($1::text)',[brand]);
 const segments=require('../n8n/growth/segment-audience-api.cjs').createAudienceAPI({store:S.createAudienceStore({transaction,countProvider:Counter.countAudience,refreshCatalog})}),binding=require('../n8n/growth/segment-campaign-binding-api.cjs').createCampaignBindingAPI({store:B.createSegmentCampaignBinding({transaction,countProvider:Counter.countAudience,refreshCatalog})});
 app=createServer({segments,binding,revision:'1'.repeat(40),enabled:true,bindingEnabled:true});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+app.server.address().port;
 const api={capabilities:{segments:{contract_version:'crm-audience-v2',brands:['fish','aristo'],read:true,save:true,count:true,operation:true},campaign_audience:{contract_version:B.VERSION,brands:['fish','aristo'],read:true,inspect:true,bind:true,validate:true,operation:true},endpoints:{segments:'https://runtime.invalid/segments',campaign_audience:'https://runtime.invalid/campaign-audience'}}};
 const calls=[],bridge=(url,init)=>{const target=new URL(url);assert.equal(target.origin,'https://runtime.invalid');calls.push(init.method==='POST'?JSON.parse(init.body).acao:target.searchParams.get('acao'));return fetch(origin+target.pathname+target.search,init).then(async r=>{if(r.status>=400)console.error('SYNTHETIC_HTTP_ERROR',r.status,await r.clone().text());return r;});};
 for(const brand of ['fish','aristo']){
  const {document,window}=parseHTML('<html><body><section id="segments"></section><section id="binding"></section></body></html>'),select=Object.getPrototypeOf(document.createElement('select')),dialog=Object.getPrototypeOf(document.createElement('dialog'));
  Object.defineProperty(select,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});dialog.showModal=function(){this.setAttribute('open','');};dialog.close=function(){this.removeAttribute('open');this.onclose?.();};window.HTMLElement.prototype.focus=function(){};
  const saved=new Map(),storage={getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},locks=require('./campaign-lock-fixture.cjs')(),key=()=> 'synthetic-manager-key';
  const segment=SegmentUI.create({element:document.querySelector('#segments'),document,storage,locks,key,fetch:bridge}),q=s=>document.querySelector(s);
  await segment.sync({api,brand});assert.ok(q('[data-gs-name]'),document.body.textContent);
  q('[data-gs-name]').value='HTTP '+brand;q('[data-gs-name]').dispatchEvent(new window.Event('input',{bubbles:true}));q('[data-gs-list]').value=brand==='fish'?'101':'201';q('[data-gs-list]').dispatchEvent(new window.Event('change',{bubbles:true}));
  q('[data-gs="save"]').click();await until(()=>!segment.contextStatus().blocked);assert.match(q('#segments').textContent,/Público salvo/);
  const audience=(await db.query('SELECT id FROM crm_audience_v2.audience WHERE brand=$1',[brand])).rows[0];assert.ok(audience);
  let campaign=await fixture.current(brand==='fish'?100:200),ui;
  const sync=()=>ui.sync({api,brand,campaign,clean:true,blocked:false});
  ui=BindingUI.create({element:q('#binding'),storage,locks,key,fetch:bridge,getCampaignContext:()=>campaign.version,onBound:async()=>{campaign=await fixture.current(campaign.id);sync();}});activeUIs.push(()=>ui.sync({api:{},brand,campaign,clean:true,blocked:false}));sync();
  q('[data-ca="load"]').click();await until(()=>!!q('[data-ca-select]')&&!ui.contextStatus().blocked);
  q('[data-ca-select]').value=audience.id;q('[data-ca-select]').dispatchEvent(new window.Event('change',{bubbles:true}));q('[data-ca="inspect"]').click();await until(()=>!!q('[data-ca-inspection]')&&!ui.contextStatus().blocked);
  q('[data-ca="bind"]').click();q('[data-ca-yes]').click();await until(()=>!ui.contextStatus().blocked);assert.equal(ui.contextStatus().canValidate,true,q('#binding').textContent);
  await ui.validate();assert.match(q('[data-ca-validation]').textContent,/Conteúdo conferido.*1 pessoas elegíveis/);
  await assert.rejects(fixture.legacySchedule(campaign.id),e=>e.message.includes('SEGMENT_CAMPAIGN_SELECTOR_REQUIRED'));

  await db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=$1",[brand==='fish'?17:16]);
  await ui.validate();assert.match(q('[data-ca-validation]').textContent,/0 pessoas elegíveis/);assert.equal((await fixture.current(campaign.id)).status,'draft');
  assert.equal([...saved.values()].some(v=>v.includes('synthetic-manager-key')),false);
  ui.sync({api:{},brand,campaign,clean:true,blocked:false});
 }
 // Verify actual database privileges rather than assuming that API routing is enough.
 for(const sql of ["UPDATE subscribers SET status='enabled'",'UPDATE lists SET id=id',"UPDATE campaigns SET status='scheduled'",'UPDATE crm_audience_v2.config SET enabled=false','DELETE FROM crm_audience_v2.request','SELECT email FROM subscribers','SELECT * FROM crm_dash_chave','SELECT * FROM shrigma_panel_permission_v1'])await assert.rejects(pool.query(sql),e=>['42501','42703'].includes(e.code));
 const blocker=await owner.connect();try{await blocker.query('BEGIN');await blocker.query('SELECT id FROM campaigns WHERE id=100 FOR UPDATE');const b=await fixture.bound(100),body={acao:B.ACTIONS.validate,brand:'fish',campaign_id:100,expected_campaign_version:b.campaign_version,expected_binding_version:b.binding_version,expected_binding_hash:b.binding_hash};const started=Date.now(),r=await fetch(origin+'/campaign-audience',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic-manager-key'},body:JSON.stringify(body)});assert.equal(r.status,503);assert.ok(Date.now()-started<4000);assert.equal((await r.json()).error,'SEGMENT_BINDING_UNCONFIRMED');}finally{await blocker.query('ROLLBACK');blocker.release();}
 assert.equal(calls.includes('campanha_validar'),false);assert.equal(calls.includes('campanha_agendar'),false);
 console.log(JSON.stringify({postgres:'17.10',http:true,dom:true,role:'crm_audience_api',brands:['fish','aristo'],native_writes_denied:true,lock_timeout:true,sends:0}));
}finally{for(const clear of activeUIs)clear();if(app)await app.stop();if(transaction)await transaction.drain();if(pool)await pool.end();await owner.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
