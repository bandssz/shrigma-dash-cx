'use strict';
// Brasília send-window policy. No transport, enrollment or activation.
const ZONE='America/Sao_Paulo',DAY={Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6,Sun:7};
const DEFAULT=Object.freeze({timeZone:ZONE,start:'09:00',end:'19:00',days:Object.freeze([1,2,3,4,5,6,7])});
const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:ZONE,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const fail=()=>{throw Object.assign(Error('JOURNEY_WINDOW_INVALID'),{code:'JOURNEY_WINDOW_INVALID',status:400});};
function normalize(input){
 if(!input||Object.getPrototypeOf(input)!==Object.prototype||Object.keys(input).sort().join(',')!=='days,end,start,timeZone'||input.timeZone!==ZONE||!Array.isArray(input.days)||input.days.length<1||input.days.length>7||input.days.some(d=>!Number.isInteger(d)||d<1||d>7)||new Set(input.days).size!==input.days.length)fail();
 const minute=s=>{if(typeof s!=='string'||!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(s))fail();return Number(s.slice(0,2))*60+Number(s.slice(3));};
 if(minute(input.start)>=minute(input.end))fail();
 return {timeZone:ZONE,start:input.start,end:input.end,days:[...input.days].sort((a,b)=>a-b)};
}
function allowed(policy,at){
 const parts=Object.fromEntries(formatter.formatToParts(at).map(p=>[p.type,p.value])),minute=Number(parts.hour)*60+Number(parts.minute),start=Number(policy.start.slice(0,2))*60+Number(policy.start.slice(3)),end=Number(policy.end.slice(0,2))*60+Number(policy.end.slice(3));
 return policy.days.includes(DAY[parts.weekday])&&minute>=start&&minute<end;
}
function evaluate(input,at){
 const policy=normalize(input);if(!Number.isSafeInteger(at)||at<0||at>8640000000000000-8*86400000)fail();
 if(allowed(policy,at))return {allowed:true,nextAt:null,timeZone:ZONE};
 let t=Math.floor(at/60000)*60000+60000;
 for(let n=0;n<=8*1440;n++,t+=60000)if(allowed(policy,t))return {allowed:false,nextAt:t,timeZone:ZONE};
 fail();
}
module.exports={normalize,evaluate,ZONE,DEFAULT};
