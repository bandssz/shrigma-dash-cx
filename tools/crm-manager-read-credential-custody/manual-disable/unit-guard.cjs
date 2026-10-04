'use strict';
const Module=require('node:module'),load=Module._load,deny=()=>{throw Error('MANUAL_DISABLE_TEST_EXTERNAL_EFFECT_REFUSED');};
Module._load=function(name,...rest){if(name==='pg'||name.startsWith('pg/'))deny();return load.call(this,name,...rest);};
for(const name of ['node:http','node:https']){const m=require(name);m.request=deny;m.get=deny;m.createServer=deny;}
const net=require('node:net');net.connect=deny;net.createConnection=deny;net.createServer=deny;net.Socket.prototype.connect=deny;
require('node:dgram').createSocket=deny;for(const k of ['lookup','resolve','resolve4','resolve6'])require('node:dns')[k]=deny;
for(const k of ['exec','execSync','execFile','execFileSync','spawn','spawnSync','fork'])require('node:child_process')[k]=deny;
