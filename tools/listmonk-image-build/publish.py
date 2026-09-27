#!/usr/bin/env python3
"""Copy one approved OCI artifact to GHCR; no rebuild or service access."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import build

RUN = 36282672565
HEAD = 'c53807f6bb81c127697b9fcb9c9e843cf4fb1fcf'
CI_REVISION = '31d3676018f41219e6f0aca95b85565d4a7506d9'
ARCHIVE_SHA = '8e105cabe9fafe17d4aae5c8d61dc79f35d7bf6acddbedccd6c790a7ad347f0f'
MANIFEST = 'sha256:fb83f8c0924548fda38ca22a12157220f26e552df82c217d5e7fc03f19ea9e3d'
IMAGE = 'ghcr.io/bandssz/shrigma-crm-listmonk'
TAG = 'ab-v2-c97a058'
ARTIFACT = 'listmonk-6.1.0-crm-ab-oci-linux-amd64'


def verify(run, directory):
    build.require(run.get('id') == RUN and run.get('head_sha') == HEAD and
                  run.get('conclusion') == 'success' and run.get('status') == 'completed' and
                  run.get('event') == 'pull_request' and run.get('path') == '.github/workflows/ab-listmonk-image-build.yml' and
                  run.get('repository', {}).get('full_name') == build.LOCK['repository'], 'AB_PUBLISH_RUN')
    archive = directory / 'listmonk-ab-linux-amd64.oci.tar'
    build.require(build.sha(build.read_bound(archive, build.LOCK['max_oci_bytes'])) == ARCHIVE_SHA, 'AB_PUBLISH_ARCHIVE')
    actual = build.verify_oci(archive, build.read_bound(build.HERE / 'base-config.json', 16384))
    claimed = json.loads(build.read_bound(directory / 'image-manifest.json', 16384))
    build.require(all(claimed.get(k) == v for k, v in actual.items()) and
                  claimed.get('build_workflow_run') == str(RUN) and claimed.get('build_recipe_revision') == CI_REVISION and
                  actual['image_manifest_digest'] == MANIFEST, 'AB_PUBLISH_PROOF')
    # The original source archive accompanies the image in GitHub Actions.
    source = directory / 'source' / build.LOCK['archive_name']
    build.require(build.sha(build.read_bound(source, build.LOCK['max_archive_bytes'])) == build.LOCK['archive_sha256'], 'AB_PUBLISH_SOURCE')
    return archive


def require_context():
    build.require(os.environ.get('GITHUB_ACTIONS') == 'true' and
                  os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and
                  os.environ.get('GITHUB_REF') == 'refs/heads/main' and
                  os.environ.get('GITHUB_REPOSITORY') == build.LOCK['repository'], 'AB_PUBLISH_CONTEXT')


def command(args, **kw):
    # Do not expose provider errors, login output or token-bearing environment.
    result = subprocess.run(args, text=True, capture_output=True, timeout=300, **kw)
    if result.returncode:
        raise RuntimeError('AB_PUBLISH_COMMAND_FAILED')
    return result.stdout


def publish(archive, receipt, initial_create=False):
    require_context()
    token, actor = os.environ.get('GH_TOKEN', ''), os.environ.get('GITHUB_ACTOR', '')
    build.require(bool(token) and re.fullmatch(r'[A-Za-z0-9-]{1,100}', actor), 'AB_PUBLISH_AUTH')
    with tempfile.TemporaryDirectory(prefix='ab-registry-') as folder:
        auth = Path(folder) / 'auth.json'
        command(['skopeo', 'login', '--authfile', str(auth), '--username', actor, '--password-stdin', 'ghcr.io'], input=token)
        auth.chmod(0o600)
        target = 'docker://' + IMAGE + ':' + TAG
        existing = subprocess.run(['skopeo', 'inspect', '--authfile', str(auth), '--raw', target], text=True, capture_output=True, timeout=60)
        if existing.returncode == 0:
            build.require('sha256:' + hashlib.sha256(existing.stdout.encode()).hexdigest() == MANIFEST, 'AB_PUBLISH_TAG_COLLISION')
        else:
            # GHCR can deny reads before the package exists. The reviewed manual
            # bootstrap permits ONE copy to this fixed new package/tag only; it
            # does not classify denial as absence or change registry permissions.
            detail = existing.stderr.lower()
            missing = any(x in detail for x in ('manifest unknown', 'name unknown'))
            bootstrap = initial_create and 'denied' in detail and 'timeout' not in detail
            build.require(missing or bootstrap, 'AB_PUBLISH_DESTINATION_UNCONFIRMED')
            command(['skopeo', 'copy', '--authfile', str(auth), '--preserve-digests', 'oci-archive:' + str(archive), target])
        for suffix in (':' + TAG, '@' + MANIFEST):
            raw = command(['skopeo', 'inspect', '--authfile', str(auth), '--raw', 'docker://' + IMAGE + suffix])
            build.require('sha256:' + hashlib.sha256(raw.encode()).hexdigest() == MANIFEST, 'AB_PUBLISH_READBACK')
    result = {'status': 'REGISTRY_VERIFIED_NOT_DEPLOYED', 'image': IMAGE + '@' + MANIFEST,
              'tag': IMAGE + ':' + TAG, 'source_run': RUN, 'oci_archive_sha256': ARCHIVE_SHA,
              'runtime_enabled': False, 'service_changed': False, 'public_pull_verified': False}
    build.write_json(receipt, result)
    print(json.dumps(result))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['verify', 'publish'])
    p.add_argument('--run-json', type=Path, required=True)
    p.add_argument('--artifact-dir', type=Path, required=True)
    p.add_argument('--receipt', type=Path)
    p.add_argument('--initial-create', action='store_true')
    args = p.parse_args()
    run = json.loads(build.read_bound(args.run_json, 1024 * 1024))
    archive = verify(run, args.artifact_dir)
    if args.action == 'publish':
        build.require(args.receipt is not None, 'AB_PUBLISH_RECEIPT')
        publish(archive, args.receipt, args.initial_create)
    else:
        print(json.dumps({'status': 'VERIFIED_FOR_REGISTRY', 'image': IMAGE + '@' + MANIFEST, 'published': False}))


if __name__ == '__main__':
    main()
