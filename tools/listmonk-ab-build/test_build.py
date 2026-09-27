import hashlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('ab_build', HERE / 'build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


def stuffed(files, prefix=b'\x7fELFsynthetic-no-executable-code', modes=None):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        for name, body in files:
            info = zipfile.ZipInfo(name, (2026, 3, 29, 13, 27, 20))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = ((modes or {}).get(name, 0o100644)) << 16
            z.writestr(info, body)
    data = buf.getvalue()
    return prefix + data + struct.pack('>8sQQ', b'stuffbin', len(prefix), len(data))


class BuildTests(unittest.TestCase):
    def test_reader_uses_official_footer_and_keeps_asset_set(self):
        blob = stuffed([(build.QUERY, b'select synthetic'), ('/admin/index.html', b'UI')])
        got = build.inspect_stuffed(blob)
        self.assertEqual(got['prefix'], b'\x7fELFsynthetic-no-executable-code')
        self.assertEqual(set(got['assets']), {build.QUERY, '/admin/index.html'})
        self.assertEqual(got['assets'][build.QUERY]['body'], b'select synthetic')
        for corrupt in (blob[:-1], blob + b'extra', blob[:-24] + struct.pack('>8sQQ', b'stuffbin', 1, 2)):
            with self.assertRaises(ValueError):
                build.inspect_stuffed(corrupt)

    def test_rejects_archive_escape_alias_collision_and_non_regular_assets(self):
        for name in ['/../x', 'relative', '/a//b', '/a/./b', '//x', '/a\\b', '/a:b']:
            with self.assertRaises(ValueError):
                build.inspect_stuffed(stuffed([(build.QUERY, b'x'), (name, b'y')]))
        with self.assertRaises(ValueError):
            build.inspect_stuffed(stuffed([(build.QUERY, b'x'), (build.QUERY, b'y')]))
        with self.assertRaises(ValueError):
            build.inspect_stuffed(stuffed([(build.QUERY, b'x')], modes={build.QUERY: 0o120777}))

    def test_bounds_count_compressed_and_expanded_assets(self):
        blob = stuffed([(build.QUERY, b'four')])
        for key, value in [('asset_count', 0), ('asset_bytes', 3), ('assets_total_bytes', 3), ('zip_bytes', 1), ('binary_bytes', 1)]:
            with patch.dict(build.LIMITS, {key: value}):
                with self.assertRaises(ValueError):
                    build.inspect_stuffed(blob)

    def test_comparison_requires_exact_prefix_assets_and_one_locked_query_change(self):
        before = build.inspect_stuffed(stuffed([(build.QUERY, b'old'), ('/schema.sql', b'preserve')]))
        after = build.inspect_stuffed(stuffed([(build.QUERY, b'new'), ('/schema.sql', b'preserve')]))
        with patch.dict(build.LOCK['query'], {'upstream_sha256': build.sha(b'old'), 'patched_sha256': build.sha(b'new')}):
            self.assertEqual(build.compare(before, after), [build.QUERY])
            for candidate in [
                stuffed([(build.QUERY, b'new'), ('/schema.sql', b'changed')]),
                stuffed([(build.QUERY, b'new')]),
                stuffed([(build.QUERY, b'new'), ('/schema.sql', b'preserve')], prefix=b'altered'),
                stuffed([(build.QUERY, b'wrong'), ('/schema.sql', b'preserve')]),
            ]:
                with self.assertRaises(ValueError):
                    build.compare(before, build.inspect_stuffed(candidate))

    def test_pinned_cached_inputs_fail_closed_without_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            entry = {'name': 'synthetic.txt', 'bytes': 4, 'sha256': build.sha(b'good')}
            (root / entry['name']).write_bytes(b'good')
            with patch('urllib.request.urlopen', side_effect=AssertionError('No network expected')):
                self.assertEqual(build.locked_download(entry, root / 'copy', root), b'good')
                (root / entry['name']).write_bytes(b'evil')
                with self.assertRaises(ValueError):
                    build.locked_download(entry, root / 'bad', root)
                self.assertFalse((root / 'bad').exists())

    def test_release_extracts_only_expected_regular_members(self):
        def release(extra=False, link=False):
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode='w:gz') as tar:
                for name in ['LICENSE', 'README.md', 'listmonk'] + (['../escape'] if extra else []):
                    b = b'\x7fELFtest' if name == 'listmonk' else b'text'
                    i = tarfile.TarInfo(name)
                    i.mode = 0o755 if name == 'listmonk' else 0o644
                    i.size = len(b)
                    if link and name == 'listmonk':
                        i.type, i.linkname = tarfile.SYMTYPE, '/outside'
                    tar.addfile(i, io.BytesIO(b))
            return buf.getvalue()
        self.assertEqual(set(build.release_files(release())), {'LICENSE', 'README.md', 'listmonk'})
        for archive in (release(extra=True), release(link=True)):
            with self.assertRaises(ValueError):
                build.release_files(archive)

    def test_bundle_is_deterministic_and_preserves_official_rollback_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p / 'bundle/rollback').mkdir(parents=True)
            (p / 'bundle/candidate').mkdir()
            (p / 'bundle/rollback/official.tar.gz').write_bytes(b'original archive bytes')
            (p / 'bundle/candidate/listmonk').write_bytes(b'candidate bytes')
            build.archive_bundle(p / 'bundle', p / 'a.tar.gz')
            build.archive_bundle(p / 'bundle', p / 'b.tar.gz')
            self.assertEqual((p / 'a.tar.gz').read_bytes(), (p / 'b.tar.gz').read_bytes())
            with tarfile.open(p / 'a.tar.gz') as t:
                self.assertEqual(t.extractfile('rollback/official.tar.gz').read(), b'original archive bytes')
                self.assertEqual(t.getmember('candidate/listmonk').mode, 0o755)

    def test_pure_patch_refuses_unpinned_query_before_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p / 'wrong.sql').write_text('select 1;')
            r = subprocess.run(['node', str(HERE / 'patch-query.cjs'), str(p / 'wrong.sql'), str(p / 'out.sql')], capture_output=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertFalse((p / 'out.sql').exists())
            self.assertIn(b'AB_NATIVE_SOURCE_DRIFT', r.stderr)

    def test_lock_agrees_with_existing_pure_patch(self):
        script = "const p=require('./n8n/growth/ab-listmonk-cohort-patch.cjs');process.stdout.write(p.SOURCE_SHA256)"
        result = subprocess.check_output(['node', '-e', script], cwd=build.REPO).decode()
        self.assertEqual(result, build.LOCK['query']['upstream_sha256'])
        self.assertEqual(set(build.LOCK['releases']), {'linux_amd64', 'linux_arm64'})


if __name__ == '__main__':
    unittest.main()
