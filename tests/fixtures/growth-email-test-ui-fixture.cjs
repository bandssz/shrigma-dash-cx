'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom'),P=require('../../n8n/growth/email-test-protocol.cjs'),GEC=require('../../growth-email-contract.js');
const source=name=>fs.readFileSync(path.join(__dirname,'../..',name),'utf8');
function setup({brand='fish',values=new Map(),operations=new Map(),mode='accepted',previewGate=null,previewPatch={},key='synthetic-manager',storageBlocked=false}={}){
 const {document,window}=parseHTML(`<html><body><div id="seg-marca"><button data-marca="fish" class="${brand==='fish'?'ativo':''}">Fish</button><button data-marca="aristo" class="${brand==='aristo'?'ativo':''}">Aristo</button></div><p id="brand-context-status" hidden></p><section id="control-drafts"></section></body></html>`);
 let focused=null,currentKey=key;window.HTMLElement.prototype.focus=function(){focused=this;};Object.defineProperty(document,'activeElement',{get:()=>focused?.isConnected?focused:document.body});
 const storage={getItem:k=>{if(storageBlocked)throw Error('storage');return values.get(k)??null;},setItem:(k,v)=>{if(storageBlocked)throw Error('storage');values.set(k,v);},removeItem:k=>values.delete(k)},calls=[],held=new Set();
 const locks={request:async(k,o,fn)=>{if(held.has(k))return fn(null);held.add(k);try{return await fn({});}finally{held.delete(k);}}};
 const json=(body,status=200)=>({status,json:async()=>body});let draft;
 const ctx=vm.createContext({document,window,localStorage:storage,URL,URLSearchParams,Date,Intl,TextEncoder,console,crypto:require('node:crypto').webcrypto,navigator:{locks},setInterval:()=>1,
  shrigmaChaveOperador:(_area,cap)=>['draft','submit'].includes(cap)?currentKey:'',confirm:()=>{throw Error('Native confirmation must not be used');},
  fetch:async(url,o)=>{
   calls.push({url,method:o.method,headers:o.headers,body:o.body});const q=new URL(url).searchParams;
   if(q.get('acao')==='email_teste_previa'){
    if(previewGate)await previewGate;
    const native=GEC.payload(draft),snap={eligible:true,draft_id:draft.servidor.draft_id,version:draft.servidor.version,rascunho:draft,components:{subject:native.subject,body_html:native.body},native:{id:100,type:'tx',subject:native.subject,body:native.body}};
    return json({...P.preview(P.plan(snap,GEC)),...previewPatch});
   }
   if(o.method==='POST'){
    const {acao,...p}=JSON.parse(o.body);assert.equal(acao,'email_teste');assert.equal(JSON.parse(values.get('shrigma_crm_email_tests_v1')).operations.at(-1).phase,'pending');
    if(mode!=='missing')operations.set(p.idempotency_key,{idempotency_key:p.idempotency_key,actor:'panel:manager',request_payload:p,request_sha256:'a'.repeat(64),request_hash_schema:'postgres-jsonb-text-sha256-v1',state:mode,http_accepted:mode==='accepted',draft_id:p.draft_id,version:p.expected_version,ses:{}});
    throw Error('Synthetic lost response');
   }
   const id=q.get('idempotency_key');return json({contract:'crm_email_test_v1',operation:operations.get(id)||{idempotency_key:id,actor:'panel:manager',state:'missing',request_payload:null}});
  }});
 for(const file of ['whatsapp-template-contract.js','growth-email-contract.js','growth-drafts.js','growth-templates-api.js','growth-template-journal.js','growth-table.js','growth-message-preview.js','growth-brand-state.js','growth-email-test.js','growth-drafts-ui.js'])vm.runInContext(source(file),ctx,{filename:file});
 vm.runInContext(`globalThis.ui=GRU;globalThis.drafts=GR;globalThis.rules=GTA;GRU.render({marca:'${brand}',api:{capabilities:{templates:{draft:true,validate:true,submit:true,submit_email:true},endpoints:{templates:'https://example.invalid/templates'}}}});`,ctx);
 draft=ctx.drafts.novo({id:'local-'+brand,canal:'email',marca:brand,nome:'fixture',assunto:'Olá {{ .Tx.Data.first_name }}',corpo:'<!doctype html><html><head></head><body><p>Conteúdo Felipe</p><a href="https://example.invalid/link">Link</a></body></html>',from_email:GEC.BRANDS[brand].name+' <contato@'+GEC.BRANDS[brand].domain+'>',reply_to:'contato@'+GEC.BRANDS[brand].domain,preheader:'Pré-header fixture',botoes:[]});
 draft.servidor={draft_id:'d_fixture_'+brand,version:1,estado:'publicado',provider_status:'APPROVED',hash:ctx.rules.hash(ctx.drafts.conteudo(draft))};
 if(!storageBlocked)ctx.drafts.guarda(draft);ctx.ui.abrir(draft,draft.id);ctx.ui.contextSaved=JSON.stringify(ctx.ui.contextValue());
 const html=source('growth.html'),change=html.slice(html.indexOf('function trocaMarca(next,'),html.indexOf('window.growthChangeBrand=trocaMarca;'));
 vm.runInContext(`let MARCA='${brand}',AB_WRITE_EPOCH=0;const AB_BUSY=false,$=s=>document.querySelector(s),GCE={contextStatus:()=>({}),preserve:()=>{}},GABF={contextStatus:()=>({}),preserve:()=>{}},GB={state:{}},G={MARCA_CHEIA:{}};function ativaBotao(sel,attr,val){document.querySelectorAll(sel).forEach(b=>b.classList.toggle('ativo',b.dataset[attr]===val));}function salvaPref(){}function gravaHash(){}function render(){GRU.render({...GRU.ctx,marca:MARCA});}${change}window.growthChangeBrand=trocaMarca;globalThis.changeBrand=trocaMarca;`,ctx);
 return {ctx,ui:ctx.ui,draft,document,window,$:s=>document.querySelector(s),calls,values,operations,setKey:k=>currentKey=k,focused:()=>focused};
}

module.exports=setup;
