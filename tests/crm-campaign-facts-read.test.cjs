'use strict';
const test=require('node:test'),a=require('node:assert/strict'),path=require('node:path'),runtime=process.env.PAID_FACTS_RUNTIME||path.resolve(__dirname,'../services/dashboard-operational'),R=require(path.join(runtime,'crm-paid-facts.cjs'));
const scope={brand:'fish',id:12,uuid:'00000000-0000-4000-8000-000000000012',from:'2026-10-10T00:00:00.000Z',to:'2026-10-25T18:00:00.000Z',kind:'open'};
const observed={schema:'infra-behavior-native-counts-v2',kind:scope.kind,brand:scope.brand,campaignId:scope.id,campaignUuid:scope.uuid,from:scope.from,to:scope.to,validInput:true,campaignMatched:true,status:'observed',nativeUniqueSubscribers:0,nativeEventRows:0,nullSubscriberEventRows:0,nonpositiveSubscriberEventRows:0,unresolvedUniqueSubscribers:0};
test('native observed zero remains zero without inferring delivery',()=>{a.equal(R.engagementCount(observed,scope),0);a.equal(R.engagementCount({...observed,nativeUniqueSubscribers:3,nativeEventRows:8},scope),3);});
for(const change of [{brand:'aristo'},{campaignId:13},{campaignUuid:'00000000-0000-4000-8000-000000000013'},{from:'2026-10-11T00:00:00.000Z'},{to:'2026-10-25T18:00:01.000Z'},{kind:'click'},{validInput:false},{campaignMatched:false},{status:'campaign_scope_unconfirmed'},{nativeUniqueSubscribers:null},{nativeUniqueSubscribers:2,nativeEventRows:1},{nativeUniqueSubscribers:'0'},{nullSubscriberEventRows:1},{nonpositiveSubscriberEventRows:1},{unresolvedUniqueSubscribers:1}])test('ambiguous or mismatched native counts remain unknown '+JSON.stringify(change),()=>a.equal(R.engagementCount({...observed,...change},scope),null));
test('mixed-schema public store preserves definitions and exposes combined choices only to admitted QA',()=>{
 const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(':memory:'),store=require(path.join(runtime,'crm-paid-facts-store.cjs')).create(db);
 try{
  const legacy=store.save({brand:'fish',owner:'internal-qa',name:'Legacy',rule:{kind:'bought_recently',days:30}}),combined=store.save({brand:'fish',owner:'internal-qa',name:'[QA] Combined',rule:{schema:'combined-audience-v2',brand:'fish',rule:{op:'all',rules:[]}}});
  a.equal(db.prepare('SELECT COUNT(*) n FROM crm_restricted_publics_v1').get().n,2);
  const listed=store.list('fish');a.equal(listed.length,2);
  for(const expected of [legacy,combined]){const actual=listed.find(p=>p.id===expected.id);a(actual);a.equal(actual.name,expected.name);a.deepEqual(actual.rule,expected.rule);}
  a.equal(store.list('aristo').length,0);
  const service=R.create({store,auth:{authorizeBrand:(context,brand)=>{a.equal(brand,'fish');return context.user;}}}),ordinary={role:'editor',email:'ordinary@example.test'},qa={role:'editor',email:'editor-qa-fish@shrigma.com.br'};
  a.deepEqual(service.publics({user:ordinary},'fish',true).publics.map(p=>p.id),[legacy.id]);
  a.deepEqual(service.publics({user:qa},'fish',true).publics.map(p=>p.id).sort(),[legacy.id,combined.id].sort());
 }finally{db.close();}
});
