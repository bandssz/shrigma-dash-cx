'use strict';
// Pure source transformation; only the existing exact upstream hash is accepted.
const fs=require('node:fs');
const {patchSource}=require('../../n8n/growth/ab-listmonk-cohort-patch.cjs');
if(process.argv.length!==4)throw Error('Expected upstream query and new output paths');
const input=fs.readFileSync(process.argv[2],'utf8');
const result=patchSource(input);
fs.writeFileSync(process.argv[3],result.source,{flag:'wx',mode:0o600});
process.stdout.write(JSON.stringify({upstream:result.upstream,source_sha256:result.source_sha256,patched_sha256:result.patched_sha256,changed_queries:result.changed_queries})+'\n');
