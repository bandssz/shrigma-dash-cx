'use strict';
// Author tests only: no socket/HTTP/PG transport may run in local verification.
const deny=()=>{throw Error('WRITER_PRODUCTION_TEST_NETWORK_REFUSED');};
for(const name of ['node:net','node:tls','node:http','node:https','node:dgram']){
 const m=require(name);for(const key of ['connect','createConnection','createServer','request','get','createSocket'])if(typeof m[key]==='function')m[key]=deny;
 if(m.Socket?.prototype)m.Socket.prototype.connect=deny;
}
globalThis.fetch=deny;
