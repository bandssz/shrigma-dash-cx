#!/usr/bin/env python3
"""Verify and copy one pinned regular-worker OCI layout; never rebuild or deploy."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
LOCK_PATH = HERE / 'lock.json'
MAX_JSON = 4 * 1024 * 1024


def require(condition, code):
    if not condition:
        raise ValueError('REGULAR_REGISTRY_' + code)


def read_file(path, limit):
    require(path.is_file() and not path.is_symlink(), 'FILE_TYPE')
    size = path.stat().st_size
    require(size <= limit, 'FILE_SIZE')
    data = path.read_bytes()
    require(len(data) == size, 'FILE_READ')
    return data


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def load_json(path, limit=MAX_JSON):
    try:
        value = json.loads(read_file(path, limit))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError('REGULAR_REGISTRY_JSON') from None
    require(isinstance(value, dict), 'JSON_OBJECT')
    return value


def load_lock(path=LOCK_PATH):
    lock = load_json(path)
    require(lock.get('schema') == 'crm-regular-registry-lock-v1', 'LOCK_SCHEMA')
    require(isinstance(lock.get('enabled'), bool), 'LOCK_ENABLED')
    require(re.fullmatch(r'[0-9a-f]{40}', str(lock.get('source_head', ''))) is not None, 'LOCK_HEAD')
    require(re.fullmatch(r'[0-9a-f]{40}', str(lock.get('ci_revision', ''))) is not None, 'LOCK_REVISION')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', str(lock.get('manifest_digest', ''))) is not None, 'LOCK_MANIFEST')
    require(re.fullmatch(r'[0-9a-f]{40}', str(lock.get('source_merge', ''))) is not None, 'LOCK_MERGE')
    require(lock.get('tag') == 'regular-v1-' + lock['source_head'], 'LOCK_TAG')
    require(lock.get('image') == 'ghcr.io/bandssz/shrigma-crm-listmonk', 'LOCK_IMAGE')
    require(isinstance(lock.get('run_id'), int) and lock['run_id'] > 0 and
            isinstance(lock.get('pull_request'), int) and lock['pull_request'] > 0 and
            isinstance(lock.get('max_file_bytes'), int) and lock['max_file_bytes'] > 0 and
            isinstance(lock.get('max_total_bytes'), int) and
            lock['max_total_bytes'] >= lock['max_file_bytes'], 'LOCK_BOUNDS')
    inventory = lock.get('artifact_files')
    require(isinstance(inventory, dict) and inventory, 'LOCK_INVENTORY')
    for relative, digest in inventory.items():
        path_obj = Path(relative)
        require(isinstance(relative, str) and relative and not path_obj.is_absolute() and
                path_obj.as_posix() == relative and '..' not in path_obj.parts and '\\' not in relative,
                'LOCK_PATH')
        require(re.fullmatch(r'[0-9a-f]{64}', str(digest)) is not None, 'LOCK_DIGEST')
    return lock


def verify_inventory(directory, lock):
    require(directory.is_dir() and not directory.is_symlink(), 'ARTIFACT_DIR')
    directory = directory.resolve()
    actual = set()
    total = 0
    for entry in directory.rglob('*'):
        mode = entry.lstat().st_mode
        require(not stat.S_ISLNK(mode) and (stat.S_ISREG(mode) or stat.S_ISDIR(mode)), 'ARTIFACT_TYPE')
        if stat.S_ISREG(mode):
            relative = entry.relative_to(directory).as_posix()
            actual.add(relative)
            size = entry.stat().st_size
            require(size <= lock['max_file_bytes'], 'ARTIFACT_FILE_SIZE')
            total += size
            require(total <= lock['max_total_bytes'], 'ARTIFACT_TOTAL_SIZE')
    expected = set(lock['artifact_files'])
    require(actual == expected, 'ARTIFACT_INVENTORY')
    for relative, digest in lock['artifact_files'].items():
        require(sha256(read_file(directory / relative, lock['max_file_bytes'])) == digest,
                'ARTIFACT_DRIFT')


def verify_descriptor(oci, descriptor):
    require(isinstance(descriptor, dict), 'OCI_DESCRIPTOR')
    digest = descriptor.get('digest', '')
    size = descriptor.get('size')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', str(digest)) is not None and
            isinstance(size, int) and 0 <= size <= 128 * 1024 * 1024, 'OCI_DESCRIPTOR')
    body = read_file(oci / 'blobs' / 'sha256' / digest.split(':', 1)[1], 128 * 1024 * 1024)
    require(len(body) == size and 'sha256:' + sha256(body) == digest, 'OCI_BLOB')
    return body


def verify_oci(directory, lock):
    oci = directory / 'regular-image' / 'oci'
    require(load_json(oci / 'oci-layout', 1024) == {'imageLayoutVersion': '1.0.0'}, 'OCI_LAYOUT')
    index = load_json(oci / 'index.json')
    manifests = index.get('manifests')
    require(index.get('schemaVersion') == 2 and isinstance(manifests, list) and len(manifests) == 1,
            'OCI_INDEX')
    descriptor = manifests[0]
    require(descriptor.get('digest') == lock['manifest_digest'] and
            descriptor.get('size') == lock['manifest_size'] and
            descriptor.get('mediaType') == 'application/vnd.oci.image.manifest.v1+json', 'OCI_MANIFEST_PIN')
    try:
        manifest = json.loads(verify_descriptor(oci, descriptor))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError('REGULAR_REGISTRY_OCI_JSON') from None
    require(manifest.get('schemaVersion') == 2 and
            manifest.get('mediaType') == 'application/vnd.oci.image.manifest.v1+json', 'OCI_MANIFEST')
    config_desc = manifest.get('config')
    require(isinstance(config_desc, dict) and config_desc.get('digest') == lock['config_digest'], 'OCI_CONFIG_PIN')
    try:
        config = json.loads(verify_descriptor(oci, config_desc))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError('REGULAR_REGISTRY_OCI_JSON') from None
    require(config.get('os') == 'linux' and config.get('architecture') == 'amd64', 'OCI_PLATFORM')
    labels = config.get('config', {}).get('Labels', {})
    require(labels.get('org.opencontainers.image.revision') == lock['ci_revision'] and
            labels.get('org.opencontainers.image.source') == 'https://github.com/bandssz/shrigma-dash-cx' and
            labels.get('crm.regular.status') == 'OFF_NOT_DEPLOYED' and
            labels.get('crm.regular.binary-sha256') == lock['binary_sha256'], 'OCI_LABELS')
    layers = manifest.get('layers')
    require(isinstance(layers, list) and layers, 'OCI_LAYERS')
    for layer in layers:
        verify_descriptor(oci, layer)
    return oci


def verify_run(run, lock, source_pr):
    # GitHub can empty run.pull_requests after a merge. Verify the PR directly.
    require(isinstance(source_pr, dict) and source_pr.get('number') == lock['pull_request'] and
            source_pr.get('merged') is True and source_pr.get('state') == 'closed' and
            source_pr.get('head', {}).get('sha') == lock['source_head'] and
            source_pr.get('head', {}).get('repo', {}).get('full_name') == lock['repository'] and
            source_pr.get('base', {}).get('repo', {}).get('full_name') == lock['repository'] and
            source_pr.get('base', {}).get('ref') == 'main' and
            source_pr.get('merge_commit_sha') == lock['source_merge'], 'SOURCE_PR')
    prs = run.get('pull_requests')
    require(isinstance(prs, list) and (not prs or any(
        p.get('number') == lock['pull_request'] and p.get('head', {}).get('sha') == lock['source_head']
        for p in prs if isinstance(p, dict))), 'SOURCE_RUN_PR')
    require(run.get('id') == lock['run_id'] and run.get('head_sha') == lock['source_head'] and
            run.get('conclusion') == 'success' and run.get('status') == 'completed' and
            run.get('event') == 'pull_request' and run.get('path') == lock['workflow_path'] and
            run.get('repository', {}).get('full_name') == lock['repository'],
            'SOURCE_RUN')


def verify_proofs(directory, lock):
    image = load_json(directory / 'regular-image' / 'image-proof.json')
    native = load_json(directory / 'regular-image' / 'native-proof.json')
    package = load_json(directory / 'regular-image' / 'package-manifest.json')
    postgres = load_json(directory / 'regular-pg-proof' / 'postgres-proof.json')
    source = read_file(directory / 'regular-image' / 'source.tar.gz', lock['max_file_bytes'])
    native_bytes = read_file(directory / 'regular-image' / 'native-proof.json', lock['max_file_bytes'])

    require(image.get('schema') == 'crm-regular-oci-v1' and
            image.get('status') == 'VERIFIED_IMAGE_OFF_NOT_DEPLOYED' and
            image.get('revision') == lock['ci_revision'] and
            image.get('manifest_digest') == lock['manifest_digest'] and
            image.get('config_digest') == lock['config_digest'] and
            image.get('binary_sha256') == lock['binary_sha256'] and
            image.get('source_sha256') == sha256(source) == lock['source_sha256'] and
            image.get('native_proof_sha256') == sha256(native_bytes) and
            image.get('source_lock_sha256') == lock['source_lock_sha256'] and
            image.get('runtime_config_preserved') is True and
            image.get('oci_binary_matches_native_proof') is True and
            image.get('version_command_network_none') is True and
            image.get('registry_push') is False and image.get('production_changed') is False,
            'IMAGE_PROOF')
    require(package.get('schema') == 'listmonk-regular-package-v1' and
            package.get('status') == 'CANDIDATE_OFF_NOT_DEPLOYED' and
            package.get('target') == 'linux_amd64' and
            package.get('binary_sha256') == lock['binary_sha256'] and
            package.get('query_sha256') == lock['query_sha256'] and
            package.get('source_lock_sha256') == lock['source_lock_sha256'] and
            package.get('runtime_activation') is False and package.get('registry_push') is False and
            package.get('production_changed') is False, 'PACKAGE_PROOF')
    require(native.get('schema') == 'segment-regular-native-proof-v1' and
            native.get('status') == 'PASSED_EPHEMERAL_ONLY_NOT_DEPLOYED' and
            native.get('binary_sha256') == lock['binary_sha256'] and
            native.get('identity', {}).get('worker_sha256') == lock['binary_sha256'] and
            native.get('query_sha256') == lock['query_sha256'] and
            native.get('cluster_stopped') is True and native.get('local_disposable') is True and
            native.get('production_changed') is False and native.get('remote_hosts') == 0,
            'NATIVE_PROOF')
    runs = postgres.get('runs')
    require(postgres.get('schema') == 'regular-postgres-proof-v1' and
            postgres.get('success') is True and postgres.get('stopped') is True and
            postgres.get('production_changed') is False and postgres.get('sends') == 0 and
            isinstance(runs, list) and runs and all(r.get('exit_code') == 0 for r in runs),
            'POSTGRES_PROOF')
    if ('graph_cache_runtime_sha256' in package or
            'regular-image/graph-native-proof.json' in lock['artifact_files']):
        runtime = package.get('graph_cache_runtime_sha256')
        require(re.fullmatch(r'[0-9a-f]{64}', str(runtime)) is not None and
                runtime == lock.get('graph_cache_runtime_sha256') and
                package.get('graph_cache_enabled_by_default') is False,
                'GRAPH_PACKAGE_PROOF')
        graph = load_json(directory / 'regular-image' / 'graph-native-proof.json')
        proof = graph.get('proof', {})
        require(graph.get('schema') == 'crm-graph-real-http-cache-native-v1' and
                graph.get('success') is True and graph.get('postgres') == '17.10' and
                graph.get('binary_sha256') == lock['binary_sha256'] and
                graph.get('runtime_sha256') == runtime and
                graph.get('regular_native_schema_prepared') is True and
                graph.get('cluster_stopped') is True and graph.get('database_removed') is True and
                graph.get('production_changed') is False and
                graph.get('smtp_calls') == 0 and graph.get('customer_sends') == 0 and
                proof.get('success') is True and proof.get('actual_http_clone') is True and
                proof.get('creates') == 2 and proof.get('extra_create_on_replay') is False and
                proof.get('process_generated_heartbeat') is True and
                proof.get('actual_compiled_cache_snapshots') == 2 and
                sorted(proof.get('brands', [])) == ['aristo', 'fish'] and
                proof.get('graph_enabled') is False and proof.get('cart_enabled') is False and
                proof.get('entries') == 0 and proof.get('dispatches') == 0 and
                proof.get('send_logs') == 0, 'GRAPH_NATIVE_PROOF')


def verify(run, directory, lock=None, source_pr=None):
    lock = load_lock() if lock is None else lock
    verify_run(run, lock, source_pr)
    verify_inventory(directory, lock)
    oci = verify_oci(directory, lock)
    verify_proofs(directory, lock)
    return oci


def require_context(lock):
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and
            os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and
            os.environ.get('GITHUB_REF') == 'refs/heads/main' and
            os.environ.get('GITHUB_REPOSITORY') == lock['repository'], 'CONTEXT')


def child_environment():
    environment = dict(os.environ)
    environment.pop('GH_TOKEN', None)
    return environment


def command(args, **kwargs):
    kwargs.setdefault('env', child_environment())
    try:
        result = subprocess.run(args, text=True, capture_output=True, timeout=300, **kwargs)
    except (OSError, subprocess.SubprocessError):
        raise RuntimeError('REGULAR_REGISTRY_COMMAND_FAILED') from None
    if result.returncode or len(result.stdout) + len(result.stderr) > MAX_JSON:
        raise RuntimeError('REGULAR_REGISTRY_COMMAND_FAILED')
    return result.stdout


def publish(oci, receipt, lock=None):
    lock = load_lock() if lock is None else lock
    require(lock['enabled'] is True, 'DISABLED')
    require_context(lock)
    token, actor = os.environ.get('GH_TOKEN', ''), os.environ.get('GITHUB_ACTOR', '')
    require(bool(token) and re.fullmatch(r'[A-Za-z0-9-]{1,100}', actor) is not None, 'AUTH')
    with tempfile.TemporaryDirectory(prefix='regular-registry-') as folder:
        auth = Path(folder) / 'auth.json'
        command(['skopeo', 'login', '--authfile', str(auth), '--username', actor,
                 '--password-stdin', 'ghcr.io'], input=token)
        auth.chmod(0o600)
        destination = 'docker://' + lock['image'] + ':' + lock['tag']
        try:
            existing = subprocess.run(['skopeo', 'inspect', '--authfile', str(auth), '--raw', destination],
                                      text=True, capture_output=True, timeout=60, env=child_environment())
        except (OSError, subprocess.SubprocessError):
            raise RuntimeError('REGULAR_REGISTRY_COMMAND_FAILED') from None
        require(len(existing.stdout) + len(existing.stderr) <= MAX_JSON, 'DESTINATION_RESPONSE')
        if existing.returncode == 0:
            require('sha256:' + sha256(existing.stdout.encode()) == lock['manifest_digest'], 'TAG_COLLISION')
        else:
            detail = existing.stderr.lower()
            require('manifest unknown' in detail and
                    'denied' not in detail and 'unauthorized' not in detail and 'timeout' not in detail,
                    'DESTINATION_UNCONFIRMED')
            command(['skopeo', 'copy', '--authfile', str(auth), '--preserve-digests',
                     'oci:' + str(oci) + ':candidate', destination])
        for suffix in (':' + lock['tag'], '@' + lock['manifest_digest']):
            raw = command(['skopeo', 'inspect', '--authfile', str(auth), '--raw',
                           'docker://' + lock['image'] + suffix])
            require('sha256:' + sha256(raw.encode()) == lock['manifest_digest'], 'READBACK')
    result = {
        'schema': 'crm-regular-registry-receipt-v1',
        'status': 'REGISTRY_VERIFIED_OFF_NOT_DEPLOYED',
        'image': lock['image'] + '@' + lock['manifest_digest'],
        'tag': lock['image'] + ':' + lock['tag'],
        'source_run': lock['run_id'],
        'source_head': lock['source_head'],
        'runtime_enabled': False,
        'service_changed': False,
        'deployed': False,
    }
    receipt.write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
    print(json.dumps(result, sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('verify', 'publish'))
    parser.add_argument('--run-json', type=Path, required=True)
    parser.add_argument('--pr-json', type=Path, required=True)
    parser.add_argument('--artifact-dir', type=Path, required=True)
    parser.add_argument('--receipt', type=Path)
    args = parser.parse_args()
    lock = load_lock()
    run = load_json(args.run_json)
    oci = verify(run, args.artifact_dir, lock, load_json(args.pr_json))
    if args.action == 'publish':
        require(args.receipt is not None, 'RECEIPT')
        publish(oci, args.receipt, lock)
    else:
        print(json.dumps({'status': 'VERIFIED_OFF_NOT_PUBLISHED',
                          'enabled': lock['enabled'],
                          'image': lock['image'] + '@' + lock['manifest_digest']}, sort_keys=True))


if __name__ == '__main__':
    main()
