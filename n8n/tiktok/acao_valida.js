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
  // campos editáveis pelo painel, com validação de faixa
  const r = b.regra || {};
  const num = (v, min, max) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new Error('valor fora da faixa'); return n; };
  const out = {};
  if (r.gmv_auto !== undefined) out.gmv_auto = num(r.gmv_auto, 0, 1e7);
  if (r.gmv_manual !== undefined) out.gmv_manual = num(r.gmv_manual, 0, 1e7);
  if (r.fulfillment_min !== undefined) out.fulfillment_min = num(r.fulfillment_min, 0, 100);
  if (r.teto_mensal !== undefined) out.teto_mensal = Math.round(num(r.teto_mensal, 0, 10000));
  if (r.modo !== undefined) { if (!['dry_run', 'ativo', 'pausado'].includes(r.modo)) throw new Error('modo invalido'); out.modo = r.modo; }
  // cobranca_modo é separado de modo de propósito: mandar mensagem e decidir amostra são riscos
  // diferentes e ligar um não pode ligar o outro sem querer.
  if (r.cobranca_modo !== undefined) { if (!['dry_run', 'ativo', 'pausado'].includes(r.cobranca_modo)) throw new Error('cobranca_modo invalido'); out.cobranca_modo = r.cobranca_modo; }
  if (r.cobranca_max_dia !== undefined) out.cobranca_max_dia = Math.round(num(r.cobranca_max_dia, 0, 200));
  if (r.cobranca_max_tentativas !== undefined) out.cobranca_max_tentativas = Math.round(num(r.cobranca_max_tentativas, 1, 20));
  if (r.cobranca_dias_entre !== undefined) out.cobranca_dias_entre = Math.round(num(r.cobranca_dias_entre, 1, 120));
  if (out.gmv_auto !== undefined && out.gmv_manual !== undefined && out.gmv_manual > out.gmv_auto) throw new Error('gmv_manual nao pode ser maior que gmv_auto');
  if (!Object.keys(out).length) throw new Error('nada para alterar');
  return [{ json: { acao, marca, autor, regra: out } }];
}
throw new Error('acao desconhecida');
