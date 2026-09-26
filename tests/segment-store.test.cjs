'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const S=require('../n8n/growth/segment-contract');
const sql=fs.readFileSync(path.join(__dirname,'../n8n/growth/segment-store.sql'),'utf8');
const provider=fs.readFileSync(path.join(__dirname,'../n8n/growth/campaign-provider.sql'),'utf8');
const classifier=provider.slice(provider.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_campaign_list_brand'),provider.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_campaign_catalog'));
const leaf=list_id=>({op:'in_list',list_id});
const definition=(brand='fish',rule={op:'and',rules:(brand==='fish'?[101,102]:[201,202]).map(leaf)})=>({schema_version:S.VERSION,brand,name:'Segmento sintético',rule});
const caps=['read_content','draft'];
async function setup(t,{enabled=true}={}){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE TABLE lists(id integer PRIMARY KEY,tags varchar[],status text,optin text);CREATE TABLE subscribers(id integer PRIMARY KEY,status text);CREATE TABLE subscriber_lists(subscriber_id integer,list_id integer,status text,PRIMARY KEY(subscriber_id,list_id));
 INSERT INTO lists VALUES(17,ARRAY['fish'],'active','single'),(101,ARRAY['fish'],'active','single'),(102,ARRAY['fish'],'active','double'),(16,ARRAY['aristo'],'active','single'),(201,ARRAY['aristo'],'active','single'),(202,ARRAY['aristo'],'active','double');
 INSERT INTO subscribers SELECT n,CASE n WHEN 4 THEN 'blocklisted' WHEN 5 THEN 'disabled' ELSE 'enabled' END FROM generate_series(1,8)n;
 INSERT INTO subscriber_lists SELECT n,l,'confirmed' FROM generate_series(1,6)n CROSS JOIN unnest(ARRAY[17,101,102])l;
 UPDATE subscriber_lists SET status='unconfirmed' WHERE subscriber_id=2 AND list_id=102;
 UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=3 AND list_id=101 OR subscriber_id=6 AND list_id=17;
 INSERT INTO subscriber_lists SELECT n,l,CASE WHEN n=8 AND l=202 THEN 'unconfirmed' ELSE 'confirmed' END FROM generate_series(7,8)n CROSS JOIN unnest(ARRAY[16,201,202])l;`);
 await db.exec(classifier);await db.exec(sql);
 if(enabled)await db.exec("UPDATE shrigma_segment_config SET enabled=true,base_list_id=CASE brand WHEN 'fish' THEN 17 ELSE 16 END");
 const api=async(p,actor='panel:growth:synthetic',capabilities=caps)=>(await db.query('SELECT public.shrigma_segment_api_v1($1,$2::jsonb,$3::jsonb) AS result',[actor,JSON.stringify(capabilities),JSON.stringify(p)])).rows[0].result;
 return{db,api,create:(brand='fish',key='create-0001')=>api({acao:'segmento_criar',brand,idempotency_key:key,definition:definition(brand)})};
}
test('fresh installation is OFF, no send; a second installation cannot overwrite it',async t=>{
 const {db,api,create}=await setup(t,{enabled:false});
 const listed=await api({acao:'segmentos_listar',brand:'fish'});assert.equal(listed._http,200);assert.deepEqual(listed._body.segments,[]);assert.deepEqual(listed._body.capabilities,{draft:false,count:false,send:false});
 assert.equal((await create())._http,503);assert.equal((await db.query('SELECT count(*) n FROM shrigma_segment')).rows[0].n,0);
 await assert.rejects(db.exec(sql),/SEGMENT_INSTALL_COLLISION/);await db.exec('ROLLBACK');
 assert.equal((await db.query('SELECT count(*) n FROM shrigma_segment_config')).rows[0].n,2);
 const acl=(await db.query("SELECT proname,prosecdef,EXISTS(SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute FROM pg_proc WHERE proname LIKE 'shrigma_segment_%' ORDER BY proname")).rows;
 assert.equal(acl.length,5);assert.ok(acl.every(x=>!x.prosecdef&&!x.public_execute));
});
test('create/save/archive are versioned, atomic, replayable and retain original receipts',async t=>{
 const {db,api,create}=await setup(t);const first=await create();assert.equal(first._http,201);const s=first._body.segment;
 assert.equal(s.version,1);assert.equal(first._body.transport_supported,false);assert.deepEqual(await create(),first);
 const save={acao:'segmento_salvar',brand:'fish',id:s.id,expected_version:1,idempotency_key:'save-0001',definition:{...definition(),name:'Revisão 2'}};
 const saved=await api(save);assert.equal(saved._http,200);assert.equal(saved._body.segment.version,2);
 assert.deepEqual(await api(save),saved);assert.deepEqual(await create(),first);
 const stale={...save,idempotency_key:'save-stale',definition:{...definition(),name:'Outro nome'}};const rejected=await api(stale);assert.equal(rejected._http,409);assert.equal(rejected._body.current_version,2);
 const archived=await api({acao:'segmento_arquivar',brand:'fish',id:s.id,expected_version:2,idempotency_key:'archive-01'});assert.equal(archived._body.segment.version,3);assert.equal(archived._body.segment.archived,true);
 assert.deepEqual(await api(stale),rejected);assert.deepEqual(await api({acao:'segmento_operacao',brand:'fish',idempotency_key:'save-stale'}),rejected);
 assert.equal((await api({...save,expected_version:3,idempotency_key:'save-after-archive'}))._body.error,'SEGMENT_ARCHIVED');
 assert.equal((await api({acao:'segmento_obter',brand:'fish',id:s.id}))._body.segment.archived,true);
 assert.deepEqual((await db.query('SELECT version,archived FROM shrigma_segment_revision ORDER BY version')).rows,[{version:1,archived:false},{version:2,archived:false},{version:3,archived:true}]);
 assert.equal((await api({acao:'segmentos_listar',brand:'fish'}))._body.segments.length,1);
 await db.exec('BEGIN');await api({acao:'segmento_criar',brand:'aristo',idempotency_key:'rollback-create',definition:definition('aristo')});await db.exec('ROLLBACK');
 assert.equal((await api({acao:'segmento_operacao',brand:'aristo',idempotency_key:'rollback-create'}))._body.error,'SEGMENT_OPERATION_UNCONFIRMED');
 assert.equal((await db.query('SELECT count(*) n FROM shrigma_segment')).rows[0].n,1);
});
test('actor, exact payload, brand and capabilities bind operations; missing never authorizes retry',async t=>{
 const {api,create,db}=await setup(t);const made=await create();const id=made._body.segment.id;
 assert.equal((await api({acao:'segmento_criar',brand:'fish',idempotency_key:'create-0001',definition:{...definition(),name:'Different'}}))._body.error,'SEGMENT_OPERATION_MISMATCH');
 assert.equal((await api({acao:'segmento_operacao',brand:'aristo',idempotency_key:'create-0001'}))._body.error,'SEGMENT_OPERATION_MISMATCH');
 assert.equal((await api({acao:'segmento_operacao',brand:'fish',idempotency_key:'create-0001'},'panel:growth:other'))._body.error,'SEGMENT_OPERATION_UNCONFIRMED');
 assert.equal((await api({acao:'segmento_obter',brand:'aristo',id}))._http,404);
 for(const [actor,cs] of [['',caps],['panel:growth:synthetic',[]],['panel:growth:synthetic',['publish']]])assert.equal((await api({acao:'segmento_criar',brand:'fish',definition:definition(),idempotency_key:'denied-001'},actor,cs))._http,403);
 assert.equal((await api({acao:'segmento_operacao',brand:'fish',idempotency_key:'create-0001'},'panel:growth:synthetic',[]))._http,403);
 await db.exec('UPDATE shrigma_segment_config SET enabled=false');assert.deepEqual(await create(),made);assert.deepEqual(await api({acao:'segmento_operacao',brand:'fish',idempotency_key:'create-0001'}),made);
 assert.equal((await api({acao:'segmentos_listar',brand:'fish',limit:101}))._http,422);
 assert.equal((await db.query('SELECT count(*) n FROM shrigma_segment')).rows[0].n,1);
});
test('unsafe rules, unavailable/foreign lists and malformed requests never create a segment',async t=>{
 const {api,db}=await setup(t);let i=0;
 for(const d of [{...definition(),sql:'OR TRUE'},definition('olivas'),definition('fish',leaf('101 OR TRUE')),definition('fish',leaf(201)),definition('fish',{op:'sql',rules:[]}),definition('fish',{op:'not',rules:[leaf(101)]}),definition('fish',leaf(9999)),{...definition(),name:''}]){
  const res=await api({acao:'segmento_criar',brand:'fish',idempotency_key:'invalid-'+(++i),definition:d});assert.equal(res._http,422,JSON.stringify(res));
 }
 await db.exec("UPDATE lists SET tags=ARRAY['aristo'] WHERE id=17");assert.equal((await api({acao:'segmento_criar',brand:'fish',idempotency_key:'bad-base-1',definition:definition()}))._body.error,'SEGMENT_LIST_UNAVAILABLE');
 assert.equal((await db.query('SELECT count(*) n FROM shrigma_segment')).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*) n FROM subscribers')).rows[0].n,8);
 assert.equal((await db.query('SELECT count(*) n FROM lists')).rows[0].n,6);
});
test('stored and pure parameterized counts agree for both brands; source drift is unknown and revisions are pinned',async t=>{
 const {api,db,create}=await setup(t);for(const brand of ['fish','aristo'])for(const op of ['and','or']){
  const d=definition(brand,{op,rules:(brand==='fish'?[101,102]:[201,202]).map(leaf)});
  const q=S.compileCount(d,{catalog:{brand,current:true,lists:(brand==='fish'?[17,101,102]:[16,201,202]).map(id=>({id,brand,available:true}))},baseListId:brand==='fish'?17:16});
  const expected=(await db.query(q.text,q.values)).rows[0];const got=await api({acao:'segmento_contar',brand,definition:d});assert.equal(got._http,200);assert.equal(got._body.source_confirmed,true);assert.equal(got._body.eligible_count,Number(expected.eligible_count));assert.ok(got._body.checked_at);assert.equal(got._body.transport_supported,false);assert.equal(got._body.segment_id,null);assert.equal(got._body.version,null);assert.ok(!JSON.stringify(got).includes('subscriber_id'));
 }
 const s=(await create())._body.segment;const p={acao:'segmento_contar',brand:'fish',id:s.id,expected_version:1};assert.equal((await api(p))._body.eligible_count,1);
 assert.equal((await api({...p,expected_version:2}))._body.error,'SEGMENT_VERSION_CONFLICT');assert.equal((await api({...p,definition:definition()}))._body.error,'SEGMENT_COUNT_INPUT');
 await db.exec("UPDATE lists SET status='archived' WHERE id=102");const unknown=await api(p);assert.equal(unknown._body.source_confirmed,false);assert.equal(unknown._body.eligible_count,null);
});
test('SQL canonical definitions agree with pure contract including equivalent nested children',async t=>{
 const {db}=await setup(t);const variants=[definition(),definition('fish',{op:'or',rules:[leaf(102),leaf(101),leaf(102)]}),definition('fish',{op:'or',rules:[leaf(101),{op:'and',rules:[leaf(101)]}]}),definition('fish',{op:'and',rules:[{op:'or',rules:[leaf(102),leaf(101)]},leaf(102)]})];
 for(const d of variants){const row=(await db.query('SELECT shrigma_segment_definition_v1($1::jsonb) d',[JSON.stringify(d)])).rows[0];assert.deepEqual(row.d,S.normalize(d));}
});
test('failure while storing receipt rolls back segment and revision together; retry after proven rollback creates once',async t=>{
 const {db,api,create}=await setup(t);
 await db.exec("CREATE FUNCTION fail_synthetic_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_RECEIPT_FAILURE'; END $$;CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON shrigma_segment_request FOR EACH ROW EXECUTE FUNCTION fail_synthetic_receipt()");
 await assert.rejects(create(),/SYNTHETIC_RECEIPT_FAILURE/);
 for(const table of ['shrigma_segment','shrigma_segment_revision','shrigma_segment_request'])assert.equal((await db.query('SELECT count(*) n FROM '+table)).rows[0].n,0);
 await db.exec('DROP TRIGGER synthetic_receipt_failure ON shrigma_segment_request');assert.equal((await create())._http,201);
 assert.deepEqual((await api({acao:'segmentos_listar',brand:'fish'},'panel:growth:reader',['read_content']))._body.capabilities,{draft:false,count:true,send:false});
});
