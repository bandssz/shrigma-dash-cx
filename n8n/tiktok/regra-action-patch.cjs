/* Pure patch of a fresh workflow. Authentication, review transport and all other nodes survive.
 * Inputs/outputs may contain server secrets: callers must keep exports outside the public repo. */
'use strict';
const LEGACY_VALIDATE = "if (acao === 'regra') {\n  // campos editáveis pelo painel, com validação de faixa\n  const r = b.regra || {};\n  const num = (v, min, max) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new Error('valor fora da faixa'); return n; };\n  const out = {};\n  if (r.gmv_auto !== undefined) out.gmv_auto = num(r.gmv_auto, 0, 1e7);\n  if (r.gmv_manual !== undefined) out.gmv_manual = num(r.gmv_manual, 0, 1e7);\n  if (r.fulfillment_min !== undefined) out.fulfillment_min = num(r.fulfillment_min, 0, 100);\n  if (r.teto_mensal !== undefined) out.teto_mensal = Math.round(num(r.teto_mensal, 0, 10000));\n  if (r.modo !== undefined) { if (!['dry_run', 'ativo', 'pausado'].includes(r.modo)) throw new Error('modo invalido'); out.modo = r.modo; }\n  // cobranca_modo é separado de modo de propósito: mandar mensagem e decidir amostra são riscos\n  // diferentes e ligar um não pode ligar o outro sem querer.\n  if (r.cobranca_modo !== undefined) { if (!['dry_run', 'ativo', 'pausado'].includes(r.cobranca_modo)) throw new Error('cobranca_modo invalido'); out.cobranca_modo = r.cobranca_modo; }\n  if (r.cobranca_max_dia !== undefined) out.cobranca_max_dia = Math.round(num(r.cobranca_max_dia, 0, 200));\n  if (r.cobranca_max_tentativas !== undefined) out.cobranca_max_tentativas = Math.round(num(r.cobranca_max_tentativas, 1, 20));\n  if (r.cobranca_dias_entre !== undefined) out.cobranca_dias_entre = Math.round(num(r.cobranca_dias_entre, 1, 120));\n  if (out.gmv_auto !== undefined && out.gmv_manual !== undefined && out.gmv_manual > out.gmv_auto) throw new Error('gmv_manual nao pode ser maior que gmv_auto');\n  if (!Object.keys(out).length) throw new Error('nada para alterar');\n  return [{ json: { acao, marca, autor, regra: out } }];\n}";
const LEGACY_EXECUTE = "if (a.acao === 'regra') {\n  const sets = Object.entries(a.regra).map(([k, v]) => `${k} = ${typeof v === 'number' ? v : q(v)}`);\n  sets.push(`atualizado_em = now()`, `atualizado_por = ${q(a.autor + ' (painel)')}`);\n  return [{ json: { ok: true, mensagem: `regra da marca ${a.marca} atualizada: ${Object.keys(a.regra).join(', ')}`,\n    sql: `UPDATE crm_tts_regra SET ${sets.join(', ')} WHERE marca = ${q(a.marca)} RETURNING *` } }];\n}";
const VALIDATE = `if (acao === 'regra') {
  const r = b.regra;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('regra deve ser um objeto');
  const ranges = { gmv_auto:[0,1e7], gmv_manual:[0,1e7], fulfillment_min:[0,100], teto_mensal:[0,10000],
    cobranca_max_dia:[0,200], cobranca_max_tentativas:[1,20], cobranca_dias_entre:[1,120] };
  const integers = ['teto_mensal','cobranca_max_dia','cobranca_max_tentativas','cobranca_dias_entre'];
  const out = {};
  for (const [k,v] of Object.entries(r)) {
    if (['modo','cobranca_modo'].includes(k)) {
      if (typeof v !== 'string' || !['dry_run','ativo','pausado'].includes(v)) throw new Error('modo invalido');
    } else {
      if (!Object.hasOwn(ranges,k)) throw new Error('campo de regra nao editavel');
      if (typeof v !== 'number' || !Number.isFinite(v) || v < ranges[k][0] || v > ranges[k][1]
          || integers.includes(k) && !Number.isInteger(v)) throw new Error('limite numerico invalido');
    }
    out[k] = v;
  }
  if (!Object.keys(out).length) throw new Error('nada para alterar');
  const expected = b.esperado_atualizado_em;
  if (expected !== undefined && (typeof expected !== 'string' || !expected.trim())) throw new Error('versao invalida');
  // Cross-field and activation checks run against the locked current row in PostgreSQL.
  return [{ json: { acao, marca, autor, regra: out, esperado_atualizado_em: expected ?? null } }];
}`;
const EXECUTE = `if (a.acao === 'regra') {
  return [{ json: { acao:'regra', sql:'SELECT public.crm_tts_regra_patch_v1($1::text,$2::jsonb,$3::text,$4::text) AS regra_result',
    sqlParameters:[a.marca,JSON.stringify(a.regra),a.autor,a.esperado_atualizado_em ?? null] } }];
}`;
const RESULT = `($('Executa acao').first().json.acao === 'regra' ?
  ($input.first().json.regra_result || {ok:false,codigo:'resultado_ausente',erro:'A gravação não confirmou o resultado. Recarregue a regra antes de tentar novamente.',mensagem:'Resultado indisponível.',linhas:[]}) :
  {ok:$('Executa acao').first().json.ok,mensagem:$('Executa acao').first().json.mensagem,linhas:$input.all().map(i=>i.json).filter(j=>Object.keys(j).length)})`;
const RESPONSE_BODY='={{ JSON.stringify('+RESULT+') }}';
const RESPONSE_CODE='={{ ('+RESULT+').ok ? 200 : (('+RESULT+").codigo === 'resultado_ausente' ? 500 : 400) }}";
function replaceBlock(code,start,end,replacement,legacy) {
 if(typeof code!=='string'||code.split(start).length!==2||code.split(end).length!==2)throw Error('Node divergiu: revisar export fresco');
 const i=code.indexOf(start),j=code.indexOf(end,i);
 if(j<i)throw Error('Ordem dos blocos divergiu');
 if(![replacement.trim(),legacy].includes(code.slice(i,j).trim()))throw Error('Bloco de regra divergiu: revisar alterações concorrentes');
 return code.slice(0,i)+replacement+'\n'+code.slice(j);
}
function patchValidate(code){return replaceBlock(code,"if (acao === 'regra') {","throw new Error('acao desconhecida');",VALIDATE,LEGACY_VALIDATE);}
function patchExecute(code){return replaceBlock(code,"if (a.acao === 'regra') {",'// revisar',EXECUTE+'\n',LEGACY_EXECUTE);}
function patchWorkflow(fresh,{expectedVersion}={}){
 if(!fresh?.versionId||!expectedVersion||fresh.versionId!==expectedVersion)throw Error('Versão fresca obrigatória ou alterada');
 const workflow=JSON.parse(JSON.stringify(fresh)),changes=[];
 const node=name=>{const n=workflow.nodes.filter(n=>n.name===name);if(n.length!==1)throw Error('Node ausente ou duplicado: '+name);return n[0];};
 const validate=node('Valida'),execute=node('Executa acao'),pg=node('Grava'),response=node('Resposta');
 if(!pg.type.endsWith('.postgres')||pg.parameters.query!=='={{ $json.sql }}')throw Error('Grava divergiu');
 const edit=(n,key,value)=>{if(JSON.stringify(n.parameters[key])!==JSON.stringify(value)){n.parameters[key]=value;changes.push({node:n.name,field:key});}};
 edit(validate,'jsCode',patchValidate(validate.parameters.jsCode));
 edit(execute,'jsCode',patchExecute(execute.parameters.jsCode));
 edit(pg,'options',{...pg.parameters.options,queryReplacement:'={{ $json.sqlParameters || [] }}'});
 edit(response,'responseBody',RESPONSE_BODY);
 edit(response,'options',{...response.parameters.options,responseCode:RESPONSE_CODE});
 return {workflow,changes};
}
module.exports={VALIDATE,EXECUTE,RESULT,RESPONSE_BODY,RESPONSE_CODE,patchValidate,patchExecute,patchWorkflow};
