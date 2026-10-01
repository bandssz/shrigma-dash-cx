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
    config = {'os': 'linux', 'architecture': 'amd64',
              'rootfs': {'type': 'layers', 'diff_ids': ['sha256:' + image.sha(b'synthetic layer')]}, 'config': {'User': 'node',
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
    def runtime_commands(self, receipt, *, loaded_changes=None, container_changes=None, execute_error=False, mutate_archive=None):
        loaded = {'Id': receipt['config_digest'], 'RootFS': {'Type': 'layers', 'Layers': ['sha256:' + image.sha(b'synthetic layer')]}}
        running = {'Image': receipt['config_digest'], 'State': {'ExitCode': 0}}
        if loaded_changes:
            loaded.update(loaded_changes)
        if container_changes:
            running.update(container_changes)
        def run(args, **kw):
            if args[:3] == ['docker', 'image', 'inspect']:
                return json.dumps([loaded]).encode()
            if args[:2] == ['docker', 'inspect']:
                return json.dumps([running]).encode()
            if args[0] == 'node':
                return json.dumps({'CRM_FLOWS_ENABLED': 'false', 'CRM_FLOWS_REVISION': REVISION}).encode()
            if args[:2] == ['docker', 'exec'] and execute_error:
                raise ValueError('CRM_IMAGE_SYNTHETIC_OFF_FAILED')
            if args[:2] == ['docker', 'stop'] and mutate_archive:
                mutate_archive()
            return b''
        return run

    def test_runtime_imports_oci_and_starts_its_config_digest_not_original_docker_image(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder); archive, receipt = artifact(directory)
            before = archive.read_bytes()
            # Docker-only fields/JSON serialization may change the original build
            # ID. That unrelated ID must never be the input to the runtime proof.
            original_id = 'sha256:' + 'f' * 64
            self.assertNotEqual(original_id, receipt['config_digest'])
            with patch.object(image, 'command', side_effect=self.runtime_commands(receipt)) as command:
                actual = image.test_oci_image(archive, REVISION, 'synthetic-proof')
            self.assertEqual(actual, {k: receipt[k] for k in ('manifest_digest', 'config_digest')})
            calls = [call.args[0] for call in command.call_args_list]
            self.assertEqual(calls[0], ['skopeo', 'copy', 'oci-archive:' + str(archive), 'docker-daemon:crm-flows-oci-proof:' + REVISION])
            self.assertEqual(calls[1], ['docker', 'image', 'inspect', 'crm-flows-oci-proof:' + REVISION])
            start = next(c for c in calls if c[:2] == ['docker', 'run'])
            self.assertEqual(start[-1], receipt['config_digest'])
            self.assertEqual(start[start.index('--network') + 1], 'none')
            self.assertNotIn(original_id, json.dumps(calls))
            self.assertEqual(sum(c[:2] == ['docker', 'inspect'] for c in calls), 2)
            self.assertEqual(archive.read_bytes(), before)

    def test_import_config_or_rootfs_drift_fails_before_starting_container(self):
        changes = [({'Id': 'sha256:' + 'f' * 64}, 'TESTED_IMAGE_ID'),
                   ({'RootFS': {'Type': 'layers', 'Layers': ['sha256:' + 'f' * 64]}}, 'TESTED_ROOTFS'),
                   ({'RootFS': {'Type': 'other', 'Layers': ['sha256:' + image.sha(b'synthetic layer')]}}, 'TESTED_ROOTFS')]
        for change, code in changes:
            with self.subTest(code=code), tempfile.TemporaryDirectory() as folder:
                archive, receipt = artifact(Path(folder))
                with patch.object(image, 'command', side_effect=self.runtime_commands(receipt, loaded_changes=change)) as command:
                    with self.assertRaisesRegex(ValueError, code):
                        image.test_oci_image(archive, REVISION, 'synthetic-proof')
                self.assertFalse(any(c.args[0][:2] == ['docker', 'run'] for c in command.call_args_list))

    def test_wrong_container_image_and_failed_off_proof_fail_and_remove_container(self):
        for changes, execute_error, code in [({'Image': 'sha256:' + 'f' * 64}, False, 'CONTAINER_IMAGE_ID'),
                                              (None, True, 'SYNTHETIC_OFF_FAILED'),
                                              ({'State': {'ExitCode': 1}}, False, 'SHUTDOWN')]:
            with self.subTest(code=code), tempfile.TemporaryDirectory() as folder:
                archive, receipt = artifact(Path(folder))
                with patch.object(image, 'command', side_effect=self.runtime_commands(receipt, container_changes=changes, execute_error=execute_error)) as command:
                    with self.assertRaisesRegex(ValueError, code):
                        image.test_oci_image(archive, REVISION, 'synthetic-proof')
                self.assertEqual(command.call_args.args[0], ['docker', 'rm', '-f', 'synthetic-proof'])

    def test_runtime_refuses_archive_changed_after_import(self):
        with tempfile.TemporaryDirectory() as folder:
            archive, receipt = artifact(Path(folder))
            mutate = lambda: archive.write_bytes(archive.read_bytes() + b'changed after import')
            with patch.object(image, 'command', side_effect=self.runtime_commands(receipt, mutate_archive=mutate)):
                with self.assertRaisesRegex(ValueError, 'TESTED_ARCHIVE_CHANGED'):
                    image.test_oci_image(archive, REVISION, 'synthetic-proof')

    def test_missing_invalid_or_wrong_count_rootfs_is_not_publishable(self):
        changes = [lambda c: c.pop('rootfs'), lambda c: c['rootfs'].update(type='other'),
                   lambda c: c['rootfs'].update(diff_ids=[]),
                   lambda c: c['rootfs'].update(diff_ids=['not-a-digest'])]
        for change in changes:
            with tempfile.TemporaryDirectory() as folder:
                directory = Path(folder); artifact(directory, mutate_config=change)
                with self.assertRaisesRegex(ValueError, 'ROOTFS'):
                    image.verify_artifact(directory, REVISION, RUN)

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

    def test_identity_probe_accepts_current_service_without_opening_a_connection(self):
        result = subprocess.run(['node', str(image.HERE / 'probe.cjs'), str(ROOT)],
                                capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stdout, b'')
        self.assertEqual(result.stderr, b'')

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

    def test_pull_request_ci_runs_real_oci_runtime_helper_without_registry_receipt(self):
        workflow = (ROOT / '.github/workflows/crm-flow-service.yml').read_text()
        self.assertIn('  pull_request:', workflow)
        self.assertIn('runs-on: ubuntu-24.04', workflow)
        self.assertIn('--tag crm-flows-synthetic:ci', workflow)
        self.assertIn('skopeo copy docker-daemon:crm-flows-synthetic:ci ', workflow)
        self.assertIn('python3 tools/crm-flow-image/smoke.py --source-sha "$GITHUB_SHA"', workflow)
        self.assertIn('org.opencontainers.image.revision=$GITHUB_SHA', workflow)
        self.assertNotIn('packages: write', workflow)
        self.assertNotIn('publish.py', workflow)
        smoke = (ROOT / 'tools/crm-flow-image/smoke.py').read_text()
        self.assertIn('image.test_oci_image(', smoke)
        self.assertNotIn('image.json', smoke)
        self.assertNotIn('image.build(', smoke)


if __name__ == '__main__':
    unittest.main()
