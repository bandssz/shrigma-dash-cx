'use strict';
// Eco de credencial escapado nas pontes READ de públicos e templates (#219,
// agente K2). Uma credencial sintética escrita com \uXXXX no JSON bruto escapa
// de uma varredura só do texto bruto e volta inteira depois do JSON.parse.
// Contrato: a varredura vale para o conteúdo DECODIFICADO (toda string e toda
// chave, em qualquer profundidade); a resposta é recusada (502), o valor nunca
// aparece no retorno, no erro nem em log, e nenhum socket é aberto.
const {test}=require('node:test'),assert=require('node:assert/strict'),net=require('node:net');
const A=require('../services/dashboard-operational/crm-audience-read-bridge.cjs');
const T=require('../services/dashboard-operational/crm-template-read-bridge.cjs');
const NOW=Date.UTC(2026,9,3,12),HOST='dashboard-v24-crm.tazdb8.easypanel.host',ORIGIN='https://'+HOST;
// Sintética, com letras e dígitos (nada real).
const CRED='feedbeef'+'0123456789abcdef'.repeat(3)+'deadc0de',MARK='__ECO__';
const proof=brand=>({userId:brand==='fish'?'11111111-1111-4111-8111-111111111111':'33333333-3333-4333-8333-333333333333',owner:brand+'@oaristocrata.com',lifecycleId:brand==='fish'?'22222222-2222-4222-8222-222222222222':'44444444-4444-4444-8444-444444444444',lifecycleVersion:1,principalId:'dcrm-'+(brand==='fish'?'a':'b').repeat(32),generation:1,expiresAt:NOW+86400000,credentialMac:'d'.repeat(64),slot:'crm-panel-read',caps:['read_content','list_history','submission']});
const esc=(c,upper=false)=>{const h=c.charCodeAt(0).toString(16).padStart(4,'0');return '\\u'+(upper?h.toUpperCase():h);};
// Formas de escrever a credencial no JSON bruto sem que o texto bruto a contenha.
const VARIANTS={
 primeiro:CRED.replace(/^./,c=>esc(c)),
 ultimo:CRED.replace(/.$/,c=>esc(c)),
 meio:CRED.slice(0,31)+esc(CRED[31])+CRED.slice(32),
 // 'd' e 'e' (0x64/0x65) não têm letra no hex; '\u006' + 'X' cobre maiúscula/minúscula onde existe ('é' etc. não é hex de credencial).
 todos_minusculo:[...CRED].map(c=>esc(c)).join(''),
 todos_maiusculo:[...CRED].map(c=>esc(c,true)).join(''),
 alternado:[...CRED].map((c,i)=>i%2?esc(c,i%4===1):c).join(''),
 credencial_maiuscula:CRED.toUpperCase().replace(/^./,c=>esc(c,true))
};
function guard(){
 const sockets=[],logs=[],orig={connect:net.Socket.prototype.connect,log:console.log,error:console.error,warn:console.warn,info:console.info,write:process.stderr.write};
 net.Socket.prototype.connect=function(...a){sockets.push(a);throw new Error('socket proibido');};
 for(const k of ['log','error','warn','info'])console[k]=(...a)=>{logs.push(a.map(String).join(' '));};
 return {sockets,logs,restore(){net.Socket.prototype.connect=orig.connect;for(const k of ['log','error','warn','info'])console[k]=orig[k];}};
}
function respond(raw){return async()=>new Response(raw,{status:200,headers:{'content-type':'application/json; charset=utf-8'}});}
const authForBrand=brand=>({managedCrmReadAuthorization(ctx){assert.equal(ctx.brand,brand);return proof(brand);},getUpstreamCredential(ctx){assert.equal(ctx.brand,brand);return CRED;}});
function audience(raw){const brand='fish',auth=authForBrand(brand),b=A.createAudienceReadBridge({auth,upstreams:{'audience-read':new URL(A.DESTINATIONS['audience-read'])},enabled:true},{fetchImpl:respond(raw),now:()=>NOW});return q=>b.read({context:{method:'GET',host:HOST,brand},route:'segments',method:'GET',query:new URLSearchParams(q),origin:ORIGIN});}
function template(raw,brand='aristo'){const auth=authForBrand(brand),b=T.createTemplateReadBridge({auth,upstreams:{'template-read':new URL(T.DESTINATIONS['template-read'])},enabled:true},{fetchImpl:respond(raw),now:()=>NOW});return q=>b.read({context:{method:'GET',host:HOST,brand},route:'templates',method:'GET',query:new URLSearchParams(q),origin:ORIGIN});}
const templateFish=raw=>template(raw,'fish');
// Corpos válidos com MARK nos pontos onde a credencial é injetada.
const fresh={contract:'crm-audience-read-freshness-v1',catalog_refreshed_at:'2026-10-03T11:59:00.000Z',catalog_expires_at:'2026-10-03T12:03:00.000Z',catalog_age_seconds:60,read_at:'2026-10-03T12:00:00.000Z',current:true,stale:false,coverage:'unconfirmed',schedule_proof:false};
const lists=(name)=>({brand:'fish',base_list_id:17,lists:[{id:17,brand:'fish',name,available:true}],freshness:fresh});
const segs=(fields,defExtra)=>({segments:[{id:'33333333-3333-4333-8333-333333333333',brand:'fish',name:'Seg',definition:{brand:'fish',name:'Seg',schema_version:'crm-audience-v2',...defExtra},version:1,archived:false,created_at:fresh.read_at,updated_at:fresh.read_at,updated_by:'panel:x',semantic_context:{currency:'BRL',timezone:'America/Sao_Paulo',current:true}}],
 limit:50,offset:0,catalog:{brand:'fish',current:true,coverage:'unconfirmed',catalog_hash:'f'.repeat(64),checked_at:fresh.read_at,lists:[],fields,products:[],origins:[]},capabilities:{draft:false,count:false,send:false},freshness:fresh});
const AT='2026-10-03T12:00:00.000Z',H='e'.repeat(64);
const tpl=(over={})=>({key:'email.template.1',brand:'aristo',channel:'email',id:'1',name:'Template 1',type:'tx',draft_id:null,components:{subject:'Oi',body_html:'<p>x</p>',altbody:null},content_available:true,content_hash:H,updated_at:AT,...over});
const tlist=items=>({contract:'crm-template-read-v1',brand:'aristo',channel:'email',templates:items,offset:0,limit:20,total:items.length,next_offset:null,coverage:'registered_email_only',consultado_em:AT,schedule_proof:false});
const hist=detail=>({contract:'crm-template-history-read-v1',brand:'fish',draft_id:'d_1',events:[{at:AT,who:'gestor',action:'validate',from_version:null,to_version:2,result:'ok',detail}],truncated:false,read_at:AT});
// Locais: valor simples, chave de objeto e array aninhado.
const PLACES=[
 ['públicos: valor (name da lista)',audience,{acao:'publicos_listas',brand:'fish'},()=>lists(MARK)],
 ['públicos: chave dentro de definition',audience,{acao:'segmentos_listar',brand:'fish',offset:'0',limit:'50'},()=>segs([],{[MARK]:1})],
 ['públicos: array aninhado em catalog.fields',audience,{acao:'segmentos_listar',brand:'fish',offset:'0',limit:'50'},()=>segs([['a',[{x:['y',MARK]}]]],{})],
 ['templates: valor (name)',template,{acao:'listar',marca:'aristo'},()=>tlist([tpl({name:'Oi '+MARK})])],
 ['templates: valor (subject)',template,{acao:'listar',marca:'aristo'},()=>tlist([tpl({components:{subject:MARK,body_html:'<p>x</p>',altbody:null}})])],
 ['templates: valor (detail do histórico)',templateFish,{acao:'historico',marca:'fish',draft_id:'d_1'},()=>hist(MARK)],
 ['templates: chave de objeto',template,{acao:'listar',marca:'aristo'},()=>({...tlist([tpl()]),[MARK]:1})]
];
const leaks=s=>typeof s==='string'&&(s.includes(CRED)||s.toLowerCase().includes(CRED));

test('controle: os corpos de prova são aceitos quando o marcador é inofensivo',async()=>{
 for(const [name,make,q,body]of PLACES){
  if(name.includes('chave de objeto'))continue; // chave extra no topo já viola o formato
  const r=await make(JSON.stringify(body()).split(MARK).join('inofensivo'))(q);assert.equal(r.status,200,name);
 }
});

for(const [label,bridge]of [['públicos',audience],['templates',template]])
test(label+': credencial escapada com \\uXXXX em qualquer posição, caixa, chave, valor ou array aninhado: 502, sem eco, sem log, sem socket',async()=>{
 const g=guard();
 try{
  for(const [name,make,q,body]of PLACES.filter(p=>bridge===audience?p[1]===audience:p[1]===template||p[1]===templateFish))for(const [vname,v]of Object.entries(VARIANTS)){
   const raw=JSON.stringify(body()).split(MARK).join(v);
   assert.equal(raw.includes(CRED),false,'o texto bruto não contém a credencial literal: '+vname);
   assert.equal(JSON.stringify(JSON.parse(raw)).toLowerCase().includes(CRED),true,'após o parse a credencial volta: '+vname);
   let out,err;try{out=await make(raw)(q);}catch(e){err=e;}
   assert.ok(err,`${name} / ${vname}: deveria recusar, retornou ${out&&out.status}`);
   assert.equal(err.status,502,`${name} / ${vname}`);assert.match(err.code,/_READ_RESPONSE_DENIED$/);
   for(const s of [err.message,err.code,String(err.stack),JSON.stringify(err),JSON.stringify(out??null)])assert.equal(leaks(s),false,`${name} / ${vname}: valor vazou`);
  }
  assert.equal(g.logs.some(leaks),false,'nada da credencial em log');assert.equal(g.sockets.length,0,'zero sockets');
 }finally{g.restore();}
});
