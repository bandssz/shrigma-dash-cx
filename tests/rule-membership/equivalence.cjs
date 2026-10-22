'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const H=__dirname,R=path.resolve(H,'../..');let db;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const before=fs.readFileSync(path.join(H,'before-kernel.sql'),'utf8'),after=fs.readFileSync(path.resolve(H,'../../n8n/growth/segment-listmonk-selection.batch.sql'),'utf8');
const ctx=(rule,brand='fish')=>({bound:true,brand,base_list_id:17,list_ids:[17],single_list_ids:[17],definition:{rule}});
const cond=(field,operator,value)=>({op:'condition',field,operator,value});
const opened=cond('email.opened','within_last_days',30),notopened=cond('email.opened','not_within_last_days',30),clicked=cond('email.clicked','within_last_days',30);
const product=cond('purchase.product','purchased','gid://shopify/Product/1'),negative=cond('purchase.product','not_purchased','gid://shopify/Product/1');
const origin=cond('signup.recorded_origin','is','vip_alma'),confirmed=rule=>({op:'confirmed',rule}),base={op:'in_list',list_id:17};
const result={schema:'set-based-rule-membership-new-equivalence-v1',beforeKernelSha256:sha(before),afterKernelSha256:sha(after),originalCalls:0,persistentDatabase:false,oldSuitesExecuted:0,cases:[]};let phase='setup';
async function invalidProducts(){
 const constraints=(await db.query("SELECT conname FROM pg_constraint WHERE conrelid='crm_audience_v2.shopify_customer_product'::regclass AND pg_get_constraintdef(oid)LIKE'%jsonb_typeof%'")).rows;
 for(const r of constraints){assert.match(r.conname,/^[a-z_]+$/);await db.exec('ALTER TABLE crm_audience_v2.shopify_customer_product DROP CONSTRAINT '+r.conname);}
 await db.exec("UPDATE crm_audience_v2.shopify_customer_product SET products='{}'::jsonb");
}
async function run(name,rule,{brand='fish',mutate=null,expectedCode=null,idsTransform=ids=>ids,raw=false,contextTransform=c=>c,check=null}={}){
 phase=name;await db.exec('BEGIN');try{
 if(mutate)await mutate();
 for(const n of[32,4100]){
  const ids=idsTransform(Array.from({length:n},(_,i)=>i+1)),args=[JSON.stringify(contextTransform(ctx(rule,brand))),ids],out=[];
  for(const kernel of[before,after]){
   const sql=raw?kernel.slice(0,kernel.indexOf('leaf_matches AS MATERIALIZED (\n')).replace(/,\n$/,'\n')+'SELECT sid,path,leaf_op,value,fatal FROM raw_matches ORDER BY sid,path;':kernel;
   await db.exec('SAVEPOINT compare');
   try{out.push({rows:(await db.query(sql,args)).rows});}catch(e){out.push({sqlstate:e.code});}
   await db.exec('ROLLBACK TO compare');
  }
  assert.deepEqual(out[1],out[0],name+' before/after');
  if(expectedCode)assert.equal(out[1].sqlstate,expectedCode);else{assert.equal(out[1].sqlstate,undefined);if(check)check(out[1].rows);}
  result.cases.push({name,branch:n<=4096?'unchanged-small':'bulk-full-membership',candidateCount:ids.length,rows:out[1].rows?.length??null,sqlstate:out[1].sqlstate||'00000',rowsAndFlagsEqual:true});
 }
 }finally{await db.exec('ROLLBACK');}
}
async function main({database=null}={}){
 assert(database,'ISOLATED_DATABASE_ADAPTER_REQUIRED');db=database;
 const composition=JSON.parse(fs.readFileSync(path.join(H,'composition.json')));
 await require(path.join(H,'fixture.cjs')).create({db,composition});
 await db.exec(`INSERT INTO public.subscribers(id,status,uuid,email,attribs) SELECT g,'enabled',md5('membership-'||g)::uuid,'membership-'||g||'@synthetic.invalid','{}'::jsonb FROM generate_series(33,4101)g;
 INSERT INTO public.subscriber_lists(list_id,subscriber_id,status)SELECT 17,g,'confirmed'FROM generate_series(33,4101)g;
 INSERT INTO public.campaign_views(subscriber_id,campaign_id,created_at)VALUES(1,90001,statement_timestamp()-interval'1 minute'),(1,90001,statement_timestamp()-interval'1 minute'),(4101,90001,statement_timestamp()-interval'1 minute'),(2,90001,NULL);
 INSERT INTO crm_audience_v2.recorded_origin_source VALUES('aristo','vip_alma','00000000-0000-4000-8000-000000009001','synthetic-origin','synthetic-revision',statement_timestamp()-interval'1 day',true);
 INSERT INTO crm_audience_v2.recorded_origin_receipt SELECT '00000000-0000-4000-8000-000000009001','synthetic-origin',id,uuid,statement_timestamp()-interval'1 minute' FROM public.subscribers WHERE id IN(1,4101);
 INSERT INTO crm_audience_v2.recorded_origin_receipt SELECT * FROM crm_audience_v2.recorded_origin_receipt WHERE subscriber_id=1;
 SET enable_seqscan=on;SET enable_nestloop=on;SET enable_hashjoin=on;SET enable_mergejoin=on;SET jit=off;SET work_mem='4MB';SET statement_timeout='9s';SET lock_timeout='500ms';`);
 await run('event positive duplicate RHS and outside candidate',opened,{check:rows=>{assert.equal(rows[0].matched,true);if(rows.length>32)assert.equal(rows.find(r=>r.sid===33).matched,false);}});
 await run('event NOT membership no-hit versus duplicate hit',notopened,{check:rows=>{assert.equal(rows[0].matched,false);if(rows.length>32)assert.equal(rows.find(r=>r.sid===33).matched,true);}});
 await run('product positive/negative and repeated product RHS',{op:'or',rules:[confirmed(product),confirmed(negative)]},{mutate:()=>db.exec("UPDATE crm_audience_v2.shopify_customer_product SET products=products||products"),check:rows=>assert.equal(rows.filter(r=>r.matched).length,32)});
 await run('product unknown history/gap retains confirmedNULLcoalesce',confirmed(negative),{mutate:()=>db.exec("UPDATE crm_audience_v2.shopify_customer_product SET history_complete=false WHERE customer_gid='gid://shopify/Customer/1';INSERT INTO crm_audience_v2.shopify_product_history_gap(brand,operation_id,customer_gid,source_sha256,query_sha256,expected_orders,observed_orders,proof_sha256,correction_sha256)VALUES('fish','gid://shopify/BulkOperation/1','gid://shopify/Customer/3',repeat('a',64),'bb89faf525f58f9c5075878888c1be6fcf4992200310a4867cdd2871fb570086',2,1,repeat('b',64),repeat('c',64))")});
 await run('origin valid duplicate keys/raw bag preserved',{op:'or',rules:[origin,base]},{brand:'aristo',raw:true,check:rows=>{assert.equal(rows.filter(r=>r.sid===1).length,2);assert.equal(rows.find(r=>r.sid===1&&r.leaf_op==='condition').value,true);}});
 await run('origin unavailableNULL not masked asfalse in raw',origin,{brand:'aristo',mutate:()=>db.exec("UPDATE crm_audience_v2.recorded_origin_source SET enabled=false"),raw:true,check:rows=>assert(rows.every(r=>r.value===null))});
 await run('OR retainsunknown origin while knownbase resolves', {op:'or',rules:[origin,base]}, {brand:'aristo',mutate:()=>db.exec("UPDATE crm_audience_v2.recorded_origin_source SET enabled=false")});
 await run('raw bags/tri-state for compound product/event',{op:'and',rules:[base,opened,clicked,confirmed(product),confirmed(negative)]},{raw:true});
 await run('lazy irrelevant productJSON not consumed by event class',opened,{mutate:invalidProducts});
 await run('lazy productJSON not consumed when source unavailable',confirmed(product),{mutate:async()=>{await invalidProducts();await db.exec("UPDATE crm_audience_v2.shopify_source SET enabled=false");},expectedCode:'55000'});
 await run('lazy in_list priority prevents product lookup despite field', {op:'in_list',list_id:17,field:'purchase.product'}, {mutate:invalidProducts});
 await run('invalid engagement OR cannot hidefatal', {op:'or',rules:[opened,cond('email.clicked','within_last_days',0)]},{expectedCode:'55000'});
 await run('NULL candidate remains global structural refusal',opened,{idsTransform:ids=>ids.concat(null),expectedCode:'55000'});
 await run('NULL bound remains failclosed',opened,{contextTransform:c=>({...c,bound:null}),expectedCode:'55000'});
 // Deliberately impossible RHS NULL key is refused defensively, never changed
 // to a false NOT-IN result. Original SQL tri-state is observed explicitly.
 const nulls=(await db.query("SELECT ROW(1,ARRAY[1]) IN(SELECT sid,path FROM(VALUES(1,NULL::integer[]))v(sid,path)) positive,ROW(1,ARRAY[1])NOT IN(SELECT sid,path FROM(VALUES(1,NULL::integer[]))v(sid,path))negative")).rows[0];assert.deepEqual(nulls,{positive:null,negative:null});
 const injected=after.replace('bulk_hit_keys AS MATERIALIZED (\n',"bulk_hit_keys AS MATERIALIZED (\n SELECT 1::integer sid,NULL::integer[]path,'event'::text hit_kind,true hit_present UNION ALL\n");
 await db.exec('BEGIN');let code;try{await db.query(injected,[JSON.stringify(ctx(opened)),Array.from({length:4100},(_,i)=>i+1)]);}catch(e){code=e.code;}await db.exec('ROLLBACK');assert.equal(code,'55000');result.impossibleNullHitKey={originalInAndNotInNullObserved:true,defensiveRefusal:code,productionQueryChanged:false};
 const plan=(await db.query('EXPLAIN (FORMAT JSON) '+after,[JSON.stringify(ctx({op:'and',rules:[opened,clicked,confirmed(product)]})),Array.from({length:4100},(_,i)=>i+1)])).rows[0]['QUERY PLAN'];
 const find=(n,p)=>p(n)?n:(n.Plans||[]).map(x=>find(x,p)).find(Boolean);const boundary=find(plan[0].Plan,n=>n['Subplan Name']==='CTE bulk_raw_boundary');assert(boundary);const full=find(boundary,n=>n['Join Type']==='Full');assert(full);assert(['Hash Join','Merge Join'].includes(full['Node Type']));
 result.bulkPhysicalBoundary={materializedCte:true,nodeType:full['Node Type'],joinType:full['Join Type'],wideProductJsonPerLeafMaterialized:false};
 result.ok=true;result.rollbackConfirmed=true;await db.close();result.endConfirmed=true;fs.writeFileSync(process.env.BULK_MEMBERSHIP_REPORT,JSON.stringify(result,null,2)+'\n');return result;
}
exports.runWithDatabase=database=>main({database});
if(require.main===module)throw Error('ISOLATED_DATABASE_ADAPTER_REQUIRED');
