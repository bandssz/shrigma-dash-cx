'use strict';
// Pure SQL construction. guardBody is reviewed internal installer code, never user input.
const SIGNATURE='public.shrigma_crm_vip_subscribe_v1(text,text,boolean,text)';
function check(ok,code){if(!ok)throw Error('VIP_INSTALL_'+code);}
function commentEnd(sql,i){
 if(sql.startsWith('--',i)){const n=sql.indexOf('\n',i+2);return n<0?sql.length:n+1;}
 if(!sql.startsWith('/*',i))return i;
 let depth=1,j=i+2;while(j<sql.length&&depth){if(sql.startsWith('/*',j)){depth++;j+=2;}else if(sql.startsWith('*/',j)){depth--;j+=2;}else j++;}check(depth===0,'COMMENT');return j;
}
function triviaEnd(sql,i){while(i<sql.length){if(/\s/.test(sql[i])){i++;continue;}const end=commentEnd(sql,i);if(end===i)break;i=end;}return i;}
function statements(sql){
 const out=[];let start=0,i=0;
 while(i<sql.length){
  const comment=commentEnd(sql,i);if(comment!==i){i=comment;continue;}
  if(sql[i]==="'"||sql[i]==='"'){
   const quote=sql[i++];let closed=false;while(i<sql.length){if(sql[i]===quote){if(sql[i+1]===quote){i+=2;continue;}i++;closed=true;break;}i++;}check(closed,'QUOTE');continue;
  }
  if(sql[i]==='$'){
   const tag=sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0];
   if(tag){const end=sql.indexOf(tag,i+tag.length);check(end>=0,'DOLLAR_QUOTE');i=end+tag.length;continue;}
  }
  if(sql[i]===';'){const coreStart=triviaEnd(sql,start);out.push({start:coreStart,end:i+1,text:sql.slice(coreStart,i).trim()});start=i+1;}i++;
 }
 check(triviaEnd(sql,start)===sql.length,'STATEMENT_END');return out;
}
function delimiter(stem,text){let n=0,tag;do{tag='$'+stem+'_'+n+++'$';}while(text.includes(tag));return tag;}
function atomicInstallSQL(migration,guardBody){
 check(typeof migration==='string'&&migration.length>0&&migration.length<=262144,'MIGRATION');
 check(typeof guardBody==='string'&&guardBody.trim().length>0&&guardBody.length<=65536,'GUARD');
 const list=statements(migration);check(list.length===4&&/^BEGIN$/i.test(list[0].text)&&/^COMMIT$/i.test(list[3].text),'OUTER_TRANSACTION');
 check(/^CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.shrigma_crm_vip_subscribe_v1\s*\(\s*p_email\s+text\s*,\s*p_origem\s+text\s*,\s*p_corrigido\s+boolean\s*,\s*p_source\s+text\s*\)\s+RETURNS\s+TABLE\s*\(\s*eligible\s+boolean\s*,\s*reason\s+text\s*\)/i.test(list[1].text),'SIGNATURE');
 check(/^REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.shrigma_crm_vip_subscribe_v1\s*\(\s*text\s*,\s*text\s*,\s*boolean\s*,\s*text\s*\)\s+FROM\s+PUBLIC$/i.test(list[2].text),'PUBLIC_REVOKE');
 // Remove only the two outer statements. Preserve comments and the function body verbatim.
 const ddl=migration.slice(0,list[0].start)+migration.slice(list[0].end,list[3].start)+migration.slice(list[3].end);
 const all=ddl+'\n'+guardBody,outer=delimiter('vip_install',all),inner=delimiter('vip_ddl',all+outer);
 return `DO ${outer}\nBEGIN\n PERFORM set_config('lock_timeout','3s',true);\n ${guardBody}\n EXECUTE ${inner}${ddl}${inner};\nEND ${outer};`;
}
module.exports={SIGNATURE,atomicInstallSQL};
