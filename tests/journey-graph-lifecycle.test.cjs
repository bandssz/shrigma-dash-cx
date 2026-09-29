'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const C=require('../n8n/growth/journey-graph-lifecycle-contract.cjs');
const {createLifecycleReviewer}=require('../n8n/growth/journey-graph-lifecycle-review.cjs');
const {body,graph:legacyGraph}=require('./journey-graph-release-fixture.cjs');
const copy=x=>JSON.parse(JSON.stringify(x)),T=Date.parse('2026-09-28T12:00:00.000Z'),at=n=>new Date(n).toISOString();
const id=n=>'70000000-0000-4000-8000-'+String(n).padStart(12,'0'),hash='a'.repeat(64),authorization='Bearer synthetic-private-token';
function setup(brand='fish',options={}){
 let time=T;
 const binding='email.template.'+(brand==='fish'?60:95),snapshot='snapshot_'+'a'.repeat(48);
 const definition={version:'journey_graph_v1',brand,name:'Jornada sintética',nodes:[{id:'entry',type:'trigger',event:'cart.abandoned'},{id:'mail',type:'message',binding},{id:'end',type:'exit',reason:'finished'}],edges:[{from:'entry',port:'next',to:'mail'},{from:'mail',port:'next',to:'end'}]};
 const catalog={version:'journey_graph_v1',brand,triggers:[{key:'cart.abandoned',brand,available:true,fields:['cart.abandoned_at','purchase.confirmed','contact.email_allowed']}],fields:[{key:'cart.abandoned_at',type:'timestamp',available:true,max_age_seconds:300},{key:'purchase.confirmed',type:'boolean',available:false,max_age_seconds:300},{key:'contact.email_allowed',type:'boolean',available:false,max_age_seconds:300}],messages:[{key:binding,brand,channel:'email',available:true,release:snapshot,required_fields:[]}]};
 const source={brand,template_id:brand==='fish'?60:95,binding,source_snapshot:snapshot,native:{type:'tx',subject:'Seu carrinho',body:body(brand),body_source:null},slot:legacyGraph(brand).steps[0],published_version:6};
 const stored={server:{journey_id:id(1),brand,version:3,revision:2,published_revision:null,paused:true},definition,catalog:copy(catalog),content_hash:C.digest({definition,catalog})};
 const state={actor:'panel:synthetic',caps:['read_content','validate','draft','submit'],stored,catalog,source,checked_at:at(T)};
 const calls=[],hooks={},provider={};
 for(const name of ['authenticate','readDraft','readCatalog','readSource'])provider[name]=async args=>{
  calls.push({name,brand:args.brand,aborted:args.signal.aborted});if(hooks[name]){const r=await hooks[name](args,calls.filter(c=>c.name===name).length);if(r!==undefined)return r;}
  const data=name==='authenticate'?{actor:state.actor,caps:state.caps}:name==='readDraft'?state.stored:name==='readCatalog'?{catalog:state.catalog}:{source:state.source};
  return {...copy(data),checked_at:state.checked_at};
 };
 for(const name of ['write','publish','create','send','capture','enroll'])provider[name]=()=>{throw Error('Unexpected mutation '+name);};
 const reviewer=createLifecycleReviewer({provider,clock:()=>time,...options});
 const request={action:'review',brand,journey_id:id(1),expected_version:3};
 return {state,calls,hooks,provider,reviewer,request,now:n=>time=n,seal:()=>state.stored.content_hash=C.digest({definition:state.stored.definition,catalog:state.stored.catalog}),review:()=>reviewer.review(request,{authorization})};
}
test('future command vocabulary is strict, binds exact payload and never exposes execution',()=>{
 const common={brand:'fish',journey_id:id(1),expected_version:3,request_id:id(2)};
 const commands=[{action:'review',brand:'fish',journey_id:id(1),expected_version:3},{action:'status',brand:'fish',journey_id:id(1)},{action:'operation',brand:'fish',request_id:id(2)},
  {...common,action:'prepare',review_hash:hash,confirm:'preparar'},
  {...common,action:'publish',prepared_revision:2,prepared_hash:hash,confirm:'publicar'},
  {...common,action:'activate',published_revision:2,publication_hash:hash,admission_review_hash:hash,confirm:'ativar'},
  {...common,action:'pause',published_revision:2,confirm:'pausar'}];
 for(const p of commands){assert.deepEqual(C.validateRequest(p),p);assert.equal(C.commandFingerprint(p).length,64);assert.throws(()=>C.validateRequest({...p,actor:'panel:caller'}),{code:'GRAPH_LIFECYCLE_INPUT'});assert.throws(()=>C.validateRequest({...p,brand:'todas'}),{code:'GRAPH_LIFECYCLE_INPUT'});const key=Object.keys(p).at(-1),missing={...p};delete missing[key];assert.throws(()=>C.validateRequest(missing),{code:'GRAPH_LIFECYCLE_INPUT'});}
 for(const p of commands.filter(x=>x.confirm)){assert.throws(()=>C.validateRequest({...p,confirm:true}),{code:'GRAPH_LIFECYCLE_INPUT'});assert.throws(()=>C.validateRequest({...p,confirm:'publicar tudo'}),{code:'GRAPH_LIFECYCLE_INPUT'});assert.notEqual(C.commandFingerprint(p),C.commandFingerprint({...p,request_id:id(3)}));}
 const p=commands[4];assert.equal(C.validateRequest({...p,prepared_revision:4}).prepared_revision,4,'revision/version relation is checked only from locked server state');assert.throws(()=>C.validateRequest({...p,expected_version:2147483647}),{code:'GRAPH_LIFECYCLE_INPUT'});assert.equal(C.ENABLED,false);
});
test('input copying refuses accessors, exotic objects, symbols and cycles without executing them',()=>{
 let accessed=0;const p={get action(){accessed++;return 'review';}};assert.throws(()=>C.validateRequest(p));assert.equal(accessed,0);
 for(const p of [new Date(),Object.assign({a:1},{[Symbol('secret')]:2}),(()=>{const x={};x.x=x;return x;})()])assert.throws(()=>C.copy(p));
 for(const p of [null,[],{action:{toString:'review'}},{action:'review',brand:'fish',journey_id:{toString:id(1)},expected_version:3},{action:'prepare',brand:'fish',journey_id:id(1),expected_version:3,request_id:id(2),review_hash:{toString:hash},confirm:'preparar'}])assert.throws(()=>C.validateRequest(p),{code:'GRAPH_LIFECYCLE_INPUT'});
 assert.equal(C.digest({b:2,a:1}),C.digest({a:1,b:2}));
});
for(const brand of ['fish','aristo']){
 test(brand+': fresh review preserves original and proposes only a distinct unreserved revision',async()=>{
  const f=setup(brand),before=copy(f.state),r=await f.review();
  assert.deepEqual(f.state,before);assert.equal(r.state,'compatible_for_preparation');assert.equal(r.proposal.proposed_revision,3);assert.equal(r.proposal.revision_reserved,false);assert.deepEqual(r.proposal.definition,before.stored.definition);assert.equal(r.original.revision,2);assert.equal(r.proposal.message.material_version,'journey_graph_release_v2');assert.equal(r.proposal.message.purchase_policy.field,'purchase.observed_for_cart');
  for(const key of Object.keys(r).filter(k=>k.startsWith('authorizes_')))assert.equal(r[key],false);
  for(const key of ['release_id','native_id','operational_catalog'])assert.equal(r.proposal[key],null);
  assert.equal(f.state.catalog.fields.find(x=>x.key==='contact.email_allowed').available,false);assert.equal(f.state.catalog.fields.some(x=>x.key==='purchase.observed_for_cart'),false);
  assert.equal(r.outstanding.length,5);assert.equal(r.review_hash.length,64);assert.ok(Object.isFrozen(r.proposal.definition));assert.notEqual(r.proposal.definition,f.state.stored.definition);
  const publicText=JSON.stringify(r);assert.doesNotMatch(publicText,/synthetic-private-token|panel:synthetic|<html>|body_source|from_email|Reply-To/);
  assert.deepEqual(f.calls.map(x=>x.name),['authenticate','readDraft','readCatalog','readSource','readSource','readDraft','readCatalog','authenticate']);
  assert.ok(f.calls.every(x=>!x.aborted));assert.deepEqual(await f.review(),r,'same timestamp and fresh identical data have the same checksum');assert.equal(f.calls.length,16);
 });
 test(brand+': stale, future and mismatched revision reads cannot produce a proposal',async()=>{
  for(const timestamp of [T-30001,T+1]){const f=setup(brand);f.state.checked_at=at(timestamp);await assert.rejects(f.review(),{code:'GRAPH_LIFECYCLE_READ_UNCONFIRMED'});}
  const f=setup(brand);f.state.stored.server.version=4;await assert.rejects(f.review(),{code:'GRAPH_LIFECYCLE_VERSION'});
  const other=setup(brand);other.state.stored.server.brand=brand==='fish'?'aristo':'fish';await assert.rejects(other.review(),{code:'GRAPH_LIFECYCLE_CORRUPT'});
 });
 test(brand+': catalog/source drift and concurrent edits are fenced without modifying the draft',async()=>{
  const f=setup(brand);f.state.source.source_snapshot='snapshot_'+'b'.repeat(48);const r=await f.review();assert.equal(r.state,'blocked');assert.equal(r.proposal,null);assert.ok(r.blockers.some(b=>b.code==='source_changed'));
  const changed=setup(brand);changed.hooks.readSource=(_a,n)=>{if(n===2)changed.state.source.native.subject='Mudou sem alterar o snapshot declarado';};await assert.rejects(changed.review(),{code:'GRAPH_LIFECYCLE_DRIFT'});
  const edited=setup(brand);edited.hooks.readDraft=(_a,n)=>{if(n===2){edited.state.stored.definition.name='Mudou';edited.seal();}};await assert.rejects(edited.review(),{code:'GRAPH_LIFECYCLE_DRIFT'});
  const catalog=setup(brand);catalog.hooks.readCatalog=(_a,n)=>{if(n===2)catalog.state.catalog.messages[0].release='snapshot_'+'c'.repeat(48);};await assert.rejects(catalog.review(),{code:'GRAPH_LIFECYCLE_DRIFT'});
 });
 test(brand+': removed capability or changed operator at final authentication rejects all output',async()=>{
  for(const change of [s=>s.caps=['read_content'],s=>s.actor='panel:another',s=>s.actor={toString:'panel:synthetic'},s=>s.caps=[]]){const f=setup(brand);f.hooks.authenticate=(_a,n)=>{if(n===2)change(f.state);};await assert.rejects(f.review(),{code:'GRAPH_LIFECYCLE_ACCESS'});}
  const noAccess=setup(brand);noAccess.state.caps=['read_content'];await assert.rejects(noAccess.review(),{code:'GRAPH_LIFECYCLE_ACCESS'});assert.deepEqual(noAccess.calls.map(x=>x.name),['authenticate']);
 });
}
test('unsupported event, message count, channel and slot receive human blockers without apparent readiness',async()=>{
 const edits=[['trigger',f=>{f.state.stored.definition.nodes[0].event='order.created';}],['message_count',f=>{f.state.stored.definition.nodes.push({id:'second',type:'message',binding:f.state.source.binding});}],['channel',f=>{f.state.catalog.messages[0].channel='whatsapp';f.state.stored.catalog=copy(f.state.catalog);}],['binding',f=>{f.state.source.slot.key='email:other';}],['material',f=>{f.state.source.native.body+='<script>unsafe()</script>';}],['binding',f=>{f.state.source=null;}]];
 for(const [code,edit]of edits){const f=setup();edit(f);f.seal();const before=copy(f.state),r=await f.review();assert.equal(r.proposal,null);assert.equal(r.state,'blocked');assert.ok(r.blockers.some(b=>b.code===code&&b.message.length>30),code);assert.deepEqual(f.state,before);assert.equal(r.authorizes_publish,false);}
});
test('time-window check follows the longest path and does not add mutually exclusive waits',async()=>{
 function branches(seconds){const f=setup();f.state.stored.definition.nodes.splice(1,0,{id:'condition',type:'condition',expression:{all:[{field:'cart.abandoned_at',op:'before',value:at(T)}]},on_unknown:{max_wait_seconds:60,retry_seconds:30}},{id:'yeswait',type:'wait',seconds},{id:'nowait',type:'wait',seconds});f.state.stored.definition.edges=[{from:'entry',port:'next',to:'condition'},{from:'condition',port:'yes',to:'yeswait'},{from:'condition',port:'no',to:'nowait'},{from:'yeswait',port:'next',to:'mail'},{from:'nowait',port:'next',to:'mail'},{from:'mail',port:'next',to:'end'}];f.seal();return f;}
 assert.equal((await branches(2000).review()).state,'compatible_for_preparation');assert.ok((await branches(3540).review()).blockers.some(b=>b.code==='time_window'));
});
test('a proposal never emits a revision outside its own supported version range',async()=>{
 const f=setup();f.state.stored.server.version=C.MAX_VERSION-1;f.state.stored.server.revision=C.MAX_VERSION-1;f.request.expected_version=C.MAX_VERSION-1;
 const r=await f.review();assert.equal(r.state,'blocked');assert.equal(r.proposal,null);assert.ok(r.blockers.some(b=>b.code==='version_limit'));assert.equal(f.calls.some(c=>c.name==='readSource'),false);
});
test('hash pins content, principal and time; it never masquerades as a stored SQL material digest',async()=>{
 const f=setup(),a=await f.review();f.state.actor='panel:another';const b=await f.review();assert.notEqual(a.review_hash,b.review_hash);f.now(T+1);const c=await f.review();assert.notEqual(b.review_hash,c.review_hash);
 assert.equal(a.proposal.message.hash_contract,'canonical_json_sha256_v1');assert.equal(Object.hasOwn(a.proposal.message,'material_sha256'),false);assert.equal(a.expires_at,at(T+C.MAX_AGE_MS));
});
test('bad storage hash, provider errors and deadline failure return only fixed errors and abort subsequent reads',async()=>{
 const f=setup();f.state.stored.content_hash='b'.repeat(64);await assert.rejects(f.review(),{code:'GRAPH_LIFECYCLE_CORRUPT'});
 const raw=setup();raw.hooks.readDraft=()=>{throw Error('synthetic-private-token select email from contacts');};await assert.rejects(raw.review(),e=>e.code==='GRAPH_LIFECYCLE_READ_UNCONFIRMED'&&!/token|email|contacts/.test(e.message));
 const timeout=setup('fish',{timeoutMs:10});let release,signal;timeout.hooks.readSource=args=>{signal=args.signal;return new Promise(resolve=>release=resolve);};await assert.rejects(timeout.review(),{code:'GRAPH_LIFECYCLE_TIMEOUT'});assert.equal(signal.aborted,true);const count=timeout.calls.length;release({checked_at:at(T),source:timeout.state.source});await new Promise(setImmediate);assert.equal(timeout.calls.length,count);
});
test('caller mutation during a read cannot switch the pinned journey, brand or expected version',async()=>{
 const f=setup();f.hooks.authenticate=(_a,n)=>{if(n===1){f.request.brand='aristo';f.request.expected_version=9;f.request.journey_id=id(99);}};const r=await f.review();assert.equal(r.original.brand,'fish');assert.equal(r.original.journey_id,id(1));assert.equal(r.original.version,3);assert.ok(f.calls.filter(x=>x.brand).every(x=>x.brand==='fish'));
});
test('reviewer rejects future commands and malformed authorization before provider calls',async()=>{
 const f=setup();await assert.rejects(f.reviewer.review({action:'pause',brand:'fish',journey_id:id(1),expected_version:3,request_id:id(2),published_revision:2,confirm:'pausar'},{authorization}),{code:'GRAPH_LIFECYCLE_INPUT'});await assert.rejects(f.reviewer.review(f.request,{authorization:'secret-in-url'}),{code:'GRAPH_LIFECYCLE_ACCESS'});assert.equal(f.calls.length,0);assert.deepEqual(Object.keys(f.reviewer),['enabled','review']);
});
test('existing SQL release-source shapes are read in a read-only PGlite transaction for both brands, with no release or native changes',async t=>{
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
 const db=new PGlite();t.after(()=>db.close());const actual=await require('./journey-graph-release-fixture.cjs').install(db);
 const before=(await db.query('SELECT * FROM templates ORDER BY id')).rows;
 for(const brand of ['fish','aristo']){
  const f=setup(brand),source=await actual.source(brand);f.state.source=source;f.state.catalog.messages[0].release=source.source_snapshot;f.state.stored.catalog=copy(f.state.catalog);f.seal();let reads=0;
  f.hooks.readSource=async({brand:asked,binding,signal})=>{assert.equal(asked,brand);assert.equal(binding,source.binding);assert.equal(signal.aborted,false);reads++;return {checked_at:at(T),source:await actual.source(asked)};};
  await db.query('BEGIN READ ONLY');try{const r=await f.review();assert.equal(r.state,'compatible_for_preparation');assert.equal(r.proposal.message.source_snapshot,source.source_snapshot);assert.equal(reads,2);await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}
  assert.equal((await db.query('SELECT count(*)::int n FROM crm_graph_candidate.message_release_v1')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int n FROM crm_graph_candidate.message_release_request_v1')).rows[0].n,0);
 }
 assert.deepEqual((await db.query('SELECT * FROM templates ORDER BY id')).rows,before);
});
