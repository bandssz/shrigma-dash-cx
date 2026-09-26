#!/usr/bin/env python3
"""Execute the official Listmonk API only in the isolated Linux CI rehearsal."""
import argparse
import base64
import html.parser
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from smtp_capture import CaptureSMTP
from upstream import LOCK, bounded, require, sha

HERE = Path(__file__).resolve().parent
DB = 'listmonk_test_probe'
CAMPAIGN_UUID = '40000000-0000-4000-8000-000000000001'
SUBSCRIBER_UUID = '30000000-0000-4000-8000-000000000001'
AUTH = 'Basic ' + base64.b64encode(b'synthetic-api:synthetic-probe-token').decode()
MAX_BODY = 128 * 1024


def require_ci(env):
    require(env.get('GITHUB_ACTIONS') == env.get('CI') == 'true' and env.get('RUNNER_OS') == 'Linux'
            and env.get('RUNNER_ARCH') == 'X64' and env.get('LISTMONK_TEST_PROBE_ISOLATED') == '1'
            and env.get('PROBE_EGRESS_RESTRICTED') == '1', 'EPHEMERAL_RESTRICTED_CI_REQUIRED')
    require(not any(k.startswith(('PG', 'LISTMONK_')) and k != 'LISTMONK_TEST_PROBE_ISOLATED' for k in env), 'EXTERNAL_CONFIG_FORBIDDEN')
    require(env.get('PROBE_UID', '').isdigit() and int(env['PROBE_UID']) == os.getuid() and os.getuid() != 0,
            'DEDICATED_UNPRIVILEGED_USER_REQUIRED')


def clean_env():
    return {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC'}


def db(sql):
    result = subprocess.run(['psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
                             '-p', '5432', '-U', 'synthetic', '-d', DB], input="SET statement_timeout='10s';\n" + sql,
                            text=True, env=clean_env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
    require(len(result.stdout) + len(result.stderr) < MAX_BODY, 'DB_OUTPUT_LIMIT')
    require(result.returncode == 0, 'DISPOSABLE_DB_QUERY_FAILED')
    return result.stdout.strip()


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def config(port):
    return f'''[app]
address="127.0.0.1:{port}"
[db]
host="127.0.0.1"
port=5432
user="synthetic"
password="synthetic-ci-placeholder"
database="{DB}"
ssl_mode="disable"
max_open=5
max_idle=5
max_lifetime="60s"
'''


def settings(smtp_port, origin):
    smtp = [{'enabled': True, 'host': '127.0.0.1', 'port': smtp_port, 'auth_protocol': 'none',
             'username': '', 'password': '', 'hello_hostname': 'example.invalid', 'max_conns': 1,
             'idle_timeout': '2s', 'wait_timeout': '2s', 'max_msg_retries': 0, 'tls_type': 'none',
             'tls_skip_verify': False, 'email_headers': []}]
    values = {'smtp': smtp, 'app.root_url': origin, 'app.from_email': 'Probe <probe@example.invalid>',
              'app.check_updates': False, 'app.notify_emails': [], 'app.enable_public_archive': False,
              'app.enable_public_subscription_page': False, 'app.send_optin_confirmation': False,
              'app.concurrency': 1, 'app.message_rate': 10, 'app.batch_size': 1, 'app.max_send_errors': 1,
              'app.cache_slow_queries': False, 'privacy.individual_tracking': True,
              'privacy.disable_tracking': False, 'bounce.enabled': False, 'bounce.mailboxes': [], 'messengers': []}
    return '\n'.join('UPDATE settings SET value=' + literal(json.dumps(v)) + '::jsonb WHERE key=' + literal(k) + ';'
                     for k, v in values.items())


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def local_url(url, origin):
    p = urllib.parse.urlsplit(url)
    require(p.scheme == 'http' and p.hostname == '127.0.0.1' and not p.username and not p.password
            and p.netloc == urllib.parse.urlsplit(origin).netloc and not p.fragment, 'LOOPBACK_URL_REQUIRED')
    return url


def request(origin, path, payload=None, authenticated=True):
    url = local_url(origin + path, origin)
    allowed = {'/api/health', '/api/about', '/api/campaigns/1/test', '/api/tx'}
    require(urllib.parse.urlsplit(url).path in allowed or payload is None and
            urllib.parse.urlsplit(url).path.startswith(('/link/', '/campaign/', '/subscription/')), 'PROBE_ROUTE_FORBIDDEN')
    headers = {'Accept': 'application/json', 'User-Agent': 'Synthetic-local-probe/1.0'}
    if authenticated:
        headers['Authorization'] = AUTH
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        require(len(data) < MAX_BODY, 'REQUEST_LIMIT')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=headers, method='POST' if data is not None else 'GET')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        response = opener.open(req, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read(MAX_BODY + 1)
        require(len(body) <= MAX_BODY, 'RESPONSE_LIMIT')
        return response.code, body, dict(response.headers)


def snapshot():
    return json.loads(db('''SELECT json_build_object(
      'campaign', (SELECT json_build_object('status',status,'sent',sent,'to_send',to_send,'started_at',started_at,
        'config_hash',encode(digest(jsonb_build_object('name',name,'subject',subject,'from',from_email,'body',body,
        'altbody',altbody,'template_id',template_id,'content_type',content_type,'headers',headers,'send_at',send_at)::text,'sha256'),'hex')) FROM campaigns WHERE id=1),
      'subscriber_count',(SELECT count(*) FROM subscribers),
      'subscriber_hash',(SELECT encode(digest(coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb)::text,'sha256'),'hex') FROM subscribers s),
      'subscription_hash',(SELECT encode(digest(coalesce(jsonb_agg(to_jsonb(s) ORDER BY subscriber_id,list_id),'[]'::jsonb)::text,'sha256'),'hex') FROM subscriber_lists s),
      'campaign_count',(SELECT count(*) FROM campaigns),'views',(SELECT count(*) FROM campaign_views),
      'clicks',(SELECT count(*) FROM link_clicks),'links',(SELECT count(*) FROM links),
      'campaign_views',(SELECT count(*) FROM campaign_views WHERE campaign_id=1),
      'campaign_clicks',(SELECT count(*) FROM link_clicks WHERE campaign_id=1),
      'known_views',(SELECT count(*) FROM campaign_views WHERE campaign_id=1 AND subscriber_id=1),
      'known_clicks',(SELECT count(*) FROM link_clicks WHERE campaign_id=1 AND subscriber_id=1));'''))


def unchanged(before, after):
    for key in ('subscriber_count', 'subscriber_hash', 'subscription_hash', 'campaign_count'):
        require(before[key] == after[key], 'PERSISTENT_IDENTITY_CHANGED_' + key)
    for key in ('status', 'config_hash', 'started_at'):
        require(before['campaign'][key] == after['campaign'][key], 'CAMPAIGN_CHANGED_' + key)
    require(after['campaign']['status'] == 'draft' and after['campaign']['started_at'] is None, 'CAMPAIGN_STARTED')


def payload(email, case, origin, template_id=1):
    require(re.fullmatch(r'[a-z]+@example\.invalid', email) is not None, 'SYNTHETIC_RECIPIENT_REQUIRED')
    body = ('<p>REQUEST-BODY ' + case + ' · {{ .Subscriber.Name }}</p>'
            '<a href="{{ TrackLink \"' + origin + '/local-destination?case=' + case + '\" }}">Tracked</a>'
            '{{ TrackView }}<a href="{{ UnsubscribeURL }}">Unsubscribe</a>')
    return {'name': 'Synthetic request ' + case, 'subject': '[TESTE] ' + case, 'from_email': 'Probe <probe@example.invalid>',
            'body': body, 'content_type': 'html', 'messenger': 'email', 'type': 'regular',
            'template_id': template_id, 'lists': [1], 'subscribers': [email]}


class Links(html.parser.HTMLParser):
    def __init__(self, body):
        super().__init__()
        self.urls = []
        self.feed(body)

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in ('href', 'src') and value:
                self.urls.append(value)


def wait_messages(capture, total, process):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and len(capture.messages) < total:
        require(process.poll() is None, 'NATIVE_PROCESS_EXITED')
        time.sleep(.1)
    require(len(capture.messages) == total and not capture.errors, 'SMTP_COUNT_OR_REJECTION')
    time.sleep(.2)
    require(len(capture.messages) == total, 'DUPLICATE_SMTP_MESSAGE')
    return capture.messages[-1]


def mime_proof(message, case, recipient, wrapper=None):
    require(message['sender'] == 'probe@example.invalid' and message['recipients'] == [recipient], 'SMTP_ENVELOPE_MISMATCH')
    require(message['subject'] == '[TESTE] ' + case and '{{' not in message['body'], 'MIME_SUBJECT_OR_RENDER_MISMATCH')
    if wrapper:
        require(wrapper in message['body'] and 'REQUEST-BODY ' + case in message['body'] and 'STORED-BODY' not in message['body'], 'MIME_WRAPPER_OR_BODY_MISMATCH')
        other = 'WRAPPER-OVERRIDE' if wrapper == 'WRAPPER-STORED' else 'WRAPPER-STORED'
        require(other not in message['body'], 'MULTIPLE_WRAPPERS')
    return {'subject': message['subject'], 'recipient': recipient, 'body_bytes': len(message['body'].encode()),
            'body_sha256': sha(message['body'].encode()), 'wrapper': wrapper, 'remaining_go': False}


def run(artifact, output):
    require_ci(os.environ)
    require(not output.exists(), 'REPORT_EXISTS')
    manifest = json.loads(bounded(artifact / 'manifest.json', MAX_BODY))
    binary = bounded(artifact / 'listmonk', 32 * 1024 * 1024)
    schema = bounded(artifact / 'schema.sql', 1024 * 1024)
    require(manifest['archive_sha256'] == LOCK['release']['sha256'] and manifest['patched'] is False and
            manifest['binary_sha256'] == sha(binary) and manifest['schema_sha256'] == sha(schema), 'ARTIFACT_MISMATCH')
    identity = json.loads(db("SELECT json_build_object('db',current_database(),'user',current_user,'objects',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'));"))
    require(identity == {'db': DB, 'user': 'synthetic', 'objects': 0}, 'EMPTY_DISPOSABLE_DB_REQUIRED')
    report = {'schema': 'listmonk-test-probe-v1', 'status': 'FAILED', 'official': manifest, 'production_access': False,
              'smtp_relay': False, 'egress_restricted': True, 'cases': [], 'snapshots': {}}
    process = None
    with tempfile.TemporaryDirectory(prefix='listmonk-test-probe-') as temp:
        work = Path(temp)
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]
        origin = 'http://127.0.0.1:' + str(port)
        (work / 'config.toml').write_text(config(port))
        try:
            db(schema.decode())
            db((HERE / 'fixture.sql').read_text())
            with CaptureSMTP() as capture:
                db(settings(capture.port, origin))
                with (work / 'native.log').open('wb') as log:
                    process = subprocess.Popen([str(artifact / 'listmonk'), '--config', str(work / 'config.toml')],
                                               cwd=work, env=clean_env(), stdout=log, stderr=subprocess.STDOUT)
                    deadline = time.monotonic() + 25
                    while True:
                        require(process.poll() is None, 'NATIVE_START_FAILED')
                        try:
                            status, _, _ = request(origin, '/api/health')
                            if status == 200: break
                        except (urllib.error.URLError, TimeoutError, ConnectionError): pass
                        require(time.monotonic() < deadline, 'NATIVE_START_TIMEOUT'); time.sleep(.2)
                    status, body, _ = request(origin, '/api/about')
                    require(status == 200 and LOCK['version'].encode() in body, 'NATIVE_VERSION_UNCONFIRMED')
                    report['about_sha256'] = sha(body)
                    base = snapshot(); report['snapshots']['initial'] = base
                    status, body, _ = request(origin, '/api/campaigns/1/test', payload('absent@example.invalid', 'absent', origin))
                    time.sleep(.5)
                    after = snapshot(); report['snapshots']['absent'] = after
                    report['cases'].append({'case': 'absent', 'http': status, 'response_sha256': sha(body), 'smtp_messages': len(capture.messages), 'expected_from_source': '400 with no known subscriber; no SMTP'})
                    require(status == 400 and not capture.messages and after == base, 'ABSENT_RECIPIENT_NOT_REJECTED_CLEANLY')
                    cases = [('known-json', 'known@example.invalid', 2, '', 'WRAPPER-STORED'),
                             ('known-query', 'known@example.invalid', 2, '?template_id=2', 'WRAPPER-OVERRIDE'),
                             ('blocklisted', 'blocked@example.invalid', 1, '', 'WRAPPER-STORED'),
                             ('unsubscribed', 'unsubscribed@example.invalid', 1, '', 'WRAPPER-STORED')]
                    first = None
                    for index, (case, recipient, template_id, query, wrapper) in enumerate(cases, 1):
                        before = snapshot()
                        status, body, _ = request(origin, '/api/campaigns/1/test' + query, payload(recipient, case, origin, template_id))
                        evidence = {'case': case, 'http': status, 'response_sha256': sha(body), 'before': before,
                                    'expected_from_source': '200 queued; /test does not filter global or list suppression',
                                    'crm_authorization': False}
                        report['cases'].append(evidence)
                        require(status == 200, 'CAMPAIGN_TEST_HTTP_' + case)
                        message = wait_messages(capture, index, process)
                        proof = mime_proof(message, case, recipient, wrapper)
                        if first is None: first = message
                        after = snapshot(); unchanged(base, after)
                        evidence.update(mime=proof, after=after)
                    urls = Links(first['body']).urls
                    pixel = [u for u in urls if '/campaign/' in u]
                    click = [u for u in urls if '/link/' in u]
                    require(len(pixel) == len(click) == 1, 'TRACKING_URLS_MISSING')
                    for url in pixel + click:
                        local_url(url, origin)
                        require(CAMPAIGN_UUID in url and SUBSCRIBER_UUID in url, 'CAMPAIGN_TEST_IDENTITY_NOT_REAL')
                    before = snapshot()
                    statuses = []
                    for url in pixel + click:
                        status, _, headers = request(origin, url[len(origin):], authenticated=False)
                        if url in click:
                            require(status in (302, 307) and headers.get('Location') == origin + '/local-destination?case=known-json', 'TRACKED_REDIRECT_UNEXPECTED')
                        else: require(status == 200, 'PIXEL_NOT_RETURNED')
                        statuses.append(status)
                    after = snapshot(); unchanged(base, after)
                    report['cases'].append({'case': 'open-click-localhost', 'http': statuses, 'before': before, 'after': after, 'redirect_followed': False})
                    require(after['known_views'] == before['known_views'] + 1 and after['known_clicks'] == before['known_clicks'] + 1, 'TRACKING_COUNTER_EVIDENCE_MISSING')
                    before = snapshot()
                    tx = {'template_id': 3, 'subscriber_mode': 'external', 'subscriber_emails': ['external@example.invalid'],
                          'subject': '[TESTE] tx-external', 'from_email': 'Probe <probe@example.invalid>',
                          'data': {'marker': 'synthetic-value', 'url': origin + '/local-destination?case=tx'}}
                    status, body, _ = request(origin, '/api/tx', tx)
                    require(status == 200, 'TX_EXTERNAL_HTTP_FAILED')
                    message = wait_messages(capture, 5, process)
                    proof = mime_proof(message, 'tx-external', 'external@example.invalid')
                    require('TX-ONLY synthetic-value' in message['body'] and 'identity[]name[]' in message['body']
                            and 'WRAPPER-' not in message['body'] and '/link/' not in message['body']
                            and '/campaign/' not in message['body'], 'TX_CONTEXT_UNEXPECTED')
                    after = snapshot(); unchanged(base, after)
                    require(before == after, 'TX_EXTERNAL_PERSISTED_OR_TRACKED')
                    report['cases'].append({'case': 'tx-external', 'http': status, 'mime': proof, 'before': before, 'after': after})
                    report['smtp_messages'] = len(capture.messages)
                    report['snapshots']['final'] = after
                    report['status'] = 'PASSED_EPHEMERAL_ONLY_NO_PRODUCTION_APPROVAL'
        except Exception as error:
            report['failure'] = str(error) if re.fullmatch(r'[A-Z_a-z0-9-]{1,100}', str(error)) else type(error).__name__
            raise
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(report, indent=2) + '\n')
            # Local logs contain only generated fixture data; keep bounded evidence on failure.
            log_path = work / 'native.log'
            if log_path.exists() and report['status'] == 'FAILED':
                output.with_suffix('.log').write_bytes(log_path.read_bytes()[-16000:])
    print(json.dumps({'status': report['status'], 'smtp_messages': report.get('smtp_messages'), 'cases': len(report['cases'])}))


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--artifact', required=True, type=Path)
    p.add_argument('--report', required=True, type=Path)
    a = p.parse_args(); run(a.artifact.resolve(), a.report.resolve())
