import copy
import gzip
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('oci_build', HERE / 'build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


def tar_bytes(entries):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w') as tar:
        for name, value, mode, kind in entries:
            info = tarfile.TarInfo(name)
            info.mode, info.type = mode, kind
            info.size = len(value) if kind == tarfile.REGTYPE else 0
            tar.addfile(info, io.BytesIO(value) if kind == tarfile.REGTYPE else None)
    return out.getvalue()


def fixture(modify_config=None, extra=None, modify_manifest=None, index_count=1, binary_mode=0o755):
    binary = b'synthetic ELF bytes; never executable'
    parent = gzip.compress(b'synthetic immutable base layer')
    child_raw = tar_bytes([('listmonk', b'', 0o755, tarfile.DIRTYPE),
                           ('listmonk/listmonk', binary, binary_mode, tarfile.REGTYPE)] + (extra or []))
    child = gzip.compress(child_raw)
    base = {'os': 'linux', 'architecture': 'amd64', 'config': {'Entrypoint': ['docker-entrypoint.sh'], 'Cmd': ['./listmonk'], 'WorkingDir': '/listmonk', 'Env': ['PATH=/usr/bin']}, 'rootfs': {'type': 'layers', 'diff_ids': ['sha256:' + build.sha(gzip.decompress(parent))]}}
    base_bytes = build.json_bytes(base)
    config = copy.deepcopy(base)
    config['rootfs']['diff_ids'].append('sha256:' + build.sha(child_raw))
    if modify_config:
        modify_config(config)
    blobs = {}

    def add(value, media):
        digest = 'sha256:' + build.sha(value)
        blobs['blobs/sha256/' + digest[7:]] = value
        return {'digest': digest, 'size': len(value), 'mediaType': media}

    cfg = add(build.json_bytes(config), 'application/vnd.oci.image.config.v1+json')
    layers = [add(x, 'application/vnd.oci.image.layer.v1.tar+gzip') for x in (parent, child)]
    expected_parent = {'digest': layers[0]['digest'], 'size': layers[0]['size']}
    manifest = {'schemaVersion': 2, 'config': cfg, 'layers': layers}
    if modify_manifest:
        modify_manifest(manifest)
    desc = add(build.json_bytes(manifest), 'application/vnd.oci.image.manifest.v1+json')
    files = [('oci-layout', build.json_bytes({'imageLayoutVersion': '1.0.0'}), 0o644, tarfile.REGTYPE),
             ('index.json', build.json_bytes({'schemaVersion': 2, 'manifests': [desc] * index_count}), 0o644, tarfile.REGTYPE)]
    files += [(name, value, 0o644, tarfile.REGTYPE) for name, value in blobs.items()]
    locks = {'base_config_digest': 'sha256:' + build.sha(base_bytes), 'base_layers': [expected_parent], 'binary_sha256': build.sha(binary)}
    return tar_bytes(files), base_bytes, locks


class OCIProofTests(unittest.TestCase):
    def verify_fixture(self, **kwargs):
        image, base, locks = fixture(**kwargs)
        with tempfile.TemporaryDirectory() as tmp, patch.dict(build.LOCK, locks):
            path = Path(tmp) / 'candidate.oci.tar'
            path.write_bytes(image)
            return build.verify_oci(path, base)

    def test_off_image_preserves_base_and_only_replaces_expected_binary(self):
        with patch.object(build.subprocess, 'run', side_effect=AssertionError('Must not execute')):
            result = self.verify_fixture()
        self.assertEqual(result['status'], 'VERIFIED_BUILD_ONLY_OFF_NOT_DEPLOYED')
        self.assertEqual(result['additional_layer_files'], ['listmonk/listmonk'])
        self.assertFalse(result['listmonk_executed'])
        self.assertFalse(result['registry_push'])

    def test_all_runtime_configuration_is_preserved(self):
        for key, value in [('User', 'nobody'), ('Entrypoint', ['/bad']), ('Cmd', ['--upgrade']), ('WorkingDir', '/'), ('Env', ['DB_PASSWORD=synthetic']), ('Volumes', {'/db': {}}), ('Labels', {'altered': 'yes'})]:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'AB_IMAGE_CONFIG_CHANGED'):
                self.verify_fixture(modify_config=lambda c: c['config'].update({key: value}))

    def test_architecture_and_rootfs_changes_are_rejected(self):
        for mutate in [lambda c: c.update(architecture='arm64'), lambda c: c['rootfs']['diff_ids'].__setitem__(0, 'sha256:' + '0' * 64)]:
            with self.assertRaises(ValueError):
                self.verify_fixture(modify_config=mutate)

    def test_base_layer_replacement_and_multiple_images_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'AB_IMAGE_BASE_LAYER_CHANGED'):
            self.verify_fixture(modify_manifest=lambda m: m['layers'][0].update(digest='sha256:' + '0' * 64))
        with self.assertRaisesRegex(ValueError, 'AB_IMAGE_SINGLE_MANIFEST'):
            self.verify_fixture(index_count=2)

    def test_extra_file_whiteout_symlink_and_changed_directory_are_rejected(self):
        for item in [('etc/password', b'x', 0o644, tarfile.REGTYPE), ('listmonk/.wh.uploads', b'', 0o644, tarfile.REGTYPE), ('listmonk/link', b'', 0o777, tarfile.SYMTYPE), ('etc', b'', 0o777, tarfile.DIRTYPE)]:
            with self.subTest(path=item[0]), self.assertRaises(ValueError):
                self.verify_fixture(extra=[item])

    def test_binary_hash_and_mode_are_not_trusted_from_manifest(self):
        image, base, locks = fixture()
        with tempfile.TemporaryDirectory() as tmp, patch.dict(build.LOCK, {**locks, 'binary_sha256': '0' * 64}):
            path = Path(tmp) / 'x';path.write_bytes(image)
            with self.assertRaisesRegex(ValueError, 'AB_IMAGE_BINARY_CHANGED'):
                build.verify_oci(path, base)

    def test_mode_changes_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'AB_IMAGE_BINARY_CHANGED'):
            self.verify_fixture(binary_mode=0o4755)

    def test_blob_bytes_must_match_digest(self):
        image, base, locks = fixture()
        files = build.regular_tar(image, 100000)
        name = next(x for x in files if x.startswith('blobs/'))
        files[name] = (files[name][0] + b'x', files[name][1])
        broken = tar_bytes([(k, v[0], v[1], tarfile.REGTYPE) for k, v in files.items()])
        with tempfile.TemporaryDirectory() as tmp, patch.dict(build.LOCK, locks):
            path = Path(tmp) / 'x';path.write_bytes(broken)
            with self.assertRaisesRegex(ValueError, 'AB_IMAGE_BLOB_HASH'):
                build.verify_oci(path, base)

    def test_bounded_archives_reject_escape_duplicates_and_oversize(self):
        for entries in [[('../x', b'x', 0o644, tarfile.REGTYPE)], [('x', b'x', 0o644, tarfile.REGTYPE)] * 2, [('/x', b'x', 0o644, tarfile.REGTYPE)], [('a/./x', b'x', 0o644, tarfile.REGTYPE)]]:
            with self.assertRaises(ValueError):
                build.regular_tar(tar_bytes(entries), 100000)
        with self.assertRaises(ValueError):
            build.bounded_gunzip(gzip.compress(b'x' * 100), 99)
        with self.assertRaises(ValueError):
            build.regular_tar(tar_bytes([('x', b'x', 0o644, tarfile.REGTYPE)]), 1)

    def test_approved_run_requires_exact_head_repository_workflow_success(self):
        run = {'id': build.LOCK['run_id'], 'head_sha': build.LOCK['source_head'], 'conclusion': 'success', 'status': 'completed', 'path': build.LOCK['workflow_path'], 'event': 'pull_request', 'repository': {'full_name': build.LOCK['repository']}}
        self.assertEqual(build.verify_run(run)['id'], build.LOCK['run_id'])
        for key, value in [('id', 1), ('head_sha', '0' * 40), ('conclusion', 'failure'), ('event', 'workflow_dispatch'), ('path', 'other.yml'), ('repository', {'full_name': 'other/repo'})]:
            with self.assertRaisesRegex(ValueError, 'AB_IMAGE_UNAPPROVED_RUN'):
                build.verify_run({**run, key: value})

    def test_build_refuses_local_execution_before_docker(self):
        with patch.dict(build.os.environ, {}, clear=True), patch.object(build.subprocess, 'run', side_effect=AssertionError('Docker forbidden')):
            with self.assertRaisesRegex(ValueError, 'AB_IMAGE_CI_ONLY'):
                build.build(Path('none'), {}, Path('none'))

    def test_dockerfile_and_workflow_have_no_transport_or_registry_write(self):
        instructions = [x for x in build.dockerfile().splitlines() if x and not x.startswith('#')]
        self.assertEqual([x.split()[0] for x in instructions], ['FROM', 'COPY'])
        self.assertIn('@sha256:', instructions[0])
        source = (HERE / 'build.py').read_text()
        self.assertNotIn("['docker', 'run'", source)
        self.assertNotIn("'--push'", source)
        workflow = (HERE.parents[1] / '.github/workflows/ab-listmonk-image-build.yml').read_text()
        self.assertNotIn('packages: write', workflow)
        self.assertNotIn('secrets.', workflow)
        self.assertIn('persist-credentials: false', workflow)
        self.assertIn('actions: read', workflow)

    def test_public_base_configuration_is_pinned_and_has_no_onbuild(self):
        raw = (HERE / 'base-config.json').read_bytes()
        self.assertEqual('sha256:' + build.sha(raw), build.LOCK['base_config_digest'])
        base = json.loads(raw)
        self.assertFalse(base['config'].get('OnBuild'))
        self.assertEqual(base['config']['Entrypoint'], ['docker-entrypoint.sh'])
        self.assertEqual(base['config']['Cmd'], ['./listmonk'])
        self.assertEqual(len(base['rootfs']['diff_ids']), 7)


if __name__ == '__main__':
    unittest.main()
