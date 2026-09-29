'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../n8n/growth/segment-audience-review.cjs'),A=require('../n8n/growth/segment-audience-contract.js');
const condition=(field,operator,value)=>({op:'condition',field,operator,value});
const purchase=condition('purchase.count','gt',0),popup=condition('signup.origin','is','popup'),clicked=condition('email.clicked','within_last_days',30);
const AUDIENCE_ID='b80c260a-75ae-4e0d-9e4f-01f878877651';
const START=Date.parse('2026-09-28T12:00:00.000Z'),time=n=>new Date(START+n).toISOString(),copy=x=>JSON.parse(JSON.stringify(x));
const dates=()=>({checked_at:time(-1000),expires_at:time(240000)}),authorization='Bearer synthetic-manager-key';
function fixture({brand='fish',rule=purchase,values=[[true],[false],[null]],timeoutMs=1000}={}){
 const definition=A.normalize({schema_version:A.VERSION,brand,name:'Synthetic audience',rule}),base=brand==='fish'?17:16,leaves=A.leaves(definition),calls=[],counts={},hooks={};let elapsed=0;
 const state={
  authenticate:{actor:'panel:synthetic-manager',caps:['read_content'],brands:[brand],...dates()},
  readDefinition:{brand,audience_id:AUDIENCE_ID,revision:3,definition,definition_hash:R.digest(definition),...dates()},
  readCatalog:{brand,base_list_id:base,catalog:{brand,current:true,currency:'BRL',fields:Object.keys(A.FIELDS).map(key=>({key,available:true})),lists:[{id:base,brand,available:true}],products:[{id:'gid://shopify/Product/123',brand,available:true}],origins:['popup','vip_alma','vip_desodorante'].map(key=>({key,brand,available:true}))},...dates()},
  readUniverse:{brand,base_list_id:base,complete:true,identity_confirmed:true,total_count:values.length,subjects:values.map((_,i)=>({subject_ref:'private-subject-'+i,identity_confirmed:true,base_member_confirmed:true,eligibility_confirmed:true})),...dates()}
 };
 state.readCatalog.catalog_hash=R.snapshotHash(state.readCatalog,'catalog_hash');state.readUniverse.universe_hash=R.snapshotHash(state.readUniverse,'universe_hash');
 const sources=[...new Set(leaves.map(x=>x.rule.op==='in_list'?'listmonk':A.FIELDS[x.rule.field].source))].map(source=>({source,source_hash:R.digest({source,brand}),coverage:'complete_subject',negative_evidence_supported:true,...dates()}));
 state.readEvidence={brand,revision:3,definition_hash:R.digest(definition),base_list_id:base,universe_hash:state.readUniverse.universe_hash,catalog_hash:state.readCatalog.catalog_hash,sources,evidence:[],...dates()};
 values.forEach((row,i)=>leaves.forEach(({key,rule},j)=>{if(row[j]===null||row[j]===undefined)return;const source=rule.op==='in_list'?'listmonk':A.FIELDS[rule.field].source;state.readEvidence.evidence.push({subject_ref:state.readUniverse.subjects[i].subject_ref,rule_key:key,brand,revision:3,definition_hash:R.digest(definition),universe_hash:state.readUniverse.universe_hash,catalog_hash:state.readCatalog.catalog_hash,source,source_hash:sources.find(x=>x.source===source).source_hash,value:row[j],complete:true,proof_kind:'complete_subject_snapshot',observed_at:time(-500),expires_at:time(230000)});}));
 function rehash(){
  state.readCatalog.catalog_hash=R.snapshotHash(state.readCatalog,'catalog_hash');state.readUniverse.universe_hash=R.snapshotHash(state.readUniverse,'universe_hash');
  Object.assign(state.readEvidence,{catalog_hash:state.readCatalog.catalog_hash,universe_hash:state.readUniverse.universe_hash});
  for(const fact of state.readEvidence.evidence)Object.assign(fact,{catalog_hash:state.readCatalog.catalog_hash,universe_hash:state.readUniverse.universe_hash});
  state.readEvidence.evidence_hash=R.snapshotHash(state.readEvidence,'evidence_hash');
 }
 rehash();const provider=Object.fromEntries(Object.keys(state).map(name=>[name,async args=>{calls.push({name,args});counts[name]=(counts[name]||0)+1;if(hooks[name])return await hooks[name](copy(state[name]),counts[name],args);return copy(state[name]);}]));
 const reviewer=R.createAudienceReviewer({provider,clock:()=>START+elapsed,timeoutMs}),request={brand,audience_id:AUDIENCE_ID,expected_revision:3,expected_definition_hash:R.digest(definition)};
 return {state,calls,counts,hooks,rehash,request,reviewer,review:options=>reviewer.review(request,{authorization,...options}),advance:n=>{elapsed=n;}};
}
test('explicit confirmed Shopify choice excludes individual unknowns while an unavailable whole source blocks review',async()=>{
 const rule={op:'confirmed',rule:purchase},f=fixture({rule,values:[[true],[false],[null]]}),r=await f.review();assert.equal(r.complete,true);assert.equal(r.counts.eligible_count,1);assert.equal(r.counts.excluded_count,2);
 for(const expired of [false,true]){const broken=fixture({rule,values:[[true],[null]]});if(expired)broken.state.readEvidence.sources[0].expires_at=time(0);else{broken.state.readEvidence.sources[0].coverage='unavailable';broken.state.readEvidence.sources[0].negative_evidence_supported=false;}broken.rehash();const value=await broken.review();assert.equal(value.complete,false);assert.equal(value.counts.eligible_count,null);assert.ok(value.blockers.includes('catalog_unavailable'));}
});
test('canonical hash is explicit, key order independent, array order sensitive and refuses accessors',()=>{
 assert.equal(R.digest({b:[2,1],a:1}),R.digest({a:1,b:[2,1]}));assert.notEqual(R.digest({b:[2,1]}),R.digest({b:[1,2]}));
 assert.equal(R.HASH_CONTRACT,'canonical-json-sorted-keys-sha256-v1');assert.equal(R.ENABLED,false);
 const x={};Object.defineProperty(x,'secret',{enumerable:true,get(){throw Error('must not execute');}});assert.throws(()=>R.digest(x),{code:'AUDIENCE_REVIEW_CORRUPT'});
 assert.throws(()=>R.digest([,1]));assert.throws(()=>R.digest({toJSON(){return 'unsafe';}}));
});
test('both brands: exact server revision produces aggregate only, source expiry bounds result, no send or selection',async()=>{
 for(const brand of ['fish','aristo']){
  const f=fixture({brand,values:[[true],[false]]}),r=await f.review();
  assert.deepEqual(r.counts,{observed_count:2,matched_count:1,excluded_count:1,unknown_count:0,eligible_count:1});assert.equal(r.complete,true);assert.equal(r.counts_are_partial,false);
  assert.equal(r.authorizes_send,false);assert.equal(r.authorizes_selection,false);assert.equal(f.reviewer.enabled,false);assert.equal(r.expires_at,time(230000));assert.equal(Object.isFrozen(r.counts),true);
  assert.deepEqual(f.counts,{authenticate:3,readDefinition:2,readCatalog:2,readUniverse:2,readEvidence:2});
  assert.doesNotMatch(JSON.stringify(r),/private-subject|synthetic-manager|Synthetic audience|rule_key|sources|Bearer|password/);
  const {review_hash,...result}=r;assert.equal(R.digest(result),review_hash);
  assert.ok(f.calls.every(x=>x.args.signal instanceof AbortSignal));assert.ok(f.calls.filter(x=>x.name!=='authenticate').every(x=>!Object.hasOwn(x.args,'authorization')));
 }
});
test('E/OU truth tables with unknown preserve union and intersection without flattening',async()=>{
 const states=[true,false,null],values=states.flatMap(a=>states.map(b=>[a,b]));
 for(const op of ['and','or']){
  const f=fixture({rule:{op,rules:[purchase,popup]},values}),r=await f.review();
  assert.deepEqual(r.counts,{observed_count:9,matched_count:op==='and'?1:5,excluded_count:op==='and'?5:1,unknown_count:3,eligible_count:null});assert.equal(r.complete,false);
 }
 const f=fixture({rule:{op:'and',rules:[clicked,{op:'or',rules:[purchase,popup]}]},values:[[true,true,null]]});
 // Map by field because canonical leaf order is not visual rule order.
 for(const fact of f.state.readEvidence.evidence)fact.value=JSON.parse(fact.rule_key).field==='email.clicked'||JSON.parse(fact.rule_key).field==='purchase.count';f.rehash();
 assert.equal((await f.review()).counts.matched_count,1);
});
test('missing facts, partial universe and unconfirmed identity do not become zero eligible',async()=>{
 const missing=await fixture().review();assert.equal(missing.counts.eligible_count,null);assert.equal(missing.counts.unknown_count,1);
 const partial=fixture({values:[[true]]});partial.state.readUniverse.complete=false;partial.state.readUniverse.total_count=100;partial.rehash();
 const p=await partial.review();assert.equal(p.counts.matched_count,1);assert.equal(p.counts.eligible_count,null);assert.equal(p.counts_are_partial,true);assert.deepEqual(p.blockers,['universe_incomplete']);
 const identity=fixture({values:[[true]]});identity.state.readUniverse.identity_confirmed=false;identity.state.readUniverse.subjects[0].identity_confirmed=false;identity.rehash();
 const i=await identity.review();assert.equal(i.counts.matched_count,0);assert.equal(i.counts.unknown_count,1);assert.equal(i.counts.eligible_count,null);assert.equal(i.complete,false);
 const emptyPartial=fixture({values:[]});emptyPartial.state.readUniverse.complete=false;emptyPartial.state.readUniverse.total_count=null;emptyPartial.rehash();assert.equal((await emptyPartial.review()).counts.eligible_count,null);
 assert.equal((await fixture({values:[]}).review()).counts.eligible_count,0);
});
test('unproven base membership and catalog OFF/unavailable invalidate counting, not saved definition',async()=>{
 for(const change of [f=>{f.state.readUniverse.subjects[0].eligibility_confirmed=false;},f=>{f.state.readUniverse.subjects[0].base_member_confirmed=false;},f=>{f.state.readCatalog.catalog.current=false;},f=>{f.state.readCatalog.catalog.fields.find(x=>x.key==='purchase.count').available=false;},f=>{f.state.readCatalog.catalog.lists[0].available=false;}]){
  const f=fixture({values:[[true]]});change(f);f.rehash();const r=await f.review();assert.equal(r.counts.unknown_count,1);assert.equal(r.counts.eligible_count,null);assert.equal(r.complete,false);
 }
});
test('negative predicates and false evaluations need explicit complete coverage; Shopify enumeration never supplies it',async()=>{
 const rules=[condition('purchase.count','eq',0),condition('purchase.product','not_purchased','gid://shopify/Product/123'),condition('signup.origin','is_not','popup'),condition('email.opened','not_within_last_days',30)];
 for(const rule of rules)for(const value of [true,false]){
  const complete=fixture({rule,values:[[value]]});assert.equal((await complete.review()).complete,true);
  for(const mutate of [f=>{f.state.readEvidence.sources[0].negative_evidence_supported=false;},f=>{f.state.readEvidence.evidence[0].proof_kind='observed_fact';},f=>{f.state.readEvidence.evidence[0].proof_kind='shopify_member_enumeration';},f=>{f.state.readEvidence.evidence[0].complete=false;}]){
   const f=fixture({rule,values:[[value]]});mutate(f);f.rehash();const r=await f.review();assert.equal(r.counts.unknown_count,1,JSON.stringify(rule));assert.equal(r.counts.eligible_count,null);
  }
 }
});
test('positive event evidence can match but cannot exclude or infer numeric totals',async()=>{
 for(const [rule,expected] of [[popup,true],[clicked,true],[condition('purchase.product','purchased','gid://shopify/Product/123'),true],[{op:'in_list',list_id:17},true],[purchase,false]]){
  const f=fixture({rule,values:[[true],[false]]});for(const s of f.state.readEvidence.sources){s.coverage='positive_only';s.negative_evidence_supported=false;}for(const e of f.state.readEvidence.evidence)e.proof_kind='observed_fact';f.rehash();
  const r=await f.review();assert.equal(r.counts.matched_count,Number(expected));assert.equal(r.counts.excluded_count,0);assert.equal(r.counts.unknown_count,expected?1:2);
 }
});
test('old, future, too-long or expired source/fact observations stay unknown',async()=>{
 for(const mutate of [e=>{e.evidence[0].expires_at=time(0);},e=>{e.evidence[0].observed_at=time(1);},e=>{e.evidence[0].observed_at=time(-301000);},e=>{e.sources[0].expires_at=time(0);},e=>{e.sources[0].checked_at=time(1);},e=>{e.sources[0].expires_at=time(400000);},e=>{e.evidence[0].expires_at=time(250000);}]){
  const f=fixture({values:[[true]]});mutate(f.state.readEvidence);f.rehash();const r=await f.review();assert.equal(r.counts.unknown_count,1);assert.equal(r.counts.eligible_count,null);
 }
});
test('stale catalog or snapshot metadata refuses review rather than extending validity',async()=>{
 for(const change of [x=>x.expires_at=time(0),x=>x.checked_at=time(1),x=>x.expires_at=time(300000),x=>x.checked_at='invalid']){
  const f=fixture();change(f.state.readCatalog);f.rehash();await assert.rejects(f.review(),{code:'AUDIENCE_REVIEW_READ_UNCONFIRMED'});
 }
 const f=fixture();f.hooks.authenticate=(x,n)=>{if(n===3)f.advance(240000);return x;};await assert.rejects(f.review(),{code:'AUDIENCE_REVIEW_TIMEOUT'});
});
test('revision, definition hash, brand/base and snapshot tampering are rejected',async()=>{
 for(const mutate of [f=>f.request.expected_revision=4,f=>f.request.expected_definition_hash='a'.repeat(64)]){const f=fixture();mutate(f);await assert.rejects(f.review(),{code:'AUDIENCE_REVIEW_VERSION'});}
 for(const mutate of [f=>f.state.readDefinition.brand='aristo',f=>f.state.readDefinition.definition.rule.value=5,f=>f.state.readCatalog.catalog.lists[0].brand='aristo',f=>f.state.readUniverse.base_list_id=16,f=>f.state.readUniverse.universe_hash='a'.repeat(64),f=>f.state.readEvidence.evidence[0].brand='aristo',f=>f.state.readEvidence.evidence[0].revision=2,f=>f.state.readEvidence.evidence[0].source_hash='a'.repeat(64)]){
  const f=fixture();mutate(f);if(f.state.readUniverse.universe_hash!=='a'.repeat(64))f.rehash();await assert.rejects(f.review(),{code:'AUDIENCE_REVIEW_CORRUPT'});
 }
});
test('source/evidence, catalog and universe changes between reads cannot return a result',async()=>{
 for(const [name,change,field] of [['readEvidence',x=>x.evidence[0].value=false,'evidence_hash'],['readCatalog',x=>x.catalog.currency='USD','catalog_hash'],['readUniverse',x=>{x.complete=false;x.total_count=100;},'universe_hash']]){
  const f=fixture();f.hooks[name]=(x,n)=>{if(n===2){change(x);x[field]=R.snapshotHash(x,field);}return x;};await assert.rejects(f.review(),e=>['AUDIENCE_REVIEW_DRIFT','AUDIENCE_REVIEW_CORRUPT'].includes(e.code));
 }
 const f=fixture();f.hooks.readDefinition=(x,n)=>{if(n===2)x.revision=4;return x;};await assert.rejects(f.review(),{code:'AUDIENCE_REVIEW_VERSION'});
});
test('revocation or principal/brand changes at either reauthentication stop review',async()=>{
 for(const nth of [1,2,3])for(const change of [x=>x.caps=[],x=>x.brands=['aristo'],x=>x.actor='panel:another']){
  const f=fixture();f.hooks.authenticate=(x,n)=>{if(n===nth)change(x);return x;};
  await assert.rejects(f.review(),{code:'AUDIENCE_REVIEW_ACCESS'});
 }
});
test('duplicates, extra facts, malformed payloads and caller capabilities are refused',async()=>{
 for(const mutate of [f=>f.state.readUniverse.subjects.push(copy(f.state.readUniverse.subjects[0])),f=>f.state.readEvidence.evidence.push(copy(f.state.readEvidence.evidence[0])),f=>f.state.readEvidence.sources.push(copy(f.state.readEvidence.sources[0])),f=>f.state.readEvidence.evidence[0].subject_ref='outsider',f=>f.state.readEvidence.evidence[0].rule_key=JSON.stringify(clicked)]){
  const f=fixture();mutate(f);f.rehash();await assert.rejects(f.review(),{code:'AUDIENCE_REVIEW_CORRUPT'});
 }
 const f=fixture();f.request.caps=['read_content'];await assert.rejects(f.review(),{code:'AUDIENCE_REVIEW_INPUT'});assert.equal(f.calls.length,0);
 const denied=fixture();await assert.rejects(denied.review({authorization:'not-a-bearer'}),{code:'AUDIENCE_REVIEW_ACCESS'});assert.equal(denied.calls.length,0);
});
test('timeout and external abort are bounded, signal providers, and never retry late reads',async()=>{
 for(const external of [false,true]){
  const f=fixture({timeoutMs:20}),controller=new AbortController();let captured,finish;
  f.hooks.readUniverse=(_x,_n,args)=>{captured=args.signal;return new Promise(resolve=>{finish=resolve;});};
  const pending=f.review({signal:controller.signal});if(external)setTimeout(()=>controller.abort(),5);
  await assert.rejects(pending,{code:external?'AUDIENCE_REVIEW_ABORTED':'AUDIENCE_REVIEW_TIMEOUT'});assert.equal(captured.aborted,true);assert.equal(f.counts.readUniverse,1);assert.equal(f.counts.readEvidence,undefined);
  finish(copy(f.state.readUniverse));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.counts.readEvidence,undefined);
 }
 const f=fixture(),controller=new AbortController();controller.abort();await assert.rejects(f.review({signal:controller.signal}),{code:'AUDIENCE_REVIEW_ABORTED'});assert.equal(f.calls.length,0);
});
test('provider exceptions are static sanitized failures with no subject/key/error leak',async()=>{
 const f=fixture();f.hooks.readEvidence=()=>{throw Object.assign(Error('private-subject password Bearer secret'),{code:'BAD_PRIVATE_CODE'});};
 await assert.rejects(f.review(),e=>{assert.equal(e.code,'AUDIENCE_REVIEW_READ_UNCONFIRMED');assert.equal(e.message,e.code);assert.equal(e.cause,undefined);return true;});assert.equal(f.counts.readEvidence,1);
});
