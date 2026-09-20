'use strict';
// Linkedom has no native top layer. This fixture only supplies dialog lifecycle;
// every acceptance still requires an explicit test click on the real UI button.
module.exports=function installDialog(document,window){
 const dialog=document.querySelector('[data-ce-confirm]'),messages=[];
 Object.defineProperty(dialog,'open',{configurable:true,get(){return this.hasAttribute('open');}});
 dialog.showModal=function(){if(this.open)throw Error('already open');this.setAttribute('open','');messages.push(document.querySelector('[data-ce-confirm-text]').textContent);};
 dialog.close=function(){this.removeAttribute('open');this.onclose?.(new window.Event('close'));};
 return {messages,accept:()=>document.querySelector('[data-ce-confirm-yes]').click(),cancel:()=>document.querySelector('[data-ce-confirm-no]').click(),escape:()=>dialog.oncancel?.(new window.Event('cancel',{cancelable:true})),close:()=>dialog.close(),dialog};
};
