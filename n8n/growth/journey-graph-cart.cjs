/* First cart email bridge. Trusted server query only; no HTTP, UI or send. */
'use strict';
const VERSION='journey_graph_cart_v1',ENABLED=false;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),obj=x=>x&&typeof x==='object'&&!Array.isArray(x),exact=(x,keys)=>obj(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const fail=c=>{throw Object.assign(Error(c),{code:c});},brand=b=>b==='fish'||b==='aristo',uuid=x=>typeof x==='string'&&UUID.test(x),iso=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x));
const REASONS=new Set(['claimed','graph_owned','graph_proof_expired','in_flight','accepted','rejected','outcome_unknown','payload_conflict','legacy_existing_dispatch','flow_paused','subscriber_missing','eligibility_changed','cadence_or_cap_changed','legacy_already_accepted']);
function validateGraphGuard(g,dispatchID,templateID,subscriberID){
 if(!exact(g,['contract','cache_target','instance_id','template_id','subscriber_id','native_sha256','snapshot_sha256','dispatch_id','token','expires_at'])||g.contract!=='journey_graph_cache_guard_v1'||!uuid(g.instance_id)||!uuid(g.dispatch_id)||g.dispatch_id!==dispatchID||g.template_id!==templateID||!Number.isSafeInteger(g.subscriber_id)||g.subscriber_id<=0||subscriberID!==undefined&&g.subscriber_id!==subscriberID||typeof g.cache_target!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(g.cache_target)||![g.native_sha256,g.snapshot_sha256,g.token].every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x))||!iso(g.expires_at))fail('GRAPH_CACHE_GUARD_UNCONFIRMED');
 return g;
}
function validateClaim(row,expected={}){
 if(!exact(row,['should_send','dispatch_id','claim_token','payload','context','reason'])||typeof row.should_send!=='boolean'||!REASONS.has(row.reason)||row.dispatch_id!==null&&!uuid(row.dispatch_id))fail('GRAPH_CART_CLAIM_UNCONFIRMED');
 if(!row.should_send){if(row.claim_token!==null||row.payload!==null||row.context!==null||row.reason==='claimed')fail('GRAPH_CART_CLAIM_UNCONFIRMED');return row;}
 const c=row.context,p=row.payload;
 const payloadKeys=['template_id','subscriber_email','from_email','headers','data','content_type'];if(!expected.allow_unguarded)payloadKeys.push('graph_guard');
 if(!uuid(row.dispatch_id)||!uuid(row.claim_token)||row.reason!=='claimed'||!exact(c,['brand','toque','piece','chave','subscriber_id','email','ref','template_id','tx','graph_intent_id','graph_expires_at'])||!brand(c.brand)||c.toque!=='t05'||c.piece!=='carrinho-30min'||c.chave!=='cart_t05_at'||!Number.isSafeInteger(c.subscriber_id)||c.subscriber_id<=0||!Number.isSafeInteger(c.template_id)||c.template_id<=0||!uuid(c.graph_intent_id)||!iso(c.ref)||!iso(c.graph_expires_at)||!exact(c.tx,['template_id','subscriber_email','from_email','headers','data','content_type'])||c.tx.content_type!=='html'||!exact(p,payloadKeys))fail('GRAPH_CART_CLAIM_UNCONFIRMED');
 if(p.template_id!==c.template_id||c.tx.template_id!==c.template_id||p.subscriber_email!==c.email||c.tx.subscriber_email!==c.email||p.content_type!=='html'||p.subject!==undefined||p.altbody!==undefined||!obj(p.data)||!same(p.data,c.tx.data)||typeof c.email!=='string'||!(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).test(c.email))fail('GRAPH_CART_CLAIM_UNCONFIRMED');
 const address=c.brand==='fish'?'contato@fishermans.com.br':'contato@oaristocrata.com',from=(c.brand==='fish'?'Fishermans':'O Aristocrata')+' <'+address+'>';
 if(p.from_email!==from||c.tx.from_email!==from||!same(c.tx.headers,[{'Reply-To':address}])||!same(p.headers,[{'Reply-To':address},{'X-SES-CONFIGURATION-SET':c.brand==='fish'?'cs-fishermans-tx':'cs-aristocrata-tx'},{'X-SES-MESSAGE-TAGS':'crm_dispatch_id='+row.dispatch_id+', crm_test=false'}]))fail('GRAPH_CART_CLAIM_UNCONFIRMED');
 if(!expected.allow_unguarded)validateGraphGuard(p.graph_guard,row.dispatch_id,c.template_id,c.subscriber_id);
 if(expected.brand!==undefined&&expected.brand!==c.brand||expected.intent_id!==undefined&&expected.intent_id!==c.graph_intent_id||expected.subscriber_id!==undefined&&expected.subscriber_id!==c.subscriber_id||expected.ref!==undefined&&Date.parse(expected.ref)!==Date.parse(c.ref)||expected.clone_template_id!==undefined&&expected.clone_template_id!==c.template_id)fail('GRAPH_CART_CLAIM_UNCONFIRMED');
 return row;
}
function canonicalURL(raw,b){
 if(!brand(b)||typeof raw!=='string'||/[\s\\<>"'`{}]/.test(raw))fail('GRAPH_CART_URL');let u;try{u=new URL(raw);}catch{fail('GRAPH_CART_URL');}
 const host=b==='fish'?'fishermans.com.br':'oaristocrata.com';if(u.protocol!=='https:'||![host,'www.'+host].includes(u.hostname)||u.username||u.password||u.port||u.hash)fail('GRAPH_CART_URL');
 for(const key of [...u.searchParams.keys()])if(/^utm_/i.test(key))u.searchParams.delete(key);
 for(const [key,value]of Object.entries({source:'email',medium:'fluxo',campaign:b+'-carrinho',content:'carrinho-30min'}))u.searchParams.set('utm_'+key,value);return u.href;
}
function createCartBridge({query,cacheTarget}={}){
 if(typeof query!=='function'||typeof cacheTarget!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(cacheTarget))fail('GRAPH_CART_ADAPTER');
 const one=async(sql,args)=>{let r;try{r=await query(sql,args);}catch(e){fail(/^GRAPH_CART_[A-Z0-9_]+$/.test(e?.message||'')?e.message:'GRAPH_CART_OUTCOME_UNKNOWN');}if(r?.rows?.length!==1||!Object.hasOwn(r.rows[0],'result'))fail('GRAPH_CART_OUTCOME_UNKNOWN');return r.rows[0].result;};
 const input=(b,id)=>{if(!brand(b)||!uuid(id))fail('GRAPH_CART_INPUT');};
 return Object.freeze({
  async openEpoch(actor,{brand:b,journey_id,expected_version,...extra}){input(b,journey_id);if(Object.keys(extra).length||!Number.isSafeInteger(expected_version)||expected_version<1||typeof actor!=='string'||!/^panel:.{1,194}$/.test(actor))fail('GRAPH_CART_INPUT');return one('SELECT crm_graph_candidate.cart_epoch_open_v1($1,$2,$3,$4,$5) result',[actor,b,journey_id,expected_version,cacheTarget]);},
  closeEpoch(b,id){input(b,id);return one('SELECT crm_graph_candidate.cart_epoch_close_v1($1,$2) result',[b,id]);},
  enroll(b,id){input(b,id);return one('SELECT crm_graph_candidate.cart_enroll_v1($1,$2) result',[b,id]);},
  async claim({brand:b,intent_id,expected_entry_version,preflight,...extra}){input(b,intent_id);if(Object.keys(extra).length||!Number.isSafeInteger(expected_entry_version)||expected_entry_version<1||preflight?.brand!==b||preflight.intent_id!==intent_id||canonicalURL(preflight.source_checkout_url,b)!==preflight.message?.data?.checkout_url)fail('GRAPH_CART_PROOF_INVALID');const r=await one('SELECT crm_graph_candidate.cart_claim_v1($1,$2,$3,$4,$5) result',[b,intent_id,expected_entry_version,preflight,cacheTarget]);validateClaim(r,{brand:b,intent_id,subscriber_id:preflight.recipient.subscriber_id,ref:preflight.ref,clone_template_id:preflight.message.template_id,allow_unguarded:true});if(r.should_send){const guard=await one('SELECT crm_graph_candidate.cache_identity_issue_v1($1,$2,$3,$4) result',[b,intent_id,r.dispatch_id,cacheTarget]);r.payload={...r.payload,graph_guard:guard};}return validateClaim(r,{brand:b,intent_id,subscriber_id:preflight.recipient.subscriber_id,ref:preflight.ref,clone_template_id:preflight.message.template_id});},
  async dispatch(b,id){input(b,id);const r=await one('SELECT crm_graph_candidate.cart_dispatch_v1($1,$2) result',[b,id]);if(r===null)return null;if(!exact(r,['contract','brand','intent_id','entry_id','revision','node_id','attempt_key','dispatch_id','transport_state'])||r.contract!=='journey_graph_cart_dispatch_v1'||r.brand!==b||r.intent_id!==id||!uuid(r.entry_id)||!uuid(r.dispatch_id)||!Number.isSafeInteger(r.revision)||r.revision<1||!['in_flight','accepted','rejected','outcome_unknown'].includes(r.transport_state))fail('GRAPH_CART_DISPATCH_MISMATCH');return r;}
 });
}
module.exports={VERSION,ENABLED,REASONS,validateGraphGuard,validateClaim,canonicalURL,createCartBridge};
