/* A/B email v2 protocol and conservative fixed-window result. No I/O or recipients. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GABExperiment=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const CONTRACT='crm-ab-email-v2',RULE='fisher-two-sided-fixed-window-v1';
 const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
 const exact=(x,keys)=>object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
 const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
 const integer=(x,min,max)=>Number.isSafeInteger(x)&&x>=min&&x<=max;
 const text=(x,max)=>typeof x==='string'&&x===x.trim()&&x.length>0&&x.length<=max;
 const clone=x=>JSON.parse(JSON.stringify(x));
 const stable=x=>Array.isArray(x)?x.map(stable):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
 // Hypergeometric weights relative to the mode avoid factorial overflow.
 // Two-sided Fisher sums all tables no more likely than the observed table.
 function fisher(nA,xA,nB,xB){
  if(!integer(nA,1,100000)||!integer(nB,1,100000)||!integer(xA,0,nA)||!integer(xB,0,nB))throw Error('AB_V2_COUNTS');
  const successes=xA+xB,total=nA+nB,lo=Math.max(0,successes-nB),hi=Math.min(successes,nA),mode=Math.max(lo,Math.min(hi,Math.floor((successes+1)*(nA+1)/(total+2))));
  const left=k=>k*(nB-successes+k)/((nA-k+1)*(successes-k+1));
  const right=k=>(nA-k)*(successes-k)/((k+1)*(nB-successes+k+1));
  let observed=1;
  if(xA<mode)for(let k=mode;k>xA;k--)observed*=left(k);
  else for(let k=mode;k<xA;k++)observed*=right(k);
  let mass=1,tail=observed>=1-1e-12?1:0;
  for(const [direction,limit,ratio] of [[-1,lo,left],[1,hi,right]]){
   let weight=1;
   for(let k=mode;k!==limit;k+=direction){weight*=ratio(k);mass+=weight;if(weight<=observed*(1+1e-12))tail+=weight;}
  }
  return Math.max(Number.MIN_VALUE,Math.min(1,tail/mass));
 }
 function protocol(p){
  if(!exact(p,['contract','test_id','brand','channel','name','hypothesis','arms','allocation','rule'])||p.contract!==CONTRACT||!uuid(p.test_id)||!['fish','aristo'].includes(p.brand)||p.channel!=='email'||!text(p.name,120)||!text(p.hypothesis,2000))throw Error('AB_V2_PROTOCOL');
  if(!Array.isArray(p.arms)||p.arms.length!==2||p.arms.some((a,i)=>!exact(a,['arm','campaign_id','expected_version'])||a.arm!==['a','b'][i]||!integer(a.campaign_id,1,2147483647)||!text(a.expected_version,128))||p.arms[0].campaign_id===p.arms[1].campaign_id)throw Error('AB_V2_ARMS');
  // No remainder/winner rollout: every eligible person belongs to exactly one arm.
  if(!exact(p.allocation,['method','a_basis_points'])||p.allocation.method!=='random-permutation-v1'||p.allocation.a_basis_points!==5000)throw Error('AB_V2_ALLOCATION');
  const r=p.rule;
  if(!exact(r,['method','metric','window_hours','minimum_per_arm','minimum_effect_pp','alpha'])||r.method!==RULE||r.metric!=='unique_tracked_click_per_allocated'||!integer(r.window_hours,24,168)||!integer(r.minimum_per_arm,1,50000)||typeof r.minimum_effect_pp!=='number'||!Number.isFinite(r.minimum_effect_pp)||r.minimum_effect_pp<0||r.minimum_effect_pp>100||r.alpha!==0.05)throw Error('AB_V2_RULE');
  return clone(p);
 }
 function result(p,source){
  const cfg=protocol(p),rule=cfg.rule,empty={contract:CONTRACT,test_id:cfg.test_id,metric:rule.metric,rule:clone(rule),winner:null,can_declare_winner:false,automatic_send:false};
  const unknown=reason=>({...empty,status:'unknown',reason,arms:null,difference_pp:null});
  if(!object(source)||source.contract!==CONTRACT||source.test_id!==cfg.test_id||JSON.stringify(stable(source.protocol))!==JSON.stringify(stable(cfg)))return unknown('source_identity');
  const required=['allocation_complete','assignment_disjoint','transport_bound','tracking_continuous','source_complete'];
  if(!object(source.integrity)||required.some(k=>source.integrity[k]!==true))return unknown('incomplete_evidence');
  if(!Array.isArray(source.arms)||source.arms.length!==2)return unknown('arm_counts');
  const arms=[];
  for(let i=0;i<2;i++){
   const a=source.arms[i];
   if(!object(a)||a.arm!==['a','b'][i]||a.campaign_id!==cfg.arms[i].campaign_id||!integer(a.allocated,1,100000)||!integer(a.unique_clickers,0,a.allocated)||!integer(a.native_sent,0,a.allocated)||!integer(a.revoked,0,a.allocated)||!integer(a.unknown,0,a.allocated))return unknown('arm_counts');
   if(a.unknown>0)return unknown('unknown_outcomes');
   if(a.unique_clickers>a.native_sent)return unknown('transport_counts');
   const rate=a.unique_clickers/a.allocated;
   arms.push({...clone(a),rate,rate_pp:100*rate});
  }
  if(Math.abs(arms[0].allocated-arms[1].allocated)>1||arms[0].allocated+arms[1].allocated>100000)return unknown('allocation_counts');
  // Denominator remains the initial allocation, including later opt-outs/non-delivery.
  const out={...empty,arms,difference_pp:(arms[1].rate-arms[0].rate)*100};
  const date=x=>typeof x==='string'&&/Z$/.test(x)&&Number.isFinite(Date.parse(x));
  if(!date(source.window_start)||!date(source.window_end)||!date(source.as_of)||Date.parse(source.window_end)-Date.parse(source.window_start)!==rule.window_hours*3600000)return unknown('window');
  if(Date.parse(source.as_of)<Date.parse(source.window_end))return {...out,status:'collecting',reason:'window_open'};
  if(source.arms.some(a=>a.finished_before_deadline!==true))return {...out,status:'inconclusive',reason:'transport_incomplete'};
  if(arms.some(a=>a.allocated<rule.minimum_per_arm))return {...out,status:'inconclusive',reason:'minimum_not_reached'};
  const pValue=fisher(arms[0].allocated,arms[0].unique_clickers,arms[1].allocated,arms[1].unique_clickers);
  const winner=pValue<rule.alpha&&Math.abs(out.difference_pp)>=rule.minimum_effect_pp&&out.difference_pp!==0?(out.difference_pp>0?'b':'a'):null;
  return {...out,p_value:pValue,status:winner?'conclusive':'inconclusive',reason:winner?'fixed_rule_met':'insufficient_separation',winner,can_declare_winner:!!winner};
 }
 return {CONTRACT,RULE,protocol,result,fisher};
});
