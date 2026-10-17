"""Run only the new scanner classifier tests with the actual composed pq module.

The worker build compiles the complete source separately. This focused proof
extracts the exact classifier tail; it substitutes no driver or implementation.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

SOURCE_SHA = 'fddc286630157005e82a64ba97dbcb100869f56ea6cf2ba7e61cb59232486fee'
TEST_SHA = '7bf2ce6a80fb870eb49ff2314fcc11461a38a98ee85c69eb51622d4625efd643'
MARKER = b'// campaignScanPhase and the classifier intentionally expose only closed static values.\n'
HEADER = b'package main\n\nimport (\n "context"\n "database/sql"\n "errors"\n "github.com/lib/pq"\n)\n\n'


def checked_file(path, expected):
    if path.is_symlink() or not path.is_file():
        raise ValueError('SCAN_PROOF_SOURCE_REFUSED')
    body = path.read_bytes()
    if hashlib.sha256(body).hexdigest() != expected:
        raise ValueError('SCAN_PROOF_SOURCE_REFUSED')
    return body


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', required=True, type=Path)
    parser.add_argument('--go', required=True, type=Path)
    args = parser.parse_args()
    root = args.source_root.resolve(strict=True)
    source = checked_file(root / 'cmd/manager_store_regular.go', SOURCE_SHA)
    tests = checked_file(root / 'cmd/manager_store_scan_observability_test.go', TEST_SHA)
    if source.count(MARKER) != 1:
        raise ValueError('SCAN_PROOF_SOURCE_REFUSED')
    tail = MARKER + source.split(MARKER, 1)[1]
    work = root.parent / 'go.work'
    if not work.is_file() or work.is_symlink():
        raise ValueError('SCAN_PROOF_WORKSPACE_REFUSED')
    env = os.environ.copy()
    env.update(GOWORK=str(work), GOPROXY='off', GOSUMDB='off', GOTOOLCHAIN='local')
    with tempfile.TemporaryDirectory(prefix='scanner-proof-') as scratch:
        directory = Path(scratch)
        production = directory / 'scanner.go'
        test = directory / 'scanner_test.go'
        production.write_bytes(HEADER + tail)
        test.write_bytes(tests)
        result = subprocess.run(
            [str(args.go), 'test', '-race', '-count=1', '-run',
             '^TestCampaignScan(ClosedClasses|UnknownAndContext|BoundaryOrderAndFailure)$',
             str(production), str(test)], cwd=root, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False)
    report = {
        'schema': 'shrigma-scanner-observability-go-proof-v1',
        'ok': result.returncode == 0,
        'sourceSha256': SOURCE_SHA, 'testsSha256': TEST_SHA,
        'testedTailSha256': hashlib.sha256(tail).hexdigest(),
        'actualComposedSourceUsed': True, 'actualPqDependencyUsed': True,
        'productionImplementationSubstituted': False, 'driverStubUsed': False,
        'focusedTests': 3, 'raceDetector': True,
        'completeWorkerBuildIsSeparateProof': True,
        'productionUsed': False, 'operational': False,
    }
    print(json.dumps(report, separators=(',', ':')))
    if result.returncode:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
