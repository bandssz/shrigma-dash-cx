'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const dir=__dirname;
const read=name=>fs.readFileSync(path.join(dir,name),'utf8');

test('S3 maintenance image has immutable official bases and a closed two-file context',()=>{
 const dockerfile=read('Dockerfile.backup-s3'),ignore=read('Dockerfile.backup-s3.dockerignore');
 assert.match(dockerfile,/^FROM public\.ecr\.aws\/aws-cli\/aws-cli:2\.37\.7@sha256:[a-f0-9]{64} AS awscli$/m);
 assert.match(dockerfile,/^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}$/m);
 assert.match(dockerfile,/^COPY --from=awscli \/usr\/local\/aws-cli \/usr\/local\/aws-cli$/m);
 assert.match(dockerfile,/^COPY --chmod=0444 services\/dashboard-operational\/backup-identity\.cjs services\/dashboard-operational\/backup-s3\.cjs \.\/$/m);
 assert.match(dockerfile,/^USER 1000:1000$/m);
 assert.match(dockerfile,/^ENTRYPOINT \["node", "\/app\/backup-s3\.cjs"\]$/m);
 assert.doesNotMatch(dockerfile,/\b(?:ADD|RUN\s+(?:curl|wget|apt|apk)|COPY\s+\.)\b/i);
 assert.deepEqual(ignore.trim().split(/\r?\n/).filter(line=>line&&!line.startsWith('#')),[
  '**','!services/','!services/dashboard-operational/',
  '!services/dashboard-operational/backup-identity.cjs',
  '!services/dashboard-operational/backup-s3.cjs'
 ]);
});

test('S3 export and restore templates are one-shot and cannot mount a live identity volume',()=>{
 const exporting=read('compose.synthetic-s3-export.template.yml'),restoring=read('compose.synthetic-s3-restore.template.yml');
 for(const compose of [exporting,restoring]){
  assert.match(compose,/image: ghcr\.io\/bandssz\/shrigma-dash-backup-s3@sha256:/);
  assert.match(compose,/user: "1000:1000"/);
  assert.match(compose,/read_only: true/);
  assert.match(compose,/cap_drop: \[ALL\]/);
  assert.match(compose,/no-new-privileges:true/);
  assert.match(compose,/restart: "no"/);
  assert.match(compose,/replicas: 1/);
  assert.match(compose,/cpus: "0\.5"/);
  assert.match(compose,/memory: 512M/);
  assert.doesNotMatch(compose,/^\s*(?:ports|privileged|build|domain|deploy_key):/m);
  assert.doesNotMatch(compose,/dashboard-canary-identity|web-access|crm-(?:campaign|audience|panel-read|shopify-sync)/);
 }
 assert.match(exporting,/name: dashboard-canary-snapshot-drill-20260930-01/);
 assert.match(exporting,/target: \/backup-data\n\s*read_only: true/);
 assert.match(exporting,/command: \["export", "\/backup-data\/drill-20260930-01\/identity", "\/receipt-data\/synthetic-drill-20261002-01\.json"\]/);
 assert.doesNotMatch(restoring,/dashboard-canary-snapshot-drill-20260930-01|target: \/backup-data/);
 assert.match(restoring,/target: \/receipt-data\n\s*read_only: true/);
 assert.match(restoring,/name: dashboard-s3-restore-drill-20261002-01/);
});
