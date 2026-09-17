const b = $json.body || {};
if (String(b.k || '') !== 'shrigma-tts-canal-7d2e') throw new Error('chave invalida');
// backfill: { "k": "...", "dias": 90 }  (dias de canal_dia e de lives para trás; vídeos são sempre o retrato de 30 dias)
return [{ json: { dias: b.dias || null } }];
