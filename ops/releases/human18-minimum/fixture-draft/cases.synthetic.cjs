'use strict';
// Real PG17, original custody/functions and role, synthetic native HTTP only.
const fs=require('node:fs'),a=require('node:assert/strict'),crypto=require('node:crypto'),Module=require('node:module');
const filename='/delta/native-correction-ui-fixture-draft.cjs',source=fs.readFileSync('/delta/native-correction-ui-fixture.cjs','utf8');
a(source.includes('return{admin,nativePool,effectPool,run,'));const fixture=new Module(filename,module);fixture.filename=filename;fixture.paths=module.paths;
// The real native catalog proved that the earlier ownership proposal is absent.
// Do not inject its function/triggers into this draft proof through the fixture.
const inlineOwnership="coalesce(t.id>0 AND b IN ('fish','aristo') AND t.type::text='campaign' AND EXISTS(SELECT 1 FROM public.shrigma_template_email_registry r WHERE r.template_id=t.id AND r.brand=b) AND NOT EXISTS(SELECT 1 FROM public.shrigma_template_email_registry r WHERE r.template_id=t.id AND r.brand IS DISTINCT FROM b),false)";
let fixtureSource=source.replace('return{admin,nativePool,effectPool,run,','return{native,admin,nativePool,effectPool,run,');
a(fixtureSource.includes("'n8n/growth/campaign-template-ownership.sql',"));fixtureSource=fixtureSource.replace("'n8n/growth/campaign-template-ownership.sql',",'');
const originalSql="const sql=p=>fs.readFileSync('/source/'+p,'utf8');";a(fixtureSource.includes(originalSql));fixtureSource=fixtureSource.replace(originalSql,"const sql=p=>{let text=fs.readFileSync('/source/'+p,'utf8');if(p==='n8n/growth/campaign-provider.sql'){if(!text.includes('public.shrigma_campaign_template_owned_v1(t.id,b)'))throw Error('FIXTURE_CATALOG_BOUNDARY');text=text.replace('public.shrigma_campaign_template_owned_v1(t.id,b)',"+JSON.stringify(inlineOwnership)+");}if(p==='n8n/growth/campaign-write-guard.sql'){const i=text.indexOf('CREATE FUNCTION public.shrigma_campaign_template_create_guard_v1()');if(i<0)throw Error('FIXTURE_GUARD_BOUNDARY');text=text.slice(0,i);}return text;};");
fixture._compile(fixtureSource,filename);
const {createFixture,closeAll}=fixture.exports,C=require('/app/n8n/growth/campaign-contract.js'),T=require('/app/n8n/growth/campaign-tracking.js'),{createExecutor}=require('/app/services/crm-campaign/transport.cjs');
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v,hash=v=>crypto.createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
let assertions=0;const check=(v,label)=>{a(v,label);assertions++;console.log('DRAFT_CASE_OK:'+label);};
(async()=>{const f=await createFixture(process.env.SHRIGMA_LOCAL_TEST_DB);
 try{
  // Match native schema: id is serial; uuid must be supplied by the creator.
  await f.admin.query("ALTER TABLE public.campaigns ALTER COLUMN id SET DEFAULT nextval('qa_campaign_id'),ALTER COLUMN uuid DROP DEFAULT,ALTER COLUMN uuid SET NOT NULL");
  check((await f.admin.query("SELECT to_regprocedure('public.shrigma_campaign_template_owned_v1(integer,text)') IS NULL AS absent")).rows[0].absent,'uninstalled-ownership-helper-not-in-fixture');
  check((await f.admin.query("SELECT count(*)=0 AS absent FROM pg_trigger WHERE tgname IN('shrigma_campaign_template_registry_guard_v1','shrigma_campaign_template_registry_truncate_guard_v1','shrigma_campaign_template_create_guard_v1')")).rows[0].absent,'uninstalled-ownership-triggers-not-in-fixture');
  await f.admin.query(fs.readFileSync('/draft/install.synthetic.sql','utf8'));
  const execute=createExecutor({pool:f.effectPool,native:f.native,nativeInternalEnabled:true}),run=command=>execute({key:'synthetic-native-owner',command});
  let nativeCreates=0;const beforeNative=f.events.length,created=[],receipts=[];
  await a.rejects(f.effectPool.query("SELECT public.shrigma_campaign_draft_save_v1('draft_create','{}')"),e=>e.code==='42501');check(true,'role-cannot-call-private-draft-function');
  for(const brand of ['aristo','fish']){
   const catalog=(await f.admin.query('SELECT public.shrigma_campaign_catalog($1) AS c',[brand])).rows[0].c;
   const definition=C.normalizeDraft({schema_version:C.VERSION,brand,channel:'email',name:'[TESTE] Ideia mínima '+brand,subject:'[TESTE] Conferência interna',tags:[C.DRAFT_EDITOR_TAG],send_at:null},{catalog});
   check(definition.list_ids.length===0&&definition.html===''&&definition.text==='','minimum-does-not-invent-audience-or-content-'+brand);
   check(definition.reply_to==='contato@'+C.BRANDS[brand]&&definition.from_email==='avisos@'+C.BRANDS[brand],'confirmed-defaults-'+brand);
   const key=crypto.randomUUID(),command={acao:'campanha_salvar',brand,definition,idempotency_key:key},r=await run(command);
   a.equal(r.status,201,JSON.stringify(r));const c=r.body.campaign;created.push(c);
   check(c.status==='draft'&&c.sent===0&&c.started_at===null&&c.send_at===null&&hash(c.definition)===hash(definition),'minimum-created-and-read-back-'+brand);
   check(r.body.tracking.policy===C.DRAFT_POLICY&&r.body.tracking.term===null,'no-dispatch-token-for-minimum-'+brand);
   const op=await run({acao:'campanha_operacao',brand,idempotency_key:key});check(op.status===200&&op.body.operation.state==='succeeded'&&op.body.operation.providerId===c.id,'same-original-operation-committed-'+brand);receipts.push({brand,key,command,operation:op.body.operation});
   const countBefore=(await f.admin.query("SELECT count(*)::int AS n FROM public.campaigns WHERE attribs#>>'{crm,draft_editor}'='v2'")).rows[0].n;
   const repeated=await run(command);check(repeated.status===201&&repeated.body.campaign.id===c.id,'same-key-returns-same-native-campaign-'+brand);
   check((await f.admin.query("SELECT count(*)::int AS n FROM public.campaigns WHERE attribs#>>'{crm,draft_editor}'='v2'")).rows[0].n===countBefore,'same-key-creates-no-duplicate-'+brand);
   const changed={...definition,subject:'[TESTE] Alteração salva'},saved=await run({acao:'campanha_salvar',brand,id:c.id,expected_version:c.version,definition:changed,idempotency_key:crypto.randomUUID()});
   a.equal(saved.status,200,JSON.stringify(saved));check(saved.body.campaign.id===c.id&&saved.body.campaign.version!==c.version&&saved.body.campaign.definition.subject===changed.subject,'partial-update-same-id-CAS-'+brand);
   const stale=await run({acao:'campanha_salvar',brand,id:c.id,expected_version:c.version,definition:{...changed,subject:'[TESTE] Versão antiga'},idempotency_key:crypto.randomUUID()});check(stale.status===409&&stale.body.error==='VERSION_CONFLICT','stale-version-refused-'+brand);
   const current=saved.body.campaign,withoutMarker={...changed,tags:changed.tags.filter(t=>t!==C.DRAFT_EDITOR_TAG)},downgrade=await run({acao:'campanha_salvar',brand,id:c.id,expected_version:current.version,definition:withoutMarker,idempotency_key:crypto.randomUUID()});check(downgrade.status===409&&downgrade.body.error==='DRAFT_FORMAT_REQUIRED','editor-downgrade-refused-'+brand);
   const incomplete=await run({acao:'campanha_validar',brand,id:c.id,expected_version:current.version,idempotency_key:crypto.randomUUID()});check(incomplete.status>=400,'partial-cannot-validate-'+brand);
   const wrongBrand=brand==='aristo'?'fish':'aristo',cross=await run({acao:'campanha_salvar',brand:wrongBrand,id:c.id,expected_version:current.version,definition:{...changed,brand:wrongBrand},idempotency_key:crypto.randomUUID()});check(cross.status>=400,'cross-brand-write-refused-'+brand);
   const fresh=await run({acao:'campanha_obter',brand,id:c.id});check(fresh.status===200&&fresh.body.campaign.definition.subject===changed.subject&&fresh.body.campaign.definition.list_ids.length===0,'refusals-kept-saved-draft-'+brand);
   const baseId=brand==='aristo'?176:175,partialDefinition={...fresh.body.campaign.definition,list_ids:[baseId]},partial=await run({acao:'campanha_salvar',brand,id:c.id,expected_version:fresh.body.campaign.version,definition:partialDefinition,idempotency_key:crypto.randomUUID()});a.equal(partial.status,200,JSON.stringify(partial));
   for(const[action,kind,error]of [['update','salvar','DRAFT_FORMAT_REQUIRED'],['review','validar','DRAFT_INCOMPLETE'],['schedule','agendar','DRAFT_INCOMPLETE']]){
    const claim=(await f.admin.query("SELECT public.shrigma_campaign_store('claim',$1) AS op",[JSON.stringify({actor:'synthetic-direct-provider',key:crypto.randomUUID(),hash:'a'.repeat(64),brand,action:kind})])).rows[0].op;
    const payload={id:c.id,expectedVersion:partial.body.campaign.version,operationId:claim.id,definition:{...partialDefinition,tags:partialDefinition.tags.filter(t=>t!==C.DRAFT_EDITOR_TAG)}};
    await a.rejects(f.admin.query('SELECT public.shrigma_campaign_provider($1,$2)',[action,payload]),e=>e.code==='P0001'&&e.message===error);check(true,'SQL-fence-'+action+'-'+brand);
   }
   const domain=C.BRANDS[brand],full={...partialDefinition,html:'<p><a href="https://'+domain+'/collections/all">Loja</a><a href="{{ UnsubscribeURL }}">Sair</a></p>',text:'Loja https://'+domain+'/collections/all {{ UnsubscribeURL }}'},prepared=C.prepareDraft(full,{catalog,tracking:T,trackingId:c.id}),complete=await run({acao:'campanha_salvar',brand,id:c.id,expected_version:partial.body.campaign.version,definition:prepared.definition,idempotency_key:crypto.randomUUID()});
   a.equal(complete.status,200,JSON.stringify(complete));const attrs=(await f.admin.query('SELECT attribs FROM public.campaigns WHERE id=$1',[c.id])).rows[0].attribs.crm;
   check(complete.body.tracking.policy===C.VERSION&&attrs.draft_ready===true&&/^[a-f0-9]{32}$/.test(attrs.content_template_version),'complete-update-keeps-id-and-native-content-proof-'+brand);
  }
  // Lose the DB ACK after its atomic INSERT/receipt commit. Query the same key.
  const brand='aristo',catalog=(await f.admin.query('SELECT public.shrigma_campaign_catalog($1) AS c',[brand])).rows[0].c,definition=C.normalizeDraft({schema_version:C.VERSION,brand,channel:'email',name:'[TESTE] ACK perdido',subject:'[TESTE] Uma intenção',tags:[C.DRAFT_EDITOR_TAG],send_at:null},{catalog}),key=crypto.randomUUID(),original=f.effectPool.query;
  let lost=false;f.effectPool.query=async(text,args)=>{const r=await original(text,args);let effect;try{effect=JSON.parse(args?.[2]||'null');}catch{}if(!lost&&effect?.kind==='provider'&&effect.action==='draft_create'){lost=true;throw Error('SYNTHETIC_ACK_LOST_AFTER_COMMIT');}return r;};
  const lostCommand={acao:'campanha_salvar',brand,definition,idempotency_key:key};await run(lostCommand);f.effectPool.query=original;const recovered=await run({acao:'campanha_operacao',brand,idempotency_key:key});
  check(lost&&recovered.status===200&&recovered.body.operation.state==='succeeded','lost-ACK-recovered-by-GET-original-receipt');
  const replay=await run(lostCommand);check(hash(replay)===hash(recovered.body.operation.response),'lost-create-ACK-replay-is-exact-original-receipt');
  const ackCampaign=(await run({acao:'campanha_obter',brand,id:recovered.body.operation.providerId})).body.campaign,updateKey=crypto.randomUUID(),updateCommand={acao:'campanha_salvar',brand,id:ackCampaign.id,expected_version:ackCampaign.version,definition:{...ackCampaign.definition,subject:'[TESTE] ACK da alteração'},idempotency_key:updateKey};
  let updateLost=false;f.effectPool.query=async(text,args)=>{const r=await original(text,args);let effect;try{effect=JSON.parse(args?.[2]||'null');}catch{}if(!updateLost&&effect?.kind==='provider'&&effect.action==='draft_update'){updateLost=true;throw Error('SYNTHETIC_UPDATE_ACK_LOST_AFTER_COMMIT');}return r;};await run(updateCommand);f.effectPool.query=original;
  const updateRecovered=await run({acao:'campanha_operacao',brand,idempotency_key:updateKey}),updateReplay=await run(updateCommand);check(updateLost&&updateRecovered.body.operation.state==='succeeded'&&hash(updateReplay)===hash(updateRecovered.body.operation.response),'lost-update-ACK-GET-and-replay-keep-exact-receipt');
  check((await f.admin.query("SELECT count(*)::int AS n FROM public.campaigns WHERE attribs#>>'{crm,draft_editor}'='v2'")).rows[0].n===3,'lost-ACK-created-once');
  nativeCreates=f.events.slice(beforeNative).filter(e=>e.method==='POST'&&e.path==='/api/campaigns').length;check(nativeCreates===0,'partial-never-uses-native-create-with-fake-list');
  const reads=[];for(const c of created)reads.push(await run({acao:'campanha_obter',brand:c.definition.brand,id:c.id}));check(reads.every(r=>r.status===200),'both-brands-remain-readable');
  // Original BFF journals survive an installation return after lost source ACKs.
  const {DatabaseSync}=require('node:sqlite'),Cgateway=require('/gateway/services/dashboard-operational/campaign-write-contract.js'),Creturn=require('/gateway-return/services/dashboard-operational/campaign-write-contract.js'),Tgateway=require('/gateway/services/dashboard-operational/campaign-write-tracking.js'),{createCampaignCreator}=require('/gateway/services/dashboard-operational/crm-campaign-create.cjs'),{createCampaignDelivery}=require('/gateway/services/dashboard-operational/crm-campaign-delivery.cjs'),bff=[];
  for(const brand of ['aristo','fish']){
   const db=new DatabaseSync(':memory:'),userId=crypto.randomUUID(),ctx={userId},ciphers=new Map();let encrypted=0,posts=0;
   const encrypt=s=>{const c='v1.synthetic.fixture.'+Buffer.from(String(++encrypted)).toString('base64url');ciphers.set(c,s);return c;},decrypt=c=>ciphers.get(c),authorize=()=>({userId,role:'manager',slot:'growth-campaign',canEdit:true,credentialMac:'a'.repeat(64),caps:['read_content','draft','validate','submit']});
   const transport=async(_ctx,{method,command})=>{const r=await run(command);if(method==='POST'){posts++;throw Error('SYNTHETIC_BFF_ACK_LOST');}return r;};
   const common={db,authorize,transport,now:Date.now,encrypt,decrypt},creatorOptions=C=>({...common,enabled:true,profile:'crm-sandbox',allowedEmailDomains:['synthetic.invalid'],preflightDefinition:(d,{catalog})=>C.normalizeDraft(d,{catalog}),prepareDefinition:(d,{catalog,id,now})=>C.prepareDraft(d,{catalog,tracking:Tgateway,trackingId:id,now,initial:true}),hasOpenDelivery:()=>false}),deliveryOptions=C=>({...common,prepareDefinition:(d,{catalog,id,now})=>C.prepareDraft(d,{catalog,tracking:Tgateway,trackingId:id,now}).definition,hasOpenCreate:()=>false});
   const creator=createCampaignCreator(creatorOptions(Cgateway)),definition={schema_version:Cgateway.VERSION,brand,channel:'email',name:'[TESTE] BFF retorno '+brand,subject:'[TESTE] Rascunho BFF',tags:[Cgateway.DRAFT_EDITOR_TAG],send_at:null},createKey=crypto.randomUUID(),pendingCreate=await creator.submit(ctx,{acao:'campanha_criar',brand,definition,idempotency_key:createKey});a.equal(pendingCreate.state,'pending');
   const id=(await f.admin.query('SELECT id FROM public.campaigns WHERE name=$1',[definition.name])).rows[0].id,c=(await run({acao:'campanha_obter',brand,id})).body.campaign,delivery=createCampaignDelivery(deliveryOptions(Cgateway)),deliveryKey=crypto.randomUUID(),pendingDelivery=await delivery.submit(ctx,{acao:'campanha_salvar',brand,id,expected_version:c.version,definition:{...c.definition,subject:'[TESTE] Alteração BFF'},idempotency_key:deliveryKey});a.equal(pendingDelivery.state,'pending');
   check(posts===2,'BFF-lost-create-and-update-ACKs-use-original-journals-'+brand);bff.push({brand,db,ctx,id,createKey,deliveryKey,creatorOptions,deliveryOptions,get posts(){return posts;}});
  }
  const beforeReturn=(await f.admin.query('SELECT id,uuid,name,subject,body,altbody,attribs FROM public.campaigns ORDER BY id')).rows;await f.admin.query(fs.readFileSync('/draft/return.synthetic.sql','utf8'));
  // A still-running candidate can reach SQL after its write gate is closed.
  // Only a recognized atomic P0001 is a durable refusal; lost network ACKs above stay uncertain.
  for(const action of ['draft_create','draft_update']){
   const current=(await run({acao:'campanha_obter',brand,id:ackCampaign.id})).body.campaign,k=crypto.randomUUID(),command={acao:'campanha_salvar',brand,definition:action==='draft_create'?definition:{...current.definition,subject:'[TESTE] Recusa após fechamento'},idempotency_key:k,...(action==='draft_update'?{id:current.id,expected_version:current.version}:{})};
   const refused=await run(command),operation=await run({acao:'campanha_operacao',brand,idempotency_key:k});
   check(refused.status===503&&refused.body.error==='DRAFT_WRITES_DISABLED','in-flight-candidate-SQL-closure-is-explicit-refusal-'+action);
   check(operation.body.operation.state==='rejected'&&hash(operation.body.operation.response)===hash(refused),'closed-SQL-refusal-GET-original-intention-'+action);
   check(hash(await run(command))===hash(refused),'closed-SQL-refusal-replay-exact-'+action);
  }
  const returned=require('/return-source/services/crm-campaign/transport.cjs').createExecutor({pool:f.effectPool,native:f.native,nativeInternalEnabled:true}),returnRun=command=>returned({key:'synthetic-native-owner',command});
  for(const receipt of receipts){const q=await returnRun({acao:'campanha_operacao',brand:receipt.brand,idempotency_key:receipt.key});check(hash(q.body.operation)===hash(receipt.operation),'return-keeps-entire-original-receipt-'+receipt.brand);check(hash(await returnRun(receipt.command))===hash(receipt.operation.response),'return-replay-keeps-original-response-'+receipt.brand);const get=await returnRun({acao:'campanha_obter',brand:receipt.brand,id:q.body.operation.providerId});check(get.status===200,'return-reads-same-native-campaign-'+receipt.brand);}
  const blocked=await returnRun({...lostCommand,idempotency_key:crypto.randomUUID()});check(blocked.status===503&&blocked.body.error==='DRAFT_WRITES_DISABLED','return-closes-new-editor-writes-with-durable-refusal');check(hash(beforeReturn)===hash((await f.admin.query('SELECT id,uuid,name,subject,body,altbody,attribs FROM public.campaigns ORDER BY id')).rows),'return-does-not-rewrite-campaigns-or-receipts');
  for(const f of bff){const readonly=async(_ctx,{method,command})=>{a.equal(method,'GET');return returnRun(command);},creator=createCampaignCreator({...f.creatorOptions(Creturn),transport:readonly}),delivery=createCampaignDelivery({...f.deliveryOptions(Creturn),transport:readonly}),created=await creator.reconcile(f.ctx,{brand:f.brand,idempotency_key:f.createKey}),updated=await delivery.reconcile(f.ctx,{brand:f.brand,idempotency_key:f.deliveryKey});check(created.state==='succeeded'&&created.campaign.id===f.id,'returned-BFF-confirms-original-create-with-GET-'+f.brand);check(updated.state==='succeeded'&&updated.campaign.id===f.id,'returned-BFF-confirms-original-update-with-GET-'+f.brand);check(f.posts===2,'returned-BFF-never-reposts-'+f.brand);f.db.close();}
  console.log(JSON.stringify({ok:true,assertions,postgres:'17.10',productionUsed:false,customerDataUsed:false,sourceSends:0,nativeCampaignCreates:nativeCreates}));
 }finally{await closeAll();}
})().catch(e=>{console.error(e.stack);console.error(JSON.stringify({code:e.code,position:e.position,internalPosition:e.internalPosition,internalQuery:e.internalQuery,where:e.where,detail:e.detail}));process.exitCode=1;});
