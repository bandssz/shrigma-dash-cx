'use strict';
const a=require('node:assert/strict');
// Assert the stored native template using the ID returned by Listmonk. Native
// rendering itself is proved by the separate HTML/text preview and single TEST.
function assertSaved(c,brand,base){
 const domain=brand==='aristo'?'oaristocrata.com':'fishermans.com.br';
 for(const field of ['html','text']){
  const value=c.definition[field];a.equal(typeof value,'string');
  a.match(value,/\$\.Campaign\.ID/);a(!value.includes('SHRIGMA_NATIVE_CAMPAIGN_ID'));
  const matches=[...value.matchAll(/printf "%s%d%s" ("(?:[^"\\]|\\.)*") \$\.Campaign\.ID ("(?:[^"\\]|\\.)*")/g)];a(matches.length>0,'NATIVE_TRACKING_MISSING_'+field);
  for(const match of matches){const url=new URL(JSON.parse(match[1])+c.id+JSON.parse(match[2]));a.equal(url.hostname,domain);a.equal(url.pathname,'/collections/all');a.equal(url.searchParams.get('variant'),'42');a.equal(url.searchParams.get('utm_content'),'hero');a.equal(url.searchParams.get('utm_source'),'listmonk');a.equal(url.searchParams.get('utm_medium'),'campanha');a.equal(url.searchParams.get('utm_campaign'),c.definition.utm_campaign);a.equal(url.searchParams.get('utm_term'),'ensaio--lm-'+c.id+'-l'+base);}
 }
 a.match(c.definition.html,/TrackLink \(printf/);a.match(c.definition.text,/\{\{ Safe \(/);
 return{nativeCampaignId:true,html:true,text:true,variantPreserved:true,trackingPreserved:true};
}
module.exports={assertSaved};
