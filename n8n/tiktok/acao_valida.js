// API de AÇÃO do painel de afiliados TikTok. Só com a chave de ESCRITA (própria, não mora no repo):
// a chave de leitura fica no localStorage de quem abre o painel e não pode aprovar amostra nem mudar regra.
const ESCRITA = '__SERVER_ONLY_TIKTOK_WRITE_KEY__';
if (ESCRITA.startsWith('__SERVER_ONLY_')) throw new Error('Configure a credencial no servidor antes de publicar este node.');
const b = $json.body || {};
if (String(b.k || '') !== ESCRITA) throw new Error('chave invalida');
const acao = String(b.acao || '');
const marca = String(b.marca || '');
if (!['aristo', 'fish'].includes(marca)) throw new Error('marca invalida');
const autor = String(b.autor || '').trim().slice(0, 40) || 'painel';
if (acao === 'revisar') {
  const application_id = String(b.application_id || '').replace(/[^0-9]/g, '');
  const resultado = String(b.resultado || '').toUpperCase();
  if (!application_id) throw new Error('application_id obrigatorio');
  if (!['APPROVE', 'REJECT'].includes(resultado)) throw new Error('resultado deve ser APPROVE ou REJECT');
  const motivo_rejeicao = ['NOT_MATCH', 'INSUFFICIENT_STOCK', 'OTHER'].includes(String(b.motivo_rejeicao || '')) ? b.motivo_rejeicao : 'NOT_MATCH';
  return [{ json: { acao, marca, autor, application_id, resultado, motivo_rejeicao, observacao: String(b.observacao || '').slice(0, 200) } }];
}
if (acao === 'regra') {
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
}
throw new Error('acao desconhecida');
