/* Shadow lifecycle vocabulary. Validation never grants permission or executes a command. */
'use strict';
const {createHash}=require('node:crypto');
const VERSION='journey_graph_lifecycle_v1',SCOPE='cart_first_email_v1',ENABLED=false;
const MAX_VERSION=2147483646,MAX_AGE_MS=30000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const MESSAGES=Object.freeze({
 GRAPH_LIFECYCLE_INPUT:'Confira a marca, a jornada, a versão e os campos desta operação.',
 GRAPH_LIFECYCLE_ACCESS:'Seu acesso não permite conferir esta revisão. Entre novamente com o acesso de gestor CRM.',
 GRAPH_LIFECYCLE_VERSION:'A jornada mudou. Reabra a versão atual e confira novamente.',
 GRAPH_LIFECYCLE_READ_UNCONFIRMED:'Não foi possível confirmar uma leitura atual. Nenhuma alteração foi realizada.',
 GRAPH_LIFECYCLE_DRIFT:'A jornada, o catálogo ou a mensagem mudou durante a conferência. Confira novamente.',
 GRAPH_LIFECYCLE_CORRUPT:'A revisão recebida não corresponde ao conteúdo salvo. Preserve o rascunho e atualize a leitura.',
 GRAPH_LIFECYCLE_TIMEOUT:'A conferência não terminou no prazo. Nenhuma alteração foi realizada.',
 GRAPH_LIFECYCLE_ADAPTER:'A conferência operacional não está configurada.'
});
function fail(code){return Object.assign(Error(MESSAGES[code]||MESSAGES.GRAPH_LIFECYCLE_READ_UNCONFIRMED),{code:Object.hasOwn(MESSAGES,code)?code:'GRAPH_LIFECYCLE_READ_UNCONFIRMED'});}
function copy(value,maxBytes=524288){
 const seen=new Set();let count=0;
 function check(v,depth){
  if(++count>25000||depth>24)throw fail('GRAPH_LIFECYCLE_INPUT');
  if(v===null||typeof v==='boolean'||typeof v==='string'||typeof v==='number'&&Number.isFinite(v))return;
  if(!v||typeof v!=='object'||seen.has(v)||Object.getOwnPropertySymbols(v).length||!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw fail('GRAPH_LIFECYCLE_INPUT');
  if(Array.isArray(v)&&(Object.keys(v).length!==v.length||Object.keys(v).some((k,i)=>k!==String(i))))throw fail('GRAPH_LIFECYCLE_INPUT');
  seen.add(v);for(const [key,d]of Object.entries(Object.getOwnPropertyDescriptors(v))){if(Array.isArray(v)&&key==='length')continue;if(!d.enumerable||!Object.hasOwn(d,'value')||['__proto__','constructor','prototype'].includes(key))throw fail('GRAPH_LIFECYCLE_INPUT');check(d.value,depth+1);}seen.delete(v);
 }
 check(value,0);const text=JSON.stringify(value);if(Buffer.byteLength(text)>maxBytes)throw fail('GRAPH_LIFECYCLE_INPUT');return JSON.parse(text);
}
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
const digest=x=>createHash('sha256').update(canonical(copy(x))).digest('hex');
const exact=(x,keys)=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const version=x=>Number.isSafeInteger(x)&&x>=1&&x<MAX_VERSION;
function freeze(x){if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;}
const FIELDS=freeze({
 review:['journey_id','expected_version'],status:['journey_id'],operation:['request_id'],
 prepare:['journey_id','expected_version','request_id','review_hash','confirm'],
 publish:['journey_id','expected_version','request_id','prepared_revision','prepared_hash','confirm'],
 activate:['journey_id','expected_version','request_id','published_revision','publication_hash','admission_review_hash','confirm'],
 pause:['journey_id','expected_version','request_id','published_revision','confirm']
});
const CONFIRM=Object.freeze({prepare:'preparar',publish:'publicar',activate:'ativar',pause:'pausar'});
const PERMISSIONS=freeze({review:['read_content','validate'],status:['read_content'],operation:['read_content'],prepare:['read_content','submit'],publish:['read_content','submit'],activate:['read_content','submit'],pause:['read_content','submit']});
function validateRequest(value){
 const p=copy(value,8192);
 if(!p||typeof p!=='object'||Array.isArray(p)||typeof p.action!=='string'||!Object.hasOwn(FIELDS,p.action)||!exact(p,['action','brand',...FIELDS[p.action]])||!['fish','aristo'].includes(p.brand))throw fail('GRAPH_LIFECYCLE_INPUT');
 for(const key of ['journey_id','request_id'])if(Object.hasOwn(p,key)&&(typeof p[key]!=='string'||!UUID.test(p[key])))throw fail('GRAPH_LIFECYCLE_INPUT');
 for(const key of ['expected_version','prepared_revision','published_revision'])if(Object.hasOwn(p,key)&&!version(p[key]))throw fail('GRAPH_LIFECYCLE_INPUT');
 for(const key of ['review_hash','prepared_hash','publication_hash','admission_review_hash'])if(Object.hasOwn(p,key)&&(typeof p[key]!=='string'||!HASH.test(p[key])))throw fail('GRAPH_LIFECYCLE_INPUT');
 if(Object.hasOwn(CONFIRM,p.action)&&p.confirm!==CONFIRM[p.action])throw fail('GRAPH_LIFECYCLE_INPUT');
 // A publication creates the next immutable revision while expected_version
 // fences the mutable journey row.  Those counters are related only after the
 // server has locked and read the journey, so a client-side numeric comparison
 // would reject the normal version 1 -> revision 2 publication.  Activation
 // and pause still address an already-published revision.
 if(['activate','pause'].includes(p.action)&&p.published_revision>p.expected_version)throw fail('GRAPH_LIFECYCLE_INPUT');
 return freeze(p);
}
// A digest binds only the exact payload, not a permission, durable receipt or proof.
function commandFingerprint(p){return digest({contract:VERSION,scope:SCOPE,request:validateRequest(p)});}
module.exports={VERSION,SCOPE,ENABLED,MAX_VERSION,MAX_AGE_MS,UUID,HASH,FIELDS,CONFIRM,PERMISSIONS,fail,copy,canonical,digest,exact,version,freeze,validateRequest,commandFingerprint};
