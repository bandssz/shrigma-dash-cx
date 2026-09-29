/* Shadow candidate: typed reusable audiences. No I/O, enrollment or send. */
var SegmentAudienceContract=(()=>{
'use strict';
const VERSION='crm-audience-v2',ENABLED=false;
const LIMITS=Object.freeze({depth:4,nodes:32,children:16,bytes:16000});
const FIELDS=Object.freeze({
 'purchase.count':{label:'Quantidade de pedidos na Shopify',type:'integer',source:'shopify',operators:['eq','gt','gte','lt','lte']},
 'purchase.last_date':{label:'Data do último pedido',type:'date',source:'shopify',operators:['eq','before','on_or_before','after','on_or_after']},
 'purchase.amount':{label:'Valor gasto na loja',type:'money',source:'shopify',operators:['eq','gt','gte','lt','lte']},
 'purchase.product':{label:'Produto nos pedidos',type:'product',source:'shopify',operators:['purchased','not_purchased']},
 'signup.origin':{label:'Origem comprovada da inscrição',type:'origin',source:'crm',operators:['is','is_not']},
 'email.opened':{label:'Abertura de e-mail registrada',type:'days',source:'email',operators:['within_last_days','not_within_last_days']},
 'email.clicked':{label:'Clique em e-mail registrado',type:'days',source:'email',operators:['within_last_days','not_within_last_days']}
});
for(const v of Object.values(FIELDS)){Object.freeze(v.operators);Object.freeze(v);}
const own=(v,k)=>Object.prototype.hasOwnProperty.call(v,k);
const fail=code=>{throw Object.assign(Error(code),{code});};
const integer=v=>Number.isSafeInteger(v)&&v>=0&&v<=2147483647;
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&v>='2000-01-01'&&v<='2100-12-31'&&Number.isFinite(Date.parse(v+'T00:00:00.000Z'))&&new Date(v+'T00:00:00.000Z').toISOString().slice(0,10)===v;
const stamp=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
function exact(v,keys){
 if(!v||typeof v!=='object'||Array.isArray(v))fail('AUDIENCE_SHAPE');
 const names=Reflect.ownKeys(v);
 if(names.length!==keys.length||names.some(k=>typeof k!=='string'||!keys.includes(k))||keys.some(k=>!own(v,k))||names.some(k=>!own(Object.getOwnPropertyDescriptor(v,k),'value')||!Object.getOwnPropertyDescriptor(v,k).enumerable))fail('AUDIENCE_FIELDS');
}
function condition(input){
 exact(input,['op','field','operator','value']);
 if(typeof input.field!=='string'||typeof input.operator!=='string')fail('AUDIENCE_CONDITION');
 const field=own(FIELDS,input.field)?FIELDS[input.field]:null;if(input.op!=='condition'||!field||!field.operators.includes(input.operator))fail('AUDIENCE_CONDITION');
 let value=input.value;
 if(field.type==='integer'&&!integer(value))fail('AUDIENCE_NUMBER');
 if(field.type==='date'&&!date(value))fail('AUDIENCE_DATE');
 // Money is a decimal string in the server-confirmed store currency, never a
 // binary float or a locale-dependent parse. The UI owns display formatting.
 if(field.type==='money'){
  if(typeof value!=='string'||!/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(value))fail('AUDIENCE_MONEY');
  const [whole,frac='']=value.split('.');value=whole+'.'+frac.padEnd(2,'0');
 }
 if(field.type==='product'&&(typeof value!=='string'||!/^gid:\/\/shopify\/Product\/[1-9]\d{0,19}$/.test(value)))fail('AUDIENCE_PRODUCT');
 if(field.type==='origin'&&!['popup','vip_alma','vip_desodorante'].includes(value))fail('AUDIENCE_ORIGIN');
 if(field.type==='days'&&(!Number.isSafeInteger(value)||value<1||value>3650))fail('AUDIENCE_DAYS');
 return {op:'condition',field:input.field,operator:input.operator,value};
}
function normalize(input){
 exact(input,['schema_version','brand','name','rule']);
 if(input.schema_version!==VERSION)fail('AUDIENCE_VERSION');
 if(!['fish','aristo'].includes(input.brand))fail('AUDIENCE_BRAND');
 if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>160||/[\x00-\x1f\x7f]/.test(input.name))fail('AUDIENCE_NAME');
 let nodes=0;const active=new Set();
 function walk(rule,depth){
  if(depth>LIMITS.depth||++nodes>LIMITS.nodes)fail('AUDIENCE_LIMIT');
  if(!rule||typeof rule!=='object'||active.has(rule))fail('AUDIENCE_RULE');
  const op=Object.getOwnPropertyDescriptor(rule,'op');if(!op||!own(op,'value'))fail('AUDIENCE_FIELDS');
  if(op.value==='condition')return condition(rule);
  if(op.value==='in_list'){exact(rule,['op','list_id']);if(!integer(rule.list_id)||rule.list_id===0)fail('AUDIENCE_LIST');return {op:'in_list',list_id:rule.list_id};}
  if(op.value==='confirmed'){
   exact(rule,['op','rule']);if(Object.getOwnPropertyDescriptor(rule.rule||{},'op')?.value!=='condition')fail('AUDIENCE_CONFIRMED_RULE');active.add(rule);const child=walk(rule.rule,depth+1);active.delete(rule);
   if(child.op!=='condition'||FIELDS[child.field].source!=='shopify')fail('AUDIENCE_CONFIRMED_RULE');
   return {op:'confirmed',rule:child};
  }
  exact(rule,['op','rules']);
  if(!['and','or'].includes(rule.op)||!Array.isArray(rule.rules)||rule.rules.length<1||rule.rules.length>LIMITS.children)fail('AUDIENCE_RULE');
  active.add(rule);const normalized=rule.rules.map(r=>walk(r,depth+1));active.delete(rule);
  const children=[...new Map(normalized.map(r=>[JSON.stringify(r),r])).entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,r])=>r);
  return children.length===1?children[0]:{op:rule.op,rules:children};
 }
 const d={schema_version:VERSION,brand:input.brand,name:input.name.trim(),rule:walk(input.rule,1)};
 if(JSON.stringify(d).length>LIMITS.bytes)fail('AUDIENCE_LIMIT');return d;
}
function leaves(input){
 const d=normalize(input),out=new Map();
 const visit=r=>r.op==='and'||r.op==='or'?r.rules.forEach(visit):r.op==='confirmed'?visit(r.rule):out.set(JSON.stringify(r),r);visit(d.rule);
 return [...out.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,rule])=>({key,rule}));
}
function checkCatalog(input,catalog){
 const d=normalize(input);
 if(catalog?.brand!==d.brand||catalog.current!==true||!Array.isArray(catalog.fields)||!Array.isArray(catalog.lists)||!Array.isArray(catalog.products)||!Array.isArray(catalog.origins))fail('AUDIENCE_CATALOG');
 const blocked=[];
 for(const {key,rule} of leaves(d)){
  const only=(rows,predicate)=>{const found=rows.filter(predicate);return found.length===1&&found[0].available===true;};
  if(rule.op==='in_list'){
   if(!only(catalog.lists,x=>x.id===rule.list_id&&x.brand===d.brand))blocked.push({key,reason:'list_unavailable'});continue;
  }
  if(!only(catalog.fields,x=>x.key===rule.field))blocked.push({key,reason:'field_unavailable'});
  if(rule.field==='purchase.product'&&!only(catalog.products,x=>x.id===rule.value&&x.brand===d.brand))blocked.push({key,reason:'product_unavailable'});
  if(rule.field==='signup.origin'&&!only(catalog.origins,x=>x.key===rule.value&&x.brand===d.brand))blocked.push({key,reason:'origin_unconfirmed'});
  if(rule.field==='purchase.amount'&&!/^[A-Z]{3}$/.test(catalog.currency||''))blocked.push({key,reason:'currency_unconfirmed'});
 }
 return {ok:blocked.length===0,blocked,authorizes_send:false};
}
// A single Shopify leaf is compiled into an allowlisted segment expression.
// Mixed CRM/Shopify/E-mail OR groups must be evaluated as a tree; pushing only
// Shopify leaves into a global AND would silently narrow or widen the audience.
function shopifyQuery(rule){
 const r=condition(rule);if(FIELDS[r.field].source!=='shopify')fail('AUDIENCE_SHOPIFY_FIELD');
 const operators={eq:'=',gt:'>',gte:'>=',lt:'<',lte:'<=',before:'<',on_or_before:'<=',after:'>',on_or_after:'>='};
 if(r.field==='purchase.count')return 'number_of_orders '+operators[r.operator]+' '+r.value;
 if(r.field==='purchase.amount')return 'amount_spent '+operators[r.operator]+' '+r.value;
 if(r.field==='purchase.last_date')return 'last_order_date '+operators[r.operator]+' '+r.value;
 return 'products_purchased '+(r.operator==='purchased'?'MATCHES':'NOT_MATCHES')+' (id = '+r.value.split('/').at(-1)+')';
}
// Evidence is issued by trusted source adapters for ONE subject and ONE exact
// rule. A missing record, stale result, partial query or identity mismatch is
// unknown, never false. No customer facts are returned to the panel by this API.
function evaluate(input,{subject_ref,revision,evidence,now}={}){
 const d=normalize(input);
 if(typeof subject_ref!=='string'||!subject_ref||subject_ref.length>200||!Number.isSafeInteger(revision)||revision<1||!Array.isArray(evidence)||evidence.length>LIMITS.nodes||!stamp(now))fail('AUDIENCE_EVIDENCE');
 const lookup=new Map(),validKeys=new Set(leaves(d).map(x=>x.key)),unknown=new Set();
 for(const e of evidence){
  if(!e||typeof e!=='object'||!validKeys.has(e.rule_key)||lookup.has(e.rule_key))fail('AUDIENCE_EVIDENCE');
  lookup.set(e.rule_key,e);
 }
 const visit=r=>{
  if(r.op==='confirmed')return visit(r.rule)===true;
  if(r.op==='and'||r.op==='or'){
   const results=r.rules.map(visit);
   if(r.op==='and')return results.includes(false)?false:results.every(x=>x===true)?true:null;
   return results.includes(true)?true:results.every(x=>x===false)?false:null;
  }
  const key=JSON.stringify(r),e=lookup.get(key);
  if(!e||e.brand!==d.brand||e.subject_ref!==subject_ref||e.revision!==revision||e.complete!==true||![true,false].includes(e.value)||!stamp(e.observed_at)||!stamp(e.expires_at)||Date.parse(e.observed_at)>Date.parse(now)||Date.parse(e.expires_at)<=Date.parse(now)||Date.parse(e.expires_at)-Date.parse(e.observed_at)>300000){unknown.add(key);return null;}
  return e.value;
 };
 const match=visit(d.rule);return {match,unknown_rules:[...unknown].sort(),authorizes_send:false};
}
return {VERSION,ENABLED,LIMITS,FIELDS,normalize,leaves,checkCatalog,shopifyQuery,evaluate};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=SegmentAudienceContract;
