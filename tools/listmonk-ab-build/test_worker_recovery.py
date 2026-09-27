import concurrent.futures
import json
from pathlib import Path
import smtplib
import tempfile
import unittest
from unittest.mock import Mock, patch

import worker_recovery as recovery


def send(port):
    with smtplib.SMTP('127.0.0.1', port, timeout=3) as smtp:
        smtp.sendmail('smoke@example.invalid', ['s001@example.invalid'],
                      'From: smoke@example.invalid\r\nTo: s001@example.invalid\r\nSubject: AB-A\r\n\r\ns001@example.invalid\r\n')


class RecoveryTests(unittest.TestCase):
    def test_gate_is_before_smtp_acceptance_and_can_release_normally(self):
        with recovery.GatedSMTP() as gate, concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(send, gate.port)
            self.assertTrue(gate.entered.wait(2))
            self.assertFalse(future.done())
            self.assertEqual(gate.messages, [])
            self.assertEqual(gate.attempted, ('s001@example.invalid',))
            gate.release.set()
            future.result(timeout=2)
            self.assertEqual(len(gate.messages), 1)
            self.assertEqual(gate.errors, [])

    def test_abort_never_invents_an_accepted_receipt(self):
        with recovery.GatedSMTP() as gate, concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(send, gate.port)
            self.assertTrue(gate.entered.wait(2))
            gate.abort.set()
            gate.release.set()
            with self.assertRaises(smtplib.SMTPServerDisconnected):
                future.result(timeout=2)
            self.assertEqual(gate.messages, [])
            self.assertEqual(gate.errors, [])

    def test_recovery_requires_its_own_ci_opt_in_before_files_or_database(self):
        env = {'GITHUB_ACTIONS': 'true', 'CI': 'true', 'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64', 'AB_WORKER_RECOVERY_ISOLATED': '1'}
        recovery.require_ci(env)
        for key in env:
            bad = dict(env)
            bad.pop(key)
            with self.assertRaises(ValueError):
                recovery.require_ci(bad)
        with patch.dict(recovery.os.environ, {}, clear=True), patch.object(recovery, 'db') as database, patch.object(recovery.smoke, 'load_candidate') as load:
            with self.assertRaises(ValueError):
                recovery.run(Path('/absent'), Path('/absent/report'))
            database.assert_not_called()
            load.assert_not_called()

    def test_only_separate_fixed_local_databases_are_allowed(self):
        with patch.object(recovery.subprocess, 'run') as command:
            for name in ('ab_worker_smoke', 'production', 'postgres://remote/db', 'ab_worker_recovery_optout;DROP TABLE x'):
                with self.assertRaises(ValueError):
                    recovery.db(name, 'SELECT 1;')
            command.assert_not_called()
        fake = recovery.subprocess.CompletedProcess([], 0, 'synthetic\n', '')
        with patch.object(recovery.subprocess, 'run', return_value=fake) as command:
            recovery.db(recovery.DATABASES[0], 'SELECT current_user;')
        args, kwargs = command.call_args
        self.assertEqual(args[0][-8:], ['-h', '127.0.0.1', '-p', '5432', '-U', 'synthetic', '-d', recovery.DATABASES[0]])
        self.assertFalse(any(k.startswith(('PG', 'LISTMONK_')) for k in kwargs['env']))

    def message(self, subject='AB-A', sid=1):
        address = 's%03d@example.invalid' % sid
        return {'sender': 'smoke@example.invalid', 'subject': subject, 'recipients': [address], 'body': address}

    def test_captures_preserve_partition_identity_and_reject_duplicates(self):
        self.assertEqual(recovery.captured_sets([self.message(), self.message('AB-B', 13)]), {'AB-A': {1}, 'AB-B': {13}})
        for messages in [[self.message(), self.message()], [self.message('AB-A', 13)], [self.message('AB-B', 1)], [self.message('OTHER', 1)]]:
            with self.assertRaises(ValueError):
                recovery.captured_sets(messages)

    def test_executable_or_merely_paused_arms_block_rollback_before_binary_write(self):
        for status in ('running', 'scheduled', 'paused', 'draft'):
            scenario = Mock()
            scenario.database = recovery.DATABASES[1]
            with tempfile.TemporaryDirectory() as tmp:
                scenario.work = Path(tmp)
                replies = ['', json.dumps([{'id': 1, 'status': status}, {'id': 2, 'status': 'finished'}])]
                with patch.object(recovery, 'db', side_effect=replies):
                    with self.assertRaises(ValueError):
                        recovery.rollback_case(scenario, b'NEVER EXECUTE')
                self.assertFalse((scenario.work / 'original-rollback').exists())
                scenario.start.assert_not_called()

    def test_result_evaluation_keeps_a_real_deficit_inconclusive_and_denominator_fixed(self):
        scenario = recovery.Scenario.__new__(recovery.Scenario)
        scenario.database = recovery.DATABASES[0]
        source = {'contract': 'crm-ab-email-v2', 'test_id': recovery.TEST_ID, 'protocol': recovery.protocol(),
                  'window_start': '2026-09-24T00:00:00.000Z', 'window_end': '2026-09-25T00:00:00.000Z', 'as_of': '2026-09-25T00:00:00.001Z',
                  'integrity': {k: True for k in ('allocation_complete', 'assignment_disjoint', 'transport_bound', 'transport_continuous', 'tracking_continuous', 'source_complete')},
                  'arms': [{'arm': arm, 'campaign_id': cid, 'allocated': 12, 'native_sent': sent, 'unique_clickers': 0, 'revoked': 0, 'unknown': 0, 'finished_before_deadline': True}
                           for arm, cid, sent in [('a', 1, 12), ('b', 2, 11)]]}
        with patch.object(recovery, 'db', return_value=json.dumps(source)):
            result = scenario.mature_result()
        self.assertEqual(result['result']['reason'], 'transport_not_fully_accounted')
        self.assertEqual(result['result']['status'], 'inconclusive')
        self.assertEqual(result['source'], source)
        self.assertEqual([a['allocated'] for a in result['result']['arms']], [12, 12])


if __name__ == '__main__':
    unittest.main()
