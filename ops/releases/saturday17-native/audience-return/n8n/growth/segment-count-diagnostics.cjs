'use strict';
// Technical count metadata only; message, SQL, parameters and cause never leave memory.
// PostgreSQL17 AppendixA; unknown/custom classes remain unclassified.
const CLASSES=new Set('00 01 02 03 08 09 0A 0B 0F 0L 0P 0Z 20 21 22 23 24 25 26 27 28 2B 2D 2F 34 38 39 3B 3D 3F 40 42 44 53 54 55 57 58 72 F0 HV P0 XX'.split(' '));
const TRANSPORT=new Set(['EPIPE','ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','ENOTFOUND','EAI_AGAIN']);
const sqlState=value=>typeof value==='string'&&/^[0-9A-Z]{5}$/.test(value)&&CLASSES.has(value.slice(0,2))?value:null;
const transportCode=value=>TRANSPORT.has(value)?value:null;
const CODE=new Set(['AUDIENCE_COUNT_ABORTED','AUDIENCE_COUNT_TIMEOUT','AUDIENCE_COUNT_UNCONFIRMED']);
const COMPILER=new Set(['unavailable','list-only','inline-email','external','shopify-aggregate']);
function line(event,brand,revision){
 if(!event||event.schema!=='crm-audience-count-diagnostic-v1'||event.phase!=='count'||!CODE.has(event.code)||!COMPILER.has(event.compiler)||!['fish','aristo'].includes(brand)||typeof revision!=='string'||!/^[a-f0-9]{40}$/.test(revision)||typeof event.timeout!=='boolean'||typeof event.aborted!=='boolean'||!Number.isSafeInteger(event.timeout_ms)||event.timeout_ms<10||event.timeout_ms>30000)return null;
 const sqlstate=sqlState(event.sqlstate);
 const elapsed_ms=Number.isSafeInteger(event.elapsed_ms)&&event.elapsed_ms>=0?event.elapsed_ms:null;
 return 'CRM_AUDIENCE_COUNT_DIAGNOSTIC '+JSON.stringify({schema:event.schema,phase:'count',revision,brand,compiler:event.compiler,code:event.code,sqlstate,transport_code:transportCode(event.transport_code),elapsed_ms,timeout_ms:event.timeout_ms,timeout:event.timeout,aborted:event.aborted});
}
function createCounter(count,{revision,write}={}){
 if(typeof count!=='function'||typeof write!=='function'||typeof revision!=='string'||!/^[a-f0-9]{40}$/.test(revision))throw Error('CRM_AUDIENCE_DIAGNOSTIC_CONFIG');
 return input=>count({...input,onDiagnostic:event=>{const value=line(event,input?.definition?.brand,revision);if(value!==null)return write(value+'\n');}});
}
module.exports={line,createCounter,sqlState,transportCode};
