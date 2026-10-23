'use strict';
const M=require('./crm-paid-acquisition.cjs');
const SHOPS={aristo:'gwx20u-vw.myshopify.com',fish:'c0kfm1-qt.myshopify.com'};
const BASE=`FROM public.crm_attribution_order_v2 WHERE brand=$1 AND paid_fact->>'financialStatus'='paid' AND paid_fact->>'test'='false' AND paid_fact->>'createdAt'>=$2 AND paid_fact->>'createdAt'<$3`;
const SELECT=`SELECT order_id,paid_fact->>'createdAt' created_at,paid_fact->>'sourceUpdatedAt' fact_updated_at,md5((paid_fact-'acquisition')::text) base_hash,paid_fact->'acquisition' prior_acquisition ${BASE} AND order_id>$4 AND ($5::text[] IS NULL OR order_id=ANY($5)) ORDER BY order_id LIMIT 10`;
const UPDATE=`UPDATE public.crm_attribution_order_v2 SET paid_fact=jsonb_set(paid_fact,'{acquisition}',$3::jsonb,true) WHERE brand=$1 AND order_id=$2 AND md5((paid_fact-'acquisition')::text)=$4 AND coalesce(paid_fact->'acquisition','null'::jsonb)=$5::jsonb RETURNING order_id`;
const fail=code=>{throw Object.assign(Error(code),{code,status:409});};
function range(now){return {from:new Date(now-30*86400000).toISOString(),until:new Date(now).toISOString(),days:30};}
function ids(input){if(input===undefined)return null;if(!Array.isArray(input)||input.length<1||input.length>10||new Set(input).size!==input.length||input.some(x=>!/^gid:\/\/shopify\/Order\/[1-9][0-9]{0,19}$/.test(x)))fail('PAID_ACQUISITION_IDS_INVALID');return input;}
function create({authorize,database,graphql,openBackup,readBackup,now=Date.now}){
 async function availableWindow(brand){const p=range(now()),row=await database(async c=>(await c.query("SELECT max(paid_fact->>'createdAt') latest FROM public.crm_attribution_order_v2 WHERE brand=$1 AND paid_fact->>'financialStatus'='paid' AND paid_fact->>'test'='false'",[brand])).rows[0]);if(row?.latest&&Date.parse(row.latest)<Date.parse(p.from)){const until=Date.parse(row.latest)+1;return {...range(until),fallback:true};}return {...p,fallback:false};}
 async function acquisition(context,brand,input={}){
  authorize(context,brand);const p=await availableWindow(brand),selected=ids(input.ids);
  const value=await database(async c=>{
   const groups=(await c.query(`SELECT coalesce(paid_fact->'acquisition'->>'origin','unknown') origin,count(*)::int orders,count(*) FILTER(WHERE paid_fact->'acquisition'->'journey'->>'complete'='true')::int complete,count(*) FILTER(WHERE jsonb_typeof(paid_fact->'acquisition'->'discountCodes')='array' AND paid_fact->'acquisition'->'discountCodes'<>'[]'::jsonb)::int with_coupon,max(paid_fact->'acquisition'->>'observedAt') latest ${BASE} GROUP BY 1 ORDER BY 1`,[brand,p.from,p.until])).rows;
   const samples=(await c.query(`SELECT order_id,paid_fact->>'createdAt' created_at,paid_fact->'acquisition' acquisition ${BASE} AND ($4::text[] IS NULL OR order_id=ANY($4)) ORDER BY paid_fact->>'createdAt' DESC,order_id LIMIT 10`,[brand,p.from,p.until,selected])).rows;
   return {brand,period:p,groups,samples,checkedAt:new Date(now()).toISOString()};
  });authorize(context,brand);return value;
 }
 async function enrich(context,brand,input={},onProgress=()=>{}){
  authorize(context,brand,true);const p=range(now()),selected=ids(input.ids);if(typeof openBackup!=='function')fail('PAID_ACQUISITION_BACKUP_UNAVAILABLE');
  const backup=openBackup(brand);let after='',pages=0,orders=0,stored=0,skipped=0,complete=0,incomplete=0;
  try{
   onProgress({brand,...p,backup:backup.name,pages,orders,stored,skipped,complete,incomplete});
   for(;;){
    authorize(context,brand,true);const rows=await database(async c=>(await c.query(SELECT,[brand,p.from,p.until,after,selected])).rows);if(!rows.length)break;
    if(++pages>5000)fail('PAID_ACQUISITION_RANGE_TOO_LARGE');
    const data=await graphql(brand,M.ORDERS_QUERY,{ids:rows.map(r=>r.order_id),after:null});
    if(data?.shop?.myshopifyDomain!==SHOPS[brand]||!Array.isArray(data.nodes)||data.nodes.length!==rows.length)fail('PAID_ACQUISITION_SHOP_MISMATCH');
    const byId=new Map(data.nodes.filter(Boolean).map(o=>[o.id,o]));if(byId.size!==data.nodes.length)fail('PAID_ACQUISITION_SOURCE_INCOMPLETE');
    const writes=[];
    for(const row of rows){
     const order=byId.get(row.order_id);orders++;
     if(!order||new Date(order.createdAt).toISOString()!==new Date(row.created_at).toISOString()){skipped++;continue;}
     const full=await M.completeJourney(order,{shop:SHOPS[brand],read:(q,v)=>graphql(brand,q,v)}),webhook=row.prior_acquisition?.webhook,observed=webhook&&typeof webhook==='object'&&!Array.isArray(webhook)?{webhook:{...webhook,origin:M.classify(webhook)},observedOrigin:M.classify(webhook)}:{},value={...M.acquisition(full.order,{observedAt:new Date(now()).toISOString(),complete:full.complete,reason:full.reason}),...observed};
     value.factSourceUpdatedAt=row.fact_updated_at??null;value.snapshotMatchesFact=row.fact_updated_at?Date.parse(row.fact_updated_at)===Date.parse(order.updatedAt):null;
     if(!value.journey.complete){incomplete++;if(row.prior_acquisition?.journey?.complete===true){skipped++;continue;}}
     writes.push({row,value});
    }
    // Durable metadata backup before the conditional UPDATE. No lease, claim,
    // operation journal or purchase/customer/product mutation is introduced.
    backup.append(writes.map(({row,value})=>({brand,orderId:row.order_id,baseHash:row.base_hash,before:row.prior_acquisition??null,after:value})));
    await database(async c=>{
     authorize(context,brand,true);
     for(const {row,value}of writes){const result=await c.query(UPDATE,[brand,row.order_id,JSON.stringify(value),row.base_hash,JSON.stringify(row.prior_acquisition??null)]);if(result.rowCount===1){stored++;if(value.journey.complete)complete++;}else skipped++;}
     authorize(context,brand,true);
    },true);
    after=rows.at(-1).order_id;onProgress({brand,...p,backup:backup.name,pages,orders,stored,skipped,complete,incomplete});
   }
   authorize(context,brand,true);return {ok:true,brand,period:p,pages,orders,stored,skipped,complete,incomplete,backup:backup.name,checkedAt:new Date(now()).toISOString()};
  }finally{backup.close();}
 }
 async function reclassify(context,brand,input={},onProgress=()=>{}){
  authorize(context,brand,true);const p=range(now()),selected=ids(input.ids);if(typeof openBackup!=='function')fail('PAID_ACQUISITION_BACKUP_UNAVAILABLE');
  const backup=openBackup(brand);let after='',pages=0,orders=0,stored=0,unchanged=0,skipped=0;
  const progress=()=>({brand,...p,backup:backup.name,pages,orders,stored,unchanged,skipped});
  try{
   onProgress(progress());
   for(;;){
    authorize(context,brand,true);const rows=await database(async c=>(await c.query(SELECT,[brand,p.from,p.until,after,selected])).rows);if(!rows.length)break;
    if(++pages>5000)fail('PAID_ACQUISITION_RANGE_TOO_LARGE');const writes=[];
    for(const row of rows){orders++;const value=M.reclassify(row.prior_acquisition);if(!value){skipped++;continue;}if(JSON.stringify(value)===JSON.stringify(row.prior_acquisition)){unchanged++;continue;}writes.push({row,value});}
    backup.append(writes.map(({row,value})=>({brand,orderId:row.order_id,baseHash:row.base_hash,before:row.prior_acquisition,after:value})));
    const result=await database(async c=>{let changed=0,raced=0;for(const {row,value}of writes){authorize(context,brand,true);const r=await c.query(UPDATE,[brand,row.order_id,JSON.stringify(value),row.base_hash,JSON.stringify(row.prior_acquisition)]);if(r.rowCount===1)changed++;else raced++;}authorize(context,brand,true);return {changed,raced};},true);
    stored+=result.changed;skipped+=result.raced;after=rows.at(-1).order_id;onProgress(progress());
   }
   authorize(context,brand,true);return {ok:true,...progress(),checkedAt:new Date(now()).toISOString()};
  }finally{backup.close();}
 }
 async function restore(context,brand,input={}){
  authorize(context,brand,true);const dryRun=input.dryRun!==false;
  if(typeof readBackup!=='function')fail('PAID_ACQUISITION_BACKUP_UNAVAILABLE');
  if(Object.keys(input).some(key=>!['action','brand','name','offset','dryRun'].includes(key))||input.dryRun!==undefined&&typeof input.dryRun!=='boolean'||typeof input.name!=='string'||!Number.isSafeInteger(input.offset??0)||(input.offset??0)<0)fail('PAID_ACQUISITION_RESTORE_INPUT_INVALID');
  const page=await readBackup(brand,input.name,input.offset??0);authorize(context,brand,true);
  const B=require('./crm-paid-acquisition-backup.cjs'),equal=require('node:util').isDeepStrictEqual;
  const statements=page.rows.map(row=>{if(row.brand!==brand)fail('PAID_ACQUISITION_RESTORE_BRAND_MISMATCH');return {row,...B.rollback(row)};});
  const result=await database(async c=>{
   let restored=0,wouldRestore=0,alreadyRestored=0,conflicts=0;
   for(const command of statements){
    authorize(context,brand,true);
    if(!dryRun){const updated=await c.query(command.sql,command.values);if(updated.rowCount===1){restored++;continue;}}
    const current=(await c.query("SELECT paid_fact->'acquisition' acquisition FROM public.crm_attribution_order_v2 WHERE brand=$1 AND order_id=$2",[brand,command.row.orderId])).rows;
    if(current.length===1&&equal(current[0].acquisition??null,command.row.before??null))alreadyRestored++;
    else if(dryRun&&current.length===1&&equal(current[0].acquisition,command.row.after))wouldRestore++;
    else conflicts++;
   }
   authorize(context,brand,true);return {restored,wouldRestore,alreadyRestored,conflicts};
  },!dryRun);
  authorize(context,brand,true);return {ok:result.conflicts===0,brand,name:page.name,dryRun,rows:page.rows.length,...result,more:page.more,nextOffset:page.nextOffset,checkedAt:new Date(now()).toISOString()};
 }
 return {acquisition,enrich,reclassify,restore};
}
module.exports={create,SELECT,UPDATE,BASE,range,ids};
