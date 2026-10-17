'use strict';
// Optional metadata only. The admitted TEST identity and plaintext descriptor
// remain unchanged. No credential, sender or template fallback is introduced.
const {createHash}=require('node:crypto');
const CONTRACT='journey-html-test-v1';
const TEMPLATE_BODY='{{ Safe .Tx.Data.test_html }}';
const TEMPLATE_SHA=createHash('sha256').update(TEMPLATE_BODY).digest('hex');
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function createHtmlBindingReader({baseBinding,env=process.env,readDescriptor}={}){
 if(!baseBinding||typeof baseBinding.getBinding!=='function'||typeof baseBinding.privateApi!=='function')throw Error('TEST_HTML_BINDING_CONFIG');
 function current(brand){
  try{
   const raw=readDescriptor?readDescriptor():env.DASHBOARD_JOURNEY_HTML_TEMPLATE;
   if(typeof raw!=='string'||Buffer.byteLength(raw)>2048)return null;
   const d=JSON.parse(raw),b=baseBinding.getBinding(brand);
   if(!d||Object.keys(d).sort().join(',')!=='contract,templateId,templateSha256'||d.contract!==CONTRACT||!Number.isSafeInteger(d.templateId)||d.templateId<1||d.templateSha256!==TEMPLATE_SHA||!b||b.brand!==brand||b.purpose!=='crm.journey-internal-test'||b.active!==true||b.txSend!==true||typeof b.revision!=='string'||!b.revision||!Number.isSafeInteger(b.templateId)||d.templateId===b.templateId)return null;
   return {base:b,descriptor:d,binding:{...b,format:'html',templateId:d.templateId,revision:digest([CONTRACT,b.revision,raw])}};
  }catch{return null;}
 }
 return Object.freeze({
  getBinding(brand){return current(brand)?.binding||null;},
  privateApi(binding){
   const c=current(binding?.brand);
   if(!c||binding.format!=='html'||binding.purpose!==c.binding.purpose||binding.templateId!==c.binding.templateId||binding.revision!==c.binding.revision||binding.active!==true||binding.txSend!==true)return null;
   const p=baseBinding.privateApi(c.base);
   if(!p||p.purpose!==c.base.purpose||p.revision!==c.base.revision)return null;
   return {...p,revision:c.binding.revision,templateId:c.descriptor.templateId,templateSha256:c.descriptor.templateSha256};
  }
 });
}
module.exports={createHtmlBindingReader,CONTRACT,TEMPLATE_BODY,TEMPLATE_SHA};
