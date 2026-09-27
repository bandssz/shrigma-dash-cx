#!/usr/bin/env python3
"""Build-only OCI proof. Never run Listmonk, push a registry, or contact a host."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile

HERE = Path(__file__).resolve().parent
LOCK = json.loads((HERE / 'lock.json').read_text())
BUILDER = 'crm-ab-oci-proof'


def require(ok, code):
    if not ok:
        raise ValueError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_bound(path, maximum):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= maximum, 'AB_IMAGE_FILE_BOUND')
    return path.read_bytes()


def json_bytes(data):
    return json.dumps(data, sort_keys=True, indent=2).encode() + b'\n'


def write_json(path, data):
    path.write_bytes(json_bytes(data))


def verify_run(run):
    require(run.get('id') == LOCK['run_id'] and run.get('head_sha') == LOCK['source_head'] and
            run.get('conclusion') == 'success' and run.get('status') == 'completed' and
            run.get('path') == LOCK['workflow_path'] and run.get('event') == 'pull_request' and
            run.get('repository', {}).get('full_name') == LOCK['repository'], 'AB_IMAGE_UNAPPROVED_RUN')
    return {k: run[k] for k in ('id', 'head_sha', 'conclusion', 'status', 'path', 'event')}


def regular_tar(data, maximum, allow_dirs=False, layer=False):
    require(len(data) <= maximum, 'AB_IMAGE_ARCHIVE_BOUND')
    out, seen, total = {}, set(), 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as tar:
        for item in tar:
            name = item.name.rstrip('/') if item.isdir() else item.name
            parts = PurePosixPath(name)
            require(name and not parts.is_absolute() and '..' not in parts.parts and '\\' not in name and
                    str(parts) == name and name not in seen, 'AB_IMAGE_ARCHIVE_PATH')
            seen.add(name)
            require(len(seen) <= 256, 'AB_IMAGE_ARCHIVE_COUNT')
            if layer:
                require(item.uid == 0 and item.gid == 0 and not item.pax_headers, 'AB_IMAGE_LAYER_METADATA')
            if item.isdir() and allow_dirs:
                if layer:
                    require(name == 'listmonk' and item.mode == 0o755, 'AB_IMAGE_DIRECTORY_CHANGED')
                continue
            require(item.isfile() and not item.linkname and not item.pax_headers, 'AB_IMAGE_ARCHIVE_TYPE')
            total += item.size
            require(0 <= item.size <= maximum and total <= maximum, 'AB_IMAGE_ARCHIVE_BOUND')
            value = tar.extractfile(item).read(item.size + 1)
            require(len(value) == item.size, 'AB_IMAGE_ARCHIVE_TRUNCATED')
            out[name] = (value, item.mode)
    return out


def dockerfile():
    return ('# Build-only candidate: no RUN, no container start, no registry push.\n'
            'FROM ' + LOCK['base_image'] + '\n'
            'COPY --chmod=0755 candidate/listmonk /listmonk/listmonk\n')


def prepare(artifact, run, out):
    source_run = verify_run(run)
    require(not out.exists(), 'AB_IMAGE_OUTPUT_EXISTS')
    archive = read_bound(artifact / LOCK['archive_name'], LOCK['max_archive_bytes'])
    require(sha(archive) == LOCK['archive_sha256'], 'AB_IMAGE_ARCHIVE_HASH')
    files = regular_tar(archive, LOCK['max_archive_bytes'])
    m = json.loads(files['manifest.json'][0])
    require(m.get('status') == 'CANDIDATE_OFF_NOT_DEPLOYED' and m.get('target') == 'linux_amd64' and
            m.get('repository_revision') == LOCK['ci_revision'] and m.get('repository_modified') is False and
            m.get('asset_count') == 130 and m.get('changed_assets') == ['/queries/campaigns.sql'] and
            m.get('candidate_binary_sha256') == LOCK['binary_sha256'] and
            m.get('patch', {}).get('patched_sha256') == LOCK['query_sha256'], 'AB_IMAGE_MANIFEST')
    require(sha(files['candidate/listmonk'][0]) == LOCK['binary_sha256'] and
            files['candidate/listmonk'][1] == 0o755 and
            sha(files['source/campaigns.candidate.sql'][0]) == LOCK['query_sha256'] and
            LOCK['ci_revision'].encode() in files['SOURCE.md'][0], 'AB_IMAGE_SOURCE_OR_BINARY')
    out.mkdir(parents=True)
    context = out / 'context'
    (context / 'candidate').mkdir(parents=True)
    (context / 'candidate/listmonk').write_bytes(files['candidate/listmonk'][0])
    (context / 'candidate/listmonk').chmod(0o755)
    os.utime(context / 'candidate/listmonk', (0, 0))
    (context / 'Dockerfile').write_text(dockerfile())
    (context / '.dockerignore').write_text('*\n!Dockerfile\n!candidate/\n!candidate/listmonk\n')
    sources = out / 'source'
    sources.mkdir()
    (sources / LOCK['archive_name']).write_bytes(archive)
    for name in ('LICENSE', 'SOURCE.md', 'manifest.json'):
        (sources / name).write_bytes(files[name][0])
    for name in ('build.py', 'test_build.py', 'lock.json', 'base-config.json', 'README.md'):
        shutil.copyfile(HERE / name, sources / name)
    shutil.copyfile(context / 'Dockerfile', sources / 'Dockerfile')
    shutil.copyfile(HERE.parents[1] / '.github/workflows/ab-listmonk-image-build.yml', sources / 'ab-listmonk-image-build.yml')
    write_json(sources / 'approved-run.json', source_run)
    return context


def bounded_gunzip(data, maximum):
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
        value = stream.read(maximum + 1)
        require(len(value) <= maximum, 'AB_IMAGE_LAYER_BOUND')
        require(not stream.read(1), 'AB_IMAGE_LAYER_BOUND')
        return value


def verify_oci(path, base_bytes):
    require('sha256:' + sha(base_bytes) == LOCK['base_config_digest'], 'AB_IMAGE_BASE_IDENTITY')
    base = json.loads(base_bytes)
    require(base.get('architecture') == 'amd64' and base.get('os') == 'linux', 'AB_IMAGE_BASE_IDENTITY')
    files = regular_tar(read_bound(path, LOCK['max_oci_bytes']), LOCK['max_oci_bytes'], allow_dirs=True)
    require(json.loads(files['oci-layout'][0]) == {'imageLayoutVersion': '1.0.0'}, 'AB_IMAGE_LAYOUT')
    for name, (value, _) in files.items():
        require(name in ('index.json', 'oci-layout') or re.fullmatch(r'blobs/sha256/[0-9a-f]{64}', name), 'AB_IMAGE_OCI_PATH')
        if name.startswith('blobs/'):
            require(sha(value) == name.rsplit('/', 1)[1], 'AB_IMAGE_BLOB_HASH')

    def blob(descriptor):
        digest = descriptor.get('digest', '')
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', digest), 'AB_IMAGE_DESCRIPTOR')
        name = 'blobs/sha256/' + digest[7:]
        require(name in files, 'AB_IMAGE_BLOB_MISSING')
        value = files[name][0]
        require(len(value) == descriptor.get('size'), 'AB_IMAGE_DESCRIPTOR_SIZE')
        return value

    index = json.loads(files['index.json'][0])
    for _ in range(3):
        require(index.get('schemaVersion') == 2 and len(index.get('manifests', [])) == 1, 'AB_IMAGE_SINGLE_MANIFEST')
        descriptor = index['manifests'][0]
        document = json.loads(blob(descriptor))
        if 'layers' in document:
            manifest, manifest_digest = document, descriptor['digest']
            break
        index = document
    else:
        raise ValueError('AB_IMAGE_INDEX_DEPTH')
    require(manifest.get('schemaVersion') == 2, 'AB_IMAGE_MANIFEST_SCHEMA')
    config = json.loads(blob(manifest['config']))
    require(config.get('architecture') == 'amd64' and config.get('os') == 'linux' and
            config.get('config') == base.get('config'), 'AB_IMAGE_CONFIG_CHANGED')
    require(not base.get('config', {}).get('OnBuild'), 'AB_IMAGE_BASE_ONBUILD')
    layers = manifest['layers']
    require(len(layers) == len(LOCK['base_layers']) + 1, 'AB_IMAGE_LAYER_COUNT')
    for got, expected in zip(layers, LOCK['base_layers']):
        require(got['digest'] == expected['digest'] and got['size'] == expected['size'], 'AB_IMAGE_BASE_LAYER_CHANGED')
        blob(got)
    diff_ids = config.get('rootfs', {}).get('diff_ids', [])
    require(config.get('rootfs', {}).get('type') == 'layers' and
            diff_ids[:-1] == base.get('rootfs', {}).get('diff_ids') and len(diff_ids) == len(layers), 'AB_IMAGE_ROOTFS_CHANGED')
    last = layers[-1]
    require(last.get('mediaType') in ('application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.docker.image.rootfs.diff.tar.gzip'), 'AB_IMAGE_LAYER_ENCODING')
    raw = bounded_gunzip(blob(last), LOCK['max_archive_bytes'])
    require('sha256:' + sha(raw) == diff_ids[-1], 'AB_IMAGE_DIFF_ID')
    changed = regular_tar(raw, LOCK['max_archive_bytes'], allow_dirs=True, layer=True)
    require(set(changed) == {'listmonk/listmonk'}, 'AB_IMAGE_UNEXPECTED_CHANGE')
    binary, mode = changed['listmonk/listmonk']
    require(sha(binary) == LOCK['binary_sha256'] and mode == 0o755, 'AB_IMAGE_BINARY_CHANGED')
    return {'policy': LOCK['policy'], 'status': 'VERIFIED_BUILD_ONLY_OFF_NOT_DEPLOYED',
            'source_run': LOCK['run_id'], 'source_head': LOCK['source_head'], 'ci_revision': LOCK['ci_revision'],
            'base_image': LOCK['base_image'], 'rollback_image': LOCK['base_image'],
            'oci_archive_sha256': sha(path.read_bytes()), 'image_manifest_digest': manifest_digest,
            'config_digest': manifest['config']['digest'], 'base_layers_preserved': len(LOCK['base_layers']),
            'additional_layer_files': ['listmonk/listmonk'], 'binary_sha256': sha(binary),
            'query_sha256': LOCK['query_sha256'], 'base_config_preserved': True,
            'runtime_activation': False, 'listmonk_executed': False, 'registry_push': False, 'host_access': False}


def require_ci():
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('AB_IMAGE_BUILD_ONLY') == '1' and
            sys.platform == 'linux', 'AB_IMAGE_CI_ONLY')


def run_command(args, **kwargs):
    return subprocess.run(args, check=True, timeout=300, **kwargs)


def build(artifact, run, out):
    require_ci()
    context = prepare(artifact, run, out)
    base = read_bound(HERE / 'base-config.json', 16384)
    require('sha256:' + sha(base) == LOCK['base_config_digest'] and
            not json.loads(base).get('config', {}).get('OnBuild'), 'AB_IMAGE_BASE_IDENTITY')
    created = False
    try:
        run_command(['docker', 'buildx', 'create', '--name', BUILDER, '--driver', 'docker-container',
                     '--driver-opt', 'image=' + LOCK['builder_image'], '--driver-opt', 'memory=1g,cpu-quota=200000'])
        created = True
        run_command(['docker', 'buildx', 'build', '--builder', BUILDER, '--platform', 'linux/amd64',
                     '--provenance=false', '--sbom=false', '--network=none', '--progress=plain',
                     '--output', 'type=oci,dest=' + str(out / 'listmonk-ab-linux-amd64.oci.tar'), str(context)])
    finally:
        if created:
            run_command(['docker', 'buildx', 'rm', '--force', BUILDER])
    proof = verify_oci(out / 'listmonk-ab-linux-amd64.oci.tar', base)
    proof.update(builder_image=LOCK['builder_image'], build_recipe_revision=os.environ.get('GITHUB_SHA'),
                 build_workflow_run=os.environ.get('GITHUB_RUN_ID'))
    write_json(out / 'image-manifest.json', proof)
    shutil.rmtree(context)
    files = sorted(f for f in out.rglob('*') if f.is_file())
    (out / 'SHA256SUMS').write_text(''.join(sha(f.read_bytes()) + '  ' + str(f.relative_to(out)) + '\n' for f in files))
    print(json.dumps({'status': proof['status'], 'image_manifest_digest': proof['image_manifest_digest'], 'registry_push': False}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['verify-run', 'build'])
    parser.add_argument('--run-json', type=Path, required=True)
    parser.add_argument('--artifact-dir', type=Path)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    run = json.loads(read_bound(args.run_json, 1024 * 1024))
    if args.action == 'verify-run':
        print(json.dumps(verify_run(run)))
    else:
        require(args.artifact_dir is not None and args.out is not None, 'AB_IMAGE_ARGUMENTS')
        build(args.artifact_dir, run, args.out)


if __name__ == '__main__':
    main()
