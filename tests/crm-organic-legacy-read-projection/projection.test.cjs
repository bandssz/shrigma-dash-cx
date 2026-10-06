'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const Projection=require('../../services/dashboard-operational/domain/organic-legacy-read-projection/projection.cjs');
const canonicalNormalizer=path.resolve(__dirname,'../../ui/organic-v2/organic-contract-v1-0-2.js');
const preparedNormalizer=path.resolve(__dirname,'../../../../organic-v102-consumer-source-root2/files/ui/organic-v2/organic-contract-v1-0-2.js');
// Native checkout uses its canonical typed source; local preparation uses the
// closed Root2 source. Both must match the same exact public SHA before import.
const normalizerPath=process.env.ORGANIC_LEGACY_NORMALIZER_PATH||(fs.existsSync(canonicalNormalizer)?canonicalNormalizer:preparedNormalizer);
const bytes=fs.readFileSync(normalizerPath);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),'a53fc473eb2afec76259dea7f157aea69da8c2990f86b025874cd146450b3bb8');
const N=require(normalizerPath),P=Projection.createProjection({normalizer:N});
const period={from:'2026-09-19',to:'2026-09-19'};
const context=()=>({contextRevision:'session-scope-v7',sessionRevision:'session7',effectiveBrand:'aristo',role:'read',capabilities:{'link.create':{available:false,reason:'OFF'},'link.archive':{available:false,reason:'OFF'}},pendingOperations:[],operationJournal:{state:'complete',revision:'journal7'}});
const query=resource=>({resource,filters:{period:{...period},...(resource.startsWith('attribution-')?{model:'last_click'}:{})},expectedContextRevision:'session-scope-v7'});
const observation=q=>({resource:q.resource,filters:structuredClone(q.filters),contextRevision:'session-scope-v7',brandId:'aristo',state:'ready',source:'own_verified',coverage:'complete',freshness:'fresh',collectedAt:'2026-09-20T12:00:00Z',cacheAt:null,error:null});
const post=(changes={})=>({marca:'aristocrata',post_id:'post-own-1',rede:'instagram',publicado_em:'2026-09-19T15:00:00Z',dia:'2026-09-19',legenda:'Título da publicação',formato:'REELS',impulsionado:false,alcance:120,curtidas:0,comentarios:null,salvos:'2',compartilh:3,...changes});
const story=(changes={})=>({marca:'aristo',story_id:'story-own-1',rede:'instagram',publicado_em:'2026-09-20T01:00:00Z',link_clicks:0,...changes});
const daily=(changes={})=>({marca:'aristo',dia:'2026-09-19',model:'last_click',source_system:'shopify',currency:'BRL',classification:'editorial',rule_version:'organico-utm-20260927-v2',rule_reason:'controle_utm_instagram_story',rede:'instagram',superficie:'story',utm_source:'instagram_social',utm_medium:'story',utm_campaign:'20260919_fato',utm_content:'',utm_term:'',utm_provenance:'ledger_normalized',piece_status:'nao_vinculada',utm_raw_available:false,detail_level:'utm',pedidos:2,receita_liquida:'300.500000',leitura_mais_antiga:'2026-09-19T15:00:00Z',coletado_em:'2026-09-20T12:00:00Z',...changes});
const quality=(changes={})=>({marca:'aristo',dia:'2026-09-19',pedidos_lidos:4,pagos_elegiveis:3,jornada_pendente:1,jornada_parcial:0,ultima_sessao_conhecida:3,ultima_sessao_desconhecida:0,origem_nao_direta_desconhecida:1,receita_elegivel:'400.00',...changes});
const attribution=(changes={})=>({schema_version:1,janela:{ini:period.from,fim:period.to},window_days:30,source_system:'shopify',currency:'BRL',rule_version:'organico-utm-20260927-v2',utm_raw_available:false,assistance_available:false,piece_identity_available:false,daily:[daily()],quality:[quality()],coverage:[{marca:'aristo',dia:period.from,checked_at:'2026-09-20T12:00:00Z'}],...changes});
const link=(changes={})=>({id:'620a3b59-a46f-4f84-afb2-1dc3c9381c52',marca:'aristo',dia:period.from,destino:'https://oaristocrata.com/products/fato',url:'https://oaristocrata.com/products/fato?utm_source=instagram_social&utm_medium=story&utm_campaign=fato',utm_source:'instagram_social',utm_medium:'story',utm_campaign:'fato',arquivado:false,criado_em:'2026-09-19T15:00:00Z',criado_por:'private actor not allowed',observacao:'private note not allowed',origem:'planilha',...changes});
function run(resource,payload,options={}){const q=options.query||query(resource),ctx=options.context||context();return P.projectRead({query:q,context:ctx,payload,observation:options.unobserved?undefined:options.observation||observation(q)});}
function valid(r,q=query('posts'),ctx=context()){const n=N.normalizeRead(q,r,ctx);assert.equal(n.state,'valid');return n.value;}
function frozen(v){if(v&&typeof v==='object'){assert.ok(Object.isFrozen(v));for(const x of Object.values(v))frozen(x);}}
function deepFreeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))deepFreeze(x);Object.freeze(v);}return v;}

test('real normalizer pin and pure default OFF surface',()=>{
 assert.equal(N.version,'1.0.2-proposed');assert.deepEqual(Object.keys(P),['projectRead']);assert.deepEqual(Object.keys(Projection),['createProjection','metadata']);
 assert.deepEqual(Projection.metadata,{version:N.version,sourceOnly:true,operational:false,readAdmission:false,writeAuthorized:false,sendAuthorized:false,perOrderSupported:false});assert.ok(Object.isFrozen(P));assert.ok(Object.isFrozen(Projection));assert.ok(Object.isFrozen(Projection.metadata));
 for(const normalizer of [null,{}, {...N,version:'1.0.1-proposed'}, {...N,normalizeRead:null}])assert.throws(()=>Projection.createProjection({normalizer}),{message:'ORGANIC_READ_NORMALIZER_REQUIRED'});
});

test('posts isolate brand and Brazil publication day, preserving original ID/timestamp and excluding known paid/outside rows',()=>{
 const payload=deepFreeze({cx_post:[post(),post({marca:'fish',post_id:'foreign',legenda:'must not appear'}),post({post_id:'boosted',impulsionado:true}),post({post_id:'outside',publicado_em:'2026-09-20T15:00:00Z',dia:'2026-09-20'})]});const before=JSON.stringify(payload),r=run('posts',payload),v=valid(r);
 assert.equal(r.state,'ready');assert.equal(v.data.items.length,1);assert.equal(v.data.items[0].id,'post-own-1');assert.equal(v.data.items[0].publishedAt,'2026-09-19T15:00:00Z');assert.equal(v.data.items[0].brandId,'aristo');assert.equal(v.data.items[0].title,'Título da publicação');assert.equal(v.data.items[0].kind,'REELS');assert.equal(v.data.items[0].metrics.likes,0);assert.equal(v.data.items[0].metrics.comments,null);assert.equal(v.data.items[0].metrics.saves,2);assert.equal(JSON.stringify(payload),before);assert.doesNotMatch(JSON.stringify(r),/foreign|must not appear|boosted|outside/);frozen(r);
});

test('stories use BR day across UTC midnight, keep known zero and never invent expiry or sales',()=>{
 const r=run('stories',{cx_story:[story(),story({story_id:'out',publicado_em:'2026-09-19T01:00:00Z'})]});const v=valid(r,query('stories'));
 assert.equal(v.data.items.length,1);assert.equal(v.data.items[0].publishedAt,'2026-09-20T01:00:00Z');assert.equal(v.data.items[0].metrics.linkClicks,0);assert.equal(v.data.items[0].expiresAt,null);assert.equal(v.data.items[0].source,'unknown');assert.equal(v.data.items[0].metrics.reach,null);assert.doesNotMatch(JSON.stringify(r),/receita|amount|orders|revenue/);
});

test('strict count values and explicit share aliases do not convert invalid or absent metrics to zero',()=>{
 const r=run('posts',{cx_post:[post({alcance:'9007199254740993',curtidas:'',salvos:-1,compartilh:1,compartilhamentos:2})]});const m=r.data.items[0].metrics;
 assert.equal(m.reach,null);assert.equal(m.likes,null);assert.equal(m.saves,null);assert.equal(m.shares,null);assert.equal(m.views,null);
 const r2=run('posts',{cx_post:[post({compartilhamentos:'3'})]});assert.equal(r2.data.items[0].metrics.shares,3);
});

test('missing, malformed, sparse and inherited collections refuse rather than become an empty read',()=>{
 const inherited=Object.create({cx_post:[]}),hole=Array(1);Array.prototype[0]=post();try{
  for(const payload of [{},{cx_post:null},{cx_post:{}},{cx_post:hole},inherited]){const r=run('posts',payload);assert.equal(r.state,'unavailable');assert.equal(r.data,null);}
 }finally{delete Array.prototype[0];}
});

test('only actual dense empty plus complete fresh observed scope confirms absence',()=>{
 const r=run('posts',{cx_post:[]});assert.equal(r.state,'empty');assert.equal(valid(r).emptyConfirmed,true);
 for(const changed of [{coverage:'unknown'},{coverage:'partial'},{freshness:'stale'},{freshness:'unknown'}]){const q=query('posts');const r=run('posts',{cx_post:[]},{observation:{...observation(q),...changed}});assert.equal(r.state,'unavailable');assert.equal(r.data,null);}
 assert.equal(run('posts',{cx_post:[]},{unobserved:true}).state,'unavailable');
});

test('nonempty unobserved or stale snapshots stay useful but metadata is not inferred from row/cache/generation dates',()=>{
 const r=run('posts',{cx_post:[post({coletado_em:'2026-09-20T12:00:00Z',ultima_coleta:'2026-09-20T12:00:00Z'})],gerado_em:'2026-09-20T12:00:00Z'},{unobserved:true});assert.equal(r.state,'ready');assert.equal(r.source,'unknown');assert.equal(r.coverage,'unknown');assert.equal(r.freshness,'unknown');assert.equal(r.collectedAt,null);assert.equal(r.cacheAt,null);valid(r);
 const q=query('posts'),r2=run('posts',{cx_post:[post()]},{observation:{...observation(q),freshness:'stale',cacheAt:'2026-09-20T10:00:00Z'}});assert.equal(r2.freshness,'stale');assert.equal(r2.cacheAt,'2026-09-20T10:00:00Z');assert.equal(r2.state,'ready');
});

test('metadata resource/period/model/brand/revision mismatches and stale query revision close with no fallback',()=>{
 const q=query('posts'),o=observation(q);
 for(const changed of [{resource:'stories'},{brandId:'fish'},{contextRevision:'prior'},{filters:{period:{from:'2026-09-18',to:'2026-09-18'}}}]){const r=run('posts',{cx_post:[post()]},{observation:{...o,...changed}});assert.equal(r.state,'unavailable');assert.equal(r.data,null);}
 for(const changed of [{expectedContextRevision:'old'},{expectedContextRevision:undefined},{filters:{period,brand:'fish'}},{filters:{period,model:'last_click'}}])assert.equal(run('posts',{cx_post:[post()]},{query:{...q,...changed}}).state,'unavailable');
 const aq=query('attribution-aggregate'),ao=observation(aq);assert.equal(run('attribution-aggregate',{organico_attribution:attribution()},{observation:{...ao,filters:{period,model:'last_non_direct'}}}).state,'unavailable');
 for(const effectiveBrand of ['todas','aristocrata','unknown'])assert.equal(run('posts',{cx_post:[post()]},{context:{...context(),effectiveBrand}}).state,'forbidden');
});

test('attribution keeps one requested model/brand/period, exact decimals and the original factual window without sums or per-order IDs',()=>{
 const payload=deepFreeze({organico_attribution:attribution({daily:[daily({post_id:'unproven',story_id:'unproven',email:'private'}),daily({model:'last_non_direct',receita_liquida:'999.00'}),daily({marca:'fish',receita_liquida:'888.00'}),daily({dia:'2026-09-18',receita_liquida:'777.00'})],quality:[quality(),quality({marca:'fish'})],coverage:[{marca:'aristo',dia:period.from,checked_at:'2026-09-20T12:00:00Z'},{marca:'fish',dia:period.from,checked_at:'2026-09-20T12:00:00Z'}]})});const before=JSON.stringify(payload),r=run('attribution-aggregate',payload),v=valid(r,query('attribution-aggregate'));
 assert.equal(v.data.model,'last_click');assert.deepEqual(v.data.period,period);assert.equal(v.data.daily.length,1);assert.equal(v.data.daily[0].receita_liquida,'300.500000');assert.equal(v.data.quality.length,1);assert.equal(v.data.coverage.length,1);assert.equal(v.data.window.days,30);assert.equal(v.data.window.utmRawAvailable,false);assert.equal(v.data.currency,'BRL');assert.equal(v.data.perOrder,null);assert.doesNotMatch(JSON.stringify(r),/unproven|private|999\.00|888\.00|777\.00/);assert.equal(JSON.stringify(payload),before);
 const q=query('attribution-aggregate');q.filters.model='last_non_direct';const r2=run('attribution-aggregate',payload,{query:q});assert.equal(r2.data.daily.length,1);assert.equal(r2.data.daily[0].receita_liquida,'999.00');assert.equal(r2.data.model,'last_non_direct');
});

test('exact monetary strings, known integer zero and unknown fractional numbers do not round or manufacture money/counts',()=>{
 const r=run('attribution-aggregate',{organico_attribution:attribution({daily:[daily({receita_liquida:'0.000000',pedidos:0}),daily({receita_liquida:0,pedidos:'0'}),daily({receita_liquida:0.1,pedidos:'9007199254740993'}),daily({receita_liquida:'-7.250000',pedidos:null})],quality:[quality({receita_elegivel:0.2})]})});
 assert.deepEqual(r.data.daily.map(x=>x.receita_liquida),['0.000000','0',null,'-7.250000']);assert.deepEqual(r.data.daily.map(x=>x.pedidos),[0,0,null,null]);assert.equal(r.data.quality[0].receita_elegivel,null);
});

test('missing auxiliary attribution source stays null/partial and never zero; malformed arrays or source window refuse',()=>{
 const a=attribution();delete a.quality;const r=run('attribution-aggregate',{organico_attribution:a});assert.equal(r.state,'ready');assert.equal(r.coverage,'partial');assert.equal(r.data.quality,null);assert.equal(r.data.daily.length,1);valid(r,query('attribution-aggregate'));
 for(const change of [{daily:null},{coverage:{}},{quality:Array(1)},{schema_version:2},{janela:{ini:'2026-09-18',fim:'2026-09-18'}}])assert.equal(run('attribution-aggregate',{organico_attribution:attribution(change)}).state,'unavailable');
 assert.equal(run('attribution-aggregate',{}).state,'unavailable');
});

test('empty attribution rows preserve known quality/coverage instead of falsely declaring no orders',()=>{
 const r=run('attribution-aggregate',{organico_attribution:attribution({daily:[]})});assert.equal(r.state,'ready');assert.equal(r.data.daily.length,0);assert.equal(r.data.quality[0].pagos_elegiveis,3);assert.equal(r.data.coverage.length,1);valid(r,query('attribution-aggregate'));
 const r2=run('attribution-aggregate',{organico_attribution:attribution({daily:[],quality:[],coverage:[]})});assert.equal(r2.state,'empty');assert.equal(valid(r2,query('attribution-aggregate')).emptyConfirmed,true);
 const q=query('attribution-aggregate');assert.equal(run('attribution-aggregate',{organico_attribution:attribution({daily:[],quality:[],coverage:[]})},{observation:{...observation(q),freshness:'stale'}}).state,'unavailable');
});

test('unknown currency/window facts are not filled from model, row, generation time or constants',()=>{
 const a=attribution();for(const k of ['currency','window_days','source_system','rule_version','utm_raw_available','assistance_available','piece_identity_available'])delete a[k];const r=run('attribution-aggregate',{organico_attribution:a},{unobserved:true});assert.equal(r.data.currency,null);assert.deepEqual(r.data.window,{days:null,ruleVersion:null,sourceSystem:null,utmRawAvailable:null,assistanceAvailable:null,pieceIdentityAvailable:null});assert.equal(r.collectedAt,null);assert.equal(r.freshness,'unknown');
 const r2=run('attribution-aggregate',{organico_attribution:attribution({daily:[daily({currency:'EUR'})]})});assert.equal(r2.data.currency,null);assert.equal(r2.data.daily[0].currency,'EUR');assert.equal(r2.coverage,'partial');
});

test('malformed own rows lower complete coverage while foreign scoped rows never leak and missing-ID rows do not mint identity',()=>{
 const r=run('posts',{cx_post:[post(),post({post_id:undefined}),post({post_id:'bad-day',publicado_em:'2026-02-31T12:00:00Z'}),Object.assign(Object.create({marca:'aristo'}),{post_id:'inherited-brand',publicado_em:'2026-09-19T15:00:00Z'})]});assert.equal(r.state,'ready');assert.equal(r.coverage,'partial');assert.equal(r.data.items.length,1);
 assert.equal(run('posts',{cx_post:[post({post_id:null})]}).state,'unavailable');
});

test('legacy links preserve original identity/archive state, exclude private fields and leave absent revision unknown',()=>{
 const r=run('links',{ok:true,links:[link(),link({id:'archived',arquivado:true}),link({id:'foreign',marca:'fish'})]});const v=valid(r,query('links'));assert.equal(v.data.items.length,2);const active=v.data.items[0],archived=v.data.items[1];assert.equal(active.id,'620a3b59-a46f-4f84-afb2-1dc3c9381c52');assert.equal(active.revision,null);assert.equal(active.origin,'instagram_social');assert.equal(active.surface,'story');assert.equal(active.copyEligible,true);assert.equal(active.archiveEligible,false);assert.equal(archived.state,'archived');assert.equal(archived.copyEligible,false);assert.equal(archived.archiveEligible,false);assert.doesNotMatch(JSON.stringify(r),/private actor|private note|criado_por|observacao|foreign/);
});

test('undated links do not borrow creation time or campaign date; URL missing/unsafe and archive flag unknown remain unusable',()=>{
 const r=run('links',{links:[link(),link({id:'undated',dia:null,utm_campaign:'20260919_fato'}),link({id:'unsafe',url:'javascript:alert(1)',destino:'https://user:password@invalid.test/x',arquivado:undefined})]});assert.equal(r.coverage,'partial');assert.equal(r.data.items.length,2);const row=r.data.items[1];assert.equal(row.url,null);assert.equal(row.destination,null);assert.equal(row.state,'unknown');const v=valid(r,query('links'));assert.equal(v.data.items[1].copyEligible,false);assert.equal(v.data.items[1].archiveEligible,false);assert.doesNotMatch(JSON.stringify(r),/undated|javascript|password/);
 assert.equal(run('links',{links:[link({dia:null})]}).state,'unavailable');
});

test('duplicate selected identities close rather than merge; foreign same IDs remain isolated',()=>{
 for(const payload of [{cx_post:[post(),post()]},{cx_post:[post({post_id:7}),post({post_id:'7'})]}])assert.equal(run('posts',payload).state,'unavailable');
 assert.equal(run('posts',{cx_post:[post(),post({marca:'fish'})]}).data.items.length,1);
 assert.equal(run('links',{links:[link(),link()]}).state,'unavailable');
});

test('source/observation failures use fixed public messages and never expose raw error values',()=>{
 const secret='never-echo-source-secret';for(const p of [{erro:secret,cx_post:[post()]},{error:Error(secret),cx_post:[post()]},{ok:false,cx_post:[post()]}]){const r=run('posts',p);assert.equal(r.state,'unavailable');assert.doesNotMatch(JSON.stringify(r),new RegExp(secret));}
 const q=query('posts');for(const state of ['unavailable','forbidden']){const r=run('posts',{cx_post:[post()]},{observation:{...observation(q),state,error:secret}});assert.equal(r.state,state);assert.equal(r.data,null);assert.doesNotMatch(JSON.stringify(r),new RegExp(secret));}
 assert.equal(run('posts',{cx_post:[post()]},{observation:{...observation(q),state:'empty'}}).state,'unavailable');
 const p={};Object.defineProperty(p,'cx_post',{get(){throw Error(secret);}});assert.doesNotMatch(JSON.stringify(run('posts',p)),new RegExp(secret));
});

test('per-order and mutations stay unsupported even with master role, positive capabilities, raw orders and payload callbacks',()=>{
 let calls=0;const ctx={...context(),role:'master',capabilities:{'link.create':{available:true,reason:null},'link.archive':{available:true,reason:null}}};
 const r=run('attribution-order-if-admitted',{orders:[{id:'private-order',amount:10}],send(){calls++;}},{context:ctx});assert.equal(r.state,'unavailable');assert.equal(r.data,null);assert.equal(calls,0);assert.doesNotMatch(JSON.stringify(r),/private-order/);
 const l=run('links',{links:[link()],submit(){calls++;}},{context:ctx});assert.equal(l.state,'ready');assert.equal(calls,0);assert.equal(l.data.items[0].revision,null);assert.equal(Projection.metadata.writeAuthorized,false);assert.equal(P.beginMutation,undefined);assert.equal(P.submit,undefined);assert.equal(P.receipt,undefined);
});


test('unknown paid classification keeps known post facts as partial without claiming organic completeness',()=>{
 const p=post();delete p.impulsionado;const r=run('posts',{cx_post:[p]});assert.equal(r.state,'ready');assert.equal(r.coverage,'partial');assert.equal(r.data.items[0].id,p.post_id);assert.equal(r.data.items[0].metrics.likes,0);assert.equal(r.data.items[0].source,'unknown');
});

test('active-only legacy listing cannot confirm the entire link history or its absence',()=>{
 const r=run('links',{links:[link()]});assert.equal(r.state,'ready');assert.equal(r.coverage,'partial');assert.equal(r.data.items[0].revision,null);assert.equal(valid(r,query('links')).meta.coverage,'partial');
 const r2=run('links',{links:[]});assert.equal(r2.state,'unavailable');assert.equal(r2.data,null);
});


test('inherited observation metadata cannot prove freshness, completeness, dates or state',()=>{
 const q=query('posts');
 const scope={resource:q.resource,filters:structuredClone(q.filters),contextRevision:context().contextRevision,brandId:'aristo'};
 for(const state of ['ready','empty','unavailable','forbidden']){
  const inherited=Object.assign(Object.create({source:'own_verified',coverage:'complete',freshness:'fresh',collectedAt:'2026-09-20T12:00:00Z',cacheAt:'2026-09-20T10:00:00Z',state}),scope);
  const empty=run('posts',{cx_post:[]},{observation:inherited});assert.equal(empty.state,'unavailable');assert.equal(empty.data,null);
  const r=run('posts',{cx_post:[post()]},{observation:inherited});assert.equal(r.state,'ready');assert.equal(r.source,'unknown');assert.equal(r.coverage,'unknown');assert.equal(r.freshness,'unknown');assert.equal(r.collectedAt,null);assert.equal(r.cacheAt,null);assert.equal(valid(r).emptyConfirmed,false);
 }
 const inheritedGetters={};let reads=0;
 for(const field of ['source','coverage','freshness','collectedAt','cacheAt','state'])Object.defineProperty(inheritedGetters,field,{get(){reads++;throw Error('inherited metadata must not be read');}});
 const r=run('posts',{cx_post:[post()]},{observation:Object.assign(Object.create(inheritedGetters),scope)});
 assert.equal(r.state,'ready');assert.equal(reads,0);assert.equal(r.source,'unknown');assert.equal(r.coverage,'unknown');assert.equal(r.freshness,'unknown');assert.equal(r.collectedAt,null);assert.equal(r.cacheAt,null);
 const own=Object.assign(Object.create({state:'empty'}),observation(q));delete own.state;
 assert.equal(run('posts',{cx_post:[post()]},{observation:own}).state,'ready');
 own.state='forbidden';assert.equal(run('posts',{cx_post:[post()]},{observation:own}).state,'forbidden');
 own.state='ready';assert.equal(run('posts',{cx_post:[]},{observation:own}).state,'empty');
});
