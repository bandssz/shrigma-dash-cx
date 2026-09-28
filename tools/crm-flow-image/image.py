#!/usr/bin/env python3
"""Build one clean, disabled CRM candidate; verify the same OCI bytes for copying."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
IMAGE = 'ghcr.io/bandssz/shrigma-crm-flows'
SOURCE = 'https://github.com/bandssz/shrigma-dash-cx'
SHA = re.compile(r'[a-f0-9]{40}')
DIGEST = re.compile(r'sha256:[a-f0-9]{64}')
MAX_ARCHIVE = 1024 * 1024 * 1024
LOCKS = {
    'services/crm-flows/Dockerfile': 'f864bd19f173743be2a2bca3836146fcab0b850d9c0ac5039840a53e58f4d8c0',
    'services/crm-flows/package-lock.json': '8bada6aef0c6044810bd9919622c28d569d43d450874c517f7e8ee342c4669df',
    'services/crm-flows/package.json': 'bb9e056c7b20db198dadfba76d489ada5f52871668d63d326cfcd14a2484cae3',
}


def require(ok, code):
    if not ok:
        raise ValueError('CRM_IMAGE_' + code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def command(args, *, error_code='COMMAND_FAILED', **kw):
    result = subprocess.run(args, capture_output=True, timeout=360, **kw)
    require(result.returncode == 0, error_code)
    return result.stdout


def allowed_file(name):
    return (name in LOCKS or name in ('growth-email-contract.js', 'growth-email-expressions.js',
            'tests/journey-graph-service.test.cjs', 'n8n/growth/journey-graph-contract.js') or
            bool(re.fullmatch(r'services/crm-flows/[a-z0-9-]+\.cjs', name)) or
            bool(re.fullmatch(r'n8n/growth/journey-graph-[a-z0-9-]+\.cjs', name)))


def source_context(repo, revision, destination):
    require(bool(SHA.fullmatch(revision)), 'SOURCE_SHA')
    command(['git', '-C', str(repo), 'merge-base', '--is-ancestor', revision, 'refs/remotes/origin/main'], error_code='SOURCE_NOT_MAIN')
    entries = command(['git', '-C', str(repo), 'ls-tree', '-r', revision]).decode().splitlines()
    copied = set()
    for entry in entries:
        metadata, name = entry.split('\t', 1)
        if not allowed_file(name):
            continue
        mode, kind, oid = metadata.split()
        require(mode in ('100644', '100755') and kind == 'blob', 'SOURCE_MODE')
        data = command(['git', '-C', str(repo), 'cat-file', 'blob', oid])
        require(len(data) <= 2 * 1024 * 1024, 'SOURCE_LIMIT')
        if name in LOCKS:
            require(sha(data) == LOCKS[name], 'RECIPE_OR_LOCK_DRIFT')
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        copied.add(name)
    require(set(LOCKS) | {'services/crm-flows/config.cjs', 'services/crm-flows/main.cjs',
            'tests/journey-graph-service.test.cjs'} <= copied, 'SOURCE_MISSING')


def stream_sha(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(chunk)
    return digest.hexdigest()


def file_sha(file):
    with file.open('rb') as stream:
        return stream_sha(stream)


def verify_oci(archive, revision):
    require(archive.is_file() and not archive.is_symlink() and archive.stat().st_size <= MAX_ARCHIVE, 'ARCHIVE_LIMIT')
    with tarfile.open(archive, 'r:') as tar:
        members = tar.getmembers()
        require(len(members) <= 100 and len({m.name for m in members}) == len(members), 'ARCHIVE_MEMBERS')
        entries = {m.name: m for m in members if m.isfile()}
        require(all(m.isfile() or m.isdir() for m in members), 'ARCHIVE_TYPE')
        require(all(not m.isdir() or m.name.rstrip('/') in ('blobs', 'blobs/sha256') for m in members), 'ARCHIVE_DIRECTORY')
        require(all(name in ('index.json', 'oci-layout') or re.fullmatch(r'blobs/sha256/[a-f0-9]{64}', name) for name in entries), 'ARCHIVE_PATH')
        def read(name, limit):
            require(name in entries and entries[name].size <= limit, 'OCI_ENTRY')
            return tar.extractfile(entries[name]).read()
        require(json.loads(read('oci-layout', 1024)) == {'imageLayoutVersion': '1.0.0'}, 'OCI_LAYOUT')
        index = json.loads(read('index.json', 16384))
        require(index.get('schemaVersion') == 2 and len(index.get('manifests', [])) == 1, 'OCI_INDEX')
        def blob(descriptor, limit=None):
            require(isinstance(descriptor, dict) and bool(DIGEST.fullmatch(descriptor.get('digest', ''))), 'OCI_DESCRIPTOR')
            name = 'blobs/sha256/' + descriptor['digest'][7:]
            require(name in entries and type(descriptor.get('size')) is int and descriptor['size'] == entries[name].size, 'OCI_SIZE')
            require(entries[name].size <= (limit or MAX_ARCHIVE), 'OCI_LIMIT')
            with tar.extractfile(entries[name]) as stream:
                require('sha256:' + stream_sha(stream) == descriptor['digest'], 'OCI_DIGEST')
            return read(name, limit) if limit else None
        descriptor = index['manifests'][0]
        manifest = json.loads(blob(descriptor, 1024 * 1024))
        require(manifest.get('schemaVersion') == 2 and isinstance(manifest.get('layers'), list), 'OCI_MANIFEST')
        config = json.loads(blob(manifest['config'], 1024 * 1024))
        for layer in manifest['layers']:
            blob(layer)
        require(config.get('os') == 'linux' and config.get('architecture') == 'amd64', 'PLATFORM')
        c = config.get('config', {})
        require(c.get('User') == 'node' and c.get('WorkingDir') == '/app/services/crm-flows' and c.get('Cmd') == ['node', 'main.cjs'], 'RUNTIME')
        variables = c.get('Env', [])
        require(isinstance(variables, list) and all(isinstance(v, str) and v.split('=', 1)[0] in ('PATH', 'NODE_VERSION', 'YARN_VERSION', 'NODE_ENV') for v in variables) and 'NODE_ENV=production' in variables, 'IMAGE_ENV')
        labels = c.get('Labels', {})
        require(labels.get('org.opencontainers.image.source') == SOURCE and labels.get('org.opencontainers.image.revision') == revision and labels.get('org.opencontainers.image.version') == revision and labels.get('io.shrigma.crm.execution') == 'off', 'LABELS')
        return {'manifest_digest': descriptor['digest'], 'config_digest': manifest['config']['digest']}


def verify_artifact(directory, expected_sha, expected_run):
    directory = Path(directory)
    require(bool(SHA.fullmatch(expected_sha)) and bool(re.fullmatch(r'[1-9][0-9]*', str(expected_run))), 'EXPECTED_IDENTITY')
    receipt = directory / 'image.json'
    require(receipt.is_file() and not receipt.is_symlink() and receipt.stat().st_size <= 16384, 'RECEIPT')
    data = json.loads(receipt.read_text())
    require(set(data) == {'source_sha', 'run_id', 'image', 'tag', 'archive_sha256', 'manifest_digest', 'config_digest', 'runtime_enabled', 'service_changed'}, 'RECEIPT_SHAPE')
    require(data['source_sha'] == expected_sha and data['run_id'] == str(expected_run) and data['image'] == IMAGE and data['tag'] == 'sha-' + expected_sha and data['runtime_enabled'] is False and data['service_changed'] is False, 'RECEIPT_IDENTITY')
    archive = directory / 'crm-flows.oci.tar'
    actual = verify_oci(archive, expected_sha)
    require(data['archive_sha256'] == file_sha(archive) and all(data[k] == v for k, v in actual.items()), 'RECEIPT_DIGEST')
    return {**data, 'archive_path': archive}


def build(repo, revision, output):
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and os.environ.get('GITHUB_REF') == 'refs/heads/main' and os.environ.get('GITHUB_REPOSITORY') == 'bandssz/shrigma-dash-cx', 'BUILD_CONTEXT')
    require(not os.environ.get('GH_TOKEN') and not os.environ.get('GITHUB_TOKEN'), 'BUILD_TOKEN')
    run = os.environ.get('GITHUB_RUN_ID', '')
    require(bool(re.fullmatch(r'[1-9][0-9]*', run)), 'RUN')
    require(not output.exists(), 'OUTPUT_EXISTS')
    output.mkdir(parents=True)
    local = 'crm-flows-proof:' + revision
    container = 'crm-flows-proof-' + run
    with tempfile.TemporaryDirectory(prefix='crm-flow-source-') as folder:
        context = Path(folder)
        source_context(repo, revision, context)
        command(['node', str(HERE / 'probe.cjs'), str(context)], error_code='DEDICATED_ROLE_REQUIRED')
        command(['node', '--test', 'tests/journey-graph-service.test.cjs'], cwd=context, error_code='SOURCE_TESTS_FAILED')
        args = ['docker', 'build', '--platform', 'linux/amd64', '--file', str(context / 'services/crm-flows/Dockerfile'), '--tag', local]
        for key, value in {'org.opencontainers.image.source': SOURCE, 'org.opencontainers.image.revision': revision, 'org.opencontainers.image.version': revision, 'io.shrigma.crm.execution': 'off'}.items():
            args += ['--label', key + '=' + value]
        command(args + [str(context)])
        archive = output / 'crm-flows.oci.tar'
        command(['skopeo', 'copy', 'docker-daemon:' + local, 'oci-archive:' + str(archive)])
        identity = verify_oci(archive, revision)
        require(json.loads(command(['docker', 'image', 'inspect', local]))[0]['Id'] == identity['config_digest'], 'TESTED_IMAGE_ID')
        env = json.loads(command(['node', '-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).syntheticEnv(process.argv[2])))', str(HERE / 'probe.cjs'), revision]))
        runtime = ['docker', 'run', '-d', '--name', container, '--network', 'none']
        for key, value in env.items():
            runtime += ['-e', key + '=' + value]
        try:
            command(runtime + [local])
            smoke = "(async()=>{for(let i=0;i<30;i++){try{const r=await fetch('http://127.0.0.1:8080/healthz');const b=await r.json();if(r.status===200&&b.execution_enabled===false&&b.revision===process.env.CRM_FLOWS_REVISION)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('OFF proof failed');})().catch(()=>process.exit(1))"
            command(['docker', 'exec', container, 'node', '-e', smoke])
            command(['docker', 'stop', '--time', '10', container])
            require(json.loads(command(['docker', 'inspect', container]))[0]['State']['ExitCode'] == 0, 'SHUTDOWN')
        finally:
            command(['docker', 'rm', '-f', container])
        data = {'source_sha': revision, 'run_id': run, 'image': IMAGE, 'tag': 'sha-' + revision, 'archive_sha256': file_sha(archive), **identity, 'runtime_enabled': False, 'service_changed': False}
        (output / 'image.json').write_text(json.dumps(data, indent=2) + '\n')
        verify_artifact(output, revision, run)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    require(bool(SHA.fullmatch(args.source_sha)), 'SOURCE_SHA')
    build(args.repo, args.source_sha, args.output)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        raise SystemExit(code if re.fullmatch(r'CRM_IMAGE_[A-Z_]{1,60}', code) else 'CRM_IMAGE_BUILD_UNCONFIRMED')
