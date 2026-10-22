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
  const f = await fixture(t, { enabled }); let person = await f.manager('ui@synthetic.invalid', { writer, brand: 'fish' });
  let currentSession = (await f.get(hosts.growth, '/auth/session', person)).json;
  const dom = browserDom(), requests = [], responses = [];
  const request = async q => {
    requests.push(structuredClone(q));
    assert.ok(q.path === '/auth/session' || q.path === '/api/campaigns' || q.path.startsWith('/api/campaigns?') || q.path.startsWith('/auth/campaign-delivery?'));
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
    remount() { this.controller.close(); const freshDom = browserDom(); return { ...this, ...freshDom, controller: mount(freshDom) }; },
    async reloginAs(other) { this.controller.close(); person=other; currentSession=(await f.get(hosts.growth, '/auth/session', other)).json; assert.equal(currentSession.user.brandAccess,'single'); const freshDom=browserDom(); return {...this,person:other,...freshDom,controller:mount(freshDom)}; }
  };
}

function forgeBrand(ui, brand) {
  const option=ui.document.createElement('option');option.value=brand;option.textContent='Forged other brand';ui.element('campaign-brand').append(option);ui.change('campaign-brand',brand);
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
  const effect = { save: 'save', validate: 'validate', schedule: 'schedule', cancel: 'cancel' }[action];
  const button = ui.element('campaign-' + action);
  assert.equal(button.disabled, false, action + ' must require a usable current state');
  button.click();
  await until(() => ui.f.origin.effects[effect] === expected && ui.responses.filter(value => value.request.method === 'POST').length === postRequests(ui).length, action + ' source effect');
  await until(() => ui.responses.at(-1)?.request.path.includes('campanha_obter') && ui.responses.at(-1)?.body?.campaign?.version === ui.f.origin.row().version && !ui.element('campaign-consult').disabled, action + ' current readback');
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
}

test('real portal dialog completes existing update-save, validate, confirmed schedule and cancel', async t => {
  const ui = await uiFixture(t); alignFixtureMinute(ui);
  assert.equal(await ui.controller.open(), true); assert.equal(ui.dialog.open, true);
  assert.equal(ui.element('campaign-name').value, ui.f.origin.row().definition.name);
  assert.equal(ui.element('campaign-schedule').disabled, true);
  ui.input('campaign-subject', 'UI updated synthetic subject');
  assert.equal(ui.element('campaign-validate').disabled, true, 'Dirty content cannot be validated');
  await clickEffect(ui, 'save', 1);
  assert.equal(ui.f.origin.row().definition.subject, 'UI updated synthetic subject');
  await clickEffect(ui, 'validate', 1);
  assert.equal(ui.element('campaign-schedule').disabled, true, 'Review alone cannot confirm scheduling');
  checked(ui); assert.equal(ui.element('campaign-schedule').disabled, false);
  await clickEffect(ui, 'schedule', 1);
  assert.equal(ui.f.origin.row().status, 'scheduled');
  assert.equal(ui.element('campaign-cancel').disabled, true, 'Scheduling clears the previous confirmation');
  checked(ui); await clickEffect(ui, 'cancel', 1);
  assert.equal(ui.f.origin.row().status, 'cancelled');
  assert.deepEqual(ui.f.origin.effects, { save: 1, validate: 1, schedule: 1, cancel: 1, create: 0 });
  assert.equal(postRequests(ui).length, 4);
  assert.equal(new Set(postRequests(ui).map(request => request.body.idempotency_key)).size, 4);
  for (const request of ui.requests) {
    assert.equal(request.headers['X-CSRF-Token'], ui.session().csrf);
    assert.equal(JSON.stringify(request).includes(ui.person.bearer), false);
  }
  assert.ok(ui.locks.names.every(name => name === 'shrigma-campaign-bff:' + ui.session().uiKey + ':fish'));
  assert.equal(JSON.stringify([...ui.storage.values]).includes(ui.person.bearer), false);
  ui.escape(); assert.equal(ui.dialog.open, false); assert.equal(ui.document.activeElement.id, 'entry-campaign-open');
});

test('lost save ACK survives new DOM/controller and resumes STATUS first without another POST', async t => {
  let ui = await uiFixture(t); alignFixtureMinute(ui); await ui.controller.open();
  ui.f.behavior(async ({ options, dispatch }) => { if (options.method === 'POST') { await dispatch(); throw Error('SYNTHETIC_LOST_ACK'); } return dispatch(); });
  ui.input('campaign-subject', 'Lost ACK subject'); ui.element('campaign-save').click();
  await until(() => stored(ui)?.phase === 'uncertain' && !ui.element('campaign-consult').disabled, 'uncertain save intent');
  const row = stored(ui), posted = postRequests(ui).length; assert.equal(posted, 1); assert.equal(ui.f.origin.effects.save, 1);
  assert.equal(ui.element('campaign-save').disabled, true);
  const firstResume = ui.requests.length;
  ui = ui.remount(); await ui.controller.open();
  assert.equal(ui.requests[firstResume].method, 'GET'); assert.match(ui.requests[firstResume].path, /^\/auth\/campaign-delivery\?/);
  assert.equal(stored(ui).attemptKey, row.attemptKey); assert.equal(stored(ui).phase, 'succeeded');
  assert.equal(postRequests(ui).length, posted); assert.equal(ui.f.origin.effects.save, 1);
  assert.equal(ui.element('campaign-subject').value, 'Lost ACK subject');
  assert.equal(ui.element('campaign-validate').disabled, false);
});

test('expired historical validation is terminal, and a fresh explicit validation uses a new key', async t => {
  let ui = await uiFixture(t); alignFixtureMinute(ui); await ui.controller.open();
  await clickEffect(ui, 'validate', 1);
  const original = stored(ui).attemptKey;
  ui.f.advance(300001);
  ui = ui.remount(); await ui.controller.open(); checked(ui);
  const history = ui.responses.findLast(response => response.request.path.startsWith('/auth/campaign-delivery?'));
  assert.equal(history.body.state, 'succeeded'); assert.equal(history.body.validation, null);
  assert.equal(stored(ui).phase, 'succeeded'); assert.equal(stored(ui).attemptKey, original);
  assert.equal(ui.element('campaign-schedule').disabled, true); assert.equal(ui.element('campaign-validate').disabled, false);
  await clickEffect(ui, 'validate', 2);
  assert.notEqual(stored(ui).attemptKey, original); assert.equal(postRequests(ui).length, 2); assert.equal(ui.f.origin.effects.schedule, 0);
});

test('opening seconds and milliseconds does not dirty the draft, and another field save preserves the exact time', async t => {
  const ui = await uiFixture(t), row = ui.f.origin.row();
  const planned = new Date(Math.floor((ui.f.config.now() + 3600000) / 60000) * 60000 + 37123).toISOString();
  row.send_at = planned; row.definition.send_at = planned; ui.f.origin.setRow(row);
  await ui.controller.open();
  assert.equal(ui.element('campaign-validate').disabled, false, 'Displaying a timestamp must not change the loaded definition');
  await clickEffect(ui, 'validate', 1);
  ui.input('campaign-subject', 'Another field preserves precise planned time');
  await clickEffect(ui, 'save', 1);
  assert.equal(ui.f.origin.row().send_at, planned); assert.equal(ui.f.origin.row().definition.send_at, planned);
  assert.equal(postRequests(ui).find(request => request.body.acao === 'campanha_salvar').body.definition.send_at, planned);
});

test('bare 404 preserves the own-brand journal across refused forged switching, close and refresh with GET only', async t => {
  const ui = await uiFixture(t); alignFixtureMinute(ui); await ui.controller.open();
  ui.f.behavior(async ({ options, dispatch }) => options.method === 'POST' ? { status: 404, body: { error: 'NOT_FOUND' } } : dispatch());
  ui.element('campaign-validate').click();
  await until(() => stored(ui)?.phase === 'uncertain' && !ui.element('campaign-consult').disabled, 'bare 404 pending');
  const original = stored(ui), before = ui.requests.length;
  forgeBrand(ui,'aristo');for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.requests.length,before,'A forged selector cannot read another brand or submit a new intent');
  assert.equal(ui.element('campaign-brand').value,'fish');assert.match(ui.element('campaign-status').textContent,/vinculado à sua marca/);
  assert.equal(stored(ui,'aristo'),null);assert.deepEqual(stored(ui),original);
  ui.controller.close();const resume=ui.requests.length;await ui.controller.open();
  assert.match(ui.requests[resume].path,/^\/auth\/campaign-delivery\?brand=fish/);
  assert.equal(stored(ui).attemptKey,original.attemptKey);assert.equal(stored(ui).phase,'uncertain');
  assert.equal(postRequests(ui).length,1);assert.equal(ui.f.origin.effects.validate,0);
  assert.equal(ui.element('campaign-save').disabled,true);assert.equal(ui.element('campaign-schedule').disabled,true);
});

test('closing during an active write preserves intent and a late ACK cannot fill another authenticated brand', async t => {
  let ui = await uiFixture(t); alignFixtureMinute(ui); await ui.controller.open();
  const fishPerson=ui.person;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  ui.f.behavior(async ({ options, dispatch }) => { const result = await dispatch(); if (options.method === 'POST') await waiting; return result; });
  ui.input('campaign-subject','First delayed save');ui.element('campaign-save').click();
  await until(()=>ui.f.origin.effects.save===1&&stored(ui)?.phase==='pending','active save after durable browser intent');
  const attemptKey=stored(ui).attemptKey,fishJournalKey='shrigma_campaign_bff_v1:'+ui.session().uiKey+':fish';
  ui.escape();assert.equal(ui.dialog.open,false);assert.equal(ui.document.activeElement.id,'entry-campaign-open');
  ui=ui.remount();await ui.controller.open();
  const before=ui.requests.length;forgeBrand(ui,'aristo');for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.requests.length,before);assert.equal(ui.element('campaign-brand').value,'fish');assert.equal(stored(ui).attemptKey,attemptKey);
  const other=await ui.f.manager('other-brand@synthetic.invalid',{number:2,brand:'aristo'});
  ui=await ui.reloginAs(other);assert.equal(ui.session().user.brand,'aristo');await ui.controller.open();
  assert.equal(ui.element('campaign-brand').value,'aristo');assert.equal(ui.element('campaign-brand').disabled,true);
  const untouched=ui.element('campaign-subject').value;
  release();await until(()=>ui.responses.filter(value=>value.request.method==='POST').length===1,'late ACK');
  for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.element('campaign-subject').value,untouched);assert.equal(ui.element('campaign-name').value,'');assert.equal(stored(ui,'aristo'),null);
  assert.equal(JSON.parse(ui.storage.getItem(fishJournalKey)).attemptKey,attemptKey);
  assert.equal(ui.f.origin.effects.save,1);assert.equal(postRequests(ui).length,1);
  ui=await ui.reloginAs(fishPerson);const resume=ui.requests.length;await ui.controller.open();
  assert.match(ui.requests[resume].path,/^\/auth\/campaign-delivery\?brand=fish/);
  assert.equal(stored(ui).phase,'succeeded');assert.equal(stored(ui).attemptKey,attemptKey);
  assert.equal(ui.element('campaign-subject').value,'First delayed save');assert.equal(postRequests(ui).length,1);
});

test('a write lock held by another tab prevents a browser intent and POST', async t => {
  const ui = await uiFixture(t); alignFixtureMinute(ui); await ui.controller.open();
  let release;
  const held = ui.locks.request('shrigma-campaign-bff:' + ui.session().uiKey + ':fish', () => new Promise(resolve => { release = resolve; }));
  await until(() => typeof release === 'function', 'external tab lock acquired'); t.after(() => release());
  ui.element('campaign-save').click();
  await until(() => /não foi confirmada/.test(ui.element('campaign-status').textContent), 'external tab lock refusal');
  assert.equal(stored(ui), null); assert.equal(postRequests(ui).length, 0); assert.equal(ui.f.origin.effects.save, 0);
  release(); await held;
});

test('OFF, missing writer and absent cross-tab locks cannot dispatch writes', async t => {
  for (const args of [{ enabled: false }, { writer: false }]) await t.test(JSON.stringify(args), async sub => {
    const ui = await uiFixture(sub, args);
    assert.equal(await ui.controller.open(), false); assert.equal(ui.dialog.open, false); assert.equal(ui.requests.length, 0);
  });
  await t.test('no lock implementation keeps read-only access', async sub => {
    const ui = await uiFixture(sub, { locks: null }); alignFixtureMinute(ui); await ui.controller.open();
    for (const action of ['save', 'validate', 'schedule', 'cancel']) assert.equal(ui.element('campaign-' + action).disabled, true);
    ui.element('campaign-save').click();
    for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(postRequests(ui).length, 0); assert.equal(stored(ui), null);
  });
});
