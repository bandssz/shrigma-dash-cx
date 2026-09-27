'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const G=require('../n8n/growth/journey-graph-contract.js'),R=require('../n8n/growth/journey-graph-release.cjs');
const {createGraphRuntime}=require('../n8n/growth/journey-graph-runtime.cjs'),{createSourceAdapter}=require('../n8n/growth/journey-graph-source.cjs');
const {setup,id}=require('./journey-graph-source-fixture.cjs'),{body,graph:legacyGraph}=require('./journey-graph-release-fixture.cjs');
const copy=x=>JSON.parse(JSON.stringify(x));
function definition(brand,binding){return {version:G.VERSION,brand,name:'Carrinho sintético',nodes:[{id:'start',type:'trigger',event:'cart.abandoned'},{id:'message',type:'message',binding},{id:'end',type:'exit',reason:'finished'}],edges:[{from:'start',to:'message',port:'next'},{from:'message',to:'end',port:'next'}]};}
function planning(source){return {version:G.VERSION,brand:source.brand,triggers:[{key:'cart.abandoned',brand:source.brand,available:true,fields:['purchase.confirmed','contact.email_allowed']}],fields:['purchase.confirmed','contact.email_allowed'].map(key=>({key,type:'boolean',available:true,max_age_seconds:300})),messages:[{key:source.binding,brand:source.brand,channel:'email',available:true,release:source.source_snapshot,required_fields:[]}]};}
async function fixture(t,db,providedPool){
 const x=await setup(db);t.after(()=>x.db.close());await x.db.exec('CREATE TABLE templates(id integer PRIMARY KEY,name text,type text,subject text,body text,body_source text);CREATE TABLE shrigma_template_email_registry(template_id integer,brand text);CREATE TABLE shrigma_flow_definition(key text PRIMARY KEY,brand text,runtime_ready boolean,published_version integer,published jsonb);');
 for(const brand of ['fish','aristo']){const tid=brand==='fish'?60:95;await x.query('INSERT INTO templates VALUES($1,$2,$3,$4,$5,NULL)',[tid,'Synthetic '+brand,'tx','Seu carrinho',body(brand)]);await x.query('INSERT INTO shrigma_template_email_registry VALUES($1,$2)',[tid,brand]);await x.query('INSERT INTO shrigma_flow_definition VALUES($1,$2,true,6,$3)',[brand+':carrinho',brand,legacyGraph(brand)]);
  await x.query('UPDATE subscribers SET attribs=jsonb_set(attribs,ARRAY[$1],$2::jsonb) WHERE id=1',[brand,JSON.stringify({...x.a,cart_id:'synthetic-'+brand,cart_url:'https://'+(brand==='fish'?'fishermans.com.br':'oaristocrata.com')+'/cart/synthetic'})]);
 }
 await x.db.exec(fs.readFileSync(require.resolve('../n8n/growth/journey-graph-release.sql'),'utf8'));
 const provider=R.createReleaseProvider({query:x.query}),pool=providedPool||{connect:async()=>({query:x.query,release(){}})};let seq=1000;
 const sourceAdapter=createSourceAdapter({query:x.query,purchaseFor:async a=>({version:'journey_purchase_evidence_v1',source_ref:a.source_ref,subject_id:a.subject_id,brand:a.brand,complete:true,purchased:false,covered_from:a.occurred_at,covered_through:a.now,observed_at:a.now})});
 return {...x,provider,pool,sourceAdapter,async prepare(brand='fish',observed=false){
  const s=(await x.query('SELECT crm_graph_candidate.release_source_v1($1,$2) result',[brand,brand==='fish'?60:95])).rows[0].result;
  const release=await provider.prepare('panel:synthetic',{request_id:id(seq++),brand,binding:s.binding,expected_snapshot:s.source_snapshot,...(observed?{purchase_policy:R.PURCHASE_POLICY.version}:{})});
  const catalog=R.bindCatalog(observed?require('../n8n/growth/journey-graph-catalog.cjs').withObservedPurchase(planning(s),{observationPolicy:R.PURCHASE_POLICY.version}):planning(s),[release]),graph=definition(brand,s.binding),source_ref=await x.capture(brand,id(seq++));
  const settings={pool,catalogFor:async()=>copy(catalog),readSource:async args=>{const p=await sourceAdapter.readSource(args);if(observed)p.facts['purchase.observed_for_cart']={value:false,complete:true,observed_at:p.observed_at};return p;}},api=createGraphRuntime(settings),request=p=>({request_id:id(seq++),actor:'panel:synthetic',brand,...p});
  return {s,release,catalog,graph,source_ref,settings,api,request,async atMessage(){let j=await api.create(request({definition:graph}));j=await api.publish(request({journey_id:j.journey_id,expected_version:j.version,confirm:'publicar'}));assert.equal(j.paused,true);await x.query('UPDATE crm_graph_candidate.control SET enabled=true');j=await api.pause(request({journey_id:j.journey_id,expected_version:j.version,paused:false,confirm:'retomar'}));let e=await api.enroll(request({journey_id:j.journey_id,expected_version:j.version,source_ref}));return api.step(request({entry_id:e.entry_id,expected_version:e.version}));}};
 }};
}
module.exports={fixture,planning};
