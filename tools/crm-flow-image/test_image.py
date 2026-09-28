import copy
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import image

REVISION = 'a' * 40
RUN = '123456'
ROOT = Path(__file__).resolve().parents[2]


def artifact(directory, mutate_config=None, mutate_receipt=None, extra=None):
    config = {'os': 'linux', 'architecture': 'amd64', 'config': {'User': 'node',
              'WorkingDir': '/app/services/crm-flows', 'Cmd': ['node', 'main.cjs'],
              'Env': ['NODE_ENV=production', 'PATH=/usr/local/bin'], 'Labels': {
                  'org.opencontainers.image.source': image.SOURCE,
                  'org.opencontainers.image.revision': REVISION,
                  'org.opencontainers.image.version': REVISION, 'io.shrigma.crm.execution': 'off'}}}
    if mutate_config:
        mutate_config(config)
    files = {'oci-layout': json.dumps({'imageLayoutVersion': '1.0.0'}).encode()}
    def blob(value):
        raw = json.dumps(value).encode() if isinstance(value, dict) else value
        digest = 'sha256:' + image.sha(raw)
        files['blobs/sha256/' + digest[7:]] = raw
        return {'digest': digest, 'size': len(raw)}
    conf = blob(config)
    manifest = blob({'schemaVersion': 2, 'config': conf, 'layers': [blob(b'synthetic layer')]})
    files['index.json'] = json.dumps({'schemaVersion': 2, 'manifests': [manifest]}).encode()
    archive = directory / 'crm-flows.oci.tar'
    with tarfile.open(archive, 'w') as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name); info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        if extra:
            tar.addfile(extra)
    receipt = {'source_sha': REVISION, 'run_id': RUN, 'image': image.IMAGE,
               'tag': 'sha-' + REVISION, 'archive_sha256': image.file_sha(archive),
               'manifest_digest': manifest['digest'], 'config_digest': conf['digest'],
               'runtime_enabled': False, 'service_changed': False}
    if mutate_receipt:
        mutate_receipt(receipt)
    (directory / 'image.json').write_text(json.dumps(receipt))
    return archive, receipt


class ImageTests(unittest.TestCase):
    def test_exact_oci_bytes_and_receipt_are_verified_without_execution(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(image, 'command') as command:
            directory = Path(folder); archive, receipt = artifact(directory)
            result = image.verify_artifact(directory, REVISION, RUN)
            self.assertEqual(result, {**receipt, 'archive_path': archive})
            command.assert_not_called()

    def test_wrong_source_run_digest_and_operational_flags_fail(self):
        changes = [('source_sha', 'b' * 40), ('run_id', '999'), ('image', 'ghcr.io/other/image'),
                   ('tag', 'latest'), ('archive_sha256', '0' * 64),
                   ('manifest_digest', 'sha256:' + '0' * 64), ('runtime_enabled', True),
                   ('service_changed', True)]
        for key, value in changes:
            with self.subTest(key=key), tempfile.TemporaryDirectory() as folder:
                directory = Path(folder); artifact(directory, mutate_receipt=lambda r: r.update({key: value}))
                with self.assertRaises(ValueError):
                    image.verify_artifact(directory, REVISION, RUN)

    def test_credentials_wrong_user_platform_and_revision_cannot_enter_image(self):
        changes = [lambda c: c.update(architecture='arm64'),
                   lambda c: c['config'].update(User='root'),
                   lambda c: c['config'].update(Cmd=['sh']),
                   lambda c: c['config']['Env'].append('CRM_PG_PASSWORD=synthetic-secret'),
                   lambda c: c['config']['Labels'].update({'org.opencontainers.image.revision': 'b' * 40})]
        for mutate in changes:
            with tempfile.TemporaryDirectory() as folder:
                directory = Path(folder); artifact(directory, mutate_config=mutate)
                with self.assertRaises(ValueError):
                    image.verify_artifact(directory, REVISION, RUN)

    def test_archive_traversal_symlink_duplicate_and_digest_corruption_fail(self):
        for name, kind in [('../private', tarfile.REGTYPE), ('blobs/escape', tarfile.SYMTYPE),
                           ('index.json', tarfile.REGTYPE), ('../../escape', tarfile.DIRTYPE)]:
            with tempfile.TemporaryDirectory() as folder:
                directory = Path(folder); info = tarfile.TarInfo(name); info.type = kind
                artifact(directory, extra=info)
                with self.assertRaises(ValueError):
                    image.verify_artifact(directory, REVISION, RUN)
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder); archive, _ = artifact(directory)
            archive.write_bytes(archive.read_bytes().replace(b'synthetic layer', b'corrupted layer'))
            with self.assertRaisesRegex(ValueError, 'DIGEST'):
                image.verify_artifact(directory, REVISION, RUN)

    def test_build_context_is_an_explicit_source_allowlist(self):
        for name in ['services/crm-flows/config.cjs', 'n8n/growth/journey-graph-worker.cjs', 'growth-email-contract.js']:
            self.assertTrue(image.allowed_file(name))
        for name in ['.private/secret.json', '.env', '.git/config', 'services/crm-flows/secret.json',
                     'services/crm-flows/.env', 'services/crm-flows/nested/evil.cjs', 'n8n/cx/worker.cjs',
                     'n8n/growth/journey-graph-source.sql', 'growth-ui.js']:
            self.assertFalse(image.allowed_file(name))
        for filename, digest in image.LOCKS.items():
            self.assertEqual(image.sha((ROOT / filename).read_bytes()), digest)

    def test_source_sha_and_main_ancestry_are_checked_before_source_copy(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder); destination = repo / 'out'
            for revision in ['main', 'a' * 39, 'A' * 40, '--help', 'a' * 40 + '\n']:
                with patch.object(image, 'command') as command, self.assertRaisesRegex(ValueError, 'SOURCE_SHA'):
                    image.source_context(repo, revision, destination)
                command.assert_not_called()
            with patch.object(image, 'command', side_effect=ValueError('not main')) as command:
                with self.assertRaises(ValueError):
                    image.source_context(repo, REVISION, destination)
                self.assertEqual(command.call_args.args[0][-3:], ['--is-ancestor', REVISION, 'refs/remotes/origin/main'])
                self.assertFalse(destination.exists())

    def test_identity_probe_refuses_pre_guard_source(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder); service = directory / 'services/crm-flows'; service.mkdir(parents=True)
            (service / 'main.cjs').write_text('module.exports={};')
            (service / 'config.cjs').write_text('module.exports={config:()=>({enabled:false})};')
            result = subprocess.run(['node', str(image.HERE / 'probe.cjs'), str(directory)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stderr, b'CRM_IMAGE_DEDICATED_ROLE_REQUIRED\n')

    def test_workflow_keeps_manual_main_build_and_write_permissions_separate(self):
        workflow = (ROOT / '.github/workflows/crm-flow-image-publish.yml').read_text()
        verify, publish = workflow.split('  publish:\n')
        self.assertIn('  workflow_dispatch:', verify)
        self.assertNotIn('pull_request:', workflow)
        self.assertNotIn('packages: write', verify)
        self.assertEqual(publish.count('packages: write'), 1)
        self.assertIn('needs: verify', publish)
        self.assertIn("github.ref == 'refs/heads/main'", verify)
        self.assertIn("github.event_name == 'workflow_dispatch'", publish)
        self.assertIn('fetch-depth: 0', verify)
        self.assertIn('ref: ${{ github.sha }}', publish)
        self.assertIn('crm-flows-oci-${{ github.run_id }}', verify)
        self.assertIn('--name "crm-flows-oci-$GITHUB_RUN_ID"', publish)
        self.assertNotIn('image.py --source-sha', publish)
        self.assertNotIn(':latest', workflow)
        self.assertNotIn('secrets.', workflow)


if __name__ == '__main__':
    unittest.main()
