'use strict';
const fs=require('node:fs'),path=require('node:path');
const base=require('./maintenance-fixture.cjs');
const txSQL=fs.readFileSync(path.join(__dirname,'../n8n/growth/maintenance-tx-popup.sql'),'utf8');
const fixtureSQL=base.fixtureSQL.replace("b,jsonb_build_object('brand',brand),'claimed'","b,b,'claimed'")+`
CREATE FUNCTION public.shrigma_email_claim_fish(b jsonb,is_test boolean DEFAULT false) RETURNS TABLE(should_send boolean,dispatch_id uuid,claim_token uuid,payload jsonb,reason text) LANGUAGE sql AS $$SELECT should_send,dispatch_id,claim_token,payload,reason FROM public.maintenance_fixture_claim('fish','transactional',b)$$;
CREATE FUNCTION public.shrigma_email_claim_aristo(b jsonb,is_test boolean DEFAULT false) RETURNS TABLE(should_send boolean,dispatch_id uuid,claim_token uuid,payload jsonb,reason text) LANGUAGE sql AS $$SELECT should_send,dispatch_id,claim_token,payload,reason FROM public.maintenance_fixture_claim('aristo','transactional',b)$$;
CREATE FUNCTION public.shrigma_flow_slot_wa_versioned_v1(p_brand text,p_channel text,p_flow text,p_piece text,p_variant text,p_source text,p_runtime_contract text) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT '{"_managed":false}'::jsonb$$;
CREATE FUNCTION public.shrigma_flow_slot(p_brand text,p_channel text,p_flow text,p_piece text,p_variant text DEFAULT '',p_source text DEFAULT '') RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT '{"_managed":false}'::jsonb$$;
CREATE TABLE public.subscribers(id serial PRIMARY KEY,email text UNIQUE,status text NOT NULL);
CREATE TABLE public.subscriber_lists(subscriber_id integer REFERENCES subscribers,list_id integer,status text NOT NULL,PRIMARY KEY(subscriber_id,list_id));
CREATE TABLE public.maintenance_finish_log(dispatch_id uuid PRIMARY KEY,context jsonb,outcome text);
CREATE FUNCTION public.shrigma_email_transport_outcome(r jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN r->>'statusCode'='200' AND r#>>'{body,data}'='true' THEN 'accepted' WHEN r->>'statusCode' IN('400','401','403','404','422') THEN 'rejected' ELSE 'outcome_unknown' END $$;
CREATE FUNCTION public.maintenance_fixture_finish(brand text,p_id uuid,p_claim uuid,outcome text,b jsonb)
RETURNS TABLE(dispatch_id uuid,transport_state text,send_log_id bigint,error_code text) LANGUAGE plpgsql AS $$
DECLARE d public.shrigma_email_dispatch%ROWTYPE;
BEGIN
 SELECT * INTO STRICT d FROM public.shrigma_email_dispatch x WHERE x.dispatch_id=p_id FOR UPDATE;
 IF d.brand IS DISTINCT FROM brand OR d.claim_token IS DISTINCT FROM p_claim OR d.flow<>'transacional' OR d.dedupe_key IS DISTINCT FROM jsonb_build_array('email',b->>'order_id',0,false)::text THEN RAISE EXCEPTION 'SYNTHETIC_FINISH_GUARD';END IF;
 IF d.transport_state='in_flight' THEN UPDATE public.shrigma_email_dispatch x SET transport_state=outcome WHERE x.dispatch_id=p_id RETURNING * INTO d;INSERT INTO maintenance_finish_log VALUES(p_id,b,outcome);END IF;
 RETURN QUERY SELECT d.dispatch_id,d.transport_state,42::bigint,NULL::text;
END $$;
CREATE FUNCTION public.shrigma_email_finish_fish(p_id uuid,p_claim uuid,outcome text,b jsonb) RETURNS TABLE(dispatch_id uuid,transport_state text,send_log_id bigint,error_code text) LANGUAGE sql AS $$SELECT * FROM public.maintenance_fixture_finish('fish',p_id,p_claim,outcome,b)$$;
CREATE FUNCTION public.shrigma_email_finish_aristo(p_id uuid,p_claim uuid,outcome text,b jsonb) RETURNS TABLE(dispatch_id uuid,transport_state text,send_log_id bigint,error_code text) LANGUAGE sql AS $$SELECT * FROM public.maintenance_fixture_finish('aristo',p_id,p_claim,outcome,b)$$;
`;
function body(brand='fish',overrides={}){return {order_id:'order-synthetic-1',event_type:'confirmado',email:'synthetic@example.invalid',name:'Synthetic',from_email:brand==='fish'?'orders@fishermans.com.br':'orders@oaristocrata.com',reply_to:'synthetic@example.invalid',template_id:brand==='fish'?5:15,subject:'Synthetic',items:[{name:'Synthetic item',qty:1}],...overrides};}
function txAPI(db){const a=base.api(db);return {...a,
 admitTX:async (brand,b)=>(await db.query('SELECT crm_maintenance_candidate.tx_admit_v1($1,$2) receipt',[brand,JSON.stringify(b)])).rows[0].receipt,
 nextTX:async brand=>(await db.query('SELECT * FROM crm_maintenance_candidate.tx_next_v1($1)',[brand])).rows,
 claimTX:async id=>(await db.query('SELECT * FROM crm_maintenance_candidate.tx_claim_v1($1)',[id])).rows[0],
 finishTX:async (c,response)=>(await db.query('SELECT * FROM crm_maintenance_candidate.tx_finish_v1($1,$2,$3,$4)',[c.dispatch_id,c.claim_token,JSON.stringify(response),JSON.stringify(c.context)])).rows[0],
 subscriber:async (brand,email='synthetic@example.invalid',status='enabled',subscription='confirmed')=>{const s=(await db.query('INSERT INTO subscribers(email,status) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET status=EXCLUDED.status RETURNING id',[email,status])).rows[0];await db.query('INSERT INTO subscriber_lists VALUES($1,$2,$3) ON CONFLICT(subscriber_id,list_id) DO UPDATE SET status=EXCLUDED.status',[s.id,brand==='fish'?17:16,subscription]);return s.id;}
};}
module.exports={...base,fixtureSQL,txSQL,body,txAPI};
function workflow(){
 const {BRANDS,TARGET}=require('../n8n/growth/maintenance-tx-popup-patch.cjs'),{MAP}=require('../n8n/growth/maintenance-tx-popup-protocol.cjs');
 const w={id:TARGET,versionId:'synthetic-v1',activeVersionId:'synthetic-v1',active:true,name:'Synthetic TX+popup',settings:{executionOrder:'v1',saveDataSuccessExecution:'none'},nodes:[],connections:{}};
 const add=(name,type,parameters={})=>{const n={id:'node-'+w.nodes.length,name,type:'n8n-nodes-base.'+type,typeVersion:2,position:[0,0],parameters};w.nodes.push(n);return n;};
 const edge=(from,to)=>{w.connections[from]={main:[to.map(node=>({node,type:'main',index:0}))]};};
 for(const [brand,b] of Object.entries(BRANDS)){
  add(b.webhook,'webhook',{httpMethod:'POST',path:'synthetic-'+brand,options:{}});
  if(b.start!==b.derive)add(b.start,'code',{jsCode:"return $input.all().filter(i=>!i.json.body.nps);"});
  add(b.derive,'code',{jsCode:'return $input.all();'});add(b.wa,'httpRequest',{method:'POST',url:'http://127.0.0.1:9/wa',jsonBody:'={{ $json.body }}'});
  const sub=add(b.subscriber,'httpRequest',{method:'POST',url:'http://127.0.0.1:9/api/subscribers',jsonBody:'={{ {email:$json.body.email,preconfirm_subscriptions:true} }}'});sub.credentials={httpBasicAuth:{id:'synthetic-http',name:'Synthetic'}};sub.retryOnFail=true;sub.onError='continueRegularOutput';
  add(b.branch,'if',{conditions:{conditions:[{leftValue:`={{ (()=>{const b=$('${b.derive}').item.json.body;const m=${JSON.stringify(MAP[brand])};return Object.hasOwn(m,b.event_type)&&Number(b.template_id)===m[b.event_type]&&b.from_email.endsWith('${brand==='fish'?'@fishermans.com.br':'@oaristocrata.com'}');})() }}`,operator:{operation:'true'}}]}});
  const claim=add(b.claim,'postgres',{operation:'executeQuery',query:`SELECT * FROM public.shrigma_flow_email_claim_tx('${brand}',$1::jsonb);`,options:{queryReplacement:`={{ [JSON.stringify($('${b.derive}').item.json.body)] }}`}});claim.credentials={postgres:{id:'synthetic-pg',name:'Synthetic'}};
  add(b.winner,'if',{conditions:{conditions:[{leftValue:'={{ $json.should_send === true }}',operator:{operation:'true'}}]}});
  const http=add(b.http,'httpRequest',{method:'POST',url:'http://127.0.0.1:9/api/tx',jsonBody:`={{ $('${b.claim}').item.json.payload }}`,authentication:'genericCredentialType',genericAuthType:'httpBasicAuth',options:{response:{response:{fullResponse:true,neverError:true,responseFormat:'json'}},redirect:{redirect:{followRedirects:false}},timeout:40000}});http.credentials={httpBasicAuth:{id:'synthetic-http',name:'Synthetic'}};http.retryOnFail=false;http.onError='continueRegularOutput';
  const finish=add(b.finish,'postgres',{operation:'executeQuery',query:`SELECT * FROM public.shrigma_email_finish_${brand}($1::uuid,$2::uuid,public.shrigma_email_transport_outcome($3::jsonb),$4::jsonb);`,options:{queryReplacement:`={{ [$('${b.claim}').item.json.dispatch_id,$('${b.claim}').item.json.claim_token,JSON.stringify($json),JSON.stringify($('${b.claim}').item.json.context)] }}`}});finish.credentials=claim.credentials;
  add(b.accepted,'if',{conditions:{conditions:[{leftValue:'={{ $json.transport_state === "accepted" }}',operator:{operation:'true'}}]}});add(b.cleanup,'httpRequest',{method:'PUT',url:'http://127.0.0.1:9/api/subscribers/lists',jsonBody:`={{ $('${b.webhook}').item.json.body.email }}`});
  const legacy='Legacy '+brand;add(legacy,'httpRequest',{method:'POST',url:'http://127.0.0.1:9/legacy'});
  edge(b.webhook,[b.start]);if(b.start!==b.derive)edge(b.start,[b.derive]);edge(b.derive,[b.subscriber,b.wa]);edge(b.subscriber,[b.branch]);w.connections[b.branch]={main:[[{node:b.claim,type:'main',index:0}],[{node:legacy,type:'main',index:0}]]};
  for(const [from,to] of [[b.claim,b.winner],[b.winner,b.http],[b.http,b.finish],[b.finish,b.accepted],[b.accepted,b.cleanup]])edge(from,[to]);
 }
 add('Webhook — Recebe Evento3','webhook',{httpMethod:'POST',path:'synthetic-popup'});add('Original popup','code',{jsCode:'return $input.all();'});edge('Webhook — Recebe Evento3',['Original popup']);return w;
}
module.exports.workflow=workflow;
