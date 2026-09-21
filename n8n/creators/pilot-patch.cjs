'use strict';
function patchWorkflow(fresh,{expectedVersionId}={}){
 if(fresh?.id!=='SVM6ojSUrFZkZd0L'||fresh.versionId!==expectedVersionId)throw Error('Fresh Creators workflow required');
 const w=structuredClone(fresh),n=w.nodes.find(x=>x.name==='Monta SQL'),pg=w.nodes.find(x=>x.name==='Executa');
 if(!n?.parameters.jsCode.includes("'gerado_em', now(),")||n.parameters.jsCode.includes('crm_creator_pilot_read_v1')||pg?.parameters.query!=='={{ $json.sql }}'||Object.keys(pg.parameters.options||{}).length)throw Error('Creators runtime drift');
 n.parameters.jsCode=n.parameters.jsCode.replace("'gerado_em', now(),","'gerado_em', now(),\n  'pilot', ${b.pilot===true?'public.crm_creator_pilot_read_v1('+q(ini)+'::date,'+q(fim)+'::date)':'NULL'},");
 const marker='// ---------- LEITURA ----------';if(!n.parameters.jsCode.includes(marker))throw Error('Read marker missing');
 n.parameters.jsCode=n.parameters.jsCode.replace(marker,"if (['piloto_salvar','piloto_operacao'].includes(acao)) return [{json:{sql:'SELECT public.crm_creator_pilot_write_v1($1::jsonb) AS payload',args:[JSON.stringify(b)]}}];\n"+marker);
 pg.parameters.options.queryReplacement='={{ $json.args || [] }}';return w;
}
module.exports={patchWorkflow};
