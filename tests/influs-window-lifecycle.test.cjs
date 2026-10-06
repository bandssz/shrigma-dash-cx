'use strict';
// Real LinkeDOM window events; real pagehide listener extracted from unchanged pinned HTML.
// Synthetic mount counters only. No network, transport, store, or component replacement.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
const html=fs.readFileSync(path.join(__dirname,'../influs.html'),'utf8');
test('Influs pagehide uses the real window event target and disposes the mounted presentation once',()=>{
 const {document,window}=parseHTML(html);let disposed=0;
 const listener=html.match(/window\.addEventListener\('pagehide',[^\n]+/);assert(listener,'real pinned pagehide listener is present');
 vm.runInContext(listener[0],vm.createContext({window,document,AFFILIATES_MOUNT:{dispose(){disposed++;}}}));
 assert.equal(disposed,0);window.dispatchEvent(new window.Event('unrelated'));assert.equal(disposed,0);
 window.dispatchEvent(new window.Event('pagehide'));window.dispatchEvent(new window.Event('pagehide'));assert.equal(disposed,1);
});
test('Influs pagehide without an admitted mount remains safe on the real window event target',()=>{
 const {document,window}=parseHTML(html);const listener=html.match(/window\.addEventListener\('pagehide',[^\n]+/);assert(listener);
 vm.runInContext(listener[0],vm.createContext({window,document,AFFILIATES_MOUNT:null}));assert.doesNotThrow(()=>window.dispatchEvent(new window.Event('pagehide')));
});
