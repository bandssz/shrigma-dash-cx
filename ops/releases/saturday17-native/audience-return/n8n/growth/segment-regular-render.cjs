'use strict';
// Conservative preflight; the pinned native worker is the authoritative Go
// template parser and applies the same function policy to its compiled AST.
const forbidden=Object.freeze(['Date','L','ago','date','date_in_zone','date_modify','now','htmlDate','htmlDateInZone','dateInZone','dateModify','randAlphaNum','randAlpha','randAscii','randNumeric','randBytes','randInt','shuffle','uuidv4','bcrypt','htpasswd','genPrivateKey','genCA','genCAWithKey','genSelfSignedCert','genSelfSignedCertWithKey','genSignedCert','genSignedCertWithKey','encryptAES']);
const blocked=new Set(forbidden);
function allowed(text){
 if(typeof text!=='string')return false;
 let i=0;
 while((i=text.indexOf('{{',i))!==-1){
  i+=2;let closed=false;
  while(i<text.length){
   if(text.startsWith('}}',i)){i+=2;closed=true;break;}
   if(text.startsWith('/*',i)){const end=text.indexOf('*/',i+2);if(end<0)return false;i=end+2;continue;}
   if(['"',"'",'`'].includes(text[i])){const quote=text[i++];let found=false;while(i<text.length){const c=text[i++];if(c===quote){found=true;break;}if(c==='\\'&&quote!=='`')i++;}if(!found)return false;continue;}
   if(/[A-Za-z_.$]/.test(text[i])){const start=i++;while(i<text.length&&/[A-Za-z0-9_.$]/.test(text[i]))i++;if(blocked.has(text.slice(start,i)))return false;continue;}
   i++;
  }
  if(!closed)return false;
 }
 return true;
}
function headersAllowed(headers){
 if(!Array.isArray(headers))return false;
 const seen=new Set();
 for(const set of headers){
  if(!set||typeof set!=='object'||Array.isArray(set))return false;
  for(const [name,value]of Object.entries(set)){
   const key=name.toLowerCase();
   if(!['reply-to','x-ses-configuration-set'].includes(key)||seen.has(key)||typeof value!=='string'||/[\x00-\x1f\x7f]/.test(value))return false;
   seen.add(key);
  }
 }
 return seen.has('reply-to');
}
function validate(snapshot){return snapshot?.media?.length===0&&[snapshot?.campaign?.subject,snapshot?.campaign?.body,snapshot?.campaign?.altbody??'',snapshot?.template?.body].every(allowed);}
module.exports={forbidden,allowed,headersAllowed,validate};
