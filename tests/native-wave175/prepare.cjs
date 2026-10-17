'use strict';
const fs=require('node:fs'),path=require('node:path');
function prepare(expected){
 if(!expected||Object.getPrototypeOf(expected)!==Object.prototype||Object.keys(expected).sort().join()!==['campaigns','campaignLists','list156','template175','campaignMedia','media','bindings','controls','alias','selection175','maternalOptouts','triggers','constraints','relations'].sort().join())throw Error('WAVE175_EXPECTED_REQUIRED');
 const json=JSON.stringify(expected);if(json.length>1048576||json.includes('privateValueSha256'))throw Error('WAVE175_FULL_PRIVATE_EXPECTED_REQUIRED');
 // SQL quoted JSON is data only. Never execute or persist it here.
 const literal="'"+json.replace(/'/g,"''")+"'::jsonb";
 const body=fs.readFileSync(path.join(__dirname,'kernel.sql'),'utf8').replace('__EXPECTED_JSON__',literal);
 let tag='$wave175$';while(body.includes(tag))tag=tag.slice(0,-1)+'x$';
 return "BEGIN;SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='500ms';SET LOCAL TimeZone='Etc/UTC';DO "+tag+'\n'+body+tag+";COMMIT;\n";
}
module.exports=Object.freeze({prepare});
