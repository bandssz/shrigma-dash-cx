#!/usr/bin/env python3
"""Disposable PG17 + compiled Listmonk + real template HTTP, zero SMTP messages."""
import argparse,hashlib,importlib.util,json,os,shutil,socket,subprocess,tempfile,time
from pathlib import Path

def port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1',0));return probe.getsockname()[1]

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--package',type=Path,required=True);parser.add_argument('--pg-bin',type=Path,required=True);parser.add_argument('--node-path',required=True);parser.add_argument('--receipt',type=Path,required=True);args=parser.parse_args()
    assert os.environ.get('GRAPH_CACHE_NATIVE_PROOF_ISOLATED')=='1','Explicit disposable opt-in required';repo=Path(__file__).resolve().parents[2];package=args.package.resolve(strict=True);pg=args.pg_bin.resolve(strict=True);receipt=args.receipt.resolve();receipt.parent.mkdir(parents=True,exist_ok=True);assert not receipt.exists()
    manifest=json.loads((package/'manifest.json').read_text());binary=package/'candidate/listmonk';assert hashlib.sha256(binary.read_bytes()).hexdigest()==manifest['binary_sha256'];assert manifest['graph_cache_enabled_by_default'] is False
    spec=importlib.util.spec_from_file_location('native_helper',repo/'tools/listmonk-regular-build/native_proof.py');helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
    run=Path(tempfile.mkdtemp(prefix='graph-cache-native-',dir=receipt.parent));os.chmod(run,0o700);data=run/'data';sock=Path(tempfile.mkdtemp(prefix='graph-cache-native-',dir='/private/tmp' if Path('/private/tmp').is_dir() else tempfile.gettempdir()));db_port,http_port=port(),port();assert db_port!=5432 and db_port!=http_port
    report={'schema':'crm-graph-real-http-cache-native-v1','success':False,'production_changed':False,'postgres':'17.10','binary_sha256':manifest['binary_sha256'],'runtime_sha256':manifest['graph_cache_runtime_sha256'],'smtp_calls':0,'customer_sends':0,'cluster_stopped':False,'database_removed':False,'proof_directory':str(run)}
    env=helper.clean_env({'NODE_PATH':args.node_path,'TEST_DATABASE_URL':f'postgresql://crm_shadow@127.0.0.1:{db_port}/listmonk','GRAPH_CACHE_NATIVE_PROOF_ISOLATED':'1','GRAPH_NATIVE_REPO':str(repo),'GRAPH_NATIVE_BINARY_SHA':manifest['binary_sha256'],'GRAPH_NATIVE_RUNTIME_SHA':manifest['graph_cache_runtime_sha256'],'GRAPH_NATIVE_HTTP_ORIGIN':f'http://127.0.0.1:{http_port}'})
    fixture=repo/'tests/journey-graph-cache-native-fixture.cjs';started=False;worker=None;worker_log=None
    def db(sql,database='listmonk'):
        db_env=dict(env,TEST_DATABASE_URL=f'postgresql://crm_shadow@127.0.0.1:{db_port}/{database}');result=subprocess.run(['node','-e',helper.NODE_DB],input=sql,text=True,env=db_env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30);assert result.returncode==0,result.stderr[-4000:];return result.stdout
    def phase(mode):
        result=subprocess.run(['node',str(fixture),mode],cwd=repo,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=45);(run/(mode+'.log')).write_text(result.stdout+result.stderr);assert result.returncode==0,result.stderr[-4000:];return json.loads(result.stdout.strip())
    try:
        with (run/'init.log').open('wb') as log:subprocess.run([str(pg/'initdb'),'-D',str(data),'-U','crm_shadow','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--locale=C','--no-sync'],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=30)
        with (run/'lifecycle.log').open('wb') as log:subprocess.run([str(pg/'pg_ctl'),'-D',str(data),'-l',str(run/'postgres.log'),'-o',f'-h 127.0.0.1 -k {sock} -p {db_port}','-w','-t','15','start'],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=20)
        started=True;db('CREATE DATABASE listmonk','postgres');db((package/'source/listmonk/schema.sql').read_text()+"\nINSERT INTO settings(key,value) VALUES('migrations','[\"v6.1.0\"]');")
        with helper.NativeSMTP() as smtp:
            db(helper.settings_sql(smtp.port,http_port));base_env=dict(env,CRM_AUDIENCE_TEST_ISOLATED='1');base=subprocess.run(['node',str(repo/'tests/segment-regular-native-fixture.cjs'),'prepare'],cwd=repo,env=base_env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=45);(run/'regular-base.log').write_text(base.stdout+base.stderr);assert base.returncode==0,base.stderr[-4000:];report['regular_native_schema_prepared']=True;report['prepare']=phase('prepare');config=run/'config.toml';config.write_text(helper.config(db_port,http_port));worker_log=(run/'worker.log').open('wb')
            worker=subprocess.Popen([str(binary),'--config',str(config),'--passive'],cwd=run,env=helper.clean_env({'CRM_GRAPH_CACHE_ENABLED':'true','CRM_GRAPH_CACHE_TARGET':'native-proof-cache'}),stdout=worker_log,stderr=subprocess.STDOUT)
            deadline=time.monotonic()+15
            while time.monotonic()<deadline:
                assert worker.poll() is None,'Worker exited before HTTP startup'
                try:
                    with socket.create_connection(('127.0.0.1',http_port),timeout=.2):break
                except OSError:time.sleep(.1)
            else:raise RuntimeError('HTTP startup unavailable')
            report['proof']=phase('clones');assert worker.poll() is None;assert smtp.messages==[];report['success']=True
    finally:
        if worker is not None and worker.poll() is None:
            worker.terminate()
            try:worker.wait(timeout=8)
            except subprocess.TimeoutExpired:worker.kill();worker.wait(timeout=5)
        if worker_log:worker_log.close()
        if started:
            result=subprocess.run([str(pg/'pg_ctl'),'-D',str(data),'-m','fast','-w','-t','15','stop'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=20);report['cluster_stopped']=result.returncode==0
        if report['cluster_stopped']:
            shutil.rmtree(data);shutil.rmtree(sock);report['database_removed']=True
        with receipt.open('x') as out:json.dump(report,out,indent=2,sort_keys=True);out.write('\n')
        os.chmod(receipt,0o600)
        for item in run.iterdir():
            if item.is_file():os.chmod(item,0o600)
    print(json.dumps(report,sort_keys=True))

if __name__=='__main__':main()
