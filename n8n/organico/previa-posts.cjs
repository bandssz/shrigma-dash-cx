'use strict';
// Prévia dos posts no Orgânico (26/09/2026).
//
// O Post a post mostrava só a legenda. A Graph devolve a imagem da peça (`media_url`) e, em vídeo/reels,
// a capa (`thumbnail_url`). As duas são URLs assinadas da CDN da Meta e EXPIRAM em alguns dias; por isso:
//   - um workflow próprio do Orgânico relê todas as peças orgânicas do Instagram uma vez por dia;
//   - a tabela guarda só a última URL válida por post, com `verificado_em` e `ok`;
//   - o cache do painel só publica URL verificada nas últimas 72 h; fora disso a tela mostra o marcador
//     "sem prévia" e o link para o post, nunca uma imagem quebrada.
// Não altera o coletor de posts, a API de leitura do CX nem `cx_social_coleta_saude`.
const NAME = 'Orgânico — Prévia dos posts (diário 05:55, Instagram)';
const POSTGRES = { id: 'uALf0AHnEuLCgOtx', name: 'Postgres account 2' };
const META = { id: '4GdnUtcDaMLS0am5', name: 'Meta WA — token permanente (Bearer)' };
const GRAPH = 'v22.0';
const LIMITE = 600;
const VALIDADE_H = 72;

const SQL = `-- Prévia (miniatura) de cada post orgânico do Instagram. Uma linha por post; a URL expira na CDN da Meta.
CREATE TABLE IF NOT EXISTS cx_social_post_midia (
  post_id       text PRIMARY KEY,
  marca         text NOT NULL,
  conta         text,
  tipo          text,
  previa_url    text,
  ok            boolean NOT NULL DEFAULT true,
  detalhe       text,
  verificado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cx_social_post_midia_verificado ON cx_social_post_midia (verificado_em);
COMMENT ON TABLE cx_social_post_midia IS 'Prévia do post (thumbnail_url de vídeo ou media_url de imagem/carrossel). URL assinada da Meta: expira; publicar só se verificada há menos de ${VALIDADE_H} h.';`;

const LISTA_SQL = `SELECT obj_id, marca, conta FROM cx_social_objetos
 WHERE rede='instagram' AND origem='organico' AND obj_id ~ '^[0-9]{5,30}$'
 ORDER BY criado_em DESC LIMIT ${LIMITE}`;

// Só aceita imagem servida pela CDN da Meta, por https. Qualquer outra coisa vira "sem prévia".
const HOST_OK = String.raw`^https:\/\/([a-z0-9-]+\.)*(cdninstagram\.com|fbcdn\.net)\/`;

function montaCode() {
  return `// Prévia do post → cx_social_post_midia. Erro da Meta marca ok=false e preserva a URL anterior,
// que deixa de ser publicada quando passa de ${VALIDADE_H} h.
const posts = $('Lista posts').all().map(x => x.json);
const resp = $input.all();
const q = v => v === null || v === undefined ? 'NULL' : "'" + String(v).split("'").join("''").slice(0, 2000) + "'";
const HOST = new RegExp(${JSON.stringify(HOST_OK)}, 'i');
const vals = [], falhas = [];
posts.forEach((p, i) => {
  const r = (resp[i] && resp[i].json) || {};
  if (r.error || !r.id) {
    const det = r.error ? '#' + (r.error.code || '') + ' ' + String(r.error.message || '').slice(0, 160) : 'resposta sem id';
    falhas.push(p.obj_id + ': ' + det);
    vals.push('(' + [q(p.obj_id), q(p.marca), q(p.conta), 'NULL', 'NULL', 'false', q(det)].join(',') + ')');
    return;
  }
  const tipo = String(r.media_type || '').toUpperCase() || null;
  const bruta = tipo === 'VIDEO' ? (r.thumbnail_url || null) : (r.media_url || r.thumbnail_url || null);
  const url = bruta && HOST.test(bruta) ? bruta : null;
  vals.push('(' + [q(p.obj_id), q(p.marca), q(p.conta), q(tipo), q(url), 'true', q(url ? 'prévia lida' : 'post sem imagem disponível na Graph')].join(',') + ')');
});
if (!vals.length) throw new Error('nenhum post para ler a prévia');
if (falhas.length === posts.length) throw new Error('prévia: todas as leituras falharam — ' + falhas.slice(0, 3).join(' | '));
const sql = \`INSERT INTO cx_social_post_midia (post_id,marca,conta,tipo,previa_url,ok,detalhe) VALUES \${vals.join(',')}
ON CONFLICT (post_id) DO UPDATE SET marca=EXCLUDED.marca, conta=EXCLUDED.conta,
  tipo=COALESCE(EXCLUDED.tipo, cx_social_post_midia.tipo),
  previa_url=CASE WHEN EXCLUDED.ok THEN EXCLUDED.previa_url ELSE cx_social_post_midia.previa_url END,
  ok=EXCLUDED.ok, detalhe=EXCLUDED.detalhe,
  verificado_em=CASE WHEN EXCLUDED.ok THEN now() ELSE cx_social_post_midia.verificado_em END;
SELECT \${vals.length - falhas.length} AS lidos, \${falhas.length} AS falhas\`;
return [{ json: { sql, lidos: vals.length - falhas.length, falhas: falhas.slice(0, 5), n_falhas: falhas.length } }];`;
}

function buildWorkflow({ webhookPath }) {
  if (!/^organico-previa-posts-[a-f0-9]{8,}$/.test(webhookPath || '')) throw Error('caminho do webhook invalido');
  const nodes = [
    { name: 'Diario 05:55', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0],
      parameters: { rule: { interval: [{ field: 'cronExpression', expression: '55 5 * * *' }] } } },
    { name: 'Forcar (GET)', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 200], webhookId: webhookPath,
      parameters: { path: webhookPath, options: {} } },
    { name: 'Lista posts', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [220, 100], credentials: { postgres: POSTGRES },
      parameters: { operation: 'executeQuery', query: LISTA_SQL, options: {} } },
    { name: 'Midia do post', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [440, 100], credentials: { httpHeaderAuth: META },
      parameters: { url: `=https://graph.facebook.com/${GRAPH}/{{ $json.obj_id }}`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
        sendQuery: true, queryParameters: { parameters: [{ name: 'fields', value: 'id,media_type,media_url,thumbnail_url' }] },
        options: { timeout: 25000, batching: { batch: { batchSize: 10, batchInterval: 400 } }, response: { response: { neverError: true } } } } },
    { name: 'Monta SQL', type: 'n8n-nodes-base.code', typeVersion: 2, position: [660, 100], parameters: { jsCode: montaCode() } },
    { name: 'Grava previa', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [880, 100], credentials: { postgres: POSTGRES },
      parameters: { operation: 'executeQuery', query: '={{ $json.sql }}', options: {} } },
  ];
  const connections = {
    'Diario 05:55': { main: [[{ node: 'Lista posts', type: 'main', index: 0 }]] },
    'Forcar (GET)': { main: [[{ node: 'Lista posts', type: 'main', index: 0 }]] },
    'Lista posts': { main: [[{ node: 'Midia do post', type: 'main', index: 0 }]] },
    'Midia do post': { main: [[{ node: 'Monta SQL', type: 'main', index: 0 }]] },
    'Monta SQL': { main: [[{ node: 'Grava previa', type: 'main', index: 0 }]] },
  };
  // O token de página nunca passa por aqui, mas a resposta da Graph não precisa ficar no histórico.
  return { name: NAME, nodes, connections, settings: { timezone: 'America/Sao_Paulo', executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all', callerPolicy: 'workflowsFromSameOwner' } };
}

// Cache do Orgânico: lê as prévias válidas e anexa em payload.cx_post_midia, sem mexer na API de leitura.
const CACHE_API = 'API de leitura (painel=organico)';
const CACHE_MONTA = 'Monta upsert';
const CACHE_PREVIA = 'Prévias dos posts';
const PREVIA_SQL = `SELECT COALESCE(json_agg(json_build_object('post_id',post_id,'tipo',tipo,'previa_url',previa_url) ORDER BY post_id),'[]'::json)::text AS midia
 FROM cx_social_post_midia WHERE ok AND previa_url IS NOT NULL AND verificado_em > now() - interval '${VALIDADE_H} hours'`;
const ANEXO = `// Prévias dos posts (cx_social_post_midia): só URL verificada nas últimas ${VALIDADE_H} h. Falha aqui não derruba o cache.
let midia = [];
try { const m = $('${CACHE_PREVIA}').first().json.midia; midia = Array.isArray(m) ? m : JSON.parse(m || '[]'); } catch (_) { midia = []; }
if (Array.isArray(midia)) payload.cx_post_midia = midia.filter(x => x && typeof x.post_id === 'string' && /^https:\\/\\//.test(String(x.previa_url || '')));
`;

function patchCache(wf) {
  const w = JSON.parse(JSON.stringify(wf));
  const api = w.nodes.find(n => n.name === CACHE_API), monta = w.nodes.find(n => n.name === CACHE_MONTA);
  if (!api || !monta) throw Error('cache do Orgânico sem os nós esperados');
  if (w.nodes.some(n => n.name === CACHE_PREVIA)) throw Error('cache já tem o nó de prévias');
  const code = monta.parameters.jsCode;
  const alvo = 'const r = $input.first().json;';
  const marca = 'let txt = JSON.stringify(payload);';
  if (!code.includes(alvo) || !code.includes(marca)) throw Error('Monta upsert mudou; revisar antes de aplicar');
  monta.parameters.jsCode = code.replace(alvo, `const r = $('${CACHE_API}').first().json;`).replace(marca, ANEXO + marca);
  const pg = w.nodes.find(n => n.type === 'n8n-nodes-base.postgres' && n.credentials && n.credentials.postgres);
  w.nodes.push({ name: CACHE_PREVIA, type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [api.position[0] + 110, api.position[1] + 180],
    credentials: { postgres: pg ? pg.credentials.postgres : POSTGRES }, alwaysOutputData: true, onError: 'continueRegularOutput',
    parameters: { operation: 'executeQuery', query: PREVIA_SQL, options: {} } });
  const saida = w.connections[CACHE_API];
  if (!saida || JSON.stringify(saida.main) !== JSON.stringify([[{ node: CACHE_MONTA, type: 'main', index: 0 }]])) throw Error('ligação API → Monta upsert inesperada');
  w.connections[CACHE_API] = { main: [[{ node: CACHE_PREVIA, type: 'main', index: 0 }]] };
  w.connections[CACHE_PREVIA] = { main: [[{ node: CACHE_MONTA, type: 'main', index: 0 }]] };
  return w;
}

module.exports = { NAME, SQL, LISTA_SQL, HOST_OK, VALIDADE_H, PREVIA_SQL, montaCode, buildWorkflow, patchCache, CACHE_PREVIA };
