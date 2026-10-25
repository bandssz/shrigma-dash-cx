'use strict';
const crypto=require('node:crypto'),C=require('./combined-audience.cjs'),B=require('./behavior-source.cjs'),{nativeListBrand}=require('./simple-crm-native-internal.cjs');
const fail=(code,status=409)=>{throw Object.assign(Error(code),{code,status});};
const ids=rows=>{if(rows.length>500000)fail('COMBINED_MEMBERS_LIMIT');return rows.map(r=>String(r.id));};
const ELIGIBLE="SELECT DISTINCT s.id FROM public.subscribers s JOIN public.subscriber_lists sl ON sl.subscriber_id=s.id JOIN public.lists l ON l.id=sl.list_id WHERE sl.list_id=$1 AND l.status='active' AND s.status='enabled' AND sl.status<>'unsubscribed' AND (l.optin='single' OR sl.status='confirmed')";
function create({database,authorize,store,sourceRevision,purchaseSql,coverage,listCatalog,refresh=async()=>{},now=Date.now}){
 function authority(context,brand){const u=authorize(context,brand);return {userId:u.id,revision:C.digest({id:u.id,email:u.email,role:u.role,brands:u.brands,viewBrands:u.viewBrands,permissions:u.permissions,productWriteFronts:u.productWriteFronts,profileRevision:u.profileRevision})};}
 async function lists(context,brand){if(typeof listCatalog!=='function')fail('COMBINED_CATALOG_UNAVAILABLE',503);const r=await listCatalog(context,brand);if(r?.brand!==brand||r.current!==true||!Array.isArray(r.lists)||new Set(r.lists.map(x=>x.id)).size!==r.lists.length)fail('COMBINED_CATALOG_UNCONFIRMED',503);return r.lists;}
 async function evaluate(context,definition,sharedSnapshot=null){
  const normalized=C.normalize(definition,now()),brand=normalized.brand,before=authority(context,brand),cut=coverage(brand),cutHash=C.digest(cut),end=cut?Date.parse(cut.until):now();
  const originalLists=await lists(context,brand),referenced=new Set([brand==='aristo'?16:17]);function visit(n){if(n.kind==='list')referenced.add(n.listId);if(n.rules)n.rules.forEach(visit);if(n.op==='exclude'){visit(n.base);visit(n.without);}}visit(normalized.rule);const scopeHash=rows=>C.digest([...referenced].sort((a,b)=>a-b).map(id=>{const r=rows.find(x=>x.id===id);return r?{id,brand:r.brand,available:r.available}:null;})),originalHash=scopeHash(originalLists);
  const engine=C.create({sourceRevision,now,maxMembers:500000,authorize:authority,beginSnapshot:work=>sharedSnapshot?work(sharedSnapshot):database(async client=>work({consistent:true,brand,id:crypto.randomUUID(),client}),false,true),readSet:async(ctx,leaf,{snapshot,leafHash})=>{
   const c=snapshot.client,base={brand,snapshotId:snapshot.id,leafHash,positiveOnly:true,eligibleOnly:true};
   const validateList=async id=>{const admitted=originalLists.find(l=>l.id===id);if(!admitted||admitted.brand!==brand)fail('COMBINED_LIST_SCOPE_DENIED',403);if(admitted.available!==true)fail('COMBINED_LIST_UNAVAILABLE');const l=(await c.query('SELECT id,status,optin FROM public.lists WHERE id=$1',[id])).rows[0];if(!l||l.status!=='active'||!['single','double'].includes(l.optin))fail('COMBINED_LIST_UNAVAILABLE');return l;};
   await validateList(brand==='aristo'?16:17);
   const filterEligible=async(_,{ids:input})=>({brand,snapshotId:snapshot.id,confirmed:true,ids:ids((await c.query(ELIGIBLE+' AND s.id=ANY($2::bigint[]) ORDER BY s.id LIMIT 500001',[brand==='aristo'?16:17,input])).rows)});
   if(leaf.kind==='behavior')return B.create({query:(sql,params)=>c.query(sql,params),filterEligible,maxMembers:500000})(ctx,leaf,{brand,snapshot,leafHash});
   let members;
   if(leaf.kind==='list'){
    await validateList(leaf.listId);
    members=ids((await c.query(ELIGIBLE+' ORDER BY s.id LIMIT 500001',[leaf.listId])).rows);
    members=(await filterEligible(ctx,{ids:members})).ids;
   }else{
    const q=leaf.rule,from=new Date(end-q.days*86400000).toISOString();if(!cut||cut.from>from||now()-end>=30*60000)return {...base,confirmed:false,count:null,ids:null};
    const sql=purchaseSql(q.kind).replace('SELECT count(DISTINCT s.id)::int count FROM','SELECT DISTINCT s.id FROM')+' ORDER BY s.id LIMIT 500001';
    members=ids((await c.query(sql,[brand,from,cut.until,q.productId||null,false,brand==='aristo'?16:17])).rows);
   }
   return {...base,confirmed:true,count:members.length,ids:members};
  }});
  const result=await engine.resolveSaved(context,normalized);if(C.digest(coverage(brand))!==cutHash||JSON.stringify(authority(context,brand))!==JSON.stringify(before)||scopeHash(await lists(context,brand))!==originalHash)fail('COMBINED_SOURCE_CHANGED');return {...result,coverage:cut||{until:result.checkedAt},normalized};
 }
 async function catalog(context,brand){authority(context,brand);const scopedLists=(await lists(context,brand)).filter(l=>l.available===true&&l.brand===brand).map(({id,name})=>({id,name})),value=await database(async c=>{
  const campaigns=(await c.query('SELECT id,uuid,name,from_email FROM public.campaigns ORDER BY id DESC')).rows.filter(c=>{const match=String(c.from_email).trim().match(/(?:^|<)[^<>\s@]+@([^<>\s@]+)>?$/);return match&&(brand==='aristo'?['oaristocrata.com','marketing.oaristocrata.com']:['fishermans.com.br','marketing.fishermans.com.br']).includes(match[1].toLowerCase());}).map(({id,uuid,name})=>({id,uuid,name}));
  return {lists:scopedLists,campaigns};
 });authority(context,brand);return {brand,...value,publics:store.list(brand).filter(p=>p.rule.schema==='combined-audience-v2'),checkedAt:new Date(now()).toISOString()};}
 async function count(context,brand,input){if(input.definition?.brand!==brand)fail('COMBINED_SCOPE_INVALID',400);const d=C.normalize(input.definition,now());await refresh(context,brand,d);const {subscriberIds,normalized,...safe}=await evaluate(context,d);return safe;}
 async function save(context,brand,input){const u=authorize(context,brand,true),before=JSON.stringify(authority(context,brand));if(typeof input.name!=='string'||input.name.trim().length<3||input.name.length>120||input.definition?.brand!==brand||input.id&&typeof input.expectedUpdatedAt!=='string')fail('COMBINED_INPUT_INVALID',400);const result=await count(context,brand,input);if(result.confirmed!==true||result.definitionHash!==input.definitionHash)fail('COMBINED_COUNT_REQUIRED');const after=authorize(context,brand,true);if(after.id!==u.id||JSON.stringify(authority(context,brand))!==before)fail('COMBINED_AUTHORITY_CHANGED',403);return store.save({id:input.id,brand,owner:u.id,name:input.name.trim(),rule:C.normalize(input.definition,now()),...(input.id?{expectedUpdatedAt:input.expectedUpdatedAt}:{})});}
 async function compareList(context,brand,input){
  if(input.definition?.brand!==brand||!Number.isSafeInteger(input.listId)||input.listId<1)fail('COMBINED_SCOPE_INVALID',400);authority(context,brand);
  return database(async client=>{const snapshot={consistent:true,brand,id:crypto.randomUUID(),client},r=await evaluate(context,input.definition,snapshot),reference=await evaluate(context,{schema:'combined-audience-v2',brand,channel:'email',rule:{kind:'list',listId:input.listId}},snapshot);
   if(!r.confirmed||!reference.confirmed)return {brand,confirmed:false,count:null,referenceCount:null};
   const actual=new Set(r.subscriberIds),expected=new Set(reference.subscriberIds),missing=[...expected].filter(id=>!actual.has(id)),extra=[...actual].filter(id=>!expected.has(id));
   return {brand,confirmed:true,definitionHash:r.definitionHash,listId:input.listId,count:r.count,referenceCount:reference.count,missing:missing.length,extra:extra.length,matched:missing.length===0&&extra.length===0,recipientHash:C.digest(r.subscriberIds),referenceHash:C.digest(reference.subscriberIds),checkedAt:r.checkedAt,sameSnapshot:true,eligibilityBaseListId:brand==='aristo'?16:17,comparisonScope:'eligible-confirmed-members-in-brand-base',customerWrites:0};
  },false,true);
 }
 return Object.freeze({evaluate,count,save,catalog,compareList});
}
module.exports={create,ELIGIBLE};
