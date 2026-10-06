'use strict';
// This compiler is offline. Runtime execution accepts exact source statements
// from a pinned registry, never arbitrary SQL or a browser supplied namespace.
function tokens(sql){const out=[];for(let i=0;i<sql.length;){let j=i,c=sql[i];if(/\s/.test(c)){i++;continue;}
 if(c==="'"||c==='"'){const quote=c;i++;while(i<sql.length){if(sql[i]===quote){if(sql[i+1]===quote){i+=2;continue;}i++;break;}i++;}if(sql[i-1]!==quote)throw Error('SQL_LITERAL_REFUSED');out.push({kind:quote==="'"?'literal':'quoted',text:sql.slice(j,i)});continue;}
 if(c==='-'&&sql[i+1]==='-'){while(i<sql.length&&sql[i]!=='\n')i++;continue;}
 if(c==='/'&&sql[i+1]==='*'){const end=sql.indexOf('*/',i+2);if(end<0)throw Error('SQL_COMMENT_REFUSED');i=end+2;continue;}
 if(/[A-Za-z_]/.test(c)){while(i<sql.length&&/[A-Za-z0-9_]/.test(sql[i]))i++;out.push({kind:'word',text:sql.slice(j,i)});continue;}
 if(/[0-9]/.test(c)){while(i<sql.length&&/[0-9.]/.test(sql[i]))i++;out.push({kind:'number',text:sql.slice(j,i)});continue;}
 if(['>=','<=','<>','!=','||'].includes(sql.slice(i,i+2))){out.push({kind:'operator',text:sql.slice(i,i+2)});i+=2;continue;}
 if(!'(),.;?=<>+-*/'.includes(c))throw Error('SQL_TOKEN_REFUSED');out.push({kind:'punctuation',text:c});i++;
 }return out;}
const upper=t=>t?.text.toUpperCase();
function mapPrepare(sql,tables){const ts=tokens(sql),names=new Set(tables.map(t=>t.name)),first=upper(ts[0]);
 if(first==='PRAGMA'){
  const match=/^PRAGMA table_info\((campaign_writer_attestation_v1|audience_draft_operations)\)$/.exec(sql);if(!match)throw Error('SQL_PRAGMA_REFUSED');
  return {kind:'table-info',table:match[1],parameterCount:0,writes:false,pgSql:null};
 }
 if(ts.some(t=>upper(t)==='SQLITE_MASTER')){
  if(!/^SELECT 1 FROM sqlite_master WHERE type='table' AND name=(\?|'[a-z][a-z0-9_]*')$/.test(sql))throw Error('SQL_MASTER_REFUSED');
  const value=ts.at(-1).text,parameterCount=value==='?'?1:0;
  return {kind:'query',writes:false,parameterCount,pgSql:"SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='dashboard_identity' AND c.relkind IN('r','p') AND c.relname IN ("+[...names].map(n=>"'"+n+"'").join(',')+") AND c.relname="+(parameterCount?'$1::text':value)};
 }
 if(!['SELECT','INSERT','UPDATE','DELETE'].includes(first)||ts.some(t=>t.text===';'))throw Error('SQL_STATEMENT_REFUSED');
 let n=0,ignore=false;const out=[];
 const ordinal=alias=>"(SELECT ord.source_rowid FROM dashboard_identity.\"_sqlite_row_order_v1\" ord WHERE ord.table_name='crm_writer_bridge_op_v1' AND ord.row_key="+alias+'.operation_id)';
 for(let i=0;i<ts.length;i++){const token=ts[i],word=upper(token);
  if(i===1&&word==='OR'&&upper(ts[i+1])==='IGNORE'&&first==='INSERT'){ignore=true;i++;continue;}
  if(token.kind==='word'&&ts[i+1]?.text==='.'&&upper(ts[i+2])==='ROWID'){out.push(ordinal(token.text));i+=2;continue;}
  if(word==='ROWID'){out.push(ordinal('crm_writer_bridge_op_v1'));continue;}
  if(token.text==='?'){const parameter='$'+(++n);out.push(upper(ts[i+1])==='IS'&&upper(ts[i+2])==='NULL'?parameter+'::text':parameter);continue;}
  if(token.kind==='word'&&names.has(token.text)&&['FROM','JOIN','UPDATE','INTO'].includes(upper(ts[i-1]))){out.push('dashboard_identity."'+token.text+'"');continue;}
  out.push(token.text);
 }
 let ignoreNullParameters;
 if(ignore){
  const known=new Map([
   ["INSERT OR IGNORE INTO crm_writer_bridge_op_v1(operation_id,commit_operation_id,lifecycle_id,kind,phase,request_json,request_mac) VALUES(?,?,?,'revoke','revoke_pending',?,?)",[1,2,3,4]],
   ['INSERT OR IGNORE INTO crm_writer_retired_binding_v1 VALUES(?,?,?,?,?,?,?,?,?,?)',[0,1,2,3,4,5,6,7,8,9]]
  ]);
  ignoreNullParameters=known.get(sql);if(!ignoreNullParameters)throw Error('SQL_IGNORE_REFUSED');out.push('ON CONFLICT DO NOTHING');
 }
 return {kind:'query',writes:first!=='SELECT',parameterCount:n,ignore,...(ignore?{ignoreNullParameters}:{}),pgSql:out.join(' ')};
}
function mapExec(sql){if(['BEGIN IMMEDIATE','COMMIT','ROLLBACK'].includes(sql))return {kind:sql==='BEGIN IMMEDIATE'?'begin':sql.toLowerCase()};
 if(sql==='PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;')return {kind:'schema-assertion'};
 if(tokens(sql).some(t=>upper(t)==='CREATE')||/^ALTER TABLE (?:campaign_writer_attestation_v1|audience_draft_operations) ADD COLUMN [a-z_]+ (?:TEXT|INTEGER)$/.test(sql))return {kind:'schema-assertion'};
 throw Error('SQL_EXEC_REFUSED');}
module.exports={tokens,mapPrepare,mapExec};
