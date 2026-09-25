#!/usr/bin/env python3
"""Bounded synthetic SQL selection rehearsal, only in disposable amd64 GitHub CI.

The root CI job creates an EMPTY ab_selection_load database first. No server,
worker, SMTP, HTTP, external connection, recipient export or deployment is made.
All source SQL comes from the pinned, verified candidate/rollback artifact.
"""
import argparse
import gzip
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import statistics
import subprocess
import tarfile
import time

import build
from worker_smoke import clean_env, load_candidate

HERE = Path(__file__).resolve().parent
DB_NAME = 'ab_selection_load'
PG_VERSION = 170010
COHORT = 100000
BATCH = 1000
TIMEOUT = 240
OUTPUT_LIMIT = 262144
REPORT_LIMIT = 2097152
PLAN_RAW_LIMIT = 20 * 1048576
PLAN_GZIP_LIMIT = 4 * 1048576
QUERY_NAMES = ('next-campaigns', 'next-campaign-subscribers')
CASES = (('upstream', 'control', 3), ('candidate', 'control', 3),
         ('candidate', 'a', 1), ('candidate', 'b', 2))


def require_ci(env):
    build.require(env.get('GITHUB_ACTIONS') == 'true' and env.get('CI') == 'true'
                  and env.get('RUNNER_OS') == 'Linux' and env.get('RUNNER_ARCH') == 'X64'
                  and env.get('AB_SELECTION_LOAD_ISOLATED') == '1', 'Ephemeral amd64 load CI opt-in required')
    build.require(not any(k.startswith(('LISTMONK_', 'PG')) for k in env), 'External service configuration forbidden')


def require_identity(identity):
    # Docker DNAT can make inet_server_addr() the private service-container IP.
    # The CLIENT endpoint is always literal loopback, regardless of this value.
    address = ipaddress.ip_address(identity.get('address', '0.0.0.0'))
    build.require(all(identity.get(key) == value for key, value in
                      {'db': DB_NAME, 'user': 'synthetic', 'version': PG_VERSION, 'objects': 0}.items())
                  and address.version == 4 and address.is_private and not address.is_unspecified,
                  'Expected an empty local disposable PostgreSQL 17.10 database')


class Database:
    def __init__(self, deadline):
        self.deadline = deadline

    def sql(self, sql, seconds=30, cleanup=False):
        remaining = 5 if cleanup else self.deadline - time.monotonic()
        build.require(remaining > 1, 'Synthetic selection deadline exceeded')
        seconds = min(seconds, remaining - 0.5)
        start = time.monotonic()
        result = subprocess.run(['psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
                                 '-h', '127.0.0.1', '-p', '5432', '-U', 'synthetic', '-d', DB_NAME],
                                input="SET statement_timeout='%dms'; SET lock_timeout='3s';\n" % int(seconds * 1000) + sql,
                                text=True, env=clean_env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=seconds + 0.4)
        build.require(len(result.stdout.encode()) + len(result.stderr.encode()) <= OUTPUT_LIMIT, 'Database output limit exceeded')
        build.require(result.returncode == 0, 'Synthetic database statement failed: ' + result.stderr[-1500:])
        return result.stdout.strip(), round((time.monotonic() - start) * 1000, 3)

    def json(self, sql, **kwargs):
        body, elapsed = self.sql(sql, **kwargs)
        return json.loads(body), elapsed


def section(source, name):
    build.require(name in QUERY_NAMES, 'Unexpected query name')
    matches = list(re.finditer(r'^-- name: ([a-z0-9-]+)\s*$', source, re.M))
    selected = [i for i, match in enumerate(matches) if match.group(1) == name]
    build.require(len(selected) == 1, 'Native query section missing or duplicated')
    index = selected[0]
    text = source[matches[index].end():matches[index + 1].start() if index + 1 < len(matches) else len(source)].strip()
    build.require(text.endswith(';'), 'Native query must be a complete statement')
    expected = {'1', '2'} if name == QUERY_NAMES[0] else {str(n) for n in range(1, 7)}
    build.require(set(re.findall(r'\$(\d+)\b', text)) == expected, 'Unexpected native query parameters')
    return text


def load_queries(folder, candidate):
    patched = build.inspect_stuffed(candidate)['assets'][build.QUERY]['body']
    name = 'listmonk-6.1.0-crm-ab-candidate-linux_amd64.tar.gz'
    source = None
    with tarfile.open(folder / name, 'r:gz') as archive:
        for entry in archive:
            if entry.name != 'source/campaigns.upstream.sql':
                continue
            build.require(source is None and entry.isfile() and entry.size <= build.LIMITS['asset_bytes'], 'Unsafe upstream query source')
            with archive.extractfile(entry) as stream:
                source = stream.read(entry.size + 1)
            build.require(len(source) == entry.size, 'Truncated upstream query source')
    build.require(source is not None and build.sha(source) == build.LOCK['query']['upstream_sha256'], 'Upstream query hash mismatch')
    build.require(build.sha(patched) == build.LOCK['query']['patched_sha256'], 'Candidate query hash mismatch')
    return {variant: {name: section(body.decode(), name) for name in QUERY_NAMES}
            for variant, body in [('upstream', source), ('candidate', patched)]}


def quote(text):
    return "'" + text.replace("'", "''") + "'"


def bind(query, args):
    # Only fixed runner constants are supplied; the exact statement is otherwise
    # unchanged. DML CTEs must stay top level (no SELECT wrapper is added).
    parameters = set(re.findall(r'\$(\d+)\b', query))
    build.require(parameters == {str(i) for i in range(1, len(args) + 1)}, 'SQL parameter mismatch')
    return re.sub(r'\$(\d+)\b', lambda match: args[int(match.group(1)) - 1], query)


def expected_ids(phase, kind):
    build.require(phase in ('baseline', 'suppressed') and kind in ('control', 'a', 'b'), 'Unknown expectation')
    return {n for n in range(1, COHORT + 1)
            if (kind == 'control' or n % 2 == (1 if kind == 'a' else 0))
            and (phase == 'baseline' or n % 100 not in ((0, 1, 3) if kind == 'control' else (0, 1, 2, 3, 4)))}


def explain_sql(query):
    return 'BEGIN;\nEXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF, SUMMARY TRUE)\n' + query + '\nROLLBACK;'


def explain_record(value, wall_ms):
    build.require(isinstance(value, list) and len(value) == 1 and isinstance(value[0], dict), 'Invalid EXPLAIN result')
    plan = value[0]
    build.require(isinstance(plan.get('Plan'), dict), 'Missing EXPLAIN plan')
    for key in ('Execution Time', 'Planning Time'):
        build.require(type(plan.get(key)) in (int, float) and math.isfinite(plan[key]) and plan[key] >= 0, 'Invalid EXPLAIN timing')
    return {'execution_ms': plan['Execution Time'], 'planning_ms': plan['Planning Time'],
            'psql_wall_ms': wall_ms, 'explain': plan}


def compare_samples(upstream, candidate):
    native = statistics.median(item['execution_ms'] for item in upstream)
    changed = statistics.median(item['execution_ms'] for item in candidate)
    return {'upstream_median_ms': native, 'candidate_median_ms': changed,
            'delta_ms': round(changed - native, 3), 'ratio': round(changed / native, 3) if native else None,
            # A review signal, not a production SLO or automatic optimization.
            'review_signal': changed >= 3 * max(native, 0.001) and changed - native >= 250}


def verify_page_summary(value, phase, kind):
    ids = expected_ids(phase, kind)
    expected = {'count': len(ids), 'pages': math.ceil(len(ids) / BATCH),
                'requests': math.ceil(len(ids) / BATCH) + 1, 'checkpoint': max(ids), 'batch_size': BATCH}
    build.require(value == expected, 'Native pagination count or checkpoint mismatch')


def count_proof(db, queries, phase, report):
    reports = report[phase + '_counts'] = []
    for variant in ('upstream', 'candidate'):
        for group, excluded in [('control', [1, 2]), ('ab', [3])]:
            report['stage'] = phase + ':count:' + variant + ':' + group
            query = queries[variant][QUERY_NAMES[0]]
            array = 'ARRAY[' + ','.join(map(str, excluded)) + ']::int[]'
            zeroes = 'ARRAY[' + ','.join('0' for _ in excluded) + ']::int[]'
            statement = bind(query, [array, zeroes])
            # EXECUTE without INTO discards native SELECT rows. Inspect only
            # aggregate counters after its DML CTEs, then roll the changes back.
            sql = ('BEGIN; DO $proof$ BEGIN EXECUTE ' + quote(statement) + '; END $proof$;\n'
                   'SELECT json_agg(json_build_object(\'id\',id,\'to_send\',to_send,\'max_id\',max_subscriber_id) ORDER BY id) '
                   'FROM campaigns WHERE id IN (' + ('3' if group == 'control' else '1,2') + '); ROLLBACK;')
            rows, elapsed = db.json(sql)
            expected = []
            for cid in ([3] if group == 'control' else [1, 2]):
                kind = 'control' if variant == 'upstream' or cid == 3 else ('a' if cid == 1 else 'b')
                ids = expected_ids(phase, kind)
                expected.append({'id': cid, 'to_send': len(ids), 'max_id': max(ids)})
            build.require(rows == expected, 'Native count or upper checkpoint mismatch')
            reports.append({'variant': variant, 'group': group, 'counters': rows, 'psql_wall_ms': elapsed})
    return reports


def set_proof(db, queries, phase, report):
    partial = report[phase + '_sets'] = {'pages': [], 'exact_set_equivalence': False}
    result = partial['pages']
    for variant, kind, cid in CASES:
        label = phase + ':' + variant + ':' + kind
        report['stage'] = phase + ':pagination:' + variant + ':' + kind
        query = queries[variant][QUERY_NAMES[1]]
        sql = ('SELECT selection_load_paginate(' + quote(label) + ',' + str(cid) + ','
               + str(max(expected_ids(phase, kind))) + ',' + quote(query) + ');')
        value, elapsed = db.json(sql)
        verify_page_summary(value, phase, kind)
        # These are test-evidence rows only. Keep their planner statistics fresh;
        # neither this table nor this ANALYZE is part of the product query.
        db.sql('ANALYZE selection_load_seen;')
        proof, _ = db.json("SELECT json_build_object('missing',(SELECT count(*) FROM (SELECT id FROM selection_load_expected WHERE phase="
                          + quote(phase) + ' AND kind=' + quote(kind) + ' EXCEPT SELECT id FROM selection_load_seen WHERE label='
                          + quote(label) + ")x),'extra',(SELECT count(*) FROM (SELECT id FROM selection_load_seen WHERE label="
                          + quote(label) + ' EXCEPT SELECT id FROM selection_load_expected WHERE phase='
                          + quote(phase) + ' AND kind=' + quote(kind) + ')x));')
        build.require(proof == {'missing': 0, 'extra': 0}, 'Selection set differs from independent fixture expectation')
        result.append({'variant': variant, 'kind': kind, **value, **proof, 'psql_wall_ms': elapsed})
    report['stage'] = phase + ':overlap'
    overlap, _ = db.json(overlap_sql(phase))
    build.require(overlap == {'overlap': 0}, 'A/B partition overlap')
    partial.update({**overlap, 'exact_set_equivalence': True})
    return partial


def overlap_sql(phase):
    build.require(phase in ('baseline', 'suppressed'), 'Unknown overlap phase')
    return ("SELECT json_build_object('overlap',count(*)) FROM (SELECT id FROM selection_load_seen WHERE label="
            + quote(phase + ':candidate:a') + ' INTERSECT SELECT id FROM selection_load_seen WHERE label='
            + quote(phase + ':candidate:b') + ') shared_ids;')


def measure(db, queries, report, plans):
    cases = [('count_control', QUERY_NAMES[0], ['ARRAY[1,2]::int[]', 'ARRAY[0,0]::int[]']),
             ('count_ab', QUERY_NAMES[0], ['ARRAY[3]::int[]', 'ARRAY[0]::int[]'])]
    for kind, cid in [('control', 3), ('a', 1), ('b', 2)]:
        for position in (0, 50000, 98000):
            cases.append(('batch_' + kind + '_' + str(position), QUERY_NAMES[1],
                          [str(cid), "'regular'", str(position), str(COHORT), 'ARRAY[1,2]::int[]', str(BATCH)]))
    reports = report['measurements']
    for name, query_name, args in cases:
        samples = {'upstream': [], 'candidate': []}
        entry = {'case': name, 'samples': samples}
        reports.append(entry)
        for repeat in range(3):
            # Alternate order. These are warm/shared-cache sequential samples,
            # not independent cold-cache or concurrent worker measurements.
            for variant in (('upstream', 'candidate') if repeat % 2 == 0 else ('candidate', 'upstream')):
                report['stage'] = 'explain:' + name + ':' + variant
                bound = bind(queries[variant][query_name], args)
                value, elapsed = db.json(explain_sql(bound))
                sample = explain_record(value, elapsed)
                sample['plan_id'] = len(plans)
                plans.append({'plan_id': len(plans), 'case': name, 'variant': variant, 'repeat': repeat,
                              'query_sha256': build.sha(bound.encode()), 'query': bound, 'explain': sample.pop('explain')})
                samples[variant].append(sample)
        entry.update(compare_samples(samples['upstream'], samples['candidate']))
    return reports


SUPPRESSION = """
BEGIN;
UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id<=100000 AND subscriber_id%100=0;
UPDATE subscribers SET status='blocklisted' WHERE id<=100000 AND id%100=1;
UPDATE subscribers SET status='disabled' WHERE id<=100000 AND id%100=2;
UPDATE subscriber_lists SET status='unconfirmed' WHERE subscriber_id<=100000 AND subscriber_id%100=3 AND list_id=1;
UPDATE crm_ab_member_v2 SET revoked_at=clock_timestamp(),revoked_reason='synthetic' WHERE subscriber_id%100=4;
COMMIT;
ANALYZE;
"""


def plan_path(output):
    return output.with_name(output.stem + '-plans.json.gz')


def compact_json(value, limit):
    encoded = (json.dumps(value, separators=(',', ':'), allow_nan=False) + '\n').encode()
    build.require(len(encoded) <= limit, 'Evidence byte limit exceeded')
    return encoded


def emergency_summary(report):
    # Fixed-shape fallback: keeps EVERY timing sample (11 x 2 x 3), never plans
    # or unexpected oversized fields. The original failure takes precedence.
    result = {key: report[key] for key in (
        'schema', 'stage', 'production_access', 'database', 'postgres_version', 'runtime_after',
        'failure_type', 'failure_detail', 'cleanup_failure_type', 'report_failure_type',
        'elapsed_seconds', 'cardinality', 'review_signals', 'explain_archive') if key in report}
    result['status'] = 'FAILED'
    result['measurements'] = []
    for entry in report.get('measurements', [])[:11]:
        item = {key: entry[key] for key in ('case', 'upstream_median_ms', 'candidate_median_ms', 'delta_ms', 'ratio', 'review_signal') if key in entry}
        item['samples'] = {variant: [{key: sample[key] for key in ('execution_ms', 'planning_ms', 'psql_wall_ms', 'plan_id') if key in sample}
                                    for sample in entry.get('samples', {}).get(variant, [])[:3]] for variant in ('upstream', 'candidate')}
        result['measurements'].append(item)
    return result


def write_reports(report, plans, output):
    """Return a reporting error; do not mask the primary database/cleanup error.

    Full plans have separate raw/gzip limits. Metrics remain in the small summary.
    Even an unwritable disk leaves a bounded FAILED summary in the CI log.
    """
    failure = None
    try:
        raw = compact_json({'schema': 'listmonk-ab-selection-plans-v1', 'plans': plans}, PLAN_RAW_LIMIT)
        zipped = gzip.compress(raw, mtime=0)
        build.require(len(zipped) <= PLAN_GZIP_LIMIT, 'Compressed plan byte limit exceeded')
        output.parent.mkdir(parents=True, exist_ok=True)
        target = plan_path(output)
        with target.open('xb') as stream:
            stream.write(zipped)
        report['explain_archive'] = {'file': target.name, 'plans': len(plans), 'raw_bytes': len(raw),
                                     'gzip_bytes': len(zipped), 'sha256': build.sha(zipped),
                                     'raw_limit_bytes': PLAN_RAW_LIMIT, 'gzip_limit_bytes': PLAN_GZIP_LIMIT}
    except Exception as exc:
        failure = exc
        report['status'] = 'FAILED'
        report['report_failure_type'] = type(exc).__name__
    try:
        encoded = compact_json(report, REPORT_LIMIT)
    except Exception as exc:
        failure = failure or exc
        report['status'] = 'FAILED'
        report['report_failure_type'] = type(exc).__name__
        encoded = compact_json(emergency_summary(report), REPORT_LIMIT)
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open('xb') as stream:
            stream.write(encoded)
    except Exception as exc:
        failure = failure or exc
        report['status'] = 'FAILED'
        report['report_failure_type'] = type(exc).__name__
    if failure or report['status'] == 'FAILED':
        print(compact_json(emergency_summary(report), REPORT_LIMIT).decode().strip())
    return failure


def run(folder, output):
    require_ci(os.environ)
    build.require(not output.exists() and not plan_path(output).exists(), 'Reports must be new files')
    db = Database(time.monotonic() + TIMEOUT)
    candidate, schema, manifest = load_candidate(folder)
    queries = load_queries(folder, candidate)
    identity, _ = db.json("SELECT json_build_object('db',current_database(),'user',current_user,'address',host(inet_server_addr()),'version',current_setting('server_version_num')::int,'objects',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'));", seconds=5)
    require_identity(identity)
    report = {'schema': 'listmonk-ab-selection-load-v1', 'status': 'FAILED', 'production_access': False,
              'database': DB_NAME, 'postgres_version': '17.10', 'candidate_sha256': manifest['candidate_binary_sha256'],
              'upstream_query_sha256': build.LOCK['query']['upstream_sha256'],
              'candidate_query_sha256': build.LOCK['query']['patched_sha256'],
              'cohort_limit': COHORT, 'batch_size': BATCH, 'samples_per_case': 3, 'deadline_seconds': TIMEOUT,
              'runtime_after': None, 'stage': 'schema', 'limitations': [
                  'Synthetic cardinality and distribution; not production capacity evidence.',
                  '100000 is the A/B cohort cap, not the total installation audience.',
                  'One SQL session at a time; concurrency 35 and worker instance count are not reproduced.',
                  'No SMTP, worker, HTTP or application cache execution.',
                  'Sequential shared-cache samples; not cold-cache measurements.',
                  'EXPLAIN binds fixed parameter literals; generic prepared-plan reuse is not reproduced.',
                  'Both query variants use the same installed A/B triggers; only the query delta is measured, not total installation overhead.',
                  'Allocation is explicit fixture membership; authorization is tested separately.',
                  'Observed settings do not prove in-memory overrides or deployment topology.']}
    initialized = False
    primary_error = None
    plans = []
    started = time.monotonic()
    try:
        db.sql(schema, seconds=30)
        for name in ('ab-experiment-core.sql', 'ab-experiment-selection.sql'):
            body = build.bounded_file(build.REPO / 'n8n/growth' / name, 1048576)
            db.sql(body.decode())
            report[name + '_sha256'] = build.sha(body)
        initialized = True
        build.require(db.sql('SELECT enabled FROM crm_ab_runtime_v2;')[0] == 'f', 'Migration must start OFF')
        report['stage'] = 'fixture'
        fixture = build.bounded_file(HERE / 'selection_load_fixture.sql', 65536)
        _, report['fixture_wall_ms'] = db.sql(fixture.decode(), seconds=90)
        report['fixture_sha256'] = build.sha(fixture)
        report['native_schema_sha256'] = build.sha(schema.encode())
        report['cardinality'], _ = db.json("SELECT json_build_object('subscribers',(SELECT count(*) FROM subscribers),'memberships',(SELECT count(*) FROM subscriber_lists),'campaigns',(SELECT count(*) FROM campaigns),'cohort',(SELECT count(*) FROM crm_ab_member_v2));")
        build.require(report['cardinality'] == {'subscribers': 250000, 'memberships': 1470000, 'campaigns': 153, 'cohort': COHORT}, 'Synthetic fixture cardinality mismatch')
        report['postgres_settings'], _ = db.json("SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN ('jit','work_mem','shared_buffers','max_parallel_workers_per_gather','effective_cache_size','random_page_cost','seq_page_cost');")
        report['stage'] = 'baseline_count'
        count_proof(db, queries, 'baseline', report)
        report['stage'] = 'baseline_pagination'
        set_proof(db, queries, 'baseline', report)
        report['stage'] = 'explain'
        report['measurements'] = []
        measure(db, queries, report, plans)
        report['review_signals'] = [item['case'] for item in report['measurements'] if item['review_signal']]
        report['stage'] = 'suppression'
        db.sql(SUPPRESSION)
        count_proof(db, queries, 'suppressed', report)
        report['stage'] = 'suppressed_pagination'
        set_proof(db, queries, 'suppressed', report)
        report['status'] = 'PASSED_SYNTHETIC_EQUIVALENCE_REVIEW_LATENCY'
        report['stage'] = 'complete'
    except Exception as exc:
        primary_error = exc
        report['failure_type'] = type(exc).__name__
        # Inputs and SQL are entirely synthetic. Keep diagnostic text bounded;
        # never serialize result rows, environment, config or recipient bodies.
        report['failure_detail'] = str(exc)[:2000]
    finally:
        try:
            if initialized:
                body, _ = db.sql('UPDATE crm_ab_runtime_v2 SET enabled=false; SELECT enabled FROM crm_ab_runtime_v2;', seconds=3, cleanup=True)
                build.require(body == 'f', 'Disposable runtime cleanup failed')
                report['runtime_after'] = 'OFF'
        except Exception as exc:
            primary_error = primary_error or exc
            report['status'] = 'FAILED'
            report['cleanup_failure_type'] = type(exc).__name__
        finally:
            report['elapsed_seconds'] = round(time.monotonic() - started, 3)
            try:
                report_error = write_reports(report, plans, output)
            except Exception as exc:
                # Last-resort primitive output survives even a malformed summary.
                report['status'] = 'FAILED'
                report_error = exc
                print(json.dumps({'status': 'FAILED', 'stage': report.get('stage'),
                                  'failure_type': type(primary_error or exc).__name__,
                                  'report_failure_type': type(exc).__name__, 'runtime_after': report.get('runtime_after')}))
            primary_error = primary_error or report_error
    if primary_error is not None:
        raise primary_error
    print(json.dumps({key: report[key] for key in ('status', 'cardinality', 'runtime_after', 'elapsed_seconds', 'review_signals')}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-dir', required=True, type=Path)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    run(args.artifact_dir, args.report)
