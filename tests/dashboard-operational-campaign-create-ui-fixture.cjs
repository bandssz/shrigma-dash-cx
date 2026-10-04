'use strict';
// Real portal HTML and campaign controller with a synthetic origin. The HTTP
// fixture listens only on loopback and never delivers an email or uses a key
// from outside the disposable test identity database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');
// Exercise the exact generated browser bytes selected by the public build.
const { createCampaignBffClient } = require('../services/dashboard-operational/public/campaign-bff-client.js');
const { fixture, hosts } = require('./dashboard-operational-campaign-submit.test.cjs');

function memoryStorage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
function serialLocks() {
  const active = new Map(), names = [];
  return { names, request(name, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    assert.equal(typeof callback, 'function');
    names.push(name);
    if (options?.ifAvailable === true && active.has(name)) return Promise.resolve(callback(null));
    const previous = active.get(name) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => callback({ name, mode: 'exclusive' }));
    active.set(name, current);
    return current.finally(() => { if (active.get(name) === current) active.delete(name); });
  } };
}
function browserDom() {
  const html = fs.readFileSync(path.join(__dirname, '../services/dashboard-operational/public/entry.html'), 'utf8');
  const { document, window } = parseHTML(html);
  const dialog = document.getElementById('entry-campaign-dialog');
  assert.ok(dialog, 'The actual entry HTML must contain the campaign dialog');
  // Linkedom supplies real DOM parsing/events, but has no browser top layer,
  // native focus or selectable-option lifecycle. Model only those primitives.
  let activeElement = document.body;
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => activeElement });
  window.HTMLElement.prototype.focus = function () { activeElement = this; };
  Object.defineProperty(window.HTMLInputElement.prototype, 'checked', { configurable: true,
    get() { return this.hasAttribute('checked'); }, set(value) { this.toggleAttribute('checked', Boolean(value)); }
  });
  for (const select of document.querySelectorAll('select')) {
    Object.defineProperty(select, 'value', { configurable: true,
      get() { return this.querySelector('option[selected]')?.value ?? this.querySelector('option')?.value ?? ''; },
      set(value) { for (const option of this.querySelectorAll('option')) option.toggleAttribute('selected', option.value === String(value)); }
    });
  }
  Object.defineProperty(dialog, 'open', { configurable: true, get: () => dialog.hasAttribute('open') });
  dialog.showModal = function () { if (this.open) throw Error('DIALOG_ALREADY_OPEN'); this.setAttribute('open', ''); };
  dialog.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  return { document, window, dialog, element: id => document.getElementById(id),
    input(id, value) { const element = document.getElementById(id); assert.ok(element, id); element.value = value; element.dispatchEvent(new window.Event('input', { bubbles: true })); },
    change(id, value) { const element = document.getElementById(id); assert.ok(element, id); element.value = value; element.dispatchEvent(new window.Event('change', { bubbles: true })); },
    escape() { const event = new window.Event('cancel', { cancelable: true }); dialog.dispatchEvent(event); if (!event.defaultPrevented) dialog.close(); }
  };
}
async function until(condition, label) {
  const deadline = Date.now() + 10000;
  while (!condition()) { if (Date.now() >= deadline) assert.fail('UI did not settle: ' + label); await new Promise(resolve => setImmediate(resolve)); }
}
async function uiFixture(t, { enabled = true, writer = true, storage = memoryStorage(), locks = serialLocks() } = {}) {
  const f = await fixture(t, { enabled,createMode:true }), person = await f.manager('ui@synthetic.invalid', { writer });
  let currentSession = (await f.get(hosts.growth, '/auth/session', person)).json;
  f.origin.row=()=>f.origin.rows.get(1001);f.origin.setRow=row=>f.origin.rows.set(row.id,structuredClone(row));
  const dom = browserDom(), requests = [], responses = [];
  const request = async q => {
    requests.push(structuredClone(q));
    assert.ok(q.path === '/auth/session' || q.path === '/api/campaigns' || q.path.startsWith('/api/campaigns?') || q.path.startsWith('/auth/campaign-delivery?')||q.path==='/auth/campaign-create'||q.path.startsWith('/auth/campaign-create?'));
    assert.ok(['GET', 'POST'].includes(q.method));
    assert.equal(Object.keys(q.headers || {}).some(key => /authorization|cookie/i.test(key)), false);
    const context = { ...person, csrf: q.headers?.['X-CSRF-Token'] };
    const response = q.method === 'POST' ? await f.post(hosts.growth, q.path, q.body, context) : await f.get(hosts.growth, q.path, context);
    responses.push({ request: structuredClone(q), status: response.status, body: response.json });
    return { status: response.status, body: response.json };
  };
  const mount = mountedDom => {
    const { createCampaignEditor } = require('../services/dashboard-operational/public/campaign-edit.compiled.js');
    return createCampaignEditor({ document: mountedDom.document, getSession: () => currentSession, request, storage, locks, now: () => f.config.now(), uuid: () => require('node:crypto').randomUUID(), createClient: createCampaignBffClient });
  };
  const controller = mount(dom);
  return { f, person, ...dom, requests, responses, storage, locks, controller, session: () => currentSession, setSession: value => { currentSession = value; },
    remount() { controller.close(); const freshDom = browserDom(); return { ...this, ...freshDom, controller: mount(freshDom) }; }
  };
}

function checked(ui, value = true) {
  ui.element('campaign-confirm').checked = value;
  ui.element('campaign-confirm').dispatchEvent(new ui.window.Event('change', { bubbles: true }));
}
function stored(ui, brand = 'fish') {
  const key = 'shrigma_campaign_bff_v1:' + ui.session().uiKey + ':' + brand;
  const raw = ui.storage.getItem(key); return raw === null ? null : JSON.parse(raw);
}
const postRequests = ui => ui.requests.filter(request => request.method === 'POST');
function alignFixtureMinute(ui) {
  const row = ui.f.origin.row(), planned = new Date(Math.floor(Date.parse(row.send_at) / 60000) * 60000).toISOString();
  row.send_at = planned; row.definition.send_at = planned; ui.f.origin.setRow(row);
}
async function clickEffect(ui, action, expected) {
  const effect = { create:'create',save: 'save', validate: 'validate', schedule: 'schedule', cancel: 'cancel' }[action];
  const button = ui.element('campaign-' + action);
  assert.equal(button.disabled, false, action + ' must require a usable current state');
  button.click();
  await until(() => ui.f.origin.effects[effect] === expected && ui.responses.filter(value => value.request.method === 'POST').length === postRequests(ui).length, action + ' source effect');
  await until(() => ui.responses.at(-1)?.request.path.includes('campanha_obter') && ui.responses.at(-1)?.body?.campaign?.version === ui.f.origin.row().version && !ui.element('campaign-consult').disabled, action + ' current readback');
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
}


module.exports={uiFixture,browserDom,until,stored,postRequests,checked,clickEffect,memoryStorage,serialLocks,hosts};
