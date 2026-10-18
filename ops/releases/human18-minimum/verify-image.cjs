'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),a=require('node:assert/strict'),manifest=require('/proof/image-files.json'),mode=process.env.SOURCE_IMAGE_MODE;
a(['candidate','return'].includes(mode));a.equal(process.getuid(),1000);a.match(process.version,/^v22\./);
for(const f of manifest[mode==='return'?'returnFiles':'files']){const b=fs.readFileSync('/app/'+f.path);a.equal(b.length,f.bytes,f.path);a.equal(crypto.createHash('sha256').update(b).digest('hex'),f.sha256,f.path);}
const C=require('/app/n8n/growth/campaign-contract.js');a.equal(C.DRAFT_WRITES_ENABLED,mode==='candidate');a.equal(typeof require('/app/services/crm-campaign/transport.cjs').createExecutor,'function');a.equal(typeof require('/app/n8n/growth/campaign-native-internal.js').createNativeInternal,'function');
console.log(JSON.stringify({schema:'shrigma-human18-source-image-v1',mode,node:process.version,uid:process.getuid(),verifiedRuntimeFiles:manifest.files.length,productionUsed:false}));
