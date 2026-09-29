import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import publish


def compact(value):
    return json.dumps(value, separators=(',', ':'), sort_keys=True).encode()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json.dumps(value, sort_keys=True, indent=2).encode() + b'\n')


class PublishTests(unittest.TestCase):
    def fixture(self, root):
        artifact = root / 'artifact'
        oci = artifact / 'regular-image' / 'oci'
        blobs = oci / 'blobs' / 'sha256'
        blobs.mkdir(parents=True)
        source = b'synthetic reviewed source'
        layer = b'synthetic layer'
        layer_digest = 'sha256:' + hashlib.sha256(layer).hexdigest()
        (blobs / layer_digest.split(':')[1]).write_bytes(layer)
        head = '1' * 40
        revision = '2' * 40
        binary = '3' * 64
        config = compact({'architecture': 'amd64', 'os': 'linux',
                          'config': {'Labels': {
                              'org.opencontainers.image.revision': revision,
                              'org.opencontainers.image.source': 'https://github.com/bandssz/shrigma-dash-cx',
                              'crm.regular.status': 'OFF_NOT_DEPLOYED',
                              'crm.regular.binary-sha256': binary,
                          }}})
        config_digest = 'sha256:' + hashlib.sha256(config).hexdigest()
        (blobs / config_digest.split(':')[1]).write_bytes(config)
        manifest = compact({
            'schemaVersion': 2,
            'mediaType': 'application/vnd.oci.image.manifest.v1+json',
            'config': {'mediaType': 'application/vnd.oci.image.config.v1+json',
                       'digest': config_digest, 'size': len(config)},
            'layers': [{'mediaType': 'application/vnd.oci.image.layer.v1.tar+gzip',
                        'digest': layer_digest, 'size': len(layer)}],
        })
        manifest_digest = 'sha256:' + hashlib.sha256(manifest).hexdigest()
        (blobs / manifest_digest.split(':')[1]).write_bytes(manifest)
        (oci / 'oci-layout').write_bytes(b'{"imageLayoutVersion":"1.0.0"}\n')
        write_json(oci / 'index.json', {
            'schemaVersion': 2,
            'manifests': [{'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                           'digest': manifest_digest, 'size': len(manifest),
                           'annotations': {'org.opencontainers.image.ref.name': 'candidate'}}],
        })
        query = '4' * 64
        source_lock = '5' * 64
        native = {
            'schema': 'segment-regular-native-proof-v1',
            'status': 'PASSED_EPHEMERAL_ONLY_NOT_DEPLOYED',
            'binary_sha256': binary,
            'identity': {'worker_sha256': binary},
            'query_sha256': query,
            'cluster_stopped': True,
            'local_disposable': True,
            'production_changed': False,
            'remote_hosts': 0,
        }
        write_json(artifact / 'regular-image' / 'native-proof.json', native)
        native_bytes = (artifact / 'regular-image' / 'native-proof.json').read_bytes()
        package = {
            'schema': 'listmonk-regular-package-v1',
            'status': 'CANDIDATE_OFF_NOT_DEPLOYED',
            'target': 'linux_amd64',
            'binary_sha256': binary,
            'query_sha256': query,
            'source_lock_sha256': source_lock,
            'runtime_activation': False,
            'registry_push': False,
            'production_changed': False,
        }
        write_json(artifact / 'regular-image' / 'package-manifest.json', package)
        (artifact / 'regular-image' / 'source.tar.gz').write_bytes(source)
        (artifact / 'regular-image' / 'LICENSE').write_text('license\n')
        image = {
            'schema': 'crm-regular-oci-v1',
            'status': 'VERIFIED_IMAGE_OFF_NOT_DEPLOYED',
            'revision': revision,
            'manifest_digest': manifest_digest,
            'config_digest': config_digest,
            'binary_sha256': binary,
            'source_sha256': hashlib.sha256(source).hexdigest(),
            'native_proof_sha256': hashlib.sha256(native_bytes).hexdigest(),
            'source_lock_sha256': source_lock,
            'runtime_config_preserved': True,
            'oci_binary_matches_native_proof': True,
            'version_command_network_none': True,
            'registry_push': False,
            'production_changed': False,
        }
        write_json(artifact / 'regular-image' / 'image-proof.json', image)
        write_json(artifact / 'regular-pg-proof' / 'postgres-proof.json', {
            'schema': 'regular-postgres-proof-v1', 'success': True, 'stopped': True,
            'production_changed': False, 'sends': 0,
            'runs': [{'case': 'synthetic', 'exit_code': 0}],
        })
        inventory = {}
        for path in artifact.rglob('*'):
            if path.is_file():
                inventory[path.relative_to(artifact).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
        lock = {
            'schema': 'crm-regular-registry-lock-v1',
            'enabled': False,
            'repository': 'bandssz/shrigma-dash-cx',
            'workflow_path': '.github/workflows/crm-regular-worker-tests.yml',
            'artifact_name': 'crm-regular-worker-oci-linux-amd64',
            'run_id': 123,
            'pull_request': 174,
            'source_head': head,
            'source_merge': '6' * 40,
            'ci_revision': revision,
            'image': 'ghcr.io/bandssz/shrigma-crm-listmonk',
            'tag': 'regular-v1-' + head,
            'manifest_digest': manifest_digest,
            'manifest_size': len(manifest),
            'config_digest': config_digest,
            'binary_sha256': binary,
            'query_sha256': query,
            'source_sha256': hashlib.sha256(source).hexdigest(),
            'source_lock_sha256': source_lock,
            'max_file_bytes': 1024 * 1024,
            'max_total_bytes': 4 * 1024 * 1024,
            'artifact_files': inventory,
        }
        run = {
            'id': 123, 'head_sha': head, 'conclusion': 'success', 'status': 'completed',
            'event': 'pull_request', 'path': lock['workflow_path'],
            'repository': {'full_name': lock['repository']},
            'pull_requests': [{'number': 174, 'head': {'sha': head}}],
        }
        self.source_pr = {'number': 174, 'merged': True, 'state': 'closed',
                          'head': {'sha': head, 'repo': {'full_name': lock['repository']}},
                          'base': {'ref': 'main', 'repo': {'full_name': lock['repository']}},
                          'merge_commit_sha': lock['source_merge']}
        return artifact, lock, run

    def setUp(self):
        self.env = {
            'GITHUB_ACTIONS': 'true',
            'GITHUB_EVENT_NAME': 'workflow_dispatch',
            'GITHUB_REF': 'refs/heads/main',
            'GITHUB_REPOSITORY': 'bandssz/shrigma-dash-cx',
            'GITHUB_ACTOR': 'synthetic',
            'GH_TOKEN': 'synthetic-token',
        }

    def test_exact_inventory_and_disabled_lock_verify(self):
        with tempfile.TemporaryDirectory() as folder:
            artifact, lock, run = self.fixture(Path(folder))
            self.assertEqual(publish.verify(run, artifact, lock, self.source_pr), artifact / 'regular-image' / 'oci')
            self.assertFalse(lock['enabled'])

    def test_inventory_extra_drift_and_symlink_fail(self):
        for mode, code in [('extra', 'INVENTORY'), ('drift', 'DRIFT'), ('symlink', 'TYPE')]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as folder:
                artifact, lock, run = self.fixture(Path(folder))
                if mode == 'extra':
                    (artifact / 'extra').write_text('x')
                elif mode == 'drift':
                    (artifact / 'regular-image' / 'LICENSE').write_text('changed')
                else:
                    os.symlink(artifact / 'regular-image' / 'LICENSE', artifact / 'link')
                with self.assertRaisesRegex(ValueError, code):
                    publish.verify(run, artifact, lock, self.source_pr)

    def test_run_and_head_mismatch_fail_before_artifact(self):
        with tempfile.TemporaryDirectory() as folder:
            artifact, lock, run = self.fixture(Path(folder))
            for mutation in ({'id': 124}, {'head_sha': '9' * 40}, {'status': 'in_progress'}):
                with self.subTest(mutation=mutation):
                    bad = {**run, **mutation}
                    with self.assertRaisesRegex(ValueError, 'SOURCE_RUN'):
                        publish.verify(bad, artifact, lock, self.source_pr)

    def test_merged_run_without_pr_array_requires_direct_merged_pr(self):
        with tempfile.TemporaryDirectory() as folder:
            artifact, lock, run = self.fixture(Path(folder))
            run['pull_requests'] = []
            publish.verify(run, artifact, lock, self.source_pr)
            for mutation in ({'merged': False}, {'number': 175}, {'merge_commit_sha': '9' * 40},
                             {'head': {'sha': '9' * 40}}, {'base': {'ref': 'other'}}):
                with self.subTest(mutation=mutation), self.assertRaisesRegex(ValueError, 'SOURCE_PR'):
                    publish.verify(run, artifact, lock, {**self.source_pr, **mutation})
            with self.assertRaisesRegex(ValueError, 'SOURCE_PR'):
                publish.verify(run, artifact, lock)
            run['pull_requests'] = [{'number': 175, 'head': {'sha': lock['source_head']}}]
            with self.assertRaisesRegex(ValueError, 'SOURCE_RUN_PR'):
                publish.verify(run, artifact, lock, self.source_pr)

    def test_only_manual_main_repository_context(self):
        with patch.dict(os.environ, self.env, clear=True):
            publish.require_context({'repository': 'bandssz/shrigma-dash-cx'})
        for key, value in [('GITHUB_ACTIONS', ''), ('GITHUB_EVENT_NAME', 'pull_request'),
                           ('GITHUB_REF', 'refs/heads/other'), ('GITHUB_REPOSITORY', 'other/repo')]:
            with self.subTest(key=key), patch.dict(os.environ, {**self.env, key: value}, clear=True):
                with self.assertRaisesRegex(ValueError, 'CONTEXT'):
                    publish.require_context({'repository': 'bandssz/shrigma-dash-cx'})

    def run_publish(self, existing, enabled=True, readback='synthetic manifest'):
        calls = []
        lock = {
            'enabled': enabled,
            'repository': 'bandssz/shrigma-dash-cx',
            'image': 'ghcr.io/bandssz/shrigma-crm-listmonk',
            'tag': 'regular-v1-' + '1' * 40,
            'manifest_digest': 'sha256:' + hashlib.sha256(readback.encode()).hexdigest(),
            'run_id': 123,
            'source_head': '1' * 40,
        }

        def command(args, **kwargs):
            calls.append((args, kwargs))
            if args[1] == 'login':
                Path(args[3]).write_text('{}')
                return ''
            if args[1] == 'inspect':
                return readback
            return ''

        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, self.env, clear=True), \
             patch.object(publish, 'command', side_effect=command), \
             patch.object(publish.subprocess, 'run', return_value=existing), patch('builtins.print'):
            receipt = Path(folder) / 'receipt.json'
            publish.publish(Path(folder) / 'oci', receipt, lock)
            result = json.loads(receipt.read_text())
        return calls, result

    def test_disabled_lock_never_authenticates_or_publishes(self):
        with patch.object(publish, 'command') as command:
            with self.assertRaisesRegex(ValueError, 'DISABLED'):
                publish.publish(Path('/synthetic/oci'), Path('/synthetic/receipt'), {
                    'enabled': False,
                })
            command.assert_not_called()

    def test_missing_tag_copies_directory_oci_and_reads_tag_and_digest(self):
        calls, result = self.run_publish(subprocess.CompletedProcess([], 1, '', 'manifest unknown'))
        copy_call = next(args for args, _ in calls if args[1] == 'copy')
        self.assertIn('--preserve-digests', copy_call)
        self.assertTrue(copy_call[-2].startswith('oci:'))
        self.assertTrue(copy_call[-2].endswith(':candidate'))
        inspect_calls = [args for args, _ in calls if args[1] == 'inspect']
        self.assertEqual(len(inspect_calls), 2)
        self.assertIn('@sha256:', inspect_calls[1][-1])
        self.assertFalse(result['runtime_enabled'])
        self.assertFalse(result['service_changed'])
        self.assertNotIn('synthetic-token', str([args for args, _ in calls]))
        self.assertEqual(calls[0][1]['input'], 'synthetic-token')

    def test_registry_children_do_not_inherit_token(self):
        with patch.dict(os.environ, self.env, clear=True):
            self.assertNotIn('GH_TOKEN', publish.child_environment())

    def test_exact_existing_tag_reconciles_without_copy(self):
        calls, _ = self.run_publish(subprocess.CompletedProcess([], 0, 'synthetic manifest', ''))
        self.assertFalse(any(args[1] == 'copy' for args, _ in calls))

    def test_collision_denied_and_unknown_failure_never_copy(self):
        cases = [
            (subprocess.CompletedProcess([], 0, 'different', ''), 'TAG_COLLISION'),
            (subprocess.CompletedProcess([], 1, '', 'denied: access denied'), 'DESTINATION_UNCONFIRMED'),
            (subprocess.CompletedProcess([], 1, '', 'timeout'), 'DESTINATION_UNCONFIRMED'),
        ]
        for existing, code in cases:
            with self.subTest(code=code):
                with self.assertRaisesRegex(ValueError, code):
                    self.run_publish(existing)

    def test_provider_error_is_sanitized(self):
        result = subprocess.CompletedProcess([], 1, '', 'secret synthetic-token')
        with patch.object(publish.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(RuntimeError, '^REGULAR_REGISTRY_COMMAND_FAILED$'):
                publish.command(['skopeo', 'inspect'])


if __name__ == '__main__':
    unittest.main()
