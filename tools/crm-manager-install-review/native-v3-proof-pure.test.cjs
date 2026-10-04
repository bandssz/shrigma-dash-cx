'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const F=require('./native-fixture.cjs');
test('eight copied SQL files retain frozen pins and HBA is native four-rule configuration',()=>{
 for(const name of ['installer.sql','rollback.sql','profile.sql','scope.sql','auth.sql','operator.sql','short.sql','read.sql'])assert.ok(F.source(name).length>0);
 assert.equal(fs.readFileSync(path.join(__dirname,'pg_hba.conf'),'utf8'),'local all all trust\nhost all all 127.0.0.1/32 trust\nhost all all ::1/128 trust\nhost all all 0.0.0.0/0 scram-sha-256\n');
});
test('wrong native cluster or nonempty native DB refuses before any fixture DDL',async()=>{
 for(const mismatch of ['cluster','relations']){
  let statements=0,ended=false;
  class FakeClient{
   constructor(config){this.connectionParameters=config;}
   async connect(){}
   async end(){ended=true;}
   async query(sql){
    statements++;assert.match(sql,/^SELECT /);
    if(sql.includes('AS database'))return{rows:[{database:'listmonk',role:'postgres',session_role:'postgres',major:17,port:5432,app:'shrigma-manager-v3-private-fixture',cluster:mismatch==='cluster'?'foreign-cluster':'shrigma-native-v3-disposable-only'}]};
    return{rows:[{relations:1,fixture_roles:0,default_acls:0,public_functions:0,extra_schemas:0}]};
   }
  }
  await assert.rejects(F.createNativeFixture(FakeClient));
  assert.equal(statements,mismatch==='cluster'?1:2);assert.equal(ended,true);
 }
});
