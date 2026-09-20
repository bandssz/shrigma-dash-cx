'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const H = require('../n8n/growth/whatsapp-flow-health.cjs');
const { PGlite } = require(process.env.CAMPAIGN_PGLITE_MODULE || '../../growth-test-tools/node_modules/@electric-sql/pglite');
const originalQuery = fs.readFileSync(path.join(__dirname, 'fixtures/whatsapp-flow-health-v1.sql'), 'utf8');
const decision = `const teste = $('Config').first().json.teste;
const r = $json;
if (!r.chave) return { ...r, disparar: false };
const seisH = 6 * 3600 * 1000;
const repetir = !r.alertado_em_antigo || (Date.now() - new Date(r.alertado_em_antigo).getTime()) > seisH;
const disparar = r.estado === 'alerta' && (r.estado_antigo !== 'alerta' || repetir) && !teste;
return { ...r, disparar };`;
const config = `const untouched = 'synthetic-only';\nconst sql = ${JSON.stringify(originalQuery)};\nreturn [{json:{sql,teste:false}}];`;
function workflow() {
  const nodes = [{ id: 'config', name: 'Config', type: 'n8n-nodes-base.code', parameters: { jsCode: config }, position: [1, 2] },
    { id: 'decision', name: 'Decide alerta', type: 'n8n-nodes-base.code', parameters: { jsCode: decision, mode: 'runOnceForEachItem' }, position: [3, 4] },
    { id: 'other', name: 'Unrelated', type: 'synthetic', parameters: { value: 'preserved' }, credentials: { synthetic: { id: 'synthetic-ref' } } }];
  const connections = { Config: { main: [[{ node: 'Unrelated', type: 'main', index: 0 }]] } };
  return { id: H.WORKFLOW_ID, versionId: 'reviewed-version', activeVersionId: 'reviewed-version', active: true,
    nodes, connections, settings: { executionOrder: 'v1' },
    activeVersion: { workflowId: H.WORKFLOW_ID, versionId: 'reviewed-version', nodes: structuredClone(nodes), connections: structuredClone(connections) } };
}
const expected = () => ({ versionId: 'reviewed-version', configSha256: H.sha256(config), decisionSha256: H.sha256(decision) });

test('fresh workflow patch changes only two Code sources, preserves active receipt and does not mutate input', () => {
  const before = workflow(), saved = structuredClone(before), result = H.patchWorkflow(before, expected());
  assert.deepEqual(before, saved);
  const candidate = structuredClone(result.workflow);
  for (let i = 0; i < 2; i++) candidate.nodes[i].parameters.jsCode = before.nodes[i].parameters.jsCode;
  assert.deepEqual(candidate, before);
  assert.deepEqual(result.workflow.activeVersion, before.activeVersion);
  assert.deepEqual(result.proof.changed.map(x => x.name), ['Config', 'Decide alerta']);
  assert.equal(result.proof.candidateActive, false); assert.equal(result.proof.runtimeWrites, 0);
  assert.equal(H.configQuery(result.workflow.nodes[0].parameters.jsCode).query, H.patchQuery(originalQuery));
});

test('version, active snapshot, source hashes, unexpected SQL and repeat application fail closed', () => {
  for (const change of [w => { w.versionId = 'other'; }, w => { w.active = false; },
    w => { delete w.activeVersion; }, w => { w.activeVersion.connections = {}; }]) {
    const w = workflow(); change(w); assert.throws(() => H.patchWorkflow(w, expected()), /HEALTH_/);
  }
  assert.throws(() => H.patchWorkflow(workflow(), { ...expected(), configSha256: '0'.repeat(64) }), /SOURCE_DRIFT/);
  assert.throws(() => H.patchQuery(originalQuery.replace("interval '75 minutes'", "interval '80 minutes'")), /SOURCE_DRIFT/);
  assert.throws(() => H.patchQuery(H.patchQuery(originalQuery)), /ALREADY_PATCHED/);
  assert.throws(() => H.patchConfig(config + '\nconst sql = "second";'), /SQL_LITERAL_REQUIRED/);
  assert.throws(() => H.patchDecision(decision.replace('&& !teste;', '&& false;')), /SOURCE_DRIFT/);
});

function decide(source, row, teste = false) {
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(function(){${source}\n})()`, { $json: row, $: () => ({ first: () => ({ json: { teste } }) }) })));
}
test('QA remains an alert in data but never creates an operational task; original production transition/cooldown/test guard stays', () => {
  const patched = H.patchDecision(decision);
  for (const brand of ['fish', 'aristo']) {
    const row = { chave: `qa:aceite:${brand}`, estado: 'alerta', estado_antigo: 'ok', n_falhas: 14 };
    const r = decide(patched, row); assert.equal(r.disparar, false); assert.equal(r.estado, 'alerta'); assert.equal(r.n_falhas, 14);
  }
  const rows = [{ chave: 'aceite:fish', estado: 'alerta', estado_antigo: 'ok' },
    { chave: 'gatilho:fish:pedido-pago', estado: 'alerta', estado_antigo: 'alerta', alertado_em_antigo: new Date().toISOString() },
    { chave: 'aceite:aristo', estado: 'alerta', estado_antigo: 'alerta', alertado_em_antigo: '2000-01-01T00:00:00Z' },
    { chave: 'aceite:fish', estado: 'desconhecido', estado_antigo: 'alerta' }, { chave: 'aceite:fish', estado: 'ok' }];
  for (const row of rows) for (const teste of [false, true]) assert.deepEqual(decide(patched, row, teste), decide(decision, row, teste));
  assert.equal(decide(patched, rows[0]).disparar, true);
});

async function database() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE shrigma_send_log(id serial PRIMARY KEY, brand text, channel text, flow text, piece text, ref text, sent_at timestamptz, wamid text);
    CREATE TABLE shrigma_wa_status(wamid text, status text, erro_code int);
    CREATE TABLE shrigma_wa_fluxo_saude(chave text PRIMARY KEY,brand text NOT NULL,nome text NOT NULL,verificado_em timestamptz NOT NULL,
      n_gatilho int,n_saida int,n_aceites int,n_status int,n_falhas int,estado text NOT NULL,motivo text,alerta_desde timestamptz,alertado_em timestamptz);`);
  return db;
}
async function add(db, { brand = 'fish', flow = 'transacional', accepted, failed = 0, noStatus = false, prefix = flow || 'unknown', age = '30 minutes' }) {
  await db.query(`INSERT INTO shrigma_send_log(brand,channel,flow,piece,ref,sent_at,wamid)
    SELECT $1,'whatsapp',$2,'synthetic-piece','synthetic-'||$3||i,now()-$4::interval,'synthetic-'||$3||i FROM generate_series(1,$5::integer)i`, [brand, flow, prefix, age, accepted]);
  if (!noStatus) await db.query(`INSERT INTO shrigma_wa_status SELECT 'synthetic-'||$1||i,
    CASE WHEN i<=$2::integer THEN 'failed' ELSE 'delivered' END,CASE WHEN i<=$2::integer THEN 131049 ELSE NULL END FROM generate_series(1,$3::integer)i`, [prefix, failed, accepted]);
}
const byKey = result => Object.fromEntries(result.rows.map(r => [r.chave, r]));

test('SQL reproduces mixed false production alert then separates QA without erasing real operational failures or raw history', async () => {
  const db = await database();
  try {
    await add(db, { flow: 'teste-motor', accepted: 37, failed: 14, prefix: 'qa-' });
    await add(db, { accepted: 2, prefix: 'paid-' });
    await add(db, { flow: 'carrinho', accepted: 5, prefix: 'cart-' });
    await add(db, { flow: 'mensagem-automatica', accepted: 1, prefix: 'auto-' });
    await add(db, { brand: 'aristo', accepted: 10, failed: 3, prefix: 'real-failure-' });
    const before = byKey(await db.query(originalQuery));
    assert.deepEqual([before['aceite:fish'].n_aceites, before['aceite:fish'].n_falhas, before['aceite:fish'].estado], [45, 14, 'alerta']);
    const raw = await db.query('SELECT (SELECT count(*) FROM shrigma_send_log) AS logs,(SELECT count(*) FROM shrigma_wa_status) AS statuses');
    const after = byKey(await db.query(H.patchQuery(originalQuery)));
    assert.deepEqual([after['aceite:fish'].n_aceites, after['aceite:fish'].n_status, after['aceite:fish'].n_falhas, after['aceite:fish'].estado], [8, 8, 0, 'ok']);
    assert.match(after['aceite:fish'].nome, /operacional \(exceto teste-motor\)/);
    assert.doesNotMatch(after['aceite:fish'].nome, /transacional/);
    assert.deepEqual([after['qa:aceite:fish'].n_aceites, after['qa:aceite:fish'].n_status, after['qa:aceite:fish'].n_falhas, after['qa:aceite:fish'].estado], [37, 37, 14, 'alerta']);
    assert.match(after['qa:aceite:fish'].motivo, /14 falhas.*QA identificado/);
    assert.equal(after['aceite:aristo'].estado, 'alerta'); assert.equal(after['aceite:aristo'].n_falhas, 3);
    assert.deepEqual(await db.query('SELECT (SELECT count(*) FROM shrigma_send_log) AS logs,(SELECT count(*) FROM shrigma_wa_status) AS statuses'), raw);
  } finally { await db.close(); }
});

test('SQL empty cohorts expire old aggregate alerts as unknown, never healthy or zero failed, without deleting historical records', async () => {
  const db = await database();
  try {
    await db.exec(`INSERT INTO shrigma_wa_fluxo_saude(chave,brand,nome,verificado_em,n_aceites,n_status,n_falhas,estado,motivo,alerta_desde,alertado_em)
      VALUES('qa:aceite:fish','fish','QA antigo',now()-interval '2 hours',20,20,8,'alerta','snapshot antigo',now()-interval '2 hours',now()-interval '1 hour');`);
    await add(db, { flow: 'teste-motor', accepted: 20, failed: 8, age: '3 hours' });
    const result = byKey(await db.query(H.patchQuery(originalQuery)));
    for (const row of Object.values(result)) {
      assert.equal(row.estado, 'desconhecido'); assert.equal(row.n_aceites, 0);
      assert.equal(row.n_status, null); assert.equal(row.n_falhas, null); assert.match(row.motivo, /entrega não avaliada/);
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM shrigma_send_log')).rows[0].n, 20);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM shrigma_wa_status WHERE status='failed'")).rows[0].n, 8);
    assert.equal(decide(H.patchDecision(decision), result['qa:aceite:fish']).disparar, false);
  } finally { await db.close(); }
});

test('SQL retains missing-status alert, exact QA marker, unknown flow and the original mature window/thresholds', async () => {
  const db = await database();
  try {
    await add(db, { flow: null, accepted: 5, noStatus: true, prefix: 'unclassified-' });
    await add(db, { flow: 'teste-motor-extra', accepted: 1, noStatus: true, prefix: 'not-exact-qa-' });
    await add(db, { flow: 'teste-motor', accepted: 5, noStatus: true, prefix: 'actual-qa-' });
    await add(db, { accepted: 50, failed: 50, age: '10 minutes', prefix: 'too-recent-' });
    await add(db, { accepted: 50, failed: 50, age: '90 minutes', prefix: 'too-old-' });
    const result = byKey(await db.query(H.patchQuery(originalQuery)));
    assert.deepEqual([result['aceite:fish'].n_aceites, result['aceite:fish'].n_status, result['aceite:fish'].estado], [6, 0, 'alerta']);
    assert.match(result['aceite:fish'].motivo, /flow não informado; modo de envio não inferido/);
    assert.deepEqual([result['qa:aceite:fish'].n_aceites, result['qa:aceite:fish'].n_status, result['qa:aceite:fish'].estado], [5, 0, 'alerta']);
    assert.match(result['qa:aceite:fish'].motivo, /nenhum status recebido/);
  } finally { await db.close(); }
});

test('trigger-to-WhatsApp monitor is unchanged and a QA row cannot satisfy the operational output guard', async () => {
  const db = await database();
  try {
    await db.exec(`INSERT INTO shrigma_send_log(brand,channel,flow,piece,ref,sent_at)
      SELECT 'fish','email','transacional','pedido-confirmado','synthetic-order-'||i,now()-interval '30 minutes' FROM generate_series(1,5)i;
      INSERT INTO shrigma_send_log(brand,channel,flow,piece,ref,sent_at,wamid)
      SELECT 'fish','whatsapp','teste-motor','pedido-pago','synthetic-order-'||i,now()-interval '30 minutes','synthetic-qa-trigger-'||i FROM generate_series(1,5)i;`);
    const before = byKey(await db.query(originalQuery))['gatilho:fish:pedido-pago'];
    const after = byKey(await db.query(H.patchQuery(originalQuery)))['gatilho:fish:pedido-pago'];
    for (const key of ['chave', 'nome', 'n_gatilho', 'n_saida', 'estado', 'motivo']) assert.equal(after[key], before[key]);
    assert.equal(after.n_gatilho, 5); assert.equal(after.n_saida, 0); assert.equal(after.estado, 'alerta');
    assert.equal(decide(H.patchDecision(decision), after).disparar, true);
  } finally { await db.close(); }
});

test('existing consumers show QA explicitly but never attach its alert to operational flow cards', () => {
  const GF = require('../growth-flows.js'), GUI = require('../growth-ui.js');
  const rows = [{ chave: 'aceite:fish', brand: 'fish', nome: 'Operacional', estado: 'ok', n_aceites: 8 },
    { chave: 'qa:aceite:fish', brand: 'fish', nome: 'QA (teste-motor)', estado: 'alerta', motivo: '14 falhas de QA', n_aceites: 37 },
    { chave: 'qa:aceite:aristo', brand: 'aristo', nome: 'QA (teste-motor)', estado: 'desconhecido', motivo: 'Sem amostra; entrega não avaliada' }];
  const api = { wa_fluxo_saude: rows, crm_wa_envios: [{ marca: 'fish', flow: 'transacional', piece: 'pedido-pago', dia: '2026-09-20', aceitos: 2 },
    { marca: 'fish', flow: 'teste-motor', piece: 'qa', dia: '2026-09-20', aceitos: 37 }] };
  const flows = GF.observados(api).fluxos;
  assert.equal(flows.length, 1); assert.equal(flows[0].flow, 'transacional');
  assert.deepEqual(flows[0].saude.map(r => r.chave), ['aceite:fish']);
  const element = { innerHTML: '', querySelectorAll: () => [] }, el = GUI.el;
  try {
    GUI.el = () => element;
    const alerts = GUI.flowHealth({ api, marca: 'fish' });
    assert.deepEqual(alerts.map(r => r.chave), ['qa:aceite:fish']);
    assert.match(element.innerHTML, /QA \(teste-motor\).*alerta/); assert.match(element.innerHTML, /14 falhas de QA/);
    GUI.flowHealth({ api, marca: 'aristo' });
    assert.match(element.innerHTML, /desconhecido/); assert.match(element.innerHTML, /entrega não avaliada/);
  } finally { GUI.el = el; }
});
