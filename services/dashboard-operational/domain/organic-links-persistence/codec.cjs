'use strict';
// C2 · organic-links-persistence · codec puro: regras de negócio do link UTM, montagem da URL no backend,
// hash do intento ORIGINAL, recibo determinístico, projeção pública e envelope de operação 1.0.2.
// Sem I/O, relógio, aleatoriedade ou geração de ID. Regras herdadas do legado (n8n/organico/links-utm.sql, conferido
// por Root) com endurecimento: credenciais, host parcial, fragmento, forma não canônica e UTM existente são recusados.
const crypto = require('node:crypto');

const BRANDS = Object.freeze({
  aristo: Object.freeze(['oaristocrata.com', 'www.oaristocrata.com']),
  fish: Object.freeze(['fishermans.com.br', 'www.fishermans.com.br'])
  // olivas: sem host admitido -> não habilitada.
});
const ORIGINS = Object.freeze(['instagram_social', 'facebook_social', 'tiktok_social', 'youtube', 'whatsapp']);
const SURFACES = Object.freeze(['story', 'linktree', 'dm', 'feed', 'reels', 'comunidade', 'direct', 'grupo']);
const CAMPAIGN_RE = /^[A-Za-z0-9_-]{2,60}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_DESTINATION = 2000;

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
function persistableId(v) { return typeof v === 'string' && ID_RE.test(v); }
function realRevision(v) { return Number.isSafeInteger(v) && v >= 1 && v <= 2147483647; }

// Data civil real AAAA-MM-DD (sem relógio atual).
function validDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const y = Number(v.slice(0, 4)), m = Number(v.slice(5, 7)), d = Number(v.slice(8, 10));
  if (y < 2000 || y > 2099 || m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Destino: https, host EXATO da marca, sem credencial/porta/fragmento/UTM/controle, forma canônica WHATWG.
function checkDestination(brand, destination) {
  if (typeof destination !== 'string' || destination.length < 9 || destination.length > MAX_DESTINATION) return 'destination_invalid';
  if (/[\u0000- \u007f-\u009f\\"'<>`{}|^]/.test(destination)) return 'destination_invalid';
  if (destination.includes('#')) return 'destination_invalid';
  let u;
  try { u = new URL(destination); } catch (_) { return 'destination_invalid'; }
  if (u.protocol !== 'https:') return 'destination_invalid';
  if (u.username !== '' || u.password !== '' || destination.slice(8).split('/')[0].includes('@')) return 'destination_credentials';
  if (u.port !== '') return 'destination_host_not_admitted';
  if (!BRANDS[brand].includes(u.hostname)) return 'destination_host_not_admitted';
  if (u.href !== destination) return 'destination_not_canonical';
  if (destination.endsWith('?') || destination.includes('?&') || destination.includes('&&') || destination.endsWith('&')) return 'destination_not_canonical';
  for (const key of u.searchParams.keys()) if (/^utm_/i.test(key)) return 'destination_has_utm';
  if (/[?&]utm_/i.test(destination) || /%75%74%6d|utm%5f/i.test(destination)) return 'destination_has_utm';
  return null;
}

// Monta o link no backend: utm_campaign = AAAAMMDD_campanha com data; só campanha sem data. Valores de lista
// fechada/regex; encodeURIComponent mantém a regra mesmo se as listas mudarem.
function buildLink(input) {
  if (!isObj(input)) return { ok: false, reason: 'intent_invalid' };
  const { brand, destination, origin, surface, campaign, date } = input;
  if (typeof brand !== 'string' || !own(BRANDS, brand)) return { ok: false, reason: 'brand_not_admitted' };
  const bad = checkDestination(brand, destination);
  if (bad) return { ok: false, reason: bad };
  if (!ORIGINS.includes(origin)) return { ok: false, reason: 'origin_invalid' };
  if (!SURFACES.includes(surface)) return { ok: false, reason: 'surface_invalid' };
  if (typeof campaign !== 'string' || !CAMPAIGN_RE.test(campaign)) return { ok: false, reason: 'campaign_invalid' };
  if (!(date === null || validDate(date))) return { ok: false, reason: 'date_invalid' };
  const utmCampaign = date === null ? campaign : date.replace(/-/g, '') + '_' + campaign;
  const sep = new URL(destination).search === '' ? '?' : '&';
  const url = destination + sep + 'utm_source=' + encodeURIComponent(origin) + '&utm_medium=' + encodeURIComponent(surface) +
    '&utm_campaign=' + encodeURIComponent(utmCampaign);
  return { ok: true, value: { brand, destination, origin, surface, campaign, campaignDate: date, utmCampaign, url } };
}

// Intento ORIGINAL canônico (binding 1.0.2 + recordId alocado por Root na criação). Ordem de chaves fixa.
function canonicalIntent(x) {
  const p = x.kind === 'link.create'
    ? { campaign: x.payload.campaign, date: x.payload.date, destination: x.payload.destination, origin: x.payload.origin, surface: x.payload.surface }
    : {};
  return JSON.stringify({
    v: 'organic-links-intent-v1', kind: x.kind, effectiveBrand: x.effectiveBrand, recordId: x.recordId,
    expectedRecordRevision: x.kind === 'link.archive' ? x.expectedRecordRevision : null, payload: p
  });
}
function intentHash(x) { return sha256(canonicalIntent(x)); }

// Recibo determinístico da operação original (não é ID de recuperação: a recuperação usa o operationId original).
function receiptReference(op) {
  return 'olr1-' + sha256(['olr1', op.operationId, op.brand, op.kind, op.intentHash, op.outcome, op.reason || '', op.resultRevision == null ? '' : String(op.resultRevision)].join('|')).slice(0, 40);
}

// Projeção pública (sem ator, operação, cookie ou PII) no formato de link do contrato 1.0.2.
function publicLink(row) {
  if (!isObj(row)) return null;
  return {
    id: row.link_id, brandId: row.brand, destination: row.destination, url: row.url, origin: row.origin, surface: row.surface,
    campaign: row.campaign, date: row.campaign_date == null ? null : row.campaign_date, utmCampaign: row.utm_campaign,
    state: row.state, revision: row.revision, createdAt: row.created_at
  };
}

const PUBLIC_REASONS = Object.freeze([
  'store_disabled', 'dependency_missing', 'session_invalid', 'session_busy', 'session_poisoned', 'lease_not_held',
  'authority_denied', 'authority_unavailable', 'intent_invalid', 'operation_id_invalid', 'record_id_invalid',
  'brand_not_admitted', 'destination_invalid', 'destination_credentials', 'destination_host_not_admitted', 'destination_not_canonical',
  'destination_has_utm', 'origin_invalid', 'surface_invalid', 'campaign_invalid', 'date_invalid',
  'operation_id_reused', 'url_conflict_active', 'url_conflict_archived', 'record_id_conflict', 'record_not_found',
  'revision_conflict', 'already_archived', 'not_committed', 'commit_unacknowledged', 'storage_error', 'not_found'
]);

// Envelope de operação 1.0.2 (para o gateway de Root): binding = intento original; resultado só quando confirmado.
function toOperationEnvelope(result, contextRevision) {
  const states = { confirmed: 'confirmed', rejected: 'rejected', uncertain: 'uncertain' };
  if (!isObj(result) || !own(states, result.outcome) || !isObj(result.binding)) return null;
  return {
    operationId: result.operationId, contextRevision, state: states[result.outcome],
    binding: {
      effectiveBrand: result.binding.effectiveBrand, kind: result.binding.kind, recordId: result.binding.recordId,
      expectedRecordRevision: result.binding.expectedRecordRevision, payload: Object.assign({}, result.binding.payload)
    },
    receiptReference: result.outcome === 'uncertain' ? null : result.receiptReference,
    result: result.outcome === 'confirmed' ? result.link : null,
    reason: result.outcome === 'rejected' ? result.reason : (result.outcome === 'uncertain' ? 'Resultado não confirmado; consulte a operação original.' : null)
  };
}

module.exports = {
  BRANDS, ORIGINS, SURFACES, CAMPAIGN_RE, ID_RE, PUBLIC_REASONS,
  persistableId, realRevision, validDate, checkDestination, buildLink,
  canonicalIntent, intentHash, receiptReference, publicLink, toOperationEnvelope, sha256
};
