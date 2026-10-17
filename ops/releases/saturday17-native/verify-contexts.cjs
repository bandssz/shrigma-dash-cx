'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),a=require('node:assert/strict'),root=__dirname;
const m=JSON.parse(fs.readFileSync(path.join(root,'source-contexts.json'))),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
a.equal(m.schema,'crm-native-internal-source-contexts-v1');a.equal(m.audienceBase,'a31b3949a38923439fb21d0dba58bbcb69a9af84');a.equal(m.campaignParent,'ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:da9225ca0674b6f20a50f179f2501b05d73f30995fb74d95fb6368bd792d1103');a.equal(m.audienceFiles.length,58);a.equal(m.campaignFiles.length,7);a.equal(m.installed,false);a.equal(m.preservedSenderAdmission,true);a.equal(m.preservedMedia,true);a.equal(m.preservedListmonkDatabase,true);
a.equal(m.audienceReturnFiles.length,56);a.equal(m.audienceReturnExactBase,true);
for(const [prefix,files]of [['audience-source',m.audienceFiles],['campaign-source',m.campaignFiles],['audience-return',m.audienceReturnFiles]])for(const f of files){a(!f.path.split('/').some(p=>p==='..'||p.startsWith('.')));const file=path.join(root,prefix,f.path);a(fs.lstatSync(file).isFile());const b=fs.readFileSync(file);a.equal(b.length,f.bytes,f.path);a.equal(sha(b),f.sha256,f.path);}
a.equal(fs.readFileSync(path.join(root,'campaign-source/Dockerfile'),'utf8').split('\n')[0],'FROM '+m.campaignParent);
for(const file of ['catalog-install.sql','catalog-return.sql','transition-install.sql','transition-return.sql']){const b=fs.readFileSync(path.join(root,file));a(b.length>100);a.match(b.toString(),/BEGIN;/);a.match(b.toString(),/COMMIT;/);}
console.log(JSON.stringify({schema:m.schema,audienceFiles:58,campaignPatchFiles:7,exactHashes:true,existingServicesOnly:true,productionChanged:false}));
