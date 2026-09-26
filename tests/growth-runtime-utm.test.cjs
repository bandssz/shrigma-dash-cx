'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),G=require('../growth-runtime-utm.js');
function fixture(brand='fish',overrides={}){
 const step={key:'email:carrinho-30min',channel:'email',flow:'carrinho',piece:'carrinho-30min',variant:'',template_id:'60',...overrides};
 const f={key:brand+':carrinho',brand,published_version:6,available_steps:[{...step}]};return {f,step};
}
test('verified cart matrix preserves exact email and WhatsApp campaigns and terms',()=>{
 let count=0;
 for(const brand of ['fish','aristo'])for(const channel of ['email','whatsapp'])for(const time of channel==='email'?['30min','1h','2h','24h','48h']:['30min','24h'])for(const variant of channel==='email'?['']:['a','b']){
  const piece='carrinho-'+time,{f,step}=fixture(brand,{key:channel+':'+piece+(variant?':'+variant:''),channel,piece,variant});const out=G.read(f,step);assert.ok(out);
  assert.deepEqual(out.rows.slice(0,1),[{source:channel==='email'?'email':'whatsapp',medium:'fluxo',campaign:channel==='email'?brand+'-carrinho':brand==='fish'?'fishermans-carrinho':'aristocrata-carrinho',content:piece,...(variant?{term:variant}:{})}]);
  assert.match(out.evidence,/26\/09\/2026, 10:14:17 BRT/);assert.match(out.scope,/não é consulta.*ao vivo/);assert.match(out.scope,/preserva a query anterior/);count++;
 }
 assert.equal(count,18);
 const x=fixture('fish',{key:'whatsapp:carrinho-30min:a',channel:'whatsapp',variant:'a'});assert.deepEqual(G.read(x.f,x.step).rows.map(r=>r.term),['a','b']);assert.match(G.read(x.f,x.step).scope,/Apenas a variante escolhida é enviada/);assert.match(G.read(x.f,x.step).scope,/utm_term=b/);assert.match(G.read(x.f,x.step).sourceExpression,/literal "whatsapp"/);assert.doesNotMatch(G.read(x.f,x.step).sourceExpression,/\{\{/);
});
test('every identity dimension and unique available slot must match; names never infer a rule',()=>{
 const x=fixture();for(const [key,value] of [['key','email:invented'],['channel','whatsapp'],['flow','other'],['piece','other'],['variant','a']])assert.equal(G.read(x.f,{...x.step,[key]:value}),null,key);
 for(const [key,value] of [['brand','aristo'],['brand','olivas'],['key','fish:nps-d0']])assert.equal(G.read({...x.f,[key]:value},x.step),null,key);
 assert.equal(G.read({...x.f,available_steps:[]},x.step),null);assert.equal(G.read({...x.f,available_steps:[x.step,x.step]},x.step),null);
 assert.equal(G.read({...x.f,available_steps:[{...x.step,flow:'other'}]},x.step),null);
 assert.equal(G.read(x.f,{...x.step,brand:'aristo'}),null);assert.equal(G.read({...x.f,available_steps:[{...x.step,brand:'aristo'}]},x.step),null);
 assert.equal(G.read(null,x.step),null);assert.equal(G.read(x.f,null),null);
});
const orders=[
 ['aristo','pedido-recebido','whatsapp:pedido-pago','pedido-pago','28334022989557583',4,'aristo-pos-compra'],
 ['aristo','rastreio','whatsapp:rastreio-criado:28123064554028655','rastreio-criado','1358013072775819',4,'aristocrata-pos-compra'],
 ['aristo','rastreio','whatsapp:rastreio-criado:960254843767524','rastreio-criado','1074482701958396',4,'aristocrata-pos-compra'],
 ['fish','pedido-recebido','whatsapp:pedido-pago','pedido-pago','3544648535693418',5,'fish-pos-compra'],
 ['fish','rastreio','whatsapp:rastreio-criado:4613810428763952','rastreio-criado','1394726182217364',3,'fishermans-pos-compra'],
 ['fish','rastreio','whatsapp:rastreio-criado:966738019748435','rastreio-criado','2041581613228628',3,'fishermans-pos-compra']
];
test('six order rules require exact current template and minimum published version',()=>{
 for(const [brand,journey,key,piece,template_id,version,campaign] of orders){
  const {f,step}=fixture(brand,{key,channel:'whatsapp',flow:'transacional',piece,template_id});f.key=brand+':'+journey;f.published_version=version;
  const out=G.read(f,step);assert.match(out.evidence,/25\/09\/2026/);assert.match(out.scope,/26\/09\/2026/);assert.match(out.evidence,/versão de envio alterada/);assert.equal(out.rows[0].campaign,campaign);assert.equal(out.rows[0].content,piece);assert.equal(out.rows[0].term,undefined);assert.match(out.scope,/valores já recebidos prevalecem/);
  assert.equal(G.read({...f,published_version:version-1},step),null);assert.equal(G.read({...f,published_version:String(version)},step),null);
  assert.equal(G.read(f,{...step,template_id:'999'}),null);assert.equal(G.read({...f,available_steps:[{...step,template_id:'999'}]},step),null);
  assert.match(G.read({...f,published_version:version+20},step).scope,/não é consulta.*ao vivo/);
 }
});
test('PIX describes only verified native payment buttons and cannot invent a tracking tuple',()=>{
 for(const [brand,piece,flow,template_id] of [['fish','pix-15min','transacional','1378177134340410'],['aristo','pix-3min','pix','1132506052775113']]){
  const {f,step}=fixture(brand,{key:'whatsapp:'+piece,channel:'whatsapp',flow,piece,template_id});f.key=brand+':pix';const out=G.read(f,step);
  assert.deepEqual(out.rows,[]);assert.match(out.empty,/order_details/);assert.match(out.scope,/não declara ausência de outros links/);
  assert.equal(G.read(f,{...step,template_id:'old-url-template'}),null);assert.equal(G.read({...f,published_version:5},step),null);
 }
});
test('unknown families remain explicit without copying live template literals',()=>{
 const popup=fixture('aristo',{key:'email:cupom-boas-vindas',flow:'popup',piece:'cupom-boas-vindas',template_id:'22'});popup.f.key='aristo:popup';const p=G.read(popup.f,popup.step);assert.deepEqual(p.rows,[]);assert.match(p.scope,/repassa.*sem acrescentar UTMs/);assert.match(p.sourceExpression,/não comprovada/);
 const carrier=fixture('fish',{key:'whatsapp:rastreio-criado:1047166964972141',channel:'whatsapp',flow:'transacional',piece:'rastreio-criado'});carrier.f.key='fish:rastreio';const c=G.read(carrier.f,carrier.step);assert.deepEqual(c.rows,[]);assert.match(c.scope,/base do botão aprovado/);
 for(const brand of ['fish','aristo']){const x=fixture(brand,{key:'whatsapp:auto-resposta',channel:'whatsapp',flow:'mensagem-automatica',piece:'auto-resposta',kind:'interactive'});x.f.key=brand+':auto-resposta';assert.match(G.read(x.f,x.step).scope,/não comprova ausência/);assert.equal(G.read(x.f,{...x.step,kind:'template'}),null);}
 const nps=fixture('fish',{key:'email:nps-d0',flow:'nps',piece:'nps-d0',template_id:'29'});nps.f.key='fish:nps-d0';assert.equal(G.read(nps.f,nps.step),null);
});
test('reading neither mutates inputs nor allows a returned row to change the catalog',()=>{
 const x=fixture(),before=JSON.stringify(x),out=G.read(x.f,x.step);out.rows[0].source='tampered';assert.equal(G.read(x.f,x.step).rows[0].source,'email');assert.equal(JSON.stringify(x),before);
 assert.deepEqual(Object.keys(out).sort(),['rows','label','evidence','empty','sourceExpression','scope'].sort());
});
