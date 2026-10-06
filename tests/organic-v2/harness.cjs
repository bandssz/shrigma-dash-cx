'use strict';
const path = require('node:path');
const { Document, setValue, submit, flush } = require('./fake-dom.cjs');
const { createGateway } = require('./synthetic-gateway.cjs');
const Organic = require(path.join(__dirname, '..', '..', 'ui', 'organic-v2', 'organic-v2.js'));

const PERIOD = { from: '2026-10-01', to: '2026-10-05' };

function setup(gwOptions, createOptions) {
  const doc = new Document();
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const g = createGateway(gwOptions);
  const gateway = createOptions && 'gateway' in createOptions ? createOptions.gateway : g.gateway;
  const inst = Organic.create({ element: host, document: doc, gateway });
  const q = s => host.querySelector(s);
  const qa = s => host.querySelectorAll(s);
  const text = s => { const el = s ? q(s) : host; return el ? el.textContent : null; };
  const section = r => q('[data-ov-section="' + r + '"]');
  const tags = r => section(r).querySelectorAll('[data-ov-tag]').map(t => t.getAttribute('data-ov-tag'));
  const state = r => section(r).getAttribute('data-ov-state');
  async function syncNow(filters) { const p = inst.sync({ filters: filters || { period: PERIOD } }); await flush(); await p; await flush(); }
  function draft(values) {
    for (const [k, v] of Object.entries(values)) setValue(q('[data-ov-draft="' + k + '"]'), v);
  }
  async function review(values) {
    draft(values || { destination: 'https://oaristocrata.com/products/novo', origin: 'instagram_social', surface: 'story', campaign: 'kit_novo', date: '2026-10-05' });
    submit(q('[data-ov-form="link-create"]'));
    await flush();
  }
  async function click(sel) { const el = typeof sel === 'string' ? q(sel) : sel; if (!el) throw new Error('não encontrado: ' + sel); el.click(); await flush(); }
  return Object.assign({ doc, host, inst, q, qa, text, section, tags, state, syncNow, draft, review, click, flush }, g);
}

module.exports = { setup, PERIOD, Organic, flush };
