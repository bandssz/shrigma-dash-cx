const COLETA_CHAVE = '__SERVER_ONLY_TIKTOK_COLLECTION_KEY__';
if (COLETA_CHAVE.startsWith('__SERVER_ONLY_')) throw new Error('Configure a credencial no servidor antes de publicar este node.');
const b = $json.body || {};
if (String(b.k || '') !== COLETA_CHAVE) throw new Error('chave invalida');
// backfill: { "k": "...", "dias": 90 }  (dias de canal_dia e de lives para trás; vídeos são sempre o retrato de 30 dias)
return [{ json: { dias: b.dias || null } }];
