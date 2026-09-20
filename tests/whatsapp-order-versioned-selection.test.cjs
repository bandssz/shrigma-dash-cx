'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'../../growth-test-tools/node_modules/@electric-sql/pglite');
const V=require('../n8n/growth/whatsapp-order-versioned-selection.cjs'),I=require('../n8n/growth/whatsapp-order-status-integration.cjs'),M=require('../n8n/growth/whatsapp-order-status-proposal.cjs');
const WAT=require('../whatsapp-template-contract.js');
function fixture(){
 const byBrand=require('./whatsapp-order-status-fixture.cjs').catalogs(),ps=M.buildProposal(byBrand),catalog=Object.values(byBrand).flat();
 ps.forEach((p,i)=>catalog.push({brand:p.brand,id:String(99000+i),status:'APPROVED',...structuredClone(p.provider_payload)}));
 const flows=[...new Set(ps.map(p=>p.flow_key))].map(key=>{
  const selected=ps.filter(p=>p.flow_key===key),steps=selected.map(p=>({key:p.step_key,channel:'whatsapp',flow:'transacional',piece:p.draft.peca,enabled:true,template_id:p.source_template_id,template_name:p.source_template_name,category:'UTILITY',signature:[{type:'BUTTONS',buttons:[{type:'URL',url:'https://conta.'+M.HOSTS[p.brand]+'/'},{type:'URL',url:'https://'+M.HOSTS[p.brand]+'/suporte'}]}]}));
  return {key,brand:selected[0].brand,enabled:true,runtime_ready:true,version:3,published_version:3,binding:{steps:steps.map(s=>({...structuredClone(s),source_template_id:selected.find(p=>p.step_key===s.key).caller_template_id}))},draft:{steps:structuredClone(steps)},published:{steps:structuredClone(steps)}};
 });
 return {flows,catalog,proposals:ps,contracts:I.buildContracts(ps,catalog,flows)};
}
async function setup(){
 const db=new PGlite(),f=fixture();
 await db.exec(`CREATE TABLE shrigma_flow_definition(key text PRIMARY KEY,brand text,enabled boolean,runtime_ready boolean,version int,published_version int,binding jsonb,draft jsonb,published jsonb);
 CREATE FUNCTION public.shrigma_flow_slot(p_brand text,p_channel text,p_flow text,p_piece text,p_variant text DEFAULT '',p_source text DEFAULT '') RETURNS jsonb LANGUAGE sql STABLE AS $function$${V.ORIGINAL_SOURCE}$function$;`);
 for(const r of f.flows)await write(db,r);
 const freshFunction=(await db.query(`SELECT pg_get_functiondef(p.oid) AS definition,pg_get_function_identity_arguments(p.oid) AS arguments,p.proacl AS acl,p.proconfig AS config,p.prosecdef AS security_definer,l.lanname AS language FROM pg_proc p JOIN pg_language l ON p.prolang=l.oid WHERE p.oid='${V.SIGNATURE}'::regprocedure`)).rows[0];
 const plan=V.generate({...f,freshFunction});return {db,f,plan,freshFunction};
}
async function write(db,r){await db.query('INSERT INTO shrigma_flow_definition SELECT * FROM jsonb_populate_record(NULL::shrigma_flow_definition,$1::jsonb) ON CONFLICT(key) DO UPDATE SET enabled=excluded.enabled,runtime_ready=excluded.runtime_ready,version=excluded.version,published_version=excluded.published_version,binding=excluded.binding,draft=excluded.draft,published=excluded.published',[JSON.stringify(r)]);}
async function slot(db,c,contract){const args=[c.brand,'whatsapp','transacional',c.piece,'',c.caller_template_id];return (await db.query(contract===undefined?'SELECT public.shrigma_flow_slot($1,$2,$3,$4,$5,$6) AS cfg':'SELECT public.shrigma_flow_slot_wa_versioned_v1($1,$2,$3,$4,$5,$6,$7) AS cfg',contract===undefined?args:[...args,contract])).rows[0].cfg;}
async function activate(db,f){for(const u of I.planStageSwitch(f.flows,f.contracts).updates)await write(db,u.next);}
function input(c,source=true){
 const params=WAT.vars(c.target.components.find(x=>x.type==='BODY').text).map(()=>({type:'text',text:'Exemplo'}));
 const x={brand:c.brand,flow:'transacional',piece:c.piece,ref:'42',template_id:c.caller_template_id,template_name:'legacy',language:'pt_BR',modo:'real',components:[{type:'body',parameters:params}]};
 if(source)x._order_status_source={order:{id:'gid://shopify/Order/42',test:false,cancelledAt:null,displayFinancialStatus:'PAID',statusPageUrl:'https://'+M.HOSTS[c.brand]+'/123/orders/SYNTHETIC/authenticate?key=SYNTHETICKEY'}};
 return x;
}
function motor(i,cfg,cs,isNew){
 if(cfg._allowed!==true)return {...i,_flow_block:'flow_paused'};
 const out={...i,template_id:cfg.template_id,template_name:cfg.template_name};
 return isNew?I.applyOrderStatusStage(i,cfg,out,cs):out;
}
test('installs atomically with exact old source/rows and preserves legacy result before activation',async t=>{
 const {db,f,plan}=await setup();t.after(()=>db.close());
 const before=await Promise.all(f.contracts.map(c=>slot(db,c)));await db.exec(plan.sql);
 for(let i=0;i<6;i++){const now=await slot(db,f.contracts[i]);delete now._runtime_contract;delete now._runtime_content_version;delete now._runtime_release;assert.deepEqual(now,before[i]);}
 assert.equal((await db.query('SELECT count(*)::int AS n FROM shrigma_flow_definition')).rows[0].n,4);
 await assert.rejects(db.exec(plan.sql),/already_exists/);await db.exec('ROLLBACK');
 const authority=(await db.query(`SELECT p.prosecdef,pg_get_userbyid(p.proowner)=current_user AS owner,has_function_privilege('public','${V.NEW_SIGNATURE}','EXECUTE') AS audience FROM pg_proc p WHERE p.oid='${V.NEW_SIGNATURE}'::regprocedure`)).rows[0];assert.deepEqual(authority,{prosecdef:false,owner:true,audience:true});
});
test('six slots: old/new motor × old/new caller preserve logical dedupe identity; only both new use new content',async t=>{
 const {db,f,plan}=await setup();t.after(()=>db.close());await db.exec(plan.sql);await activate(db,f);
 for(const c of f.contracts)for(const newMotor of [false,true])for(const newCaller of [false,true]){
  const i=input(c,newCaller),cfg=await slot(db,c,newMotor?(newCaller?V.VERSION:V.LEGACY):undefined),out=motor(i,cfg,f.contracts,newMotor),newContent=newMotor&&newCaller;
  assert.equal(out.template_id,newContent?c.target.id:c.source_template_id);assert.equal(out._flow_block,undefined);
  assert.equal(cfg._version,c.source_version+1);assert.equal(cfg._runtime_content_version,newContent?c.source_version+1:c.source_version);
  for(const key of ['brand','flow','piece','ref'])assert.equal(out[key],i[key]);
  if(newContent){assert.equal(WAT.runtime(out,c.target),null);assert.equal(I.approvedOrderContentError(out,c.target,f.contracts),null);}
  else assert.equal(out.components.some(x=>x.type==='button'),false,'legacy inputs never acquire a dynamic order button');
 }
});
test('current flow/step pause and unavailable configuration block every motor/caller combination',async t=>{
 const {db,f,plan}=await setup();t.after(()=>db.close());await db.exec(plan.sql);await activate(db,f);
 for(const c of f.contracts){
  const active=I.planStageSwitch(f.flows,f.contracts).updates.find(x=>x.key===c.flow_key).next;
  for(const mutate of [x=>x.enabled=false,x=>x.published.steps.find(s=>s.key===c.step_key).enabled=false,x=>x.runtime_ready=false]){
   const row=structuredClone(active);mutate(row);await write(db,row);
   for(const contract of [undefined,V.LEGACY,V.VERSION]){const cfg=await slot(db,c,contract);assert.equal(cfg._managed,true);assert.equal(cfg._allowed,false);assert.ok(motor(input(c),cfg,f.contracts,contract===V.VERSION)._flow_block);}
   await write(db,active);
  }
 }
});
test('future selection/content drift blocks released slots; unrelated selections retain original behavior',async t=>{
 const {db,f,plan}=await setup();t.after(()=>db.close());await db.exec(plan.sql);await activate(db,f);
 const c=f.contracts[0],active=I.planStageSwitch(f.flows,f.contracts).updates.find(x=>x.key===c.flow_key).next;
 for(const change of [s=>s.template_id='77777',s=>s.template_name+='_future',s=>s.signature[0].buttons[0].url='https://example.invalid/{{1}}']){
  const r=structuredClone(active);change(r.published.steps.find(s=>s.key===c.step_key));await write(db,r);
  for(const version of [undefined,V.VERSION]){const cfg=await slot(db,c,version);assert.equal(cfg._allowed,false);assert.equal(cfg._compatibility_block,'release_selection_drift');}
 }
 await write(db,active);
 const unknown=await slot(db,c,'unreviewed');assert.equal(unknown._allowed,false);assert.equal(unknown._compatibility_block,'runtime_contract_unknown');
 const untouched=(await db.query("SELECT public.shrigma_flow_slot('olivas','email','nps','nps') AS cfg")).rows[0].cfg;assert.deepEqual(untouched,{_managed:false});
});
test('new caller payment/cancellation/order guards remain authoritative; invalid source never falls back',async t=>{
 const {db,f,plan}=await setup();t.after(()=>db.close());await db.exec(plan.sql);await activate(db,f);
 for(const c of f.contracts){const cfg=await slot(db,c,V.VERSION);
  for(const change of [x=>x._order_status_source.order.cancelledAt='2026-09-19T00:00:00Z',x=>x._order_status_source.order.test=true,x=>x._order_status_source.order.id='gid://shopify/Order/43',x=>x._order_status_source={error:true},x=>x._order_status_source.order.displayFinancialStatus='REFUNDED']){
   const i=input(c);change(i);assert.ok(motor(i,cfg,f.contracts,true)._flow_block);
  }
 }
});
test('native motor patch changes only selector query/args; optout/reservation/interpreter and topology remain exact',()=>{
 const original={versionId:'fresh',nodes:[{name:'Configuração publicada (PG)',type:'n8n-nodes-base.postgres',parameters:{operation:'executeQuery',query:V.OLD_QUERY,options:{queryReplacement:V.OLD_ARGS,queryBatching:'independently'}}},{name:'Aplica fluxo publicado',parameters:{jsCode:'// '+I.MOTOR_MARKER}},{name:'Interpreta resposta',parameters:{jsCode:'// WA_UNCERTAIN_RESERVATION_V1\nreturn preserveUncertainReservation();'}},{name:'Guarda + reserva (PG)',parameters:{query:'SELECT guard_optout_and_reserve_same_logical_identity();'}}],connections:{unchanged:true},settings:{unchanged:true}};
 const snapshot=structuredClone(original),patched=V.patchMotor(original,{expectedVersionId:'fresh'});assert.equal(patched.changes.length,2);assert.deepEqual(original,snapshot);
 assert.deepEqual(patched.workflow.nodes.slice(1),original.nodes.slice(1));assert.deepEqual(patched.workflow.connections,original.connections);assert.deepEqual(patched.workflow.settings,original.settings);
 for(const source of [undefined,{error:true},{order:{}}]){const i={brand:'fish',flow:'transacional',piece:'pedido-pago',template_id:'123',_order_status_source:source};const args=vm.runInNewContext(V.ARGS.slice(3,-2),{$json:i});assert.equal(args.length,6);assert.equal(args[5],source?V.VERSION:V.LEGACY);}
 assert.deepEqual(V.patchMotor(patched.workflow,{expectedVersionId:'fresh'}).changes,[]);assert.throws(()=>V.patchMotor(original,{expectedVersionId:'stale'}),/Fresh/);
});
test('preflight rejects source or exact row drift with no wrapper/function installed',async t=>{
 const {db,f,plan,freshFunction}=await setup();t.after(()=>db.close());
 assert.throws(()=>V.generate({...f,freshFunction:{...freshFunction,definition:freshFunction.definition.replace('ORDER BY','ORDER  BY')}}),/differs/);
 await db.query('UPDATE shrigma_flow_definition SET version=version+1 WHERE key=$1',[f.flows[0].key]);await assert.rejects(db.exec(plan.sql),/snapshot_drift/);await db.exec('ROLLBACK');
 assert.equal((await db.query('SELECT to_regprocedure($1) AS fn',[V.NEW_SIGNATURE])).rows[0].fn,null);
 assert.equal((await db.query('SELECT pg_get_functiondef($1::regprocedure) AS definition',[V.SIGNATURE])).rows[0].definition,freshFunction.definition);
});
test('restricted EXECUTE ACL and grant option are copied without widening access',async t=>{
 const {db,f}=await setup();t.after(()=>db.close());
 await db.exec(`CREATE ROLE release_reader; CREATE ROLE release_operator; REVOKE ALL ON FUNCTION ${V.SIGNATURE} FROM PUBLIC; GRANT EXECUTE ON FUNCTION ${V.SIGNATURE} TO release_reader; GRANT EXECUTE ON FUNCTION ${V.SIGNATURE} TO release_operator WITH GRANT OPTION;`);
 const ff=(await db.query(`SELECT pg_get_functiondef(p.oid) AS definition,pg_get_function_identity_arguments(p.oid) AS arguments,p.proacl AS acl,p.proconfig AS config,p.prosecdef AS security_definer,l.lanname AS language FROM pg_proc p JOIN pg_language l ON p.prolang=l.oid WHERE p.oid='${V.SIGNATURE}'::regprocedure`)).rows[0];
 const before=(await db.query(`SELECT x.grantee,x.privilege_type,x.is_grantable FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x WHERE p.oid='${V.SIGNATURE}'::regprocedure ORDER BY x.grantee`)).rows;
 await db.exec(V.generate({...f,freshFunction:ff}).sql);
 for(const sig of [V.SIGNATURE,V.NEW_SIGNATURE])assert.deepEqual((await db.query('SELECT x.grantee,x.privilege_type,x.is_grantable FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x WHERE p.oid=$1::regprocedure ORDER BY x.grantee',[sig])).rows,before);
});
test('readback contract pins exact function bodies, settings, language and defaults',async t=>{
 const {db,plan}=await setup();t.after(()=>db.close());await db.exec(plan.sql);
 for(const expected of plan.expectedFunctions){
  const actual=(await db.query('SELECT p.prosrc AS source,p.proconfig AS config,p.pronargdefaults AS defaults,l.lanname AS language FROM pg_proc p JOIN pg_language l ON p.prolang=l.oid WHERE p.oid=$1::regprocedure',[expected.signature])).rows[0];
  for(const k of ['source','config','defaults','language'])assert.deepEqual(actual[k],expected[k]);
 }
});
test('deployment query contains no expression delimiters while stored signatures preserve {{1}} exactly',async t=>{
 const {db,f,plan}=await setup();t.after(()=>db.close());assert.equal(plan.sql.includes('{{'),false);assert.equal(plan.sql.includes('}}'),false);assert.match(plan.sql,/convert_from\(decode\('[0-9a-f]+','hex'\),'UTF8'\)/);
 await db.exec(plan.sql);await activate(db,f);
 for(const c of f.contracts){const cfg=await slot(db,c,V.VERSION);assert.equal(cfg.signature[0].buttons[0].url,'https://'+M.HOSTS[c.brand]+'/{{1}}');}
});
