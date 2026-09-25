from pathlib import Path
import subprocess
import sqlite3
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

    def test_overlap_intersect_matches_independent_sets_and_ignores_other_phases(self):
        # SQL INTERSECT semantics on tiny synthetic sets, not a load benchmark.
        for a, b in [({1, 3, 5}, {2, 4}), ({1, 3, 5}, {1, 4, 5}), (set(), {1})]:
            with sqlite3.connect(':memory:') as db:
                db.create_function('json_build_object', 2, lambda key, value: load.json.dumps({key: value}))
                db.execute('CREATE TABLE selection_load_seen(label TEXT,id INTEGER,PRIMARY KEY(label,id))')
                for label, ids in [('suppressed:candidate:a', a), ('suppressed:candidate:b', b),
                                   ('baseline:candidate:a', {99}), ('baseline:candidate:b', {99})]:
                    db.executemany('INSERT INTO selection_load_seen VALUES(?,?)', [(label, n) for n in ids])
                result = load.json.loads(db.execute(load.overlap_sql('suppressed')).fetchone()[0])
                self.assertEqual(result, {'overlap': len(a & b)})
        with self.assertRaises(ValueError):
            load.overlap_sql('unexpected')

    def report_fixture(self):
        return {'schema': 'synthetic-test', 'status': 'PASSED_SYNTHETIC_EQUIVALENCE_REVIEW_LATENCY',
                'stage': 'complete', 'runtime_after': 'OFF', 'measurements': [
                    {'case': 'case_' + str(i), 'samples': {variant: [
                        {'execution_ms': j + 1, 'planning_ms': 0.1, 'psql_wall_ms': 10, 'plan_id': i * 6 + n * 3 + j}
                        for j in range(3)] for n, variant in enumerate(('upstream', 'candidate'))}}
                    for i in range(11)]}

    def test_all_metrics_small_summary_and_exact_large_plans_have_separate_bounds(self):
        report = self.report_fixture()
        plans = [{'plan_id': n, 'query': 'SELECT 1;', 'explain': {'Plan': {'synthetic': 'x' * 50000}}} for n in range(66)]
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'selection-load.json'
            self.assertIsNone(load.write_reports(report, plans, output))
            summary = load.json.loads(output.read_bytes())
            self.assertLess(output.stat().st_size, 20000)
            self.assertEqual(summary['measurements'], self.report_fixture()['measurements'])
            archive = load.plan_path(output).read_bytes()
            raw = load.gzip.decompress(archive)
            self.assertGreater(len(raw), load.REPORT_LIMIT)
            self.assertEqual(load.json.loads(raw)['plans'], plans)
            self.assertEqual(summary['explain_archive']['sha256'], load.build.sha(archive))
            self.assertEqual(summary['explain_archive']['plans'], 66)

    def test_report_overflow_falls_back_to_failed_summary_with_every_timing(self):
        report = self.report_fixture()
        report.update({'status': 'FAILED', 'failure_type': 'SyntheticPrimary', 'failure_detail': 'original failure',
                       'oversized_unexpected_field': 'x' * (load.REPORT_LIMIT + 1)})
        with tempfile.TemporaryDirectory() as folder, patch('builtins.print') as log:
            output = Path(folder) / 'report.json'
            self.assertIsInstance(load.write_reports(report, [], output), ValueError)
            summary = load.json.loads(output.read_bytes())
            self.assertEqual(summary['status'], 'FAILED')
            self.assertEqual(summary['failure_type'], 'SyntheticPrimary')
            self.assertEqual(summary['failure_detail'], 'original failure')
            self.assertEqual(summary['measurements'], self.report_fixture()['measurements'])
            self.assertNotIn('oversized_unexpected_field', summary)
            log.assert_called_once()

    def test_plan_archive_failure_never_leaves_pass_and_still_writes_summary(self):
        for kind in ('compress', 'raw_limit', 'gzip_limit'):
            report = self.report_fixture()
            with tempfile.TemporaryDirectory() as folder, patch('builtins.print'):
                output = Path(folder) / 'report.json'
                if kind == 'compress':
                    mocked = patch.object(load.gzip, 'compress', side_effect=OSError('synthetic gzip failure'))
                elif kind == 'raw_limit':
                    mocked = patch.object(load, 'PLAN_RAW_LIMIT', 10)
                else:
                    mocked = patch.object(load, 'PLAN_GZIP_LIMIT', 10)
                with mocked:
                    self.assertIsNotNone(load.write_reports(report, [], output))
                summary = load.json.loads(output.read_bytes())
                self.assertEqual(summary['status'], 'FAILED')
                self.assertIn('report_failure_type', summary)
                self.assertEqual(summary['measurements'], self.report_fixture()['measurements'])

    def test_unwritable_evidence_falls_back_to_bounded_failed_ci_log(self):
        report = self.report_fixture()
        with tempfile.TemporaryDirectory() as folder, patch.object(Path, 'open', side_effect=OSError('synthetic write failure')), patch('builtins.print') as log:
            self.assertIsInstance(load.write_reports(report, [], Path(folder) / 'report.json'), OSError)
            summary = load.json.loads(log.call_args.args[0])
            self.assertEqual(summary['status'], 'FAILED')
            self.assertEqual(summary['measurements'], self.report_fixture()['measurements'])

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

        with tempfile.TemporaryDirectory() as folder, patch('builtins.print'), patch.object(load.gzip, 'compress', side_effect=OSError('secondary archive failure')):
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
            self.assertEqual(report['report_failure_type'], 'OSError')
            self.assertEqual(report['failure_detail'], 'Synthetic fixture failure')
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
