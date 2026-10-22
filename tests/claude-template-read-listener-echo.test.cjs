'use strict';
// Revisão 5974202110 (P2): a saída do listener recusa a credencial do pedido
// também codificada — base64/base64url (do texto ou dos 32 bytes, em qualquer
// alinhamento dentro de um bloco maior), percent encoding (inclusive duplo),
// entidades HTML e qualquer caixa — em toda string e chave depois do parse.
// Mesmo contrato por marca e mesmo teto de bytes. Transação sintética.
const {test}=require('node:test'),assert=require('node:assert/strict');
const S=require('../services/crm-template-read/store.cjs');
const KEY='0123456789abcdef'.repeat(4),AUTH='Bearer '+KEY,AT='2026-10-03T12:00:00Z',H='e'.repeat(64);
const L=[['acao','listar'],['brand','fish'],['channel','email'],['offset','0'],['limit','20']];
const tpl=(over={})=>({key:'email.template.1',brand:'fish',channel:'email',id:'1',name:'T 1',type:'tx',draft_id:null,components:{subject:'Oi',body_html:'<p>x</p>',altbody:null},content_available:true,content_hash:H,updated_at:AT,...over});
const page=items=>({contract:'crm-template-read-v1',brand:'fish',channel:'email',templates:items,offset:0,limit:20,total:items.length,next_offset:null,coverage:'registered_email_only',consultado_em:AT,schedule_proof:false});
function fakeTx(body){return async work=>work({query:async text=>{
 if(S.SQL.attest&&text===S.SQL.attest)return {rows:S.ATTEST_ROWS.map(x=>({...x}))};
 return {rows:[{r:JSON.parse(JSON.stringify(body))}]};}});}
const run=body=>S.createTemplateReadStore({transaction:fakeTx(body)}).handle({authorization:AUTH,pairs:L});
const html=s=>page([tpl({components:{subject:'Oi',body_html:'<p>'+s+'</p>',altbody:null}})]);
const b64=(x,url=false)=>Buffer.from(x).toString(url?'base64url':'base64');
const pct=(x,upper=true)=>[...Buffer.from(x)].map(b=>'%'+b.toString(16).padStart(2,'0')[upper?'toUpperCase':'toLowerCase']()).join('');

test('controle: corpo válido sem a credencial passa, inclusive base64 e percent de outro texto',async()=>{
 for(const s of ['texto normal',b64('outro texto qualquer bem comprido 1234567890'),pct('https://exemplo.invalid/a b'),'data:image/png;base64,'+b64(Buffer.alloc(120,7)),'&#98;&#99;'])
  assert.equal((await run(html(s))).status,200,s.slice(0,30));
});

test('credencial em texto com outra caixa ou como nome de chave depois do parse: 502 sem corpo',async()=>{
 for(const body of [html(KEY.toUpperCase()),html(KEY.slice(0,20)+KEY.slice(20).toUpperCase()),page([tpl({name:'x'+KEY})])]){
  const r=await run(body);assert.equal(r.status,502);assert.deepEqual(r.body,{error:'TEMPLATE_READ_RESPONSE_DENIED'});assert.equal(r.text,undefined);
 }
});

test('credencial codificada em base64/base64url (texto e bytes, qualquer alinhamento) ou percent/entidade: página inteira recusada',async()=>{
 const raw=Buffer.from(KEY,'hex');
 const variants={
  base64_texto:b64(KEY),base64url_texto:b64(KEY,true),base64_bytes:raw.toString('base64'),base64url_bytes:raw.toString('base64url'),
  base64_texto_sem_padding:b64(KEY).replace(/=+$/,''),
  base64_embutido_1:b64('x'+KEY+'y'),base64_embutido_2:b64('xy'+KEY+'z'),base64_embutido_3:b64('<a href="?k='+KEY+'">'),
  base64_bytes_embutido:Buffer.concat([Buffer.from([1,2]),raw,Buffer.from([3])]).toString('base64'),
  data_uri:'data:text/plain;base64,'+b64('chave='+KEY),
  percent_maiusculo:pct(KEY),percent_minusculo:pct(KEY,false),percent_parcial:KEY.slice(0,10)+pct(KEY.slice(10)),percent_duplo:pct(pct(KEY)),
  percent_de_base64:pct(b64(KEY)),base64_de_percent:b64(pct(KEY)),
  entidade_decimal:[...KEY].map(c=>'&#'+c.charCodeAt(0)+';').join(''),entidade_hex:[...KEY].map(c=>'&#x'+c.charCodeAt(0).toString(16)+';').join('')
 };
 for(const [name,s] of Object.entries(variants)){
  assert.equal(s.toLowerCase().includes(KEY),false,name+': o texto bruto não contém a chave');
  const r=await run(html(s));assert.equal(r.status,502,name);assert.deepEqual(r.body,{error:'TEMPLATE_READ_RESPONSE_DENIED'},name);
 }
 // No assunto e no nome também.
 assert.equal((await run(page([tpl({components:{subject:b64(KEY),body_html:'<p>x</p>',altbody:null}})]))).status,502);
 assert.equal((await run(page([tpl({name:pct(KEY)})]))).status,502);
});

test('contrato por marca e teto de bytes continuam: outra marca e corpo acima do limite seguem 502',async()=>{
 assert.equal((await run(page([tpl({brand:'aristo'})]))).status,502);
 assert.equal((await run(html('x'.repeat(400001)))).status,502);
});

test('regressão: base64 encadeado dos 32 bytes da credencial recusa até os três níveis declarados',async()=>{
 let encoded=Buffer.from(KEY,'hex').toString('base64');
 for(let depth=1;depth<=3;depth++){
  const r=await run(html(encoded));
  assert.equal(r.status,502,'base64 nível '+depth);
  assert.deepEqual(r.body,{error:'TEMPLATE_READ_RESPONSE_DENIED'});
  assert.equal(r.text,undefined);
  encoded=b64(encoded);
 }
});

test('regressão: entidade HTML hexadecimal com X maiúsculo também recusa a credencial',async()=>{
 const encoded=[...KEY].map(c=>'&#X'+c.charCodeAt(0).toString(16)+';').join('');
 const r=await run(html(encoded));
 assert.equal(r.status,502);
 assert.deepEqual(r.body,{error:'TEMPLATE_READ_RESPONSE_DENIED'});
 assert.equal(r.text,undefined);
});


test('regressão: percent encoding dos 32 bytes brutos da credencial, inclusive duplo e encadeado, não sai em valores ou chaves',async()=>{
 const raw=Buffer.from(KEY,'hex');
 const variants={
  percent_bytes_maiusculo:pct(raw),percent_bytes_minusculo:pct(raw,false),
  percent_bytes_duplo:pct(pct(raw)),base64_de_percent_bytes:b64(pct(raw)),
  percent_de_base64_bytes:pct(raw.toString('base64')),
  percent_bytes_parcial:raw.subarray(0,4).toString('latin1')+pct(raw.subarray(4))
 };
 for(const [name,s] of Object.entries(variants)){
  assert.equal(s.toLowerCase().includes(KEY),false,name+': bruto sem chave hexadecimal');
  assert.equal(S.echoes({[s]:'valor seguro'},KEY),true,name+': nome de chave parseado');
  for(const body of [html(s),page([tpl({components:{subject:s,body_html:'<p>x</p>',altbody:null}})])]){
   const r=await run(body);
   assert.equal(r.status,502,name);
   assert.deepEqual(r.body,{error:'TEMPLATE_READ_RESPONSE_DENIED'});
   assert.equal(r.text,undefined);
  }
 }
});
