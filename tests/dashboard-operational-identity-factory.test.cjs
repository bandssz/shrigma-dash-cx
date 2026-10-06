'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const F=require('../services/dashboard-operational/identity-store-factory.cjs');
test('default SQLite uses one real synchronous store, transaction rollback and one owner close',()=>{
 const store=F.openIdentityStore({dbPath:':memory:'});
 try{
  assert.equal(store.dialect,'sqlite-v1');assert.equal(store.sqliteFilePermissionsRequired,true);
  store.database.exec('CREATE TABLE synthetic(id INTEGER PRIMARY KEY,value TEXT)');
  store.database.exec('BEGIN');assert.equal(store.database.isTransaction,true);
  store.database.prepare('INSERT INTO synthetic VALUES(?,?)').run(1,'synthetic-only');
  store.database.exec('ROLLBACK');assert.equal(store.database.isTransaction,false);
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM synthetic').get().n,0);
 }finally{store.close();store.close();}
});
test('dialect and provider inputs refuse before any database creation',()=>{
 for(const input of [null,{}, {dialect:'automatic',dbPath:':memory:'},{dbPath:':memory:',pgOptions:{}},{dialect:'postgres-pg17-v1',dbPath:':memory:',pgOptions:{}},{dialect:'postgres-pg17-v1',pgOptions:{fixtureTransport:{}}}]){
  assert.throws(()=>F.openIdentityStore(input),error=>error.code==='DASHBOARD_IDENTITY_FACTORY_INPUT_REFUSED');
 }
});
test('PG selection uses the real adapter refusal and never returns a SQLite fallback',()=>{
 // Both required target/admission guards are invalid. The real worker refuses
 // before loading pg or opening a connection, on Node22 and the local runtime.
 assert.throws(()=>F.openIdentityStore({dialect:'postgres-pg17-v1',pgOptions:{connection:{},admission:{}}}),error=>error.code==='DASHBOARD_PG_CONFIG_REFUSED');
});
test('SQLite opening failure publishes a fixed code without its original path or driver detail',()=>{
 assert.throws(()=>F.openIdentityStore({dbPath:__dirname}),error=>error.code==='DASHBOARD_IDENTITY_FACTORY_OPEN_REFUSED'&&!error.message.includes(__dirname)&&!Object.hasOwn(error,'cause'));
});
test('initialization error closes the real store, preserves rollback and returns no original error detail',()=>{
 let store;
 assert.throws(()=>F.initializeWithStore({dbPath:':memory:'},lease=>{
  store=lease;lease.database.exec('CREATE TABLE synthetic(id INTEGER)');lease.database.exec('BEGIN');
  const error=new Error('synthetic-row-must-not-escape');error.detail='synthetic-detail';throw error;
 }),error=>error.code==='DASHBOARD_IDENTITY_FACTORY_INITIALIZATION_REFUSED'&&!error.message.includes('synthetic')&&!Object.hasOwn(error,'detail'));
 assert.equal(store.database.isOpen,false);store.close();
});
test('an async initializer refuses, closes its lease and cannot be used as synchronous Auth',()=>{
 let store;
 assert.throws(()=>F.initializeWithStore({dbPath:':memory:'},async lease=>{store=lease;return {};}),error=>error.code==='DASHBOARD_IDENTITY_FACTORY_INITIALIZATION_REFUSED');
 assert.equal(store.database.isOpen,false);store.close();
});
