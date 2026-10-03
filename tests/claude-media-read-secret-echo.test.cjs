'use strict';
// Eco de chave sintética no validador de mídia (porte do fix da candidata #214,
// crm-media-read-validator.cjs sha256 02daa36a…fe0). A página inteira é recusada
// (MEDIA_READ_SECRET_ECHO) quando a chave aparece:
//  - com caixa diferente em qualquer ponto do corpo;
//  - só depois de decodificar o nome de arquivo da url/miniatura (%XX), inclusive
//    em item que o filtro descartaria (legado de outra marca) — a recusa vem antes
//    do filtro e nada do corpo volta.
const {test}=require('node:test'),assert=require('node:assert/strict');
const V=require('../services/dashboard-operational/crm-media-read-validator.cjs');
const M=require('../services/crm-campaign/media.cjs');
const ORIGIN='https://email.shrigma.com.br',OP='11111111-1111-4111-8111-111111111111',SECRET='c'.repeat(64);
const canon=(brand,n='a')=>M.canonicalFilename(brand,OP,n.repeat(64),'png');
const up=name=>ORIGIN+'/uploads/'+encodeURIComponent(name);
// Codifica TODOS os caracteres: no JSON bruto a chave não aparece, só após decodificar.
const upAll=name=>ORIGIN+'/uploads/'+[...Buffer.from(name,'utf8')].map(b=>'%'+b.toString(16).toUpperCase().padStart(2,'0')).join('');
const item=(filename,id,over={})=>({id,filename,url:up(filename),thumb_url:null,content_type:'image/png',width:600,height:300,created_at:'2026-10-01T10:00:00Z',...over});
const body=(brand,items)=>({contract:'crm-media-v1',brand,items,total:items.length,page:1,per_page:24,next_page:null});
const run=(b,secrets=[SECRET])=>V.validateMediaLibraryResponse(JSON.parse(JSON.stringify(b)),{brand:b.brand,page:1,per_page:24,secrets});
const echo=(b,msg)=>{assert.throws(()=>run(b),e=>e instanceof V.MediaReadValidationError&&e.status===502&&e.code==='MEDIA_READ_SECRET_ECHO'&&!String(e.message).toLowerCase().includes(SECRET),msg);};

test('controle: sem eco a página passa nas duas marcas; nome legado de outra marca sai do filtro normalmente',()=>{
 for(const [brand,other] of [['fish','aristo'],['aristo','fish']]){
  const r=run(body(brand,[item(canon(brand),1),item('banner.png',2),item('crm-'+other+'-x.png',3)]));
  assert.deepEqual(r.body.items.map(i=>[i.id,i.legacy]),[[1,false],[2,true]]);assert.equal(r.summary.excluded_foreign_prefix,1);
 }
});

test('chave com caixa diferente em filename, url, miniatura ou data recusa a página inteira',()=>{
 const U=SECRET.toUpperCase(),mixed=SECRET.slice(0,32)+U.slice(32);
 for(const brand of ['fish','aristo']){
  const ok=item(canon(brand),1);
  echo(body(brand,[ok,item('banner-'+U+'.png',2)]),'filename em maiúsculas');
  echo(body(brand,[ok,item('x.png',2,{url:up('x'+mixed+'.png')})]),'url com caixa mista');
  echo(body(brand,[ok,item('x.png',2,{thumb_url:up('thumb_'+U+'.png')})]),'miniatura em maiúsculas');
  echo(body(brand,[ok,item('x.png',2,{created_at:U})]),'campo fora de arquivo');
 }
});

test('chave só visível depois de decodificar o nome da url ou da miniatura recusa antes do filtro (inclusive item que seria descartado)',()=>{
 for(const [brand,other] of [['fish','aristo'],['aristo','fish']]){
  const ok=item(canon(brand),1),hidden='x'+SECRET+'.png';
  // Sanidade: no texto bruto a chave não aparece.
  assert.equal(JSON.stringify(item('x.png',2,{url:upAll(hidden)})).toLowerCase().includes(SECRET),false);
  echo(body(brand,[ok,item('x.png',2,{url:upAll(hidden)})]),'url codificada');
  echo(body(brand,[ok,item('x.png',2,{thumb_url:upAll('thumb_'+hidden)})]),'miniatura codificada');
  echo(body(brand,[ok,item('x.png',2,{url:upAll('x'+SECRET.toUpperCase()+'.png')})]),'url codificada e maiúscula');
  // Item legado de outra marca (o filtro o descartaria): a chave decodificada ainda recusa tudo.
  const dropped=item('crm-'+other+'-x.png',2);assert.equal(run(body(brand,[ok,dropped])).summary.excluded_foreign_prefix,1,'sem eco, este item sai no filtro');
  echo(body(brand,[ok,{...dropped,url:upAll('crm-'+other+'-'+SECRET+'.png')}]),'item que seria filtrado');
 }
});

test('lista de segredos vazia mantém o comportamento sem varredura de eco',()=>{
 const r=run(body('fish',[item(canon('fish'),1),item('banner-'+SECRET.toUpperCase()+'.png',2)]),[]);
 assert.equal(r.body.items.length,2);
});
