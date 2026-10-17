#!/usr/bin/env python3
"""Inert on import. Public hydration/compile, then five NEW bounded focal tests.

Only --prepare uses public archives and Go dependency download. --proof uses
the compiled real manager test executable, loopback PG/Mailpit and no tools
capable of contacting the original. Raw output remains bounded in RAM.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import time
from types import SimpleNamespace

HERE=Path(__file__).resolve().parent
EXPECTED={
 'TestPhysicalDrainAdmissionClosesBeforeWait',
 'TestPhysicalDrainProducerJoinAndWorkerJoin',
 'TestPhysicalDrainContextExpiryDoesNotDeclareDrained',
 'TestPhysicalDrainHTTPShutdownCannotUseTimeoutAsSuccess',
 'TestPhysicalDrainRealPoolLegacyGapAndProcessExit',
}
PATTERN='^('+'|'.join(sorted(EXPECTED))+')$'

def require(ok,code):
    if not ok:raise RuntimeError(code)

def body(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size<=2097152,'SOURCE_BOUND_REFUSED')
    return path.read_bytes()

def sha(data):return hashlib.sha256(data).hexdigest()

def binary_sha(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size<=268435456,'TEST_BINARY_BOUND_REFUSED')
    h=hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda:handle.read(1048576),b''):h.update(chunk)
    return h.hexdigest()

def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);obj=importlib.util.module_from_spec(spec);spec.loader.exec_module(obj);return obj

def call(argv,cwd,env,timeout):
    # No stdout/stderr is forwarded or put in an artifact.
    child=subprocess.Popen([str(x) for x in argv],cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    buffers={'stdout':bytearray(),'stderr':bytearray()};deadline=time.monotonic()+timeout
    sel=selectors.DefaultSelector()
    sel.register(child.stdout,selectors.EVENT_READ,'stdout');sel.register(child.stderr,selectors.EVENT_READ,'stderr')
    try:
        while sel.get_map():
            require(time.monotonic()<deadline,'PROCESS_TIMEOUT_REFUSED')
            for key,_ in sel.select(min(0.25,max(0,deadline-time.monotonic()))):
                chunk=os.read(key.fileobj.fileno(),16384)
                if not chunk:sel.unregister(key.fileobj);continue
                buffers[key.data].extend(chunk)
                require(sum(map(len,buffers.values()))<=1048576,'PROCESS_OUTPUT_BOUND_REFUSED')
        code=child.wait(timeout=max(0.01,deadline-time.monotonic()))
        return SimpleNamespace(returncode=code,stdout=bytes(buffers['stdout']),stderr=bytes(buffers['stderr']))
    except Exception:
        try:os.killpg(child.pid,signal.SIGKILL)
        except ProcessLookupError:pass
        child.wait(timeout=2)
        raise
    finally:
        sel.close();child.stdout.close();child.stderr.close()

def environment(args):
    # Do not propagate CI credentials, original configuration or arbitrary env.
    env={k:os.environ[k] for k in ('PATH',) if k in os.environ}
    env.update(HOME=str(args.out/'home'),GOCACHE=str(args.out/'go-cache'),
               GOMODCACHE=str(args.out/'go-mod-cache'),
               GOTOOLCHAIN='local',CGO_ENABLED='0',GOWORK=str(args.out/'go.work'))
    return env

def assets(repo):
    a=json.loads(body(HERE/'ASSETS.json'))
    require(a['schema']=='physical-drain-source-assets-v1','ASSETS_SCHEMA_REFUSED')
    for name,pin in a['files'].items():
        data=body(repo/name)
        require(len(data)==pin['bytes'] and sha(data)==pin['sha256'],'PUBLIC_SOURCE_PIN_REFUSED')
    return a

def common(args):
    require(os.getuid()==1000 and os.environ.get('PHYSICAL_DRAIN_FIXTURE_ISOLATED')=='1','ISOLATION_REFUSED')
    repo=args.repo_root.resolve(strict=True)
    require(not (repo/'.git').exists() and not (repo/'.private').exists(),'PUBLIC_SNAPSHOT_REFUSED')
    v=call(['node','-e',"if(process.version!=='v22.23.3'||process.getuid()!==1000)process.exit(1)"],repo,os.environ,10)
    require(v.returncode==0 and not v.stdout and not v.stderr,'NODE_RUNTIME_REFUSED')
    g=call([args.go,'version'],repo,os.environ,10)
    require(g.returncode==0 and g.stdout.startswith(b'go version go1.26.1 '),'GO_RUNTIME_REFUSED')
    return repo,assets(repo)

def prepare(args):
    repo,a=common(args)
    require(not args.out.exists(),'NEW_FIXTURE_REQUIRED')
    args.out.mkdir(mode=0o700)
    (args.out/'home').mkdir();(args.out/'go-cache').mkdir()
    packager=module('physical_public_extract',repo/'tools/listmonk-regular-package/build.py')
    packager.extract_source(args.inputs/'listmonk-upstream.tar.gz',args.out/'listmonk')
    packager.extract_smtp(args.inputs/'smtppool.zip',args.out/'smtppool')
    smtp_builder=module('physical_smtp_source',repo/'tools/listmonk-regular-build/build.py')
    smtp_builder.apply(args.out/'listmonk',args.out/'smtppool')
    worker=module('physical_worker_source',repo/'tools/listmonk-regular-build/worker_patch.py')
    profile=repo/'crm-scheduler-batch-profile.json'
    worker.apply(args.out/'listmonk',repo,profile,sha(body(profile)))
    # This test does not compile or repin the candidate executable. It installs
    # the exact candidate manager into the public hydrated test package, plus
    # test-only lifecycle. Other source helpers use the public current recipe.
    manager=args.out/'listmonk/internal/manager'
    (manager/'manager.go').write_bytes(body(HERE/'manager.candidate639.go'))
    for name in ('physical_drain_lifecycle.go','physical_drain_integration.go','physical_drain_lifecycle_test.go','physical_drain_native_test.go'):
        target=manager/name;require(not target.exists(),'DRAFT_OVERWRITE_REFUSED');target.write_bytes(body(HERE/'draft'/name))
    expected={
     'listmonk/internal/manager/manager.go':'fc57c5c7c5c1bda612e59506ca641e128bc3aebe3c06d62d441dcfbe47157b5a',
     'listmonk/internal/messenger/email/email.go':'7538708c2a1774ca0dacd81d4e6e7b21af68b62b16aca9fe019de8205241e265',
     'smtppool/pool.go':'277094a1b9b1dc266424d7505dfc88ca995f322cecd24fcfc81ddfc8fb9a63dd',
     'smtppool/guarded.go':'58d80921e19358e02cf7edb939c2a09a95e2ce1c785203cb5617005f5554ea92',
    }
    for path,pin in expected.items():require(sha(body(args.out/path))==pin,'REAL_PATH_SOURCE_PIN_REFUSED')
    (args.out/'go.work').write_text('go 1.26.1\n\nuse (\n ./listmonk\n ./smtppool\n)\n')
    env=environment(args);env.update(GOPROXY='https://proxy.golang.org',GOSUMDB='sum.golang.org')
    for path in ('listmonk','smtppool'):
        r=call([args.go,'mod','download'],args.out/path,env,180);require(r.returncode==0,'PUBLIC_GO_DEPENDENCY_REFUSED')
    env.update(GOPROXY='off',GOSUMDB='off')
    exe=args.out/'physical-drain.test'
    r=call([args.go,'test','-c','-o',exe,'./internal/manager'],args.out/'listmonk',env,180)
    require(r.returncode==0,'REAL_MANAGER_COMPILE_REFUSED')
    receipt={'schema':'physical-drain-test-compile-v1','assetsSha256':sha(body(HERE/'ASSETS.json')),
             'testExecutableSha256':binary_sha(exe), 'selectedManagerSha256':expected['listmonk/internal/manager/manager.go'],
             'fullCandidateBinaryCompiled':False,'originalCalls':0,'operational':False}
    (args.out/'compile.json').write_text(json.dumps(receipt)+'\n')

def proof(args,report):
    started=time.monotonic();repo,a=common(args)
    receipt=json.loads(body(args.out/'compile.json'));exe=args.out/'physical-drain.test'
    require(receipt['assetsSha256']==sha(body(HERE/'ASSETS.json')) and receipt['testExecutableSha256']==binary_sha(exe),'COMPILED_FIXTURE_PIN_REFUSED')
    env=environment(args);env.update(GOPROXY='off',GOSUMDB='off',PHYSICAL_DRAIN_FIXTURE_ISOLATED='1',
     PHYSICAL_DRAIN_FIXTURE_URL='postgresql://postgres@127.0.0.1:55432/listmonk',
     PHYSICAL_DRAIN_MAILPIT_SMTP='127.0.0.1:51025',PHYSICAL_DRAIN_MAILPIT_API='http://127.0.0.1:58025/api/v1/messages')
    # Run already compiled package tests: no download, old tests or worker main.
    remaining=60-(time.monotonic()-started)
    require(remaining>5,'PROOF_BUDGET_REFUSED')
    r=call([args.go,'tool','test2json','-t','-p','github.com/knadh/listmonk/internal/manager',exe,
            '-test.v','-test.count=1','-test.timeout=45s','-test.run='+PATTERN],args.out/'listmonk',env,remaining)
    try:events=[json.loads(x) for x in r.stdout.splitlines()]
    except Exception:raise RuntimeError('GO_JSON_REFUSED') from None
    passed={e.get('Test') for e in events if e.get('Action')=='pass' and e.get('Test')}
    require(r.returncode==0 and passed==EXPECTED and not any(e.get('Action') in ('fail','skip') for e in events),'FOCAL_CASE_REFUSED')
    report.update(ok=True,caseCount=5,passedNames=sorted(passed),executionSeconds=round(time.monotonic()-started,3),
                  realManagerRealPool=True,pgReadOnlyRollbackClientEndConfirmed=True,mailpitSyntheticMessages=1,
                  syntheticChildProcessExited=True,oldManagerCloseObservedBeforeSmtpDone=True,
                  proposedLifecycleUsedOnlyInFixture=True,fullCandidatePhysicalDrainProved=False)

def main():
    p=argparse.ArgumentParser();p.add_argument('mode',choices=('prepare','proof'))
    for name in ('repo-root','inputs','go','out','report'):p.add_argument('--'+name,type=Path,required=True)
    args=p.parse_args()
    report={'schema':'physical-drain-focal-source-proof-v1','ok':False,'caseCount':0,'phase':args.mode,
            'node':'v22.23.3','uid':os.getuid(),'originalCalls':0,'originalWrites':0,'operational':False,
            'candidateChanged':False,'originalPhysicalDrainProved':False}
    try:
        if args.mode=='prepare':prepare(args);report.update(ok=True,phase='compiled-not-executed')
        else:proof(args,report);report['phase']='complete'
    except Exception as exc:
        code=str(exc);report['refusalCode']=code if re.fullmatch('[A-Z0-9_]{1,80}',code) else 'FOCAL_SOURCE_REFUSED'
        report['exceptionType']=type(exc).__name__
    require(not args.report.exists(),'REPORT_EXISTS_REFUSED');args.report.parent.mkdir(parents=True,exist_ok=True)
    args.report.write_text(json.dumps(report,indent=2)+'\n');args.report.chmod(0o644)
    print(json.dumps({k:report[k] for k in ('ok','phase','caseCount','refusalCode') if k in report}))
    return 0 if report['ok'] else 1

if __name__=='__main__':raise SystemExit(main())
