'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createSourceAdapter}=require('../n8n/growth/journey-graph-source.cjs');
const id=n=>'30000000-0000-4000-8000-'+String(n).padStart(12,'0');
async function setup(db){
 if(!db){const {PGlite}=require('@electric-sql/pglite');db=new PGlite();}
 await db.exec(`CREATE TABLE subscribers(id integer PRIMARY KEY,uuid uuid NOT NULL,email text,status text,attribs jsonb);CREATE TABLE lists(id integer PRIMARY KEY,tags varchar[]);CREATE TABLE subscriber_lists(subscriber_id integer,list_id integer,status text,PRIMARY KEY(subscriber_id,list_id));CREATE TABLE shrigma_email_dispatch(dispatch_id uuid PRIMARY KEY,brand text,flow text,piece text,dedupe_key text,is_test boolean,transport_state text);CREATE TABLE shrigma_send_log(id integer PRIMARY KEY,brand text,flow text,piece text,channel text,subscriber_id integer,ref text);
 INSERT INTO lists VALUES(17,ARRAY['fish']),(22,ARRAY['fish']),(16,ARRAY['aristo']),(21,ARRAY['aristo']);`);
 await db.exec(fs.readFileSync(path.join(__dirname,'../n8n/growth/journey-graph-store.sql'),'utf8'));
 await db.exec(fs.readFileSync(path.join(__dirname,'../n8n/growth/journey-graph-source.sql'),'utf8'));
 const now=(await db.query("SELECT to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') t")).rows[0].t;
 const ref=new Date(Date.parse(now)-1800000).toISOString();
 const a={cart_id:'synthetic-cart',cart_abandoned_at:ref,cart_url:'https://example.invalid/checkouts/synthetic',cart_items:[{titulo:'Synthetic',qtd:2,preco:12.3,imagem:'https://example.invalid/product.png'}],cart_value:24.6,mkt_consent:'subscribed',flows:{}};
 await db.query("INSERT INTO subscribers VALUES(1,$1,'synthetic@example.invalid','enabled',$2::jsonb)",[id(1),JSON.stringify({fish:a,aristo:{...a,cart_id:'synthetic-aristo'},first_name:'Synthetic'})]);
 await db.exec("INSERT INTO subscriber_lists VALUES(1,17,'confirmed'),(1,22,'confirmed'),(1,16,'confirmed'),(1,21,'confirmed')");
 const query=db.query.bind(db),api=createSourceAdapter({query,collectorWorkflowIds:{fish:'syntheticFish',aristo:'syntheticAristo'}});
 const receipt=async(brand='fish',rid=id(100))=>{const r=(await query(`SELECT jsonb_build_object('subscriber_id',id,'ref',attribs->$1->>'cart_abandoned_at','cart_hash',encode(sha256(convert_to(attribs->$1->>'cart_id','UTF8')),'hex'),'material_hash',encode(sha256(convert_to(crm_graph_candidate.source_material_v1(attribs->$1,attribs->>'first_name')::text,'UTF8')),'hex')) item FROM subscribers WHERE id=1`,[brand])).rows[0];return {version:'journey_graph_source_v1',brand,receipt_id:rid,reconciled:true,observed_at:now,items:[r.item]};};
 const capture=async(brand='fish',rid=id(100))=>(await api.capture(await receipt(brand,rid))).source_refs[0];
 const read=async(source_ref,brand='fish',adapter=api)=>{const current=(await query("SELECT to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') t")).rows[0].t;return adapter.readSource({source_ref,brand,trigger:'cart.abandoned',now:current});};
 return {db,query,api,now,ref,a,receipt,capture,read};
}
module.exports={setup,id};
