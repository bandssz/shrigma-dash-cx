'use strict';
const crypto=require('node:crypto'),v8=require('node:v8');
const CAPACITY=8*1024*1024,IDLE=0,PENDING=1,DONE=2;
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const safeState=e=>typeof e?.code==='string'&&/^[0-9A-Z]{5}$/.test(e.code)?e.code:null;
function closedError(code='DASHBOARD_PG_REFUSED',state=null){const e=new Error(code);e.name='DashboardPgError';e.code=code;e.status=503;if(state)e.sqlstate=state;return e;}
function registry(){const r=require('./statement-registry.json'),{registrySha256,...body}=r;if(sha(JSON.stringify(body))!==registrySha256||r.schema!=='dashboard-pg-adapter-exact-registry-v1')throw closedError('DASHBOARD_PG_REGISTRY_REFUSED');return r;}
function writeResponse(control,response,body){let bytes=v8.serialize(body);if(bytes.length>response.length)bytes=v8.serialize({ok:false,code:'DASHBOARD_PG_RESPONSE_LIMIT',sqlstate:null,poison:true,transaction:false});response.set(bytes);Atomics.store(control,1,bytes.length);Atomics.store(control,0,DONE);Atomics.notify(control,0);}
module.exports={CAPACITY,IDLE,PENDING,DONE,canonical,sha,safeState,closedError,registry,writeResponse};
