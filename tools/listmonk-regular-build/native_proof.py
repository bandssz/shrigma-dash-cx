#!/usr/bin/env python3
"""Run the guarded regular worker against disposable PG17 and loopback SMTP."""

import argparse
from email import policy
from email.parser import BytesParser
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import socketserver
import subprocess
import tempfile
import threading
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
LOCAL_ROOT = next((p for p in (REPO, *REPO.parents) if (p/'.private/test-tools').is_dir()), REPO)
LOCAL_RUNTIME = LOCAL_ROOT / '.private/runtime/crm-audience-runtime-20260929'
LOCAL_PG = LOCAL_ROOT / '.private/test-tools/pg17/node_modules/@embedded-postgres/darwin-arm64/native/bin'
LOCAL_SOURCE = LOCAL_RUNTIME / 'native-build/knadh-listmonk-1b5e8d3'
LOCAL_NODE_PATH = os.pathsep.join((str(LOCAL_ROOT/'.private/test-tools/pg17/node_modules'),
    str(LOCAL_ROOT/'.private/test-tools/node_modules')))
DB_NAME = 'listmonk'
TIMEOUT = 75
ADDRESS = re.compile(r'^(?:[a-z]+@example\.invalid|contato@(?:fishermans|oaristocrata)\.com(?:\.br)?)$', re.I)
NODE_DB = r'''const fs=require('fs'),{Client}=require('pg');(async()=>{const sql=fs.readFileSync(0,'utf8'),c=new Client({connectionString:process.env.TEST_DATABASE_URL,statement_timeout:15000});
await c.connect();try{const result=await c.query(sql),last=Array.isArray(result)?result[result.length-1]:result;
if(last&&last.rows&&last.rows.length){const row=last.rows[0],value=row[Object.keys(row)[0]];process.stdout.write(typeof value==='string'?value:JSON.stringify(value));}}
finally{await c.end();}})().catch(e=>{console.error(e.message);process.exit(1)});'''


def require(value, message):
    if not value:
        raise RuntimeError(message)


def sha(body):
    return hashlib.sha256(body).hexdigest()


class _SMTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


class _SMTPHandler(socketserver.StreamRequestHandler):
    def reply(self, value):
        self.wfile.write(value + b'\r\n')
        self.wfile.flush()

    def handle(self):
        self.request.settimeout(8)
        sender = None
        recipient = None
        self.reply(b'220 example.invalid native proof')
        while True:
            try:
                line = self.rfile.readline(1024)
            except socket.timeout:
                return
            if not line:
                return
            require(len(line) <= 1024 and line.endswith(b'\r\n'), 'Invalid SMTP command framing')
            command = line[:-2].decode('ascii')
            upper = command.upper()
            if upper.startswith('EHLO '):
                self.wfile.write(b'250-example.invalid\r\n250-SIZE 65536\r\n250 8BITMIME\r\n')
                self.wfile.flush()
            elif upper.startswith('MAIL FROM:'):
                match = re.search(r'<([^<>]+)>', command)
                require(match and ADDRESS.fullmatch(match.group(1)), 'Unsafe SMTP sender')
                sender = match.group(1).lower()
                self.reply(b'250 sender accepted')
            elif upper.startswith('RCPT TO:'):
                match = re.search(r'<([^<>]+)>', command)
                require(sender and match and ADDRESS.fullmatch(match.group(1)), 'Unsafe SMTP recipient')
                recipient = match.group(1).lower()
                self.reply(b'250 recipient accepted')
            elif upper == 'DATA':
                require(sender and recipient, 'SMTP envelope incomplete')
                self.reply(b'354 end data')
                raw = bytearray()
                while True:
                    row = self.rfile.readline(65539)
                    require(row and len(raw) + len(row) <= 65536, 'SMTP payload limit')
                    if row == b'.\r\n':
                        break
                    if row.startswith(b'..'):
                        row = row[1:]
                    raw.extend(row)
                self.server.capture(sender, recipient, bytes(raw))
                if recipient == 'aristo@example.invalid':
                    self.request.shutdown(socket.SHUT_RDWR)
                    return
                self.reply(b'250 captured')
                sender = recipient = None
            elif upper == 'RSET':
                sender = recipient = None
                self.reply(b'250 reset')
            elif upper == 'QUIT':
                self.reply(b'221 bye')
                return
            else:
                self.reply(b'502 unsupported')


class NativeSMTP:
    def __init__(self):
        self.messages = []
        self.lock = threading.Lock()
        self.server = _SMTPServer(('127.0.0.1', 0), _SMTPHandler)
        self.server.capture = self.capture
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def capture(self, sender, recipient, raw):
        parsed = BytesParser(policy=policy.default).parsebytes(raw)
        with self.lock:
            require(len(self.messages) < 8, 'SMTP message limit')
            self.messages.append({'sender': sender, 'recipient': recipient, 'raw_sha256': sha(raw),
                'dispatch_id': parsed.get('X-Crm-Dispatch-Id'), 'ses_tags': parsed.get('X-Ses-Message-Tags'),
                'configuration_sets': parsed.get_all('X-SES-Configuration-Set', []),
                'subject': parsed.get('Subject'), 'body': parsed.get_body(preferencelist=('html','plain')).get_content()})

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def clean_env(extra=None):
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C.UTF-8', 'TZ': 'UTC'}
    if extra:
        env.update(extra)
    return env


def config(port, http_port):
    return f'''[app]\naddress="127.0.0.1:{http_port}"\n[db]\nhost="127.0.0.1"\nport={port}\nuser="crm_shadow"\npassword="synthetic-local-placeholder"\ndatabase="listmonk"\nssl_mode="disable"\nmax_open=5\nmax_idle=5\nmax_lifetime="60s"\n'''


def settings_sql(smtp_port, http_port):
    smtp = [{'enabled': True, 'host': '127.0.0.1', 'port': smtp_port, 'auth_protocol': 'none',
        'username': '', 'password': '', 'hello_hostname': 'example.invalid', 'max_conns': 1,
        'idle_timeout': '2s', 'wait_timeout': '2s', 'max_msg_retries': 0, 'tls_type': 'none',
        'tls_skip_verify': False, 'email_headers': {}}]
    values = {'smtp': smtp, 'app.root_url': f'http://127.0.0.1:{http_port}',
        'app.from_email': 'Smoke <smoke@example.invalid>', 'app.check_updates': False,
        'app.notify_emails': [], 'app.enable_public_archive': False,
        'app.enable_public_subscription_page': False, 'app.send_optin_confirmation': False,
        'app.concurrency': 2, 'app.message_rate': 20, 'app.batch_size': 1,
        'app.max_send_errors': 1, 'app.cache_slow_queries': False,
        'privacy.individual_tracking': False, 'privacy.disable_tracking': False,
        'privacy.unsubscribe_header': False, 'bounce.enabled': False, 'bounce.mailboxes': [],
        'messengers': []}
    return '\n'.join("UPDATE settings SET value='" + json.dumps(v, separators=(',', ':')).replace("'", "''") +
        "'::jsonb WHERE key='" + k + "';" for k, v in values.items())


def run(binary, report_path, pg_bin=LOCAL_PG, source_dir=LOCAL_SOURCE,
        runtime_dir=LOCAL_RUNTIME, node_path=LOCAL_NODE_PATH):
    require(os.environ.get('REGULAR_NATIVE_PROOF_ISOLATED') == '1', 'Explicit isolated opt-in required')
    require(binary.is_file() and not binary.is_symlink(), 'Candidate binary required')
    require(not report_path.exists(), 'Report path must be new')
    require(pg_bin.is_dir() and pg_bin.joinpath('postgres').is_file(), 'Pinned PostgreSQL 17 runtime unavailable')
    require(source_dir.is_dir() and source_dir.joinpath('schema.sql').is_file(), 'Official native schema unavailable')
    require(runtime_dir.is_dir() and not runtime_dir.is_symlink(), 'Private runtime directory unavailable')
    require(isinstance(node_path,str) and node_path and all(Path(p).is_dir() for p in node_path.split(os.pathsep)),
        'Node module path unavailable')
    run_dir = Path(tempfile.mkdtemp(prefix='regular-native-', dir=runtime_dir))
    socket_root = Path('/private/tmp') if Path('/private/tmp').is_dir() else Path('/tmp')
    socket_dir = Path(tempfile.mkdtemp(prefix='regular-native-', dir=socket_root))
    data = run_dir / 'data'
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0)); db_port = probe.getsockname()[1]
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0)); http_port = probe.getsockname()[1]
    require(db_port != 5432, 'Default PostgreSQL port forbidden')
    def db(sql, database=DB_NAME):
        env = clean_env({'NODE_PATH': node_path,
            'TEST_DATABASE_URL': f'postgresql://crm_shadow@127.0.0.1:{db_port}/{database}'})
        result = subprocess.run(['node', '-e', NODE_DB],
            input=sql, text=True, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=35)
        require(len(result.stdout) + len(result.stderr) < 262144, 'Database output limit')
        if result.returncode:
            raise RuntimeError('Disposable database operation failed: ' + result.stderr[-5000:])
        return result.stdout.strip()

    started = False
    processes = []
    report = {'schema': 'segment-regular-native-proof-v1', 'status': 'FAILED',
        'local_disposable': True, 'production_changed': False, 'remote_hosts': 0,
        'query_sha256': '3dc9433187c4ee16f0516503c6cc3efae63e9a607f9a15748e52a43217c6f7de',
        'binary_sha256': sha(binary.read_bytes()), 'proof_directory': str(run_dir)}
    try:
        with (run_dir/'init.log').open('wb') as log:
            subprocess.run([str(pg_bin/'initdb'), '-D', str(data), '-U', 'crm_shadow', '--auth-local=trust',
                '--auth-host=trust', '--encoding=UTF8', '--locale=C', '--no-sync'], check=True,
                stdout=log, stderr=subprocess.STDOUT, timeout=30)
        with (run_dir/'lifecycle.log').open('wb') as log:
            subprocess.run([str(pg_bin/'pg_ctl'), '-D', str(data), '-l', str(run_dir/'server.log'),
                '-o', f'-h 127.0.0.1 -k {socket_dir} -p {db_port}', '-w', '-t', '15', 'start'],
                check=True, stdout=log, stderr=subprocess.STDOUT, timeout=20)
        started = True
        db('CREATE DATABASE listmonk;', 'postgres')
        native_schema = source_dir.joinpath('schema.sql').read_text()
        db(native_schema + "\nINSERT INTO settings(key,value) VALUES('migrations','[\"v6.1.0\"]');")
        with NativeSMTP() as smtp:
            db(settings_sql(smtp.port, http_port))
            config_path = run_dir/'config.toml'; config_path.write_text(config(db_port, http_port))
            node_env = clean_env({'NODE_PATH': node_path,
                'TEST_DATABASE_URL': f'postgresql://crm_shadow@127.0.0.1:{db_port}/listmonk',
                'CRM_AUDIENCE_TEST_ISOLATED': '1'})
            prepare = subprocess.run(['node', str(REPO/'tests/segment-regular-native-fixture.cjs'), 'prepare'],
                env=node_env, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=45)
            require(prepare.returncode == 0, 'Native fixture prepare failed: ' + prepare.stderr[-5000:])
            identity = subprocess.run([str(binary), '--config', str(config_path), '--crm-regular-identity'],
                cwd=run_dir, env=clean_env(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=30)
            require(identity.returncode == 0 and len(identity.stdout) < 262144, 'Identity mode failed')
            rows = [json.loads(line) for line in identity.stdout.splitlines() if line.startswith('{')]
            require(len(rows) == 1 and set(rows[0]) == {'worker_sha256','runtime_sha256'}, 'Identity output invalid')
            ident = rows[0]
            require(ident['worker_sha256'] == report['binary_sha256'] and re.fullmatch('[0-9a-f]{64}', ident['runtime_sha256']), 'Identity mismatch')
            active_env = dict(node_env, REGULAR_NATIVE_WORKER_SHA=ident['worker_sha256'], REGULAR_NATIVE_RUNTIME_SHA=ident['runtime_sha256'])
            activate = subprocess.run(['node', str(REPO/'tests/segment-regular-native-fixture.cjs'), 'activate'],
                env=active_env, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
            require(activate.returncode == 0, 'Native fixture activation failed: ' + activate.stderr[-5000:])
            def start_worker(label):
                log = (run_dir/f'{label}.log').open('wb')
                process = subprocess.Popen([str(binary), '--config', str(config_path)], cwd=run_dir,
                    env=clean_env(), stdout=log, stderr=subprocess.STDOUT)
                processes.append((process, log))
                return process

            worker = start_worker('worker-first')
            # The worker cannot scan before its first heartbeat transaction has
            # committed. Only then does this disposable administrative fixture
            # schedule bound campaigns through the operational guard.
            deadline = time.monotonic() + 20
            first_lease = None
            while time.monotonic() < deadline:
                require(worker.poll() is None, 'Native worker exited before heartbeat')
                raw = db("SELECT CASE WHEN EXISTS(SELECT 1 FROM crm_audience_v2.regular_worker_lease WHERE NOT suspended AND expires_at>clock_timestamp()) THEN json_build_object('instance_id',(SELECT instance_id::text FROM crm_audience_v2.regular_worker_lease),'catalogs',(SELECT json_object_agg(brand,expires_at>clock_timestamp()) FROM crm_audience_v2.config))::text ELSE '' END;")
                if raw:
                    first_lease = json.loads(raw)
                    break
                time.sleep(.1)
            require(first_lease and all(first_lease['catalogs'].values()), 'Initial heartbeat/catalog refresh unavailable')
            schedule = subprocess.run(['node', str(REPO/'tests/segment-regular-native-fixture.cjs'), 'schedule'],
                env=node_env, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
            require(schedule.returncode == 0, 'Native fixture scheduling failed: ' + schedule.stderr[-5000:])
            deadline = time.monotonic() + TIMEOUT
            state = None
            while time.monotonic() < deadline:
                require(worker.poll() is None, 'Native worker exited early')
                raw = db("SELECT json_build_object('campaigns',(SELECT json_agg(to_jsonb(x) ORDER BY id) FROM (SELECT id,status::text,sent,last_subscriber_id FROM campaigns WHERE id IN(100,200,300,400))x),'dispatch',(SELECT json_agg(to_jsonb(d) ORDER BY brand) FROM (SELECT dispatch_id::text,brand,transport_state,payload_sha256 FROM shrigma_email_dispatch)d),'controls',(SELECT json_agg(to_jsonb(r) ORDER BY campaign_id) FROM (SELECT campaign_id,enabled,suspended FROM crm_audience_v2.regular_delivery_campaign)r));")
                state = json.loads(raw)
                campaigns = {x['id']: x for x in state['campaigns']}
                dispatch = {x['brand']: x for x in state['dispatch'] or []}
                if campaigns[100]['status'] == 'finished' and campaigns[200]['status'] == 'paused' and campaigns[300]['status'] == 'finished' and campaigns[400]['status'] == 'paused' and dispatch.get('fish',{}).get('transport_state') == 'accepted' and dispatch.get('aristo',{}).get('transport_state') == 'outcome_unknown':
                    break
                time.sleep(.25)
            else:
                raise RuntimeError('Native worker proof timed out')
            worker.terminate(); worker.wait(timeout=8); processes.pop()[1].close()
            before = list(smtp.messages)
            require(len(before) == 3, 'Expected exactly three SMTP attempts')
            # A clean process replacement is allowed only after the previous
            # nonsuspended lease expires. The disposable fixture advances that
            # lease explicitly instead of waiting a production-length minute.
            db("UPDATE crm_audience_v2.regular_worker_lease SET heartbeat_at=clock_timestamp()-interval '61 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE NOT suspended;")
            restarted = start_worker('worker-restart')
            time.sleep(7)
            require(restarted.poll() is None, 'Restarted worker exited early')
            restarted.terminate(); restarted.wait(timeout=8); processes.pop()[1].close()
            require(smtp.messages == before, 'Unknown delivery replayed after restart')
            final = json.loads(db("SELECT json_build_object('campaigns',(SELECT json_agg(to_jsonb(x) ORDER BY id) FROM (SELECT id,status::text,sent,last_subscriber_id FROM campaigns WHERE id IN(100,200,300,400))x),'dispatch',(SELECT json_agg(to_jsonb(d) ORDER BY brand) FROM (SELECT dispatch_id::text,brand,transport_state,payload_sha256 FROM shrigma_email_dispatch)d),'controls',(SELECT json_agg(to_jsonb(r) ORDER BY campaign_id) FROM (SELECT campaign_id,enabled,suspended,acknowledged_sent,acknowledged_subscriber_id FROM crm_audience_v2.regular_delivery_campaign)r),'lease',(SELECT to_jsonb(l) FROM crm_audience_v2.regular_worker_lease l),'deployment',(SELECT to_jsonb(d) FROM crm_audience_v2.regular_worker_deployment d));"))
            messages = {m['recipient'].split('@')[0]: m for m in before}
            dispatch = {x['brand']: x for x in final['dispatch']}
            campaigns = {x['id']: x for x in final['campaigns']}
            controls = {x['campaign_id']: x for x in final['controls']}
            for brand in ('fish','aristo'):
                m=messages[brand]; d=dispatch[brand]
                expected_sender = 'contato@fishermans.com.br' if brand == 'fish' else 'contato@oaristocrata.com'
                require(m['sender']==expected_sender and m['dispatch_id']==d['dispatch_id'], 'Envelope/dispatch mismatch')
                require(m['raw_sha256']==d['payload_sha256'], 'Payload digest mismatch')
                require(f'crm_dispatch_id={d["dispatch_id"]}' in m['ses_tags'] and 'crm_test=false' in m['ses_tags'], 'Reserved SES tags missing')
                require(m['configuration_sets']==['native-fixture'], 'Private configuration set was not unique in final bytes')
                require('@TrackLink' not in m['body'] and '/link/' in m['body'], 'Panel TrackLink material was not rendered')
            require(campaigns[100]['status']=='finished' and campaigns[100]['sent']==1 and campaigns[100]['last_subscriber_id']==1, 'Fish accepted checkpoint mismatch')
            require(campaigns[200]['status']=='paused' and campaigns[200]['sent']==0 and campaigns[200]['last_subscriber_id']==0 and controls[200]['suspended'], 'Aristo unknown state mismatch')
            legacy=messages['legacy']
            require(legacy['sender']=='smoke@example.invalid' and legacy['subject']=='Native Legacy', 'Legacy envelope changed')
            require('legacy@example.invalid' in legacy['body'].lower(), 'Legacy rendered body changed')
            require(legacy['dispatch_id'] is None and legacy['ses_tags'] is None, 'Legacy message received guarded metadata')
            require(campaigns[300]['status']=='finished' and campaigns[300]['sent']==1 and campaigns[300]['last_subscriber_id']==3, 'Legacy checkpoint mismatch')
            require(campaigns[400]['status']=='paused' and campaigns[400]['sent']==0 and campaigns[400]['last_subscriber_id']==0, 'Invalid bound campaign was not quarantined')
            require(len(final['dispatch'])==2 and len(final['controls'])==3, 'Unexpected guarded state cardinality')
            require(final['lease']['instance_id']!=first_lease['instance_id'] and not final['lease']['suspended'], 'Expired lease was not replaced safely')
            report.update({'status':'PASSED_EPHEMERAL_ONLY_NOT_DEPLOYED','postgres_version':db("SHOW server_version;"),
                'identity':ident,'native_schema_sha256':sha(native_schema.encode()),'smtp_attempts':before,
                'state':final,'accepted_finish':True,'ack_lost_unknown':True,'restart_no_replay':True,
                'payload_digest_matches_bytes':True,'reserved_tags_match_dispatch':True,
                'private_configuration_set_unique_and_claimed':True,
                'panel_campaign_prepare_tracklink_rendered':True,
                'unbound_legacy_preserved':True,'invalid_bound_quarantined_without_scan_block':True,
                'initial_heartbeat_committed_before_bound_schedule':True,'native_catalog_refresh':True,
                'expired_nonsuspended_lease_replaced':True,'local_worker_concurrency':2,
                'sql_sha256':{name:sha((REPO/'n8n/growth'/name).read_bytes()) for name in (
                    'segment-regular-delivery.sql','segment-regular-worker-lease.sql','segment-regular-operation-guard.sql')}})
    finally:
        for process, log in processes:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=5)
            log.close()
        if started:
            with (run_dir/'lifecycle.log').open('ab') as log:
                stopped = subprocess.run([str(pg_bin/'pg_ctl'), '-D', str(data), '-m', 'fast', '-w', '-t', '15', 'stop'],
                    stdout=log, stderr=subprocess.STDOUT, timeout=20)
            report['cluster_stopped'] = stopped.returncode == 0
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
        try: socket_dir.rmdir()
        except OSError: pass
    print(json.dumps({'status':report['status'],'cluster_stopped':report.get('cluster_stopped'),
        'binary_sha256':report['binary_sha256']}))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary',required=True,type=Path)
    parser.add_argument('--report',required=True,type=Path)
    parser.add_argument('--pg-bin',type=Path,default=LOCAL_PG)
    parser.add_argument('--source-dir',type=Path,default=LOCAL_SOURCE)
    parser.add_argument('--runtime-dir',type=Path,default=LOCAL_RUNTIME)
    parser.add_argument('--node-path',default=LOCAL_NODE_PATH)
    args=parser.parse_args()
    run(args.binary.resolve(),args.report.resolve(),args.pg_bin.resolve(),args.source_dir.resolve(),
        args.runtime_dir.resolve(),args.node_path)
