#!/usr/bin/env python3
"""Bounded, synthetic CI-only proof of the actual worker's checkpoint limitations.

No deployment or arbitrary endpoints. Each scenario owns a new disposable database.
The original executable is started only after candidate exit, OFF and terminal arms.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tarfile
import tempfile
import threading
import time

import build
import worker_smoke as smoke
from smtp_capture import CaptureSMTP

DATABASES = ('ab_worker_recovery_optout', 'ab_worker_recovery_restart')
TEST_ID = '00000000-0000-4000-8000-000000000002'
WINDOW_SECONDS = 50
COHORT = {'AB-A': set(range(1, 13)), 'AB-B': set(range(13, 25))}


class GatedSMTP(CaptureSMTP):
    """Pause the first complete DATA before recording/250; never call this delivery."""
    def __init__(self):
        super().__init__()
        self.entered = threading.Event()
        self.release = threading.Event()
        self.abort = threading.Event()
        self.attempted = None
        self._gate_lock = threading.Lock()

    def _record(self, sender, recipients, raw):
        with self._gate_lock:
            first = self.attempted is None
            if first:
                self.attempted = tuple(recipients)
        if first:
            self.entered.set()
            if not self.release.wait(8):
                self._error('synthetic_gate_timeout')
                raise ConnectionAbortedError('Synthetic gate deadline')
            if self.abort.is_set():
                # Process was killed before SMTP acceptance; no receipt is invented.
                raise ConnectionAbortedError('Synthetic interrupted transaction')
        return super()._record(sender, recipients, raw)

    def __exit__(self, *args):
        self.abort.set()
        self.release.set()
        return super().__exit__(*args)


def db(database, sql):
    build.require(database in (*DATABASES, 'postgres'), 'Only fixed disposable databases are allowed')
    r = subprocess.run(['psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
                        '-h', '127.0.0.1', '-p', '5432', '-U', 'synthetic', '-d', database],
                       input="SET statement_timeout='15s';\n" + sql, text=True,
                       env=smoke.clean_env(), capture_output=True, timeout=30)
    build.require(len(r.stdout) + len(r.stderr) < 262144, 'Disposable database output limit')
    if r.returncode:
        raise RuntimeError('Disposable database operation failed: ' + r.stderr[-5000:])
    return r.stdout.strip()


def require_ci(env):
    build.require(env.get('AB_WORKER_RECOVERY_ISOLATED') == '1', 'Explicit recovery CI isolation required')
    smoke.require_ci({**env, 'AB_WORKER_SMOKE_ISOLATED': '1'})


def protocol():
    return {'contract': 'crm-ab-email-v2', 'test_id': TEST_ID, 'brand': 'fish', 'channel': 'email',
            'name': 'Synthetic recovery', 'hypothesis': 'Checkpoint loss never implies a winner',
            'arms': [{'arm': 'a', 'campaign_id': 1, 'expected_version': 'synthetic-a'},
                     {'arm': 'b', 'campaign_id': 2, 'expected_version': 'synthetic-b'}],
            'allocation': {'method': 'random-permutation-v1', 'a_basis_points': 5000},
            'rule': {'method': 'fisher-two-sided-fixed-window-v1', 'metric': 'unique_tracked_click_per_allocated',
                     'window_hours': 24, 'minimum_per_arm': 1, 'minimum_effect_pp': 1, 'alpha': 0.05}}


def fixture():
    p = json.dumps(protocol()).replace("'", "''")
    return f'''BEGIN;
INSERT INTO templates(id,name,subject,body,is_default) VALUES(1,'Synthetic','','{{{{ template "content" . }}}}',true);
INSERT INTO lists(id,uuid,name,type,optin,tags) VALUES(1,gen_random_uuid(),'Synthetic original','private','double',ARRAY['fish']);
INSERT INTO subscribers(id,uuid,email,name) SELECT n,gen_random_uuid(),'s'||lpad(n::text,3,'0')||'@example.invalid','Synthetic '||n FROM generate_series(1,24)n;
INSERT INTO subscriber_lists(subscriber_id,list_id,status) SELECT n,1,'confirmed' FROM generate_series(1,24)n;
INSERT INTO campaigns(id,uuid,name,subject,from_email,body,content_type,status,send_at,messenger,template_id)
SELECT id,gen_random_uuid(),subject,subject,'Smoke <smoke@example.invalid>',
 '<p>{{{{ .Subscriber.Email }}}}</p><a href="{{{{ UnsubscribeURL }}}}">Unsubscribe</a>',
 'html','scheduled',clock_timestamp()-interval '1 minute','email',1 FROM (VALUES(1,'AB-A'),(2,'AB-B'))c(id,subject);
INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(1,1,'Synthetic original'),(2,1,'Synthetic original');
UPDATE crm_ab_runtime_v2 SET enabled=true,native_query_sha256='{build.LOCK['query']['patched_sha256']}',verified_at=clock_timestamp();
WITH moment AS(SELECT date_trunc('milliseconds',clock_timestamp()) t)
INSERT INTO crm_ab_experiment_v2(test_id,brand,protocol,source_list_ids,state,window_start,window_end,transport_bound,tracking_continuous)
SELECT '{TEST_ID}','fish','{p}',ARRAY[1],'scheduled',t-interval '24 hours'+interval '{WINDOW_SECONDS} seconds',t+interval '{WINDOW_SECONDS} seconds',true,true FROM moment;
INSERT INTO crm_ab_arm_v2(test_id,arm,campaign_id,campaign_version,allocated_count)
VALUES('{TEST_ID}','a',1,'synthetic-a',12),('{TEST_ID}','b',2,'synthetic-b',12);
INSERT INTO crm_ab_member_v2(test_id,subscriber_id,arm) SELECT '{TEST_ID}',n,CASE WHEN n<=12 THEN 'a' ELSE 'b' END FROM generate_series(1,24)n;
COMMIT;'''


def original_binary(folder):
    entry = build.LOCK['releases']['linux_amd64']
    path = folder / 'listmonk-6.1.0-crm-ab-candidate-linux_amd64.tar.gz'
    with tarfile.open(path, 'r:gz') as archive:
        member = archive.getmember('rollback/' + entry['name'])
        build.require(member.isfile() and member.size == entry['bytes'], 'Invalid rollback archive')
        with archive.extractfile(member) as src:
            body = src.read(entry['bytes'] + 1)
    build.require(build.sha(body) == entry['sha256'], 'Rollback hash differs from published lock')
    return build.release_files(body)['listmonk']


class Scenario:
    def __init__(self, database, work, candidate, schema):
        self.database, self.work = database, work
        self.process = None
        self.log = None
        self.starts = 0
        build.require(db('postgres', "SELECT current_user;") == 'synthetic', 'Expected synthetic service role')
        build.require(db('postgres', "SELECT count(*) FROM pg_database WHERE datname='" + database + "';") == '0', 'Recovery database must not already exist')
        db('postgres', 'CREATE DATABASE ' + database + ';')
        build.require(db(database, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public';") == '0', 'Expected empty public schema')
        db(database, schema + "\nINSERT INTO settings(key,value) VALUES('migrations','[\"v6.1.0\"]');")
        for name in ('ab-experiment-core.sql', 'ab-experiment-selection.sql'):
            db(database, (build.REPO / 'n8n/growth' / name).read_text())
        build.require(db(database, 'SELECT enabled FROM crm_ab_runtime_v2;') == 'f', 'SQL must begin OFF')
        self.binary = work / 'candidate'
        self.binary.write_bytes(candidate)
        self.binary.chmod(0o700)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.http_port = sock.getsockname()[1]
        self.config = work / 'config.toml'
        self.config.write_text(smoke.native_config(self.http_port).replace('database="ab_worker_smoke"', 'database="' + database + '"'))

    def configure(self, smtp):
        db(self.database, smoke.configure_smtp(smtp.port, self.http_port) + "\nUPDATE settings SET value='2' WHERE key='app.message_rate';")

    def start(self, binary=None):
        build.require(self.process is None or self.process.poll() is not None, 'Never run two emitters')
        self.starts += 1
        self.log = (self.work / ('worker-' + str(self.starts) + '.log')).open('wb')
        self.process = subprocess.Popen([str(binary or self.binary), '--config', str(self.config)], cwd=self.work,
                                        env=smoke.clean_env(), stdout=self.log, stderr=subprocess.STDOUT)

    def stop(self, abrupt=False):
        if self.process and self.process.poll() is None:
            self.process.kill() if abrupt else self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        if self.log:
            self.log.close()
            self.log = None

    def check(self):
        build.require(self.process is not None and self.process.poll() is None, 'Worker exited early')
        build.require(self.log.tell() < 1048576, 'Worker log limit')

    def rows(self):
        return json.loads(db(self.database, "SELECT json_agg(r ORDER BY id) FROM (SELECT id,subject,status,sent,to_send,last_subscriber_id FROM campaigns)r;"))

    def finish(self, deadline=30):
        end = time.monotonic() + deadline
        while time.monotonic() < end:
            self.check()
            rows = self.rows()
            if all(r['status'] == 'finished' for r in rows):
                return rows
            time.sleep(.2)
        raise RuntimeError('Worker did not finish in bounded scenario')

    def mature_result(self):
        end = time.monotonic() + WINDOW_SECONDS + 5
        while time.monotonic() < end:
            source = json.loads(db(self.database, "SELECT public.crm_ab_measure_v2('" + TEST_ID + "');"))
            if source['as_of'] >= source['window_end']:
                break
            time.sleep(.5)
        else:
            raise RuntimeError('Synthetic evidence window did not close')
        command = "const fs=require('node:fs'),AB=require(process.argv[1]),s=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(AB.result(s.protocol,s)));"
        result = subprocess.run(['node', '-e', command, str(build.REPO / 'growth-ab-experiment-contract.js')],
                                input=json.dumps(source), text=True, capture_output=True, check=True, timeout=10)
        value = json.loads(result.stdout)
        build.require(value['status'] == 'inconclusive' and value['reason'] == 'transport_not_fully_accounted'
                      and value['winner'] is None and value['can_declare_winner'] is False
                      and value['automatic_send'] is False, 'Deficit must never produce a winner')
        build.require([a['allocated'] for a in value['arms']] == [12, 12], 'Frozen denominator changed')
        return {'source': source, 'result': value}

    def cleanup(self):
        self.stop()
        db(self.database, 'UPDATE crm_ab_runtime_v2 SET enabled=false;')
        build.require(db(self.database, 'SELECT enabled FROM crm_ab_runtime_v2;') == 'f', 'Cleanup must end OFF')


def captured_sets(messages):
    out = {'AB-A': set(), 'AB-B': set()}
    for m in messages:
        build.require(m['sender'] == 'smoke@example.invalid' and len(m['recipients']) == 1, 'Unexpected envelope')
        address, subject = m['recipients'][0], m['subject']
        build.require(subject in out and address.endswith('@example.invalid'), 'Unexpected campaign/domain')
        sid = int(address.split('@')[0][1:])
        build.require(address == 's%03d@example.invalid' % sid and sid in COHORT[subject], 'Wrong arm')
        build.require(sid not in out[subject], 'Duplicate send')
        build.require(address in m['body'], 'Native personalization missing')
        out[subject].add(sid)
    build.require(out['AB-A'].isdisjoint(out['AB-B']), 'Cross-arm duplicate')
    return out


def wait_gate(scenario, smtp):
    end = time.monotonic() + 12
    while time.monotonic() < end:
        scenario.check()
        if smtp.entered.wait(.1):
            # The worker may have prefetched buffered rows. Observe the persisted
            # boundary, do not assume that only the first SMTP row was selected.
            rows = scenario.rows()
            build.require(not smtp.messages and not smtp.errors, 'No message should be accepted before release')
            build.require(any(r['last_subscriber_id'] > 0 for r in rows), 'Expected selected checkpoint before SMTP acceptance')
            return rows
    raise RuntimeError('SMTP gate was not reached')


def optout_case(scenario):
    with GatedSMTP() as smtp:
        scenario.configure(smtp)
        db(scenario.database, fixture())
        scenario.start()
        before = wait_gate(scenario, smtp)
        build.require(next(r['last_subscriber_id'] for r in before if r['subject'] == 'AB-B') < 24, 'Opt-out must be beyond selected batch')
        db(scenario.database, "UPDATE subscriber_lists SET status='unsubscribed' WHERE subscriber_id=24;")
        build.require(db(scenario.database, "SELECT status FROM subscriber_lists WHERE subscriber_id=24;") == 'unsubscribed', 'Opt-out must commit before gate release')
        smtp.release.set()
        after = scenario.finish()
        actual = captured_sets(smtp.messages)
        build.require(actual == {'AB-A': COHORT['AB-A'], 'AB-B': COHORT['AB-B'] - {24}} and not smtp.errors, 'Next-batch opt-out was not preserved')
        build.require([r['sent'] for r in after] == [12, 11], 'Opt-out native sent counts differ')
        result = scenario.mature_result()
        return {'checkpoint_before_optout': before, 'campaigns_after': after, 'captured': {'AB-A': 12, 'AB-B': 11},
                'suppressed_subscriber_id': 24, 'evaluation': result}


def restart_case(scenario):
    with GatedSMTP() as gate:
        scenario.configure(gate)
        db(scenario.database, fixture())
        scenario.start()
        selected = wait_gate(scenario, gate)
        scenario.stop(abrupt=True)
        # Read the durable boundary AFTER the process is dead; any additional
        # prefetch before SIGKILL belongs to the lost in-memory batch too.
        stopped = scenario.rows()
        gate.abort.set()
        gate.release.set()
        build.require(not gate.messages, 'Interrupted DATA must not be counted as accepted SMTP')
    checkpoints = {r['subject']: r['last_subscriber_id'] for r in stopped}
    build.require(any(checkpoints.values()) and all(r['sent'] == 0 for r in stopped), 'Expected selected-but-unaccepted deficit')
    expected = {s: {n for n in ids if n > checkpoints[s]} for s, ids in COHORT.items()}
    build.require(any(expected.values()), 'Fixture must retain work after the crash')
    with CaptureSMTP() as smtp:
        scenario.configure(smtp)
        scenario.start()
        after = scenario.finish()
        actual = captured_sets(smtp.messages)
        build.require(actual == expected and not smtp.errors, 'Restart replayed or crossed the persisted checkpoint')
        build.require(sum(len(v) for v in actual.values()) < 24, 'Crash must expose a transport deficit')
        build.require(all(r['sent'] == len(actual[r['subject']]) for r in after), 'Native counters differ from captured sends')
        result = scenario.mature_result()
        return {'checkpoint_at_gate': selected, 'checkpoint_after_kill': stopped, 'campaigns_after_restart': after,
                'accepted_before_kill': 0, 'captured_after_restart': {s: len(v) for s, v in actual.items()},
                'lost_selected_count': 24 - sum(map(len, actual.values())), 'evaluation': result}


def rollback_case(scenario, upstream):
    scenario.stop()
    db(scenario.database, 'UPDATE crm_ab_runtime_v2 SET enabled=false;')
    arms = json.loads(db(scenario.database, "SELECT json_agg(json_build_object('id',c.id,'status',c.status) ORDER BY c.id) FROM campaigns c JOIN crm_ab_arm_v2 a ON a.campaign_id=c.id;"))
    build.require(len(arms) == 2 and all(a['status'] in ('finished', 'cancelled') for a in arms), 'Remove executable arms before rollback')
    build.require(scenario.process.poll() is not None and db(scenario.database, 'SELECT enabled FROM crm_ab_runtime_v2;') == 'f', 'Candidate must be dead and runtime OFF before rollback')
    binary = scenario.work / 'original-rollback'
    binary.write_bytes(upstream)
    binary.chmod(0o700)
    with CaptureSMTP() as smtp:
        scenario.configure(smtp)
        db(scenario.database, '''BEGIN;
INSERT INTO lists(id,uuid,name,type,optin) VALUES(99,gen_random_uuid(),'Rollback synthetic only','private','double');
INSERT INTO subscribers(id,uuid,email,name) SELECT n,gen_random_uuid(),'s'||lpad(n::text,3,'0')||'@example.invalid','Synthetic rollback' FROM generate_series(101,102)n;
INSERT INTO subscriber_lists(subscriber_id,list_id,status) VALUES(101,99,'confirmed'),(102,99,'confirmed');
INSERT INTO campaigns(id,uuid,name,subject,from_email,body,content_type,status,send_at,messenger,template_id)
VALUES(3,gen_random_uuid(),'ROLLBACK-CONTROL','ROLLBACK-CONTROL','Smoke <smoke@example.invalid>','<p>{{ .Subscriber.Email }}</p>','html','scheduled',clock_timestamp()-interval '1 minute','email',1);
INSERT INTO campaign_lists(campaign_id,list_id,list_name) VALUES(3,99,'Rollback synthetic only');
COMMIT;''')
        scenario.start(binary)
        rows = scenario.finish()
        messages = smtp.messages
        build.require(len(messages) == 2 and {m['subject'] for m in messages} == {'ROLLBACK-CONTROL'} and not smtp.errors, 'Rollback must not execute A/B arms')
        build.require({m['recipients'][0] for m in messages} == {'s101@example.invalid', 's102@example.invalid'}, 'Rollback control recipients differ')
        build.require(rows[2]['sent'] == 2 and rows[2]['status'] == 'finished', 'Rollback ordinary worker did not complete')
        return {'preconditions': {'candidate_exited': True, 'runtime': 'OFF', 'arms': arms},
                'upstream_binary_sha256': build.sha(upstream), 'ordinary_captured': 2, 'ab_captured': 0}


def run(folder, report_path):
    require_ci(os.environ)
    build.require(not report_path.exists(), 'Report must be new')
    candidate, schema, manifest = smoke.load_candidate(folder)
    original = original_binary(folder)
    report = {'schema': 'listmonk-ab-worker-recovery-v1', 'status': 'FAILED', 'production_access': False,
              'candidate_sha256': manifest['candidate_binary_sha256'], 'native_query_sha256': build.LOCK['query']['patched_sha256'],
              'runtime_outside_runner': 'OFF', 'recipient_domain': 'example.invalid', 'smtp_forwarding': False,
              'window_fixture': '24-hour synthetic window ending 50 seconds after fixture creation; actual as_of, counts and end retained',
              'test_settings': {'batch_size': 1, 'concurrency': 1, 'message_rate': 2},
              'limits': ['Small deterministic fixture is not representative load: operational settings reported separately are batch_size=1000, concurrency=35, message_rate=1',
                         'Suppression is proven only before the next native SELECT, not for already buffered contacts',
                         'The native worker can lose selected in-memory messages after a crash; the test proves honest inconclusive reporting, not exactly-once delivery',
                         'Rollback proof requires candidate exit, both arms terminal and runtime OFF; it does not authorize operational rollback']}
    with tempfile.TemporaryDirectory(prefix='ab-worker-recovery-') as tmp:
        try:
            for mode, database in zip(('optout', 'restart'), DATABASES):
                work = Path(tmp) / mode
                work.mkdir()
                scenario = Scenario(database, work, candidate, schema)
                try:
                    report[mode] = optout_case(scenario) if mode == 'optout' else restart_case(scenario)
                    if mode == 'restart':
                        report['rollback'] = rollback_case(scenario, original)
                finally:
                    scenario.cleanup()
            report['status'] = 'PASSED_EPHEMERAL_ONLY_NOT_DEPLOYED'
            report['runtime_after'] = 'OFF'
        except Exception:
            for log in Path(tmp).rglob('*.log'):
                print(log.name + ': ' + log.read_bytes()[-4000:].decode(errors='replace'))
            raise
        finally:
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'optout_captured': report['optout']['captured'],
                      'restart_captured': report['restart']['captured_after_restart'],
                      'lost_selected_count': report['restart']['lost_selected_count'],
                      'results': [report[m]['evaluation']['result']['reason'] for m in ('optout', 'restart')],
                      'rollback': report['rollback'], 'runtime_after': 'OFF'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-dir', required=True, type=Path)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    run(args.artifact_dir.resolve(), args.report.resolve())
