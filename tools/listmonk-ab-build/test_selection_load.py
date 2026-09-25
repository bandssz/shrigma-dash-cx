from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import selection_load as load


class SelectionLoadTests(unittest.TestCase):
    def environment(self):
        return {'GITHUB_ACTIONS': 'true', 'CI': 'true', 'RUNNER_OS': 'Linux',
                'RUNNER_ARCH': 'X64', 'AB_SELECTION_LOAD_ISOLATED': '1'}

    def identity(self, address='127.0.0.1'):
        return {'db': 'ab_selection_load', 'user': 'synthetic', 'address': address,
                'version': 170010, 'objects': 0}

    def test_no_database_or_artifact_access_without_exact_ci_opt_in(self):
        env = self.environment()
        load.require_ci(env)
        for key in env:
            bad = dict(env)
            bad.pop(key)
            with self.assertRaises(ValueError):
                load.require_ci(bad)
        for key in ('PGHOST', 'PGPASSWORD', 'PGSERVICE', 'LISTMONK_DB__HOST'):
            with self.assertRaises(ValueError):
                load.require_ci({**env, key: 'external'})
        with patch.dict(load.os.environ, {}, clear=True), patch.object(load, 'Database') as database, patch.object(load, 'load_candidate') as artifact:
            with self.assertRaises(ValueError):
                load.run(Path('/missing'), Path('/missing/report'))
            database.assert_not_called()
            artifact.assert_not_called()

    def test_database_identity_version_and_empty_schema_required(self):
        load.require_identity(self.identity())
        load.require_identity(self.identity('172.18.0.2'))  # Docker loopback DNAT.
        for key, value in [('db', 'ab_worker_smoke'), ('user', 'postgres'), ('version', 170009),
                           ('objects', 1), ('address', '8.8.8.8'), ('address', '0.0.0.0')]:
            with self.assertRaises(ValueError):
                load.require_identity({**self.identity(), key: value})

    def test_database_parameters_fixed_loopback_and_environment_clean(self):
        completed = subprocess.CompletedProcess([], 0, 'f\n', '')
        with patch.object(load.subprocess, 'run', return_value=completed) as call:
            value, _ = load.Database(load.time.monotonic() + 10).sql('SELECT false;')
        self.assertEqual(value, 'f')
        args, kwargs = call.call_args
        self.assertEqual(args[0][-8:], ['-h', '127.0.0.1', '-p', '5432', '-U', 'synthetic', '-d', 'ab_selection_load'])
        self.assertFalse(any(key.startswith(('PG', 'LISTMONK_')) for key in kwargs['env']))
        self.assertLessEqual(kwargs['timeout'], 10)
        self.assertIn("SET lock_timeout='3s'", kwargs['input'])

    def test_deadline_and_output_limits_fail_before_or_after_bounded_process(self):
        with patch.object(load.subprocess, 'run') as run:
            with self.assertRaises(ValueError):
                load.Database(load.time.monotonic() - 1).sql('SELECT 1;')
            run.assert_not_called()
        oversized = subprocess.CompletedProcess([], 0, 'x' * (load.OUTPUT_LIMIT + 1), '')
        with patch.object(load.subprocess, 'run', return_value=oversized):
            with self.assertRaises(ValueError):
                load.Database(load.time.monotonic() + 10).sql('SELECT 1;')
        with patch.object(load.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'f', '')) as run:
            load.Database(load.time.monotonic() - 1).sql('SELECT false;', seconds=3, cleanup=True)
            self.assertLessEqual(run.call_args.kwargs['timeout'], 5)

    def test_query_section_and_binding_preserve_dml_cte(self):
        body = '-- name: next-campaigns\nWITH u AS (UPDATE x SET a=$2) SELECT $1;\n-- name: unrelated\nSELECT 1;'
        query = load.section(body, 'next-campaigns')
        self.assertEqual(query, 'WITH u AS (UPDATE x SET a=$2) SELECT $1;')
        bound = load.bind(query, ['ARRAY[1,2]::int[]', 'ARRAY[0,0]::int[]'])
        self.assertIn('UPDATE x SET a=ARRAY[0,0]::int[]', bound)
        self.assertTrue(load.explain_sql(bound).startswith('BEGIN;\nEXPLAIN (ANALYZE,'))
        self.assertTrue(load.explain_sql(bound).endswith('\nROLLBACK;'))
        for invalid in (body + '\n' + body, body.replace('$2', '$7'), '-- name: next-campaigns\nSELECT $1,$2'):
            with self.assertRaises(ValueError):
                load.section(invalid, 'next-campaigns')
        with self.assertRaises(ValueError):
            load.bind(query, ['0'])

    def test_independent_expected_sets_at_cap_and_after_suppressions(self):
        for phase, counts in [('baseline', (100000, 50000, 50000)), ('suppressed', (97000, 48000, 47000))]:
            control, a, b = [load.expected_ids(phase, kind) for kind in ('control', 'a', 'b')]
            self.assertEqual(tuple(map(len, (control, a, b))), counts)
            self.assertFalse(a & b)
            self.assertTrue((a | b) <= control)
            if phase == 'baseline':
                self.assertEqual(a | b, control)
            else:
                # Native control retains disabled and explicitly revoked members;
                # cohort delivery denies them, without changing native campaigns.
                self.assertEqual(control - (a | b), {n for n in range(1, 100001) if n % 100 in (2, 4)})

    def test_pagination_requires_count_ordered_checkpoint_and_terminal_empty_page(self):
        value = {'count': 48000, 'pages': 48, 'requests': 49, 'checkpoint': 99999, 'batch_size': 1000}
        load.verify_page_summary(value, 'suppressed', 'a')
        for key in value:
            with self.assertRaises(ValueError):
                load.verify_page_summary({**value, key: value[key] + 1}, 'suppressed', 'a')

    def test_explain_reports_real_server_time_separate_from_client_wall_time(self):
        plan = [{'Plan': {'Node Type': 'Result'}, 'Planning Time': 0.2, 'Execution Time': 2.5}]
        result = load.explain_record(plan, 120)
        self.assertEqual(result['execution_ms'], 2.5)
        self.assertEqual(result['psql_wall_ms'], 120)
        for invalid in ([], [{}], [{'Plan': {}, 'Planning Time': 1, 'Execution Time': float('nan')}],
                        [{'Plan': {}, 'Planning Time': -1, 'Execution Time': 1}]):
            with self.assertRaises(ValueError):
                load.explain_record(invalid, 100)

    def test_latency_review_signal_is_not_equivalence_or_production_capacity(self):
        native = [{'execution_ms': n} for n in (100, 110, 90)]
        candidate = [{'execution_ms': n} for n in (500, 490, 510)]
        self.assertEqual(load.compare_samples(native, candidate), {
            'upstream_median_ms': 100, 'candidate_median_ms': 500, 'delta_ms': 400, 'ratio': 5.0, 'review_signal': True})
        self.assertFalse(load.compare_samples(native, native)['review_signal'])

    def test_cleanup_marks_failure_even_after_success_and_writes_bounded_report(self):
        # Simulate an early fixture failure. Runtime OFF cleanup must happen even
        # when the SQL call failed; the diagnostic must remain a failed report.
        class FakeDB:
            instances = []

            def __init__(self, deadline):
                self.calls = []
                self.instances.append(self)

            def json(self, sql, **kwargs):
                return SelectionLoadTests().identity(), 1

            def sql(self, sql, **kwargs):
                self.calls.append((sql, kwargs))
                if 'SELECT enabled FROM crm_ab_runtime_v2' in sql:
                    return 'f', 1
                if 'generate_series(1,250000)' in sql:
                    raise ValueError('Synthetic fixture failure')
                return '', 1

        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'report.json'
            with patch.dict(load.os.environ, self.environment(), clear=True), patch.object(load, 'Database', FakeDB), \
                    patch.object(load, 'load_candidate', return_value=(b'synthetic', 'SELECT 1;', {'candidate_binary_sha256': 'a' * 64})), \
                    patch.object(load, 'load_queries', return_value={}):
                with self.assertRaisesRegex(ValueError, 'fixture failure'):
                    load.run(Path(folder), output)
            report = load.json.loads(output.read_text())
            self.assertEqual(report['status'], 'FAILED')
            self.assertEqual(report['stage'], 'fixture')
            self.assertEqual(report['runtime_after'], 'OFF')
            self.assertTrue(FakeDB.instances[-1].calls[-1][1]['cleanup'])

    def test_fixture_is_synthetic_bounded_and_does_not_run_worker_or_modify_product(self):
        fixture = (load.HERE / 'selection_load_fixture.sql').read_text()
        self.assertIn('@example.invalid', fixture)
        self.assertIn('generate_series(1,250000)', fixture)
        self.assertIn('generate_series(100001,250000)', fixture)
        self.assertIn('generate_series(10,18)', fixture)
        self.assertIn('generate_series(1,100000)', fixture)
        self.assertIn("SET status='unconfirmed' WHERE list_id=1 AND subscriber_id%100=5", fixture)
        self.assertIn('RETURN QUERY EXECUTE query_text', fixture)
        self.assertIn('IF requests>101', fixture)
        self.assertIn('PRIMARY KEY(label,id)', fixture)
        self.assertNotIn('FOR r IN EXECUTE', fixture)
        self.assertNotIn('CREATE OR REPLACE', fixture)
        source = Path(load.__file__).read_text()
        self.assertNotIn('subprocess.Popen', source)
        self.assertNotIn('urlopen', source)
        self.assertNotIn('CaptureSMTP', source)


if __name__ == '__main__':
    unittest.main()
