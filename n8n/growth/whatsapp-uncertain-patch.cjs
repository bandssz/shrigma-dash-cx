'use strict';
// Pure, version-bound patch of a fresh private export. No network or credentials.
const NODE = 'Interpreta resposta';
const MARKER = 'WA_UNCERTAIN_RESERVATION_V1';
const OLD_CLASSIFICATION = "const transitorio = TRANSITORIOS.includes(Number(err.code)) || status === null || status >= 500;";
const NEW_CLASSIFICATION = "const transitorio = TRANSITORIOS.includes(Number(err.code)) || !Number.isInteger(status) || status < 400 || status === 408 || status === 429 || status >= 500;";
const OLD_BRANCH = "    saida.terminal = false; saida.motivo = 'meta_erro_transitorio_reserva_liberada';\n    sql = `with d as (delete from shrigma_send_log where id = ${Number(saida.log_id)} and wamid is null returning 1) select count(*)::int as apagados from d`;";
const NEW_BRANCH = "    // " + MARKER + ": terminal stops automatic retries; incerto is not a definitive failure.\n    saida.terminal = true; saida.incerto = true; saida.reserva_preservada = true;\n    saida.motivo = 'meta_estado_incerto_reserva_preservada';\n    saida.erro_msg = 'UNCERTAIN_META: resposta sem comprovante de aceite; reserva preservada; revisar antes de qualquer nova tentativa';\n    sql = `with u as (update shrigma_send_log set erro = ${esc(saida.erro_code + ': ' + saida.erro_msg)} where id = ${Number(saida.log_id)} and wamid is null returning 1) select count(*)::int as atualizados from u`;";
const count = (s, token) => s.split(token).length - 1;
function patchCode(code) {
 if (typeof code !== 'string') throw Error('Expected interpreter code');
 if (code.includes(MARKER)) {
  if (count(code,MARKER)!==1 || !code.includes(NEW_BRANCH) || !code.includes(NEW_CLASSIFICATION) || /delete\s+from\s+shrigma_send_log/i.test(code)) throw Error('Unrecognized uncertainty patch; review fresh code');
  return code;
 }
 if (count(code,OLD_CLASSIFICATION)!==1 || count(code,OLD_BRANCH)!==1) throw Error('Interpreter changed; review fresh export');
 const next = code.replace(OLD_CLASSIFICATION,NEW_CLASSIFICATION).replace(OLD_BRANCH,NEW_BRANCH)
  .replace('//  erro transitorio (rate limit, indisponivel) -> APAGA a reserva (caller pode tentar no proximo ciclo), terminal:false','//  resposta ambigua/transitoria -> preserva a reserva, registra incerto e interrompe novas tentativas automaticas');
 if (/delete\s+from\s+shrigma_send_log/i.test(next)) throw Error('Unexpected reservation deletion remains');
 return next;
}
function patchWorkflow(fresh,{expectedVersionId}={}) {
 if (!fresh || !Array.isArray(fresh.nodes) || !expectedVersionId || fresh.versionId!==expectedVersionId) throw Error('A fresh export and matching expectedVersionId are required');
 const workflow=JSON.parse(JSON.stringify(fresh));
 const nodes=workflow.nodes.filter(n=>n.name===NODE);
 if(nodes.length!==1 || nodes[0].type!=='n8n-nodes-base.code') throw Error('Expected exactly one response interpreter');
 const before=nodes[0].parameters?.jsCode,after=patchCode(before);
 nodes[0].parameters.jsCode=after;
 return {workflow,changes:before===after?[]:[{node:NODE,field:'jsCode'}]};
}
module.exports={NODE,MARKER,OLD_CLASSIFICATION,OLD_BRANCH,patchCode,patchWorkflow};
