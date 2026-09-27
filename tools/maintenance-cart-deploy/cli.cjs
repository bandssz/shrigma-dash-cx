#!/usr/bin/env node
'use strict';
const path=require('node:path'),fs=require('node:fs');
const {Installer,FileStore}=require('./deploy.cjs');
async function main(args){
 const [mode,adapterFile,stateDirectory,...rest]=args;
 if(!['prepare','install','create','open','patch','publish','activate','halt','verify','reconcile'].includes(mode)||!path.isAbsolute(adapterFile||'')||!path.isAbsolute(stateDirectory||''))throw Error('CART_DEPLOY_USAGE');
 const root=path.resolve(__dirname,'../..'),store=new FileStore(stateDirectory),factory=require(adapterFile),io=await factory({root,store}),i=new Installer({root,store,io});
 let result;
 if(mode==='prepare'){if(!path.isAbsolute(rest[0]||''))throw Error('CART_DEPLOY_REVIEWED_GUARD_PATH');result=await i.prepare(JSON.parse(fs.readFileSync(rest[0],'utf8')));}
 else if(mode==='verify')result=await i.verify();
 else if(mode==='reconcile')result=await i.reconcile(rest[0],{consumerId:rest[1]});
 else result=await i.phase(mode,rest[0],{activationApproval:rest[1]});
 process.stdout.write(JSON.stringify(result)+'\n');
}
if(require.main===module)main(process.argv.slice(2)).catch(e=>{const safe=/^(CART_DEPLOY_[A-Z_]+|HTTP_[0-9]{3}|RESPONSE_LIMIT|NETWORK_RESPONSE_LOST)$/.test(e.message)?e.message:'CART_DEPLOY_UNKNOWN_CHECK_PRIVATE_STATE';process.stderr.write(safe+'\n');process.exitCode=1;});
module.exports={main};
