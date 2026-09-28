'use strict';
// A permanent no-op constraint invalidates the schema guard of an older, uncertain
// graph installation without changing data, enabling graphs or creating a worker.
const G=require('../graph-install/deploy.cjs');
const NAME='crm_graph_retired_install_v1';
const needle='WHERE k.conrelid=c.oid)';
if(!G.GRAPH_SHAPE.includes(needle))throw Error('GRAPH_ACL_FINGERPRINT_CONTRACT');
const SHAPE_WITHOUT_BARRIER=G.GRAPH_SHAPE.replace(needle,`WHERE k.conrelid=c.oid AND NOT (c.relname='control' AND k.conname='${NAME}'))`);
const STATE_SQL=`SELECT g.*,${SHAPE_WITHOUT_BARRIER} AS shape_without_barrier,
 (SELECT xmin::text FROM crm_graph_candidate.control WHERE singleton) AS control_xmin,
 (SELECT c.relkind='r' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT c.relispartition AND NOT c.relhassubclass AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid) AND NOT EXISTS(SELECT 1 FROM pg_rewrite r WHERE r.ev_class=c.oid) AND NOT EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AND (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',a.atttypid::regtype::text,'notnull',a.attnotnull,'generated',a.attgenerated,'identity',a.attidentity,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)='[{"name":"singleton","type":"boolean","notnull":true,"generated":"","identity":"","default":"true"},{"name":"enabled","type":"boolean","notnull":true,"generated":"","identity":"","default":"false"}]'::jsonb
 AND (SELECT count(*)=2 AND bool_and(NOT k.condeferrable AND NOT k.condeferred AND k.convalidated AND ((k.conname='control_pkey' AND k.contype='p' AND k.connoinherit AND pg_get_constraintdef(k.oid)='PRIMARY KEY (singleton)') OR (k.conname='control_singleton_check' AND k.contype='c' AND NOT k.connoinherit AND pg_get_constraintdef(k.oid)='CHECK (singleton)' AND pg_get_expr(k.conbin,k.conrelid)='singleton'))) FROM pg_constraint k WHERE k.conrelid=c.oid AND k.conname<>'${NAME}')
 AND (SELECT count(*)=1 AND bool_and(i.indisprimary AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate AND i.indexprs IS NULL AND i.indpred IS NULL AND pg_get_indexdef(i.indexrelid)='CREATE UNIQUE INDEX control_pkey ON crm_graph_candidate.control USING btree (singleton)') FROM pg_index i WHERE i.indrelid=c.oid) FROM pg_class c WHERE c.oid='crm_graph_candidate.control'::regclass) AS control_update_safe,
 (SELECT jsonb_build_object('name',k.conname,'type',k.contype,'validated',k.convalidated,'noinherit',k.connoinherit,'expression',pg_get_expr(k.conbin,k.conrelid)) FROM pg_constraint k WHERE k.conrelid='crm_graph_candidate.control'::regclass AND k.conname='${NAME}') AS barrier
 FROM (${G.METADATA_SQL.replace(/;\s*$/,'')}) g`;
const EXPECTED={name:NAME,type:'c',validated:false,noinherit:false,expression:'true'};
const DDL=`UPDATE crm_graph_candidate.control SET enabled=enabled WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'GRAPH_ACL_CONTROL_MISSING';END IF;
 ALTER TABLE crm_graph_candidate.control ADD CONSTRAINT ${NAME} CHECK (true) NOT VALID;`;
function check(ok,code){if(!ok)throw Error('GRAPH_ACL_'+code);}
function preflight(before,retired){
 const g=before.graph_state;check(g?.control_update_safe===true&&/^\d+$/.test(g.control_xmin),'CONTROL_UPDATE_UNSAFE');check(g&&g.shape_without_barrier===g.graph_shape&&g.barrier===null,'RETIREMENT_BASE');
 // The sole waived graph precondition is exactly the permission being migrated.
 check(G.canonical(g.public_create_schemas)==='["public"]','PUBLIC_SCHEMA_SCOPE');
 G.preflight({...g,public_create_schemas:[]});
 check(g.database===before.database&&g.role===before.role&&g.statement_timeout_ms===before.statement_timeout_ms,'GRAPH_IDENTITY');
 if(retired!==undefined)check(retired&&Object.keys(retired).sort().join(',')==='graph_shape,plan_hash,sql_hash'&&/^[a-f0-9]{64}$/.test(retired.plan_hash)&&/^[a-f0-9]{64}$/.test(retired.sql_hash)&&retired.graph_shape===g.graph_shape,'RETIREMENT_REFERENCE');
}
function after(before,graphShape=null,controlXmin=null){const g=JSON.parse(JSON.stringify(before.graph_state));g.graph_shape=graphShape;g.control_xmin=controlXmin;g.public_create_schemas=[];g.barrier=EXPECTED;return g;}
function verify(before,actual){check(/^\d+$/.test(actual?.graph_state?.control_xmin)&&actual.graph_state.control_xmin!==before.graph_state.control_xmin,'RETIREMENT_ROW_VERSION');check(/^[a-f0-9]{32}$/.test(actual?.graph_state?.graph_shape)&&actual.graph_state.graph_shape!==before.graph_state.graph_shape,'RETIREMENT_SHAPE');}
module.exports={NAME,STATE_SQL,EXPECTED,DDL,preflight,after,verify};
