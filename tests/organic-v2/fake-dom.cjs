'use strict';
// DOM mínimo em memória para testar o componente sem dependências (jsdom não está no contexto).
// Cobre só o que o componente usa: criação, árvore, atributos, propriedades de formulário,
// eventos com bolha, foco e seletores simples (tag, .classe, #id, [attr], [attr="v"], descendente).

class Node {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i < 0) throw new Error('not a child'); this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(v) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; if (v !== '') this.appendChild(this.ownerDocument.createTextNode(String(v))); }
}
class Text extends Node {
  constructor(doc, data) { super(doc); this.nodeType = 3; this.data = String(data); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}
const FORM_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']);
class Element extends Node {
  constructor(doc, tag) { super(doc); this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.attributes = new Map(); this.listeners = new Map(); this._value = undefined; this._disabled = false; }
  setAttribute(k, v) { this.attributes.set(String(k), String(v)); if (k === 'disabled') this._disabled = true; }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); if (k === 'disabled') this._disabled = false; }
  get id() { return this.getAttribute('id') || ''; }
  get className() { return this.getAttribute('class') || ''; }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'SELECT') { const o = this.querySelectorAll('option')[0]; return o ? o.value : ''; }
    return this.getAttribute('value') ?? '';
  }
  set value(v) { this._value = String(v); }
  get disabled() { return this._disabled; }
  set disabled(v) { this._disabled = !!v; if (v) this.attributes.set('disabled', ''); else this.attributes.delete('disabled'); }
  focus() { if (FORM_TAGS.has(this.tagName) || this.hasAttribute('tabindex')) this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  select() { this.ownerDocument.selected = this; }
  addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, []); const l = this.listeners.get(t); if (!l.includes(fn)) l.push(fn); }
  removeEventListener(t, fn) { const l = this.listeners.get(t); if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }
  listenerCount() { let n = 0; for (const l of this.listeners.values()) n += l.length; return n; }
  dispatchEvent(ev) {
    ev.target = ev.target || this; ev.defaultPrevented = false; let stop = false;
    ev.preventDefault = () => { ev.defaultPrevented = true; }; ev.stopPropagation = () => { stop = true; };
    for (let n = this; n && !stop; n = n.parentNode) { ev.currentTarget = n; for (const fn of (n.listeners?.get(ev.type) || []).slice()) fn.call(n, ev); if (ev.bubbles === false) break; }
    return !ev.defaultPrevented;
  }
  click() { if (this.disabled) return false; return this.dispatchEvent({ type: 'click' }); }
  matches(sel) { return sel.split(',').some(s => matchChain(this, s.trim().split(/\s+/))); }
  querySelectorAll(sel) { const out = []; const walk = n => { for (const c of n.childNodes) if (c.nodeType === 1) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function matchSimple(el, s) {
  const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g; let m, consumed = 0;
  while ((m = re.exec(s))) {
    consumed += m[0].length;
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && !el.className.split(/\s+/).includes(m[2])) return false;
    if (m[3] && el.id !== m[3]) return false;
    if (m[4] && (!el.hasAttribute(m[4]) || (m[5] !== undefined && el.getAttribute(m[4]) !== m[5]))) return false;
  }
  if (consumed !== s.length) throw new Error('seletor não suportado: ' + s);
  return true;
}
function matchChain(el, parts) {
  if (!matchSimple(el, parts[parts.length - 1])) return false;
  if (parts.length === 1) return true;
  for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) if (matchChain(p, parts.slice(0, -1))) return true;
  return false;
}
class Document {
  constructor() {
    this.body = new Element(this, 'body'); this.activeElement = this.body; this.selected = null;
    this.clipboardWrites = []; this.clipboardMode = 'ok';
    const self = this;
    this.defaultView = { AbortController, navigator: { clipboard: { writeText(t) { if (self.clipboardMode === 'fail') return Promise.reject(new Error('negado')); self.clipboardWrites.push(t); return Promise.resolve(); } } } };
  }
  createElement(t) { return new Element(this, t); }
  createTextNode(t) { return new Text(this, t); }
}
function setValue(el, v) { el.value = v; el.dispatchEvent({ type: 'input' }); }
function submit(form) { return form.dispatchEvent({ type: 'submit' }); }
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); await new Promise(r => setImmediate(r)); };
module.exports = { Document, Element, setValue, submit, flush };
