/* Instalador da recuperação de tentativas pendentes · regressões da revisão Codex (#220)
   em PGlite isolado (sem rede, sem credenciais, sem transporte nativo). Rodar com QA_PG=1.
   Casos em tests/claude-pending-recovery-install-cases.cjs. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const cases=require('./claude-pending-recovery-install-cases.cjs');
(async()=>{
 const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
 const db=new PGlite();
 try{
  for(const f of ['tests/campaign-provider-schema.sql','n8n/growth/campaign-store.sql','n8n/growth/campaign-recovery.sql','n8n/growth/campaign-provider.sql'])await db.exec(read(f));
  await cases(db,{native:false});
  console.log('PASS pending recovery installer (PGlite): provider alterado com comentários, owner/SECURITY/volatilidade/search_path/ACL divergentes e trigger/função homônimos alheios recusados sem DDL; parcial recusado; reinstalação exata no-op; gate OFF mantém a cerca; inventário do documento roda.');
 }finally{await db.close();}
})().catch(e=>{console.error(e.message,e.where||'',e.stack);process.exitCode=1;});
