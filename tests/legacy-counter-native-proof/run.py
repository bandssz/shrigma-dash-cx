#!/usr/bin/env python3
"""Offline, real manager package BEFORE/AFTER; no DB, worker, SMTP or OCI."""
import argparse
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
EXPECTED = {
    'TestLegacyCounterCleanupScannerOverlap',
    'TestLegacyCounterScannerThenCleanup',
    'TestLegacyCounterRepeatedScanDoesNotReplay',
    'TestLegacyCounterBoundCleanupNeverUsesLegacyFlush',
    'TestLegacyCounterQueuedCompletion',
    'TestLegacyCounterQueuedCompletion/success',
    'TestLegacyCounterQueuedCompletion/transport-error',
}
BEFORE_MARKER = 'legacy counter double-accounted: cleanup=95 scanner=[95] total=17835; want95/0/17740'
REVERSES = {
    'internal/manager/manager.go': (
        '\t\tcounts = append(counts, p.sent.Swap(0))',
        '\t\tcounts = append(counts, p.sent.Load())\n\t\tp.sent.Store(0)'),
    'internal/manager/pipe.go': (
        'int(p.sent.Swap(0)), int(p.lastID.Load())',
        'int(p.sent.Load()), int(p.lastID.Load())'),
    'internal/manager/regular_delivery.go': (
        '\tdefer msg.pipe.wg.Done()\n\tif err != nil {\n\t\tmsg.pipe.OnError()',
        '\tmsg.pipe.wg.Done()\n\tif err != nil {\n\t\tmsg.pipe.OnError()'),
}


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def digest(body):
    return hashlib.sha256(body).hexdigest()


def bounded_file(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 1048576,
            'SOURCE_BOUND_REFUSED')
    return path.read_bytes()


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def command(argv, cwd, env, timeout=180):
    # Output remains RAM. Only finite classes / test names / public SHA enter the report.
    result = subprocess.run([str(x) for x in argv], cwd=cwd, env=env,
                            capture_output=True, timeout=timeout)
    require(len(result.stdout) + len(result.stderr) <= 1048576, 'GO_OUTPUT_BOUND_REFUSED')
    return result


def events(result):
    require(not result.stderr, 'GO_STDERR_REFUSED')
    try:
        values = [json.loads(line) for line in result.stdout.splitlines()]
    except Exception:
        raise RuntimeError('GO_JSON_REFUSED') from None
    require(values and all(isinstance(v, dict) for v in values), 'GO_JSON_REFUSED')
    return values


def hashes(root):
    paths = sorted(p for p in root.rglob('*') if p.is_file())
    require(all(not p.is_symlink() for p in paths), 'SOURCE_SYMLINK_REFUSED')
    return {str(p.relative_to(root)): digest(p.read_bytes()) for p in paths}


def run(args, report):
    report['phase'] = 'isolation'
    require(os.getuid() == 1000 and os.environ.get('LEGACY_COUNTER_PROOF_ISOLATED') == '1',
            'ISOLATION_REFUSED')
    repo = args.repo_root.resolve(strict=True)
    require(not (repo / '.git').exists() and not (repo / '.private').exists(), 'PUBLIC_SNAPSHOT_REFUSED')
    report['phase'] = 'node-runtime'
    node = command(['node', '-e', "if(process.version!=='v22.23.3'||process.getuid()!==1000)process.exit(1)"], repo, os.environ, 10)
    require(node.returncode == 0 and not node.stdout and not node.stderr, 'NODE_RUNTIME_REFUSED')
    report['phase'] = 'source-pins'
    assets = json.loads(bounded_file(HERE / 'ASSETS.json'))
    require(assets['schema'] == 'legacy-counter-focal-assets-v1', 'ASSETS_REFUSED')
    for relative, pin in assets['files'].items():
        path = repo / relative
        body = bounded_file(path)
        require(len(body) == pin['bytes'] and digest(body) == pin['sha256'], 'SOURCE_PIN_REFUSED')
    report['sourcePinsVerified'] = True
    require(not args.out.exists(), 'NEW_OUTPUT_REQUIRED')
    args.out.mkdir(mode=0o700)
    after = args.out / 'after'
    after.mkdir(mode=0o700)
    report['phase'] = 'public-hydration'
    packager = module('counter_package_reader', repo / 'tools/listmonk-regular-package/build.py')
    packager.extract_source(args.inputs / 'listmonk-upstream.tar.gz', after / 'listmonk')
    packager.extract_smtp(args.inputs / 'smtppool.zip', after / 'smtppool')
    smtp = module('counter_smtp_builder', repo / 'tools/listmonk-regular-build/build.py')
    smtp.apply(after / 'listmonk', after / 'smtppool')
    report['phase'] = 'worker-composition'
    worker = module('counter_worker_builder', repo / 'tools/listmonk-regular-build/worker_patch.py')
    receipt = worker.apply(after / 'listmonk', repo, repo / 'crm-scheduler-batch-profile.json', assets['profileSha256'])
    report['profileSha256'] = assets['profileSha256']
    report['querySha256'] = digest((after / 'listmonk/queries/campaigns.sql').read_bytes())
    require(report['querySha256'] == '772efe8e05331fb201ed24cb08bb97a4625a49811d96622c2148342ce54c6700', 'QUERY_PIN_REFUSED')
    report['graphRuntimeSha256'] = receipt['graph_cache_runtime_sha256']
    for name, expected in assets['after'].items():
        require(digest(bounded_file(after / 'listmonk' / name)) == expected, 'AFTER_SOURCE_REFUSED')
    report['phase'] = 'before-source-reconstruction'
    before = args.out / 'before'
    shutil.copytree(after, before)
    for name, (new, old) in REVERSES.items():
        p = before / 'listmonk' / name
        source = bounded_file(p).decode('utf-8')
        require(source.count(new) == 1, 'REVERSE_ANCHOR_REFUSED')
        body = source.replace(new, old).encode('utf-8')
        require(digest(body) == assets['before'][name], 'BEFORE_SOURCE_REFUSED')
        p.write_bytes(body)
    b, a = hashes(before / 'listmonk'), hashes(after / 'listmonk')
    require(b.keys() == a.keys() and {k for k in a if a[k] != b[k]} == set(REVERSES), 'UNRELATED_SOURCE_DRIFT')
    report['onlyThreeFullFileChanges'] = True
    env = dict(os.environ, GOTOOLCHAIN='local', GOPROXY='off', GOSUMDB='off', CGO_ENABLED='0')
    for name in ('GOOS', 'GOARCH', 'GOFLAGS'):
        env.pop(name, None)
    report['phase'] = 'go-runtime'
    version = command([args.go, 'version'], repo, env, 10)
    require(version.returncode == 0 and version.stdout.decode().startswith('go version go1.26.1 '), 'GO_RUNTIME_REFUSED')
    for root in (before, after):
        (root / 'go.work').write_text('go 1.26.1\n\nuse (\n ./listmonk\n ./smtppool\n)\n')
    env['GOWORK'] = str((before / 'go.work').resolve())
    report['phase'] = 'before-go-test'
    report['goTestsExecuted'] = True
    baseline = command([args.go, 'test', '-json', '-count=1', '-timeout=30s',
                        '-run', '^TestLegacyCounterCleanupScannerOverlap$', './internal/manager'], before / 'listmonk', env)
    e = events(baseline)
    failed = {v.get('Test') for v in e if v.get('Action') == 'fail' and v.get('Test')}
    text = ''.join(v.get('Output', '') for v in e)
    require(baseline.returncode != 0 and failed == {'TestLegacyCounterCleanupScannerOverlap'}
            and BEFORE_MARKER in text and not any(v.get('Action') == 'skip' for v in e), 'BEFORE_NOT_REPRODUCED')
    report['before'] = {'deterministicFailureConfirmed': True, 'test': 'TestLegacyCounterCleanupScannerOverlap',
                        'cleanupDelta': 95, 'scannerDelta': 95, 'total': 17835, 'expected': 17740}
    env['GOWORK'] = str((after / 'go.work').resolve())
    report['phase'] = 'after-go-test'
    candidate = command([args.go, 'test', '-json', '-count=1', '-timeout=30s',
                         '-run', '^TestLegacyCounter', './internal/manager'], after / 'listmonk', env)
    e = events(candidate)
    passed = {v.get('Test') for v in e if v.get('Action') == 'pass' and v.get('Test')}
    require(candidate.returncode == 0 and passed == EXPECTED
            and not any(v.get('Action') in ('fail', 'skip') for v in e), 'AFTER_NOT_ACCEPTED')
    report['after'] = {'accepted': True, 'behaviorCases': 6, 'topLevelTests': 5, 'passedTestNames': sorted(passed)}
    report['phase'] = 'complete'
    report['status'] = 'PASSED_FOCAL_MANAGER_ONLY_NOT_DEPLOYED'
    report['goTestsExecuted'] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo-root', type=Path, required=True)
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--go', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    report = {'schema': 'legacy-counter-focal-manager-proof-v1', 'status': 'REFUSED', 'phase': 'initial',
              'goTestsExecuted': False, 'originalCalls': 0, 'sqlCalls': 0, 'smtpCalls': 0,
              'workerStarted': False, 'imageBuilt': False, 'operational': False, 'productionChanged': False}
    try:
        run(args, report)
    except Exception as exc:
        # Never serialize subprocess stderr or an exception's free text.
        report['status'] = 'FOCAL_PROOF_REFUSED'
        code = str(exc)
        if re.fullmatch(r'[A-Z0-9_]{1,80}', code):
            report['refusalCode'] = code
        else:
            report['exceptionType'] = type(exc).__name__
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    args.report.chmod(0o644)
    print(json.dumps({'status': report['status'], 'goTestsExecuted': report['goTestsExecuted']}))
    return 0 if report['status'] == 'PASSED_FOCAL_MANAGER_ONLY_NOT_DEPLOYED' else 1


if __name__ == '__main__':
    sys.exit(main())
