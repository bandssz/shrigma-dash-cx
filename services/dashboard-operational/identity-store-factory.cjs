'use strict';
// Future runtime candidate only. Production does not import this module.
// Dialect selection belongs to trusted startup, never a request or browser.
const DIALECTS=Object.freeze(['sqlite-v1','postgres-pg17-v1']);
const stores=new WeakMap();
function refused(code='DASHBOARD_IDENTITY_FACTORY_INPUT_REFUSED'){
 const error=new Error(code);error.name='DashboardIdentityFactoryError';error.code=code;error.status=503;return error;
}
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
function openIdentityStore(input){
 if(!plain(input))throw refused();
 const dialect=input.dialect??'sqlite-v1';
 if(!DIALECTS.includes(dialect))throw refused();
 let database;
 if(dialect==='sqlite-v1'){
  if(Object.keys(input).some(key=>!['dialect','dbPath'].includes(key))||typeof input.dbPath!=='string'||!input.dbPath||input.dbPath.includes('\0'))throw refused();
  try{const {DatabaseSync}=require('node:sqlite');database=new DatabaseSync(input.dbPath);}catch{throw refused('DASHBOARD_IDENTITY_FACTORY_OPEN_REFUSED');}
 }else{
  if(Object.keys(input).sort().join(',')!=='dialect,pgOptions'||!plain(input.pgOptions)||Object.keys(input.pgOptions).some(key=>!['connection','admission','requestTimeoutMs'].includes(key))||!plain(input.pgOptions.connection)||!plain(input.pgOptions.admission))throw refused();
  // The original worker performs target, role, driver, signed import-receipt
  // and registry admission. Failure propagates; SQLite is never opened here.
  try{database=require('./identity-pg/database-sync.cjs').createDatabaseSyncPg(input.pgOptions);}catch(error){
   if(error?.name==='DashboardPgError'&&/^DASHBOARD_PG_[A-Z_]+$/.test(error.code))throw error;
   throw refused('DASHBOARD_IDENTITY_FACTORY_OPEN_REFUSED');
  }
 }
 const state={dialect,database,dbPath:dialect==='sqlite-v1'?input.dbPath:undefined,closed:false,claimed:false,closeCount:0};
 const close=()=>{if(state.closed)return;state.closed=true;state.closeCount++;database.close();};
 try{
  if(!database||typeof database.then==='function'||typeof database.prepare!=='function'||typeof database.exec!=='function'||typeof database.close!=='function'||typeof database.isTransaction!=='boolean')throw refused('DASHBOARD_IDENTITY_FACTORY_SYNC_REQUIRED');
  const store=Object.freeze({dialect,database,sqliteFilePermissionsRequired:dialect==='sqlite-v1',close,get isClosed(){return state.closed;},get closeCount(){return state.closeCount;}});
  stores.set(store,state);return store;
 }catch(error){try{close();}catch{}throw error;}
}
function describeIdentityStore(store){
 const state=stores.get(store);if(!state||state.closed||state.claimed)throw refused('DASHBOARD_IDENTITY_FACTORY_LEASE_REFUSED');
 return Object.freeze({dialect:state.dialect,sqliteFilePermissionsRequired:state.dialect==='sqlite-v1'});
}
function claimIdentityStore(store,expectedDbPath){
 describeIdentityStore(store);const state=stores.get(store);
 if(state.dbPath!==expectedDbPath)throw refused('DASHBOARD_IDENTITY_FACTORY_PATH_REFUSED');
 state.claimed=true;return store;
}
function initializeWithStore(input,initialize){
 if(typeof initialize!=='function')throw refused();
 const store=openIdentityStore(input);
 try{
  const result=initialize(store);
  if(!result||typeof result!=='object'||typeof result.then==='function'){
   if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});
   throw refused('DASHBOARD_IDENTITY_FACTORY_SYNC_REQUIRED');
  }
  return result;
 }catch{
  try{store.close();}catch{}
  throw refused('DASHBOARD_IDENTITY_FACTORY_INITIALIZATION_REFUSED');
 }
}
module.exports=Object.freeze({DIALECTS,openIdentityStore,describeIdentityStore,claimIdentityStore,initializeWithStore});
