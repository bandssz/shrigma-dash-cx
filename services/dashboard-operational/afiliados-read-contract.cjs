'use strict';
// Candidate projection of the observed original ZRPkPSaMRw35uZQj READ payload.
// Pure projection: no credential, SQL, transport, grant or production activation.
const BRANDS = new Set(['fish', 'aristo']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const fields = (text = '', metric = '', date = '', flag = '', texts = '') => Object.freeze(Object.fromEntries(
  [[text, 'text'], [metric, 'metric'], [date, 'date'], [flag, 'flag'], [texts, 'texts']].flatMap(([names, type]) => names.split(' ').filter(Boolean).map(name => [name, type]))
));
const FIELDS = Object.freeze({
  kpis: fields('', 'pedidos gmv comissao criadores pct_video pct_live'),
  amostras: fields('', 'total pendentes aguardando_envio em_transito_ou_conteudo completas venceu_sem_decisao aprovada_nao_enviada rejeitadas criador_nao_postou', 'pendente_mais_urgente'),
  fila: fields('application_id username nickname product_id product_title sku_id sku_name status fulfillment_status motivo_nao_aprovavel tier tier_sugerido decisao decisao_motivo', 'seguidores gmv_30d fulfillment_pct estoque_amostra commission_rate pedidos_90d gmv_90d_marca amostras_total amostras_completas', 'approve_expira_em envio_expira_em', 'is_approvable dry_run'),
  regra: fields('modo', '', 'atualizado_em'),
  envio: fields('application_id username product_title sku_name order_id', '', 'envio_expira_em'),
  criadores: fields('username nickname', 'seguidores gmv_30d fulfillment_pct pedidos gmv comissao pct_video amostras_total amostras_completas'),
  open: fields('colab_id product_id product_title product_status', 'comissao_pct inventario preco_min preco_max showcase_count content_creator_count'),
  target: fields('colab_id nome status', 'invited_count showcase_count content_creator_count product_count comissao_pct produtos_fora_do_ar', 'inicio_em fim_em', 'has_free_sample', 'produtos'),
  frescor: fields('erros', '', 'ultima_ok ultima', 'ultima_ok_todas'),
  autorizacao: fields('loja seller_name ultimo_erro_canal', '', 'autorizado_em refresh_expira_em', 'expira_em_breve', 'granted_scopes escopos_faltando'),
  escopos: fields('', '', 'verificado_em autorizado_em', 'conferido_apos_autorizar', 'mudou_desde_autorizacao aguardando_tiktok nao_medido'),
  serie: fields('', 'gmv pedidos', 'dia'),
  canal: fields('origem_estado origem_modelo', 'gmv gmv_live gmv_video gmv_vitrine gmv_afiliado gmv_proprio gmv_ads pedidos visitantes reembolso gmv_saldo_nao_afiliado gmv_ajuste_origem gmv_ajuste_origem_absoluto', 'dia'),
  canal_total: fields('origem_estado origem_modelo', 'dias gmv gmv_live gmv_video gmv_vitrine gmv_afiliado gmv_proprio gmv_ads pedidos visitantes reembolso pct_afiliado pct_live pct_video pct_vitrine pct_gmv_max conversao_pct ticket_medio gmv_saldo_nao_afiliado gmv_ajuste_origem gmv_ajuste_origem_absoluto origem_dias_divergentes origem_dias_indisponiveis', 'ultimo_dia'),
  lives: fields('live_id username origem titulo', 'duracao_min gmv gmv_24h pedidos pedidos_criados compradores espectadores cliques impressoes_produto ctr_pct clique_pedido_pct novos_seguidores', 'dia inicio_em fim_em atualizado_em'),
  live_produtos: fields('live_id product_id nome', 'gmv_direto pedidos pedidos_criados compradores impressoes cliques ctr_pct clique_pedido_pct gpm'),
  videos: fields('video_id username origem titulo', 'gmv gpm pedidos visualizacoes ctr_pct duracao_s', 'retrato_em publicado_em'),
  cobranca: fields('', 'enviadas falhas simuladas', 'ultima'),
  // Message bodies, provider errors and customer/contact details are not needed
  // to follow up the creator pipeline and do not leave this READ projection.
  cobranca_fila: fields('etapa username', 'tentativa', 'enviado_em', 'dry_run ok'),
  cobranca_regra: fields('cobranca_modo', 'cobranca_max_dia cobranca_max_tentativas cobranca_dias_entre'),
  cobranca_pendentes: fields('', 'pendentes'),
  cobranca_pulos: fields('etapa username motivo ultima_msg_de', 'tentativa nao_lidas', 'ultima_msg_em visto_em')
});
function refuse(code) { throw Object.assign(new Error(code), {code, status: 502}); }
function validDate(value) {
  return typeof value === 'string' && value.length <= 64 && /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value) && Number.isFinite(Date.parse(value));
}
function validDay(value) { return validDate(value) && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value).toISOString().slice(0, 10) === value; }
function valid(value, type) {
  if (value === null) return true;
  if (type === 'text') return typeof value === 'string' && value.length <= 4000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
  if (type === 'metric') return typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && /^-?\d{1,16}(?:\.\d{1,6})?$/.test(value);
  if (type === 'date') return validDate(value);
  if (type === 'flag') return typeof value === 'boolean';
  return type === 'texts' && Array.isArray(value) && value.length <= 500 && value.every(v => valid(v, 'text') && v !== null);
}
function project(payload, {brand, ini, fim, credential} = {}) {
  if (!BRANDS.has(brand)) refuse('AFFILIATE_BRAND_REQUIRED');
  if (!validDay(ini) || !validDay(fim) || ini > fim) refuse('AFFILIATE_WINDOW_REQUIRED');
  if (!plain(payload) || payload.error || payload.erro || !plain(payload.janela) || payload.janela.ini !== ini || payload.janela.fim !== fim) refuse('AFFILIATE_SOURCE_WINDOW_UNCONFIRMED');
  // This check consumes a private credential internally; it is never returned.
  if (typeof credential === 'string' && credential.length >= 8 && JSON.stringify(payload).includes(JSON.stringify(credential).slice(1, -1))) refuse('AFFILIATE_RESPONSE_CREDENTIAL_LEAK');
  const out = {brand, brands: [brand], brandAccess: 'single', janela: {ini, fim}};
  if (Object.hasOwn(payload, 'gerado_em')) {
    if (!validDate(payload.gerado_em)) refuse('AFFILIATE_SOURCE_TIME_INVALID');
    out.gerado_em = payload.gerado_em;
  }
  for (const [collection, definition] of Object.entries(FIELDS)) {
    // Missing remains missing. Do not manufacture an empty collection.
    if (!Object.hasOwn(payload, collection)) continue;
    const input = payload[collection];
    if (!Array.isArray(input) || input.length > 50000) refuse('AFFILIATE_SOURCE_COLLECTION_INVALID');
    out[collection] = [];
    for (const row of input) {
      if (!plain(row) || !BRANDS.has(row.marca) || Object.hasOwn(row, 'brand') && row.brand !== row.marca) refuse('AFFILIATE_SOURCE_BRAND_UNCONFIRMED');
      if (row.marca !== brand) continue;
      const result = {marca: brand};
      for (const [name, type] of Object.entries(definition)) if (Object.hasOwn(row, name)) {
        if (!valid(row[name], type)) refuse('AFFILIATE_SOURCE_FIELD_INVALID');
        // Collector error text can contain request details. Preserve the fact,
        // not an unrestricted provider message, in an analyst response.
        result[name] = ['erros', 'ultimo_erro_canal'].includes(name) && row[name]
          ? 'Falha de coleta registrada; detalhes disponíveis ao administrador.'
          : Array.isArray(row[name]) ? [...row[name]] : row[name];
      }
      out[collection].push(result);
    }
  }
  return out;
}
module.exports = {project, FIELDS};

