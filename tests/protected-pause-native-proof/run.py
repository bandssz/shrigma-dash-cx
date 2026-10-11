#!/usr/bin/env python3
"""Source-only actual Manager/pipe/cmd tests; no SMTP, SQL or worker start."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

HERE = Path(__file__).resolve().parent
MANAGER_EXPECTED = {
 'TestRegularPauseQueueGate','TestRegularPauseSubscriberGate','TestRegularPausePreflight',
 'TestRegularPauseClosedTypedError','TestRegularPauseContextClass','TestRegularPauseCleanupSingleWrite',
 'TestRegularPauseFinalizeCleanupNoRetry','TestRegularPauseClaimReasonClosed',
}
BEFORE_EXPECTED = {'TestRegularPauseQueueGate','TestRegularPauseSubscriberGate','TestRegularPausePreflight'}
CMD_EXPECTED = {'TestRegularPauseQuarantineClosed','TestRegularPauseQuarantineRefusesUntrusted'}



def require(value, code):
    if not value:
        raise RuntimeError(code)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def read(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 1048576,
            'SOURCE_BOUND_REFUSED')
    return path.read_bytes()


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def command(argv, cwd, env, timeout=180):
    value = subprocess.run([str(x) for x in argv], cwd=cwd, env=env,
                           timeout=timeout, capture_output=True)
    require(len(value.stdout) + len(value.stderr) <= 1048576, 'GO_OUTPUT_BOUND_REFUSED')
    return value


def test(args, package, expected, env):
    result = command([args.go, 'test', '-json', '-count=1', '-timeout=30s',
                      '-run', args.pattern, *(package if isinstance(package, list) else [package])], args.cwd, env)
    require(not result.stderr, 'GO_STDERR_REFUSED')
    try:
        events = [json.loads(x) for x in result.stdout.splitlines()]
    except Exception:
        raise RuntimeError('GO_JSON_REFUSED') from None
    require(events and all(isinstance(x, dict) for x in events), 'GO_JSON_REFUSED')
    passed = {x.get('Test') for x in events if x.get('Action') == 'pass' and x.get('Test') and '/' not in x['Test']}
    require(result.returncode == 0 and passed == expected
            and not any(x.get('Action') in ('fail', 'skip') for x in events), 'FOCAL_CASE_REFUSED')
    return sorted(passed)


def run(args, report):
    report['phase'] = 'isolation'
    require(os.getuid() == 1000 and os.environ.get('PROTECTED_PAUSE_PROOF_ISOLATED') == '1', 'ISOLATION_REFUSED')
    # Workflow creates a fresh network namespace, enables only lo, then drops
    # to UID1000. No default route may exist; synthetic SMTP still needs lo up.
    routes = Path('/proc/net/route').read_text().splitlines()[1:]
    require(not any(len(x.split()) >= 2 and x.split()[1] == '00000000' for x in routes), 'EGRESS_ROUTE_REFUSED')
    repo = args.repo_root.resolve(strict=True)
    require(not (repo / '.git').exists() and not (repo / '.private').exists(), 'PUBLIC_SNAPSHOT_REFUSED')
    report['phase'] = 'runtime'
    node = command(['node', '-e', "if(process.version!=='v22.23.3'||process.getuid()!==1000)process.exit(1)"], repo, os.environ, 10)
    require(node.returncode == 0 and not node.stdout and not node.stderr, 'NODE_RUNTIME_REFUSED')
    version = command([args.go, 'version'], repo, os.environ, 10)
    require(version.returncode == 0 and version.stdout.decode().startswith('go version go1.26.1 '), 'GO_RUNTIME_REFUSED')
    report['phase'] = 'source-pins'
    assets = json.loads(read(HERE / 'ASSETS.json'))
    require(assets['schema'] == 'protected-pause-focal-assets-v1', 'ASSETS_REFUSED')
    for name, pin in assets['files'].items():
        body = read(repo / name)
        require(len(body) == pin['bytes'] and digest(body) == pin['sha256'], 'SOURCE_PIN_REFUSED')
    report['sourcePinsVerified'] = True
    require(not args.out.exists(), 'NEW_OUTPUT_REQUIRED')
    args.out.mkdir(mode=0o700)
    report['phase'] = 'public-hydration'
    packager = module('guarded_public_reader', repo / 'tools/listmonk-regular-package/build.py')
    packager.extract_source(args.inputs / 'listmonk-upstream.tar.gz', args.out / 'listmonk')
    packager.extract_smtp(args.inputs / 'smtppool.zip', args.out / 'smtppool')
    smtp = module('guarded_source_builder', repo / 'tools/listmonk-regular-build/build.py')
    smtp.apply(args.out / 'listmonk', args.out / 'smtppool')
    report['phase'] = 'worker-source-composition'
    profile = repo / 'crm-scheduler-batch-profile.json'
    profile_sha = digest(read(profile))
    worker = module('guarded_manager_builder', repo / 'tools/listmonk-regular-build/worker_patch.py')
    composed = worker.apply(args.out / 'listmonk', repo, profile, profile_sha)
    # Builders above enforce their exact official-source and integrated lock
    # hashes. New files must also appear, byte-identical, in actual packages.
    source_to_hydrated = {
        'tools/listmonk-regular-build/overlay/listmonk/internal/manager/regular_delivery.go':'listmonk/internal/manager/regular_delivery.go',
        'tools/listmonk-regular-build/overlay/listmonk/internal/manager/regular_pause_diagnostic.go':'listmonk/internal/manager/regular_pause_diagnostic.go',
        'tools/listmonk-regular-build/overlay/listmonk/internal/manager/regular_pause_diagnostic_test.go':'listmonk/internal/manager/regular_pause_diagnostic_test.go',
        'tools/listmonk-regular-build/overlay/listmonk/cmd/manager_store_pause_diagnostic.go':'listmonk/cmd/manager_store_pause_diagnostic.go',
        'tools/listmonk-regular-build/overlay/listmonk/cmd/manager_store_pause_diagnostic_test.go':'listmonk/cmd/manager_store_pause_diagnostic_test.go',
    }
    for source, hydrated in source_to_hydrated.items():
        require(read(repo / source) == read(args.out / hydrated), 'HYDRATED_SOURCE_REFUSED')
    report['profileSha256'] = profile_sha
    report['querySha256'] = digest(read(args.out / 'listmonk/queries/campaigns.sql'))
    report['graphRuntimeSha256'] = composed['graph_cache_runtime_sha256']
    work = args.out / 'go.work'
    work.write_text('go 1.26.1\n\nuse (\n ./listmonk\n ./smtppool\n)\n')
    env = dict(os.environ, GOWORK=str(work.resolve()), GOTOOLCHAIN='local', GOPROXY='off', GOSUMDB='off', CGO_ENABLED='0')
    for name in ('GOOS', 'GOARCH', 'GOFLAGS'):
        env.pop(name, None)
    require(report['querySha256'] == '772efe8e05331fb201ed24cb08bb97a4625a49811d96622c2148342ce54c6700','QUERY_DRIFT_REFUSED')
    args.cwd = args.out / 'listmonk'
    report['testsStarted'] = True
    originals = {str(path):read(path) for path in (args.cwd/'internal/manager/pipe.go',args.cwd/'internal/manager/regular_delivery.go')}
    report['phase'] = 'before-real-manager-silent-refusal'
    try:
        (args.cwd/'internal/manager/pipe.go').write_bytes(read(HERE/'fixtures/pipe.before.go'))
        (args.cwd/'internal/manager/regular_delivery.go').write_bytes(read(HERE/'fixtures/regular_delivery.before.go'))
        before=command([args.go,'test','-json','-count=1','-timeout=30s','-run','^TestRegularPause(QueueGate|SubscriberGate|Preflight)$','./internal/manager'],args.cwd,env)
        require(not before.stderr,'BEFORE_GO_STDERR_REFUSED')
        events=[json.loads(x) for x in before.stdout.splitlines()]
        failed={x.get('Test') for x in events if x.get('Action')=='fail' and x.get('Test')}
        markers=sum('FINITE_PAUSE_MARKER_MISSING' in x.get('Output','') for x in events)
        require(before.returncode != 0 and failed==BEFORE_EXPECTED and markers==3
                and not any(x.get('Action')=='skip' for x in events),'BEFORE_EXPECTED_FAILURE_REFUSED')
        report['beforeFailedNames']=sorted(failed)
    finally:
        for path,body in originals.items(): Path(path).write_bytes(body)
    report['phase'] = 'after-real-manager-finite-refusal'
    args.pattern = '^TestRegularPause'
    report['managerPassedNames'] = test(args,'./internal/manager',MANAGER_EXPECTED,env)
    report['phase'] = 'committed-quarantine-shape'
    # The upstream cmd init reads config and can open real services before TestMain.
    # Execute the two byte-pinned diagnostic files, without upstream init.
    report['cmdProofScope'] = 'exact-public-files-without-upstream-init'
    report['cmdPassedNames'] = test(args,[
        './cmd/manager_store_pause_diagnostic.go',
        './cmd/manager_store_pause_diagnostic_test.go'],CMD_EXPECTED,env)
    report['phase'] = 'complete'
    report['behaviorCases'] = 10
    report['status'] = 'PASSED_FOCAL_SOURCE_ONLY_NOT_DEPLOYED'



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('repo-root', 'inputs', 'go', 'out', 'report'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    report = {'schema':'protected-pause-focal-proof-v1', 'status':'REFUSED', 'phase':'initial',
              'testsStarted':False, 'originalCalls':0, 'sqlCalls':0, 'workerStarted':False,
              'imageBuilt':False, 'productionChanged':False, 'operational':False,
              'smtpStarted':False, 'historicalCauseEstablished':False}
    try:
        run(args, report)
    except Exception as exc:
        report['status'] = 'FOCAL_PROOF_REFUSED'
        code = str(exc)
        if re.fullmatch(r'[A-Z0-9_]{1,80}', code):
            report['refusalCode'] = code
        else:
            report['exceptionType'] = type(exc).__name__
    args.report.parent.mkdir(parents=True, exist_ok=True)
    require(not args.report.exists(), 'REPORT_ALREADY_EXISTS')
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    args.report.chmod(0o644)
    print(json.dumps({k:report[k] for k in ('status','phase','testsStarted','refusalCode','exceptionType') if k in report}))
    return 0 if report['status'] == 'PASSED_FOCAL_SOURCE_ONLY_NOT_DEPLOYED' else 1


if __name__ == '__main__':
    sys.exit(main())
