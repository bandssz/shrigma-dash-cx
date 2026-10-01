'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const Patch=require('../n8n/growth/attribution-recipient-workflow.cjs');

const repo=path.join(__dirname,'..');
// Four published code/read nodes; the other 26 nodes are synthetic placeholders.
// No private export or secret is required by CI. Deployment uses the default
// pinned full production export, not this explicit fixture fingerprint.
const sourceText=fs.readFileSync(path.join(__dirname,'fixtures/attribution-recipient-workflow.json'),'utf8');
const expectedSourceSha256=Patch.sha(sourceText);
const query=fs.readFileSync(path.join(repo,'n8n/growth/attribution-query-candidate.graphql'),'utf8');
const projection=fs.readFileSync(path.join(repo,'n8n/growth/attribution.js'),'utf8');
const schema=fs.readFileSync(path.join(repo,'n8n/growth/attribution-schema.sql'),'utf8');
const source=JSON.parse(sourceText);
const built=()=>Patch.patchAttributionRecipientWorkflow(sourceText,{expectedVersionId:Patch.VERSION_ID,expectedSourceSha256,query,projection});
const node=(workflow,name)=>workflow.nodes.find(n=>n.name===name);
const without=(value,key)=>{const copy=structuredClone(value);delete copy[key];return copy;};

const visit=(at='2026-09-29T11:00:00Z')=>({occurredAt:at,source:'email',referrerUrl:null,
 utmParameters:{source:'listmonk',medium:'campanha',campaign:'recipient-proof',content:'cta',term:''}});
const order=(brand,id,customer,amount=99.5)=>({_marca:brand,id:`gid://shopify/Order/${id}`,name:`#${id}`,
 createdAt:'2026-09-29T12:00:00Z',updatedAt:'2026-09-29T12:01:00Z',test:false,cancelledAt:null,
 displayFinancialStatus:'PAID',customer,netPaymentSet:{shopMoney:{amount:String(amount),currencyCode:'BRL'}},
 customerJourneySummary:{ready:true,customerOrderIndex:1,firstVisit:null,lastVisit:visit(),
  moments:{pageInfo:{hasNextPage:false},nodes:[visit()]}}});
const input=[
 order('fish',101,{id:'gid://shopify/Customer/7001'},125.5),
 order('aristo',102,null,80),
 order('aristo',103,'malformed-customer',45),
 order('aristo',104,[],35),
 order('olivas',105,{id:'gid://shopify/Customer/9001'},70),
 ...['aristo','fish','olivas'].map(_marca=>({_marca,_coverage_complete:true}))
];
const scope={complete:true,mode:'updated',brands:['aristo','fish','olivas'],execution_id:'recipient-collector-synthetic-v1',
 read_at:'2026-09-30T12:00:00Z',coverage_from:'2026-09-29',coverage_until:'2026-09-29'};
function run(code){
 const context={$input:{all:()=>structuredClone(input).map(json=>({json}))},$:name=>{assert.equal(name,'Janela');return {first:()=>({json:{attrib:structuredClone(scope)}})};}};
 return vm.runInNewContext(`(function(){${code}\n})()`,context,{timeout:1000});
}

test('strict builder changes exactly the two queries and classifier code',()=>{
 const {workflow,changed_nodes}=built();
 assert.deepEqual(changed_nodes,['Atribuição lê aristo','Atribuição lê fish','Atribuição por pedido']);
 assert.equal(workflow.nodes.length,30);assert.deepEqual(workflow.connections,source.connections);assert.deepEqual(workflow.settings,source.settings);
 assert.deepEqual(workflow.activeVersion,source.activeVersion,'published activeVersion remains readback evidence, not a fabricated version');
 const changed=new Set(changed_nodes);
 for(const original of source.nodes){
  const candidate=node(workflow,original.name);assert.ok(candidate);
  if(!changed.has(original.name))assert.deepEqual(candidate,original,`unchanged node ${original.name}`);
 }
 for(const name of ['Atribuição lê aristo','Atribuição lê fish']){
  const before=node(source,name),after=node(workflow,name);
  assert.deepEqual(without(after.parameters,'jsonBody'),without(before.parameters,'jsonBody'));
  assert.deepEqual(without(after,'parameters'),without(before,'parameters'));
  assert.equal(after.parameters.url,before.parameters.url);assert.match(after.parameters.url,/\/admin\/api\/2025-01\/graphql\.json$/);
  const embedded=Patch.extractQuery(after.parameters.jsonBody);
  assert.equal(embedded,query.trimEnd());assert.equal(embedded.replace(' customer{id}',''),Patch.extractQuery(before.parameters.jsonBody));
  assert.match(after.parameters.jsonBody,/variables:\{search:\$\('Janela'\)\.first\(\)\.json\.attrib\.search,after:null\}/);
 }
 const beforeCode=node(source,'Atribuição por pedido'),afterCode=node(workflow,'Atribuição por pedido');
 assert.deepEqual(without(afterCode.parameters,'jsCode'),without(beforeCode.parameters,'jsCode'));
 assert.deepEqual(without(afterCode,'parameters'),without(beforeCode,'parameters'));
 assert.deepEqual(node(workflow,'Atribuição lê olivas'),node(source,'Atribuição lê olivas'));
});

test('builder refuses stale source, version, query and projection bytes',()=>{
 const call=(text=sourceText,version=Patch.VERSION_ID,q=query,p=projection)=>Patch.patchAttributionRecipientWorkflow(text,{expectedVersionId:version,expectedSourceSha256,query:q,projection:p});
 assert.throws(()=>call(sourceText+'\n'),/SOURCE_DRIFT/);
 assert.throws(()=>call(sourceText,'stale'),/VERSION_REQUIRED/);
 assert.throws(()=>call(sourceText,Patch.VERSION_ID,query+' '),/QUERY_DRIFT/);
 assert.throws(()=>call(sourceText,Patch.VERSION_ID,query,projection+' '),/PROJECTION_DRIFT/);
});

test('an explicitly reviewed source pin cannot bypass credentials or Olivas node pins',()=>{
 for(const name of ['Atribuição lê fish','Atribuição lê aristo','Atribuição lê olivas']){
  const changed=structuredClone(source);
  node(changed,name).parameters.url='https://unrelated.example.invalid/graphql';
  changed.activeVersion.nodes=structuredClone(changed.nodes);
  const text=JSON.stringify(changed);
  assert.throws(()=>Patch.patchAttributionRecipientWorkflow(text,{expectedVersionId:Patch.VERSION_ID,expectedSourceSha256:Patch.sha(text),query,projection}),/NODE_DRIFT/);
 }
 const changed=structuredClone(source);node(changed,'Atribuição lê fish').credentials.httpHeaderAuth.id='different-app';
 changed.activeVersion.nodes=structuredClone(changed.nodes);
 const text=JSON.stringify(changed);
 assert.throws(()=>Patch.patchAttributionRecipientWorkflow(text,{expectedVersionId:Patch.VERSION_ID,expectedSourceSha256:Patch.sha(text),query,projection}),/NODE_DRIFT/);
 assert.throws(()=>Patch.patchAttributionRecipientWorkflow(sourceText,{expectedVersionId:Patch.VERSION_ID,expectedSourceSha256:null,query,projection}),/SOURCE_PIN/);
});

test('customer identity is canonical or explicitly unknown; no malformed value survives',()=>{
 const A=require('../n8n/growth/attribution.js');
 for(const value of [null,undefined,{}, {id:null}])assert.deepEqual(A.customerIdentity(value),{customer_gid:null,customer_identity_state:'absent'});
 for(const value of ['private-invalid-value',7,true,[],{id:7001},{id:'gid://shopify/Order/7001'},{id:'gid://shopify/Customer/0'},{id:'gid://shopify/Customer/07001'},{id:'gid://shopify/Customer/7001 '},{id:'gid://shopify/Customer/'+'1'.repeat(26)}]){
  assert.deepEqual(A.customerIdentity(value),{customer_gid:null,customer_identity_state:'invalid'});
 }
 assert.deepEqual(A.customerIdentity({id:'gid://shopify/Customer/7001'}),{customer_gid:'gid://shopify/Customer/7001',customer_identity_state:'confirmed'});
});

test('real n8n wrapper adds private identity only for Fish and Aristo',()=>{
 const legacy=run(node(source,'Atribuição por pedido').parameters.jsCode).map(x=>JSON.parse(JSON.stringify(x)));
 const candidate=run(node(built().workflow,'Atribuição por pedido').parameters.jsCode).map(x=>JSON.parse(JSON.stringify(x)));
 assert.deepEqual(candidate[0].json.scope,legacy[0].json.scope);
 const oldRows=legacy[0].json.orders,newRows=candidate[0].json.orders;
 assert.equal(newRows.length,5);
 for(const row of newRows){
  const old=oldRows.find(x=>x.brand===row.brand&&x.order_id===row.order_id);assert.ok(old);
  if(row.brand==='olivas')assert.equal(JSON.stringify(row),JSON.stringify(old),'Olivas payload remains byte-structure identical');
  else assert.deepEqual(without(without(row,'customer_gid'),'customer_identity_state'),old);
  assert.equal(row.model_version,'last-non-direct-30d-v2');assert.equal(row.reason,old.reason);
  assert.equal(row.net_amount,old.net_amount);assert.deepEqual(row.last_click,old.last_click);assert.deepEqual(row.last_non_direct,old.last_non_direct);
 }
 assert.deepEqual(newRows.filter(x=>x.brand!=='olivas').map(x=>[x.order_id,x.customer_gid,x.customer_identity_state]),[
  ['gid://shopify/Order/101','gid://shopify/Customer/7001','confirmed'],
  ['gid://shopify/Order/102',null,'absent'],
  ['gid://shopify/Order/103',null,'invalid'],
  ['gid://shopify/Order/104',null,'invalid']
 ]);
 assert.equal(JSON.stringify(newRows).includes('malformed-customer'),false);
});

test('wrapper JSON persists through the unchanged v2 ingest function',async()=>{
 const rows=JSON.parse(JSON.stringify(run(node(built().workflow,'Atribuição por pedido').parameters.jsCode)[0].json.orders));
 const db=new PGlite();
 try{
  await db.exec("CREATE OR REPLACE FUNCTION public.hoje_br() RETURNS date LANGUAGE sql IMMUTABLE AS $$SELECT date '2026-09-30'$$;");
  const marker='REVOKE ALL ON FUNCTION public.crm_attribution_ingest_v2(jsonb,jsonb) FROM PUBLIC;',end=schema.indexOf(marker);
  assert.ok(end>0);await db.exec(schema.slice(0,end+marker.length));
  assert.equal((await db.query('SELECT public.crm_attribution_ingest_v2($1::jsonb,$2::jsonb) n',[JSON.stringify(rows),JSON.stringify(scope)])).rows[0].n,5);
  const stored=(await db.query('SELECT brand,order_id,payload FROM public.crm_attribution_order_v2 ORDER BY order_id')).rows;
  assert.deepEqual(stored.map(x=>x.payload),rows);
  assert.equal(stored.find(x=>x.brand==='olivas').payload.customer_identity_state,undefined);
  assert.equal(JSON.stringify(stored).includes('malformed-customer'),false);
  assert.equal((await db.query('SELECT public.crm_attribution_ingest_v2($1::jsonb,$2::jsonb) n',[JSON.stringify(rows),JSON.stringify(scope)])).rows[0].n,0);
 }finally{await db.close();}
});
