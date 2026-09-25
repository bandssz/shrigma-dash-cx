'use strict';
// Candidate only. Apply after every caller has migrated to the new header.
const {WORKFLOW_ID, EXPRESSION} = require('./sql-utility-parameters-patch.cjs');
function ensure(ok, message) { if (!ok) throw Error(message); }
function patchCredential(fresh, {expectedVersionId, credential, consumers} = {}) {
  ensure(fresh?.id === WORKFLOW_ID && expectedVersionId && fresh.versionId === expectedVersionId,
    'Fresh SQL utility identity and version required');
  ensure(fresh.activeVersionId === fresh.versionId, 'Unpublished utility changes must be resolved first');
  ensure(credential && /^[A-Za-z0-9_-]{1,128}$/.test(credential.id) &&
    typeof credential.name === 'string' && credential.name.trim().length > 0,
    'Existing n8n header credential reference required');
  ensure(consumers?.inventoryComplete === true && consumers?.cxDeveloperMigrated === true &&
    consumers?.tiktokProtectedEffectMigrated === true && consumers?.privateToolsMigrated === true &&
    consumers?.inactiveProbeRetired === true, 'Consumer migration is incomplete; keep current utility unchanged');
  ensure(Array.isArray(fresh.nodes) && fresh.nodes.length === 5, 'Utility topology changed');
  const w = structuredClone(fresh), byName = name => w.nodes.filter(n => n.name === name);
  const [hook] = byName('Webhook'), [gate] = byName('Chave confere?'), [sql] = byName('SQL'),
    [deny] = byName('Nega 401'), [respond] = byName('Responde');
  ensure(hook?.type === 'n8n-nodes-base.webhook' && hook.parameters?.httpMethod === 'POST' &&
    hook.parameters?.responseMode === 'responseNode' && !hook.credentials &&
    [undefined, 'none'].includes(hook.parameters.authentication), 'Existing POST webhook changed');
  ensure(gate?.type === 'n8n-nodes-base.if' && deny?.type === 'n8n-nodes-base.respondToWebhook' &&
    respond?.type === 'n8n-nodes-base.respondToWebhook', 'Existing auth/response nodes changed');
  const conditions = gate.parameters?.conditions;
  ensure(conditions?.combinator === 'and' && conditions.conditions?.length === 1 &&
    conditions.conditions[0].leftValue === '={{ $json.body.k }}' &&
    typeof conditions.conditions[0].rightValue === 'string' &&
    conditions.conditions[0].rightValue.length > 0 && !conditions.conditions[0].rightValue.startsWith('=') &&
    conditions.conditions[0].operator?.type === 'string' &&
    conditions.conditions[0].operator?.operation === 'equals', 'Existing body-key gate changed');
  ensure(sql?.type === 'n8n-nodes-base.postgres' && sql.typeVersion === 2.6 &&
    sql.parameters?.operation === 'executeQuery' && sql.parameters.query === '={{ $json.body.q }}' &&
    sql.parameters.options?.queryReplacement === EXPRESSION && sql.credentials?.postgres?.id,
    'Native SQL and arguments contract changed');
  const edge = name => ({node: name, type: 'main', index: 0});
  const expected = {Webhook:{main:[[edge('Chave confere?')]]},
    'Chave confere?':{main:[[edge('SQL')],[edge('Nega 401')]]},SQL:{main:[[edge('Responde')]]}};
  // Ignore object key order, but reject every unexpected path or extra branch.
  ensure(Object.keys(w.connections).length === Object.keys(expected).length &&
    Object.entries(expected).every(([name, value]) => JSON.stringify(w.connections[name]) === JSON.stringify(value)),
    'Utility routing changed');
  const oldSecret = conditions.conditions[0].rightValue;
  hook.parameters.authentication = 'headerAuth';
  hook.credentials = {httpHeaderAuth:{id:credential.id,name:credential.name}};
  w.nodes = w.nodes.filter(n => n !== gate && n !== deny);
  w.connections = {Webhook:{main:[[edge('SQL')]]}, SQL:{main:[[edge('Responde')]]}};
  w.settings = {...w.settings,saveDataSuccessExecution:'none',saveDataErrorExecution:'none',
    saveManualExecutions:false,saveExecutionProgress:false};
  // Only these fields are sent to n8n: metadata may contain historic versions.
  const payload = {name:w.name,nodes:w.nodes,connections:w.connections,settings:w.settings};
  ensure(!JSON.stringify(payload).includes(oldSecret), 'Legacy secret remains in candidate');
  return {payload,changes:['Webhook: n8n headerAuth credential','Remove plaintext body-key gate',
    'Do not retain execution payloads'],requiresPublishedReadback:true};
}
module.exports = {patchCredential};
