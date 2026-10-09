'use strict';
const fs=require('node:fs'),path=require('node:path'),{inputRoot}=require('./fixture.cjs');
const runtime=process.env.DELIVERY_HEALTH_RUNTIME||path.resolve(__dirname,'../../services/dashboard-operational');
// Full Root image uses its actual proxy. Standalone package extracts only the
// byte-preserved sealed readJson function, with the original ProxyError class.
const source=fs.readFileSync(path.join(inputRoot,'inputs/services/dashboard-operational/proxy.cjs'),'utf8');
const reader=source.slice(source.indexOf('async function readJson('),source.indexOf('async function readResponse('));
const classAt=source.indexOf('class ProxyError');const classEnd=source.indexOf('\n}',classAt)+2;
// Local reader success paths need no error class; bind the exact original class
// for limit/JSON failures rather than replacing parser behavior.
const originalReader=new Function('MAX_REQUEST',source.slice(classAt,classEnd)+'\n'+reader+';return readJson')(4096);
const mod={exports:{}};
new Function('require','module','exports',fs.readFileSync(path.join(runtime,'native-delivery-health-operator.cjs'),'utf8'))(name=>{if(name==='./proxy.cjs'){const actual=path.join(runtime,'proxy.cjs');return fs.existsSync(actual)?require(actual):{readJson:originalReader};}return require(name);},mod,mod.exports);
module.exports=mod.exports;
