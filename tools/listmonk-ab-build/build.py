#!/usr/bin/env python3
"""Candidate only. Official stuffbin writes the executable; Python verifies it.
No database, Docker, registry, host configuration, runtime activation or service start.
"""
import argparse
import datetime
import difflib
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import struct
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
LOCK = json.loads((HERE / 'upstream.lock.json').read_text())
LIMITS = LOCK['limits']
QUERY = LOCK['query']['asset']
BASE_URL = 'https://github.com/knadh/listmonk/releases/download/v6.1.0/'
STAMP = int(datetime.datetime(2026, 3, 29, 13, 27, 20, tzinfo=datetime.timezone.utc).timestamp())


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def bounded_file(path, limit):
    require(path.is_file() and not path.is_symlink(), 'Expected a regular input file')
    require(path.stat().st_size <= limit, 'Input exceeds byte limit')
    return path.read_bytes()


def locked_download(entry, destination, cache=None):
    source = cache / entry['name'] if cache else None
    if source:
        body = bounded_file(source, entry['bytes'])
    else:
        with urllib.request.urlopen(BASE_URL + entry['name'], timeout=45) as response:
            require(response.geturl().startswith('https://'), 'HTTPS download required')
            body = response.read(entry['bytes'] + 1)
    require(len(body) == entry['bytes'] and sha(body) == entry['sha256'], 'Official input size/hash mismatch')
    destination.write_bytes(body)
    return body


def release_files(archive):
    files = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as src:
        for member in src:
            require(member.name in ('LICENSE', 'README.md', 'listmonk'), 'Unexpected release member')
            require(member.name not in files and member.isfile() and member.size <= LIMITS['binary_bytes'], 'Unsafe release member')
            require(member.mode & 0o777 == (0o755 if member.name == 'listmonk' else 0o644), 'Unexpected release mode')
            with src.extractfile(member) as stream:
                data = stream.read(member.size + 1)
            require(len(data) == member.size, 'Truncated release member')
            files[member.name] = data
    require(set(files) == {'LICENSE', 'README.md', 'listmonk'}, 'Incomplete release')
    require(files['listmonk'][:4] == b'\x7fELF', 'Expected official Linux ELF executable')
    return files


def inspect_stuffed(binary):
    # Verified against stuffbin v1.3.0 GetFileID/GetStuff, not an ELF rewriter.
    require(24 <= len(binary) <= LIMITS['binary_bytes'], 'Invalid binary size')
    mark, bin_size, zip_size = struct.unpack('>8sQQ', binary[-24:])
    require(mark == b'stuffbin' and bin_size > 0 and zip_size <= LIMITS['zip_bytes'], 'Invalid stuffbin footer')
    require(bin_size + zip_size + 24 == len(binary), 'Stuffbin size mismatch')
    assets, total = {}, 0
    with zipfile.ZipFile(io.BytesIO(binary[bin_size:-24])) as z:
        require(0 < len(z.infolist()) <= LIMITS['asset_count'], 'Asset count limit')
        for entry in z.infolist():
            name = entry.filename
            require(len(name.encode()) <= LIMITS['asset_name_bytes'] and name.startswith('/') and not name.startswith('//'), 'Invalid asset name')
            require('\\' not in name and ':' not in name and '\x00' not in name and str(PurePosixPath(name)) == name and '..' not in PurePosixPath(name).parts, 'Unsafe asset path')
            mode = entry.external_attr >> 16
            require(stat.S_ISREG(mode) and stat.S_IMODE(mode) == 0o644 and not entry.flag_bits & 1 and not entry.is_dir(), 'Unsafe asset type/mode')
            require(name not in assets and entry.file_size <= LIMITS['asset_bytes'], 'Duplicate or oversized asset')
            total += entry.file_size
            require(total <= LIMITS['assets_total_bytes'], 'Expanded asset limit')
            with z.open(entry) as f:
                data = f.read(entry.file_size + 1)
            require(len(data) == entry.file_size, 'Truncated asset')
            assets[name] = {'body': data, 'mode': stat.S_IMODE(mode), 'sha256': sha(data), 'bytes': len(data)}
    require(QUERY in assets, 'Missing native query')
    return {'prefix': binary[:bin_size], 'bin_size': bin_size, 'zip_size': zip_size, 'assets': assets}


def compare(before, after):
    require(before['prefix'] == after['prefix'], 'Executable prefix changed')
    require(set(before['assets']) == set(after['assets']), 'Embedded asset set changed')
    changed = []
    for name in sorted(before['assets']):
        a, b = before['assets'][name], after['assets'][name]
        require(a['mode'] == b['mode'], 'Asset permission changed')
        if a['body'] != b['body']:
            changed.append(name)
    require(changed == [QUERY], 'Only the exact native query may change')
    require(before['assets'][QUERY]['sha256'] == LOCK['query']['upstream_sha256'], 'Upstream query drift')
    require(after['assets'][QUERY]['sha256'] == LOCK['query']['patched_sha256'], 'Patched query drift')
    return changed


def run(argv, timeout=120):
    result = subprocess.run(argv, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    require(len(result.stdout) + len(result.stderr) < 262144, 'Tool output exceeds limit')
    return result.stdout.decode()


def archive_bundle(folder, output):
    with output.open('xb') as raw:
        with gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode='w') as archive:
                for p in sorted(folder.rglob('*')):
                    if not p.is_file():
                        continue
                    require(not p.is_symlink(), 'Symlink in artifact')
                    info = tarfile.TarInfo(p.relative_to(folder).as_posix())
                    info.size = p.stat().st_size
                    info.mode = 0o755 if info.name == 'candidate/listmonk' else 0o644
                    info.mtime = STAMP
                    with p.open('rb') as f:
                        archive.addfile(info, f)
    require(output.stat().st_size <= LIMITS['artifact_bytes'], 'Artifact exceeds limit')


def build(target, output, stuffbin, cache=None):
    require(target in LOCK['releases'], 'Unsupported target')
    require(not output.exists(), 'Output must be a new directory')
    tool_info = run(['go', 'version', '-m', str(stuffbin)])
    require('path\tgithub.com/knadh/stuffbin/stuffbin' in tool_info and
            'mod\tgithub.com/knadh/stuffbin\tv1.3.0\t' + LOCK['stuffbin']['module_sum'] in tool_info and
            '=>' not in tool_info, 'Expected pinned official stuffbin module, without replacements')
    output.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix='listmonk-ab-build-') as tmp:
        work = Path(tmp)
        bundle = work / 'bundle'
        for part in ('candidate', 'rollback', 'source'):
            (bundle / part).mkdir(parents=True)
        checksums = locked_download(LOCK['checksums'], bundle / 'rollback' / LOCK['checksums']['name'], cache)
        entry = LOCK['releases'][target]
        archive = locked_download(entry, bundle / 'rollback' / entry['name'], cache)
        require(checksums.decode().splitlines().count(entry['sha256'] + '  ' + entry['name']) == 1, 'Official checksum entry differs')
        release = release_files(archive)
        before = inspect_stuffed(release['listmonk'])
        require(len(before['assets']) == LIMITS['expected_asset_count'], 'Unexpected official asset set')
        require(before['assets'][QUERY]['sha256'] == LOCK['query']['upstream_sha256'], 'Official embedded query differs')
        upstream = work / 'listmonk-upstream'
        upstream.write_bytes(release['listmonk'])
        # Official tool and independent reader must agree before any restuffing.
        official_zip = work / 'official.zip'
        run([str(stuffbin), '-a', 'unstuff', '-in', str(upstream), '-out', str(official_zip)])
        require(official_zip.read_bytes() == release['listmonk'][before['bin_size']:-24], 'Official extractor disagrees')
        asset_dir = work / 'assets'
        asset_dir.mkdir()
        args = []
        for i, (name, asset) in enumerate(sorted(before['assets'].items())):
            p = asset_dir / str(i)
            p.write_bytes(asset['body'])
            p.chmod(asset['mode'])
            os.utime(p, (STAMP, STAMP))
            args.append(str(p) + ':' + name)
        original_query = work / 'campaigns.sql'
        original_query.write_bytes(before['assets'][QUERY]['body'])
        patched_query = work / 'campaigns-patched.sql'
        patch_receipt = json.loads(run(['node', str(HERE / 'patch-query.cjs'), str(original_query), str(patched_query)]))
        require(patch_receipt['patched_sha256'] == LOCK['query']['patched_sha256'], 'Patch proof mismatch')
        query_index = sorted(before['assets']).index(QUERY)
        query_file = asset_dir / str(query_index)
        query_file.write_bytes(patched_query.read_bytes())
        os.utime(query_file, (STAMP, STAMP))
        candidate = bundle / 'candidate' / 'listmonk'
        run([str(stuffbin), '-a', 'stuff', '-in', str(upstream), '-out', str(candidate), *args])
        after = inspect_stuffed(bounded_file(candidate, LIMITS['binary_bytes']))
        changed = compare(before, after)
        output_zip = work / 'candidate.zip'
        run([str(stuffbin), '-a', 'unstuff', '-in', str(candidate), '-out', str(output_zip)])
        require(output_zip.read_bytes() == candidate.read_bytes()[after['bin_size']:-24], 'Candidate official extractor disagrees')
        (bundle / 'LICENSE').write_bytes(release['LICENSE'])
        (bundle / 'UPSTREAM-README.md').write_bytes(release['README.md'])
        for name in ('upstream.lock.json', 'README.md', 'build.py', 'patch-query.cjs', 'go.mod', 'go.sum', 'test_build.py'):
            shutil.copyfile(HERE / name, bundle / 'source' / name)
        patch_source = REPO / 'n8n/growth/ab-listmonk-cohort-patch.cjs'
        shutil.copyfile(patch_source, bundle / 'source' / patch_source.name)
        (bundle / 'source' / 'campaigns.upstream.sql').write_bytes(original_query.read_bytes())
        (bundle / 'source' / 'campaigns.candidate.sql').write_bytes(patched_query.read_bytes())
        (bundle / 'source' / 'campaigns.patch').write_text(''.join(difflib.unified_diff(original_query.read_text().splitlines(True), patched_query.read_text().splitlines(True), fromfile='upstream/queries/campaigns.sql', tofile='candidate/queries/campaigns.sql')))
        revision = run(['git', '-C', str(REPO), 'rev-parse', 'HEAD']).strip()
        dirty = bool(run(['git', '-C', str(REPO), 'status', '--porcelain', '--untracked-files=no']).strip())
        (bundle / 'SOURCE.md').write_text(f'''# Corresponding source and status\n\nCandidate only; runtime activation remains OFF. This manifest is not an activation receipt.\n\nUpstream Listmonk {LOCK['tag']} (AGPL-3.0), exact source commit:\nhttps://github.com/knadh/listmonk/tree/{LOCK['commit']}\nSource archive: https://github.com/knadh/listmonk/archive/{LOCK['commit']}.tar.gz\nOfficial release: https://github.com/knadh/listmonk/releases/tag/{LOCK['tag']}\n\nThe upstream executable prefix is unchanged. Only the embedded campaigns SQL changes.\nComplete changed query, unified diff and pure patch are included under source/.\nLocal repository revision: {revision}; working tree modified: {str(dirty).lower()}.\nThe pinned module uses the official stuffbin API/CLI v1.3.0:\nhttps://github.com/knadh/stuffbin/tree/v1.3.0\n\nRollback archive is the original official release, hash verified against its published\nchecksums file. Do not roll back while an A/B campaign or buffered batch can execute.\nHost version/architecture, SQL OFF migration, service rehearsal, opt-out, checkpoints,\nloads and shared-service impact must be validated before a separately authorized rollout.\n''')
        manifest = {'schema': 'listmonk-ab-candidate-v1', 'status': 'CANDIDATE_OFF_NOT_DEPLOYED', 'target': target,
                    'upstream': entry, 'upstream_commit': LOCK['commit'], 'checksum_provenance': LOCK['checksum_provenance'],
                    'repository_revision': revision, 'repository_modified': dirty, 'patch': patch_receipt,
                    'executable_prefix': {'bytes': before['bin_size'], 'sha256': sha(before['prefix']), 'unchanged': True},
                    'official_binary_sha256': sha(release['listmonk']), 'candidate_binary_sha256': sha(candidate.read_bytes()),
                    'stuffbin': {'version': LOCK['stuffbin']['version'], 'binary_sha256': sha(bounded_file(stuffbin, LIMITS['binary_bytes'])), 'build_info': tool_info},
                    'changed_assets': changed, 'asset_count': len(after['assets']),
                    'assets': [{'path': name, 'before_sha256': before['assets'][name]['sha256'], 'after_sha256': a['sha256'], 'bytes': a['bytes'], 'mode': oct(a['mode'])} for name, a in sorted(after['assets'].items())]}
        # Inventory all distributable source/licenses/rollback files, excluding this manifest.
        manifest['files'] = [{'path': p.relative_to(bundle).as_posix(), 'bytes': p.stat().st_size, 'sha256': sha(p.read_bytes())} for p in sorted(bundle.rglob('*')) if p.is_file()]
        report = json.dumps(manifest, indent=2, ensure_ascii=False) + '\n'
        (bundle / 'manifest.json').write_text(report)
        (output / 'manifest.json').write_text(report)
        artifact = output / f'listmonk-6.1.0-crm-ab-candidate-{target}.tar.gz'
        archive_bundle(bundle, artifact)
        (output / 'SHA256SUMS').write_text(sha(artifact.read_bytes()) + '  ' + artifact.name + '\n')
        print(json.dumps({'target': target, 'status': manifest['status'], 'assets': len(after['assets']), 'changed_assets': changed, 'artifact_bytes': artifact.stat().st_size, 'sha256': sha(artifact.read_bytes())}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True, choices=tuple(LOCK['releases']))
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--stuffbin', required=True, type=Path)
    parser.add_argument('--downloads', type=Path, help='Optional directory of exact locked official inputs; no downloads in this mode.')
    args = parser.parse_args()
    build(args.target, args.out.resolve(), args.stuffbin.resolve(), args.downloads.resolve() if args.downloads else None)
