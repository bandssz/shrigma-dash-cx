'use strict';
// The manifest sources and the real page run in a local DOM. No generated
// assets, browser, API, credentials or external transport are used here.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),{parseHTML}=require('linkedom');
const F=require('./growth-segment-fixture.cjs'),root=path.resolve(__dirname,'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'tools/panel-build/manifest.json'))).growth;
function payload(capabilities){return {_escopo:'growth',_painel:'growth',gerado_em:'2026-09-28T12:00:00Z',capabilities,
 ...Object.fromEntries(['crm_campanha','crm_fluxo','crm_conversao','crm_campanha_receita','crm_campanha_grupo','crm_diario','crm_intradia','crm_carrinho','crm_galho','crm_regra_galho','crm_teste','crm_teste_braco','crm_credencial','wa_saude'].map(k=>[k,[]])),
 crm_base:['fish','aristo'].map(marca=>({marca,dia:'2026-09-28',coletado_em:'2026-09-28T12:00:00Z',total:marca==='fish'?12:34,segmentos:{}}))};}
async function boot({version='crm-segment-v1',enabled=true,manager=true,brand='fish',section='base',built=false,setupFixture=()=>{}}={}){
 const f=F.fixture({version});setupFixture(f);const html=fs.readFileSync(path.join(root,'growth.html'),'utf8'),{document,window}=parseHTML(html);
 const selectProto=Object.getPrototypeOf(document.createElement('select'));
 Object.defineProperty(selectProto,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||this.options[0]?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
 const dialogProto=Object.getPrototypeOf(document.createElement('dialog'));
 dialogProto.showModal=function(){this.setAttribute('open','');};dialogProto.close=function(){this.removeAttribute('open');this.onclose?.();};
 Object.defineProperty(dialogProto,'open',{configurable:true,get(){return this.hasAttribute('open');},set(v){this.toggleAttribute('open',!!v);}});
 let focused=null;window.HTMLElement.prototype.focus=function(){focused=this;};window.HTMLElement.prototype.scrollIntoView=function(){};
 window.HTMLElement.prototype.getBoundingClientRect=()=>({top:0,width:1200,height:100});
 Object.defineProperty(document,'activeElement',{configurable:true,get:()=>focused?.isConnected?focused:document.body});
 const intervals=[],requests=[],hashes=[];let response=payload(enabled?f.api.capabilities:undefined);
 const NativeDate=Date;class FixedDate extends Date{constructor(...a){super(...(a.length?a:['2026-09-28T12:10:00Z']));}static now(){return Date.parse('2026-09-28T12:10:00Z');}}
 const context=vm.createContext({document,window,URL,URLSearchParams,Date:FixedDate,Intl,AbortSignal,AbortController,TextEncoder,crypto:webcrypto,navigator:{locks:f.locks},console,
 localStorage:f.storage,location:{hash:'#marca='+brand+'&sec='+section,search:''},history:{replaceState:(_a,_b,url)=>hashes.push(url)},
 addEventListener(){},setInterval(fn,ms){intervals.push({fn,ms});return intervals.length;},clearInterval(){},setTimeout,clearTimeout,queueMicrotask,
 Image:class{},Blob:class{},prompt:()=>null,confirm:()=>false,
 fetch:async(url,init)=>{requests.push({url,init});const u=new URL(url);if(u.hostname==='segments.example.test'||u.hostname==='changed.example.test')return f.fetch(url,init);
  const body=structuredClone(response);if(u.searchParams.get('action')==='cache_growth')body._cache_gerado_em=new NativeDate(FixedDate.now()).toISOString();return {status:200,ok:true,json:async()=>body};}});
 const run=code=>vm.runInContext(code,context);
 for(const script of built?['assets/panels/growth.js']:manifest.scripts)vm.runInContext(fs.readFileSync(path.join(root,script),'utf8'),context,{filename:script});
 run("shrigmaGuardaChave('growth','synthetic-manager-key');"+(manager?"SHRIGMA_OPERATOR_SESSION.growth={caps:['read_content','draft'],label:'Synthetic manager'};":''));
 for(const script of document.querySelectorAll('script:not([src])'))vm.runInContext(script.textContent,context,{filename:'growth-inline.js'});
 const x={f,document,window,run,requests,intervals,hashes,q:s=>document.querySelector(s),setResponse:v=>{response=v;},response:()=>structuredClone(response)};
 await settled(x);return x;
}
async function settled(x){for(let i=0;i<200;i++){if(!x.run('LOADING||CRM_SEGMENT_SYNC||CRM_AUDIENCE_CREATE_BUSY||CRM_SEGMENT_VIEW?.contextStatus().blocked'))return;await new Promise(r=>setTimeout(r,2));}assert.fail('Local panel did not settle');}
function fill(x,brand){const input=x.q('[data-gs-name]');input.value='Preparação '+brand;input.dispatchEvent(new x.window.Event('input',{bubbles:true}));const select=x.q('[data-gs-list]');select.value=brand==='fish'?'11':'21';select.dispatchEvent(new x.window.Event('change',{bubbles:true}));}
async function changeBrand(x,brand,{confirm=true}={}){x.q('[data-marca="'+brand+'"]').click();if(confirm&&x.q('#brand-change-confirm').open)x.q('#brand-change-accept').click();await settled(x);}


for(const brand of ['fish','aristo'])for(const built of [false,true])test(brand+': versioned RFM card opens, counts and saves through the complete panel '+(built?'bundle':'sources'),async()=>{
 const pin='b'.repeat(64),now=Date.parse('2026-09-28T12:10:00.000Z'),x=await boot({version:'crm-audience-v2',brand,built,setupFixture:f=>{
 const Audience=require('../n8n/growth/segment-audience-contract.js');f.control.catalogPatch={fields:Object.keys(Audience.FIELDS).map(key=>({key,available:true,...(key==='relationship.rfm'?{source_hash:pin}:{})})),rfm_snapshot:{brand,current:true,history_complete:true,source_hash:pin,operation_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',started_at:'2026-09-28T11:50:00.000Z',observed_at:'2026-09-28T12:00:00.000Z',expires_at:'2026-09-29T12:00:00.000Z',customers:3,resolved:2,unresolved:1,category_scope:'shopify_customers',semantics_version:'shopify-customer-rfm-v4',category_counts:{campeao:2,leal:0,um_x:0,um_x_lapsando:0,dormant:0,needs_attention:0,ex_campeao_at_risk:0}}};
 }});
 const card=x.q('[data-ga-rfm-id="campeao"]');assert.ok(card);assert.equal(card.querySelector('strong').textContent,'2');assert.match(card.textContent,/Clientes Shopify/);assert.equal(x.f.calls.length,1,'share existing segment GET; no additional catalog query');const create=x.q('[data-ga-rfm-create="campeao"]');assert.equal(create.disabled,false);create.click();await new Promise(r=>setTimeout(r,10));await settled(x);
 assert.equal(x.q('[data-gs-name]').value,'Campeões');assert.equal(x.q('[data-gs-field]').value,'relationship.rfm');assert.equal(x.q('[data-gs-value]').value,'campeao');assert.equal(x.run('CRM_SEGMENT_VIEW.contextStatus().dirty'),true);assert.equal(x.f.calls.filter(c=>c.method==='POST').length,0);
 x.q('[data-gs="count"]').click();await settled(x);assert.match(x.q('[data-gs-count]').textContent,/7 pessoas/);assert.match(x.q('#crm-segments-panel').textContent,/não comprova consentimento ou autorização para enviar/);x.q('[data-gs="save"]').click();await settled(x);
 const saved=[...x.f.rows.values()][0];assert.ok(saved);assert.equal(saved.brand,brand);assert.equal(saved.definition.rule.field,'relationship.rfm');assert.equal(saved.definition.rule.value,'campeao');assert.equal(x.requests.filter(r=>r.url.includes('synthetic-manager-key')).length,0);assert.doesNotMatch(JSON.stringify([...x.f.store]),/synthetic-manager-key/);
});
