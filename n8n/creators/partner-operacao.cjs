'use strict';
// Parceiros do site — cadastro de pagamento (titular, CPF, Pix) na mesma escrita com recibo do piloto.
// A função crm_creator_pilot_write_v1 em produção evoluiu além do arquivo do repositório; por isso o ramo
// novo é aplicado SOBRE a definição lida do banco (pg_get_functiondef), nunca sobre uma cópia antiga.
// Se algum dos marcadores sumir, a aplicação para em vez de adivinhar.
const fs = require('node:fs'), path = require('node:path');

const MARCA_TIPO = "ELSE RETURN jsonb_build_object('erro','Tipo de edição inválido.'); END IF;";
const MARCA_CLEAN = "clean:=p-'k'-'autor';";
const MARCA_DECLARE = 'tentativa integer;';

// O log de operações guarda a requisição para reconhecer repetição. CPF e chave Pix entram só como hash.
const MASCARA_LOG = `
 IF p->>'kind'='pagamento' AND jsonb_typeof(p->'data')='object' THEN
  clean:=jsonb_set(jsonb_set(clean,'{data,cpf}',to_jsonb(encode(sha256(convert_to(coalesce(p->'data'->>'cpf',''),'UTF8')),'hex'))),
   '{data,pix_chave}',to_jsonb(encode(sha256(convert_to(coalesce(p->'data'->>'pix_chave',''),'UTF8')),'hex')));
 END IF;`;

const PAGAMENTO_RAMO = ` ELSIF kind='pagamento' THEN
  IF coalesce(data->>'candidate_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN jsonb_build_object('erro','Confira o parceiro.'); END IF;
  cid:=(data->>'candidate_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.crm_partner_candidate_v1 WHERE id=cid AND marca=brand) THEN RETURN jsonb_build_object('erro','Parceiro não pertence à marca consultada.'); END IF;
  cpf_n:=regexp_replace(coalesce(data->>'cpf',''),'[^0-9]','','g');
  IF length(trim(coalesce(data->>'titular','')))<3 OR length(data->>'titular')>120 OR NOT public.crm_partner_cpf_ok_v1(cpf_n) THEN RETURN jsonb_build_object('erro','Confira o nome do titular e o CPF.'); END IF;
  pix_n:=public.crm_partner_pix_normaliza_v1(data->>'pix_tipo',data->>'pix_chave');
  IF pix_n IS NULL THEN RETURN jsonb_build_object('erro','Chave Pix inválida para o tipo escolhido.'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('partner-payment:'||cid,0));
  SELECT version INTO current_version FROM public.crm_partner_payment_v1 WHERE candidate_id=cid FOR UPDATE;
  IF coalesce(current_version,0)<>expected THEN RETURN jsonb_build_object('erro','Cadastro de pagamento mudou. Atualize antes de salvar.'); END IF;
  INSERT INTO public.crm_partner_payment_v1(candidate_id,marca,titular,cpf,pix_tipo,pix_chave,version,actor)
  VALUES(cid,brand,trim(data->>'titular'),cpf_n,data->>'pix_tipo',pix_n,expected+1,actor_id)
  ON CONFLICT(candidate_id) DO UPDATE SET titular=excluded.titular,cpf=excluded.cpf,pix_tipo=excluded.pix_tipo,pix_chave=excluded.pix_chave,
   version=excluded.version,actor=excluded.actor,updated_at=now();
  result:=jsonb_build_object('ok',true,'kind',kind,'candidate_id',cid,'version',expected+1,'request_id',rid,'pix_final',right(pix_n,4));
`;

function patchWrite(def) {
  const d = String(def || '');
  if (!d.includes('FUNCTION public.crm_creator_pilot_write_v1')) throw Error('definição de crm_creator_pilot_write_v1 esperada');
  if (d.includes("kind='pagamento'")) throw Error('ramo de pagamento já existe');
  for (const m of [MARCA_TIPO, MARCA_CLEAN, MARCA_DECLARE]) if (d.split(m).length !== 2) throw Error('marcador ausente ou repetido: ' + m);
  // replacer em função: o SQL tem "$'" nas expressões regulares, que String.replace interpretaria
  return d.replace(MARCA_DECLARE, () => MARCA_DECLARE + ' cpf_n text; pix_n text;')
    .replace(MARCA_CLEAN, () => MARCA_CLEAN + MASCARA_LOG)
    .replace(MARCA_TIPO, () => PAGAMENTO_RAMO + ' ' + MARCA_TIPO);
}

const SQL = fs.readFileSync(path.join(__dirname, 'partner-operacao.sql'), 'utf8');
module.exports = { SQL, patchWrite, PAGAMENTO_RAMO };
