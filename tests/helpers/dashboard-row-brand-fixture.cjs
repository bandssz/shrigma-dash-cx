'use strict';
// Partial row fixtures use the actual presentation helpers, never fake grants.
const vm=require('node:vm');
const {sessionBrandScope}=require('../../services/dashboard-operational/public/entry.js');
function rowBrandDependencies(context,source){
 const declarations=['PRODUCTS','AUDIENCE_BRANDS','brandNames'].map(name=>{
  const lines=source.split('\n').filter(line=>line.trimStart().startsWith('const '+name+'='));
  if(lines.length!==1)throw Error('Actual row presentation dependency changed: '+name);
  return lines[0];
 });
 context.sessionBrandScope=sessionBrandScope;
 vm.runInNewContext(declarations.join('\n')+'\nglobalThis.brandNames=brandNames;globalThis.PRODUCTS=PRODUCTS;',context);
}
module.exports={rowBrandDependencies};
