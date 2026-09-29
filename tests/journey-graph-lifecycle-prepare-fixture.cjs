'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const Catalog=require('../n8n/growth/journey-graph-catalog.cjs');
const {createGraphRuntime}=require('../n8n/growth/journey-graph-runtime.cjs');
const {createLifecyclePreparer}=require('../n8n/growth/journey-graph-lifecycle-prepare.cjs');
const {createDraftApi}=require('../n8n/growth/journey-graph-draft-api.cjs');
const {body,graph}=require('./journey-graph-release-fixture.cjs');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const id=n=>'81000000-0000-4000-8000-'+String(n).padStart(12,'0');
const checkoutSha='a'.repeat(40),authorization='Bearer synthetic-manager-key';
async function fixture(t,brand='fish',dependencies={}){
 const db=dependencies.db||new PGlite();if(!dependencies.db)t.after(()=>db.close());
 await db.exec(read('tests/fixtures/journey-graph-auth.sql'));await db.exec(read('n8n/access/panel-operator.sql'));
 const authSource=read('n8n/access/panel-short-keys.sql'),authStart=authSource.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_panel_operator_v1(k text,a text)'),authEnd=authSource.indexOf('REVOKE ALL ON FUNCTION public.shrigma_panel_operator_v1(text,text) FROM PUBLIC;',authStart);
 if(authStart<0||authEnd<authStart)throw Error('Missing current authentication helper');
 await db.exec(authSource.slice(authStart,authEnd)+'REVOKE ALL ON FUNCTION public.shrigma_panel_operator_v1(text,text) FROM PUBLIC;');
 for(const who of ['manager','other']){
  await db.query('INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash) VALUES($1,\'growth\',$1,$2)',[who,createHash('sha256').update('synthetic-'+who+'-key').digest('hex')]);
  await db.query("INSERT INTO shrigma_panel_permission_v1 VALUES($1,'growth','[\"draft\",\"read_content\",\"validate\",\"submit\"]')",[who]);
 }
 await db.query("UPDATE crm_dash_chave SET chave_hash_curta=$1 WHERE chave='manager'",[createHash('sha256').update('synshort').digest('hex')]);
 await db.exec(read('n8n/growth/journey-graph-store.sql'));
 await db.exec('CREATE TABLE templates(id integer PRIMARY KEY,name text,type text,subject text,body text,body_source text);CREATE TABLE shrigma_template_email_registry(template_id integer,brand text);CREATE TABLE shrigma_flow_definition(key text PRIMARY KEY,brand text,runtime_ready boolean,published_version integer,published jsonb);');
 for(const b of ['fish','aristo']){
  const tid=b==='fish'?60:95;
  await db.query('INSERT INTO templates VALUES($1,$2,\'tx\',\'Carrinho sintético\',$3,NULL)',[tid,'Synthetic '+b,body(b)]);
  await db.query('INSERT INTO shrigma_template_email_registry VALUES($1,$2)',[tid,b]);
  await db.query('INSERT INTO shrigma_flow_definition VALUES($1,$2,true,6,$3::jsonb)',[b+':carrinho',b,JSON.stringify(graph(b))]);
 }
 await db.exec(read('n8n/growth/journey-graph-release.sql'));await db.exec(read('n8n/growth/journey-graph-catalog.sql'));await db.exec(read('n8n/growth/journey-graph-lifecycle-prepare.sql'));
 await db.query("SET statement_timeout='20s'");
 const calls=[],control={before:null,after:null,discards:0},pool={async connect(){const connection=dependencies.pool?await dependencies.pool.connect():null;return {async query(sql,args){calls.push(sql);if(control.before)await control.before(sql,args,connection);const r=await (connection||db).query(sql,args);if(control.after)await control.after(sql,args,connection);return r;},release(error){if(error)control.discards++;connection?.release(error);}};}};
 const runtime=createGraphRuntime({pool,catalogFor:Catalog.catalogFor,readSource:()=>{throw Error('Unexpected enrollment');}});
 const definition={version:'journey_graph_v1',brand,name:'Preparação sintética',nodes:[{id:'entry',type:'trigger',event:'cart.abandoned'},{id:'mail',type:'message',binding:'email.template.'+(brand==='fish'?60:95)},{id:'end',type:'exit',reason:'finished'}],edges:[{from:'entry',port:'next',to:'mail'},{from:'mail',port:'next',to:'end'}]};
 const original=await runtime.create({request_id:id(1),actor:'panel:manager',brand,definition});
 let seq=100,offset=0;const options={pool,checkoutSha,clock:()=>Date.now()+offset},api=createLifecyclePreparer(options);
 const reviewRequest={action:'review',brand,journey_id:original.journey_id,expected_version:original.version};
 const review=()=>api.review(reviewRequest,{authorization});
 const request=r=>({action:'prepare',brand,journey_id:original.journey_id,expected_version:original.version,request_id:id(seq++),review_hash:r.review.review_hash,confirm:'preparar'});
 const prepare=(p,target=api)=>target.prepare(p,{authorization});
 const operation=(p,target=api,auth=authorization)=>target.operation({action:'operation',brand:p.brand,request_id:p.request_id},{authorization:auth});
 const count=async table=>(await db.query('SELECT count(*)::int n FROM crm_graph_candidate.'+table)).rows[0].n;
 const get=()=>createDraftApi({pool,catalogFor:Catalog.catalogFor}).handle({method:'GET',authorization,request:{action:'get',brand,journey_id:original.journey_id}});
 return {db,pool,control,calls,options,api,runtime,definition,original,brand,reviewRequest,review,request,prepare,operation,count,get,offset:n=>offset=n,id,authorization,read};
}
module.exports={fixture,id,read,checkoutSha,authorization};
