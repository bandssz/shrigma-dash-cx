'use strict';

// Opt-in smoke for the synthetic, isolated dashboard. Secrets are read from a
// private file and never included in reports, snapshots, traces or error text.
// PREVIEW_TEST_URL=https://<test-host> PREVIEW_TEST_ACCESS_FILE=<private.json>
// Optional: PREVIEW_TEST_PLAYWRIGHT_PATH and PREVIEW_TEST_CHROMIUM_PATH.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const areas = {
  cx: {entry: '/cx/', page: '/index.html', label: 'CX/CS'},
  growth: {entry: '/crm/', page: '/growth.html', label: 'CRM'},
  organico: {entry: '/organico/', page: '/organico.html', label: 'Orgânico'},
  influs: {entry: '/creators/', page: '/influs.html', label: 'Influs & Afiliados'},
};
const report = {ok: false, checks: [], externalRequests: 0, assetFailures: [], pageErrors: [], consoleErrors: [], apiFailures: [], integrationReads: {}, screenshots: []};
let stage = 'configuration';
let browser;
let redactions = [];
function check(ok, code) {
  if (!ok) throw new Error(code);
  report.checks.push(code);
}
function playwright() {
  const candidates = [
    process.env.PREVIEW_TEST_PLAYWRIGHT_PATH,
    'playwright',
    path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'),
  ].filter(Boolean);
  for (const modulePath of candidates) {
    try { return require(modulePath); } catch (_) {}
  }
  throw new Error('PLAYWRIGHT_UNAVAILABLE');
}
async function poll(fn, code, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(code);
}
function jsonResponse(response) {
  return response.json().catch(() => null);
}
async function main() {
  const accessFile = process.env.PREVIEW_TEST_ACCESS_FILE;
  check(!!accessFile && fs.existsSync(accessFile), 'PRIVATE_ACCESS_FILE_REQUIRED');
  const stat = fs.statSync(accessFile);
  check(stat.isFile() && !(stat.mode & 0o077), 'PRIVATE_ACCESS_FILE_PERMISSIONS');
  const access = JSON.parse(fs.readFileSync(accessFile, 'utf8'));
  const keys = access.keys || {master: access.master, ...(access.areas || {})};
  redactions = Object.values(keys).filter(value => typeof value === 'string');
  for (const role of ['master', ...Object.keys(areas)]) check(typeof keys[role] === 'string' && /^[a-z0-9-]{8,128}$/.test(keys[role]), 'ACCESS_FORMAT_' + role);
  const origin = new URL(process.env.PREVIEW_TEST_URL || access.url || '');
  check(['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === '/', 'TEST_ORIGIN_REQUIRED');
  const base = origin.origin;
  report.origin = base;
  const captureDir = path.join(path.dirname(path.resolve(accessFile)), 'qa');
  check(captureDir.includes(path.sep + '.private' + path.sep), 'SCREENSHOTS_PRIVATE_DIRECTORY');
  fs.mkdirSync(captureDir, {recursive: true, mode: 0o700});
  const {chromium, request} = playwright();
  const client = await request.newContext({baseURL: base, ignoreHTTPSErrors: false, maxRedirects: 0, timeout: 20000});
  try {
    stage = 'isolation-preflight';
    const healthResponse = await client.get('/healthz');
    const health = await jsonResponse(healthResponse);
    check(healthResponse.status() === 200 && health?.ok === true && health.mode === 'synthetic-read-only' && health.externalIntegrations === false && health.writes === false, 'ISOLATED_SYNTHETIC_HEALTH');
    if (Number.isSafeInteger(health.runtimeUid)) report.runtimeUid = health.runtimeUid;
    if (Number.isSafeInteger(health.runtimeGid)) report.runtimeGid = health.runtimeGid;
    if (process.env.PREVIEW_TEST_EXPECT_UID) {
      const expectedUid = Number(process.env.PREVIEW_TEST_EXPECT_UID);
      check(Number.isSafeInteger(expectedUid) && expectedUid > 0 && health.runtimeUid === expectedUid, 'REMOTE_RUNTIME_UID_EXPECTED');
    }

    stage = 'browser-launch';
    browser = await chromium.launch({headless: true, ...(process.env.PREVIEW_TEST_CHROMIUM_PATH ? {executablePath: process.env.PREVIEW_TEST_CHROMIUM_PATH} : {}), args: ['--disable-background-networking', '--disable-component-update', '--disable-sync']});
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', serviceWorkers: 'block'});
    let expectedRefusal = false;
    const responses = [];
    const external = [];
    const securityViolations = [];
    const credentialLeaks = [];
    const sensitive = Object.values(keys);
    const pendingRequests = new Set();
    const containsKey = value => sensitive.some(key => String(value).includes(key));
    const safePath = value => sensitive.reduce((text, key) => text.split(key).join('[credential]'), new URL(value).pathname);
    await context.route('**/*', route => {
      const u = new URL(route.request().url());
      if (['http:', 'https:'].includes(u.protocol) && u.origin !== base) {
        external.push({kind: route.request().resourceType()});
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    context.on('request', req => {
      pendingRequests.add(req);
      if (containsKey(req.url()) || containsKey(req.headers().referer || '')) credentialLeaks.push('URL_OR_REFERRER');
    });
    context.on('requestfinished', req => pendingRequests.delete(req));
    context.on('requestfailed', req => pendingRequests.delete(req));
    context.on('response', response => {
      const req = response.request(), u = new URL(response.url());
      // A refused login deliberately leaves its tiny JSON body unread. Chromium
      // can retain that fetch in lifecycle tracking after headers have arrived.
      // Actual area data consumption is separately asserted against the UI state.
      pendingRequests.delete(req);
      if (u.origin !== base) return;
      const pathname = safePath(response.url());
      responses.push({pathname, method: req.method(), status: response.status()});
      if (u.pathname.startsWith('/preview-api/') && response.ok()) report.integrationReads[pathname] = (report.integrationReads[pathname] || 0) + 1;
      if (u.pathname.startsWith('/preview-api/') && response.status() >= 400) report.apiFailures.push({stage, path: pathname, status: response.status(), expectedRefusal});
      if (response.status() >= 400 && ['script', 'stylesheet', 'image', 'font', 'document'].includes(req.resourceType())) report.assetFailures.push({path: pathname, status: response.status()});
    });
    await context.addInitScript(() => {
      window.__previewSecurityViolations = [];
      document.addEventListener('securitypolicyviolation', e => {
        window.__previewSecurityViolations.push({directive: e.violatedDirective, disposition: e.disposition});
      });
    });
    const page = await context.newPage();
    page.on('pageerror', () => report.pageErrors.push({stage}));
    page.on('console', msg => {
      if (msg.type() !== 'error') return;
      if (expectedRefusal && /^Failed to load resource: the server responded with a status of (401|403)/.test(msg.text())) return;
      // Only retain a category and stage. Console text can contain credentials.
      const httpStatus = msg.text().match(/Failed to load resource: the server responded with a status of (\d+)/)?.[1];
      const source = msg.location();
      let pathname;
      try { pathname = safePath(source.url); } catch (_) { pathname = 'unknown'; }
      report.consoleErrors.push({stage, category: httpStatus ? 'HTTP_' + httpStatus : /Content Security Policy|violates.*policy/i.test(msg.text()) ? 'CSP' : 'CONSOLE_ERROR', path: pathname, line: source.lineNumber});
    });
    async function captureSecurity() {
      for (const frame of page.frames()) {
        try {
          const violations = await frame.evaluate(() => window.__previewSecurityViolations || []);
          securityViolations.push(...violations.map(v => ({stage, directive: v.directive})));
        } catch (_) {}
      }
    }
    async function enter(entry, key, asFile = false) {
      await page.goto(base + entry, {waitUntil: 'networkidle'});
      await page.locator('#entry-key').waitFor();
      if (asFile) {
        await page.locator('#entry-file').setInputFiles({name: 'synthetic-access.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({schema: 'shrigma_area_access_v2', panel: 'todos', key}))});
        await poll(() => page.locator('#entry-key').inputValue().then(value => value === key), 'FILE_ACCESS_NOT_LOADED');
      } else {
        await page.locator('#entry-key').fill(key);
      }
      await page.locator('#entry-form button[type="submit"]').click();
    }
    async function frameFor(panel) {
      await poll(async () => {
        const frame = page.frames().find(f => new URL(f.url() || 'about:blank').pathname === areas[panel].page);
        if (!frame) return false;
        return frame.evaluate(expected => document.body.dataset.panel === expected, panel === 'cx' ? 'index' : panel).catch(() => false);
      }, 'AREA_FRAME_' + panel);
      return page.frames().find(f => new URL(f.url() || 'about:blank').pathname === areas[panel].page);
    }
    async function assertDataLoaded(panel, frame) {
      await poll(() => frame.evaluate(area => {
        if (area === 'cx') return typeof estado !== 'undefined' && !!estado.dados;
        if (area === 'influs') return typeof INFLU !== 'undefined' && !!INFLU;
        return typeof API !== 'undefined' && !!API;
      }, panel), 'SYNTHETIC_DATA_NOT_RENDERED_' + panel);
      check(true, 'DATA_RENDERED_' + panel);
      const persisted = await frame.evaluate(() => ({local: Object.values(localStorage), session: Object.values(sessionStorage), html: document.documentElement.outerHTML, url: location.href}));
      check(!containsKey(JSON.stringify(persisted)), 'NO_CREDENTIAL_PERSISTENCE_' + panel);
      await captureSecurity();
    }
    async function navigation(panel, frame) {
      const selector = panel === 'cx' ? '#abas-cx button[data-aba]' : '#secoes button[data-s]';
      const buttons = frame.locator(selector);
      for (let i = 0; i < await buttons.count(); i++) {
        const button = buttons.nth(i);
        if (!await button.isVisible()) continue;
        const target = await button.getAttribute(panel === 'cx' ? 'data-aba' : 'data-s');
        await button.click();
        const active = panel === 'cx' ? frame.locator('.aba-pane[data-aba="' + target + '"]') : frame.locator('#sec-' + target);
        check(await active.isVisible(), 'NAV_' + panel + '_' + target);
      }
      if (panel === 'influs') {
        await poll(() => frame.evaluate(() => typeof ESCOPO !== 'undefined' && ESCOPO?.dados()?.synthetic === true), 'SYNTHETIC_ESCOPO_NOT_RENDERED');
        check(true, 'ESCOPO_READ_RENDERED');
        await frame.locator('#secoes button[data-s="afil"]').click();
        await frame.locator('#canais button[data-c="tiktok"]').click();
        await poll(() => frame.locator('#tts-kpis').evaluate(el => el.children.length > 0), 'SYNTHETIC_TIKTOK_NOT_RENDERED');
        check(await frame.locator('#canal-tiktok').isVisible(), 'TIKTOK_READ_RENDERED');
        const tabs = frame.locator('#tts-abas button[data-p]');
        for (let i = 0; i < await tabs.count(); i++) {
          const tab = tabs.nth(i), target = await tab.getAttribute('data-p');
          await tab.click();
          check((await tab.getAttribute('class') || '').split(/\s+/).includes('ativo'), 'NAV_TIKTOK_' + target);
        }
        const affiliateText = await frame.locator('#tts-area').textContent();
        check(!/Falha ao carregar|escrita e conexões externas bloqueadas/i.test(affiliateText), 'TIKTOK_NO_READ_FAILURE');
      }
      const activeRequests = () => [...pendingRequests].filter(req => {try {return !req.frame().isDetached();} catch (_) {return false;}});
      await poll(() => {
        const active = activeRequests();
        report.pendingRequests = active.map(req => ({path: safePath(req.url()), method: req.method(), resourceType: req.resourceType()}));
        return active.length === 0;
      }, 'NAV_REQUESTS_UNSETTLED_' + panel);
      await captureSecurity();
    }
    async function screenshot(panel, viewport) {
      for (const frame of page.frames()) {
        const values = await frame.evaluate(() => [...document.querySelectorAll('input,textarea')].map(input => input.value));
        check(!containsKey(JSON.stringify(values)), 'SCREENSHOT_NO_CREDENTIAL_VALUES_' + viewport + '_' + panel);
        await frame.evaluate(() => window.scrollTo(0, 0));
      }
      const capturePath = path.join(captureDir, viewport + '-' + panel + '.png');
      await page.screenshot({path: capturePath, fullPage: true, animations: 'disabled'});
      fs.chmodSync(capturePath, 0o600);
      report.screenshots.push(capturePath);
    }

    stage = 'invalid-key';
    expectedRefusal = true;
    await enter('/gestao/', 'synthetic-invalid-access-20260930');
    await poll(() => page.locator('#entry-message').textContent().then(text => /não tem acesso|recusad|inválid/i.test(text || '')), 'INVALID_KEY_NOT_REFUSED');
    check(await page.locator('#entry-shell').isHidden() && await page.locator('iframe').count() === 0, 'INVALID_KEY_CANNOT_OPEN_DASHBOARD');
    expectedRefusal = false;

    stage = 'master-json';
    await enter('/gestao/', keys.master, true);
    await page.locator('#entry-shell').waitFor({state: 'visible'});
    check(await page.locator('#entry-nav button').count() === 4, 'MASTER_FOUR_AREAS');
    for (const panel of Object.keys(areas)) {
      stage = 'master-area-' + panel;
      await page.locator('#entry-nav button[data-panel="' + panel + '"]').click();
      const frame = await frameFor(panel);
      await assertDataLoaded(panel, frame);
      check(await frame.locator('#preview-safety-banner').isVisible(), 'SYNTHETIC_WARNING_' + panel);
      await screenshot(panel, 'desktop');
      await navigation(panel, frame);
    }
    stage = 'logout';
    await page.locator('#entry-logout').click();
    check(await page.locator('#entry-login').isVisible() && await page.locator('iframe').count() === 0, 'LOGOUT_REMOVES_IFRAME');
    const persisted = await page.evaluate(() => ({local: Object.values(localStorage), session: Object.values(sessionStorage), html: document.documentElement.outerHTML, url: location.href}));
    check(!containsKey(JSON.stringify(persisted)), 'LOGOUT_NO_CREDENTIALS_RETAINED');

    stage = 'master-typed-key';
    await enter('/gestao/', keys.master);
    await page.locator('#entry-shell').waitFor({state: 'visible'});
    check(await page.locator('#entry-key').inputValue() === '', 'MASTER_TYPED_KEY_CLEARED');
    await page.setViewportSize({width: 390, height: 844});
    for (const panel of Object.keys(areas)) {
      stage = 'mobile-area-' + panel;
      await page.locator('#entry-nav button[data-panel="' + panel + '"]').click();
      const frame = await frameFor(panel);
      await assertDataLoaded(panel, frame);
      check(await frame.locator('#preview-safety-banner').isVisible(), 'MOBILE_SYNTHETIC_WARNING_' + panel);
      await screenshot(panel, 'mobile');
      await navigation(panel, frame);
    }
    await page.locator('#entry-logout').click();
    await page.setViewportSize({width: 1440, height: 1000});

    for (const [panel, area] of Object.entries(areas)) {
      stage = 'manager-' + panel;
      await enter(area.entry, keys[panel]);
      await page.locator('#entry-shell').waitFor({state: 'visible'});
      check(await page.locator('#entry-nav').isHidden() && await page.locator('#entry-nav button').count() === 0, 'MANAGER_NO_CROSS_AREA_NAV_' + panel);
      await assertDataLoaded(panel, await frameFor(panel));
      await page.locator('#entry-logout').click();
      stage = 'cross-area-refusal-' + panel;
      expectedRefusal = true;
      const other = panel === 'growth' ? 'cx' : 'growth';
      await enter(areas[other].entry, keys[panel]);
      await poll(() => page.locator('#entry-message').textContent().then(text => /não tem acesso|recusad|inválid/i.test(text || '')), 'CROSS_AREA_KEY_NOT_REFUSED_' + panel);
      check(await page.locator('#entry-shell').isHidden() && await page.locator('iframe').count() === 0, 'CROSS_AREA_ENTRY_DENIED_' + panel);
      expectedRefusal = false;
    }
    await captureSecurity();

    stage = 'http-write-guards';
    const endpoints = ['cx', 'cache', 'crm-read', 'influ', 'tts', 'tts-cobranca', 'organico-links', 'candidaturas', 'aprovacao', 'escopo', 'ab-blocked', 'tts-blocked'].map(route => '/preview-api/' + route);
    for (const endpoint of endpoints) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await client.fetch(endpoint, {method, headers: {Authorization: 'Bearer ' + keys.master}, data: {acao: 'salvar', action: 'send', data: {id: 'synthetic-browser-guard'}}});
        check(response.status() === 403, 'WRITE_DENIED_' + method + '_' + endpoint.split('/').pop());
      }
      for (const parameter of ['acao', 'action']) {
        const response = await client.get(endpoint + '?' + parameter + '=salvar', {headers: {Authorization: 'Bearer ' + keys.master}});
        check(response.status() === 403, 'GET_MUTATION_DENIED_' + parameter + '_' + endpoint.split('/').pop());
      }
    }
    for (const [role, key] of Object.entries(keys)) {
      const response = await client.get('/preview-api/cx?access=1&painel=todos', {headers: {Authorization: 'Bearer ' + key}});
      check(response.status() === (role === 'master' ? 200 : 403), 'HTTP_MASTER_SCOPE_' + role);
      if (role !== 'master') {
        const other = role === 'growth' ? 'cx' : 'growth';
        const crossAreaData = await client.get('/preview-api/cache?painel=' + other, {headers: {Authorization: 'Bearer ' + key}});
        check(crossAreaData.status() === 403, 'HTTP_CROSS_AREA_DATA_DENIED_' + role);
      }
    }
    const denied = await client.get('/preview-api/cx?access=1&painel=cx');
    check(denied.status() === 401, 'HTTP_ANONYMOUS_IDENTITY_DENIED');
    const untrusted = await client.get('/preview-api/cx?access=1&painel=cx', {headers: {Authorization: 'Bearer ' + keys.master, Origin: 'https://synthetic-untrusted.invalid'}});
    check(untrusted.status() === 403, 'HTTP_CROSS_ORIGIN_DENIED');
    const externalGuard = await page.evaluate(async () => {
      try { return (await fetch('https://synthetic-untrusted.invalid/no-op')).status; } catch (_) { return 0; }
    });
    check(externalGuard === 403, 'BROWSER_EXTERNAL_FETCH_DENIED_BEFORE_NETWORK');
    const blockedRouteGuard = await page.evaluate(async () => (await fetch('/preview-api/tts-blocked?acao=capacidades')).status);
    check(blockedRouteGuard === 403, 'BROWSER_BLOCKED_ROUTE_DENIED_BEFORE_NETWORK');

    stage = 'final-isolation-check';
    report.externalRequests = external.length;
    report.securityViolations = securityViolations;
    report.browserRequests = responses.length;
    check(external.length === 0, 'ZERO_EXTERNAL_REQUEST_ATTEMPTS');
    check(report.assetFailures.length === 0, 'NO_MISSING_OR_FAILED_ASSETS');
    check(report.pageErrors.length === 0, 'NO_BROWSER_UNCAUGHT_ERRORS');
    check(report.consoleErrors.length === 0, 'NO_UNEXPECTED_CONSOLE_ERRORS');
    check(report.apiFailures.every(failure => failure.expectedRefusal), 'NO_UNEXPECTED_API_FAILURES');
    check(securityViolations.length === 0, 'NO_CSP_VIOLATIONS');
    check(credentialLeaks.length === 0, 'NO_KEYS_IN_URLS_OR_REFERRERS');
    check(Object.keys(report.integrationReads).length >= 4, 'SYNTHETIC_INTEGRATIONS_READ');
    for (const route of ['tts', 'tts-cobranca', 'escopo']) check(report.integrationReads['/preview-api/' + route] > 0, 'LAZY_SYNTHETIC_INTEGRATION_' + route);
    await context.close();
    report.ok = true;
  } finally {
    await client.dispose();
    await browser?.close();
  }
}
main().then(() => {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}).catch(error => {
  // Never print raw Playwright errors: they may embed entered secrets or URLs.
  report.failedStage = stage;
  report.failure = /^[A-Za-z0-9_/-]+$/.test(error.message || '') && !redactions.some(value => String(error.message).includes(value)) ? error.message : 'BROWSER_CHECK_FAILED';
  report.failureCategory = error.name;
  report.failureLine = String(error.stack || '').match(/dashboard-preview-browser\.cjs:(\d+):/)?.[1] || null;
  process.stderr.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = 1;
});
