'use strict';
// Store real (sql.cjs + codec.cjs + store.cjs) contra o motor SINTÉTICO de duas sessões em RAM.
// Execução: CRM_C2_ORGANIC_LINKS_CONTEXT=<ROOT-WORK/20261006-r6/context/current/files> node --test tests/organic-links-persistence/
const test = require('node:test');
const { scenarios } = require('./scenarios.cjs');
const { createEngine } = require('./synthetic-sessions.cjs');
const { loadNormalizer } = require('./normalizer-context.cjs');

function syntheticEnv() {
  const N = loadNormalizer();
  const engine = createEngine();
  const tick = () => new Promise(r => setImmediate(r));
  return {
    N, engine,
    base: slot => engine.client(slot),
    idle: async () => { for (let i = 0; i < 20; i++) await tick(); },
    until: async pred => { for (let i = 0; i < 2000; i++) { if (pred()) return; await tick(); } throw new Error('condição sintética não atingida'); }
  };
}

for (const s of scenarios) test('sintético · ' + s.name, async () => { await s.run(syntheticEnv()); });
