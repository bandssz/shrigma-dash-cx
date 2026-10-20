'use strict';
// Native API16 only. Paths/methods are derived here; never supplied by a user.
// No retries. A lost response is reconciled by the original durable operation.
const a=require('node:assert/strict');
const id=x=>Number.isSafeInteger(x)&&x>0;
function createNativeInternal({request}){
 if(typeof request!=='function')throw Error('NATIVE_INTERNAL_CONFIGURATION');
 function plan(p){a.equal(p?.contract,'crm-native-internal-plan-v1');a(id(p.campaign_id)&&id(p.list_id));a.match(p.campaign_uuid,/^[a-f0-9-]{36}$/i);a(Number.isFinite(Date.parse(p.send_at)));return p;}
 async function read(p,status,sendAt){const r=await request({method:'GET',path:'/api/campaigns/'+p.campaign_id,responseType:'json'});a.equal(r.status,200);const c=r.body?.data;a.equal(c?.id,p.campaign_id);a.equal(c.uuid,p.campaign_uuid);a.equal(c.status,status);a.equal(c.sent,0);a.equal(c.started_at??null,null);a(Array.isArray(c.lists)&&c.lists.length===1&&c.lists[0].id===p.list_id);a.equal(c.send_at===null?null:Date.parse(c.send_at),sendAt===null?null:Date.parse(sendAt));return c;}
 async function status(p,value){const r=await request({method:'PUT',path:'/api/campaigns/'+p.campaign_id+'/status',json:{status:value},responseType:'json'});a.equal(r.status,200);a.equal(r.body?.data?.id,p.campaign_id);a.equal(r.body.data.uuid,p.campaign_uuid);a.equal(r.body.data.status,value);}
 return Object.freeze({
  async scheduleInternal(input){const p=plan(input);a.equal(p.stage,'schedule');await status(p,'scheduled');await read(p,'scheduled',p.send_at);return true;},
  async cancelInternal(input){const p=plan(input);a.equal(p.stage,'to_draft');await status(p,'draft');const current=await read(p,'draft',p.send_at);a(current.attribs&&Object.getPrototypeOf(current.attribs)===Object.prototype);const r=await request({method:'PUT',path:'/api/campaigns/'+p.campaign_id,json:{send_at:null,lists:[p.list_id],attribs:current.attribs},responseType:'json'});a.equal(r.status,200);a.equal(r.body?.data?.id,p.campaign_id);await read(p,'draft',null);return true;}
 });
}
module.exports={createNativeInternal};
