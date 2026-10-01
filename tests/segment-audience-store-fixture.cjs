'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const S=require('../n8n/growth/segment-audience-store.cjs'),API=require('../n8n/growth/segment-audience-api.cjs'),H=require('../n8n/growth/segment-audience-review.cjs'),Shopify=require('../n8n/growth/segment-shopify-facts.cjs');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8'),hash=x=>createHash('sha256').update(x).digest('hex');
const definition=(brand='fish',rule={op:'condition',field:'purchase.count',operator:'gt',value:0})=>({schema_version:'crm-audience-v2',brand,name:'Synthetic audience '+brand,rule});
// This fixture installs the pre-recorded-origin schema; the prospective fixture
// adds its source only after that migration. RFM is also added only by its own
// migration; growing the JS allowlist must not change this earlier SQL tier.
function source(brand){const catalog={currency:'BRL',timezone:'America/Sao_Paulo',shop_id:'gid://shopify/Shop/'+(brand==='fish'?'1':'2'),products:[{id:'gid://shopify/Product/'+(brand==='fish'?'101':'201'),brand,name:'Synthetic product',available:true}],origins:['popup','vip_alma','vip_desodorante'].map(key=>({key,brand,name:key,available:true,provenance_hash:H.digest({brand,key,kind:'synthetic'})}))};catalog.fields=Object.keys(require('../n8n/growth/segment-audience-contract.js').FIELDS).filter(key=>!['signup.recorded_origin','relationship.rfm'].includes(key)).map(key=>({key,available:true,source_hash:Shopify.FIELDS.includes(key)?Shopify.sourceHash(brand,key,catalog):H.digest({brand,key})}));return catalog;}
// Generic Store/Binding fixtures need valid semantic pins before the private
// facts schema exists. These stubs expose only aggregate freshness and make
// every per-subscriber fact unknown; real Shopify fixtures drop all three.
const SHOPIFY_STUB_SQL=`
CREATE FUNCTION crm_audience_v2.shopify_snapshot(text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('current',true,'started_at','2026-09-29T00:00:00Z'::timestamptz,
  'observed_at','2026-09-29T00:01:00Z'::timestamptz,'expires_at','2026-09-30T02:00:00Z'::timestamptz,
  'customers',0,'mapped',0,'unresolved',0)
$$;
CREATE FUNCTION crm_audience_v2.shopify_source_current(text,text,text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
CREATE FUNCTION crm_audience_v2.shopify_customer_match(jsonb,integer,text,text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT NULL::boolean$$;
-- Generic fixtures have no private facts: their scalar leaf is unknown for
-- every eligible native contact. Real Shopify fixtures drop this stub too.
CREATE FUNCTION crm_audience_v2.shopify_count_for_rule(rule jsonb,b text,base_list_id integer,catalog jsonb)
RETURNS TABLE(source_confirmed boolean,eligible_count bigint,checked_at timestamptz) LANGUAGE plpgsql STABLE AS $$
BEGIN
 IF rule->>'op' IS DISTINCT FROM 'condition' OR rule->>'field' NOT IN('purchase.count','purchase.amount','purchase.last_date','purchase.product') THEN RAISE EXCEPTION 'SYNTHETIC_SCALAR_LEAF_REQUIRED'; END IF;
 RETURN QUERY SELECT count(*)=0,CASE WHEN count(*)=0 THEN 0::bigint ELSE NULL::bigint END,statement_timestamp()
 FROM public.subscribers s JOIN public.subscriber_lists sl ON sl.subscriber_id=s.id
 JOIN public.lists l ON l.id=sl.list_id WHERE s.status='enabled' AND sl.list_id=base_list_id
 AND l.status='active' AND public.shrigma_campaign_list_brand(l)=b
 AND ((l.optin='double' AND sl.status='confirmed') OR (l.optin='single' AND sl.status IN('confirmed','unconfirmed')));
END $$;`;
async function dropShopifyStubs(db){await db.exec('DROP FUNCTION IF EXISTS crm_audience_v2.shopify_count_for_rule(jsonb,text,integer,jsonb),crm_audience_v2.shopify_customer_match(jsonb,integer,text,text),crm_audience_v2.shopify_source_current(text,text,text),crm_audience_v2.shopify_snapshot(text)');}
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
 await db.exec(read('n8n/growth/segment-audience-store.sql'));await db.exec(SHOPIFY_STUB_SQL);await db.exec("SET statement_timeout='20s'");
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
module.exports={setup,definition,source,read,dropShopifyStubs};
