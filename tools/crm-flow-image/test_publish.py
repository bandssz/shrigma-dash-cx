import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import publish


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='crm-flow-publish-test-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.archive = self.directory / 'worker.oci.tar'
        self.archive.write_bytes(b'synthetic OCI; helper mocked')
        self.receipt = self.directory / 'receipt.json'
        self.sha = 'a' * 40
        self.raw = b'{"schemaVersion":2,"synthetic":true}'
        self.digest = 'sha256:' + hashlib.sha256(self.raw).hexdigest()
        self.proof = {'archive_path': self.archive,
                      'archive_sha256': hashlib.sha256(self.archive.read_bytes()).hexdigest(),
                      'manifest_digest': self.digest, 'config_digest': 'sha256:' + 'b' * 64,
                      'source_sha': self.sha, 'tag': 'sha-' + self.sha, 'image': publish.IMAGE}
        self.environment = {'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
                            'GITHUB_REF': 'refs/heads/main', 'GITHUB_REPOSITORY': publish.REPOSITORY,
                            'GITHUB_RUN_ID': '12345', 'GITHUB_ACTOR': 'synthetic-user',
                            'GH_TOKEN': 'synthetic-private-token', 'GITHUB_TOKEN': 'another-private-token'}
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, self.environment, clear=True).start()
        self.verify = patch.object(publish, 'verify_artifact', return_value=self.proof).start()
        self.calls = []
        self.inspect_results = [(0, self.raw, b'')] * 3
        self.copy_result = (0, b'', b'')
        self.login_result = (0, b'', b'')
        self.auth_path = None
        patch.object(publish.subprocess, 'run', side_effect=self.command).start()

    def command(self, args, **kwargs):
        self.calls.append((args, kwargs))
        self.assertNotIn(self.environment['GH_TOKEN'], args)
        self.assertNotIn('GH_TOKEN', kwargs['env'])
        self.assertNotIn('GITHUB_TOKEN', kwargs['env'])
        self.assertTrue(kwargs['capture_output'])
        self.assertNotIn('shell', kwargs)
        auth = Path(args[args.index('--authfile') + 1])
        self.auth_path = auth
        self.assertEqual(auth.stat().st_mode & 0o777, 0o600)
        if args[1] == 'login':
            self.assertEqual(kwargs['input'], self.environment['GH_TOKEN'].encode())
            self.assertIn('--password-stdin', args)
            response = self.login_result
        elif args[1] == 'copy':
            self.assertIsNone(kwargs['input'])
            self.assertIn('--preserve-digests', args)
            self.assertEqual(args[-2], 'oci-archive:' + str(self.archive))
            self.assertEqual(kwargs['timeout'], 300)
            response = self.copy_result
        elif args[1] == 'inspect':
            self.assertIsNone(kwargs['input'])
            self.assertIn('--raw', args)
            response = self.inspect_results.pop(0)
        else:
            self.fail('Unexpected registry command')
        if isinstance(response, Exception):
            raise response
        return subprocess.CompletedProcess(args, response[0], response[1], response[2])

    def count(self, verb):
        return sum(args[1] == verb for args, _ in self.calls)

    def invoke(self):
        return publish.publish(self.directory, self.sha, self.receipt)

    def test_existing_identical_tag_only_reads_and_receipt_is_private(self):
        result = self.invoke()
        self.verify.assert_called_once_with(self.directory, self.sha, '12345')
        self.assertEqual(self.count('copy'), 0)
        self.assertEqual(self.count('inspect'), 3)
        self.assertEqual(result['image'], publish.IMAGE + '@' + self.digest)
        self.assertFalse(result['runtime_enabled'])
        self.assertFalse(result['service_changed'])
        self.assertFalse(result['copy_attempted'])
        self.assertFalse(result['public_pull_verified'])
        self.assertEqual(self.receipt.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(self.receipt.read_text()), result)
        self.assertFalse(self.auth_path.exists())
        read_targets = [args[-1] for args, _ in self.calls if args[1] == 'inspect']
        self.assertEqual(read_targets[-1], 'docker://' + publish.IMAGE + '@' + self.digest)

    def test_confirmed_absence_copies_once_then_verifies_tag_and_digest(self):
        self.inspect_results = [(1, b'', b'manifest unknown'), (0, self.raw, b''), (0, self.raw, b'')]
        result = self.invoke()
        self.assertEqual(self.count('copy'), 1)
        self.assertTrue(result['copy_attempted'])
        self.assertFalse(result['copy_response_uncertain_reconciled'])

    def test_name_unknown_also_allows_one_copy(self):
        self.inspect_results = [(1, b'', b'NAME_UNKNOWN: name unknown'), (0, self.raw, b''), (0, self.raw, b'')]
        self.invoke()
        self.assertEqual(self.count('copy'), 1)

    def test_tag_collision_never_copies_or_writes_a_receipt(self):
        self.inspect_results = [(0, b'{"different":true}', b'')]
        with self.assertRaisesRegex(RuntimeError, 'TAG_COLLISION'):
            self.invoke()
        self.assertEqual(self.count('copy'), 0)
        self.assertFalse(self.receipt.exists())

    def test_auth_network_and_unknown_errors_are_not_absence(self):
        for detail in [b'denied', b'unauthorized', b'timeout', b'connection reset', b'manifest unknown denied',
                       b'name unknown 503', b'manifest unknown certificate error', b'unrecognized failure']:
            with self.subTest(detail=detail):
                self.inspect_results = [(1, b'', detail)]
                with self.assertRaisesRegex(RuntimeError, 'DESTINATION_UNCONFIRMED'):
                    self.invoke()
        self.assertEqual(self.count('copy'), 0)
        self.assertFalse(self.receipt.exists())

    def test_inspection_timeout_never_authorizes_a_copy(self):
        self.inspect_results = [subprocess.TimeoutExpired(['synthetic'], 60)]
        with self.assertRaisesRegex(RuntimeError, 'COMMAND_UNCERTAIN'):
            self.invoke()
        self.assertEqual(self.count('copy'), 0)

    def test_lost_copy_response_reconciles_only_through_reads(self):
        self.inspect_results = [(1, b'', b'manifest unknown'), (0, self.raw, b''), (0, self.raw, b'')]
        self.copy_result = subprocess.TimeoutExpired(['synthetic'], 300)
        result = self.invoke()
        self.assertEqual(self.count('copy'), 1)
        self.assertTrue(result['copy_response_uncertain_reconciled'])
        self.assertEqual(result['status'], 'REGISTRY_VERIFIED_NOT_DEPLOYED')

    def test_failed_copy_without_confirmed_effect_stops_without_retry(self):
        self.inspect_results = [(1, b'', b'manifest unknown'), (1, b'', b'manifest unknown')]
        self.copy_result = (1, b'', b'private-provider-error')
        with self.assertRaisesRegex(RuntimeError, 'DESTINATION_UNCONFIRMED'):
            self.invoke()
        self.assertEqual(self.count('copy'), 1)
        self.assertFalse(self.receipt.exists())

    def test_readback_requires_both_references_to_match(self):
        self.inspect_results = [(1, b'', b'manifest unknown'), (0, self.raw, b''), (0, b'wrong', b'')]
        with self.assertRaisesRegex(RuntimeError, 'READBACK'):
            self.invoke()
        self.assertEqual(self.count('copy'), 1)
        self.assertFalse(self.receipt.exists())

    def test_context_rejects_pr_branches_repositories_and_missing_auth_before_io(self):
        for name, value in [('GITHUB_ACTIONS', 'false'), ('GITHUB_EVENT_NAME', 'pull_request'),
                            ('GITHUB_REF', 'refs/heads/other'), ('GITHUB_REPOSITORY', 'other/repository'),
                            ('GITHUB_RUN_ID', '0'), ('GITHUB_ACTOR', 'invalid/actor'), ('GH_TOKEN', ''),
                            ('GH_TOKEN', 'with newline\n')]:
            with self.subTest(name=name, value=value), patch.dict(os.environ, {name: value}):
                with self.assertRaises(RuntimeError):
                    self.invoke()
        self.verify.assert_not_called()
        self.assertEqual(self.calls, [])

    def test_source_and_artifact_identity_fail_before_registry_io(self):
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_SHA'):
            publish.publish(self.directory, 'main', self.receipt)
        for changes in [{'image': 'ghcr.io/other/image'}, {'tag': 'latest'}, {'source_sha': 'c' * 40},
                        {'manifest_digest': 'invalid'}, {'archive_path': self.directory / 'absent'}]:
            with self.subTest(changes=changes), patch.object(publish, 'verify_artifact',
                                                           return_value={**self.proof, **changes}):
                with self.assertRaises(RuntimeError):
                    self.invoke()
        self.assertEqual(self.calls, [])

    def test_artifact_verification_failure_never_authenticates(self):
        self.verify.side_effect = RuntimeError('helper rejected mismatched source or run')
        with self.assertRaises(RuntimeError):
            self.invoke()
        self.assertEqual(self.calls, [])

    def test_existing_receipt_is_preserved_without_registry_io(self):
        self.receipt.write_text('previous proof')
        with self.assertRaisesRegex(RuntimeError, 'RECEIPT_PATH'):
            self.invoke()
        self.assertEqual(self.receipt.read_text(), 'previous proof')
        self.assertEqual(self.calls, [])

    def test_cli_failure_never_prints_provider_output_or_token(self):
        self.login_result = (1, b'private stdout', b'synthetic-private-token private stderr')
        out = io.StringIO()
        with patch.object(sys, 'argv', ['publish.py', '--artifact-dir', str(self.directory),
                                       '--source-sha', self.sha, '--receipt', str(self.receipt)]), \
                contextlib.redirect_stdout(out):
            self.assertEqual(publish.main(), 1)
        body = json.loads(out.getvalue())
        self.assertEqual(body['error'], 'CRM_FLOW_PUBLISH_AUTH_FAILED')
        self.assertNotIn('private', out.getvalue())
        self.assertFalse(body['service_changed'])
        self.assertFalse(self.receipt.exists())


if __name__ == '__main__':
    unittest.main()
