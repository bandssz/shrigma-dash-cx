'use strict';
function engagementNps(input,piece,config,sign) {
 const brand=String(input.brand||'').toLowerCase(),email=String(input.email||'').trim().toLowerCase();
 const ref=String(input.order_number||input.ref||'').trim();
 if(!['fish','aristo'].includes(brand)||!['nps-d0','nps-d3'].includes(piece)||!email||!ref)throw Error('NPS_INPUT_INVALID');
 const template_id=brand==='fish'?(piece==='nps-d0'?29:31):(piece==='nps-d0'?28:30);
 return {brand,email,ref,piece,tx:{subscriber_mode:'external',subscriber_email:email,template_id,from_email:config.FROM[brand],content_type:'html',data:{first_name:String(input.first_name||''),order_number:ref,nps_url:config.LP[brand],p:ref,e:email,s:sign(config.SECRET,ref,email)}}};
}
function engagementPopup(b,executionId) {
 const from=String(b.from_email||'');
 const brand=/(^|<)[^<>\s@]+@fishermans\.com\.br>?$/i.test(from)?'fish':/(^|<)[^<>\s@]+@oaristocrata\.com>?$/i.test(from)?'aristo':null;
 if(!brand)return null; // Preserve other brands on their existing route.
 const email=String(b.email||'').trim().toLowerCase();
 if(!/^\d+$/.test(String(executionId))||!email||Number(b.template_id)!==(brand==='fish'?23:22))throw Error('POPUP_INPUT_INVALID');
 return {brand,email,ref:'popup-execution:'+executionId,piece:'cupom-boas-vindas',tx:{subscriber_mode:'external',subscriber_email:email,template_id:Number(b.template_id),subject:b.name?String(b.name)+', aqui está o seu cupom!':'Aqui está o seu cupom!',from_email:from,content_type:'html',data:{first_name:String(b.name||''),checkout_url:String(b.checkout_url||'')}}};
}
if(typeof module!=='undefined')module.exports={engagementNps,engagementPopup};
