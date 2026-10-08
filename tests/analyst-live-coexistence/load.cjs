'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..'),runtime=process.env.ANALYST_COEXISTENCE_RUNTIME||path.join(root,'services/dashboard-operational'),inputs=path.join(__dirname,'sealed-inputs/services/dashboard-operational'),source=process.env.ANALYST_COEXISTENCE_SOURCE||runtime,cache=new Map(),extra=new Map();
function load(name){
 if(cache.has(name))return cache.get(name).exports;
 const candidate=[path.join(runtime,name),path.join(inputs,name),path.join(source,name)].find(p=>fs.existsSync(p));if(!candidate)throw Error('Missing public dependency: '+name);
 if(candidate.startsWith(source+path.sep)){const b=fs.readFileSync(candidate);extra.set(candidate,{path:candidate,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')});}
 const m=new Module(candidate,module);cache.set(name,m);m.filename=candidate;m.paths=Module._nodeModulePaths(path.dirname(candidate));m.require=id=>id.startsWith('./')?load(id.slice(2)):require(id);m._compile(fs.readFileSync(candidate,'utf8'),candidate);return m.exports;
}
function original(name){const file=path.join(inputs,name),m=new Module(file,module);m.filename=file;m.require=id=>id.startsWith('./')?load(id.slice(2)):require(id);m._compile(fs.readFileSync(file,'utf8'),file);return m.exports;}
module.exports={load,original,root,extra,runtime,inputs};
