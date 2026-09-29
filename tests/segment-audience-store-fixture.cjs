'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const S=require('../n8n/growth/segment-audience-store.cjs'),API=require('../n8n/growth/segment-audience-api.cjs'),H=require('../n8n/growth/segment-audience-review.cjs');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8'),hash=x=>createHash('sha256').update(x).digest('hex');
const definition=(brand='fish',rule={op:'condition',field:'purchase.count',operator:'gt',value:0})=>({schema_version:'crm-audience-v2',brand,name:'Synthetic audience '+brand,rule});
function source(brand){return {currency:'BRL',timezone:'America/Sao_Paulo',shop_id:'gid://shopify/Shop/'+(brand==='fish'?'1':'2'),fields:Object.keys(require('../n8n/growth/segment-audience-contract.js').FIELDS).map(key=>({key,available:true,source_hash:H.digest({brand,key})})),products:[{id:'gid://shopify/Product/'+(brand==='fish'?'101':'201'),brand,name:'Synthetic product',available:true}],origins:['popup','vip_alma','vip_desodorante'].map(key=>({key,brand,name:key,available:true,provenance_hash:H.digest({brand,key,kind:'synthetic'})}))};}
async function setup(db,{enabled=true,countProvider=null,timeoutMs=1000}={}){
 await db.exec(read('tests/fixtures/journey-graph-auth.sql'));
 await db.exec('CREATE TABLE public.shrigma_panel_permission_v1(principal_id text,area text,caps jsonb,PRIMARY KEY(principal_id,area));');
 const auth=read('n8n/access/panel-short-keys.sql'),start=auth.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_panel_operator_v1(k text,a text)'),end=auth.indexOf('REVOKE ALL ON FUNCTION public.shrigma_panel_operator_v1(text,text) FROM PUBLIC;',start);await db.exec(auth.slice(start,end)+'REVOKE ALL ON FUNCTION public.shrigma_panel_operator_v1(text,text) FROM PUBLIC;');
 for(const [actor,area,caps]of [['manager','growth',['draft','read_content']],['other','growth',['draft','read_content']],['reader','growth',['read_content']],['writer','growth',['draft']],['cx','cx',['draft','read_content']]]){
  await db.query('INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash,chave_hash_curta) VALUES($1,$2,$1,$3,$4)',[actor,area,hash('synthetic-'+actor+'-key'),actor==='manager'?hash('synshort'):null]);await db.query("INSERT INTO shrigma_panel_permission_v1 VALUES($1,'growth',$2)",[actor,JSON.stringify(caps)]);
 }
 await db.exec(`CREATE TABLE lists(id integer PRIMARY KEY,name text,tags varchar[],status text,optin text);CREATE TABLE subscribers(id integer PRIMARY KEY,status text);CREATE TABLE subscriber_lists(subscriber_id integer,list_id integer,status text,PRIMARY KEY(subscriber_id,list_id));
 INSERT INTO lists VALUES(17,'Fish base',ARRAY['fish'],'active','single'),(101,'Fish double',ARRAY['fish'],'active','double'),(16,'Aristo base',ARRAY['aristo'],'active','double'),(201,'Aristo single',ARRAY['aristo'],'active','single');
 INSERT INTO subscribers VALUES(1,'enabled'),(2,'enabled'),(3,'blocklisted'),(4,'disabled'),(5,'enabled');
 INSERT INTO subscriber_lists SELECT n,l,CASE WHEN n=2 THEN 'unconfirmed' WHEN n=5 THEN 'unsubscribed' ELSE 'confirmed' END FROM generate_series(1,5)n CROSS JOIN unnest(ARRAY[17,101,16,201])l;`);
 const provider=read('n8n/growth/campaign-provider.sql');await db.exec(provider.slice(provider.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_campaign_list_brand'),provider.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_campaign_catalog')));
 await db.exec(read('n8n/growth/segment-audience-store.sql'));await db.exec("SET statement_timeout='20s'");
 const refresh=async brand=>db.query("UPDATE crm_audience_v2.config SET enabled=true,base_list_id=$2,revision=revision+1,catalog=$3::jsonb,checked_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()+interval '4 minutes' WHERE brand=$1",[brand,brand==='fish'?17:16,JSON.stringify(source(brand))]);
 if(enabled)for(const brand of ['fish','aristo'])await refresh(brand);
 const trace=[],control={beforeQuery:null,afterQuery:null,afterCommit:null},transaction=async(work,options)=>{
  const result=await db.transaction(async tx=>work({query:async(text,values=[])=>{trace.push({text,values});if(control.beforeQuery)await control.beforeQuery(text,values,tx,options);const r=await tx.query(text,values);if(control.afterQuery)await control.afterQuery(text,values,tx,options,r);return r;}}));
  if(control.afterCommit)await control.afterCommit(result);return result;
 };
 const store=S.createAudienceStore({transaction,countProvider,timeoutMs}),api=API.createAudienceAPI({store});
 const call=(p,key='synthetic-manager-key')=>api.handle({method:['segmento_criar','segmento_salvar','segmento_arquivar','segmento_contar'].includes(p.acao)?'POST':'GET',request:{headers:{Authorization:'Bearer '+key},[p.acao==='segmento_criar'||p.acao==='segmento_salvar'||p.acao==='segmento_arquivar'||p.acao==='segmento_contar'?'body':'query']:p}});
 const catalogHashes={};for(const brand of ['fish','aristo'])catalogHashes[brand]=(await call({acao:'segmentos_listar',brand,limit:50,offset:0})).body.catalog.catalog_hash;
 const create=(brand='fish',idempotency_key='create-0001',rule)=>({acao:'segmento_criar',brand,idempotency_key,definition:definition(brand,rule),expected_catalog_hash:catalogHashes[brand]});
 return {db,store,api,call,create,control,trace,transaction,refresh,catalogHashes};
}
module.exports={setup,definition,source,read};
