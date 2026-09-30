'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{parseHTML}=require('linkedom'),M=require('../growth-media.js');
const url='https://cdn.shopify.com/s/files/1/123/files/example.jpg?v=123';
test('public image links permit known HTTPS image hosts and reject credentials, temporary links and executable or unrelated content',()=>{
 assert.equal(M.publicImage(url).host,'Shopify');assert.equal(M.publicImage('https://email.shrigma.com.br/uploads/image.png').host,'Listmonk');
 for(const value of ['http://cdn.shopify.com/s/files/a.jpg','https://cdn.shopify.com.evil.test/s/files/a.jpg','https://secret@cdn.shopify.com/s/files/a.jpg','https://cdn.shopify.com:444/s/files/a.jpg',url+'#secret',url+'&token=secret','https://email.shrigma.com.br/admin/a.jpg','https://email.shrigma.com.br/uploads/a.svg','https://cdn.shopify.com/s/files/a.html','javascript:alert(1)','data:image/png;base64,abc','https://example.test/x.jpg','https://cdn.shopify.com/s/files/a.jpg?X-Amz-Signature=x','https://cdn.shopify.com/s/files/a.jpg\n',null])assert.equal(M.publicImage(value),null,String(value));
 assert.match(M.snippet(url,'" onerror="bad <script>'),/alt="&quot; onerror=&quot;bad &lt;script&gt;"/);assert.doesNotMatch(M.snippet(url,'teste'),/<script|onload=/);
});
function boot(){const {document,window}=parseHTML('<html><body><section id="crm-media"></section></body></html>'),copies=[],context=vm.createContext({document,window,URL,navigator:{clipboard:{writeText:async x=>copies.push(x)}},fetch:()=>assert.fail('No transport in image preparation')});vm.runInContext(fs.readFileSync(path.join(__dirname,'../growth-media.js'),'utf8'),context);const api=vm.runInContext('GMedia',context);api.mount({marca:'fish'});return {document,window,api,copies,q:s=>document.querySelector(s)};}
test('brand changes preserve local fields separately without attaching a prior image or URL to the new brand',()=>{
 const x=boot(),field=x.q('#crm-media-url');field.value=url;x.q('#crm-media-alt').value='Peixe';field.dispatchEvent(new x.window.Event('input'));assert.equal(x.q('#crm-media-copy-html').disabled,false);x.api.mount({marca:'aristo'});assert.equal(field.value,'');assert.equal(x.q('#crm-media-copy-html').disabled,true);assert.match(x.q('#crm-media-brand').textContent,/O Aristocrata/);
 field.value='https://email.shrigma.com.br/uploads/aristo.png';x.api.mount({marca:'fish'});assert.equal(field.value,url);assert.equal(x.q('#crm-media-alt').value,'Peixe');x.api.mount({marca:'todas'});assert.equal(x.q('#crm-media-fields').disabled,true);assert.equal(field.value,'');assert.equal(x.copies.length,0);
});
test('copy generates escaped HTML and does not upload, save or send any message; preview is opt-in',async()=>{
 const x=boot();x.q('#crm-media-url').value=url;x.q('#crm-media-alt').value='<promoção>';x.q('#crm-media-url').dispatchEvent(new x.window.Event('input'));assert.equal(x.q('img'),null);x.q('#crm-media-copy-html').click();await new Promise(r=>setImmediate(r));assert.equal(x.copies.length,1);assert.match(x.copies[0],/alt="&lt;promoção&gt;"/);assert.equal(x.q('#crm-media-output').value,x.copies[0]);
 x.q('#crm-media-preview').click();const image=x.q('#crm-media-picture img');assert.ok(image);assert.equal(image.referrerPolicy,'no-referrer');assert.equal(image.crossOrigin,undefined,'public Listmonk images do not advertise CORS; a normal image preview must not require it');x.api.mount({marca:'aristo'});image.onload();assert.equal(x.q('#crm-media-status').textContent,'');assert.equal(x.q('img'),null);
 for(const a of x.document.querySelectorAll('a[target="_blank"]'))assert.equal(a.getAttribute('rel'),'noopener noreferrer');assert.match(x.q('#crm-media').textContent,/painel ainda não hospeda arquivos/);
});
test('image preparation belongs to Templates and remains available to the CRM manager',()=>{
 const {document}=parseHTML(fs.readFileSync(path.join(__dirname,'../growth.html'),'utf8'));assert.equal(document.querySelector('#crm-media').closest('.sec').id,'sec-templates');assert.equal(document.querySelector('#crm-media').closest('[data-crm-owner-only]'),null);
});
