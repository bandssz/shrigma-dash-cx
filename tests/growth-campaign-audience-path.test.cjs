'use strict';
// Native editor + real binding/segment clients -> HTTP boundaries -> real SQL,
// all in an isolated local DOM/PGlite fixture. No browser or remote transport.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto'),{parseHTML}=require('linkedom');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const F=require('./segment-campaign-binding-fixture.cjs'),API=require('../n8n/growth/segment-campaign-binding-api.cjs');
const Contract=require('../campaign-contract.js');global.CampaignContract=Contract;
const Editor=require('../growth-campaign-editor.js'),root=path.resolve(__dirname,'..');
const endpoints={campaigns:'https://campaign.test/api',segments:'https://audience.test/api',campaign_audience:'https://binding.test/api'};
const caps=()=>({capabilities:{endpoints,
 campaigns:{contract_version:'crm-campaign-v1',brands:['fish','aristo'],read:true,save:true,validate:true,schedule:true,cancel:true,operation:true,audience_review:'listmonk-6.1-regular-v1'},
 segments:{contract_version:'crm-audience-v2',brands:['fish','aristo'],read:true,save:true,count:true,operation:true},
 campaign_audience:{contract_version:'crm-audience-campaign-binding-v1',brands:['fish','aristo'],read:true,inspect:true,bind:true,release:true,operation:true}}});
async function setup(t,brand='fish',{enabled=true,noCapabilities=false,noCampaignCapability=false,lose=false,regular=false,store=new Map(),fixture=null}={}){
 const db=fixture?.db||new PGlite();if(!fixture)t.after(()=>db.close());const f=fixture||(regular?await require('./segment-regular-admission-fixture.cjs').setup(db):await F.setup(db,{countProvider:require('../n8n/growth/segment-audience-listmonk.cjs').countAudience})),bindingAPI=API.createCampaignBindingAPI({store:f.bindingService||f.service}),regularAPI=regular?require('../n8n/growth/segment-regular-admission-api.cjs').createRegularAdmissionAPI({store:f.service}):null;
 if(regular&&!fixture)await f.approve();
 // Prepare valid synthetic content before any binding; keep all triggers installed.
 if(!fixture&&!regular)for(const id of [100,200])await db.transaction(async tx=>{await tx.query("SELECT set_config('shrigma.campaign_writer',$1,true)",[String(id)]);await tx.query("UPDATE campaigns SET body=body||' {{ UnsubscribeURL }}',altbody=altbody||' {{ UnsubscribeURL }}' WHERE id=$1",[id]);});
 const campaignId=brand==='fish'?100:200,existing=(await db.query('SELECT id,version FROM crm_audience_v2.audience WHERE brand=$1',[brand])).rows[0];
 const audience=existing||await f.createAudience(brand,'ui-audience-'+brand,{op:'in_list',list_id:brand==='fish'?101:201}),current=await f.current(campaignId);
 const journal='shrigma_campaign_operation_v1:'+brand,local='shrigma_growth_editor_v1:campaign:'+brand;
 if(!store.has(journal))store.set(journal,JSON.stringify({version:1,brand,endpoint:endpoints.campaigns,campaign:current,validation:null,operation:null}));
 if(!store.has(local))store.set(local,JSON.stringify({version:1,area:'campaign',brand,value:{...Editor.fromDefinition(current.definition),_campaign:{id:current.id,version:current.version}}}));
 const {document,window}=parseHTML('<section id="campaign-composer"></section>'),selectProto=Object.getPrototypeOf(document.createElement('select')),dialogProto=Object.getPrototypeOf(document.createElement('dialog'));
 Object.defineProperty(selectProto,'value',{configurable:true,get(){return [...this.options].find(x=>x.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const x of this.options)x.toggleAttribute('selected',x.value===String(v));}});
 dialogProto.showModal=function(){this.setAttribute('open','');};dialogProto.close=function(){this.removeAttribute('open');this.onclose?.();};
 Object.defineProperty(dialogProto,'open',{configurable:true,get(){return this.hasAttribute('open');}});
 let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focused?.isConnected?focused:document.body});
 const calls=[],control={lose,before:null,failReopen:0,campaignRejected:false},payload=caps();if(regular)Object.assign(payload.capabilities.campaign_audience,{validate:true,regular:{contract_version:'crm-audience-regular-admission-v1',prepare:true,schedule:true,operation:true}});if(!enabled)delete payload.capabilities.campaign_audience;if(noCapabilities)payload.capabilities={};if(noCampaignCapability)delete payload.capabilities.campaigns;
 class Clock extends Date{}
 const context=vm.createContext({document,window,console,Date:Clock,Intl,URL,URLSearchParams,AbortSignal,AbortController,TextEncoder,TextDecoder,crypto:webcrypto,setTimeout,clearTimeout,
  navigator:{locks:require('./campaign-lock-fixture.cjs')()},localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
  __api:payload,__manager:'synthetic-manager-key',shrigmaChave:()=>context.__manager,shrigmaChaveOperador:()=>context.__manager,GMP:{openEmail(){}},
  fetch:async(url,init)=>{
   const u=new URL(url),request=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(u.searchParams),entry={endpoint:u.origin,method:init.method,request,headers:{...init.headers}};calls.push(entry);if(control.before)await control.before(entry);
   const input={method:init.method,request:{headers:{...init.headers},[init.method==='POST'?'body':'query']:request}};
   let r;
   if(u.origin==='https://audience.test')r=await f.api.handle(input);
   else if(u.origin==='https://binding.test')r=await (regularAPI&&Object.values(require('../n8n/growth/segment-regular-admission.cjs').ACTIONS).includes(request.acao)?regularAPI:bindingAPI).handle(input);
   else if(u.origin==='https://campaign.test'&&request.acao==='campanha_catalogo'){
    const current=await f.current(campaignId),d=current.definition;
    r={status:200,body:{brand,current:true,lists:d.list_ids.map(id=>({id,brand,name:'Synthetic list '+id,available:true})),templates:[{id:d.template_id,name:'Synthetic template',available:true,type:'campaign'}]}};
   }
   else if(u.origin==='https://campaign.test'&&request.acao==='campanha_listar')r={status:200,body:{campaigns:[await f.current(campaignId)]}};
   else if(u.origin==='https://campaign.test'&&request.acao==='campanha_operacao'&&control.campaignRejected)r={status:200,body:{operation:{brand,state:'rejected',providerId:null}}};
   else if(u.origin==='https://campaign.test'&&request.acao==='campanha_obter'){if(control.failReopen>0){control.failReopen--;throw Error('synthetic reopen failure');}r={status:200,body:{campaign:await f.current(Number(request.id))}};}
   else throw Error('UNEXPECTED_LEGACY_ACTION');
   if(control.lose&&(regular?request.acao==='campanha_publico_agendar':request.acao==='campanha_publico_vincular'))throw Error('synthetic lost ACK');
   return {status:r.status,ok:r.status>=200&&r.status<300,json:async()=>structuredClone(r.body),text:async()=>JSON.stringify(r.body)};
  }});
 for(const file of ['n8n/growth/campaign-tracking.js','campaign-contract.js','growth-brand-state.js','growth-campaign-api.js','growth-utm.js','n8n/growth/segment-contract.js','n8n/growth/segment-audience-contract.js','growth-segment-client.js','growth-campaign-audience-client.js','growth-campaign-regular-client.js','growth-campaign-audience-ui.js','growth-campaign-editor.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
 const run=code=>vm.runInContext(code,context);run('GCE.mount({marca:'+JSON.stringify(brand)+',api:__api})');
 return {db,f,store,audience,campaignId,document,window,context,run,calls,control,payload,q:s=>document.querySelector(s)};
}
async function until(check){for(let i=0;i<1500;i++){if(check())return;await new Promise(r=>setTimeout(r,2));}assert.fail('Candidate UI did not settle');}
async function load(x){x.q('[data-ca="load"]').click();try{await until(()=>x.q('[data-ca-select]')&&!x.run('GCE.contextStatus().blocked'));}catch{assert.fail(JSON.stringify({status:x.q('[data-ca-status]')?.textContent,calls:x.calls.map(c=>c.request.acao)}));}}
async function inspect(x){await load(x);const s=x.q('[data-ca-select]');s.value=x.audience.id;s.dispatchEvent(new x.window.Event('change',{bubbles:true}));x.q('[data-ca="inspect"]').click();await until(()=>x.q('[data-ca-inspection]')&&!x.run('GCE.contextStatus().blocked'));}
const posts=x=>x.calls.filter(c=>c.request.acao==='campanha_publico_vincular');
async function reopenSaved(x){
 const before=x.calls.filter(c=>c.request.acao==='campanha_publico_obter').length;
 x.q('[data-ce-refresh]').click();await until(()=>!!x.q('[data-ce-open]')&&!x.q('[data-ce-open]').disabled&&!x.run('GCE.contextStatus().blocked'));
 x.q('[data-ce-open]').click();if(x.q('[data-ce-confirm]').open)x.q('[data-ce-confirm-yes]').click();
 try{await until(()=>x.calls.filter(c=>c.request.acao==='campanha_publico_obter').length>before&&!x.run('GCE.contextStatus().blocked'));}catch{assert.fail(JSON.stringify({actions:x.calls.map(c=>c.request.acao),status:x.q('[data-ce-status]')?.textContent,audience:x.q('[data-ca-status]')?.textContent,dialog:x.q('[data-ce-confirm]')?.open,blocked:x.run('GCE.contextStatus().blocked')}));}
}
for(const brand of ['fish','aristo'])test(brand+': reopening a list-only draft confirms null binding before legacy validation',async t=>{
 const x=await setup(t,brand),before=x.calls.length;
 assert.equal(x.q('[data-ce-validate]').disabled,true);
 await reopenSaved(x);
 assert.equal(x.run('GCE.contextStatus().pending'),false);
 assert.equal(x.run('GCE.contextStatus().blocked'),false);
 assert.equal(x.q('[data-ce-validate]').disabled,false);
 assert.equal(x.q('[data-ce-schedule]').disabled,true); // The original validation and review are still required.
 assert.match(x.q('[data-ce-saved-audience]').textContent,/Nenhum público salvo vinculado/);
 assert.deepEqual(x.calls.slice(before).filter(c=>c.method==='POST'),[]);
 assert.equal(x.calls.slice(before).filter(c=>c.request.acao==='campanha_publico_obter').length,1);
});
test('a reopened bound draft keeps the legacy list schedule closed without any send POST',async t=>{
 const x=await setup(t,'fish');await inspect(x);x.q('[data-ca="bind"]').click();x.q('[data-ca-yes]').click();await until(()=>!x.run('GCE.contextStatus().blocked'));
 const before=x.calls.length;await reopenSaved(x);
 assert.equal(x.run('GCE.contextStatus().pending'),false);
 assert.equal(x.q('[data-ce-schedule]').disabled,true);
 assert.match(x.q('[data-ce-audience]').textContent,/público salvo/i);
 assert.deepEqual(x.calls.slice(before).filter(c=>c.method==='POST'),[]);
});
test('binding read failure leaves a reopened list draft blocked and retryable without POST',async t=>{
 const x=await setup(t,'fish');x.control.before=entry=>{if(entry.request.acao==='campanha_publico_obter')throw Error('synthetic transport loss');};
 const before=x.calls.length;await reopenSaved(x);
 assert.equal(x.q('[data-ce-validate]').disabled,true);
 assert.equal(x.q('[data-ce-schedule]').disabled,true);
 assert.match(x.q('[data-ce-audience]').textContent,/Não foi possível confirmar o vínculo/);
 assert.deepEqual(x.calls.slice(before).filter(c=>c.method==='POST'),[]);
});
test('a version changed between campaign reopen and binding GET cannot unlock list scheduling',async t=>{
 const x=await setup(t,'fish');
 await x.db.exec("CREATE FUNCTION fixture_campaign_auto_read_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=clock_timestamp(); RETURN NEW; END $$; CREATE TRIGGER fixture_campaign_auto_read_touch BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION fixture_campaign_auto_read_touch();");
 let touched=false;x.control.before=async entry=>{if(!touched&&entry.request.acao==='campanha_publico_obter'){touched=true;await x.db.query('UPDATE campaigns SET body=body WHERE id=$1',[x.campaignId]);}};
 const before=x.calls.length;await reopenSaved(x);
 assert.equal(touched,true);assert.equal(x.q('[data-ce-validate]').disabled,true);assert.equal(x.q('[data-ce-schedule]').disabled,true);
 assert.match(x.q('[data-ca-status]').textContent,/campanha mudou/i);
 assert.deepEqual(x.calls.slice(before).filter(c=>c.method==='POST'),[]);
});
test('editing the reopened campaign disables validation until the changed draft is saved',async t=>{
 const x=await setup(t,'fish');await reopenSaved(x);assert.equal(x.q('[data-ce-validate]').disabled,false);
 const subject=x.q('[name=subject]');subject.value='Synthetic unsaved change';subject.dispatchEvent(new x.window.Event('input',{bubbles:true}));
 assert.equal(x.q('[data-ce-validate]').disabled,true);assert.equal(x.q('[data-ce-schedule]').disabled,true);
 assert.equal(x.calls.filter(c=>c.method==='POST').length,0);
});
test('read-only audience capability permits binding lookup but never opens editor writes',async t=>{
 const x=await setup(t,'aristo');Object.assign(x.payload.capabilities.campaign_audience,{inspect:false,bind:false,release:false,validate:false});Object.assign(x.payload.capabilities.campaigns,{save:false,validate:false,schedule:false,cancel:false});
 x.run('GCE.mount({marca:"aristo",api:__api})');const before=x.calls.length;await reopenSaved(x);
 assert.equal(x.q('[data-ce-validate]').hidden,true);
 assert.equal(x.q('[data-ce-schedule]').hidden,true);
 assert.deepEqual(x.calls.slice(before).filter(c=>c.method==='POST'),[]);
});
test('switching brands detaches old audience handlers and each click performs one scoped GET pair',async t=>{
 const x=await setup(t,'fish');await load(x);
 const journalKey='shrigma_campaign_audience_v1:fish:'+x.campaignId,original=x.store.get(journalKey);
 assert.equal(x.run('GCE.enterBrand("aristo")'),true);assert.equal(x.run('GCE.enterBrand("fish")'),true);
 assert.equal(x.store.get(journalKey),original);
 const before=x.calls.length;x.q('[data-ca="load"]').click();
 await until(()=>x.calls.slice(before).filter(c=>c.request.acao==='segmentos_listar').length===1&&!x.run('GCE.contextStatus().blocked'));
 assert.deepEqual(x.calls.slice(before).map(c=>c.request.acao),['campanha_publico_obter','segmentos_listar']);
 assert.equal(x.calls.slice(before).filter(c=>c.method==='POST').length,0);
});
test('corrupt original-brand binding journal remains frozen after navigating away and back',async t=>{
 const slot='shrigma_campaign_audience_v1:fish:100',corrupt='{"synthetic":"invalid-journal"}',x=await setup(t,'fish',{store:new Map([[slot,corrupt]])});
 assert.equal(x.run('GCE.contextStatus().blocked'),true);assert.equal(x.q('[data-ce-validate]').disabled,true);
 assert.equal(x.run('GCE.enterBrand("aristo")'),true);assert.equal(x.run('GCE.enterBrand("fish")'),true);
 assert.equal(x.store.get(slot),corrupt);assert.equal(x.run('GCE.contextStatus().blocked'),true);
 assert.equal(x.q('[data-ce-validate]').disabled,true);assert.equal(x.q('[data-ce-schedule]').disabled,true);
 assert.equal(x.calls.filter(c=>c.method==='POST').length,0);
});
test('selector explains saved Shopify rules and freshness without counting or changing local records',async t=>{
 const db=new PGlite();t.after(()=>db.close());const f=await F.setup(db,{countProvider:require('../n8n/growth/segment-audience-listmonk.cjs').countAudience});
 await f.createAudience('fish','shopify-selector-proof',{op:'condition',field:'purchase.product',operator:'not_purchased',value:'gid://shopify/Product/101'});
 for(const id of [100,200])await db.transaction(async tx=>{await tx.query("SELECT set_config('shrigma.campaign_writer',$1,true)",[String(id)]);await tx.query("UPDATE campaigns SET body=body||' {{ UnsubscribeURL }}',altbody=altbody||' {{ UnsubscribeURL }}' WHERE id=$1",[id]);});
 const x=await setup(t,'fish',{fixture:f});await load(x);const select=x.q('[data-ca-select]'),beforeCalls=x.calls.length;
 select.value=x.audience.id;const beforeStore=[...x.store.entries()];select.dispatchEvent(new x.window.Event('change',{bubbles:true}));
 assert.match(x.q('[data-ca-audience-summary]').textContent,/Produto nos pedidos: não comprou nos pedidos identificados Synthetic product/);
 assert.match(x.q('[data-ca-audience-freshness]').textContent,/Atualizado no painel em/);assert.match(x.q('[data-ca-audience-freshness]').textContent,/Dados Shopify coletados até/);assert.match(x.q('[data-ca-audience-freshness]').textContent,/sincronização é noturna/);
 assert.match(x.q('[data-ca-audience-count-guidance]').textContent,/abra Público, reabra esta versão e use Contar público/);
 assert.equal(x.calls.length,beforeCalls);assert.equal(x.calls.filter(c=>c.request.acao==='segmento_contar').length,0);assert.deepEqual([...x.store.entries()],beforeStore);assert.equal(x.q('[data-ca-inspection]'),null);
});
for(const brand of ['fish','aristo'])test(brand+': bound validation counts the saved expression and rechecks consent without calling legacy review',async t=>{
 const x=await setup(t,brand);
 await x.db.exec("UPDATE shrigma_panel_permission_v1 SET caps=caps||'[\"validate\"]'::jsonb WHERE principal_id='manager'");
 x.payload.capabilities.campaign_audience.validate=true;x.run('GCE.mount({marca:'+JSON.stringify(brand)+',api:__api})');
 await inspect(x);x.q('[data-ca="bind"]').click();x.q('[data-ca-yes]').click();await until(()=>!x.run('GCE.contextStatus().blocked'));
 const binding=await x.f.bound(x.campaignId);
 assert.equal(x.q('[data-ce-validate]').disabled,false);
 const validate=async()=>{x.q('[data-ce-validate]').click();await until(()=>!!x.q('[data-ca-validation]')&&!x.run('GCE.contextStatus().blocked'));};
 await validate();assert.match(x.q('[data-ca-validation]').textContent,/1 pessoas elegíveis/);
 assert.equal(x.q('[data-ce-schedule]').disabled,true);
 const base=brand==='fish'?17:16;await x.db.query("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=$1",[base]);
 await validate();assert.match(x.q('[data-ca-validation]').textContent,/0 pessoas elegíveis/);
 assert.equal((await x.f.current(x.campaignId)).status,'draft');assert.deepEqual(await x.f.bound(x.campaignId),binding);
 assert.equal(x.calls.filter(c=>c.request.acao==='campanha_publico_validar').length,2);
 assert.equal(x.calls.filter(c=>['campanha_validar','campanha_agendar'].includes(c.request.acao)).length,0);
 x.run('Date.now=()=>4102444800000');x.run('GCE.mount({marca:'+JSON.stringify(brand)+',api:__api})');
 assert.match(x.q('[data-ca-validation]').textContent,/venceu/);
});
for(const brand of ['fish','aristo'])test(brand+': saved audience uses the actual draft, requires confirmation and blocks legacy sends',async t=>{
 const x=await setup(t,brand);assert.equal(x.calls.length,0);assert.equal(x.q('[data-ce-validate]').disabled,true);
 await inspect(x);assert.equal(posts(x).length,0);x.q('[data-ca="bind"]').click();assert.equal(x.q('[data-ca-dialog]').open,true);assert.equal(x.run('GCE.contextStatus().blocked'),true);assert.equal(x.q('[data-ce-save]').disabled,true);
 assert.equal(x.run('GCE.enterBrand("'+(brand==='fish'?'aristo':'fish')+'")'),false);x.q('[data-ca-no]').click();await until(()=>!x.run('GCE.contextStatus().blocked'));assert.equal(posts(x).length,0);
 x.q('[data-ca="bind"]').click();x.q('[data-ca-yes]').click();await until(()=>!x.run('GCE.contextStatus().blocked'));
 assert.equal(posts(x).length,1,x.q('[data-ca-status]')?.textContent);assert.equal((await x.f.bound(x.campaignId)).audience_id,x.audience.id);assert.match(x.q('[data-ce-saved-audience]').textContent,/Público vinculado/);
 assert.equal(x.q('[data-ce-validate]').disabled,true);assert.equal(x.q('[data-ce-schedule]').disabled,true);
 x.q('[data-ce-validate]').dispatchEvent(new x.window.Event('click'));x.q('[data-ce-schedule]').dispatchEvent(new x.window.Event('click'));await new Promise(setImmediate);
 assert.equal(x.calls.filter(c=>['campanha_validar','campanha_agendar','campanha_salvar'].includes(c.request.acao)).length,0);
 assert.ok(x.calls.filter(c=>c.endpoint==='https://binding.test').every(c=>c.headers.Authorization==='Bearer synthetic-manager-key'));
 for(const [key,value]of x.store)assert.doesNotMatch(key+value,/synthetic-manager-key/);
 assert.equal((await x.f.current(x.campaignId)).status,'draft');
});
test('lost acknowledgement survives reload and consults one original operation without another bind',async t=>{
 const x=await setup(t,'fish',{lose:true});await inspect(x);x.q('[data-ca="bind"]').click();x.q('[data-ca-yes]').click();await until(()=>x.run('GCE.contextStatus().pending'));
 const original=x.store.get('shrigma_campaign_audience_v1:fish:'+x.campaignId);
 assert.equal(posts(x).length,1);assert.equal(x.run('GCE.enterBrand("aristo")'),true);assert.equal(x.store.get('shrigma_campaign_audience_v1:fish:'+x.campaignId),original);
 assert.equal(x.run('GCE.enterBrand("fish")'),true);assert.equal(x.run('GCE.contextStatus().pending'),true);assert.equal(x.store.get('shrigma_campaign_audience_v1:fish:'+x.campaignId),original);assert.equal(x.q('[data-ce-new]').disabled,true);
 const y=await setup(t,'fish',{store:x.store,fixture:x.f});assert.equal(y.run('GCE.contextStatus().pending'),true);y.q('[data-ca="consult"]').click();await until(()=>!y.run('GCE.contextStatus().pending')&&!y.run('GCE.contextStatus().blocked'));
 assert.equal(posts(y).length,0);assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_audience_v2.campaign_binding_request')).rows[0].n,1);assert.match(y.q('[data-ce-saved-audience]').textContent,/Público vinculado/);
});
test('two durable pending journals recover in order with GETs only and original operation keys',async t=>{
 const x=await setup(t,'fish',{lose:true});await inspect(x);x.q('[data-ca="bind"]').click();x.q('[data-ca-yes]').click();await until(()=>x.run('GCE.contextStatus().pending'));
 const audienceSlot='shrigma_campaign_audience_v1:fish:'+x.campaignId,audienceBefore=JSON.parse(x.store.get(audienceSlot)),campaignSlot='shrigma_campaign_operation_v1:fish',campaignBefore=JSON.parse(x.store.get(campaignSlot)),operationKey='synthetic-campaign-001';
 campaignBefore.operation={phase:'pending',actorFingerprint:createHash('sha256').update('synthetic-manager-key').digest('hex'),key:operationKey,request:{acao:'campanha_validar',brand:'fish',idempotency_key:operationKey}};
 x.store.set(campaignSlot,JSON.stringify(campaignBefore));
 const y=await setup(t,'fish',{store:x.store,fixture:x.f});y.control.campaignRejected=true;
 assert.equal(y.run('GCE.contextStatus().pending'),true);assert.equal(y.q('[data-ce-consult]').disabled,false);
 assert.equal(y.q('[data-ca="consult"]').disabled,true); // The campaign journal is reconciled first.
 y.q('[data-ce-consult]').click();await until(()=>JSON.parse(y.store.get(campaignSlot)).operation.phase==='rejected'&&!y.q('[data-ca="consult"]').disabled);
 assert.equal(y.run('GCE.contextStatus().pending'),true);assert.equal(JSON.parse(y.store.get(audienceSlot)).operation.request.idempotency_key,audienceBefore.operation.request.idempotency_key);
 y.q('[data-ca="consult"]').click();await until(()=>!y.run('GCE.contextStatus().pending')&&!y.run('GCE.contextStatus().blocked'));
 assert.equal(JSON.parse(y.store.get(campaignSlot)).operation.key,operationKey);
 assert.equal(JSON.parse(y.store.get(audienceSlot)).operation.request.idempotency_key,audienceBefore.operation.request.idempotency_key);
 assert.equal(y.calls.filter(c=>c.method==='POST').length,0);
 assert.equal(y.calls.filter(c=>c.request.acao==='campanha_operacao').length,1);
 assert.equal(y.calls.filter(c=>c.request.acao==='campanha_publico_operacao').length,1);
});
test('a saved binding remains releasable when the audience listing is unavailable',async t=>{
 const x=await setup(t);await inspect(x);x.q('[data-ca="bind"]').click();x.q('[data-ca-yes]').click();await until(()=>!x.run('GCE.contextStatus().blocked'));
 const before=x.calls.length;x.control.before=async entry=>{if(entry.endpoint==='https://audience.test'&&entry.request.acao==='segmentos_listar')throw Error('synthetic audience listing unavailable');};
 x.q('[data-ca="load"]').click();await until(()=>/não puderam ser listados/.test(x.q('[data-ca-status]')?.textContent||'')&&!x.run('GCE.contextStatus().blocked'));
 const actions=x.calls.slice(before).map(c=>c.request.acao);assert.deepEqual(actions.slice(0,2),['campanha_publico_obter','segmentos_listar']);assert.equal(x.q('[data-ca="release"]').disabled,false);
 x.q('[data-ca="release"]').click();assert.equal(x.q('[data-ca-dialog]').open,true);x.q('[data-ca-yes]').click();await until(()=>!x.run('GCE.contextStatus().blocked'));
 assert.equal((await x.f.bindingCall({acao:'campanha_publico_obter',brand:'fish',campaign_id:x.campaignId})).body.binding,null);assert.equal((await x.f.current(x.campaignId)).status,'draft');
 assert.equal(x.calls.filter(c=>['campanha_validar','campanha_agendar','campanha_publico_validar'].includes(c.request.acao)).length,0);
});
test('changed manager, unsaved fields, expired confirmation and a different revision never post a binding',async t=>{
 for(const change of ['key','dirty','expired','version']){
  const x=await setup(t);await inspect(x);x.q('[data-ca="bind"]').click();
  if(change==='key')x.run('__manager="synthetic-other-key"');
  if(change==='dirty'){x.q('[name=subject]').value='Changed during modal';x.run('GCE.mount({marca:"fish",api:__api})');}
  if(change==='expired')x.run('Date.now=()=>4102444800000');
  if(change==='version'){const k='shrigma_campaign_operation_v1:fish',j=JSON.parse(x.store.get(k));j.campaign.version='b'.repeat(32);x.store.set(k,JSON.stringify(j));x.run('GCE.mount({marca:"fish",api:__api})');}
  x.q('[data-ca-yes]').click();await until(()=>!x.q('[data-ca-dialog]')?.open);assert.equal(posts(x).length,0,change);
 }
});
test('capability absent leaves legacy preparation unchanged and issues no audience requests',async t=>{
 const x=await setup(t,'aristo',{enabled:false});assert.equal(x.q('[data-ce-saved-audience]').hidden,true);assert.equal(x.q('[data-ce-save]').disabled,false);assert.equal(x.q('[data-ce-validate]').disabled,false);assert.equal(x.calls.length,0);
});
test('revoked capability preserves a known binding and freezes editing, including after reload',async t=>{
 const x=await setup(t);await inspect(x);x.q('[data-ca="bind"]').click();x.q('[data-ca-yes]').click();await until(()=>!x.run('GCE.contextStatus().blocked'));
 assert.equal(posts(x).length,1);delete x.payload.capabilities.campaign_audience;x.run('GCE.mount({marca:"fish",api:__api})');
 for(const y of [x,await setup(t,'fish',{enabled:false,store:x.store,fixture:x.f})]){
  assert.equal(y.q('[data-ce-saved-audience]').hidden,false);assert.match(y.q('[data-ce-saved-audience]').textContent,/registro foi preservado/);
  assert.equal(y.run('GCE.contextStatus().blocked'),true);
  for(const selector of ['[name=subject]','[data-ce-save]','[data-ce-validate]','[data-ce-schedule]'])assert.equal(y.q(selector).disabled,true,selector);
  assert.equal(y.run('GCE.enterBrand("aristo")'),true);assert.equal(y.run('GCE.enterBrand("fish")'),true);
  for(const selector of ['[name=subject]','[data-ce-save]','[data-ce-validate]','[data-ce-schedule]'])assert.equal(y.q(selector).disabled,true,selector);
 }
});
test('reload without capability cannot abandon an uncertain binding; restoring access permits only consultation',async t=>{
 const x=await setup(t,'fish',{lose:true});await inspect(x);x.q('[data-ca="bind"]').click();x.q('[data-ca-yes]').click();await until(()=>x.run('GCE.contextStatus().pending'));
 const y=await setup(t,'fish',{enabled:false,store:x.store,fixture:x.f});assert.equal(y.run('GCE.contextStatus().blocked'),true);assert.equal(y.run('GCE.enterBrand("aristo")'),true);assert.equal(y.run('GCE.enterBrand("fish")'),true);assert.equal(y.q('[data-ce-save]').disabled,true);assert.equal(y.q('[name=subject]').disabled,true);assert.equal(y.calls.length,0);
 y.payload.capabilities.campaign_audience=caps().capabilities.campaign_audience;y.run('GCE.mount({marca:"fish",api:__api})');assert.equal(y.run('GCE.contextStatus().pending'),true);assert.equal(y.q('[data-ca="load"]').disabled,true);
 y.q('[data-ca="consult"]').click();await until(()=>!y.run('GCE.contextStatus().pending')&&!y.run('GCE.contextStatus().blocked'));assert.equal(posts(y).length,0);
 assert.equal((await x.db.query('SELECT count(*)::int n FROM crm_audience_v2.campaign_binding_request')).rows[0].n,1);
});
test('an import that finishes during audience confirmation cannot replace the reviewed campaign',async t=>{
 const x=await setup(t);await inspect(x);const before=x.q('[name=subject]').value,current=await x.f.current(x.campaignId);let release;
 const field=x.q('[data-ce-import]');Object.defineProperty(field,'files',{value:[{size:100,text:()=>new Promise(resolve=>{release=resolve;})}]});
 field.dispatchEvent(new x.window.Event('change'));assert.equal(typeof release,'function');x.q('[data-ca="bind"]').click();assert.equal(x.q('[data-ca-dialog]').open,true);
 release(JSON.stringify({...current.definition,subject:'Late imported subject'}));await until(()=>/rascunho mudou durante a leitura/.test(x.q('[data-ce-status]').textContent));
 assert.equal(x.q('[name=subject]').value,before);assert.equal(posts(x).length,0);x.q('[data-ca-no]').click();await until(()=>!x.run('GCE.contextStatus().blocked'));
});
test('a native timestamp trigger changes the campaign revision; the editor reopens it after the binding',async t=>{
 const x=await setup(t),before=await x.f.current(x.campaignId);
 await x.db.exec("CREATE FUNCTION fixture_campaign_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=clock_timestamp(); RETURN NEW; END $$; CREATE TRIGGER fixture_campaign_touch BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION fixture_campaign_touch();");
 await inspect(x);x.q('[data-ca="bind"]').click();x.q('[data-ca-yes]').click();await until(()=>!x.run('GCE.contextStatus().blocked'));
 const after=await x.f.current(x.campaignId),saved=JSON.parse(x.store.get('shrigma_campaign_operation_v1:fish'));
 assert.notEqual(after.version,before.version);assert.equal(saved.campaign.version,after.version);assert.deepEqual(after.definition,before.definition);assert.equal(posts(x).length,1);
 assert.equal(x.calls.filter(c=>c.request.acao==='campanha_obter').length,1);assert.match(x.q('[data-ce-server-state]').textContent,/Conteúdo corresponde à versão salva/);
});
test('the local campaign anchor preserves an uncertain binding when native or all capabilities disappear on reload',async t=>{
 const x=await setup(t,'fish',{lose:true});await inspect(x);x.q('[data-ca="bind"]').click();x.q('[data-ca-yes]').click();await until(()=>x.run('GCE.contextStatus().pending'));
 for(const noCapabilities of [false,true]){
 const y=await setup(t,'fish',{noCapabilities,noCampaignCapability:true,store:new Map(x.store),fixture:x.f});assert.equal(y.run('GCE.contextStatus().blocked'),true);assert.equal(y.run('GCE.enterBrand("aristo")'),true);assert.equal(y.run('GCE.enterBrand("fish")'),true);assert.equal(y.q('[name=subject]').disabled,true);assert.equal(y.q('[data-ce-import]').disabled,true);assert.equal(y.q('[data-ce-saved-audience]').hidden,false);assert.equal(y.calls.length,0);
 y.payload.capabilities=caps().capabilities;y.run('GCE.mount({marca:"fish",api:__api})');assert.equal(y.run('GCE.contextStatus().pending'),true);
 y.q('[data-ca="consult"]').click();await until(()=>!y.run('GCE.contextStatus().pending')&&!y.run('GCE.contextStatus().blocked'));assert.equal(posts(y).length,0);assert.match(y.q('[data-ce-saved-audience]').textContent,/Público vinculado/);
 }
});

for(const brand of ['fish','aristo'])test(brand+': Gestor selects, validates, explicitly confirms and reconciles a saved audience schedule',async t=>{
 const x=await setup(t,brand,{regular:true});
 await inspect(x);x.q('[data-ca="bind"]').click();x.q('[data-ca-yes]').click();await until(()=>!x.run('GCE.contextStatus().blocked'));
 assert.equal(x.q('[data-ce-validate]').disabled,false);x.q('[data-ce-validate]').click();
 await until(()=>!!x.q('[data-ca-regular-review]')&&!x.run('GCE.contextStatus().blocked'));
 assert.equal(x.q('[data-ce-schedule]').disabled,false,x.q('[data-ca-status]').textContent);
 x.q('[data-ce-schedule]').click();assert.equal(x.q('[data-ca-dialog]').open,true);x.q('[data-ca-no]').click();await until(()=>!x.run('GCE.contextStatus().blocked'));
 assert.equal(x.calls.filter(c=>c.request.acao==='campanha_publico_agendar').length,0);
 x.control.lose=true;x.q('[data-ce-schedule]').click();x.q('[data-ca-yes]').click();await until(()=>x.run('GCE.contextStatus().pending')&&!x.q('[data-ca-dialog]')?.open);
 assert.equal((await x.f.current(x.campaignId)).status,'scheduled');
 const y=await setup(t,brand,{regular:true,store:x.store,fixture:x.f});assert.equal(y.run('GCE.contextStatus().pending'),true);
 y.q('[data-ca="consult"]').click();await until(()=>!y.run('GCE.contextStatus().pending')&&!y.run('GCE.contextStatus().blocked'));
 assert.match(y.q('[data-ca-status]').textContent,/Agendamento confirmado/);assert.match(y.q('[data-ce-server-state]').textContent,/Agendada/);
 assert.equal(x.calls.filter(c=>c.request.acao==='campanha_publico_agendar').length,1);assert.equal(y.calls.filter(c=>c.request.acao==='campanha_publico_agendar').length,0);
 assert.equal(x.calls.filter(c=>['campanha_validar','campanha_agendar'].includes(c.request.acao)).length,0);
 assert.equal((await x.db.query('SELECT count(*)::int n FROM shrigma_email_dispatch')).rows[0].n,0);
 for(const [k,v]of x.store)assert.doesNotMatch(k+v,/synthetic-manager-key/);
});

for(const action of ['vínculo','agendamento'])test('programmatic access changes cannot cross the '+action+' confirmation',async t=>{
 const regular=action==='agendamento',open=async x=>{await inspect(x);if(!regular){x.q('[data-ca="bind"]').click();return;}x.q('[data-ca="bind"]').click();x.q('[data-ca-yes]').click();await until(()=>!x.run('GCE.contextStatus().blocked'));x.q('[data-ce-validate]').click();await until(()=>!!x.q('[data-ca-regular-review]')&&!x.run('GCE.contextStatus().blocked'));x.q('[data-ce-schedule]').click();};
 const actionName=regular?'campanha_publico_agendar':'campanha_publico_vincular';
 const x=await setup(t,'fish',{regular});await open(x);assert.equal(x.q('[data-ca-dialog]').open,true);assert.equal(x.q('[data-ce-access-open]').disabled,true);
 x.q('[data-ce-access-open]').dispatchEvent(new x.window.Event('click',{bubbles:true,cancelable:true}));assert.equal(x.q('[data-ce-access-form]').hidden,true);
 const form=x.q('[data-ce-access-form]');form.hidden=false;x.q('[data-ce-key]').value='replacement-writer-key';form.dispatchEvent(new x.window.Event('submit',{bubbles:true,cancelable:true}));
 x.q('[data-ca-yes]').click();await until(()=>!x.run('GCE.contextStatus().blocked'));
 const sent=x.calls.filter(c=>c.request.acao===actionName);assert.equal(sent.length,1);assert.equal(sent[0].headers.Authorization,'Bearer synthetic-manager-key');
 const y=await setup(t,'fish',{regular});await open(y);assert.equal(y.q('[data-ca-dialog]').open,true);y.run('__manager="replacement-operator-key"');y.q('[data-ca-yes]').click();
 await until(()=>!y.q('[data-ca-dialog]')?.open&&!y.run('GCE.contextStatus().blocked'));assert.equal(y.calls.filter(c=>c.request.acao===actionName).length,0);
});

test('a confirmed regular receipt remains recoverable after reopen fails and reload never repeats the POST',async t=>{
 const x=await setup(t,'fish',{regular:true});await inspect(x);x.q('[data-ca="bind"]').click();x.q('[data-ca-yes]').click();await until(()=>!x.run('GCE.contextStatus().blocked'));
 x.q('[data-ce-validate]').click();await until(()=>!!x.q('[data-ca-regular-review]')&&!x.run('GCE.contextStatus().blocked'));
 x.control.lose=true;x.q('[data-ce-schedule]').click();x.q('[data-ca-yes]').click();await until(()=>x.run('GCE.contextStatus().pending'));
 const y=await setup(t,'fish',{regular:true,store:x.store,fixture:x.f});y.control.failReopen=1;y.q('[data-ca="consult"]').click();
 await until(()=>y.q('[data-ca-status]')?.dataset.error==='true'&&y.calls.some(c=>c.request.acao==='campanha_obter'));
 assert.equal(y.run('GCE.contextStatus().pending'),true);assert.equal(y.calls.filter(c=>c.request.acao==='campanha_publico_agendamento_operacao').length,1);
 const z=await setup(t,'fish',{regular:true,store:x.store,fixture:x.f});assert.equal(z.run('GCE.contextStatus().pending'),true);z.q('[data-ca="consult"]').click();
 await until(()=>!z.run('GCE.contextStatus().pending')&&!z.run('GCE.contextStatus().blocked'));
 assert.match(z.q('[data-ce-server-state]').textContent,/Agendada/);assert.equal(z.calls.filter(c=>c.request.acao==='campanha_publico_agendar').length,0);assert.equal(z.calls.filter(c=>c.request.acao==='campanha_publico_agendamento_operacao').length,0);
});
