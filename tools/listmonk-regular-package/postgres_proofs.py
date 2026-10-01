#!/usr/bin/env python3
"""Run synthetic admission/lease/delivery proofs in a new loopback PG17 cluster."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile

REPO=Path(__file__).resolve().parents[2]
CASES=('admission','worker-lease','operation-guard','delivery','recovery')
PROOFS=tuple((case,f'tests/segment-regular-{case}-postgres.cjs') for case in CASES)+(
    ('binding-release','tests/segment-campaign-binding-release-postgres.cjs'),
)


def run(args):
    args.out.mkdir(parents=True,exist_ok=True)
    work=Path(tempfile.mkdtemp(prefix='regular-pg-',dir=args.out))
    sock=Path(tempfile.mkdtemp(prefix='regular-pg-'))
    with socket.socket() as probe:
        probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
    if port==5432:raise RuntimeError('Disposable port required')
    env=dict(os.environ,NODE_PATH=args.node_path,TEST_DATABASE_URL=f'postgresql://crm_shadow@127.0.0.1:{port}/listmonk',CRM_AUDIENCE_TEST_ISOLATED='1',AB_UPSTREAM_SOURCE=str(args.upstream_query))
    report={'schema':'regular-postgres-proof-v1','production_changed':False,'sends':0,'runs':[],'success':False}
    started=False
    try:
        with (work/'init.log').open('w') as log:
            subprocess.run([str(args.pg_bin/'initdb'),'-D',str(work/'data'),'-U','crm_shadow','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--locale=C','--no-sync'],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=30)
        with (work/'lifecycle.log').open('w') as log:
            subprocess.run([str(args.pg_bin/'pg_ctl'),'-D',str(work/'data'),'-l',str(work/'server.log'),'-o',f'-h 127.0.0.1 -k {sock} -p {port}','-w','-t','15','start'],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=20)
        started=True
        for case,script_path in PROOFS:
            script="const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.TEST_DATABASE_URL.replace('/listmonk','/postgres')});await c.connect();try{await c.query('DROP DATABASE IF EXISTS listmonk WITH (FORCE)');await c.query('DROP OWNED BY crm_audience_api').catch(()=>{});await c.query('DROP ROLE IF EXISTS crm_audience_api');await c.query('CREATE DATABASE listmonk');}finally{await c.end();}})().catch(e=>{console.error(e);process.exit(1)});"
            subprocess.run(['node','-e',script],env=env,check=True,timeout=20)
            path=work/(case+'.log')
            with path.open('w') as log:
                result=subprocess.run(['node',str(REPO/script_path)],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=180)
            body=path.read_text();item={'case':case,'exit_code':result.returncode,'log_sha256':hashlib.sha256(body.encode()).hexdigest()}
            report['runs'].append(item)
            if result.returncode:
                print(body[-6000:]);raise RuntimeError('Synthetic proof failed: '+case)
            print(body[-2500:])
        report['success']=True
    finally:
        if started:
            with (work/'lifecycle.log').open('a') as log:
                result=subprocess.run([str(args.pg_bin/'pg_ctl'),'-D',str(work/'data'),'-m','fast','-w','-t','15','stop'],stdout=log,stderr=subprocess.STDOUT,timeout=20)
            report['stopped']=result.returncode==0
        (args.out/'postgres-proof.json').write_text(json.dumps(report,indent=2)+'\n')
        try:sock.rmdir()
        except OSError:pass
    if not report.get('stopped'):raise RuntimeError('Postgres shutdown not confirmed')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('pg-bin','out','upstream-query'):parser.add_argument('--'+name,required=True,type=Path)
    parser.add_argument('--node-path',required=True)
    args=parser.parse_args();args.pg_bin=args.pg_bin.resolve();args.out=args.out.resolve();args.upstream_query=args.upstream_query.resolve();run(args)
