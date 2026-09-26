'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const S=require('../n8n/growth/segment-contract');
const leaf=list_id=>({op:'in_list',list_id});
const input=(brand='fish',rule={op:'and',rules:[leaf(101),leaf(102)]})=>({schema_version:S.VERSION,brand,name:'Segmento sintético',rule});
const catalog=brand=>({brand,current:true,lists:(brand==='fish'?[17,101,102]:[16,201,202]).map(id=>({id,brand,available:true}))});
const options=brand=>({catalog:catalog(brand),baseListId:brand==='fish'?17:16});
test('strict definitions canonicalize E/OU without changing input or claiming native transport',()=>{
 const d=input('fish',{op:'or',rules:[leaf(102),leaf(101),leaf(102)]}),before=JSON.stringify(d),a=S.normalize(d),b=S.normalize(input('fish',{op:'or',rules:[leaf(101),leaf(102)]}));assert.deepEqual(a,b);assert.equal(JSON.stringify(d),before);assert.equal(S.TRANSPORT_SUPPORTED,false);
 const q=S.compileCount(d,options('fish'));assert.equal(q.transport_supported,false);assert.deepEqual(q.values,['fish',[17,101,102],17,101,102]);assert.ok(!('subscriber_query' in q));assert.match(q.text,/s.status::text='enabled'/);
});
test('arbitrary SQL, unsafe identifiers, operators, fields and other brands fail closed',()=>{
 for(const d of [{...input(),sql:'OR TRUE'},input('olivas'),input('fish',{op:'sql',rules:[]}),input('fish',{op:'not',rules:[leaf(101)]}),input('fish',leaf('101 OR TRUE')),input('fish',leaf(2147483648)),input('fish',{...leaf(101),status:'any'}),input('fish',{op:'and',rules:[]})])assert.throws(()=>S.normalize(d));
 const q=S.compileCount({...input(),name:"x'); DROP TABLE contacts;--"},options('fish'));assert.ok(!q.text.includes('DROP'));assert.ok(!q.values.includes("x'); DROP TABLE contacts;--"));
});
test('limits reject deep, excessive, cyclic and accessor definitions',()=>{
 let r=leaf(101);for(let i=0;i<5;i++)r={op:'and',rules:[r]};assert.throws(()=>S.normalize(input('fish',r)),{code:'SEGMENT_LIMIT'});
 assert.throws(()=>S.normalize(input('fish',{op:'or',rules:Array.from({length:17},()=>leaf(101))})),{code:'SEGMENT_RULE'});
 const wide={op:'and',rules:Array.from({length:4},()=>({op:'or',rules:Array.from({length:8},(_,i)=>leaf(101+i))}))};assert.throws(()=>S.normalize(input('fish',wide)),{code:'SEGMENT_LIMIT'});
 const cyc={op:'and',rules:[]};cyc.rules=[cyc];assert.throws(()=>S.normalize(input('fish',cyc)),{code:'SEGMENT_CYCLE'});
 const d=input();Object.defineProperty(d,'name',{enumerable:true,get(){throw Error('getter executed');}});assert.throws(()=>S.normalize(d),{code:'SEGMENT_FIELDS'});
});
test('the base and every rule list require one current trusted catalog association',()=>{
 for(const o of [{}, {...options('fish'),baseListId:null},{...options('fish'),catalog:catalog('aristo')},{...options('fish'),catalog:{...catalog('fish'),current:false}}])assert.throws(()=>S.compileCount(input(),o));
 for(const mutate of [c=>c.lists.pop(),c=>c.lists[0].brand='aristo',c=>c.lists[1].available=false,c=>c.lists.push({...c.lists[1]})]){const o=options('fish');mutate(o.catalog);assert.throws(()=>S.compileCount(input(),o),{code:'SEGMENT_LIST_UNAVAILABLE'});}
});
test('actual parameterized SQL respects E/OU, base consent, opt-in, global status and brand; source drift is unknown',async()=>{
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite'),db=new PGlite();
 try{
  await db.exec(`CREATE TABLE lists(id integer PRIMARY KEY,tags varchar[],status text,optin text); CREATE TABLE subscribers(id integer PRIMARY KEY,status text); CREATE TABLE subscriber_lists(subscriber_id integer,list_id integer,status text,PRIMARY KEY(subscriber_id,list_id));
  INSERT INTO lists VALUES(17,ARRAY['fish'],'active','single'),(101,ARRAY['fish'],'active','single'),(102,ARRAY['fish'],'active','double'),(16,ARRAY['aristo'],'active','single'),(201,ARRAY['aristo'],'active','single'),(202,ARRAY['aristo'],'active','double');
  INSERT INTO subscribers SELECT n,CASE n WHEN 4 THEN 'blocklisted' WHEN 5 THEN 'disabled' ELSE 'enabled' END FROM generate_series(1,12)n;
  INSERT INTO subscriber_lists SELECT n,l,'confirmed' FROM generate_series(1,10)n CROSS JOIN unnest(ARRAY[17,101,102])l WHERE n<>6 OR l<>17;
  UPDATE subscriber_lists SET status='unconfirmed' WHERE subscriber_id=2 AND list_id IN(101,102);
  UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=3 AND list_id=101 OR subscriber_id=7 AND list_id=17;
  UPDATE subscriber_lists SET status=CASE list_id WHEN 101 THEN 'unsubscribed' ELSE 'unconfirmed' END WHERE subscriber_id=8 AND list_id IN(101,102);
  DELETE FROM subscriber_lists WHERE subscriber_id=9 AND list_id<>17;
  UPDATE subscriber_lists SET status='unconfirmed' WHERE subscriber_id=10 AND list_id=17;
  INSERT INTO subscriber_lists SELECT n,l,CASE WHEN n=12 AND l<>16 THEN 'unconfirmed' ELSE 'confirmed' END FROM generate_series(11,12)n CROSS JOIN unnest(ARRAY[16,201,202])l;`);
  const provider=fs.readFileSync(path.join(__dirname,'../n8n/growth/campaign-provider.sql'),'utf8'),classifier=provider.slice(provider.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_campaign_list_brand'),provider.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_campaign_catalog'));await db.exec(classifier);
  const run=async(brand,op)=>{const q=S.compileCount(input(brand,{op,rules:(brand==='fish'?[101,102]:[201,202]).map(leaf)}),options(brand));return (await db.query(q.text,q.values)).rows[0];};
  assert.equal(Number((await run('fish','and')).eligible_count),2);assert.equal(Number((await run('fish','or')).eligible_count),4);assert.equal(Number((await run('aristo','and')).eligible_count),1);assert.equal(Number((await run('aristo','or')).eligible_count),2);
  await db.exec("UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=1 AND list_id=102");assert.equal(Number((await run('fish','and')).eligible_count),1);assert.equal(Number((await run('fish','or')).eligible_count),4);
  for(const sql of ["UPDATE lists SET status='archived' WHERE id=102","UPDATE lists SET status='active',tags=ARRAY['aristo'] WHERE id=102","UPDATE lists SET tags=ARRAY['fish'],optin='unknown' WHERE id=102"]){await db.exec(sql);const row=await run('fish','or');assert.equal(row.source_confirmed,false);assert.equal(row.eligible_count,null);assert.ok(row.checked_at);}
  await db.exec("UPDATE lists SET optin='double' WHERE id=102;DELETE FROM lists WHERE id=17");assert.equal((await run('fish','or')).eligible_count,null);
 }finally{await db.close();}
});
