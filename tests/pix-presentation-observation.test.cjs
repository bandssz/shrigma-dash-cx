'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const {RULE_HASHES,observePixPresentation,observationEligible,QUERY}=require('../n8n/growth/pix-presentation-observation.cjs');
const {patchWorkflow,GATE,OBSERVE,OUTPUT_ERROR}=require('../n8n/growth/pix-presentation-patch.cjs');
const money=value=>({value,offset:100});
function decision(kind='itemized_shape',count=2){
 const items=Array.from({length:count},(_,i)=>({retailer_id:kind==='aggregate'?'order-123':String(i+100),name:'Synthetic item',amount:money(1000),quantity:1}));
 return {saida:{brand:'fish',modo:'real',piece:'pix-15min',flow:'carrinho',ref:'123',log_id:7,ok:false,terminal:true},meta_body:{type:'template',to:'synthetic-do-not-retain',template:{components:[{type:'button',sub_type:'order_details',parameters:[{type:'action',action:{order_details:{reference_id:'fish-123',currency:'BRL',payment_settings:[{type:'pix_dynamic_code',pix_dynamic_code:{code:'synthetic-private-payment'}}],total_amount:money(count*1000),order:{status:'pending',items,subtotal:money(count*1000),tax:money(0)}}}}]}]}}};
}
const details=d=>d.meta_body.template.components[0].parameters[0].action.order_details;
const fixtureInterpreter=`// WA_UNCERTAIN_RESERVATION_V1
const d = $('Decide envio').item.json;
const saida={...d.saida},status=$json.statusCode,wamid=$json.body?.messages?.[0]?.id;
let sql;
if(status>=200&&status<300&&wamid){saida.ok=true;saida.wamid=wamid;saida.motivo='enviado';sql='committed-receipt';}
else{saida.incerto=true;saida.reserva_preservada=true;saida.motivo='meta_estado_incerto_reserva_preservada';sql='preserve-reservation';}
return { sql, saida };`;
const fixtureOutput=`const j=$json;if (j.saida) return j.saida;const s={...$('Interpreta resposta').item.json.saida};${OUTPUT_ERROR}\nreturn s;`;
function workflow(){return {versionId:'synthetic-fresh',active:true,activeVersionId:'synthetic-fresh',settings:{same:true},nodes:[
 {name:'Interpreta resposta',type:'n8n-nodes-base.code',parameters:{jsCode:fixtureInterpreter}},
 {name:'Saída',type:'n8n-nodes-base.code',parameters:{jsCode:fixtureOutput}},
 {name:'Finaliza (PG)',type:'n8n-nodes-base.postgres',typeVersion:2.6,credentials:{postgres:{id:'synthetic-existing'}},onError:'continueRegularOutput',parameters:{query:'={{ $json.sql }}'}},
 {name:'Meta /messages',type:'n8n-nodes-base.httpRequest',parameters:{jsonBody:'={{ JSON.stringify($json.meta_body) }}'}},
 {name:'Guardas',parameters:{code:'untouched'}}],connections:{'Finaliza (PG)':{main:[[{node:'Saída',type:'main',index:0}]]},'Guardas':{same:true}}};}
const evaluate=(code,j,records)=>vm.runInNewContext('(function(){'+code+'})()',{ $json:j,$:name=>{if(!(name in records))throw Error('not executed');return {item:{json:records[name]}};} });
const normalized=x=>JSON.parse(JSON.stringify(x));
test('observes final native card lines, including one genuine line versus aggregate label',()=>{
 for(const [kind,count] of [['itemized_shape',2],['itemized_shape',1],['aggregate',1]]){
  const d=decision(kind,count),before=structuredClone(d);assert.deepEqual(observePixPresentation(d),{variant:kind,item_count:count,version_sha256:RULE_HASHES[kind]});assert.deepEqual(d,before);
 }
});
test('only public flags, line count and public rule hash leave the observer',()=>{
 const d=decision(),o=observePixPresentation(d),text=JSON.stringify(o);
 assert.deepEqual(Object.keys(o),['variant','item_count','version_sha256']);assert.doesNotMatch(text,/Synthetic|synthetic|fish-123|retailer|code|phone|ref|1000/);
 for(const [kind,hash] of Object.entries(RULE_HASHES))assert.equal(crypto.createHash('sha256').update('pix-presentation-v1|'+kind+'|native-order-details|line-count|no-payload-values').digest('hex'),hash);
 details(d).items='ignored';assert.deepEqual(observePixPresentation(d),o);
 details(d).order.items[0].name='Another synthetic product';assert.deepEqual(observePixPresentation(d),o);
});
test('malformed, mismatched or ambiguous structure becomes unknown, never a fabricated detailed card',()=>{
 for(const change of [d=>details(d).order.items[0].retailer_id='SKU-SYNTHETIC',d=>details(d).order.items[1].retailer_id='100',d=>details(d).order.items[0].amount.value=10,d=>details(d).order.items[0].quantity=0,d=>details(d).order.subtotal.value=1]){
  const d=decision();change(d);assert.equal(observePixPresentation(d).variant,'unknown');
 }
 const d=decision();delete details(d).order;assert.deepEqual(observePixPresentation(d),{variant:'unknown',item_count:null,version_sha256:RULE_HASHES.unknown});
});
test('other brands, QA, old missing components, non-PIX, shadow, internal and invalid identity stay untouched',()=>{
 for(const mutate of [d=>d.saida.brand='aristo',d=>d.saida.modo='interno',d=>d.saida.modo='sombra',d=>d.saida.flow='teste-motor',d=>d.saida.piece='paid',d=>delete d.meta_body,d=>d.meta_body.type='text',d=>d.saida.ref='appmax:123',d=>details(d).reference_id='fish-456']){
  const d=decision();mutate(d);assert.equal(observePixPresentation(d),null);
 }
 assert.equal(observePixPresentation({}),null);assert.equal(observePixPresentation(null),null);
});
test('observer eligibility requires both provider acceptance and an already committed log update',()=>{
 const i={saida:{ok:true,wamid:'synthetic'},pix_presentation_observation:observePixPresentation(decision())};
 assert.equal(observationEligible({log_atualizado:1},i),true);
 for(const f of [{},{error:{message:'db unavailable'}},{log_atualizado:0},{log_atualizado:2}])assert.equal(observationEligible(f,i),false);
 for(const delta of [{saida:{ok:false}},{saida:{ok:true,wamid:''}},{pix_presentation_observation:null}])assert.equal(observationEligible({log_atualizado:1},{...i,...delta}),false);
});
test('fresh patch only extends post-receipt observation, keeping transport/reservation/settings exact',()=>{
 const fresh=workflow(),before=structuredClone(fresh),r=patchWorkflow(fresh,{expectedVersionId:fresh.versionId});assert.deepEqual(fresh,before);
 for(const n of fresh.nodes.filter(n=>!['Interpreta resposta','Saída'].includes(n.name)))assert.deepEqual(r.workflow.nodes.find(x=>x.name===n.name),n);
 assert.deepEqual(r.workflow.settings,fresh.settings);assert.deepEqual(r.workflow.connections.Guardas,fresh.connections.Guardas);
 const pg=r.workflow.nodes.find(n=>n.name===OBSERVE);assert.deepEqual(pg.credentials,fresh.nodes[2].credentials);assert.equal(pg.retryOnFail,false);assert.equal(pg.onError,'continueRegularOutput');assert.equal(pg.parameters.options.queryBatching,'independently');assert.equal(pg.parameters.options.connectionTimeout,2);assert.match(pg.parameters.query,/statement_timeout='1500ms'/);assert.match(pg.parameters.query,/lock_timeout='250ms'/);assert.equal(pg.parameters.query,QUERY);
 assert.deepEqual(r.workflow.connections[OBSERVE],fresh.connections['Finaliza (PG)']);
 assert.deepEqual(r.workflow.connections[GATE].main.flat().map(x=>x.node),[OBSERVE,'Saída']);
 assert.throws(()=>patchWorkflow(fresh,{expectedVersionId:'stale'}),/FRESH/);assert.throws(()=>patchWorkflow({...fresh,activeVersionId:'other'},{expectedVersionId:fresh.versionId}),/ACTIVE_VERSION/);assert.throws(()=>patchWorkflow(r.workflow,{expectedVersionId:fresh.versionId}),/ALREADY/);
 fresh.nodes[0].parameters.jsCode+='\ndelete from shrigma_send_log';assert.throws(()=>patchWorkflow(fresh,{expectedVersionId:fresh.versionId}),/CHANGED/);
});
test('accepted output survives observation PG failure/timeout, while original finalization failure remains visible',()=>{
 const w=patchWorkflow(workflow(),{expectedVersionId:'synthetic-fresh'}).workflow,code=w.nodes[0].parameters.jsCode,out=w.nodes[1].parameters.jsCode;
 const interpreted=evaluate(code,{statusCode:200,body:{messages:[{id:'synthetic-wamid'}]}},{'Decide envio':decision()});
 assert.equal(interpreted.sql,'committed-receipt');
 for(const result of [{pix_presentation_recorded:false},{error:{message:'timeout private-connection-string'}},{error:{message:'PG unavailable private-connection-string'}}]){
  const s=evaluate(out,result,{'Interpreta resposta':interpreted,'Finaliza (PG)':{log_atualizado:1}});
  assert.equal(s.ok,true);assert.equal(s.wamid,'synthetic-wamid');assert.equal(s.terminal,true);assert.equal(s.pix_card_observation,'not_recorded');assert.equal(s.aviso_pg,undefined);assert.doesNotMatch(JSON.stringify(s),/private-connection/);
 }
 const good=evaluate(out,{pix_presentation_recorded:true},{'Interpreta resposta':interpreted,'Finaliza (PG)':{log_atualizado:1}});assert.equal(good.pix_card_observation,'recorded');
 const failed={error:{message:'original-finalization-failure'}},s=evaluate(out,failed,{'Interpreta resposta':interpreted,'Finaliza (PG)':failed});assert.match(s.aviso_pg,/original-finalization/);assert.equal(s.pix_card_observation,undefined);
});
test('unknown responses, missing observation and early guard branches preserve original output exactly',()=>{
 const w=patchWorkflow(workflow(),{expectedVersionId:'synthetic-fresh'}).workflow;
 for(const response of [{},{statusCode:200,body:{}},{statusCode:503,body:{}}]){
  const records={'Decide envio':decision()},before=evaluate(fixtureInterpreter,response,records),after=evaluate(w.nodes[0].parameters.jsCode,response,records);assert.deepEqual(normalized(after.saida),normalized(before.saida));assert.equal(after.sql,before.sql);assert.equal(observationEligible({log_atualizado:1},after),false);
 }
 for(const motivo of ['opt_out','ja_enviado','sombra','contrato_invalido']){
  const j={saida:{ok:false,terminal:true,motivo}};assert.deepEqual(normalized(evaluate(w.nodes[1].parameters.jsCode,j,{})),j.saida);
 }
 const i={saida:{ok:true,terminal:true,motivo:'enviado',wamid:'synthetic'}};
 assert.deepEqual(normalized(evaluate(w.nodes[1].parameters.jsCode,{log_atualizado:1},{'Interpreta resposta':i,'Finaliza (PG)':{log_atualizado:1}})),i.saida);
});
test('SQL migration retains historical unknowns, accepted binding, immutability and committed receipt on observation failure',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();
 const schema=`CREATE TABLE shrigma_send_log(id bigint PRIMARY KEY,brand text,ref text,template_ref text,channel text,piece text,flow text,wamid text,erro text);
 CREATE TABLE shrigma_pix_charge_evidence(log_id bigint PRIMARY KEY REFERENCES shrigma_send_log(id),brand text,ref text,template_id text,accepted_at timestamptz);
 INSERT INTO shrigma_send_log VALUES(7,'fish','123','template-synthetic','whatsapp','pix-15min','carrinho','synthetic-accepted',NULL),(8,'fish','124','template-synthetic','whatsapp','pix-15min','carrinho',NULL,'UNCERTAIN_META');
 INSERT INTO shrigma_pix_charge_evidence VALUES(7,'fish','123','template-synthetic',now()),(8,'fish','124','template-synthetic',NULL);`;
 const sql=fs.readFileSync(require.resolve('../n8n/growth/pix-presentation-observation.sql'),'utf8');
 const call=(id,variant,count,hash=RULE_HASHES[variant])=>db.query('SELECT shrigma_pix_observe_presentation_v1($1,$2,$3,$4) AS ok',[id,variant,count,hash]).then(r=>r.rows[0].ok);
 try{
  await db.exec(schema);await db.exec(sql);await db.exec(sql);
  assert.equal((await db.query('SELECT card_variant FROM shrigma_pix_charge_evidence WHERE log_id=7')).rows[0].card_variant,null);
  assert.equal(await call(8,'itemized_shape',2),false);assert.equal(await call(7,'itemized_shape',null),false);assert.equal(await call(7,'aggregate',2),false);assert.equal(await call(7,'itemized_shape',2,'f'.repeat(64)),false);
  assert.equal(await call(7,'itemized_shape',2),true);assert.equal(await call(7,'itemized_shape',2),true);assert.equal(await call(7,'aggregate',1),false);
  assert.equal((await db.query('SELECT card_item_count FROM shrigma_pix_charge_evidence WHERE log_id=7')).rows[0].card_item_count,2);
  await db.exec("CREATE FUNCTION fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic observation failure'; END $$; CREATE TRIGGER fixture_failure BEFORE UPDATE ON shrigma_pix_charge_evidence FOR EACH ROW EXECUTE FUNCTION fixture_fail();");
  await db.exec("INSERT INTO shrigma_send_log SELECT 9,'fish','125','template-synthetic','whatsapp','pix-15min','carrinho','synthetic-accepted-2',NULL; INSERT INTO shrigma_pix_charge_evidence(log_id,brand,ref,template_id,accepted_at) VALUES(9,'fish','125','template-synthetic',now())");
  await assert.rejects(call(9,'itemized_shape',1),/synthetic observation failure/);
  const r=(await db.query('SELECT l.wamid,e.accepted_at,e.card_variant FROM shrigma_send_log l JOIN shrigma_pix_charge_evidence e ON e.log_id=l.id WHERE l.id=9')).rows[0];assert.equal(r.wamid,'synthetic-accepted-2');assert.ok(r.accepted_at);assert.equal(r.card_variant,null);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM shrigma_send_log')).rows[0].n,3);
  // PGlite has no backend timer; inject PostgreSQL cancellation SQLSTATE 57014.
  await db.exec("CREATE OR REPLACE FUNCTION fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE='57014'; END $$;");
  await assert.rejects(db.transaction(async tx=>{await tx.exec("SET LOCAL statement_timeout='1500ms'");await tx.query('SELECT shrigma_pix_observe_presentation_v1($1,$2,$3,$4)',[9,'itemized_shape',1,RULE_HASHES.itemized_shape]);}),/statement timeout/);
  const afterTimeout=(await db.query('SELECT l.wamid,e.card_variant FROM shrigma_send_log l JOIN shrigma_pix_charge_evidence e ON e.log_id=l.id WHERE l.id=9')).rows[0];assert.equal(afterTimeout.wamid,'synthetic-accepted-2');assert.equal(afterTimeout.card_variant,null);
  assert.equal((await db.query('SHOW statement_timeout')).rows[0].statement_timeout,'0','local timeout must not leak to pooled connection');
  assert.equal((await db.query("SELECT has_function_privilege('public','shrigma_pix_observe_presentation_v1(bigint,text,integer,text)','EXECUTE') AS allowed")).rows[0].allowed,false);
 }finally{await db.close();}
});

test('independent SQL messages retain first and third observations when the second fails or is cancelled',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();
 try{
  await db.exec("CREATE TABLE shrigma_send_log(id bigint PRIMARY KEY,brand text,ref text,template_ref text,channel text,piece text,flow text,wamid text); CREATE TABLE shrigma_pix_charge_evidence(log_id bigint PRIMARY KEY,brand text,ref text,template_id text,accepted_at timestamptz); INSERT INTO shrigma_send_log SELECT n,'fish',n::text,'synthetic-template','whatsapp','pix-15min','carrinho','synthetic-accepted-'||n FROM generate_series(1,3)n; INSERT INTO shrigma_pix_charge_evidence SELECT id,brand,ref,template_ref,now() FROM shrigma_send_log");
  await db.exec(fs.readFileSync(require.resolve('../n8n/growth/pix-presentation-observation.sql'),'utf8'));
  await db.exec("CREATE FUNCTION fixture_second() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.log_id=2 THEN RAISE EXCEPTION 'synthetic middle error'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_middle BEFORE UPDATE ON shrigma_pix_charge_evidence FOR EACH ROW EXECUTE FUNCTION fixture_second();");
  for(const cancel of [false,true]){
   if(cancel)await db.exec("CREATE OR REPLACE FUNCTION fixture_second() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.log_id=2 THEN RAISE EXCEPTION 'synthetic statement timeout' USING ERRCODE='57014'; END IF; RETURN NEW; END $$;");
   const outputs=[];
   for(const id of [1,2,3]){
    try{
     // Same simple-query boundary as the hosted node's independently mode.
     // IDs/hash are constants from this synthetic fixture, never operator input.
     const result=await db.exec("SET LOCAL lock_timeout='250ms'; SET LOCAL statement_timeout='1500ms'; SELECT public.shrigma_pix_observe_presentation_v1("+id+",'itemized_shape',1,'"+RULE_HASHES.itemized_shape+"') AS recorded");
     outputs.push({id,recorded:result.at(-1).rows[0].recorded});
    }catch(e){outputs.push({id,recorded:false,code:e.code});}
   }
   assert.deepEqual(outputs.map(x=>[x.id,x.recorded]),[[1,true],[2,false],[3,true]]);if(cancel)assert.equal(outputs[1].code,'57014');
   const rows=(await db.query('SELECT log_id,card_variant FROM shrigma_pix_charge_evidence ORDER BY log_id')).rows;
   assert.deepEqual(rows.map(r=>r.card_variant),['itemized_shape',null,'itemized_shape']);
   assert.equal((await db.query("SELECT count(*)::int AS n FROM shrigma_send_log WHERE wamid IS NOT NULL")).rows[0].n,3);
   assert.equal((await db.query('SHOW statement_timeout')).rows[0].statement_timeout,'0');
  }
 }finally{await db.close();}
});
