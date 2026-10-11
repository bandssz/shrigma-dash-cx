#!/usr/bin/env python3
"""Isolated ORIGINAL PG17.10 dependency install only. No worker, SMTP or acceptance."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile

HERE=Path(__file__).resolve().parent
REPO=HERE.parent.parent

def require(ok, message):
    if not ok:raise RuntimeError(message)

def command(args,env,cwd=None,timeout=30):
    r=subprocess.run([str(x) for x in args],env=env,cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=timeout)
    require(len(r.stdout)+len(r.stderr)<262144,'Dependency output bound exceeded')
    require(r.returncode==0,'Original ephemeral dependency operation refused')
    return r.stdout

DEPENDENCY_SQL_CLIENT = r"""
'use strict';
const MAX_SQL_BYTES = 1048576 + 256;
const refused = () => {
  process.stderr.write('EPHEMERAL_DEPENDENCY_CLIENT_REFUSED\n');
  process.exitCode = 1;
};
(async () => {
  let client = null, succeeded = false, ended = false, failed = false;
  try {
    const uri = process.env.TEST_DATABASE_URL;
    const u = new URL(uri || 'http://invalid');
    if (u.protocol !== 'postgresql:' || u.hostname !== '127.0.0.1' ||
        !/^\d{1,5}$/.test(u.port) || Number(u.port) < 1 || Number(u.port) > 65535 || u.port === '5432' ||
        !['/postgres', '/listmonk'].includes(u.pathname) || u.username !== 'postgres' ||
        u.password !== '' || u.search !== '' || u.hash !== '') throw Error('refused');
    if (require('pg/package.json').version !== '8.23.1') throw Error('refused');
    const {Client} = require('pg');
    let size = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_SQL_BYTES) throw Error('refused');
      chunks.push(chunk);
    }
    if (size === 0) throw Error('refused');
    const sql = Buffer.concat(chunks).toString('utf8');
    client = new Client({connectionString: uri});
    client.on('error', () => { failed = true; });
    await client.connect();
    const version = await client.query('SHOW server_version');
    if (version.command !== 'SHOW' || version.rows.length !== 1 ||
        typeof version.rows[0].server_version !== 'string' ||
        !/^17\.10(?:\D|$)/.test(version.rows[0].server_version)) throw Error('refused');
    await client.query(sql);
    if (failed) throw Error('refused');
    succeeded = true;
  } catch {
    failed = true;
  } finally {
    if (client) {
      try { await client.end(); ended = true; } catch { failed = true; }
    }
  }
  if (!succeeded || failed || !ended) { refused(); return; }
  process.stdout.write(JSON.stringify({ok:true,postgresVersion:'17.10',clientEnded:true}));
})().catch(refused);
"""

def run(profile,profile_sha256,pg_bin,source_dir,runtime_dir,node_path,report):
    require(os.environ.get('REGULAR_NATIVE_PROOF_ISOLATED')=='1','Explicit isolated opt-in required')
    require(re.fullmatch('[a-f0-9]{64}',profile_sha256),'Exact profile SHA required')
    env={k:v for k,v in os.environ.items() if k in ('PATH','HOME','TMPDIR','LANG','LC_ALL')}
    metadata=json.loads(command(['node',HERE/'native_batch_profile.cjs','--source-only',profile,profile_sha256],env))
    require(metadata['workerTransaction']=={'jit':'off','scope':'transaction-local'},'Exact optional source profile required')
    require(not report.exists() and not report.is_symlink(),'Fresh proof report required')
    require(runtime_dir.is_dir() and not runtime_dir.is_symlink(),'Private existing runtime directory required')
    require(pg_bin.is_dir() and not pg_bin.is_symlink(),'Pinned PG binary directory required')
    version=command([pg_bin/'postgres','--version'],env,timeout=5)
    require(re.fullmatch(r'postgres \(PostgreSQL\) 17\.10(?:[^\n]*)\n?',version),'Actual PostgreSQL17.10 required; never patch server_version')
    schema=source_dir/'schema.sql'
    require(schema.is_file() and not schema.is_symlink() and schema.stat().st_size<1048576,'Original native schema required')
    require(node_path and all(Path(n).is_dir() for n in node_path.split(os.pathsep)),'Existing pinned Node dependencies required')
    require(os.getuid()!=0,'Ephemeral PostgreSQL cannot run as root')
    run_dir=Path(tempfile.mkdtemp(prefix='batch-dependency-proof-',dir=runtime_dir));data=run_dir/'data'
    socket_root=Path('/private/tmp') if Path('/private/tmp').is_dir() else Path('/tmp')
    socket_dir=Path(tempfile.mkdtemp(prefix='batch-dependency-socket-',dir=socket_root))
    with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
    started=False;start_attempted=False;stopped=False;phase='initdb';result=None
    receipt={'schema':'shrigma-native-batch-dependency-install-proof-v3','status':'FAILED','localDisposable':True,
             'querySha256':metadata['querySha256'],'kernelSha256':metadata['kernelSha256'],
             'workerTransactionSha256':metadata['workerTransactionSha256'],'schemaSha256':hashlib.sha256(schema.read_bytes()).hexdigest(),
             'originalDependencyPins':metadata['additionalSqlSources'],'performanceAccepted':False,
             'workerExecuted':False,'smtpStarted':False,'productionChanged':False,'operational':False}
    try:
        command([pg_bin/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--locale=C','--no-sync'],env)
        phase='start';start_attempted=True;command([pg_bin/'pg_ctl','-D',data,'-l',run_dir/'server.log','-o',f'-h 127.0.0.1 -k {socket_dir} -p {port}','-w','-t','15','start'],env);started=True
        def sql(text,database='listmonk'):
            require(database in ('postgres','listmonk') and isinstance(text,str)
                    and 0<len(text.encode('utf8'))<=1048576+256,'Original ephemeral SQL input refused')
            uri=f'postgresql://postgres@127.0.0.1:{port}/{database}'
            sql_env=dict(env,NODE_PATH=node_path,TEST_DATABASE_URL=uri)
            r=subprocess.run(['node','-e',DEPENDENCY_SQL_CLIENT],input=text,env=sql_env,text=True,
                             stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
            require(len(r.stdout)+len(r.stderr)<262144 and r.returncode==0 and not r.stderr,
                    'Original ephemeral SQL refused')
            try:ack=json.loads(r.stdout)
            except Exception:raise RuntimeError('Original ephemeral SQL protocol refused') from None
            require(ack=={'ok':True,'postgresVersion':'17.10','clientEnded':True},
                    'Original ephemeral SQL protocol refused')
        phase='schema';sql('CREATE DATABASE listmonk;','postgres');sql(schema.read_text()+"\nINSERT INTO settings(key,value) VALUES('migrations','[\"v6.1.0\"]');")
        phase='original-migrations'
        fixture_env=dict(env,NODE_PATH=node_path,TEST_DATABASE_URL=f'postgresql://postgres@127.0.0.1:{port}/listmonk',
                         CRM_AUDIENCE_TEST_ISOLATED='1',REGULAR_NATIVE_PROOF_ISOLATED='1',
                         REGULAR_NATIVE_BATCH_PROFILE=str(profile),REGULAR_NATIVE_BATCH_PROFILE_SHA256=profile_sha256)
        result=json.loads(command(['node',REPO/'tests/segment-regular-native-fixture.cjs','prepare-batch-dependencies'],fixture_env,timeout=60))
        require(result.get('ok') is True and result.get('dependencyOnly') is True and result.get('finalWorkerAndSourcesOff') is True,'Dependency-only preparation required')
        receipt['status']='PASSED_ORIGINAL_EPHEMERAL_DEPENDENCIES_ONLY';receipt['result']=result
    finally:
        if started or start_attempted:
            try:command([pg_bin/'pg_ctl','-D',data,'-m','immediate','-w','-t','15','stop'],env,timeout=20);stopped=True
            except Exception:
                receipt['stopFailed']=True
                status=subprocess.run([str(pg_bin/'pg_ctl'),'-D',str(data),'status'],env=env,
                    stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
                # Native pg_ctl status3 confirms no running postmaster after failed start/stop.
                stopped=status.returncode==3
                receipt['endObservedByStatus']=stopped
        receipt['clusterStopped']=stopped;receipt['phase']=phase
        report.parent.mkdir(parents=True,exist_ok=True);report.write_text(json.dumps(receipt,indent=2)+'\n')
        try:socket_dir.rmdir()
        except OSError:pass
    require(stopped,'Ephemeral cluster end must be confirmed')
    return receipt

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for n in ('profile','pg-bin','source-dir','runtime-dir','report'):p.add_argument('--'+n,required=True,type=Path)
    p.add_argument('--profile-sha256',required=True);p.add_argument('--node-path',required=True)
    a=p.parse_args();result=run(a.profile.resolve(),a.profile_sha256,a.pg_bin.resolve(),a.source_dir.resolve(),a.runtime_dir.resolve(),a.node_path,a.report.resolve())
    print(json.dumps({'status':result['status'],'clusterStopped':result['clusterStopped'],'operational':False}))
