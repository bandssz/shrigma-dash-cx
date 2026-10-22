'use strict';
// DOM mínimo, em memória, só para os testes da frente C1 (linkedom não está instalado neste ambiente).
// Cobre o subconjunto usado pelo módulo: createElement/createTextNode, atributos, árvore, textContent,
// value/disabled, foco (document.activeElement), eventos com bolha e seletores simples.
// Não é implementação de produção e não tem rede, armazenamento nem timers.

const INSPECT = Symbol.for('nodejs.util.inspect.custom');
class Node {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  // Mensagens de falha curtas: a árvore é circular e grande demais para o inspect padrão.
  [INSPECT]() { return this.nodeType === 1 ? '<' + this.tagName.toLowerCase() + [...this._attrs].map(([k, v]) => ' ' + k + '="' + v + '"').join('') + '>' : this.nodeType === 3 ? '#text ' + JSON.stringify(this.data) : '#document'; }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this; this.childNodes.push(n); return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i < 0) throw new Error('NotFoundError');
    this.childNodes.splice(i, 1); n.parentNode = null;
    const d = this.ownerDocument;
    if (d && d.activeElement && n.contains(d.activeElement)) d.activeElement = d.body;
    return n;
  }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    this.childNodes.forEach((c) => { c.parentNode = null; });
    this.childNodes = [];
    if (v !== '' && v != null) this.appendChild(new Text(this.ownerDocument, String(v)));
  }
}
class Text extends Node {
  constructor(doc, data) { super(doc); this.nodeType = 3; this.data = data; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}
class Event {
  constructor(type, init = {}) {
    this.type = type; this.bubbles = init.bubbles !== false; this.key = init.key;
    this.target = null; this.currentTarget = null; this.defaultPrevented = false; this._stop = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
}
function parseCompound(s) {
  const out = { tag: null, classes: [], id: null, attrs: [] };
  let m, rest = s;
  if ((m = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest))) { out.tag = m[1].toLowerCase(); rest = rest.slice(m[0].length); }
  while (rest) {
    if ((m = /^\.([a-zA-Z0-9_-]+)/.exec(rest))) out.classes.push(m[1]);
    else if ((m = /^#([a-zA-Z0-9_-]+)/.exec(rest))) out.id = m[1];
    else if ((m = /^\[([a-zA-Z0-9_:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/.exec(rest))) out.attrs.push({ name: m[1], value: m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] });
    else throw new Error('Seletor não suportado pelo mini-dom: ' + s);
    rest = rest.slice(m[0].length);
  }
  return out;
}
function matchCompound(el, c) {
  if (el.nodeType !== 1) return false;
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  const cls = (el.getAttribute('class') || '').split(/\s+/);
  for (const k of c.classes) if (!cls.includes(k)) return false;
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    if (a.value !== undefined && el.getAttribute(a.name) !== a.value) return false;
  }
  return true;
}
// Divide fora de colchetes/aspas (valores de atributo podem ter espaço ou vírgula).
function splitTop(s, isSep) {
  const out = []; let cur = '', depth = 0, quote = null;
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[') depth++; else if (ch === ']') depth--;
    if (depth === 0 && isSep(ch)) { if (cur) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function matches(el, selector) {
  return splitTop(selector, (c) => c === ',').some((part) => {
    const chain = splitTop(part.trim(), (c) => /\s/.test(c)).map(parseCompound);
    if (!matchCompound(el, chain[chain.length - 1])) return false;
    let i = chain.length - 2, x = el.parentNode;
    while (i >= 0 && x) { if (x.nodeType === 1 && matchCompound(x, chain[i])) i--; x = x.parentNode; }
    return i < 0;
  });
}
class Element extends Node {
  constructor(doc, tag) { super(doc); this.nodeType = 1; this.tagName = tag.toUpperCase(); this._attrs = new Map(); this._listeners = new Map(); }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; }
  setAttribute(n, v) { this._attrs.set(n, String(v)); }
  removeAttribute(n) { this._attrs.delete(n); }
  hasAttribute(n) { return this._attrs.has(n); }
  get id() { return this.getAttribute('id') || ''; }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'OPTION') return this.hasAttribute('value') ? this.getAttribute('value') : this.textContent;
    return this.getAttribute('value') || '';
  }
  set value(v) { this._value = String(v); }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn); this.ownerDocument._withListeners.add(this);
  }
  removeEventListener(type, fn) { const s = this._listeners.get(type); if (s) s.delete(fn); }
  listenerCount() { let n = 0; this._listeners.forEach((s) => { n += s.size; }); return n; }
  dispatchEvent(ev) {
    ev.target = this;
    for (let x = this; x && x.nodeType === 1; x = x.parentNode) {
      const s = x._listeners.get(ev.type);
      if (s) { ev.currentTarget = x; for (const fn of [...s]) fn.call(x, ev); }
      if (!ev.bubbles || ev._stop) break;
    }
    return !ev.defaultPrevented;
  }
  focus() { const d = this.ownerDocument; if (d.body.contains(this) && !this.disabled) d.activeElement = this; }
  blur() { const d = this.ownerDocument; if (d.activeElement === this) d.activeElement = d.body; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  matches(sel) { return matches(this, sel); }
  closest(sel) { for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (matches(x, sel)) return x; return null; }
  querySelectorAll(sel) {
    const out = [];
    (function walk(n) { for (const c of n.childNodes) if (c.nodeType === 1) { if (matches(c, sel)) out.push(c); walk(c); } })(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
class Document extends Node {
  constructor() {
    super(null); this.ownerDocument = this; this._withListeners = new Set();
    this.documentElement = new Element(this, 'html'); this.appendChild(this.documentElement);
    this.body = new Element(this, 'body'); this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
    this.defaultView = { AbortController: globalThis.AbortController };
  }
  createElement(tag) { return new Element(this, tag); }
  createTextNode(t) { return new Text(this, t); }
  querySelectorAll(sel) { return this.documentElement.querySelectorAll(sel); }
  querySelector(sel) { return this.documentElement.querySelector(sel); }
  totalListeners() { let n = 0; this._withListeners.forEach((el) => { n += el.listenerCount(); }); return n; }
}
module.exports = { Document, Event, Element };
