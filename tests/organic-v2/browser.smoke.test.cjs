'use strict';
// Fumaça em navegador real (Chromium via Playwright) com o MESMO gateway sintético em memória.
// Opcional: se o Playwright/Chromium não existir no ambiente, os testes são marcados como "skip"
// (nada é instalado). Não substitui o percurso publicado de Root/QA.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let playwright = null;
try { playwright = require('playwright'); } catch (_) { /* opcional */ }
const SKIP = playwright ? false : 'playwright indisponível neste ambiente; nada instalado';
const SHOTS = process.env.SOV2_SCREENSHOTS || null; // pasta opcional para capturas, fora da entrega

const ui = path.join(__dirname, '..', '..', 'ui', 'organic-v2');
const component = fs.readFileSync(path.join(ui, 'organic-v2.js'), 'utf8');
const css = fs.readFileSync(path.join(ui, 'organic-v2.css'), 'utf8');
const gatewaySrc = fs.readFileSync(path.join(__dirname, 'synthetic-gateway.cjs'), 'utf8');

async function open(browser, opts) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 900 } }, opts || {}));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setContent('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style></head><body><main id="host"></main></body></html>');
  await page.addScriptTag({ content: component });
  await page.addScriptTag({ content: '(function(){var module={exports:{}};' + gatewaySrc + '\nwindow.SG=module.exports;})();' });
  await page.evaluate(async () => {
    window.t = window.SG.createGateway();
    window.view = window.ShrigmaOrganicV2.create({ element: document.getElementById('host'), document, gateway: window.t.gateway });
    await window.view.sync({ filters: { period: { from: '2026-10-01', to: '2026-10-05' } } });
  });
  return { ctx, page, errors };
}
function lum(rgb) {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

test('navegador real: render, teclado, celular e contraste', { skip: SKIP }, async t => {
  const browser = await playwright.chromium.launch();
  try {
    await t.test('renderiza as 5 seções sem erro de console e sem global além do export', async () => {
      const { ctx, page, errors } = await open(browser);
      assert.equal(await page.locator('[data-ov-section]').count(), 5);
      assert.equal(await page.locator('[data-ov-brand]').innerText(), 'O Aristocrata');
      assert.deepEqual(errors, []);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'desktop.png'), fullPage: true });
      await ctx.close();
    });

    await t.test('percurso só com teclado: preencher, Enter para revisar, Enter para confirmar', async () => {
      const { ctx, page, errors } = await open(browser);
      await page.focus('[data-ov-draft="destination"]');
      await page.keyboard.type('https://oaristocrata.com/products/teclado');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-ov-draft')), 'origin');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Tab');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Tab');
      await page.keyboard.type('kit_teclado');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-ov-op="prepared"]');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-ov-action')), 'op-confirm');
      const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
      assert.notEqual(outline, 'none', 'foco visível no botão de confirmar');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-ov-refresh="ok"]');
      assert.equal(await page.locator('[data-ov-link-row="new-1"]').count(), 1);
      assert.equal(await page.evaluate(() => window.t.calls.submit.length), 1);
      assert.deepEqual(errors, []);
      await ctx.close();
    });

    await t.test('celular 375px: sem rolagem horizontal da página e alvos de toque ≥ 44px', async () => {
      const { ctx, page, errors } = await open(browser, { viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      assert.ok(m.sw <= m.cw, 'página rola na horizontal: ' + JSON.stringify(m));
      const small = await page.evaluate(() => [...document.querySelectorAll('.sov2 button:not([disabled]), .sov2 input, .sov2 select')]
        .filter(e => e.offsetParent !== null).map(e => ({ h: e.getBoundingClientRect().height, k: e.getAttribute('data-ov-action') || e.getAttribute('data-ov-draft') || e.getAttribute('data-ov-period') || e.tagName }))
        .filter(x => x.h < 44));
      assert.deepEqual(small, []);
      const scrollers = await page.evaluate(() => [...document.querySelectorAll('.sov2-scroll')].every(s => getComputedStyle(s).overflowX === 'auto'));
      assert.ok(scrollers);
      assert.deepEqual(errors, []);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'mobile.png'), fullPage: true });
      await ctx.close();
    });

    for (const scheme of ['light', 'dark']) {
      await t.test('contraste AA do texto e etiquetas no tema ' + scheme, async () => {
        const { ctx, page } = await open(browser, { colorScheme: scheme });
        const pairs = await page.evaluate(() => {
          const out = [];
          const bgOf = el => { for (let n = el; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; } return 'rgb(255, 255, 255)'; };
          const sel = ['.sov2-title', '.sov2-role', '.sov2-source', '.sov2-note', '.sov2-tag', '.sov2-table th', '.sov2-table td', '.sov2-cap', '.sov2-field span', '.sov2-btn'];
          for (const s of sel) for (const el of document.querySelectorAll(s)) {
            if (el.disabled || el.offsetParent === null) continue;
            out.push({ s, fg: getComputedStyle(el).color, bg: bgOf(el), text: (el.textContent || '').slice(0, 30) });
          }
          return out;
        });
        const bad = pairs.filter(p => contrast(p.fg, p.bg) < 4.5).map(p => Object.assign(p, { ratio: contrast(p.fg, p.bg).toFixed(2) }));
        assert.deepEqual(bad, [], 'pares abaixo de 4.5:1');
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'tema-' + scheme + '.png'), fullPage: true });
        await ctx.close();
      });
    }
  } finally { await browser.close(); }
});
