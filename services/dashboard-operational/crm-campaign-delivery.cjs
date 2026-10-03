'use strict';
// Dormant BFF component: no routes, credentials, URLs, timers or startup I/O.
// authorize is a PRIVATE synchronous adapter, never a browser capability claim.
// It must check session, exact Origin/CSRF, Growth edit grant, the person's
// separately attested campaign writer and unresolved draft attempts. transport
// must retain the existing fixed origin, credential slot, limits and deadlines.
// The managed read issuer's `submission` capability never authorizes `submit`.
const crypto = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9_-]{16,100}$/;
const VERSION = /^[0-9a-fA-F]{32}$/;
const MAC = /^[0-9a-f]{64}$/;
const CAPS = new Set(['read_content', 'draft', 'validate', 'submit']);
const STATES = new Set(['draft', 'scheduled', 'running', 'paused', 'finished', 'cancelled']);
const MAX_RESPONSE = 4 * 1024 * 1024;
const messages = Object.freeze({
  CAMPAIGN_DELIVERY_CONFIG: [500, 'Configuração de campanha indisponível.'],
  CAMPAIGN_DELIVERY_INPUT: [400, 'Solicitação de campanha inválida.'],
  CAMPAIGN_EDIT_DENIED: [403, 'Este acesso não permite editar campanhas.'],
  CAMPAIGN_DELIVERY_CONFLICT: [409, 'Esta tentativa já está vinculada a outro conteúdo ou acesso.'],
  CAMPAIGN_DELIVERY_PENDING: [409, 'Conclua a consulta da tentativa anterior antes de criar outra.'],
  CAMPAIGN_DELIVERY_UNKNOWN: [404, 'Tentativa não encontrada neste acesso.'],
  CAMPAIGN_DELIVERY_TRANSACTION: [409, 'Conclua a transação local antes de consultar a origem.']
});
class CampaignDeliveryError extends Error {
  constructor(code) { const [status, message] = messages[code]; super(message); this.name = 'CampaignDeliveryError'; this.code = code; this.status = status; }
}
const fail = code => { throw new CampaignDeliveryError(code); };
const closedError = error => { if (error instanceof CampaignDeliveryError) throw error; fail('CAMPAIGN_DELIVERY_CONFIG'); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
  const d = Object.getOwnPropertyDescriptor(value, key); return d?.enumerable === true && Object.hasOwn(d, 'value');
});
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : plain(value) ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
const sha = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isSafeInteger(Date.parse(value));
const result = (state, campaign = null) => Object.freeze({ state, campaign });
const pending = () => result('pending');
function selector(input) {
  if (!exact(input, ['brand', 'idempotency_key']) || !['fish', 'aristo'].includes(input.brand) || typeof input.idempotency_key !== 'string' || !KEY.test(input.idempotency_key)) fail('CAMPAIGN_DELIVERY_INPUT');
  return input;
}
function command(input) {
  const schedule = input?.acao === 'campanha_agendar';
  const validate = input?.acao === 'campanha_validar';
  const save = input?.acao === 'campanha_salvar';
  const fields = ['acao', 'brand', 'id', 'expected_version', 'idempotency_key', ...(validate || save ? [] : ['confirm']), ...(schedule ? ['audience_review_id'] : []), ...(save ? ['definition'] : [])];
  if (!exact(input, fields) || !['campanha_salvar', 'campanha_validar', 'campanha_agendar', 'campanha_cancelar'].includes(input.acao)) fail('CAMPAIGN_DELIVERY_INPUT');
  selector({ brand: input.brand, idempotency_key: input.idempotency_key });
  if (!positive(input.id) || typeof input.expected_version !== 'string' || !VERSION.test(input.expected_version) || !validate && !save && input.confirm !== (schedule ? 'agendar' : 'cancelar') || schedule && (typeof input.audience_review_id !== 'string' || !UUID.test(input.audience_review_id)) || save && (!plain(input.definition) || input.definition.brand !== input.brand || Buffer.byteLength(JSON.stringify(input)) > 256 * 1024)) fail('CAMPAIGN_DELIVERY_INPUT');
  return Object.freeze({ ...input });
}
function campaign(value, row) {
  if (!exact(value, ['id', 'version', 'status', 'sent', 'started_at', 'send_at', 'definition']) || value.id !== row.campaign_id || !VERSION.test(value.version || '') || !STATES.has(value.status) || !Number.isSafeInteger(value.sent) || value.sent < 0 || value.started_at !== null && !date(value.started_at) || value.send_at !== null && !date(value.send_at) || !plain(value.definition) || value.definition.brand !== row.brand) return null;
  return Object.freeze({ id: value.id, version: value.version, status: value.status, sent: value.sent, startedAt: value.started_at, sendAt: value.send_at });
}
function envelope(value) {
  if (!exact(value, ['status', 'body']) || !Number.isSafeInteger(value.status) || value.status < 100 || value.status > 599 || !plain(value.body)) return false;
  try { return Buffer.byteLength(JSON.stringify(value.body)) <= MAX_RESPONSE; } catch { return false; }
}
function audience(value, row, c, reviewOnly = false) {
  const counts = ['eligible_count', 'unique_members_count', 'excluded_blocklisted_count', 'excluded_subscription_count', 'native_disabled_count'];
  if (!exact(value, ['policy', 'brand', 'list_ids', ...counts, 'review_id', 'campaign_id', 'campaign_version', 'frozen', 'checked_at', 'expires_at', ...(reviewOnly ? [] : ['rechecked_at'])]) || value.policy !== 'listmonk-6.1-regular-v1' || value.brand !== row.brand || !UUID.test(value.review_id || '') || !reviewOnly && value.review_id !== row.audience_review_id || value.campaign_id !== row.campaign_id || value.campaign_version !== row.expected_version || value.frozen !== false || !Array.isArray(value.list_ids) || value.list_ids.length < 1 || value.list_ids.length > 30 || !value.list_ids.every(positive) || new Set(value.list_ids).size !== value.list_ids.length || JSON.stringify(value.list_ids) !== JSON.stringify(c.definition.list_ids) || counts.some(k => !Number.isSafeInteger(value[k]) || value[k] < 0) || !reviewOnly && (value.native_disabled_count !== 0 || value.eligible_count === 0) || value.native_disabled_count > value.eligible_count || value.unique_members_count !== value.eligible_count + value.excluded_blocklisted_count + value.excluded_subscription_count || !['checked_at', 'expires_at', ...(reviewOnly ? [] : ['rechecked_at'])].every(k => date(value[k]))) return false;
  const checked = Date.parse(value.checked_at), expires = Date.parse(value.expires_at), rechecked = Date.parse(value.rechecked_at);
  // Evaluate freshness at the historical atomic effect, not the poll time.
  return expires - checked === 300000 && (reviewOnly || rechecked >= checked && rechecked < expires && Date.parse(row.send_at) >= rechecked + 15 * 60000);
}
function createCampaignDelivery({ db, authorize, transport, now = Date.now, encrypt, decrypt, prepareDefinition, hasOpenCreate = () => false }) {
  try {
    if (!db || typeof db.isTransaction !== 'boolean' || ![authorize, transport, now].every(fn => typeof fn === 'function')) fail('CAMPAIGN_DELIVERY_CONFIG');
    if (db.isTransaction) fail('CAMPAIGN_DELIVERY_TRANSACTION');
  } catch (error) { closedError(error); }
  try { db.exec(`CREATE TABLE IF NOT EXISTS crm_campaign_delivery_v1 (
    user_id TEXT NOT NULL,client_key TEXT NOT NULL,remote_key TEXT NOT NULL UNIQUE,
    brand TEXT NOT NULL CHECK(brand IN ('fish','aristo')),action TEXT NOT NULL CHECK(action IN ('salvar','validar','agendar','cancelar')),
    campaign_id INTEGER NOT NULL CHECK(campaign_id>0),expected_version TEXT NOT NULL,audience_review_id TEXT,
    payload_sha256 TEXT NOT NULL,credential_mac TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('queued','uncertain','confirmed','succeeded','rejected')),
    send_at TEXT,remote_operation_id TEXT,receipt_sha256 TEXT,receipt_state TEXT,definition_ciphertext TEXT,definition_sha256 TEXT,
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,client_key));
    CREATE UNIQUE INDEX IF NOT EXISTS crm_campaign_delivery_open_v1 ON crm_campaign_delivery_v1(user_id,brand)
      WHERE phase IN ('queued','uncertain','confirmed');`); } catch (error) { closedError(error); }
  const active = new Map();
  const clock = () => { const t = now(); if (!Number.isSafeInteger(t) || t < 0) fail('CAMPAIGN_DELIVERY_CONFIG'); return t; };
  const outside = () => { if (db.isTransaction) fail('CAMPAIGN_DELIVERY_TRANSACTION'); };
  const atomic = fn => { outside(); db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } };
  const identity = (context, request) => {
    let a;
    try {
      a = authorize(context, Object.freeze({ brand: request.brand, action: request.action || request.acao.replace('campanha_', '') }));
      // Normal Promise/thenable adapters are refused and their rejection observed.
      // Private callbacks are trusted code, not an arbitrary-code sandbox.
      if (a && typeof a.then === 'function') { Promise.resolve(a).catch(() => {}); fail('CAMPAIGN_EDIT_DENIED'); }
      if (!exact(a, ['userId', 'role', 'slot', 'canEdit', 'credentialMac', 'caps']) || !UUID.test(a.userId || '') || !['manager', 'superadmin'].includes(a.role) || a.slot !== 'growth-campaign' || a.canEdit !== true || !MAC.test(a.credentialMac || '') || !Array.isArray(a.caps) || a.caps.length !== CAPS.size || new Set(a.caps).size !== a.caps.length || !a.caps.every(cap => CAPS.has(cap))) fail('CAMPAIGN_EDIT_DENIED');
    } catch { fail('CAMPAIGN_EDIT_DENIED'); }
    return a;
  };
  const get = (user, key) => db.prepare('SELECT * FROM crm_campaign_delivery_v1 WHERE user_id=? AND client_key=?').get(user, key);
  const same = (context, row) => { const a = identity(context, row); if (a.userId !== row.user_id || a.credentialMac !== row.credential_mac) fail('CAMPAIGN_EDIT_DENIED'); return a; };
  const select = (context, input) => {
    outside(); selector(input); const a = identity(context, { brand: input.brand, action: 'operacao' });
    const row = get(a.userId, input.idempotency_key); if (!row || row.brand !== input.brand) fail('CAMPAIGN_DELIVERY_UNKNOWN'); same(context, row); return row;
  };
  const definition = row => {
    if(typeof decrypt!=='function')fail('CAMPAIGN_DELIVERY_CONFIG');
    let d;try{d=JSON.parse(decrypt(row.definition_ciphertext));}catch{fail('CAMPAIGN_DELIVERY_CONFIG');}
    const original={acao:'campanha_salvar',brand:row.brand,id:row.campaign_id,expected_version:row.expected_version,idempotency_key:row.client_key,definition:d};
    if(!plain(d)||sha(original)!==row.payload_sha256)fail('CAMPAIGN_DELIVERY_CONFIG');return d;
  };
  const wire = row => Object.freeze({ acao: 'campanha_' + row.action, brand: row.brand, id: row.campaign_id, expected_version: row.expected_version, idempotency_key: row.remote_key, ...(['salvar','validar'].includes(row.action) ? {} : { confirm: row.action }), ...(row.action === 'agendar' ? { audience_review_id: row.audience_review_id } : {}), ...(row.action==='salvar'?{definition:definition(row)}:{}) });
  async function call(context, row, method, request) {
    same(context, row); outside(); let value;
    try { value = await transport(context, Object.freeze({ method, command: request })); }
    catch { outside(); same(context, row); return null; }
    outside(); same(context, row); return envelope(value) ? value : null;
  }
  async function current(context, row) {
    const r = await call(context, row, 'GET', Object.freeze({ acao: 'campanha_obter', brand: row.brand, id: row.campaign_id }));
    if (r?.status !== 200 || !exact(r.body, ['campaign'])) return null;
    return campaign(r.body.campaign, row);
  }
  function receipt(value, row) {
    if (!exact(value, ['id', 'operation_key', 'brand', 'action', 'state', 'providerId', 'response', 'created_at', 'updated_at']) || !UUID.test(value.id || '') || value.operation_key !== row.remote_key || value.brand !== row.brand || value.action !== row.action || !['pending', 'succeeded', 'rejected', 'outcome_unknown'].includes(value.state) || value.providerId !== null && value.providerId !== row.campaign_id || !date(value.created_at) || !date(value.updated_at) || Date.parse(value.created_at) < row.created_at - 30000 || Date.parse(value.updated_at) < Date.parse(value.created_at) || Date.parse(value.updated_at) > clock() + 30000 || row.remote_operation_id && row.remote_operation_id !== value.id) return null;
    if (value.state === 'pending') return value.response === null ? { state: 'pending', id: value.id, hash: null } : null;
    if (!envelope(value.response)) return null;
    const body = value.response.body;
    if (value.state === 'succeeded') {
      const fields = row.action === 'validar' ? ['campaign', 'validation', 'tracking'] : ['campaign', 'operation_id', ...(row.action === 'agendar' ? ['audience'] : row.action === 'salvar' ? ['tracking'] : [])];
      if (value.providerId !== row.campaign_id || value.response.status !== 200 || !exact(body, fields) || row.action !== 'validar' && body.operation_id !== value.id) return null;
      const c = campaign(body.campaign, row);
      // These gates describe the historical effect, not today's worker state.
      if (!c || c.status !== ({salvar:'draft',validar:'draft',agendar:'scheduled',cancelar:'cancelled'}[row.action]) || c.sent !== 0 || c.startedAt !== null || c.sendAt !== row.send_at || (row.action === 'validar' ? c.version !== row.expected_version : c.version === row.expected_version)) return null;
      if(row.action==='salvar'&&(row.definition_sha256!==sha(body.campaign.definition)||!exact(body.tracking,['policy','term','list_ids','changed_links'])||body.tracking.policy!=='crm-campaign-v1'||typeof body.tracking.term!=='string'||body.tracking.term.length<1||body.tracking.term.length>200||!Number.isSafeInteger(body.tracking.changed_links)||body.tracking.changed_links<0||JSON.stringify(body.tracking.list_ids)!==JSON.stringify(body.campaign.definition.list_ids)))return null;
      if (row.action === 'agendar' && !audience(body.audience, row, body.campaign)) return null;
      if (row.action === 'validar' && (!exact(body.validation, ['policy','version','ok','validated_at','audience']) || body.validation.policy !== 'crm-campaign-v1' || body.validation.version !== row.expected_version || body.validation.ok !== true || !date(body.validation.validated_at) || body.validation.validated_at !== body.validation.audience?.checked_at || !audience(body.validation.audience, row, body.campaign, true) || !exact(body.tracking, ['policy','term','list_ids','changed_links']) || body.tracking.policy !== 'crm-campaign-v1' || typeof body.tracking.term !== 'string' || body.tracking.term.length > 200 || body.tracking.term.length < 1 || !Number.isSafeInteger(body.tracking.changed_links) || body.tracking.changed_links < 0 || JSON.stringify(body.tracking.list_ids) !== JSON.stringify(body.campaign.definition.list_ids))) return null;
    } else {
      if (!exact(body, ['error', 'message', 'provider_id', 'operation_id']) || typeof body.error !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(body.error) || typeof body.message !== 'string' || body.message.length > 2000 || body.operation_id !== value.id || body.provider_id !== value.providerId || value.state === 'rejected' && !(value.response.status >= 400 && value.response.status <= 599 && body.error !== 'OUTCOME_UNKNOWN') || value.state === 'outcome_unknown' && (value.response.status !== 502 || body.error !== 'OUTCOME_UNKNOWN')) return null;
    }
    const hash = sha(value);
    if (row.receipt_sha256 && (row.receipt_sha256 !== hash || row.receipt_state !== value.state)) return null;
    return { state: value.state, id: value.id, hash };
  }
  async function reconcileRow(context, row) {
    const r = await call(context, row, 'GET', Object.freeze({ acao: 'campanha_operacao', brand: row.brand, idempotency_key: row.remote_key }));
    // A missing operation, error or timeout never proves the POST did not run.
    if (r?.status !== 200 || !exact(r.body, ['operation'])) return pending();
    const proof = receipt(r.body.operation, row); if (!proof) return pending();
    atomic(() => {
      same(context, row);
      db.prepare("UPDATE crm_campaign_delivery_v1 SET remote_operation_id=?,receipt_sha256=coalesce(receipt_sha256,?),receipt_state=coalesce(receipt_state,?),phase=CASE WHEN ?='succeeded' THEN CASE WHEN phase='succeeded' THEN phase ELSE 'confirmed' END WHEN ?='rejected' THEN 'rejected' ELSE phase END,updated_at=? WHERE user_id=? AND client_key=?")
        .run(proof.id, proof.hash, proof.hash ? proof.state : null, proof.state, proof.state, clock(), row.user_id, row.client_key);
    });
    if (proof.state === 'rejected') return result('rejected');
    if (proof.state !== 'succeeded') return pending();
    // A worker can legitimately change status/version after this receipt.
    // Always return a fresh safe projection; never call it "still scheduled".
    const c = await current(context, row); if (!c) return pending();
    atomic(() => { same(context, row); db.prepare("UPDATE crm_campaign_delivery_v1 SET phase='succeeded',updated_at=? WHERE user_id=? AND client_key=? AND phase IN ('confirmed','succeeded')").run(clock(), row.user_id, row.client_key); });
    if (row.action === 'validar') {
      const v = r.body.operation.response.body.validation;
      const usable = c.version === row.expected_version && c.status === 'draft' && c.sent === 0 && c.startedAt === null && Date.parse(v.audience.expires_at) > clock() && Date.parse(v.audience.checked_at) <= clock() + 30000;
      const projected = usable ? Object.freeze({policy:v.policy,version:v.version,ok:true,validatedAt:v.validated_at,audience:Object.freeze({...v.audience,list_ids:Object.freeze([...v.audience.list_ids])})}) : null;
      return Object.freeze({state:'succeeded',campaign:c,validation:projected});
    }
    return result('succeeded', c);
  }
  async function run(context, row) {
    if (row.phase === 'rejected' && row.remote_operation_id === null) { same(context, row); return result('rejected'); }
    if (row.phase !== 'queued') return reconcileRow(context, row);
    const c = await current(context, row); if (!c) return pending();
    const t = clock();let savedDefinition=null;
    if(row.action==='salvar'){
      const catalog=await call(context,row,'GET',Object.freeze({acao:'campanha_catalogo',brand:row.brand}));
      if(catalog?.status!==200)return pending();
      if(typeof prepareDefinition!=='function')fail('CAMPAIGN_DELIVERY_CONFIG');
      try{savedDefinition=prepareDefinition(definition(row),{catalog:catalog.body,id:row.campaign_id,now:t});if(savedDefinition&&typeof savedDefinition.then==='function'){Promise.resolve(savedDefinition).catch(()=>{});savedDefinition=null;}if(!plain(savedDefinition)||savedDefinition.brand!==row.brand||savedDefinition.send_at!==null&&!date(savedDefinition.send_at))savedDefinition=null;}catch{savedDefinition=null;}
    }
    const acceptable = c.version === row.expected_version && c.sent === 0 && c.startedAt === null && (['salvar','validar'].includes(row.action) ? c.status === 'draft'&&(row.action!=='salvar'||savedDefinition!==null) : c.sendAt !== null && (row.action === 'agendar' ? c.status === 'draft' && Date.parse(c.sendAt) >= t + 15 * 60000 : c.status === 'scheduled' && Date.parse(c.sendAt) > t));
    if (!acceptable) {
      // No POST was attempted: an authoritative preflight can close only queued.
      const closed = atomic(() => { same(context, row); return db.prepare("UPDATE crm_campaign_delivery_v1 SET phase='rejected',updated_at=? WHERE user_id=? AND client_key=? AND phase='queued'").run(t, row.user_id, row.client_key).changes === 1; });
      return closed ? result('rejected') : reconcileRow(context, get(row.user_id, row.client_key));
    }
    const claimed = atomic(() => {
      same(context, row);
      return db.prepare("UPDATE crm_campaign_delivery_v1 SET phase='uncertain',send_at=?,definition_sha256=?,updated_at=? WHERE user_id=? AND client_key=? AND phase='queued'").run(savedDefinition?savedDefinition.send_at:c.sendAt,savedDefinition?sha(savedDefinition):null, t, row.user_id, row.client_key).changes === 1;
    });
    row = get(row.user_id, row.client_key);
    if (!claimed) return reconcileRow(context, row);
    // Persisted before invoking the transport. Crashes/lost ACKs never retry POST.
    const sent = await call(context, row, 'POST', wire(row));
    return sent ? reconcileRow(context, row) : pending();
  }
  function coalesce(context, row) {
    const key = row.user_id + ':' + row.client_key;
    if (active.has(key)) return active.get(key);
    const promise = run(context, row).finally(() => active.delete(key)); active.set(key, promise); return promise;
  }
  async function submit(context, input) {
    outside(); const q = command(input), a = identity(context, q), fingerprint = sha(q), t = clock();
    let cipher=null;
    if(q.acao==='campanha_salvar'){
      if(![encrypt,decrypt,prepareDefinition].every(f=>typeof f==='function'))fail('CAMPAIGN_DELIVERY_CONFIG');
      cipher=encrypt(JSON.stringify(q.definition));if(typeof cipher!=='string'||!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cipher))fail('CAMPAIGN_DELIVERY_CONFIG');
    }
    const row = atomic(() => {
      const prior = get(a.userId, q.idempotency_key);
      if (prior) {
        if (prior.payload_sha256 !== fingerprint || prior.credential_mac !== a.credentialMac) fail('CAMPAIGN_DELIVERY_CONFLICT'); return prior;
      }
      const createOpen=hasOpenCreate(a.userId,q.brand);if(createOpen&&typeof createOpen.then==='function'){Promise.resolve(createOpen).catch(()=>{});fail('CAMPAIGN_DELIVERY_CONFIG');}if(typeof createOpen!=='boolean')fail('CAMPAIGN_DELIVERY_CONFIG');if(createOpen)fail('CAMPAIGN_DELIVERY_PENDING');
      if (db.prepare("SELECT 1 FROM crm_campaign_delivery_v1 WHERE user_id=? AND brand=? AND phase IN ('queued','uncertain','confirmed')").get(a.userId, q.brand)) fail('CAMPAIGN_DELIVERY_PENDING');
      db.prepare("INSERT INTO crm_campaign_delivery_v1(user_id,client_key,remote_key,brand,action,campaign_id,expected_version,audience_review_id,payload_sha256,credential_mac,phase,created_at,updated_at,definition_ciphertext) VALUES(?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)")
        .run(a.userId, q.idempotency_key, 'bff-' + crypto.randomBytes(32).toString('hex'), q.brand, q.acao.replace('campanha_', ''), q.id, q.expected_version, q.audience_review_id ?? null, fingerprint, a.credentialMac, t, t,cipher);
      return get(a.userId, q.idempotency_key);
    });
    return coalesce(context, row);
  }
  async function reconcile(context, input) { return coalesce(context, select(context, input)); }
  return Object.freeze({
    submit: async (context, input) => { try { return await submit(context, input); } catch (error) { closedError(error); } },
    reconcile: async (context, input) => { try { return await reconcile(context, input); } catch (error) { closedError(error); } },
    describe: (context,input) => {try{const row=select(context,input);return Object.freeze({action:'campanha_'+row.action});}catch(error){closedError(error);}}
  });
}
module.exports = { createCampaignDelivery, CampaignDeliveryError };
