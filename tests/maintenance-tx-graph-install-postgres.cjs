'use strict';
const assert=require('node:assert/strict'),F=require('./maintenance-tx-graph-install-fixture.cjs');
async function run(){
 const u=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid');
 assert.equal(process.env.GRAPH_TEST_DATABASE_ISOLATED,'1');assert.equal(u.hostname,'127.0.0.1');assert.equal(u.username,'synthetic');assert.equal(u.password,'');assert.equal(u.port,'5432');assert.equal(u.pathname,'/maintenance_tx_graph_install_test');assert.equal(u.search,'');assert.equal(u.hash,'');
 const {Client}=require('pg'),client=new Client({connectionString:u.toString(),statement_timeout:20000,application_name:'synthetic-tx-graph-install'});await client.connect();
 const query=client.query.bind(client),db={query,exec:query,close:async()=>{}},pool={connect:async()=>({query,release(){}})};let createdRole=false;
 try{
  assert.equal((await query('SHOW server_version_num')).rows[0].server_version_num,'170010');
  assert.equal((await query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','crm_graph_candidate','crm_maintenance_candidate') AND c.relkind IN('r','p','v')")).rows[0].n,0);
  assert.equal((await query("SELECT count(*)::int n FROM pg_roles WHERE rolname='crm_graph_worker'")).rows[0].n,0);
  const x=await F.setup({after(){}},{db,pool});createdRole=true;
  await F.composition(x);
  console.log('PASS graph OFF → TX: late failure rolls back both seals and DDL; retry commits paired chain; replay refused; Fish/Aristo CART remains single, zero transport.');
 }finally{
  if(createdRole){await query('DROP OWNED BY crm_graph_worker');await query('DROP ROLE crm_graph_worker');}
  await client.end();
 }
}
run().catch(e=>{console.error('FAIL TX graph installation:',e.code||'',e.message);process.exitCode=1;});
