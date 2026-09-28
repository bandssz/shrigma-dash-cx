#!/usr/bin/env python3
"""Copy a verified worker OCI artifact to GHCR; never build or deploy a service."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

IMAGE = 'ghcr.io/bandssz/shrigma-crm-flows'
REPOSITORY = 'bandssz/shrigma-dash-cx'
PREFIX = 'CRM_FLOW_PUBLISH_'


def require(condition, code):
    if not condition:
        raise RuntimeError(PREFIX + code)


def verify_artifact(directory, source_sha, run_id):
    # Kept lazy so importing this publisher has no artifact or network effects.
    from image import verify_artifact as verify
    return verify(directory, source_sha, run_id)


def context(source_sha):
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and
            os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and
            os.environ.get('GITHUB_REF') == 'refs/heads/main' and
            os.environ.get('GITHUB_REPOSITORY') == REPOSITORY, 'CONTEXT')
    require(re.fullmatch(r'[a-f0-9]{40}', source_sha or '') is not None, 'SOURCE_SHA')
    run_id = os.environ.get('GITHUB_RUN_ID', '')
    actor, token = os.environ.get('GITHUB_ACTOR', ''), os.environ.get('GH_TOKEN', '')
    require(re.fullmatch(r'[1-9][0-9]{0,19}', run_id) is not None, 'RUN')
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,99}', actor) is not None and
            0 < len(token) <= 4096 and not re.search(r'\s|\x00', token), 'AUTH')
    return run_id, actor, token


def run_command(args, *, stdin=None, timeout=60):
    # Tokens travel only on login stdin, not arguments or the child's environment.
    environment = {k: v for k, v in os.environ.items() if k not in ('GH_TOKEN', 'GITHUB_TOKEN')}
    try:
        return subprocess.run(args, input=stdin, capture_output=True, timeout=timeout, env=environment)
    except (OSError, subprocess.SubprocessError):
        raise RuntimeError(PREFIX + 'COMMAND_UNCERTAIN') from None


def raw_manifest(target, auth, *, allow_missing=False):
    result = run_command(['skopeo', 'inspect', '--authfile', str(auth), '--raw', target])
    if result.returncode == 0:
        require(isinstance(result.stdout, bytes) and 0 < len(result.stdout) <= 1024 * 1024,
                'MANIFEST_SIZE')
        return 'sha256:' + hashlib.sha256(result.stdout).hexdigest()
    detail = result.stderr.decode('utf-8', errors='replace').lower()
    # An access/network error never proves absence, even if its message also
    # contains one of the registry's missing-manifest strings.
    uncertain = re.search(r'denied|unauthori[sz]ed|forbidden|timeout|timed out|connection|'
                          r'network|tls|certificate|\b(?:401|403|429|5[0-9][0-9])\b', detail)
    missing = re.search(r'\b(?:manifest[ _]unknown|name[ _]unknown)\b', detail)
    require(allow_missing and missing and not uncertain, 'DESTINATION_UNCONFIRMED')
    return None


def validate_proof(proof, directory, source_sha):
    require(isinstance(proof, dict) and proof.get('image') == IMAGE and
            proof.get('tag') == 'sha-' + source_sha and proof.get('source_sha') == source_sha,
            'ARTIFACT_IDENTITY')
    require(re.fullmatch(r'[a-f0-9]{64}', proof.get('archive_sha256', '')) is not None and
            all(re.fullmatch(r'sha256:[a-f0-9]{64}', proof.get(k, '')) is not None
                for k in ('manifest_digest', 'config_digest')), 'ARTIFACT_DIGEST')
    archive = Path(proof.get('archive_path', ''))
    require(archive.is_file() and not archive.is_symlink() and
            archive.resolve().is_relative_to(directory.resolve()), 'ARTIFACT_PATH')
    return archive


def write_receipt(path, value):
    # Never overwrite an earlier receipt or follow an existing symlink.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write('\n')


def publish(directory, source_sha, receipt):
    directory, receipt = Path(directory), Path(receipt)
    run_id, actor, token = context(source_sha)
    require(not receipt.exists() and not receipt.is_symlink() and receipt.parent.is_dir(), 'RECEIPT_PATH')
    proof = verify_artifact(directory, source_sha, run_id)
    archive = validate_proof(proof, directory, source_sha)
    expected = proof['manifest_digest']
    target = 'docker://' + IMAGE + ':' + proof['tag']
    copied, copy_response_uncertain = False, False
    with tempfile.TemporaryDirectory(prefix='crm-flow-registry-') as folder:
        auth = Path(folder) / 'auth.json'
        descriptor = os.open(auth, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            stream.write('{"auths":{}}\n')
        login = run_command(['skopeo', 'login', '--authfile', str(auth), '--username', actor,
                             '--password-stdin', 'ghcr.io'], stdin=token.encode('utf-8'))
        require(login.returncode == 0, 'AUTH_FAILED')
        auth.chmod(0o600)
        existing = raw_manifest(target, auth, allow_missing=True)
        if existing is not None:
            require(existing == expected, 'TAG_COLLISION')
        else:
            copied = True
            try:
                result = run_command(['skopeo', 'copy', '--authfile', str(auth), '--preserve-digests',
                                      'oci-archive:' + str(archive), target], timeout=300)
                copy_response_uncertain = result.returncode != 0
            except RuntimeError:
                # Reconcile through reads only. There is no second copy.
                copy_response_uncertain = True
        for destination in (target, 'docker://' + IMAGE + '@' + expected):
            require(raw_manifest(destination, auth) == expected, 'READBACK')
    result = {
        'status': 'REGISTRY_VERIFIED_NOT_DEPLOYED',
        'image': IMAGE + '@' + expected,
        'tag': IMAGE + ':' + proof['tag'],
        'source_sha': source_sha,
        'source_run': run_id,
        'oci_archive_sha256': proof['archive_sha256'],
        'manifest_digest': expected,
        'config_digest': proof['config_digest'],
        'copy_attempted': copied,
        'copy_response_uncertain_reconciled': copy_response_uncertain,
        'runtime_enabled': False,
        'service_changed': False,
        'public_pull_verified': False,
    }
    write_receipt(receipt, result)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifact-dir', type=Path, required=True)
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = publish(args.artifact_dir, args.source_sha, args.receipt)
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        code = str(error)
        if not re.fullmatch(PREFIX + r'[A-Z_]{1,60}', code):
            code = PREFIX + 'UNCONFIRMED'
        print(json.dumps({'status': 'REGISTRY_UNCONFIRMED_NOT_DEPLOYED', 'error': code,
                          'runtime_enabled': False, 'service_changed': False}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
