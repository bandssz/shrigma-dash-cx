#!/usr/bin/env python3
"""Build a local candidate with its changed sources. Never start or publish it."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import zipfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SOURCE_SHA = '5053a255705160b14250536d5aacd5f24d4d6043ae2d17459959a5cfe2c49a3c'
SMTP_ZIP_SHA = 'f6ca6779e64d24ae5ec6a09db5fae964890bf38a0fdaca524facd9d4cafa4011'
SMTP_SUM = 'h1:8nE1NkG/SP4wUgyXK8C+FuJB6JnQ9pJ6MeAiUZxjb+o='
STAMP = 1774790840


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def read(path, maximum=64 * 1024 * 1024):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= maximum, 'Invalid bounded input')
    return path.read_bytes()


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def command(args, cwd, env, timeout=600):
    result = subprocess.run([str(x) for x in args], cwd=cwd, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    require(len(result.stdout) + len(result.stderr) < 1024 * 1024, 'Tool output limit')
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors='replace')[-6000:])
    return result.stdout.decode()


def safe_relative(name, prefix):
    if name == prefix.rstrip('/'):
        return None
    require(name.startswith(prefix), 'Unexpected archive prefix')
    relative = name[len(prefix):].rstrip('/')
    if not relative:
        return None
    p = PurePosixPath(relative)
    require(not p.is_absolute() and '..' not in p.parts and '\\' not in relative and str(p) == relative,
            'Unsafe archive member')
    return relative


def extract_source(path, out):
    require(sha(read(path)) == SOURCE_SHA, 'Upstream source archive drift')
    count, size, seen = 0, 0, set()
    with tarfile.open(path, 'r:gz') as archive:
        for item in archive:
            relative = safe_relative(item.name, 'knadh-listmonk-1b5e8d3/')
            if relative is None:
                require(item.isdir(), 'Invalid archive root')
                continue
            require(relative not in seen and (item.isdir() or item.isfile()), 'Unsafe or duplicate archive type')
            seen.add(relative)
            count += 1
            size += item.size
            require(count < 2000 and size < 32 * 1024 * 1024, 'Source archive bound')
            target = out / relative
            if item.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                value = archive.extractfile(item).read(item.size + 1)
                require(len(value) == item.size, 'Truncated source')
                target.write_bytes(value)
                target.chmod(0o755 if item.mode & 0o111 else 0o644)


def extract_smtp(path, out):
    require(sha(read(path, 128 * 1024)) == SMTP_ZIP_SHA, 'SMTP module archive drift')
    size, seen = 0, set()
    with zipfile.ZipFile(path) as archive:
        for item in archive.infolist():
            relative = safe_relative(item.filename, 'github.com/knadh/smtppool/v2@v2.0.2/')
            require(relative and relative not in seen and not item.is_dir() and not item.flag_bits & 1,
                    'Invalid module member')
            seen.add(relative)
            size += item.file_size
            require(len(seen) < 100 and size < 1024 * 1024, 'Module bound')
            value = archive.read(item)
            require(len(value) == item.file_size, 'Truncated module')
            target = out / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(value)
            target.chmod(0o644)


def build(args):
    require(not args.out.exists(), 'Use a new output directory')
    args.out.mkdir(parents=True)
    source = args.out / 'source'
    listmonk, smtp = source / 'listmonk', source / 'smtppool'
    extract_source(args.source_archive, listmonk)
    extract_smtp(args.smtp_archive, smtp)
    sums = (listmonk / 'go.sum').read_text()
    require('github.com/knadh/smtppool/v2 v2.0.2 ' + SMTP_SUM in sums, 'SMTP dependency sum drift')
    overlay = REPO / 'tools/listmonk-regular-build'
    smtp_builder = module('regular_smtp_builder', overlay / 'build.py')
    worker_builder = module('regular_worker_builder', overlay / 'worker_patch.py')
    smtp_receipt = smtp_builder.apply(listmonk, smtp)
    worker_receipt = worker_builder.apply(listmonk, REPO)
    lock = json.loads((overlay / 'upstream.lock.json').read_text())
    (source / 'go.work').write_text('go 1.26.1\n\nuse (\n ./listmonk\n ./smtppool\n)\n')
    env = dict(os.environ, GOTOOLCHAIN='local', GOWORK=str((source / 'go.work').resolve()),
               GOPROXY='off', GOSUMDB='off', CGO_ENABLED='0')
    for name in ('GOOS', 'GOARCH', 'GOFLAGS'):
        env.pop(name, None)
    require(command([args.go, 'version'], listmonk, env).startswith('go version go1.26.1 '), 'Pinned Go SDK required')
    command([args.go, 'mod', 'verify'], listmonk, dict(env, GOWORK='off'))
    # Build the official pinned stuffing tool for this host; no target program runs.
    tool_dir = args.out / 'tools'
    tool_dir.mkdir()
    tool = tool_dir / 'stuffbin'
    command([args.go, 'build', '-trimpath', '-buildvcs=false', '-o', tool.resolve(),
             'github.com/knadh/stuffbin/stuffbin'], listmonk, env)
    tool_metadata = command([args.go, 'version', '-m', tool.resolve()], listmonk, env)
    require('github.com/knadh/stuffbin\tv1.3.0\th1:HaVSuYV+KnrlCHl7DrLNyOCgpTU2K8x5Hb+J4Ck3gww=' in tool_metadata,
            'Official stuffbin dependency required')
    goos, goarch = args.target.split('_')
    target_env = dict(env, GOOS=goos, GOARCH=goarch)
    raw = args.out / 'listmonk.unstuffed'
    build_id = 'v6.1.0-crm-regular-' + sha((overlay / 'upstream.lock.json').read_bytes())[:12]
    graph_runtime_sha = worker_receipt['graph_cache_runtime_sha256']
    require(len(graph_runtime_sha) == 64, 'Graph cache runtime source identity required')
    command([args.go, 'build', '-trimpath', '-buildvcs=false', '-o', raw.resolve(),
             '-ldflags=-s -w -X main.buildString=' + build_id + ' -X main.versionString=v6.1.0'
             + ' -X main.graphCacheRuntimeSHA=' + graph_runtime_sha, './cmd'], listmonk, target_env)
    raw_bytes = read(raw)
    if args.target == 'linux_amd64':
        require(raw_bytes[:6] == b'\x7fELF\x02\x01' and raw_bytes[18:20] == b'\x3e\x00', 'Expected Linux amd64 ELF')
    else:
        require(raw_bytes[:8] == b'\xcf\xfa\xed\xfe\x0c\x00\x00\x01', 'Expected Darwin arm64 Mach-O')
    raw_metadata = command([args.go, 'version', '-m', raw.resolve()], listmonk, env)
    require('GOOS=' + goos in raw_metadata and 'GOARCH=' + goarch in raw_metadata and 'CGO_ENABLED=0' in raw_metadata,
            'Target build metadata drift')
    parser = module('official_release_reader', REPO / 'tools/listmonk-ab-build/build.py')
    release_entry = parser.LOCK['releases']['linux_amd64']
    release_bytes = read(args.release_cache / release_entry['name'])
    checksums = read(args.release_cache / parser.LOCK['checksums']['name'])
    require(sha(release_bytes) == release_entry['sha256'] and sha(checksums) == parser.LOCK['checksums']['sha256'],
            'Official release/checksum drift')
    require(checksums.decode().splitlines().count(release_entry['sha256'] + '  ' + release_entry['name']) == 1,
            'Official checksum entry mismatch')
    release = parser.release_files(release_bytes)
    before = parser.inspect_stuffed(release['listmonk'])
    require(len(before['assets']) == 130, 'Official asset count changed')
    query = (listmonk / 'queries/campaigns.sql').read_bytes()
    require(sha(query) == lock['worker']['regular_query_sha256'], 'Worker query drift')
    asset_dir = args.out / 'assets'
    asset_dir.mkdir()
    stuffing = []
    for index, (name, asset) in enumerate(sorted(before['assets'].items())):
        target = asset_dir / str(index)
        target.write_bytes(query if name == parser.QUERY else asset['body'])
        target.chmod(0o644)
        os.utime(target, (STAMP, STAMP))
        stuffing.append(str(target.resolve()) + ':' + name)
    candidate_dir = args.out / 'candidate'
    candidate_dir.mkdir()
    binary = candidate_dir / 'listmonk'
    command([tool.resolve(), '-a', 'stuff', '-in', raw.resolve(), '-out', binary.resolve(), *stuffing], listmonk, env)
    binary.chmod(0o755)
    after = parser.inspect_stuffed(read(binary))
    require(after['prefix'] == raw_bytes and set(before['assets']) == set(after['assets']), 'Compiled prefix/asset set drift')
    changed = [name for name in sorted(before['assets']) if before['assets'][name]['body'] != after['assets'][name]['body']]
    require(changed == [parser.QUERY] and after['assets'][parser.QUERY]['sha256'] == sha(query), 'Unexpected embedded asset change')
    rollback = args.out / 'rollback'
    rollback.mkdir()
    (rollback / release_entry['name']).write_bytes(release_bytes)
    (rollback / parser.LOCK['checksums']['name']).write_bytes(checksums)
    recipes = source / 'recipe'
    shutil.copytree(overlay, recipes / 'listmonk-regular-build', ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copytree(HERE, recipes / 'listmonk-regular-package', ignore=shutil.ignore_patterns('__pycache__'))
    graph_recipe = recipes / 'graph-cache-runtime'
    graph_recipe_files = {}
    for name, expected in sorted(lock['graph_cache']['runtime_sources']['repo'].items()):
        source_file = REPO / name
        body = read(source_file)
        require(sha(body) == expected, 'Graph cache recipe source drift')
        target = graph_recipe / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        graph_recipe_files[name] = expected
    query_sources = source / 'query-composer'
    query_sources.mkdir()
    for name in ('segment-listmonk-selection.cjs', 'ab-listmonk-cohort-patch.cjs'):
        shutil.copyfile(REPO / 'n8n/growth' / name, query_sources / name)
    (args.out / 'LICENSE').write_bytes(release['LICENSE'])
    (args.out / 'BUILDINFO.txt').write_text(raw_metadata)
    manifest = {
        'schema': 'listmonk-regular-package-v1', 'status': 'CANDIDATE_OFF_NOT_DEPLOYED',
        'target': args.target, 'go_version': '1.26.1', 'upstream_commit': lock['listmonk']['commit'],
        'upstream_source_sha256': SOURCE_SHA, 'smtppool_zip_sha256': SMTP_ZIP_SHA,
        'source_lock_sha256': sha((overlay / 'upstream.lock.json').read_bytes()),
        'compiled_prefix_sha256': sha(raw_bytes), 'binary_sha256': sha(read(binary)),
        'query_sha256': sha(query), 'asset_count': 130, 'changed_assets': changed,
        'graph_cache_runtime_sha256': graph_runtime_sha,
        'graph_cache_runtime_recipe': graph_recipe_files,
        'graph_cache_enabled_by_default': False,
        'smtp_overlay': smtp_receipt, 'worker_overlay': worker_receipt,
        'runtime_activation': False, 'listmonk_executed': False, 'registry_push': False,
        'production_changed': False,
    }
    (args.out / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    (args.out / 'SOURCE.md').write_text(
        '# Regular worker candidate — OFF\n\n'
        'The executable was compiled from source/listmonk (Listmonk AGPL-3.0), using the modified '
        'source/smtppool (MIT) through source/go.work. Both source trees, licenses, module manifests '
        'and locked transformation recipes are included. Go dependencies remain pinned in go.sum.\n\n'
        'Upstream commit: https://github.com/knadh/listmonk/tree/' + lock['listmonk']['commit'] + '\n\n'
        '130 assets were preserved from the official v6.1.0 release except /queries/campaigns.sql. '
        'The Go executable prefix is newly compiled. BUILDINFO.txt records the compiler and modules. '
        'The executable includes the pinned graph-cache guard and its deterministic runtime source identity, '
        'and source/recipe/graph-cache-runtime preserves the two repository inputs included in that identity. '
        'The graph-cache deployment remains disabled by default and this package does not authorize delivery.\n\n'
        'No image was published or target process started. This build is not operational admission. '
        'The production guard remains unchanged. Do not replace a running service with this candidate.\n')
    # Keep only deliverable inputs and outputs, not throwaway stuffing intermediates.
    shutil.rmtree(asset_dir)
    shutil.rmtree(tool_dir)
    raw.unlink()
    files = sorted(p for p in args.out.rglob('*') if p.is_file())
    (args.out / 'SHA256SUMS').write_text(''.join(sha(read(p)) + '  ' + p.relative_to(args.out).as_posix() + '\n' for p in files))
    print(json.dumps({k: manifest[k] for k in ('status', 'target', 'binary_sha256', 'query_sha256', 'asset_count')}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ('source-archive', 'smtp-archive', 'release-cache', 'go', 'out'):
        parser.add_argument('--' + option, required=True, type=Path)
    parser.add_argument('--target', choices=('linux_amd64', 'darwin_arm64'), default='linux_amd64')
    build(parser.parse_args())
