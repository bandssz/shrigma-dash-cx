'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
test('financial refusal removes the previous ledger before a slower analytics read reaches its timeout',async()=>{
 const file=path.resolve(__dirname,'../services/dashboard-operational/public/crm-preview/journeys-observed.js'),timers=new Map();let nextTimer=0;
 const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[],replaceChildren(){this.innerHTML='';},classList:{add(){},remove(){}}});return elements.get(id);};
 const module={exports:{}},context=vm.createContext({module,require:createRequire(file),setTimeout:fn=>{const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),Date,Map,Set,Promise,Intl,URL,URLSearchParams});vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:file});
 const period={preset:'last30',ini:'2026-09-23',fim:'2026-10-22'},session={user:{id:'reader'}},state={brand:'aristo',channel:'email',view:'journeys',ticket:1,flows:[],lastConfirmedSession:session},analytics={sources:[{brand:'aristo'}],unavailable:[],ini:period.ini,fim:period.fim,flows:[]},facts={schema:'crm-journey-paid-tuples-v1',brand:'aristo',currency:'BRL',calendar:period,rows:[{tuple:['email',null,'fixture',null,null],orders:1,revenueCents:'100'}],checkedAt:'2026-10-22T15:00:00Z'};
 let second=false,finishAnalytics;const api=module.exports.create({state,el,esc:String,period:()=>period,sessionStamp:()=> 'same-reader-and-access',when:String,analytics:()=>second?new Promise(resolve=>{finishAnalytics=resolve;}):Promise.resolve(analytics),read:()=>second?Promise.reject(Object.assign(Error('SOURCE_REFUSED'),{status:403})):Promise.resolve(facts)});
 await api.load(session,1);a.match(el('journey-analytics').innerHTML,/data-journey-utm>/);
 second=true;const pending=api.load(session,1);await Promise.resolve();await Promise.resolve();a.equal(timers.size,1);for(const callback of [...timers.values()])callback();a.doesNotMatch(el('journey-analytics').innerHTML,/data-journey-utm>/);a.match(el('journey-analytics').innerHTML,/Última leitura/);
 finishAnalytics(analytics);await pending;a.doesNotMatch(el('journey-analytics').innerHTML,/data-journey-utm>/);
});
