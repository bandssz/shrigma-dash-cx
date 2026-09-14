'use strict';
function engagementOutcome(r) {
 const code=Number(r?.statusCode||0);let body=r?.body;
 if(typeof body==='string'){try{body=JSON.parse(body);}catch{body=null;}}
 return code>=200&&code<300&&body?.data===true?'accepted':[400,401,403,404,422].includes(code)?'rejected':'outcome_unknown';
}
if(typeof module!=='undefined')module.exports=engagementOutcome;
