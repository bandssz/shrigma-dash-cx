'use strict';
const test=require('node:test'),a=require('node:assert/strict'),p=require('node:path'),runtime=process.env.DASHBOARD_ACCESS_TEST_RUNTIME||p.resolve(__dirname,'../services/dashboard-operational'),P=require(runtime+'/proxy.cjs'),{readTimingHeaders}=require(runtime+'/server.cjs');
const timing='poolQuery;dur=10.25, serialize;dur=2.50, gzip;dur=0.00, sourceBytes;desc="123"',headers=(value=timing,marker='source-v1')=>new Headers({'Server-Timing':value,'X-Shrigma-Read-Timing':marker});
test('complete source timing group retains duration and raw UTF8 bytes',()=>a.deepEqual(P.sourceReadTiming(headers(),123),{source_poolQuery:10.25,source_serialize:2.5,source_gzip:0,source_bytes:123}));
for(const [name,value,bytes,marker]of [['missing',timing.split(',').slice(1).join(','),123],['duplicate',timing.replace('serialize','poolQuery'),123],['overflow',timing.replace('10.25','120001'),123],['negative',timing.replace('10.25','-1'),123],['unknown',timing.replace('gzip','sql'),123],['wrong-bytes',timing,124],['marker',timing,123,'untrusted']])test('malformed optional timing is omitted: '+name,()=>a.equal(P.sourceReadTiming(headers(value,marker),bytes),undefined));
test('normal editors never receive new metrics; QA emission keeps existing metrics and body',()=>{
 const body={actual:'unchanged'},result={status:200,body,readTiming:{sourceHeaders:12,...P.sourceReadTiming(headers(),123)}},values=new Map(),res={setHeader:(k,v)=>values.set(k,v)};
 readTimingHeaders(res,result);a.equal(values.get('Server-Timing'),'sourceHeaders;dur=12.00');a.equal(result.body,body);
 readTimingHeaders(res,result,{restricted:true});a.match(values.get('Server-Timing'),/source_poolQuery;dur=10.25/);a.match(values.get('Server-Timing'),/source_bytes;desc="123"/);a.doesNotMatch(values.get('Server-Timing'),/source_bytes;dur/);a.equal(result.body,body);
 values.clear();readTimingHeaders(res,{...result,status:503},{restricted:true});a.equal(values.size,0);
});
