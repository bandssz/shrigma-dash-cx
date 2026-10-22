'use strict';
const Module=require('node:module'),load=Module._load,deny=()=>{throw Error('PROVIDER_TEST_EXTERNAL_EFFECT_REFUSED');};
Module._load=function(name,...rest){if(name==='pg'||name.startsWith('pg/'))deny();return load.call(this,name,...rest);};
for(const name of ['node:http','node:https']){const m=require(name);m.request=deny;m.get=deny;m.createServer=deny;}
const net=require('node:net');net.connect=deny;net.createConnection=deny;net.createServer=deny;net.Socket.prototype.connect=deny;
require('node:dgram').createSocket=deny;for(const k of ['lookup','resolve','resolve4','resolve6'])require('node:dns')[k]=deny;
const cp=require('node:child_process'),original=cp.spawnSync;
for(const k of ['exec','execSync','execFile','execFileSync','spawn','fork'])cp[k]=deny;
cp.spawnSync=function(file,args,options){const path=require('node:path'),parent=path.dirname(args?.[4]||'');if(file!==process.execPath||!Array.isArray(args)||args.length!==8||args[0]!=='--require'||args[1]!==__filename||args[2]!==path.join(__dirname,'driver.cjs')||args[3]!=='--opt-in'||!path.isAbsolute(parent)||!path.basename(parent).startsWith('read-provider-unit-')||args[4]!==path.join(parent,'startup.json')||args[6]!==path.join(parent,'provider.cjs')||!/^[a-f0-9]{64}$/.test(args[5])||!/^[a-f0-9]{64}$/.test(args[7]))deny();return original.call(this,file,args,options);};
