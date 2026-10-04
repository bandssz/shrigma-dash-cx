'use strict';
// Marca da miniatura (thumb_url) e de qualquer URL de arquivo no item do
// validador de mídia (#219, agente K2). Contrato:
//  - item canônico: url/thumb_url com nome de OUTRA marca (inclusive olivas)
//    recusa a página inteira (MEDIA_READ_FOREIGN_BRAND), como o filename;
//  - item canônico com miniatura sem marca (legado): recusa a página
//    (MEDIA_READ_THUMB_DENIED) — o legado nunca vira da marca pela miniatura;
//  - item legado com url/miniatura de outra marca: sai da lista
//    (excluded_foreign_prefix), sem atribuir marca ao legado;
//  - miniatura da própria marca segue aceita.
const {test}=require('node:test'),assert=require('node:assert/strict');
const V=require('../services/dashboard-operational/crm-media-read-validator.cjs');
const M=require('../services/crm-campaign/media.cjs');
const ORIGIN='https://email.shrigma.com.br',OP='11111111-1111-4111-8111-111111111111',OP2='22222222-2222-4222-8222-222222222222';
const canon=(brand,op=OP,n='a')=>M.canonicalFilename(brand,op,n.repeat(64),'png');
const up=name=>ORIGIN+'/uploads/'+encodeURIComponent(name);
const item=(filename,id,over={})=>({id,filename,url:up(filename),thumb_url:null,content_type:'image/png',width:600,height:300,created_at:'2026-10-01T10:00:00Z',...over});
const body=(brand,items)=>({contract:'crm-media-v1',brand,items,total:items.length,page:1,per_page:24,next_page:null});
const run=b=>V.validateMediaLibraryResponse(JSON.parse(JSON.stringify(b)),{brand:b.brand,page:1,per_page:24});
const denied=(b,code,msg)=>assert.throws(()=>run(b),e=>e instanceof V.MediaReadValidationError&&e.status===502&&e.code===code,msg);

test('miniatura da própria marca segue aceita nas duas marcas',()=>{
 for(const brand of ['fish','aristo']){
  const f=canon(brand),r=run(body(brand,[item(f,1,{thumb_url:up('thumb_'+f)})]));
  assert.deepEqual(r.body.items.map(i=>[i.id,i.legacy,i.thumb_url]),[[1,false,up('thumb_'+f)]]);assert.equal(r.summary.brand_items,1);
 }
});

test('item canônico com miniatura de outra marca recusa a página: fish→aristo e aristo→fish (e olivas)',()=>{
 for(const [brand,other]of [['fish','aristo'],['aristo','fish']]){
  const own=canon(brand),foreign=canon(other,OP2,'b');
  denied(body(brand,[item(own,1,{thumb_url:up('thumb_'+foreign)})]),'MEDIA_READ_FOREIGN_BRAND',brand+': thumb_ de '+other);
  denied(body(brand,[item(own,1,{thumb_url:up(foreign)})]),'MEDIA_READ_FOREIGN_BRAND',brand+': miniatura = arquivo canônico de '+other);
  denied(body(brand,[item(own,1,{thumb_url:up('thumb_'+foreign.toUpperCase())})]),'MEDIA_READ_FOREIGN_BRAND',brand+': caixa alta');
  denied(body(brand,[item(own,1,{thumb_url:up('thumb_crm-olivas-x.png')})]),'MEDIA_READ_FOREIGN_BRAND',brand+': olivas');
  // Mistura: nome da própria marca e de outra no mesmo arquivo.
  denied(body(brand,[item(own,1,{thumb_url:up('thumb_'+own.replace('.png','')+'_'+foreign)})]),'MEDIA_READ_FOREIGN_BRAND',brand+': marca mista');
  // A página com um item bom e um ruim cai inteira.
  denied(body(brand,[item(canon(brand,OP2,'c'),2),item(own,1,{thumb_url:up('thumb_'+foreign)})]),'MEDIA_READ_FOREIGN_BRAND');
 }
});

test('item canônico com miniatura legada (sem marca) recusa a página; o legado não vira da marca',()=>{
 for(const brand of ['fish','aristo']){
  denied(body(brand,[item(canon(brand),1,{thumb_url:up('thumb_banner-antigo.png')})]),'MEDIA_READ_THUMB_DENIED',brand);
  denied(body(brand,[item(canon(brand),1,{thumb_url:up('logo.png')})]),'MEDIA_READ_THUMB_DENIED',brand);
 }
});

test('item legado com miniatura de outra marca sai da lista nas duas direções; sem marca ou da própria marca continua legado',()=>{
 for(const [brand,other]of [['fish','aristo'],['aristo','fish']]){
  const items=[item('banner-antigo.png',1,{thumb_url:up('thumb_'+canon(other))}),item('promo.png',2,{thumb_url:up('thumb_promo.png')}),
   item('selo.png',3,{thumb_url:up('thumb_'+canon(brand))}),item('logo.png',4,{thumb_url:up('thumb_crm-olivas-logo.png')}),item('capa.png',5)];
  const r=run(body(brand,items));
  assert.deepEqual(r.body.items.map(i=>[i.id,i.legacy]),[[2,true],[3,true],[5,true]],brand);
  assert.deepEqual({...r.summary},{brand_items:0,legacy_items:3,excluded_legacy:0,excluded_foreign_prefix:2,excluded_irregular:0},brand);
 }
});
