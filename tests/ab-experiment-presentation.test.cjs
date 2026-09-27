'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{parseHTML}=require('linkedom');
const UI=require('../growth-ab-experiment-ui.js');
test('both brands guide the empty state and show recovery/actions only when relevant without submitting',async()=>{
 for(const brand of ['fish','aristo']){
  const {document,window}=parseHTML('<html><body><div id="root"></div></body></html>');
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return [...this.options].find(o=>o.hasAttribute('selected'))?.value||'';},set(v){for(const o of this.options)o.toggleAttribute('selected',o.value===String(v));}});
  let pending=null,campaignPending=false,posts=0;const values=new Map(),queries=[];
  const entry={test_id:'00000000-0000-4000-8000-000000000001',state:'prepared',protocol:{name:'Comparar assunto',hypothesis:'Assunto mais curto',rule:{window_hours:24,minimum_per_arm:100,minimum_effect_pp:1.5}},arms:[{arm:'a',allocated:100},{arm:'b',allocated:100}]};
  const ui=UI.mount({element:document.querySelector('#root'),brand,storage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},client:{inspect:()=>({pending}),read:async method=>{queries.push(method);return method==='capabilities'?{enabled:true,configure:true,review:true}:method==='list'?{experiments:[]}:method==='campaigns'?{campaigns:[]}:{experiment:entry,review:null,result:null};},mutate:()=>{posts++;throw Error('No submission permitted');}},reviewer:{pending:()=>campaignPending,review:async()=>{}}});
  try{
   await ui.ready;const q=s=>document.querySelector(s);
   assert.match(q('[data-abx-empty]').textContent,/Prepare duas campanhas/);assert.equal(q('[data-abx-empty]').hidden,false);
   for(const sel of ['[data-abx-recover]','[data-abx-campaign-recover]','[data-abx-actions]','[data-abx-recent]'])assert.equal(q(sel).hidden,true);
   assert.match(q('[data-abx-new]').textContent,/Novo teste A\/B/);assert.equal(posts,0);
   ui.state.selected=entry;await ui.refresh();assert.equal(q('[data-abx-empty]').hidden,true);assert.equal(q('[data-abx-actions]').hidden,false);
   assert.match(q('[data-abx-detail]').textContent,/diferença mínima 1,5 p.p./);assert.match(q('[data-abx-detail] [title]').title,/p < 0,05/);
   pending={request_payload:{brand}};campaignPending=true;await ui.refresh();
   assert.equal(q('[data-abx-recover]').hidden,false);assert.equal(q('[data-abx-campaign-recover]').hidden,false);assert.equal(posts,0);
   assert.ok(queries.every(m=>['capabilities','list','campaigns','get'].includes(m)));
  }finally{ui.destroy();}
 }
});
