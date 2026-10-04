'use strict';
// Loaded only by the selected CI worker. No external or Unix-socket transport.
const net=require('node:net'),tls=require('node:tls'),dns=require('node:dns'),dgram=require('node:dgram');
const local=h=>h==='127.0.0.1'||h==='localhost';
function allowed(host,port,ports){return local(host)&&Number.isInteger(Number(port))&&(Number(port)===55440||ports.has(Number(port)));}
function options(args){if(Array.isArray(args[0]))args=args[0];const x=args[0];if(x&&typeof x==='object')return x;if(typeof x==='number'||typeof x==='string'&&/^[0-9]+$/.test(x))return {port:Number(x),host:typeof args[1]==='string'?args[1]:undefined};return {path:x};}
let installed=false;
function install(){
 if(installed)return;installed=true;const ports=new Set(),listeningPorts=new WeakMap(),refuse=()=>{throw Error('CLAUDE_NATIVE_EXTERNAL_NETWORK_REFUSED');};
 const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const o=options(args);if(o.path||!allowed(o.host,o.port,ports))refuse();return connect.apply(this,args);};
 const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){const o=options(args);if(o.path||!local(o.host)||!Number.isInteger(Number(o.port))||Number(o.port)<0||Number(o.port)>65535)refuse();this.once('listening',()=>{const a=this.address();if(a&&typeof a==='object'&&['127.0.0.1','::1'].includes(a.address)){ports.add(a.port);listeningPorts.set(this,a.port);}});this.once('close',()=>{const a=listeningPorts.get(this);if(a)ports.delete(a);listeningPorts.delete(this);});return listen.apply(this,args);};
 tls.connect=refuse;dgram.Socket.prototype.send=refuse;dgram.Socket.prototype.bind=refuse;
 const lookup=dns.lookup;dns.lookup=function(host,...args){if(!local(host))refuse();return lookup.call(this,host,...args);};
 for(const key of ['resolve','resolve4','resolve6','resolveAny','reverse'])if(typeof dns[key]==='function')dns[key]=refuse;
 if(dns.promises){const pLookup=dns.promises.lookup;dns.promises.lookup=async function(host,...args){if(!local(host))refuse();return pLookup.call(this,host,...args);};for(const key of ['resolve','resolve4','resolve6','resolveAny','reverse'])if(typeof dns.promises[key]==='function')dns.promises[key]=async()=>refuse();}
}
module.exports=Object.freeze({allowed,options,install});
if(process.env.CLAUDE_PG17_NETWORK_GUARD==='1')install();
