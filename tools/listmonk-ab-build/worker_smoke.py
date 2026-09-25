#!/usr/bin/env python3
"""Real worker rehearsal, ONLY in an explicitly opted-in ephemeral GitHub Linux runner.

No arbitrary database URL, config, credentials or recipients are accepted. Uses the
native schema from the verified artifact, synthetic fixtures and loopback SMTP.
"""
import argparse
import collections
import json
import os
from pathlib import Path
import socket
import subprocess
import tarfile
import tempfile
import time

import build
from smtp_capture import CaptureSMTP

HERE = Path(__file__).resolve().parent
DB_NAME = 'ab_worker_smoke'
EXPECTED = {'AB-A': {1, 13}, 'AB-B': {2, 14}, 'CONTROL': {1, 2, 7, 8, 11, 12, 13, 14, 15, 16}}
TIMEOUT = 120


def require_ci(env):
    build.require(env.get('GITHUB_ACTIONS') == 'true' and env.get('CI') == 'true'
                  and env.get('RUNNER_OS') == 'Linux' and env.get('RUNNER_ARCH') == 'X64'
                  and env.get('AB_WORKER_SMOKE_ISOLATED') == '1', 'Ephemeral amd64 CI opt-in required')
    build.require(not any(k.startswith(('LISTMONK_', 'PG')) for k in env), 'External service configuration forbidden')


def clean_env():
    return {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C.UTF-8', 'TZ': 'UTC'}


def db(sql):
    r = subprocess.run(['psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
                        '-h', '127.0.0.1', '-p', '5432', '-U', 'synthetic', '-d', DB_NAME],
                       input="SET statement_timeout='15s';\n" + sql, text=True, env=clean_env(),
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    build.require(len(r.stdout) + len(r.stderr) < 262144, 'Database output limit exceeded')
    if r.returncode:
        raise RuntimeError('Disposable database operation failed: ' + r.stderr[-6000:])
    return r.stdout.strip()


def load_candidate(folder):
    manifest = json.loads(build.bounded_file(folder / 'manifest.json', 262144))
    build.require(manifest['target'] == 'linux_amd64' and manifest['status'] == 'CANDIDATE_OFF_NOT_DEPLOYED', 'Expected OFF amd64 artifact')
    name = 'listmonk-6.1.0-crm-ab-candidate-linux_amd64.tar.gz'
    body = build.bounded_file(folder / name, build.LIMITS['artifact_bytes'])
    build.require((folder / 'SHA256SUMS').read_text() == build.sha(body) + '  ' + name + '\n', 'Artifact checksum mismatch')
    wanted = {'candidate/listmonk', 'manifest.json', 'rollback/' + build.LOCK['releases']['linux_amd64']['name']}
    found = {}
    with tarfile.open(folder / name, 'r:gz') as archive:
        for entry in archive:
            if entry.name not in wanted:
                continue
            build.require(entry.name not in found and entry.isfile() and entry.size <= build.LIMITS['binary_bytes'], 'Unsafe artifact member')
            with archive.extractfile(entry) as src:
                found[entry.name] = src.read(entry.size + 1)
            build.require(len(found[entry.name]) == entry.size, 'Truncated artifact')
    build.require(set(found) == wanted and json.loads(found['manifest.json']) == manifest, 'Artifact manifest mismatch')
    release = build.LOCK['releases']['linux_amd64']
    rollback = found['rollback/' + release['name']]
    build.require(len(rollback) == release['bytes'] and build.sha(rollback) == release['sha256'], 'Rollback hash mismatch')
    native = build.inspect_stuffed(build.release_files(rollback)['listmonk'])
    candidate = found['candidate/listmonk']
    build.require(build.sha(candidate) == manifest['candidate_binary_sha256'], 'Candidate hash mismatch')
    inspected = build.inspect_stuffed(candidate)
    build.compare(native, inspected)
    build.require(len(inspected['assets']) == 130, 'Expected complete asset set')
    return candidate, inspected['assets']['/schema.sql']['body'].decode(), manifest


def configure_smtp(port, http_port):
    smtp = [{'enabled': True, 'host': '127.0.0.1', 'port': port, 'auth_protocol': 'none',
             'username': '', 'password': '', 'hello_hostname': 'example.invalid',
             'max_conns': 1, 'idle_timeout': '2s', 'wait_timeout': '2s',
             'max_msg_retries': 0, 'tls_type': 'none', 'tls_skip_verify': False, 'email_headers': []}]
    settings = {'smtp': smtp, 'app.root_url': 'http://127.0.0.1:' + str(http_port),
                'app.from_email': 'Smoke <smoke@example.invalid>', 'app.check_updates': False,
                'app.notify_emails': [], 'app.enable_public_archive': False,
                'app.enable_public_subscription_page': False, 'app.send_optin_confirmation': False,
                'app.concurrency': 1, 'app.message_rate': 20, 'app.batch_size': 1,
                'app.max_send_errors': 1, 'app.cache_slow_queries': False,
                'privacy.individual_tracking': True, 'privacy.disable_tracking': False,
                'bounce.enabled': False, 'bounce.mailboxes': [], 'messengers': []}
    return '\n'.join("UPDATE settings SET value='" + json.dumps(v).replace("'", "''") + "'::jsonb WHERE key='" + k + "';" for k, v in settings.items())


def validate_delivery(messages, rows, errors):
    build.require(not errors, 'SMTP capture rejected an unexpected transaction')
    actual = collections.defaultdict(list)
    for m in messages:
        build.require(m['sender'] == 'smoke@example.invalid' and len(m['recipients']) == 1, 'Unexpected SMTP envelope')
        subject, recipient = m['subject'], m['recipients'][0]
        build.require(subject in EXPECTED, 'Unexpected campaign subject')
        allowed = {'s%03d@example.invalid' % n for n in EXPECTED[subject]}
        build.require(recipient in allowed, 'Recipient crossed a partition or suppression boundary')
        build.require(recipient in m['body'] and 'http://127.0.0.1:' in m['body'] and '/subscription/' in m['body'], 'Native personalization/unsubscribe context missing')
        actual[subject].append(recipient)
    for subject, ids in EXPECTED.items():
        expected = {'s%03d@example.invalid' % n for n in ids}
        build.require(set(actual[subject]) == expected and len(actual[subject]) == len(expected), 'Missing or duplicate native delivery')
    build.require(len(rows) == 3 and {r['subject'] for r in rows} == set(EXPECTED), 'Campaign result mismatch')
    for r in rows:
        expected = EXPECTED[r['subject']]
        build.require(r['status'] == 'finished' and r['sent'] == r['to_send'] == len(expected), 'Native campaign did not finish with exact counters')
        build.require(r['last_subscriber_id'] == max(expected), 'Native checkpoint did not traverse sparse IDs')
    build.require(set(actual['AB-A']).isdisjoint(actual['AB-B']), 'A/B overlap')
    return {subject: len(actual[subject]) for subject in EXPECTED}


def run(folder, output):
    require_ci(os.environ)
    build.require(not output.exists(), 'Report must be a new file')
    candidate, schema, manifest = load_candidate(folder)
    # Native schema.sql contains DROP statements. Refuse ANY populated public schema
    # before applying it; connection parameters are fixed to this local CI service.
    identity = json.loads(db("SELECT json_build_object('db',current_database(),'user',current_user,'address',host(inet_server_addr()),'objects',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'));"))
    build.require(identity['db'] == DB_NAME and identity['user'] == 'synthetic' and identity['objects'] == 0, 'Expected an empty disposable CI database')
    report = {'schema': 'listmonk-ab-worker-smoke-v1', 'status': 'FAILED', 'production_access': False,
              'native_query_sha256': build.LOCK['query']['patched_sha256'],
              'candidate_sha256': manifest['candidate_binary_sha256'], 'database': DB_NAME,
              'fixture': 'explicit-membership-worker-only', 'recipients_domain': 'example.invalid',
              'smtp_forwarding': False, 'runtime_after': None}
    process = None
    initialized = False
    with tempfile.TemporaryDirectory(prefix='ab-worker-smoke-') as tmp:
        work = Path(tmp)
        binary = work / 'listmonk'
        binary.write_bytes(candidate)
        binary.chmod(0o700)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            http_port = sock.getsockname()[1]
        config = work / 'config.toml'
        config.write_text(f'[app]\naddress="127.0.0.1:{http_port}"\n[db]\nhost="127.0.0.1"\nport=5432\nuser="synthetic"\npassword=""\ndatabase="{DB_NAME}"\nssl_mode="disable"\nmax_open=5\nmax_idle=5\nmax_lifetime="60s"\n')
        try:
            # Same schema + migration marker as upstream installSchema(), without
            # installer sample addresses or API users; this is not an installer test.
            db(schema + "\nINSERT INTO settings(key,value) VALUES('migrations','[\"v6.1.0\"]');")
            for name in ('ab-experiment-core.sql', 'ab-experiment-selection.sql'):
                source = build.REPO / 'n8n/growth' / name
                db(source.read_text())
                report[name + '_sha256'] = build.sha(source.read_bytes())
            initialized = True
            build.require(db('SELECT enabled FROM crm_ab_runtime_v2;') == 'f', 'Migration must start OFF')
            with CaptureSMTP() as smtp:
                db(configure_smtp(smtp.port, http_port))
                fixture = (HERE / 'worker_fixture.sql').read_text()
                db(fixture)
                report['fixture_sha256'] = build.sha(fixture.encode())
                report['native_schema_sha256'] = build.sha(schema.encode())
                with (work / 'worker.log').open('wb') as log:
                    process = subprocess.Popen([str(binary), '--config', str(config)], cwd=work, env=clean_env(), stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + TIMEOUT
                    while time.monotonic() < deadline:
                        build.require(process.poll() is None, 'Native worker exited before completion')
                        build.require(log.tell() < 1048576, 'Native worker log limit')
                        rows = json.loads(db("SELECT json_agg(x ORDER BY id) FROM (SELECT id,subject,status,sent,to_send,last_subscriber_id FROM campaigns) x;"))
                        if all(r['status'] == 'finished' for r in rows):
                            break
                        time.sleep(1)
                    else:
                        raise RuntimeError('Native worker exceeded 120-second deadline')
                    report['delivered'] = validate_delivery(smtp.messages, rows, smtp.errors)
                    report['campaigns'] = rows
                    report['status'] = 'PASSED_EPHEMERAL_ONLY_NOT_DEPLOYED'
        except Exception:
            log = work / 'worker.log'
            if log.exists():
                # Only synthetic data can reach this file; output is still bounded.
                print(log.read_bytes()[-6000:].decode(errors='replace'))
            raise
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            if initialized:
                db('UPDATE crm_ab_runtime_v2 SET enabled=false;')
                report['runtime_after'] = db('SELECT enabled FROM crm_ab_runtime_v2;')
                build.require(report['runtime_after'] == 'f', 'Disposable runtime cleanup failed')
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'delivered': report['delivered'], 'runtime_after': 'OFF'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-dir', required=True, type=Path)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    run(args.artifact_dir.resolve(), args.report.resolve())
