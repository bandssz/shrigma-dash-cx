'use strict';
const assert=require('node:assert/strict'),{webcrypto}=require('node:crypto');
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const Client=require('../growth-segment-client.js'),Contract=Client.Contract,Audience=require('../n8n/growth/segment-audience-contract.js');
const api={capabilities:{segments:{contract_version:Client.VERSION,brands:['fish','aristo'],read:true,save:true,count:true,operation:true},endpoints:{segments:'https://segments.example.test/api'}}};
const definition=(brand='fish',name='Público de exemplo')=>({schema_version:Client.VERSION,brand,name,rule:{op:'and',rules:[{op:'in_list',list_id:brand==='fish'?11:21},{op:'in_list',list_id:brand==='fish'?12:22}]}});
function fixture({version=Client.VERSION}={}){
 const runtimeApi=structuredClone(api);runtimeApi.capabilities.segments.contract_version=version;
 const normalize=d=>(d.schema_version===Audience.VERSION?Audience:Contract).normalize(d);
 const store=new Map(),calls=[],rows=new Map(),receipts=new Map(),locks=require('./campaign-lock-fixture.cjs')();let next=1;
 const control={lose:false,unconfirmed:false,malformed:false,countUnknown:false,countMismatch:false,failCurrent:false,before:null,catalogPatch:{}};
 const storage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
 const catalog=brand=>({brand,current:true,lists:[{id:brand==='fish'?11:21,brand,name:'Lista principal '+brand,available:true},{id:brand==='fish'?12:22,brand,name:'Clientes '+brand,available:true}],...(version===Audience.VERSION?{catalog_hash:'a'.repeat(64),fields:Object.keys(Audience.FIELDS).map(key=>({key,available:true})),products:[{id:'gid://shopify/Product/'+(brand==='fish'?101:201),brand,name:'Produto '+brand,available:true}],origins:['popup','vip_alma','vip_desodorante'].map(key=>({key,brand,name:{popup:'Popup confirmado',vip_alma:'VIP Alma da Roça',vip_desodorante:'VIP Desodorante'}[key],available:key==='popup'||brand==='aristo'})),currency:'BRL'}:{}),...control.catalogPatch});
 async function fetch(url,init){const u=new URL(url),body=init.method==='POST'?JSON.parse(init.body):Object.fromEntries(u.searchParams);const actor=init.headers.Authorization;assert.ok(actor?.startsWith('Bearer '));assert.equal(body.actor,undefined);assert.equal(body.caps,undefined);assert.equal(body.k,undefined);assert.equal(u.searchParams.has('k'),false);calls.push({method:init.method,body,actor});if(control.before)await control.before(body);
  const brand=body.brand,op=body.acao;let result;
  if(op==='segmentos_listar'){const all=[...rows.values()].filter(r=>r.brand===brand),limit=Number(body.limit),offset=Number(body.offset);result={status:200,body:{segments:all.slice(offset,offset+limit),limit,offset,capabilities:{draft:true,count:true,send:false},catalog:catalog(brand)}};}
  else if(op==='segmento_obter'){const row=rows.get(body.id);result=control.failCurrent?{status:503,body:{error:'SEGMENT_SERVICE_UNAVAILABLE'}}:row&&row.brand===brand?{status:200,body:{segment:row}}:{status:404,body:{error:'SEGMENT_NOT_FOUND'}};}
  else if(op==='segmento_operacao')result=control.unconfirmed?{status:404,body:{error:'SEGMENT_OPERATION_UNCONFIRMED'}}:receipts.get(actor+':'+body.idempotency_key)||{status:404,body:{error:'SEGMENT_OPERATION_UNCONFIRMED'}};
  else if(op==='segmento_contar'){const row=rows.get(body.id),d=body.definition||row.definition;result={status:200,body:{source_confirmed:!control.countUnknown,eligible_count:control.countUnknown?null:7,checked_at:new Date().toISOString(),definition:normalize(d),definition_hash:'a'.repeat(64),transport_supported:false,segment_id:body.id||null,version:body.expected_version||null}};if(control.countMismatch)result.body.definition.brand=brand==='fish'?'aristo':'fish';}
  else{const previous=rows.get(body.id);if(body.id&&(!previous||previous.version!==body.expected_version))result={status:409,body:{error:'SEGMENT_VERSION_CONFLICT',current_version:previous?.version}};
   else{const id=body.id||'11111111-1111-4111-8111-'+String(next++).padStart(12,'0'),d=normalize(body.definition||previous.definition),row={id,brand,name:d.name,definition:d,version:(previous?.version||0)+1,archived:op==='segmento_arquivar',created_at:new Date().toISOString(),updated_at:new Date().toISOString(),updated_by:'fixture',...(version===Audience.VERSION?{semantic_context:{currency:'BRL',timezone:'America/Sao_Paulo',current:true}}:{})};rows.set(id,row);result={status:op==='segmento_criar'?201:200,body:{segment:row,transport_supported:false}};}
   receipts.set(actor+':'+body.idempotency_key,structuredClone(result));if(control.lose)throw Error('synthetic response loss');if(control.malformed)result={status:200,body:{ok:true}};
  }
  const response=structuredClone(result);return {status:response.status,json:async()=>response.body};
 }
 const create=(brand='fish',key=()=> 'synthetic-actor-one',opts={})=>Client.create({api:runtimeApi,brand,key,storage,fetch,locks,...opts});
 return {api:runtimeApi,store,storage,calls,rows,receipts,locks,control,fetch,catalog,create};
}
module.exports={fixture,definition,api,Client};
