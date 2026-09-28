import os
from pathlib import Path
import subprocess
import sys
import unittest
import uuid
from unittest.mock import patch
import probe


class ProbeGuards(unittest.TestCase):
    def test_missing_opt_in_and_invalid_destination_never_start_a_process(self):
        for env, port, container in [({}, '5432', 'a' * 64),
                                     ({'CI': 'true', 'CRM_PGP_PROTOTYPE': '1'}, '1', 'a' * 64),
                                     ({'CI': 'true', 'CRM_PGP_PROTOTYPE': '1'}, '5432', '--help')]:
            with self.subTest(port=port, container=container), patch.dict(os.environ, env, clear=True), patch.object(sys, 'argv', ['probe.py', '--port', port, '--container-id=' + container]), patch.object(probe, 'process') as process:
                with self.assertRaisesRegex(ValueError, 'PGP_PROTOTYPE_(CI_ONLY|TARGET)'):
                    probe.main()
                process.assert_not_called()

    def test_wrong_database_or_server_identity_stops_before_fixture_ddl(self):
        for body in [b'{"version":170009}', b'{"version":170010,"database":"listmonk","role":"postgres","fixture_absent":true}']:
            with self.subTest(body=body), patch.dict(os.environ, {'CI': 'true', 'CRM_PGP_PROTOTYPE': '1'}, clear=True), patch.object(sys, 'argv', ['probe.py', '--port', '5432', '--container-id', 'a' * 64]), patch.object(probe, 'process', return_value=subprocess.CompletedProcess([], 0, body, b'')) as process:
                with self.assertRaisesRegex(ValueError, 'IDENTITY'):
                    probe.main()
                self.assertEqual(process.call_count, 1)
                request = process.call_args.kwargs
                self.assertNotIn(b'CREATE', request['data'])
                self.assertEqual(request['env']['PGHOST'], '127.0.0.1')
                self.assertEqual(request['env']['PGDATABASE'], 'crm_pgp_prototype')

    def test_public_sql_builder_refuses_unrecognized_inputs_and_never_creates_real_access(self):
        for pub, nonce, mode in [(b'a', str(uuid.uuid4()), 'normal'), (b'a' * 256, "x'; ALTER ROLE postgres LOGIN;--", 'normal'), (b'a' * 256, str(uuid.uuid4()), 'production')]:
            with self.assertRaises(ValueError):
                probe.prepare_sql(pub, nonce, mode)
        sql = probe.prepare_sql(bytes(range(256)), str(uuid.uuid4()))
        self.assertIn('gen_random_bytes(32)', sql)
        self.assertIn('pgp_pub_encrypt', sql)
        self.assertIn('NOLOGIN PASSWORD %L', sql)
        self.assertIn('auth_proof_hash', sql)
        self.assertNotIn('crm_graph_worker', sql)
        self.assertNotIn(' PASSWORD NULL', sql)
        self.assertNotIn('DISABLE', sql)

    def test_missing_logs_cannot_be_reported_as_no_leak(self):
        for value in [b'', b'crm_pgp_probe', b'PGP_PROTOTYPE_CANCELLED']:
            with self.assertRaisesRegex(ValueError, 'LOG_COVERAGE'):
                probe.check_logs(value, [b'synthetic-secret'])

    def test_plaintext_and_verifier_in_normal_or_error_output_are_detected(self):
        prefix = b'crm_pgp_probe PGP_PROTOTYPE_CANCELLED '
        for secret in [b'synthetic-secret', b'SCRAM-SHA-256$4096:synthetic$stored:server']:
            for location in [b'LOG: ', b'ERROR: ', b'CONTEXT: ']:
                with self.assertRaisesRegex(ValueError, 'LOG_SECRET'):
                    probe.check_logs(prefix + location + secret, [secret])
        probe.check_logs(prefix + b"EXECUTE format('ALTER ROLE %I NOLOGIN PASSWORD %L',target,secret)", [b'synthetic-secret'])

    def test_rolled_back_secret_unknown_to_client_is_detected_in_expanded_sql(self):
        evidence = b"crm_pgp_probe PGP_PROTOTYPE_CANCELLED CONTEXT: SQL statement \"ALTER ROLE crm_pgp_probe_absent NOLOGIN PASSWORD '" + b'a' * 64 + b"'\""
        with self.assertRaisesRegex(ValueError, 'LOG_DYNAMIC_SECRET'):
            probe.check_logs(evidence, [b'different-successful-secret'])

    def test_workflow_has_no_production_credentials_or_registry_permissions(self):
        text = (Path(__file__).resolve().parents[2] / '.github/workflows/crm-worker-credential-pgp-probe.yml').read_text()
        self.assertIn('postgres:17.10', text)
        self.assertIn('crm_pgp_prototype', text)
        self.assertIn('pull_request:', text)
        self.assertNotIn('secrets.', text)
        self.assertNotIn('packages: write', text)
        self.assertNotIn('upload-artifact', text)


if __name__ == '__main__':
    unittest.main()
