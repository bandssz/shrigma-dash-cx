'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{postgresTarget,verifySchema,SCHEMA_SHA256}=require('./ab-native-roles.cjs');
test('native role proof refuses remote, wrong, unacknowledged, query-injected or ambiguous DB targets',()=>{
 const valid={AB_NATIVE_ROLES_ISOLATED:'1',TEST_DATABASE_URL:'postgres://synthetic@127.0.0.1:5432/ab_native_roles_test'};
 assert.equal(postgresTarget(valid),valid.TEST_DATABASE_URL);
 for(const overrides of [{AB_NATIVE_ROLES_ISOLATED:'0'},{TEST_DATABASE_URL:'postgres://synthetic@example.invalid/ab_native_roles_test'},{TEST_DATABASE_URL:'postgres://synthetic@localhost/production'},{TEST_DATABASE_URL:'postgres://synthetic@localhost/ab_native_roles_test?host=example.invalid'},{TEST_DATABASE_URL:'postgres://synthetic@localhost/ab_native_roles_test#x'},{TEST_DATABASE_URL:'postgresql://synthetic@localhost/ab_native_roles_test'},{}]){
  if(!Object.keys(overrides).length)assert.throws(()=>postgresTarget({}));else assert.throws(()=>postgresTarget({...valid,...overrides}));
 }
});
test('native schema must match the complete byte-pinned embedded 6.1.0 schema before DDL',()=>{
 assert.match(SCHEMA_SHA256,/^[a-f0-9]{64}$/);assert.throws(()=>verifySchema('CREATE TABLE synthetic(id int)'),/AB_NATIVE_SCHEMA_DRIFT/);assert.throws(()=>verifySchema(null),/AB_NATIVE_SCHEMA_DRIFT/);
});
