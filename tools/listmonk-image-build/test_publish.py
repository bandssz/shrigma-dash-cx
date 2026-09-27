import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import publish


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.env = {'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
                    'GITHUB_REF': 'refs/heads/main', 'GITHUB_REPOSITORY': 'bandssz/shrigma-dash-cx',
                    'GITHUB_ACTOR': 'synthetic', 'GH_TOKEN': 'synthetic-token'}

    def test_only_main_manual_workflow(self):
        with patch.dict(os.environ, self.env, clear=True):
            publish.require_context()
        for key, value in [('GITHUB_ACTIONS', ''), ('GITHUB_EVENT_NAME', 'pull_request'),
                           ('GITHUB_REF', 'refs/heads/other'), ('GITHUB_REPOSITORY', 'other/repo')]:
            with self.subTest(key=key), patch.dict(os.environ, {**self.env, key: value}, clear=True):
                with self.assertRaisesRegex(ValueError, 'CONTEXT'):
                    publish.require_context()

    def test_wrong_source_run_fails_before_archive_or_network(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(publish, 'command') as command:
            with self.assertRaisesRegex(ValueError, 'RUN'):
                publish.verify({'id': publish.RUN + 1}, Path(folder))
            command.assert_not_called()

    def run_publish(self, existing, raw='synthetic manifest', initial_create=False):
        calls = []

        def command(args, **kw):
            calls.append((args, kw))
            if args[1] == 'login':
                Path(args[3]).write_text('{}')
            return raw if args[1] == 'inspect' else ''

        digest = 'sha256:' + publish.hashlib.sha256(raw.encode()).hexdigest()
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, self.env, clear=True), \
             patch.object(publish, 'MANIFEST', digest), patch.object(publish, 'command', side_effect=command), \
             patch.object(publish.subprocess, 'run', return_value=existing), patch('builtins.print'):
            receipt = Path(folder) / 'receipt.json'
            publish.publish(Path(folder) / 'image.tar', receipt, initial_create)
            result = json.loads(receipt.read_text())
        return calls, result

    def test_first_push_preserves_digest_and_keeps_token_off_arguments(self):
        calls, result = self.run_publish(subprocess.CompletedProcess([], 1, '', 'manifest unknown'))
        copy = next(args for args, _ in calls if args[1] == 'copy')
        self.assertIn('--preserve-digests', copy)
        self.assertTrue(copy[-1].startswith('docker://ghcr.io/bandssz/shrigma-crm-listmonk:'))
        self.assertEqual(len([a for a, _ in calls if a[1] == 'inspect']), 2)
        self.assertFalse(result['service_changed'])
        self.assertFalse(result['runtime_enabled'])
        self.assertFalse(result['public_pull_verified'])
        self.assertNotIn('synthetic-token', str([a for a, _ in calls]))
        self.assertEqual(calls[0][1]['input'], 'synthetic-token')
        auth = Path(calls[0][0][3])
        self.assertFalse(auth.exists())

    def test_existing_exact_tag_is_reconciled_without_second_copy(self):
        calls, _ = self.run_publish(subprocess.CompletedProcess([], 0, 'synthetic manifest', ''))
        self.assertFalse(any(a[1] == 'copy' for a, _ in calls))

    def test_denied_read_requires_explicit_fixed_package_bootstrap(self):
        denied = subprocess.CompletedProcess([], 1, '', 'denied: requested access denied')
        with self.assertRaisesRegex(ValueError, 'DESTINATION_UNCONFIRMED'):
            self.run_publish(denied)
        calls, _ = self.run_publish(denied, initial_create=True)
        self.assertEqual(len([a for a, _ in calls if a[1] == 'copy']), 1)
        with self.assertRaisesRegex(ValueError, 'COLLISION'):
            self.run_publish(subprocess.CompletedProcess([], 0, 'different', ''), initial_create=True)

    def test_collision_and_unknown_error_never_push(self):
        for existing, code in [(subprocess.CompletedProcess([], 0, 'different bytes', ''), 'COLLISION'),
                               (subprocess.CompletedProcess([], 1, '', 'timeout'), 'DESTINATION_UNCONFIRMED')]:
            with self.subTest(code=code):
                with self.assertRaisesRegex(ValueError, code):
                    self.run_publish(existing)

    def test_command_failure_does_not_print_provider_error(self):
        with patch.object(publish.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'secret synthetic-token')):
            with self.assertRaisesRegex(RuntimeError, '^AB_PUBLISH_COMMAND_FAILED$'):
                publish.command(['skopeo', 'inspect'])


if __name__ == '__main__':
    unittest.main()
