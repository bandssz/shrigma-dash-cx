'use strict';
const G=require('../../n8n/growth/journey-graph-contract.js');
const {createGraphRuntime}=require('../../n8n/growth/journey-graph-runtime.cjs');
const copy=x=>JSON.parse(JSON.stringify(x));
const T='2026-09-25T12:00:00.000Z';
const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
function fixture(pool,brand='fish'){
 let seq=1,now=T;
 const sourceRef=id(800),subject=id(900);
 const catalog={version:G.VERSION,brand,triggers:[{key:'cart.abandoned',brand,available:true,fields:['purchase.confirmed','first_name']}],fields:[{key:'purchase.confirmed',type:'boolean',available:true,max_age_seconds:120},{key:'first_name',type:'string',available:true,max_age_seconds:3600}],messages:[{key:'cart.email',brand,channel:'email',available:true,release:'synthetic-release-1',required_fields:['first_name']}]};
 const graph={version:G.VERSION,brand,name:'Synthetic cart',nodes:[{id:'start',type:'trigger',event:'cart.abandoned'},{id:'wait',type:'wait',seconds:60},{id:'condition',type:'condition',expression:{field:'purchase.confirmed',op:'eq',value:true},on_unknown:{max_wait_seconds:120,retry_seconds:30}},{id:'message',type:'message',binding:'cart.email'},{id:'paid',type:'exit',reason:'purchased'},{id:'end',type:'exit',reason:'finished'}],edges:[{from:'start',to:'wait',port:'next'},{from:'wait',to:'condition',port:'next'},{from:'condition',to:'paid',port:'yes'},{from:'condition',to:'message',port:'no'},{from:'message',to:'end',port:'next'}]};
 const proof={version:'journey_source_v1',source_ref:sourceRef,brand,trigger:'cart.abandoned',event_id:'synthetic-private-event',subject_id:subject,source_revision:'immutable-cart-revision-1',occurred_at:T,observed_at:T,complete:true,eligible:true,consent:true,suppressed:false,facts:{'purchase.confirmed':{value:false,observed_at:T,complete:true},first_name:{value:'Synthetic',observed_at:T,complete:true}}};
 let override=null;
 const settings={pool,catalogFor:async()=>copy(catalog),clock:()=>now,readSource:async()=>override?override():copy(proof)};
 const api=createGraphRuntime(settings);
 const request=fields=>({request_id:id(seq++),actor:'synthetic-operator',brand,...fields});
 const query=async(q,a)=>{const c=await pool.connect();try{return await c.query(q,a);}finally{c.release();}};
 return {api,settings,catalog,graph,proof,sourceRef,request,query,copy,
  now:()=>now,
  setTime(t){now=t;proof.observed_at=t;for(const v of Object.values(proof.facts))if(v)v.observed_at=t;},
  overrideSource(fn){override=fn;},
  async ready(){let j=await api.create(request({definition:graph}));j=await api.publish(request({journey_id:j.journey_id,expected_version:j.version,confirm:'publicar'}));await query('UPDATE crm_graph_candidate.control SET enabled=true');return api.pause(request({journey_id:j.journey_id,expected_version:j.version,paused:false,confirm:'retomar'}));},
  enroll(j){return api.enroll(request({journey_id:j.journey_id,expected_version:j.version,source_ref:sourceRef}));},
  step(e,runtime=api){return runtime.step(request({entry_id:e.entry_id,expected_version:e.version}));},
  async atCondition(j){let e=await this.enroll(j);e=await this.step(e);this.setTime('2026-09-25T12:01:00.000Z');return this.step(e);},
  async atMessage(j){return this.step(await this.atCondition(j));}
 };
}
// Fault injection occurs at the storage boundary; no source/transport is called.
function faultPool(pool,control){return {async connect(){const c=await pool.connect();return {async query(q,a){if(control.before&&control.before(q,a))throw Error('synthetic pre-commit failure');const r=await c.query(q,a);if(control.after&&control.after(q,a))throw Error('synthetic lost response');return r;},release(error){c.release(error);}};}};}
module.exports={fixture,faultPool,id,T};
