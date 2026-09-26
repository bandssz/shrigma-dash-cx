"""Download and inspect only the pinned, unmodified official Linux release."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import struct
import tarfile
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
LOCK = json.loads((HERE / 'upstream.lock.json').read_text())
BASE = 'https://github.com/knadh/listmonk/releases/download/v6.1.0/'
MAX_BINARY = 32 * 1024 * 1024


def require(ok, code):
    if not ok:
        raise ValueError(code)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def bounded(path, limit):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= limit, 'INPUT_FILE_LIMIT')
    return path.read_bytes()


def download(entry, cache=None):
    if cache is not None:
        body = bounded(cache / entry['name'], entry['bytes'])
    else:
        with urllib.request.urlopen(BASE + entry['name'], timeout=45) as r:
            require(r.geturl().startswith('https://'), 'HTTPS_REQUIRED')
            body = r.read(entry['bytes'] + 1)
    require(len(body) == entry['bytes'] and sha(body) == entry['sha256'], 'UPSTREAM_HASH_MISMATCH')
    return body


def extract(archive):
    files = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        for item in tar:
            require(item.name in ('listmonk', 'LICENSE', 'README.md') and item.name not in files
                    and item.isfile() and item.size <= MAX_BINARY, 'RELEASE_MEMBER_INVALID')
            files[item.name] = tar.extractfile(item).read(item.size + 1)
            require(len(files[item.name]) == item.size, 'RELEASE_MEMBER_TRUNCATED')
    require(set(files) == {'listmonk', 'LICENSE', 'README.md'}, 'RELEASE_INCOMPLETE')
    binary = files['listmonk']
    require(binary[:4] == b'\x7fELF' and len(binary) >= 24, 'ELF_REQUIRED')
    mark, prefix, size = struct.unpack('>8sQQ', binary[-24:])
    require(mark == b'stuffbin' and 0 < size <= 8 * 1024 * 1024
            and prefix > 0 and prefix + size + 24 == len(binary), 'STUFFBIN_INVALID')
    with zipfile.ZipFile(io.BytesIO(binary[prefix:-24])) as z:
        entries = z.infolist()
        require(len(entries) == LOCK['expected_assets'] and len({x.filename for x in entries}) == len(entries), 'ASSET_SET_INVALID')
        for name in ('/schema.sql', '/queries/campaigns.sql'):
            info = z.getinfo(name)
            require(not info.is_dir() and info.file_size < 1024 * 1024, 'ASSET_LIMIT')
            files[name] = z.read(name)
    require(sha(files['/queries/campaigns.sql']) == LOCK['query_sha256'], 'NATIVE_QUERY_DRIFT')
    return files


def prepare(output, cache=None):
    require(not output.exists(), 'OUTPUT_ALREADY_EXISTS')
    checksums = download(LOCK['checksums'], cache)
    entry = LOCK['release']
    require(checksums.decode().splitlines().count(entry['sha256'] + '  ' + entry['name']) == 1, 'CHECKSUM_ENTRY_MISMATCH')
    files = extract(download(entry, cache))
    output.mkdir(parents=True)
    for name in ('listmonk', 'LICENSE', 'README.md'):
        (output / name).write_bytes(files[name])
    (output / 'listmonk').chmod(0o700)
    (output / 'schema.sql').write_bytes(files['/schema.sql'])
    proof = {'version': LOCK['version'], 'commit': LOCK['commit'], 'archive_sha256': entry['sha256'],
             'binary_sha256': sha(files['listmonk']), 'schema_sha256': sha(files['/schema.sql']),
             'query_sha256': LOCK['query_sha256'], 'assets': LOCK['expected_assets'], 'patched': False}
    (output / 'manifest.json').write_text(json.dumps(proof, indent=2) + '\n')
    print(json.dumps({'prepared': True, 'version': LOCK['version'], 'patched': False}))


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--cache', type=Path)
    a = p.parse_args()
    prepare(a.out.resolve(), a.cache.resolve() if a.cache else None)
