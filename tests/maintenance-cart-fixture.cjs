'use strict';
const fs=require('node:fs'),path=require('node:path');
const base=require('./maintenance-fixture.cjs');
const cartSQL=fs.readFileSync(path.join(__dirname,'../n8n/growth/maintenance-cart.sql'),'utf8');
// Synthetic originals: a per-event pause lets fairness be checked independently.
const fixtureSQL=base.fixtureSQL.replace('IF pol.paused THEN',"IF pol.paused OR coalesce((b->>'fixture_pause')::boolean,false) THEN");
const finishSQL=`
CREATE TABLE maintenance_finish_log(dispatch_id uuid PRIMARY KEY,context jsonb,outcome text);
CREATE FUNCTION public.shrigma_email_finish_cart(p_id uuid,p_claim uuid,p_outcome text,b jsonb)
RETURNS TABLE(dispatch_id uuid,transport_state text,send_log_id bigint,error_code text) LANGUAGE plpgsql AS $$
DECLARE d public.shrigma_email_dispatch%ROWTYPE;
BEGIN
 SELECT * INTO STRICT d FROM public.shrigma_email_dispatch x WHERE x.dispatch_id=p_id FOR UPDATE;
 IF d.claim_token IS DISTINCT FROM p_claim OR d.brand IS DISTINCT FROM b->>'brand' OR d.flow<>'carrinho' OR p_outcome IS NULL OR p_outcome NOT IN('accepted','rejected','outcome_unknown') THEN RAISE EXCEPTION 'SYNTHETIC_FINISH_GUARD';END IF;
 IF d.transport_state='in_flight' THEN
  UPDATE public.shrigma_email_dispatch x SET transport_state=p_outcome WHERE x.dispatch_id=p_id RETURNING * INTO d;
  INSERT INTO maintenance_finish_log VALUES(p_id,b,p_outcome);
 END IF;
 RETURN QUERY SELECT d.dispatch_id,d.transport_state,42::bigint,NULL::text;
END $$;
`;
const selector=`WITH classificado AS (SELECT s.id,s.cart_at,s.toque,s.email FROM maintenance_selector_source s WHERE s.brand=$2::text AND ($1::int IS NULL OR $1::int>=0))
SELECT cl.id,cl.email,cl.cart_at,cl.toque,$2::text AS brand FROM classificado cl
WHERE cl.toque IS NOT NULL
ORDER BY cl.id
LIMIT 500;`;
function workflow(){
 const specs=[['A cada 15 min','scheduleTrigger'],['Config · 3 marcas','code'],['Elegíveis (PG)','postgres'],['Monta payload','code'],['Modo teste?','if'],['Resumo (não enviou)','code'],['Envia /api/tx','httpRequest'],['Marca toque (PG)','postgres'],['R4 itens com template','code'],['R4 carrinho Fish Aristo','if'],['R4 reserva carrinho','postgres'],['R4 vencedores carrinho','code'],['R4 Listmonk carrinho','httpRequest'],['R4 classifica carrinho','code'],['R4 finaliza carrinho','postgres']];
 const w={id:'ekQxu1pUFyab8Iyd',versionId:'synthetic-active-v1',activeVersionId:'synthetic-active-v1',active:true,name:'Synthetic cart',settings:{executionOrder:'v1',timezone:'America/Sao_Paulo'},nodes:specs.map(([name,type],i)=>({id:'synthetic-'+i,name,type:'n8n-nodes-base.'+type,typeVersion:1,position:[i,0],parameters:{},...(type==='postgres'?{credentials:{postgres:{id:'synthetic-db',name:'Synthetic'}}}:{})})),connections:{}};
 const get=name=>w.nodes.find(n=>n.name===name);
 get('Elegíveis (PG)').parameters={query:selector,options:{queryReplacement:'={{ [$json.list,$json.brand] }}'}};
 get('R4 reserva carrinho').parameters={operation:'executeQuery',query:'SELECT * FROM public.shrigma_email_claim_cart($1::jsonb);',options:{queryReplacement:'={{ [JSON.stringify($json)] }}',queryBatching:'independently'}};
 get('R4 carrinho Fish Aristo').parameters={conditions:{conditions:[{leftValue:"={{ ['fish','aristo'].includes($json.brand) }}",operator:{operation:'true'}}],combinator:'and'}};
 get('R4 vencedores carrinho').parameters={jsCode:"return $input.all().flatMap((i,index)=>i.json.should_send===true?[{json:i.json,pairedItem:{item:index}}]:[]);"};
 Object.assign(get('R4 Listmonk carrinho'),{retryOnFail:false,onError:'continueRegularOutput',credentials:{httpBasicAuth:{id:'synthetic-http',name:'Synthetic'}},parameters:{method:'POST',url:'http://127.0.0.1:9/api/tx',authentication:'genericCredentialType',genericAuthType:'httpBasicAuth',jsonBody:'={{ $json.payload }}',options:{response:{response:{fullResponse:true,neverError:true,responseFormat:'json'}},redirect:{redirect:{followRedirects:false}},timeout:40000}}});
 get('R4 classifica carrinho').parameters={mode:'runOnceForEachItem',jsCode:"const r=$json;const code=Number(r.statusCode||0);let body=r.body;\nif(typeof body==='string'){try{body=JSON.parse(body);}catch{body=null;}}\nconst outcome=(code>=200&&code<300&&body?.data===true)?'accepted':([400,401,403,404,422].includes(code)?'rejected':'outcome_unknown');\nreturn {json:{outcome}};"};
 get('R4 finaliza carrinho').parameters={operation:'executeQuery',query:'SELECT * FROM public.shrigma_email_finish_cart($1::uuid,$2::uuid,$3::text,$4::jsonb);',options:{queryBatching:'independently',queryReplacement:"={{ [$('R4 reserva carrinho').item.json.dispatch_id,$('R4 reserva carrinho').item.json.claim_token,$json.outcome,JSON.stringify($('R4 reserva carrinho').item.json.context)] }}"}};
 const edge=(a,b)=>{w.connections[a]={main:[[{node:b,type:'main',index:0}]]};};
 for(const [a,b] of [['A cada 15 min','Config · 3 marcas'],['Config · 3 marcas','Elegíveis (PG)'],['Elegíveis (PG)','Monta payload'],['Monta payload','Modo teste?'],['R4 itens com template','R4 carrinho Fish Aristo'],['R4 reserva carrinho','R4 vencedores carrinho'],['R4 vencedores carrinho','R4 Listmonk carrinho'],['R4 Listmonk carrinho','R4 classifica carrinho'],['R4 classifica carrinho','R4 finaliza carrinho'],['Envia /api/tx','Marca toque (PG)']])edge(a,b);
 w.connections['Modo teste?']={main:[[{node:'Resumo (não enviou)',type:'main',index:0}],[{node:'R4 itens com template',type:'main',index:0}]]};
 w.connections['R4 carrinho Fish Aristo']={main:[[{node:'R4 reserva carrinho',type:'main',index:0}],[{node:'Envia /api/tx',type:'main',index:0}]]};return w;
}
function cartAPI(db){const a=base.api(db);return {...a,
 finish:async c=>(await db.query('SELECT * FROM crm_maintenance_candidate.cart_finish_v1($1,$2,$3,$4)',[c.dispatch_id,c.claim_token,c.outcome,JSON.stringify(c.context)])).rows[0],
 ingest:async body=>(await db.query('SELECT * FROM crm_maintenance_candidate.cart_admit_claim_v1($1)',[JSON.stringify(body)])).rows[0],
 next:async brand=>(await db.query('SELECT * FROM crm_maintenance_candidate.cart_next_v1($1)',[brand])).rows,
 known:async (b)=>(await db.query('SELECT crm_maintenance_candidate.cart_known_v1($1,$2,$3,$4) known',[b.brand,b.toque,b.subscriber_id,b.ref])).rows[0].known
};}
module.exports={...base,fixtureSQL:fixtureSQL+finishSQL,cartSQL,cartAPI,workflow};
