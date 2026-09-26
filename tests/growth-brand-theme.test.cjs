'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {parseHTML}=require('linkedom');
const css=fs.readFileSync(require.resolve('../growth-workspace.css'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
// Read only body-level variable rules; no simulated layout or browser claims.
const themes=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([,selector,body])=>({selector:selector.trim(),body})).filter(r=>/^body(?:\[[^\]]+\])+$/.test(r.selector));
function tokens(panel,brand){
 const {document}=parseHTML(`<html><body data-panel="${panel}" data-marca="${brand}"></body></html>`),out={};
 for(const r of themes)if(document.body.matches(r.selector))for(const [,key,value] of r.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))out[key]=value.trim();
 return out;
}
function luminance(hex){
 const raw=hex.slice(1),full=raw.length===3?[...raw].map(c=>c+c).join(''):raw;
 assert.match(full,/^[a-f0-9]{6}$/i);
 return full.match(/../g).map(x=>parseInt(x,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
}
function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
test('brand changes select isolated CRM tokens while other panels and status semantics stay untouched',()=>{
 const fish=tokens('growth','fish'),aristo=tokens('growth','aristo'),all=tokens('growth','todas'),olivas=tokens('growth','olivas');
 assert.equal(fish['--crm-accent'],'#1a1c2e');assert.equal(aristo['--crm-accent'],'#0c3c21');
 assert.equal(fish['--crm-sidebar-bg'],'#f8f9fa');assert.equal(aristo['--crm-sidebar-bg'],'#0c3c21');assert.equal(aristo['--fundo'],'#f7f4ec');
 assert.equal(all['--crm-accent'],'#244b73');assert.equal(olivas['--crm-accent'],'var(--marca-texto)');
 for(const panel of ['cx','organico','influs'])for(const brand of ['fish','aristo','olivas'])assert.deepEqual(tokens(panel,brand),{});
 for(const theme of [fish,aristo,all,olivas]){
  assert.equal(theme['--fundo'],theme===aristo?'#f7f4ec':'#fff');assert.equal(theme['--texto'],'#202d3a');
  for(const key of ['--ruim','--ruim-bg','--bom','--bom-bg'])assert.equal(theme[key],undefined);
 }
 for(const rule of themes.filter(r=>r.selector.includes('data-marca'))){
  const declarations=rule.body.split(';').map(x=>x.trim()).filter(Boolean);
  assert.ok(declarations.every(x=>x.startsWith('--')),'brand rules may only choose tokens, never visibility or layout');
 }
});
test('brand text, selection, primary action and focus colors retain readable contrast',()=>{
 for(const brand of ['fish','aristo','todas']){
  const t=tokens('growth',brand),accent=t['--crm-accent'],sidebar=t['--crm-sidebar-bg'];
  const resolve=v=>v.startsWith('var(')?resolve(t[v.slice(4,-1)]):v;
  for(const bg of [t['--fundo'],t['--crm-accent-bg'],t['--crm-hover-bg'],'#fff'])assert.ok(contrast(accent,bg)>=4.5,`${brand}: accent on ${bg}`);
  for(const fg of [t['--texto'],t['--mudo'],t['--rotulo']])for(const bg of [t['--fundo'],t['--crm-hover-bg'],'#fff'])assert.ok(contrast(fg,bg)>=4.5,`${brand}: ${fg} on ${bg}`);
  for(const token of ['--crm-sidebar-ink','--crm-sidebar-soft','--crm-wordmark-ink'])assert.ok(contrast(resolve(t[token]),sidebar)>=4.5,`${brand}: ${token} on sidebar`);
  for(const state of ['hover','active'])assert.ok(contrast(resolve(t[`--crm-nav-${state}-ink`]),resolve(t[`--crm-nav-${state}-bg`]))>=4.5,`${brand}: ${state} navigation`);
  assert.ok(contrast('#fff',accent)>=4.5,`${brand}: primary button label`);
  assert.ok(contrast(accent,t['--card-2'])>=3,`${brand}: focus outline`);
 }
});
