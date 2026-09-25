from pathlib import Path
import unittest
from unittest.mock import patch

import worker_smoke as smoke


class WorkerSmokeTests(unittest.TestCase):
    def valid_messages(self):
        return [{'sender': 'smoke@example.invalid', 'recipients': ['s%03d@example.invalid' % n],
                 'subject': subject, 'body': 's%03d@example.invalid http://127.0.0.1:9999/subscription/synthetic/synthetic' % n}
                for subject, ids in smoke.EXPECTED.items() for n in sorted(ids)]

    def valid_rows(self):
        return [{'subject': s, 'status': 'finished', 'sent': len(ids), 'to_send': len(ids), 'last_subscriber_id': max(ids)}
                for s, ids in smoke.EXPECTED.items()]

    def test_runner_requires_explicit_ephemeral_amd64_ci_before_any_side_effect(self):
        env = {'GITHUB_ACTIONS': 'true', 'CI': 'true', 'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64', 'AB_WORKER_SMOKE_ISOLATED': '1'}
        smoke.require_ci(env)
        for key in env:
            bad = dict(env)
            bad.pop(key)
            with self.assertRaises(ValueError):
                smoke.require_ci(bad)
        for key in ('LISTMONK_DB__HOST', 'PGHOST', 'PGSERVICE', 'PGPASSWORD'):
            with self.assertRaises(ValueError):
                smoke.require_ci({**env, key: 'external'})
        with patch.dict(smoke.os.environ, {}, clear=True), patch.object(smoke, 'db') as database, patch.object(smoke, 'load_candidate') as load:
            with self.assertRaises(ValueError):
                smoke.run(Path('/missing'), Path('/missing/report'))
            database.assert_not_called()
            load.assert_not_called()

    def test_exact_disjoint_delivery_and_native_control_counts(self):
        self.assertEqual(smoke.validate_delivery(self.valid_messages(), self.valid_rows(), []), {'AB-A': 2, 'AB-B': 2, 'CONTROL': 10})

    def test_rejects_suppressed_unallocated_wrong_arm_and_external_recipients(self):
        for recipient in ['s002@example.invalid', 's003@example.invalid', 's005@example.invalid', 's007@example.invalid', 's009@example.invalid', 's011@example.invalid', 's015@example.invalid', 'any@example.com']:
            messages = self.valid_messages()
            messages[0]['recipients'] = [recipient]
            with self.assertRaises(ValueError):
                smoke.validate_delivery(messages, self.valid_rows(), [])

    def test_rejects_duplicates_missing_messages_extra_campaigns_and_capture_errors(self):
        for messages in [self.valid_messages()[:-1], self.valid_messages() + self.valid_messages()[:1], []]:
            with self.assertRaises(ValueError):
                smoke.validate_delivery(messages, self.valid_rows(), [])
        messages = self.valid_messages()
        messages[0]['subject'] = 'UNEXPECTED'
        with self.assertRaises(ValueError):
            smoke.validate_delivery(messages, self.valid_rows(), [])
        with self.assertRaises(ValueError):
            smoke.validate_delivery(self.valid_messages(), self.valid_rows(), ['rejected'])

    def test_requires_finished_exact_native_counters_and_sparse_checkpoint(self):
        for key, value in [('status', 'running'), ('sent', 0), ('to_send', 16), ('last_subscriber_id', 1)]:
            rows = self.valid_rows()
            rows[0][key] = value
            with self.assertRaises(ValueError):
                smoke.validate_delivery(self.valid_messages(), rows, [])
        with self.assertRaises(ValueError):
            smoke.validate_delivery(self.valid_messages(), self.valid_rows()[:-1], [])

    def test_requires_native_personalization_and_loopback_unsubscribe_url(self):
        for body in ['unrendered {{ .Subscriber.Email }}', 's001@example.invalid https://example.invalid/subscription/a/b']:
            messages = self.valid_messages()
            messages[0]['body'] = body
            with self.assertRaises(ValueError):
                smoke.validate_delivery(messages, self.valid_rows(), [])

    def test_configuration_has_no_external_transport_and_exercises_small_batches(self):
        sql = smoke.configure_smtp(2525, 9000)
        self.assertIn('"host": "127.0.0.1"', sql)
        self.assertIn('"max_msg_retries": 0', sql)
        for key in ('app.check_updates', 'bounce.enabled', 'app.send_optin_confirmation'):
            self.assertIn("value='false'::jsonb WHERE key='" + key + "'", sql)
        self.assertIn("value='1'::jsonb WHERE key='app.batch_size'", sql)
        self.assertIn("value='[]'::jsonb WHERE key='messengers'", sql)

    def test_database_endpoint_cannot_be_supplied_by_environment(self):
        fake = smoke.subprocess.CompletedProcess([], 0, 'f\n', '')
        with patch.object(smoke.subprocess, 'run', return_value=fake) as call:
            self.assertEqual(smoke.db('SELECT false;'), 'f')
        args, kwargs = call.call_args
        self.assertEqual(args[0][-8:], ['-h', '127.0.0.1', '-p', '5432', '-U', 'synthetic', '-d', 'ab_worker_smoke'])
        self.assertFalse(any(k.startswith(('PG', 'LISTMONK_')) for k in kwargs['env']))
        self.assertIn("SET statement_timeout='15s'", kwargs['input'])

    def test_native_dsn_placeholder_does_not_consume_database(self):
        # Regression: v6.1.0 interpolates TOML password into `password=%s dbname=%s`.
        # lib/pq skips whitespace after '=', so a zero-length token swallowed the
        # database field and connected to the user-named database instead.
        config = smoke.native_config(9000)
        self.assertIn('password="synthetic-ci-placeholder"\n', config)
        self.assertNotIn('password=""\n', config)
        self.assertIn('database="ab_worker_smoke"\n', config)
        self.assertIn('host="127.0.0.1"\n', config)
        self.assertIn('address="127.0.0.1:9000"\n', config)


if __name__ == '__main__':
    unittest.main()
