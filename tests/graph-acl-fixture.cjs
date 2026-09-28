'use strict';
const D=require('../tools/graph-acl-migration/deploy.cjs');
const NONCE='60000000-0000-4000-8000-000000000001';
async function setup(t,{db}={}){
 const base=await require('./journey-graph-install-fixture.cjs').installBase(t,{db});db=base.db;
 await db.exec(`SET statement_timeout='20s';ALTER SCHEMA public OWNER TO CURRENT_USER;
 CREATE ROLE central_leitor LOGIN NOINHERIT;
 CREATE ROLE fixture_group NOLOGIN;
 CREATE ROLE fixture_set_target NOLOGIN NOINHERIT;
 CREATE ROLE fixture_app LOGIN NOINHERIT;
 GRANT fixture_set_target TO fixture_app WITH INHERIT FALSE,SET TRUE;
 GRANT fixture_group TO fixture_set_target WITH INHERIT TRUE,SET TRUE;
 GRANT CREATE ON SCHEMA public TO PUBLIC;
 GRANT USAGE ON SCHEMA public TO central_leitor;
 GRANT CREATE ON SCHEMA public TO fixture_group WITH GRANT OPTION;
 COMMENT ON SCHEMA public IS 'existing application documentation';
 CREATE TABLE public.fixture_existing(id integer PRIMARY KEY,value text);INSERT INTO public.fixture_existing VALUES(1,'preserved');
 GRANT SELECT ON public.fixture_existing TO central_leitor;`);
 const query=db.query.bind(db),metadata=async()=>(await query(D.METADATA_SQL)).rows[0];
 const before=await metadata();
 return {...base,db,query,metadata,before,retired:{plan_hash:D.sha('synthetic old reviewed plan'),sql_hash:D.sha('synthetic old compiled SQL'),graph_shape:before.graph_state.graph_shape}};
}
function breakLate(sql){const marker='INSERT INTO '+D.SCHEMA+'.receipt';if(!sql.includes(marker))throw Error('FIXTURE_MARKER');return sql.replace(marker,'PERFORM missing_acl_preservation_fixture_function();\n'+marker);}
async function assertPreserved(x,assert,before){
 const after=await x.metadata();assert.deepEqual(after,D.expectedAfter(before,after.graph_state.graph_shape,after.graph_state.control_xmin));
 assert.deepEqual(after.capabilities,before.capabilities);assert.deepEqual(after.memberships,before.memberships);assert.deepEqual(after.roles,before.roles);
 const receipt=(await x.query(D.RECEIPT_SQL)).rows[0];assert.equal(receipt.nonce,NONCE);assert.deepEqual(receipt.before_state,before);assert.deepEqual(receipt.after_state,after);assert.deepEqual(receipt.retired,x.retired);
 await x.db.exec('SET ROLE central_leitor');
 try{await x.db.exec('CREATE TABLE public.fixture_reader_ddl(id integer)');assert.equal((await x.query('SELECT value FROM public.fixture_existing')).rows[0].value,'preserved');}finally{await x.db.exec('RESET ROLE');}
 await x.db.exec('SET ROLE fixture_app');
 try{await x.db.exec('SET ROLE fixture_set_target');assert.equal((await x.query("SELECT has_schema_privilege(current_user,'public','CREATE WITH GRANT OPTION') value")).rows[0].value,true);await x.db.exec('CREATE TABLE public.fixture_set_role_ddl(id integer)');}finally{await x.db.exec('RESET ROLE');}
 await x.db.exec('CREATE ROLE fixture_new_worker NOLOGIN NOINHERIT');
 assert.equal((await x.query("SELECT has_schema_privilege('fixture_new_worker','public','CREATE') value")).rows[0].value,false);
 await x.db.exec('SET ROLE fixture_new_worker');
 try{await assert.rejects(x.query('CREATE TABLE public.fixture_denied(id integer)'),/permission denied/);}finally{await x.db.exec('RESET ROLE');}
}
module.exports={setup,NONCE,breakLate,assertPreserved};
