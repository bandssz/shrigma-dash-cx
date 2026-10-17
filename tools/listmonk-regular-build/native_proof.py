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


def isolated_source_receipt(report, profile):
    """Pure final receipt assembler; it never runs a proof or imports original acceptance."""
    require(profile is not None and profile.get('isolatedSourceProofAuthorized') is True
        and profile.get('isolatedProofAuthorized') is False
        and profile.get('isolatedProofAuthorization') is None,
        'Explicit source-functional purpose required')
    accepted = (report.get('status') == 'PASSED_EPHEMERAL_ONLY_NOT_DEPLOYED'
        and report.get('cluster_stopped') is True and report.get('workerProcessesEnded') is True
        and report.get('smtpServerEnded') is True and report.get('local_disposable') is True
        and report.get('production_changed') is False and report.get('remote_hosts') == 0
        and report.get('binary_sha256') == profile['binaryExpectedSha256']
        and report.get('query_sha256') == profile['querySha256']
        and report.get('batch_full_recipient_proof',{}).get('accepted') is True
        and report.get('batch_full_recipient_proof',{}).get('scope') == 'ephemeral-synthetic-running-campaigns'
        and report.get('batch_full_recipient_proof',{}).get('platform') == 'linux'
        and report.get('batch_full_recipient_proof',{}).get('architecture') == 'amd64'
        and report.get('batch_full_recipient_proof',{}).get('postgres_version') == '17.10'
        and report.get('batch_full_recipient_proof',{}).get('running_status_required_by_exact_query') is True
        and report.get('batch_full_recipient_proof',{}).get('production_operational') is False
        and all(report.get('batch_full_recipient_proof',{}).get(key) == profile[slot]
                for key,slot in [('binary_sha256','binaryExpectedSha256'),('query_sha256','querySha256'),
                    ('kernel_sha256','kernelSha256'),('worker_transaction_sha256','workerTransactionSha256'),
                    ('composed_recipient_query_sha256','composedRecipientQuerySha256')]))
    return {'schema':'shrigma-isolated-source-functional-proof-v1',
        'purpose':'isolated-source-functional','synthetic':True,'accepted':accepted,
        'fullSyntheticRecipientAccepted':accepted,'loopbackSMTPAccepted':accepted,
        'originalPerformanceAccepted':False,'originalOperational':False,'originalDispatchProved':False,
        'binarySha256':profile['binaryExpectedSha256'],'querySha256':profile['querySha256'],
        'kernelSha256':profile['kernelSha256'],'workerTransactionSha256':profile['workerTransactionSha256'],
        'composedRecipientQuerySha256':profile['composedRecipientQuerySha256']}


def run(binary, report_path, pg_bin=LOCAL_PG, source_dir=LOCAL_SOURCE,
        runtime_dir=LOCAL_RUNTIME, node_path=LOCAL_NODE_PATH, batch_profile=None, batch_profile_sha256=None, isolated_source_proof=False):
    require(os.environ.get('REGULAR_NATIVE_PROOF_ISOLATED') == '1', 'Explicit isolated opt-in required')
    require(bool(batch_profile) == bool(batch_profile_sha256), 'Native batch profile pair required')
    require(type(isolated_source_proof) is bool and (not isolated_source_proof or bool(batch_profile)),
        'Isolated source proof requires explicit batch profile')
    profile = None
    if batch_profile:
        require(re.fullmatch('[0-9a-f]{64}', batch_profile_sha256), 'Native batch profile hash required')
        checked = subprocess.run(['node', str(HERE/'native_batch_profile.cjs'),
            *(['--isolated-source-proof'] if isolated_source_proof else []),
            str(batch_profile), batch_profile_sha256, str(REPO)], text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        require(checked.returncode == 0 and len(checked.stdout) < 262144, 'Native batch profile refused')
        profile = json.loads(checked.stdout)
        require(profile['binaryExpectedSha256'] == sha(binary.read_bytes()), 'Native batch binary/source receipt mismatch')
        require(sha((source_dir/'queries/campaigns.sql').read_bytes()) == profile['querySha256'],
            'Native batch composed worker query mismatch')
        require(sha((source_dir/'cmd/manager_store.go').read_bytes()) == profile['sourcePins']['managerStoreCandidate']['sha256'],
            'Native batch composed manager source mismatch')
        require(sha((source_dir/'cmd/manager_store_batch_jit.go').read_bytes()) == profile['sourcePins']['jitHelper']['sha256'],
            'Native batch local JIT source mismatch')

    db_user = 'postgres' if profile else 'crm_shadow'
    require(binary.is_file() and not binary.is_symlink(), 'Candidate binary required')
    if profile:
        import sys
        require(sys.platform == 'linux', 'Batch full recipient proof requires Linux')
        header = binary.read_bytes()[:20]
        require(header[:6] == b'\x7fELF\x02\x01' and header[18:20] == b'\x3e\x00',
            'Batch full recipient proof requires measured Linux amd64 ELF')
    require(not report_path.exists(), 'Report path must be new')
    require(pg_bin.is_dir() and pg_bin.joinpath('postgres').is_file(), 'Pinned PostgreSQL 17 runtime unavailable')
    require(source_dir.is_dir() and source_dir.joinpath('schema.sql').is_file(), 'Official native schema unavailable')
    require(runtime_dir.is_dir() and not runtime_dir.is_symlink(), 'Private runtime directory unavailable')
    require(isinstance(node_path,str) and node_path and all(Path(p).is_dir() for p in node_path.split(os.pathsep)),
        'Node module path unavailable')
    if profile:
        version = subprocess.run([str(pg_bin/'postgres'), '--version'], text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=True)
        require(re.fullmatch(r'postgres \(PostgreSQL\) 17\.10(?:[^\n]*)\n?', version.stdout),
            'Original batch migrations require PostgreSQL 17.10')
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
            'TEST_DATABASE_URL': f'postgresql://{db_user}@127.0.0.1:{db_port}/{database}'})
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
        'query_sha256': '084a9493713b21b618d24daae98b38db59fb84febf0c367914bea1ed7aa84c2d',
        'binary_sha256': sha(binary.read_bytes()), 'proof_directory': str(run_dir),
        'proof_scope': 'synthetic prepared/due schedule boundary; real admission proof composed separately'}
    if profile:
        report['query_sha256'] = profile['querySha256']
        report['batch_profile'] = profile
        report.update({'proofPurpose':'isolated-source-functional' if isolated_source_proof else 'original-read-gated',
            'originalPerformanceAccepted':False,'originalOperational':False,'originalDispatchProved':False})
    try:
        with (run_dir/'init.log').open('wb') as log:
            subprocess.run([str(pg_bin/'initdb'), '-D', str(data), '-U', db_user, '--auth-local=trust',
                '--auth-host=trust', '--encoding=UTF8', '--locale=C', '--no-sync'], check=True,
                stdout=log, stderr=subprocess.STDOUT, timeout=30)
        with (run_dir/'lifecycle.log').open('wb') as log:
            subprocess.run([str(pg_bin/'pg_ctl'), '-D', str(data), '-l', str(run_dir/'server.log'),
                '-o', f'-h 127.0.0.1 -k {socket_dir} -p {db_port}', '-w', '-t', '15', 'start'],
                check=True, stdout=log, stderr=subprocess.STDOUT, timeout=20)
        started = True
        if profile and isolated_source_proof:
            membership_path = run_dir / 'rule-membership-native.json'
            membership_env = clean_env({'NODE_PATH': node_path,
                'TEST_DATABASE_URL': f'postgresql://{db_user}@127.0.0.1:{db_port}/postgres',
                'CRM_AUDIENCE_TEST_ISOLATED': '1', 'REGULAR_NATIVE_SOURCE_PROOF': '1',
                'BULK_MEMBERSHIP_REPORT': str(membership_path)})
            membership = subprocess.run(['node', str(REPO/'tests/rule-membership/native-runner.cjs')],
                env=membership_env, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=90)
            require(membership.returncode == 0 and not membership.stderr and len(membership.stdout) < 4096,
                'Native membership equivalence refused')
            membership_summary = json.loads(membership.stdout)
            require(membership_summary.get('ok') is True and membership_summary.get('cases') == 28
                and membership_summary.get('afterKernelSha256') == profile['kernelSha256']
                and membership_summary.get('endConfirmed') is True, 'Native membership identity refused')
            report['rule_membership_native'] = membership_summary
        db('CREATE DATABASE listmonk;', 'postgres')
        native_schema = source_dir.joinpath('schema.sql').read_text()
        db(native_schema + "\nINSERT INTO settings(key,value) VALUES('migrations','[\"v6.1.0\"]');")
        with NativeSMTP() as smtp:
            db(settings_sql(smtp.port, http_port))
            config_path = run_dir/'config.toml'
            config_text = config(db_port, http_port)
            if profile:
                require(config_text.count('user="crm_shadow"') == 1, 'Original native config user anchor drift')
                config_text = config_text.replace('user="crm_shadow"', 'user="postgres"', 1)
            config_path.write_text(config_text)
            node_env = clean_env({'NODE_PATH': node_path,
                'TEST_DATABASE_URL': f'postgresql://{db_user}@127.0.0.1:{db_port}/listmonk',
                'CRM_AUDIENCE_TEST_ISOLATED': '1'})
            if profile:
                node_env.update({'REGULAR_NATIVE_BATCH_PROFILE':str(batch_profile),
                    'REGULAR_NATIVE_BATCH_PROFILE_SHA256':batch_profile_sha256,'REGULAR_NATIVE_PROOF_ISOLATED':'1'})
            if isolated_source_proof:
                node_env['REGULAR_NATIVE_SOURCE_PROOF']='1'
            prepare = subprocess.run(['node', str(REPO/'tests/segment-regular-native-fixture.cjs'), 'prepare'],
                env=node_env, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=45)
            require(prepare.returncode == 0, 'Native fixture prepare failed: ' + prepare.stderr[-5000:])
            released_history_sql = """SELECT json_build_object(
                'head',(SELECT count(*) FROM crm_audience_v2.campaign_binding WHERE campaign_id=500),
                'revision',(SELECT count(*) FROM crm_audience_v2.campaign_binding_revision WHERE campaign_id=500),
                'release',(SELECT count(*) FROM crm_audience_v2.campaign_binding_release WHERE campaign_id=500),
                'effective',(SELECT count(*) FROM crm_audience_v2.campaign_binding_effective(500)),
                'controls',(SELECT count(*) FROM crm_audience_v2.regular_delivery_campaign WHERE campaign_id=500),
                'digest',md5(concat(
                    (SELECT to_jsonb(b)::text FROM crm_audience_v2.campaign_binding b WHERE campaign_id=500),
                    (SELECT to_jsonb(r)::text FROM crm_audience_v2.campaign_binding_revision r WHERE campaign_id=500),
                    (SELECT to_jsonb(t)::text FROM crm_audience_v2.campaign_binding_release t WHERE campaign_id=500))));"""
            released_history = db(released_history_sql)
            release_state = json.loads(released_history)
            require(all(release_state[k] == 1 for k in ('head','revision','release'))
                and release_state['effective'] == 0 and release_state['controls'] == 0,
                'Released history/effective state invalid before worker')
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
            if profile:
                coherent = json.loads(db("SELECT json_build_object('query_sha256',d.query_sha256,'candidate_query_sha256',rt.candidate_query_sha256,'enabled',rt.enabled,'worker_sha256',d.worker_sha256,'runtime_sha256',d.runtime_sha256) FROM crm_audience_v2.regular_worker_deployment d CROSS JOIN crm_audience_v2.selection_runtime rt WHERE d.singleton AND rt.singleton;"))
                require(coherent['query_sha256'] == profile['querySha256']
                    and coherent['candidate_query_sha256'] == profile['querySha256'] and coherent['enabled']
                    and coherent['worker_sha256'] == ident['worker_sha256']
                    and coherent['runtime_sha256'] == ident['runtime_sha256'], 'Native batch readiness identity mismatch')
                report['batch_readiness_identity'] = coherent

            schedule = subprocess.run(['node', str(REPO/'tests/segment-regular-native-fixture.cjs'), 'schedule'],
                env=node_env, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
            require(schedule.returncode == 0, 'Native fixture scheduling failed: ' + schedule.stderr[-5000:])
            scheduled = json.loads(schedule.stdout.strip().splitlines()[-1])
            require(scheduled == {'mode':'schedule','ok':True,'synthetic_boundary':'scheduled','pairs':2,
                'scheduled_campaigns':4,'scheduled_experiments':2,'active_controls':4},
                'Synthetic post-admission boundary invalid')
            state_sql = """SELECT json_build_object(
 'campaigns',(SELECT json_agg(to_jsonb(x) ORDER BY id) FROM (SELECT id,status::text,sent,last_subscriber_id FROM campaigns WHERE id IN(100,101,200,201,300,400,500))x),
 'dispatch',(SELECT json_agg(to_jsonb(d) ORDER BY campaign_id,subscriber_id) FROM (SELECT dispatch_id::text,brand,transport_state,payload_sha256,split_part(piece,':',2)::integer campaign_id,(dedupe_key::jsonb->>2)::integer subscriber_id FROM shrigma_email_dispatch)d),
 'controls',(SELECT json_agg(to_jsonb(r) ORDER BY campaign_id) FROM (SELECT campaign_id,enabled,suspended,acknowledged_sent,acknowledged_subscriber_id FROM crm_audience_v2.regular_delivery_campaign)r),
 'arms',(SELECT json_agg(to_jsonb(a) ORDER BY brand,arm) FROM (SELECT e.brand,a.arm,a.campaign_id,a.finished_at IS NOT NULL finished,a.transport_interrupted_at IS NOT NULL interrupted FROM crm_ab_arm_v2 a JOIN crm_ab_experiment_v2 e USING(test_id))a),
 'members',(SELECT json_agg(to_jsonb(m) ORDER BY brand,arm,subscriber_id) FROM (SELECT e.brand,m.arm,m.subscriber_id,m.revoked_at IS NOT NULL revoked,EXISTS(SELECT 1 FROM subscriber_lists sl WHERE sl.subscriber_id=m.subscriber_id AND sl.list_id=CASE e.brand WHEN 'fish' THEN 17 ELSE 16 END AND sl.status IN('confirmed','unconfirmed')) consented FROM crm_ab_member_v2 m JOIN crm_ab_experiment_v2 e USING(test_id))m),
 'experiments',(SELECT json_agg(to_jsonb(e) ORDER BY brand) FROM (SELECT brand,state,transport_bound,tracking_continuous,source_complete FROM crm_ab_experiment_v2)e),
 'pairs',(SELECT count(*)::integer FROM crm_audience_v2.ab_regular_pair),
 'lease',(SELECT to_jsonb(l) FROM crm_audience_v2.regular_worker_lease l),
 'deployment',(SELECT to_jsonb(d) FROM crm_audience_v2.regular_worker_deployment d))::text;"""
            deadline = time.monotonic() + TIMEOUT
            state = None
            while time.monotonic() < deadline:
                require(worker.poll() is None, 'Native worker exited early')
                raw = db(state_sql)
                state = json.loads(raw)
                campaigns = {x['id']: x for x in state['campaigns']}
                dispatch = state['dispatch'] or []
                fish_dispatch = [x for x in dispatch if x['campaign_id'] in (100,101)]
                aristo_dispatch = [x for x in dispatch if x['campaign_id'] in (200,201)]
                aristo_statuses = (campaigns[200]['status'], campaigns[201]['status'])
                if (campaigns[100]['status'] == campaigns[101]['status'] == 'finished'
                    and all(value in ('finished','paused') for value in aristo_statuses)
                    and 'paused' in aristo_statuses
                    and campaigns[300]['status'] == 'finished' and campaigns[400]['status'] == 'paused'
                    and campaigns[500]['status'] == 'finished'
                    and len(fish_dispatch) == 2 and all(x['transport_state']=='accepted' for x in fish_dispatch)
                    and sum(x['transport_state']=='outcome_unknown' for x in aristo_dispatch) == 1
                    and not any(x['transport_state']=='in_flight' for x in dispatch)):
                    break
                time.sleep(.25)
            else:
                raise RuntimeError('Native worker proof timed out')
            worker.terminate(); worker.wait(timeout=8); processes.pop()[1].close()
            before = list(smtp.messages)
            require(len(before) in (5,6), 'Unexpected synthetic SMTP attempt cardinality')
            # A clean process replacement is allowed only after the previous
            # nonsuspended lease expires. The disposable fixture advances that
            # lease explicitly instead of waiting a production-length minute.
            db("UPDATE crm_audience_v2.regular_worker_lease SET heartbeat_at=clock_timestamp()-interval '61 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE NOT suspended;")
            restarted = start_worker('worker-restart')
            time.sleep(7)
            require(restarted.poll() is None, 'Restarted worker exited early')
            restarted.terminate(); restarted.wait(timeout=8); processes.pop()[1].close()
            require(smtp.messages == before, 'Unknown delivery replayed after restart')
            final = json.loads(db(state_sql))
            messages = {m['recipient'].split('@')[0]: m for m in before}
            messages_by_dispatch = {m['dispatch_id']:m for m in before if m['dispatch_id']}
            dispatch = final['dispatch']
            campaigns = {x['id']: x for x in final['campaigns']}
            controls = {x['campaign_id']: x for x in final['controls']}
            members = final['members']; arms = final['arms']
            for d in dispatch:
                m=messages_by_dispatch.get(d['dispatch_id']);brand=d['brand']
                require(m is not None, 'Dispatch did not reach synthetic SMTP')
                expected_sender = 'contato@fishermans.com.br' if brand == 'fish' else 'contato@oaristocrata.com'
                require(m['sender']==expected_sender and m['dispatch_id']==d['dispatch_id'], 'Envelope/dispatch mismatch')
                require(m['raw_sha256']==d['payload_sha256'], 'Payload digest mismatch')
                require(f'crm_dispatch_id={d["dispatch_id"]}' in m['ses_tags'] and 'crm_test=false' in m['ses_tags'], 'Reserved SES tags missing')
                require(m['configuration_sets']==['native-fixture'], 'Private configuration set was not unique in final bytes')
                require('@TrackLink' not in m['body'] and '/link/' in m['body'], 'Panel TrackLink material was not rendered')
            fish_dispatch=[x for x in dispatch if x['campaign_id'] in (100,101)]
            fish_members=[x for x in members if x['brand']=='fish']
            require(len(fish_dispatch)==2 and {x['campaign_id'] for x in fish_dispatch}=={100,101}
                and all(x['transport_state']=='accepted' for x in fish_dispatch), 'Fish pair dispatch mismatch')
            require(len({x['subscriber_id'] for x in fish_dispatch})==2, 'Fish A/B recipients overlap')
            for d in fish_dispatch:
                arm=next((a for a in arms if a['brand']=='fish' and a['campaign_id']==d['campaign_id']),None)
                member=next((m for m in fish_members if m['subscriber_id']==d['subscriber_id']),None)
                require(arm and member and member['arm']==arm['arm'] and not member['revoked'] and member['consented'],
                    'Fish A/B dispatch escaped allocation or consent')
                require(campaigns[d['campaign_id']]['status']=='finished' and campaigns[d['campaign_id']]['sent']==1
                    and campaigns[d['campaign_id']]['last_subscriber_id']==d['subscriber_id'], 'Fish pair checkpoint mismatch')
                require(controls[d['campaign_id']]['acknowledged_sent']==1
                    and controls[d['campaign_id']]['acknowledged_subscriber_id']==d['subscriber_id'],
                    'Fish delivery acknowledgement mismatch')
            excluded={m['subscriber_id'] for m in fish_members if m['revoked'] or not m['consented']}
            require(len(excluded)==2 and not excluded.intersection({x['subscriber_id'] for x in fish_dispatch}),
                'Revoked or opted-out Fish member was dispatched')
            require(all(a['finished'] and not a['interrupted'] for a in arms if a['brand']=='fish'),
                'Fish pair arm completion mismatch')
            aristo_dispatch=[x for x in dispatch if x['campaign_id'] in (200,201)]
            require(len(aristo_dispatch) in (1,2) and sum(x['transport_state']=='outcome_unknown' for x in aristo_dispatch)==1
                and all(x['transport_state'] in ('accepted','outcome_unknown') for x in aristo_dispatch),
                'Aristo concurrent transport outcome mismatch')
            aristo_campaigns=[campaigns[200],campaigns[201]]
            require(all(c['status'] in ('finished','paused') for c in aristo_campaigns)
                and any(c['status']=='paused' for c in aristo_campaigns)
                and controls[200]['suspended'] and controls[201]['suspended'], 'Aristo pair-wide suspension mismatch')
            aristo_arms=[a for a in arms if a['brand']=='aristo']
            require(len(aristo_arms)==2 and any(a['interrupted'] for a in aristo_arms)
                and all((a['finished'] and not a['interrupted']) or (a['interrupted'] and not a['finished']) for a in aristo_arms),
                'Aristo arm terminal/interruption evidence mismatch')
            aristo_members=[x for x in members if x['brand']=='aristo']
            for d in aristo_dispatch:
                campaign=campaigns[d['campaign_id']]
                arm=next((a for a in aristo_arms if a['campaign_id']==d['campaign_id']),None)
                member=next((m for m in aristo_members if m['subscriber_id']==d['subscriber_id']),None)
                require(arm and member and member['arm']==arm['arm'] and not member['revoked'] and member['consented'],
                    'Aristo A/B dispatch escaped allocation or consent')
                if d['transport_state']=='accepted':
                    require(campaign['status'] in ('finished','paused') and campaign['sent']==1
                        and campaign['last_subscriber_id']==d['subscriber_id'], 'Accepted Aristo checkpoint mismatch')
                    require(controls[d['campaign_id']]['acknowledged_sent']==1
                        and controls[d['campaign_id']]['acknowledged_subscriber_id']==d['subscriber_id'],
                        'Accepted Aristo acknowledgement mismatch')
                else:
                    require(campaign['status']=='paused' and campaign['sent']==0 and campaign['last_subscriber_id']==0
                        and controls[d['campaign_id']]['acknowledged_sent']==0
                        and controls[d['campaign_id']]['acknowledged_subscriber_id']==0,
                        'Unknown Aristo checkpoint was not preserved')
            attempted_aristo={d['campaign_id'] for d in aristo_dispatch}
            for campaign_id in ({200,201}-attempted_aristo):
                require(campaigns[campaign_id]['status']=='paused' and campaigns[campaign_id]['sent']==0
                    and campaigns[campaign_id]['last_subscriber_id']==0
                    and controls[campaign_id]['acknowledged_sent']==0
                    and controls[campaign_id]['acknowledged_subscriber_id']==0,
                    'Unattempted Aristo peer checkpoint changed')
            require(final['pairs']==2 and all(e['state']=='scheduled' and e['transport_bound'] for e in final['experiments']),
                'A/B scheduled boundary changed')
            legacy=messages['legacy']
            require(legacy['sender']=='smoke@example.invalid' and legacy['subject']=='Native Legacy', 'Legacy envelope changed')
            require('legacy@example.invalid' in legacy['body'].lower(), 'Legacy rendered body changed')
            require(legacy['dispatch_id'] is None and legacy['ses_tags'] is None, 'Legacy message received guarded metadata')
            require(campaigns[300]['status']=='finished' and campaigns[300]['sent']==1 and campaigns[300]['last_subscriber_id']==3, 'Legacy checkpoint mismatch')
            released = messages['released']
            require(released['sender']=='smoke@example.invalid' and released['subject']=='Native Released', 'Released legacy envelope changed')
            require('released@example.invalid' in released['body'].lower(), 'Released campaign used its old audience')
            require(released['dispatch_id'] is None and released['ses_tags'] is None and not released['configuration_sets'], 'Released campaign received guarded metadata')
            require(campaigns[500]['status']=='finished' and campaigns[500]['sent']==1 and campaigns[500]['last_subscriber_id']==4, 'Released legacy checkpoint mismatch')
            require(db(released_history_sql)==released_history, 'Released history changed or delivery control was created')
            require(campaigns[400]['status']=='paused' and campaigns[400]['sent']==0 and campaigns[400]['last_subscriber_id']==0, 'Invalid bound campaign was not quarantined')
            require(len(final['dispatch']) in (3,4) and len(final['controls'])==5, 'Unexpected guarded state cardinality')
            require(final['lease']['instance_id']!=first_lease['instance_id'] and not final['lease']['suspended'], 'Expired lease was not replaced safely')
            report.update({'status':'PASSED_EPHEMERAL_ONLY_NOT_DEPLOYED','postgres_version':db("SHOW server_version;"),
                'identity':ident,'native_schema_sha256':sha(native_schema.encode()),'smtp_attempts':before,
                'state':final,'accepted_finish':True,'ack_lost_unknown':True,'restart_no_replay':True,
                'ab_native_pair_accepted':True,'ab_revoked_excluded':True,'ab_optout_excluded':True,
                'ab_arms_disjoint':True,'ab_unknown_suspended_pair':True,
                'ab_unknown_peer_may_finish_before_pause':any(c['status']=='finished' for c in aristo_campaigns),
                'ab_unknown_concurrent_attempts':len(aristo_dispatch),
                'synthetic_boundary':scheduled,
                'payload_digest_matches_bytes':True,'reserved_tags_match_dispatch':True,
                'private_configuration_set_unique_and_claimed':True,
                'panel_campaign_prepare_tracklink_rendered':True,
                'unbound_legacy_preserved':True,'invalid_bound_quarantined_without_scan_block':True,
                'released_legacy_preserved':True,'released_history_preserved':True,
                'released_campaign_uses_current_lists':True,
                'initial_heartbeat_committed_before_bound_schedule':True,'native_catalog_refresh':True,
                'expired_nonsuspended_lease_replaced':True,'local_worker_concurrency':2,
                'source_sha256':{
                    'tools/listmonk-regular-build/native_proof.py':sha(Path(__file__).read_bytes()),
                    'tests/segment-regular-native-fixture.cjs':sha((REPO/'tests/segment-regular-native-fixture.cjs').read_bytes())},
                'sql_sha256':{name:sha((REPO/'n8n/growth'/name).read_bytes()) for name in (
                    'segment-audience-store.sql','campaign-provider.sql','segment-campaign-binding.sql','ab-experiment-core.sql',
                    'ab-experiment-selection.sql','ab-audience-prepare.sql','segment-listmonk-selection.sql',
                    'segment-regular-readiness.sql','segment-regular-delivery.sql','segment-runtime-access.sql',
                    'segment-regular-recovery.sql','segment-regular-worker-lease.sql',
                    'segment-regular-operation-guard.sql','segment-regular-admission.sql',
                    'segment-shopify-facts.sql','segment-shopify-selection.sql','ab-audience-regular.sql')},
                'function_prosrc_md5':json.loads(db("""SELECT coalesce(json_object_agg(signature,body_md5 ORDER BY signature),'{}'::json)::text FROM (
 SELECT p.oid::regprocedure::text signature,md5(p.prosrc) body_md5 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN('crm_audience_v2','public') AND p.proname IN('campaign_send_guard','ab_assignment_guard','ab_experiment_guard',
  'regular_delivery_claim','regular_delivery_finish','regular_delivery_quarantine','regular_delivery_recover',
  'regular_admission_schedule','ab_regular_fence','ab_regular_context','ab_regular_pause','crm_ab_campaign_guard_v2',
  'shrigma_campaign_current')) q;""")),
                'trigger_definition_md5':json.loads(db("""SELECT coalesce(json_object_agg(trigger_name,definition_md5 ORDER BY trigger_name),'{}'::json)::text FROM (
 SELECT c.oid::regclass::text||'.'||t.tgname trigger_name,md5(pg_get_triggerdef(t.oid,false)) definition_md5
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE NOT t.tgisinternal AND n.nspname IN('crm_audience_v2','public')) q;"""))})
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
        if isolated_source_proof:
            report['workerProcessesEnded'] = all(process.poll() is not None for process, _ in processes)
            report['smtpServerEnded'] = 'smtp' in locals() and not smtp.thread.is_alive()
        if profile and report.get('status') == 'PASSED_EPHEMERAL_ONLY_NOT_DEPLOYED' and report.get('cluster_stopped') is True:
            report['batch_full_recipient_proof'] = {
                'accepted': True, 'scope': 'ephemeral-synthetic-running-campaigns',
                'platform': 'linux', 'architecture': 'amd64', 'postgres_version': '17.10',
                'running_status_required_by_exact_query': True,
                'binary_sha256': report['binary_sha256'], 'query_sha256': profile['querySha256'],
                'kernel_sha256': profile['kernelSha256'],
                'worker_transaction_sha256': profile['workerTransactionSha256'],
                'composed_recipient_query_sha256': profile['composedRecipientQuerySha256'],
                'production_operational': False}
        if isolated_source_proof:
            report['isolated_source_proof'] = isolated_source_receipt(report, profile)
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
    parser.add_argument('--batch-profile',type=Path)
    parser.add_argument('--batch-profile-sha256')
    parser.add_argument('--isolated-source-proof',action='store_true')
    args=parser.parse_args()
    run(args.binary.resolve(),args.report.resolve(),args.pg_bin.resolve(),args.source_dir.resolve(),
        args.runtime_dir.resolve(),args.node_path,
        args.batch_profile.resolve() if args.batch_profile else None,args.batch_profile_sha256,args.isolated_source_proof)
