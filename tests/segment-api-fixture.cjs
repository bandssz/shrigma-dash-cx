'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const D=require('../n8n/growth/segment-api.cjs');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8'),hash=x=>createHash('sha256').update(x).digest('hex');
const definition=(brand='fish')=>({schema_version:'crm-segment-v1',brand,name:'Segmento sintético',rule:{op:'and',rules:(brand==='fish'?[101,102]:[201,202]).map(list_id=>({op:'in_list',list_id}))}});
async function setup(db,{enabled=true}={}){
 const exec=db.exec?sql=>db.exec(sql):sql=>db.query(sql);
 await exec(read('tests/fixtures/journey-graph-auth.sql'));
 await exec("CREATE TABLE public.shrigma_panel_permission_v1(principal_id text,area text,caps jsonb,PRIMARY KEY(principal_id,area));");
 const auth=read('n8n/access/panel-short-keys.sql'),start=auth.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_panel_operator_v1(k text,a text)'),end=auth.indexOf('REVOKE ALL ON FUNCTION public.shrigma_panel_operator_v1(text,text) FROM PUBLIC;',start);if(start<0||end<start)throw Error('FIXTURE_AUTH_DRIFT');await exec(auth.slice(start,end)+'REVOKE ALL ON FUNCTION public.shrigma_panel_operator_v1(text,text) FROM PUBLIC;');
 for(const [actor,area,caps]of [['manager','growth',['draft','read_content']],['other','growth',['draft','read_content']],['reader','growth',['read_content']],['writer','growth',['draft']],['cx','cx',['draft','read_content']]]){
  await db.query('INSERT INTO crm_dash_chave(chave,painel,dono,chave_hash,chave_hash_curta) VALUES($1,$2,$1,$3,$4)',[actor,area,hash('synthetic-'+actor+'-key'),actor==='manager'?hash('synshort'):null]);
  await db.query("INSERT INTO shrigma_panel_permission_v1 VALUES($1,'growth',$2)",[actor,JSON.stringify(caps)]);
 }
 await exec(`CREATE TABLE lists(id integer PRIMARY KEY,name text,tags varchar[],status text,optin text);CREATE TABLE subscribers(id integer PRIMARY KEY,status text);CREATE TABLE subscriber_lists(subscriber_id integer,list_id integer,status text,PRIMARY KEY(subscriber_id,list_id));
 INSERT INTO lists VALUES(17,'Base Fish',ARRAY['fish'],'active','single'),(101,'Fish A',ARRAY['fish'],'active','single'),(102,'Fish B',ARRAY['fish'],'active','double'),(16,'Base Aristo',ARRAY['aristo'],'active','single'),(201,'Aristo A',ARRAY['aristo'],'active','single'),(202,'Aristo B',ARRAY['aristo'],'active','double');
 INSERT INTO subscribers SELECT n,CASE n WHEN 4 THEN 'blocklisted' WHEN 5 THEN 'disabled' ELSE 'enabled' END FROM generate_series(1,8)n;
 INSERT INTO subscriber_lists SELECT n,l,'confirmed' FROM generate_series(1,6)n CROSS JOIN unnest(ARRAY[17,101,102])l;
 UPDATE subscriber_lists SET status='unconfirmed' WHERE subscriber_id=2 AND list_id=102;
 UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=3 AND list_id=101 OR subscriber_id=6 AND list_id=17;
 INSERT INTO subscriber_lists SELECT n,l,CASE WHEN n=8 AND l=202 THEN 'unconfirmed' ELSE 'confirmed' END FROM generate_series(7,8)n CROSS JOIN unnest(ARRAY[16,201,202])l;`);
 const provider=read('n8n/growth/campaign-provider.sql');await exec(provider.slice(provider.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_campaign_list_brand'),provider.indexOf('CREATE OR REPLACE FUNCTION public.shrigma_campaign_catalog')));
 await exec(read('n8n/growth/segment-store.sql'));await exec(D.INSTALL_SQL);
 if(enabled)await exec("UPDATE shrigma_segment_config SET enabled=true,base_list_id=CASE brand WHEN 'fish' THEN 17 ELSE 16 END");
 await exec("SET statement_timeout='20s'");
 const entry=(p,key='synthetic-manager-key',method=['segmento_contar','segmento_criar','segmento_salvar','segmento_arquivar'].includes(p.acao)?'POST':'GET')=>D.API.parse({method,request:{headers:{authorization:'Bearer '+key},[method==='POST'?'body':'query']:p}});
 const query=async e=>(await db.query(D.QUERY,[e.key,JSON.stringify(e.request)])).rows[0].result;
 const call=async(p,key)=>{const e=entry(p,key);return e.route==='response'?e.response:D.API.finish(e,await query(e)).response;};
 const create=(brand='fish',key='create-0001')=>({acao:'segmento_criar',brand,idempotency_key:key,definition:definition(brand)});
 return {db,exec,entry,query,call,create};
}
module.exports={setup,definition,read};
