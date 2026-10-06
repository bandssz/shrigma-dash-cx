/* Provider-neutral manual audience slices. This contract never grants a send. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.AudienceSliceContract=api;})(typeof globalThis==='undefined'?this:globalThis,function(){
 'use strict';
 const VERSION='crm-audience-slices-v1',ENABLED=false,SCALE=10000,MAX_SLICES=20;
 const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
 const fail=code=>{throw Object.assign(Error(code),{code});};
 const brand=v=>['fish','aristo'].includes(v),positive=v=>Number.isSafeInteger(v)&&v>0;
 const uuid=v=>typeof v==='string'&&UUID.test(v),hash=v=>typeof v==='string'&&HASH.test(v);
 const array=v=>Array.isArray(v)&&v.length<=100000&&Array.from({length:v.length},(_,i)=>Object.getOwnPropertyDescriptor(v,String(i))).every(d=>d&&Object.hasOwn(d,'value')&&d.enumerable);
 function exact(v,keys){
  if(!v||typeof v!=='object'||Array.isArray(v))fail('AUDIENCE_SLICE_SHAPE');
  const names=Reflect.ownKeys(v);
  if(names.length!==keys.length||names.some(k=>typeof k!=='string'||!keys.includes(k)||!Object.getOwnPropertyDescriptor(v,k)?.enumerable||!Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value')))fail('AUDIENCE_SLICE_SHAPE');
 }
 function range(input){
  exact(input,['id','name','from_bp','to_bp']);
  if(!uuid(input.id)||typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>100||/[\x00-\x1f\x7f]/.test(input.name)||!Number.isSafeInteger(input.from_bp)||!Number.isSafeInteger(input.to_bp)||input.from_bp<0||input.to_bp>SCALE||input.from_bp>=input.to_bp)fail('AUDIENCE_SLICE_RANGE');
  return {id:input.id,name:input.name.trim(),from_bp:input.from_bp,to_bp:input.to_bp};
 }
 function normalize(input){
  exact(input,['schema','brand','distribution_id','distribution_revision','key_hash','slices']);
  if(input.schema!==VERSION||!brand(input.brand)||!uuid(input.distribution_id)||!positive(input.distribution_revision)||!hash(input.key_hash)||!Array.isArray(input.slices)||!input.slices.length||input.slices.length>MAX_SLICES||!array(input.slices))fail('AUDIENCE_SLICE_PLAN');
  const slices=input.slices.map(range).sort((a,b)=>a.from_bp-b.from_bp||a.to_bp-b.to_bp);
  if(new Set(slices.map(s=>s.id)).size!==slices.length||slices.some((s,i)=>i>0&&s.from_bp<slices[i-1].to_bp))fail('AUDIENCE_SLICE_OVERLAP');
  return {schema:VERSION,brand:input.brand,distribution_id:input.distribution_id,distribution_revision:input.distribution_revision,key_hash:input.key_hash,slices};
 }
 const includes=(slice,bucket)=>Number.isSafeInteger(bucket)&&bucket>=slice.from_bp&&bucket<slice.to_bp;
 const percentage=bp=>new Intl.NumberFormat('pt-BR',{maximumFractionDigits:2}).format(bp/100)+'%';
 const summary=slice=>percentage(slice.from_bp)+' até '+percentage(slice.to_bp)+' · '+percentage(slice.to_bp-slice.from_bp)+' da distribuição';
 return Object.freeze({VERSION,ENABLED,SCALE,MAX_SLICES,UUID,HASH,brand,positive,uuid,hash,array,exact,range,normalize,includes,percentage,summary});
});
