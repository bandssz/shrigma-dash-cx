'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const G=require('../n8n/growth/journey-graph-contract.js');
const copy=x=>JSON.parse(JSON.stringify(x));
const T='2026-09-25T12:00:00.000Z',T60='2026-09-25T12:01:00.000Z';
function fixture(brand='fish'){
 const fields=[{key:'purchase.confirmed',type:'boolean',available:true,max_age_seconds:120},{key:'first_name',type:'string',available:true,max_age_seconds:3600},{key:'order.total',type:'number',available:true,max_age_seconds:120},{key:'tags',type:'string_set',available:true,max_age_seconds:120},{key:'last.purchase',type:'timestamp',available:true,max_age_seconds:120}];
 const catalog={version:G.VERSION,brand,triggers:[{key:'cart.abandoned',brand,available:true,fields:fields.map(f=>f.key)}],fields,messages:[{key:'cart.email',brand,channel:'email',available:true,release:'release-one',required_fields:['first_name']},{key:'cart.whatsapp',brand,channel:'whatsapp',available:true,release:'approved-wa-one',required_fields:['first_name']}]};
 const graph={version:G.VERSION,brand,name:'Carrinho sintético',nodes:[{id:'start',type:'trigger',event:'cart.abandoned'},{id:'wait',type:'wait',seconds:60},{id:'condition',type:'condition',expression:{field:'purchase.confirmed',op:'eq',value:true},on_unknown:{max_wait_seconds:120,retry_seconds:30}},{id:'message',type:'message',binding:'cart.email'},{id:'paid',type:'exit',reason:'purchased'},{id:'end',type:'exit',reason:'finished'}],edges:[{from:'start',to:'wait',port:'next'},{from:'wait',to:'condition',port:'next'},{from:'condition',to:'paid',port:'yes'},{from:'condition',to:'message',port:'no'},{from:'message',to:'end',port:'next'}]};
 const identity={entry_id:'10000000-0000-4000-8000-000000000001',journey_id:'20000000-0000-4000-8000-000000000001',revision:7,event_id:'shopify-cart:synthetic:revision-1',brand,trigger:'cart.abandoned'};
 const facts={'purchase.confirmed':{value:false,observed_at:T,complete:true},first_name:{value:'Pessoa fictícia',observed_at:T,complete:true},'order.total':{value:100,observed_at:T,complete:true},tags:{value:['vip'],observed_at:T,complete:true},'last.purchase':{value:'2026-09-01T00:00:00.000Z',observed_at:T,complete:true}};
 return {graph,catalog,identity,facts};
}
function step(f,state,now=T,extra={}){return G.nextTransition(f.graph,state,{catalog:f.catalog,identity:f.identity,now,facts:f.facts,...extra});}
function start(f){return G.createState(f.graph,{catalog:f.catalog,identity:f.identity,started_at:T});}
function atCondition(f){return step(f,step(f,start(f)).state,T60).state;}
function atMessage(f){return step(f,atCondition(f),T60).state;}
function rejected(f,code){const r=G.validateGraph(f.graph,{catalog:f.catalog});assert.equal(r.ok,false);assert.equal(r.errors[0].code,code);}

test('candidate is disabled, structural catalog immutable, both brands and channels validate',()=>{
 assert.equal(G.ENABLED,false);assert.equal(G.CATALOG.enabled,false);assert.equal(Object.isFrozen(G.CATALOG.operators.number),true);
 for(const brand of ['fish','aristo'])for(const channel of ['email','whatsapp']){const f=fixture(brand);f.graph.nodes.find(n=>n.type==='message').binding='cart.'+channel;assert.deepEqual(G.validateGraph(f.graph,{catalog:f.catalog}),{ok:true,version:G.VERSION,errors:[]});}
});
test('editable definition cannot carry server identities, activation, SQL, code or unsupported schema',()=>{
 for(const field of ['id','revision','published_version','enabled','sql','code']){const f=fixture();f.graph[field]='not-operator-owned';rejected(f,'GRAPH_SHAPE');}
 const f=fixture();f.graph.version='journey_graph_v2';rejected(f,'GRAPH_VERSION');f.graph.version=G.VERSION;f.graph.brand='olivas';rejected(f,'GRAPH_CATALOG');
});
test('each branch has one distinct destination; missing ports, parallel edges and missing nodes fail',()=>{
 let f=fixture();f.graph.edges=f.graph.edges.filter(e=>e.port!=='no');rejected(f,'GRAPH_PORTS');
 f=fixture();f.graph.edges.push({from:'condition',to:'end',port:'yes'});rejected(f,'GRAPH_PARALLEL');
 f=fixture();f.graph.edges.find(e=>e.port==='no').to='paid';rejected(f,'GRAPH_BRANCH');
 f=fixture();f.graph.edges[0].to='missing';rejected(f,'GRAPH_EDGE');
 f=fixture();f.graph.edges[0].port='true';rejected(f,'GRAPH_PORTS');
});
test('detects disconnected blocks and cycles, including disconnected cycles',()=>{
 let f=fixture();f.graph.nodes.push({id:'orphan',type:'exit',reason:'unused'});rejected(f,'GRAPH_ORPHAN');
 f=fixture();f.graph.edges.find(e=>e.from==='message').to='wait';rejected(f,'GRAPH_CYCLE');
 f=fixture();f.graph.nodes.push({id:'a',type:'wait',seconds:1},{id:'b',type:'wait',seconds:1});f.graph.edges.push({from:'a',to:'b',port:'next'},{from:'b',to:'a',port:'next'});rejected(f,'GRAPH_CYCLE');
 f=fixture();f.graph.nodes.push(copy(f.graph.nodes[0]));rejected(f,'GRAPH_DUPLICATE');
});
test('bounded graph, group depth and number of comparisons; all nodes must be supported',()=>{
 let f=fixture();f.graph.nodes.push(...Array.from({length:27},(_,i)=>({id:'extra'+i,type:'exit',reason:'unused'})));rejected(f,'GRAPH_SIZE');
 f=fixture();f.graph.nodes[1].type='javascript';rejected(f,'GRAPH_NODE_TYPE');
 f=fixture();let expression=f.graph.nodes[2].expression;for(let i=0;i<5;i++)expression={all:[expression]};f.graph.nodes[2].expression=expression;rejected(f,'GRAPH_CONDITION');
 f=fixture();f.graph.nodes[2].expression={all:[{all:Array.from({length:9},()=>({field:'order.total',op:'gt',value:1}))},{any:Array.from({length:8},()=>({field:'order.total',op:'lt',value:2}))}]};rejected(f,'GRAPH_CONDITION');
});
test('capabilities deny unavailable triggers, fields, cross-brand templates and unbound message variables',()=>{
 for(const mutate of [f=>f.catalog.triggers[0].available=false,f=>f.graph.nodes[0].event='unconnected']){const f=fixture();mutate(f);rejected(f,'GRAPH_TRIGGER_UNAVAILABLE');}
 let f=fixture();f.catalog.messages[0].brand='aristo';rejected(f,'GRAPH_CATALOG');
 f=fixture();f.catalog.messages[0].available=false;rejected(f,'GRAPH_MESSAGE_UNAVAILABLE');
 f=fixture();f.catalog.fields[0].available=false;rejected(f,'GRAPH_FIELD');
 f=fixture();f.catalog.triggers[0].fields=f.catalog.triggers[0].fields.filter(k=>k!=='first_name');rejected(f,'GRAPH_MESSAGE_FIELDS');
 f=fixture();f.catalog.triggers[0].fields=f.catalog.triggers[0].fields.filter(k=>k!=='purchase.confirmed');rejected(f,'GRAPH_FIELD');
});
test('comparisons have strict types, no truthy strings/coercion and no arbitrary operators',()=>{
 for(const expression of [{field:'purchase.confirmed',op:'eq',value:'false'},{field:'first_name',op:'gt',value:'x'},{field:'order.total',op:'gt',value:'99'},{field:'tags',op:'contains',value:['vip']},{field:'order.total',op:'eval',value:0}]){const f=fixture();f.graph.nodes[2].expression=expression;rejected(f,'GRAPH_CONDITION_TYPE');}
 const f=fixture();const evaluate=e=>G.evaluateCondition(e,{catalog:f.catalog,trigger:'cart.abandoned',facts:f.facts,now:T});
 for(const [op,value,want]of [['eq',100,true],['ne',100,false],['gt',99,true],['gte',100,true],['lt',100,false],['lte',100,true]])assert.equal(evaluate({field:'order.total',op,value}).value,want);
 assert.equal(evaluate({field:'tags',op:'contains',value:'vip'}).value,true);assert.equal(evaluate({field:'tags',op:'not_contains',value:'vip'}).value,false);
 assert.equal(evaluate({field:'last.purchase',op:'before',value:T}).value,true);assert.equal(evaluate({field:'last.purchase',op:'after',value:T}).value,false);
});
test('unknown is never coerced to false, including negation; all/any use three-valued logic',()=>{
 const f=fixture(),args={catalog:f.catalog,trigger:'cart.abandoned',facts:f.facts,now:T};delete f.facts['purchase.confirmed'];
 const unknown={field:'purchase.confirmed',op:'ne',value:true},yes={field:'order.total',op:'eq',value:100},no={field:'order.total',op:'eq',value:0};
 assert.equal(G.evaluateCondition(unknown,args).value,'unknown');
 for(const [expression,want]of [[{all:[yes,unknown]},'unknown'],[{any:[no,unknown]},'unknown'],[{all:[no,unknown]},false],[{any:[yes,unknown]},true]])assert.equal(G.evaluateCondition(expression,args).value,want);
});
test('incomplete, stale, future, malformed and wrongly typed facts remain unknown',()=>{
 const cases=[null,{value:false,complete:false,observed_at:T},{value:'false',complete:true,observed_at:T},{value:false,complete:true,observed_at:'2026-09-25T11:57:59.999Z'},{value:false,complete:true,observed_at:T60},{value:false,complete:true,observed_at:'2026-02-30T00:00:00.000Z'},{value:false,complete:true,observed_at:T,sql:'no'}];
 for(const fact of cases){const f=fixture();f.facts['purchase.confirmed']=fact;assert.equal(G.evaluateCondition(f.graph.nodes[2].expression,{catalog:f.catalog,trigger:'cart.abandoned',facts:f.facts,now:T}).value,'unknown');}
});
test('wait is relative to predecessor completion, survives serialization and is deterministic',()=>{
 const f=fixture(),initial=start(f);const waited=step(f,initial);assert.equal(waited.state.entered_at,T);assert.equal(waited.to,'wait');
 const w=step(f,waited.state,'2026-09-25T12:00:10.000Z');assert.equal(w.kind,'wait');assert.equal(w.due_at,T60);
 const repeated=step(f,copy(w.state),'2026-09-25T12:00:59.999Z');assert.equal(repeated.due_at,T60);assert.equal(repeated.state.entered_at,T);
 assert.equal(step(f,repeated.state,T60).to,'condition');assert.equal(step(f,copy(w.state),'2026-09-25T12:10:00.000Z').state.entered_at,'2026-09-25T12:10:00.000Z');
 assert.throws(()=>step(f,w.state,T),{code:'GRAPH_STATE'});
 for(const seconds of [0,-1,0.5,'60',2592001]){const v=fixture();v.graph.nodes[1].seconds=seconds;rejected(v,'GRAPH_RANGE');}
 assert.throws(()=>G.createState(f.graph,{catalog:f.catalog,identity:f.identity,started_at:'2026-09-25T09:00:00-03:00'}),{code:'GRAPH_TIME'});
});
test('unknown conditions persist a deadline without taking the No branch, then block',()=>{
 const f=fixture();delete f.facts['purchase.confirmed'];const state=atCondition(f);const r=step(f,state,T60);assert.equal(r.kind,'wait_data');assert.equal(r.deadline,'2026-09-25T12:03:00.000Z');assert.equal(r.state.node_id,'condition');assert.equal(r.recheck_at,'2026-09-25T12:01:30.000Z');
 const later=step(f,copy(r.state),'2026-09-25T12:02:59.000Z');assert.equal(later.deadline,r.deadline);assert.equal(later.recheck_at,r.deadline);
 const blocked=step(f,later.state,r.deadline);assert.equal(blocked.kind,'blocked');assert.equal(blocked.reason,'data_deadline_expired');assert.equal(step(f,blocked.state,r.deadline).kind,'terminal');
});
test('a recorded data wait expires absolutely, even if valid data arrives at/after deadline or during pause',()=>{
 for(const at of ['2026-09-25T12:03:00.000Z','2026-09-25T13:00:00.000Z']){
  const f=fixture();delete f.facts['purchase.confirmed'];const waiting=step(f,atCondition(f),T60);f.facts['purchase.confirmed']={value:true,complete:true,observed_at:at};
  const paused=step(f,waiting.state,at,{paused:true});assert.equal(paused.kind,'paused');const resumed=step(f,paused.state,at);assert.equal(resumed.kind,'blocked');assert.equal(resumed.reason,'data_deadline_expired');assert.equal(resumed.to,undefined);
 }
 const f=fixture();delete f.facts['purchase.confirmed'];const waiting=step(f,atCondition(f),T60);const justBefore='2026-09-25T12:02:59.999Z';f.facts['purchase.confirmed']={value:true,complete:true,observed_at:justBefore};assert.equal(step(f,waiting.state,justBefore).to,'paid');
});
test('recovered data follows only the actual branch, without restarting the data deadline',()=>{
 for(const value of [false,true]){const f=fixture();delete f.facts['purchase.confirmed'];const unknown=step(f,atCondition(f),T60);f.facts['purchase.confirmed']={value,complete:true,observed_at:T60};const r=step(f,unknown.state,T60);assert.equal(r.to,value?'paid':'message');assert.equal(r.decision.value,value);}
});
test('message intents are unique per participant/node, never authorize sending and require fresh values',()=>{
 for(const brand of ['fish','aristo']){const f=fixture(brand),s=atMessage(f),r=step(f,s,T60);assert.equal(r.kind,'message_intent');assert.equal(r.authorizes_send,false);assert.equal(r.intent.brand,brand);assert.equal(r.intent.release,'release-one');assert.equal(step(f,copy(r.state),T60).kind,'await_receipt');assert.equal(step(f,copy(r.state),T60).intent,undefined);}
 const f=fixture();delete f.facts.first_name;const r=step(f,atMessage(f),T60);assert.equal(r.kind,'blocked');assert.equal(r.reason,'message_data_unavailable');assert.equal(r.intent,undefined);
});
test('unknown transport stays fenced; only matching acceptance or rejection resolves the attempt',()=>{
 const f=fixture(),r=step(f,atMessage(f),T60),receipt={attempt_key:r.intent.attempt_key,status:'outcome_unknown'};
 const unknown=step(f,r.state,T60,{messageReceipt:receipt});assert.equal(unknown.kind,'unknown');assert.equal(step(f,copy(unknown.state),T60).intent,undefined);
 for(const wrong of [{...receipt,attempt_key:'other'},{...receipt,status:'delivered'},{...receipt,status:'accepted',retry:true}])assert.throws(()=>step(f,unknown.state,T60,{messageReceipt:wrong}));
 const accepted=step(f,unknown.state,T60,{messageReceipt:{...receipt,status:'accepted'}});assert.equal(accepted.to,'end');assert.equal(step(f,accepted.state,T60).kind,'exit');assert.throws(()=>step(f,accepted.state,T60,{messageReceipt:{...receipt,status:'accepted'}}),{code:'GRAPH_RECEIPT'});
 const rejected=step(f,unknown.state,T60,{messageReceipt:{...receipt,status:'rejected'}});assert.equal(rejected.state.status,'failed');assert.equal(step(f,rejected.state,T60).kind,'terminal');
});
test('pause emits no new intent but may reconcile acceptance already in flight',()=>{
 const f=fixture(),s=atMessage(f),paused=step(f,s,T60,{paused:true});assert.equal(paused.kind,'paused');assert.equal(paused.state.attempt_key,null);assert.equal(paused.intent,undefined);
 const r=step(f,s,T60);assert.equal(step(f,r.state,T60,{paused:true}).kind,'paused');assert.equal(step(f,r.state,T60,{paused:true,messageReceipt:{attempt_key:r.intent.attempt_key,status:'accepted'}}).to,'end');
});
test('server identity, pinned definition/catalog release and phase mismatches reject, never silently adopt',()=>{
 const f=fixture(),s=start(f);
 for(const identity of [{...f.identity,revision:8},{...f.identity,entry_id:'10000000-0000-4000-8000-000000000099'},{...f.identity,brand:'aristo'}])assert.throws(()=>step(f,s,T,{identity}));
 let changed=fixture();changed.graph.name='new revision';assert.throws(()=>step(changed,s),{code:'GRAPH_STATE'});
 changed=fixture();changed.catalog.messages[0].release='release-two';assert.throws(()=>step(changed,s),{code:'GRAPH_STATE'});
 for(const mutate of [x=>x.status='waiting_message',x=>x.attempt_key='invented',x=>x.node_id='missing',x=>x.definition_key='forged',x=>x.extra='unsupported']){const bad=copy(s);mutate(bad);assert.throws(()=>step(f,bad));}
 assert.throws(()=>G.createState(f.graph,{catalog:f.catalog,identity:{...f.identity,revision:0},started_at:T}));
});
test('simulation uses the exact transition engine for Yes, No and unknown, with zero side effects',()=>{
 for(const brand of ['fish','aristo'])for(const value of [true,false,'unknown']){
  const f=fixture(brand);if(value==='unknown')delete f.facts['purchase.confirmed'];else f.facts['purchase.confirmed'].value=value;
  const before=copy(f),sim=G.simulate(f.graph,{catalog:f.catalog,now:T,facts:f.facts});assert.deepEqual(f,before);assert.equal(sim.simulated,true);assert.equal(sim.sends,0);assert.equal(sim.persistence_writes,0);
  let state=G.createState(f.graph,{catalog:f.catalog,identity:sim.state.identity,started_at:T}),receipt=null;
  for(const expected of sim.trace){const actual=G.nextTransition(f.graph,state,{catalog:f.catalog,identity:sim.state.identity,now:expected.at,facts:f.facts,messageReceipt:receipt});assert.deepEqual({...actual,at:expected.at},expected);state=actual.state;receipt=actual.kind==='message_intent'?{attempt_key:actual.intent.attempt_key,status:'accepted'}:null;}
  assert.equal(sim.reason,value==='unknown'?'wait_data':'exit');assert.equal(sim.trace.filter(t=>t.kind==='message_intent').length,value===false?1:0);assert.deepEqual(f,before);
 }
});
test('simulation explicitly reports incomplete bounds and hypothetical unknown/rejected messages',()=>{
 const f=fixture();assert.equal(G.simulate(f.graph,{catalog:f.catalog,now:T,facts:f.facts,maxSteps:1}).reason,'step_limit');
 assert.equal(G.simulate(f.graph,{catalog:f.catalog,now:T,facts:f.facts,receipts:{message:'outcome_unknown'}}).reason,'unknown');
 assert.equal(G.simulate(f.graph,{catalog:f.catalog,now:T,facts:f.facts,receipts:{message:'rejected'}}).reason,'failed');
 assert.throws(()=>G.simulate(f.graph,{catalog:f.catalog,now:T,receipts:{start:'accepted'}}),{code:'GRAPH_RECEIPT'});
});
test('rejects non-JSON/accessors before execution and works without I/O in a browser sandbox',()=>{
 const f=fixture(),bad=copy(f.graph);let touched=false;Object.defineProperty(bad,'name',{enumerable:true,get(){touched=true;throw Error('must not execute');}});assert.equal(G.validateGraph(bad,{catalog:f.catalog}).ok,false);assert.equal(touched,false);
 const sparse=copy(f.graph);delete sparse.nodes[1];assert.equal(G.validateGraph(sparse,{catalog:f.catalog}).ok,false);const symbolic=copy(f.graph);symbolic[Symbol('hidden')]=1;assert.equal(G.validateGraph(symbolic,{catalog:f.catalog}).ok,false);
 const cyclic=copy(f.graph);cyclic.extra=cyclic;assert.equal(G.validateGraph(cyclic,{catalog:f.catalog}).ok,false);
 const context={console:{log(){throw Error('no logs')}},fetch(){throw Error('no network')},setTimeout(){throw Error('no timers')}};vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../n8n/growth/journey-graph-contract.js'),'utf8'),context);vm.runInContext('Date.now = () => { throw Error("no ambient clock"); };',context);
 context.fixture=JSON.stringify(f);const r=vm.runInContext(`(()=>{const f=JSON.parse(fixture);return JourneyGraphContract.simulate(f.graph,{catalog:f.catalog,now:${JSON.stringify(T)},facts:f.facts});})()`,context);assert.equal(r.reason,'exit');assert.equal(r.sends,0);
});
