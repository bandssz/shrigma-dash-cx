/* Local manual-review fence. This is not TikTok/server idempotency.
 * Keep every reservation: an absent/failed receipt does not prove no effect.
 * No credentials, author or complete request may enter this journal.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TTSActionJournal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PREFIX = 'shrigma_tts_manual_v1:';
  const unavailable = 'A decisão manual exige armazenamento local e proteção entre abas neste navegador. A consulta continua disponível.';
  const unknown = 'Resultado sem confirmação. Não repita nem troque a decisão; peça ao integrador para conferir esta amostra.';
  const error = (code, message) => Object.assign(new Error(message), {code});
  function identity(input) {
    if (!input || !['fish','aristo'].includes(input.brand) || !/^[0-9]{1,80}$/.test(String(input.application_id || ''))) throw error('TTS_INVALID_IDENTITY','Identidade da amostra inválida. Recarregue a fila.');
    return {brand:input.brand, application_id:String(input.application_id).replace(/^0+(?=\d)/,'')};
  }
  function create(options) {
    const {storage, locks, endpoint} = options || {};
    let endpointValid = false;
    try { const u = new URL(endpoint); endpointValid = u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash; } catch (_) {}
    const available = () => !!(endpointValid && storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' && locks && typeof locks.request === 'function');
    const slot = id => PREFIX + id.brand + ':' + id.application_id; // Deliberately independent of endpoint, result and access key.
    function read(id) {
      let raw;
      try { raw = storage.getItem(slot(id)); } catch (_) { throw error('TTS_JOURNAL_UNAVAILABLE',unavailable); }
      if (raw === null) return null;
      try {
        const j = JSON.parse(raw);
        if (!j || j.version !== 1 || j.brand !== id.brand || j.application_id !== id.application_id || !['APPROVE','REJECT'].includes(j.result) || !['pending','unknown','confirmed'].includes(j.state) || typeof j.endpoint !== 'string') throw Error();
        return j;
      } catch (_) { throw error('TTS_JOURNAL_INVALID','O registro local desta amostra precisa de conferência pelo integrador. Não repita a decisão.'); }
    }
    function persist(id, value) {
      const raw = JSON.stringify(value);
      try { storage.setItem(slot(id),raw); if (storage.getItem(slot(id)) !== raw) throw Error(); }
      catch (_) { throw error('TTS_JOURNAL_UNAVAILABLE',unavailable); }
    }
    function inspect(input) {
      try {
        const id = identity(input);
        if (!available()) return {state:'blocked',message:unavailable};
        return read(id);
      } catch (e) { return {state:'blocked',message:e.message}; }
    }
    async function run(input, transport) {
      const id = identity(input);
      if (!['APPROVE','REJECT'].includes(input.result) || typeof transport !== 'function') throw error('TTS_INVALID_ACTION','Decisão inválida. Recarregue a fila.');
      if (!available()) throw error('TTS_WRITE_UNAVAILABLE',unavailable);
      return locks.request(slot(id),{mode:'exclusive',ifAvailable:true},async lock => {
        if (!lock) throw error('TTS_OUTCOME_UNKNOWN','Esta amostra está sendo conferida em outra aba. Não repita a decisão.');
        const previous = read(id);
        if (previous) throw error(previous.state === 'confirmed' ? 'TTS_DECISION_RECORDED' : 'TTS_OUTCOME_UNKNOWN',previous.state === 'confirmed' ? 'Esta amostra já tem uma decisão registrada neste navegador. Confira o resultado na fila.' : unknown);
        const reservation = {version:1,...id,result:input.result,endpoint,state:'pending'};
        persist(id,reservation); // Required, with readback, before invoking any transport.
        try {
          const response = await transport();
          const body = response?.body, row = Array.isArray(body?.linhas) && body.linhas.length === 1 ? body.linhas[0] : null;
          const approved = input.result === 'APPROVE';
          if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300 || body?.ok !== true || !row || String(row.application_id) !== id.application_id || row.status !== (approved ? 'AWAITING_SHIPMENT' : 'REJECT_CANCELLED') || row.decisao !== (approved ? 'manual_aprovada' : 'manual_rejeitada')) throw Error('unconfirmed');
          persist(id,{...reservation,state:'confirmed'});
          return body;
        } catch (_) {
          // If updating fails, the durable pending reservation still blocks reload/retry.
          try { persist(id,{...reservation,state:'unknown'}); } catch (_) {}
          throw error('TTS_OUTCOME_UNKNOWN',unknown);
        }
      });
    }
    return Object.freeze({available,inspect,run});
  }
  return Object.freeze({create,PREFIX});
});
