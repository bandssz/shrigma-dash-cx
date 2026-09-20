'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom'),Access=require('../influs-access.js');
const html=fs.readFileSync(require.resolve('../influs.html'),'utf8');
function page(){
 const {document}=parseHTML(html);
 Access.bind({document,host:document.querySelector('#influ-access'),readExisting:()=>'',writeExisting:()=>'',authorExisting:()=>'',onRead:()=>{throw Error('No network or operation permitted in section test');}});
 // Evaluate real style selectors against the DOM; linkedom has CSSOM but no layout engine.
 const rules=[...document.querySelectorAll('style')].flatMap(s=>Array.from(s.sheet.cssRules)).filter(r=>r.selectorText&&!r.selectorText.includes('::')&&r.style?.getPropertyValue('display'));
 const display=el=>rules.filter(r=>el.matches(r.selectorText)).reduce((_value,r)=>r.style.getPropertyValue('display'),'initial');
 const context=vm.createContext({document,SEC:'creators',$:s=>document.querySelector(s)});
 const start=html.indexOf("document.querySelectorAll('#secoes button').forEach(b=>b.onclick="),end=html.indexOf('\npintaMarca();',start);
 assert(start>=0&&end>start);vm.runInContext(html.slice(start,end),context);
 return {document,display,$:s=>document.querySelector(s)};
}
test('section visibility CSS keeps real secondary access, cancel and legacy buttons displayed',()=>{
 const p=page();p.$('#influ-access-form').hidden=false;
 const controls=[...p.document.querySelectorAll('button.btn.sec')];
 assert(controls.length>=5,'includes both access buttons, cancel and existing secondary actions');
 assert(controls.some(b=>b.dataset.influAccess==='read'));assert(controls.some(b=>b.dataset.influAccess==='write'));assert(controls.some(b=>b.id==='influ-access-cancel'));
 for(const button of controls)assert.notEqual(p.display(button),'none',button.id||button.textContent);
 assert.equal(p.display(p.$('#sec-creators')),'block');assert.equal(p.display(p.$('#sec-afil')),'none');
});
test('switching Creators/TikTok changes only the two panels and preserves secondary controls',()=>{
 const p=page(),unrelated=p.document.createElement('button');unrelated.className='btn sec ativa';unrelated.textContent='Unrelated active control';p.document.body.append(unrelated);
 for(const selected of ['afil','creators','afil']){
  p.$(`#secoes [data-s="${selected}"]`).click();
  for(const panel of ['creators','afil']){assert.equal(p.display(p.$('#sec-'+panel)),panel===selected?'block':'none');assert.equal(p.$(`#secoes [data-s="${panel}"]`).classList.contains('ativo'),panel===selected);}
  assert.equal(p.document.body.classList.contains('sec-afil'),selected==='afil');
  assert(unrelated.classList.contains('ativa'),'section switching must not clear unrelated state');
  for(const button of p.document.querySelectorAll('button.btn.sec'))assert.notEqual(p.display(button),'none',button.id||button.textContent);
 }
});
