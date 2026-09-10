#!/usr/bin/env python3
"""Bounded n8n GETs. Output is authenticated ciphertext, never raw API data.

No workflow execution, activation, publication or retry is implemented.
The API key is taken only from N8N_API_KEY and never written to disk.
"""
import base64
import copy
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = 'https://n8n.shrigma.com.br/api/v1'
TARGETS = {'aristo_tx': '54waQbYEjCHDLwgA', 'aristo_retry': 'jx00U4fCbJHVwvDL'}
MAX_BYTES = 8 * 1024 * 1024
ITERATIONS = 200000
PREFIX = 'ARISTO_ENCRYPTED_REPORT_V1='
MAC_CONTEXT = b'shrigma/aristo-readonly/report-mac/v1'
BLOCKED_FIELDS = {'credentials', 'pinData', 'headers', 'headerParameters', 'authentication',
                  'httpHeaderAuth', 'httpBasicAuth'}
CONTROL_KEY = re.compile(r'paus|suspend|suspens|hold|bloque|block|cutoff|corte|not_?before|modo|mode|enabled|habilit|kill.?switch|emergency|maintenance', re.I)
SENSITIVE_KEY = re.compile(r'secret|senha|password|token|authorization|credential|api.?key|phone|email|customer|recipient', re.I)
MODES = {'real','sombra','interno','internal','shadow','live','paused','stopped','active','inactive','true','false','off','on','test','production'}
STAMP = re.compile(r'^\d{4}-\d{2}-\d{2}(?:T[0-9:.+Z-]+)?$')


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, key=''):
        self.key = key
        self.opener = urllib.request.build_opener(NoRedirect())

    def get(self, route, query=None, probe=False):
        query = query or {}
        if route not in ['/workflows/' + wid for wid in TARGETS.values()] + ['/executions']:
            raise ValueError('route_not_allowed')
        if route == '/executions':
            if set(query) != {'workflowId','includeData','limit'} or query.get('workflowId') not in TARGETS.values() or query.get('includeData') != 'false' or query.get('limit') != '30':
                raise ValueError('query_not_allowed')
        elif query:
            raise ValueError('query_not_allowed')
        if probe and (route != '/workflows/' + TARGETS['aristo_tx'] or query):
            raise ValueError('probe_not_allowed')
        url = BASE + route + ('?' + urllib.parse.urlencode(query) if query else '')
        headers = {'Accept': 'application/json'}
        if not probe:
            if not self.key:
                raise ValueError('missing_secret')
            headers['X-N8N-API-KEY'] = self.key
        request = urllib.request.Request(url, headers=headers, method='GET')
        receipt = {'checked_at': now(), 'http_status': None, 'error': None}
        try:
            with self.opener.open(request, timeout=20) as response:
                receipt['http_status'] = response.status
                if probe:
                    return None, receipt
                data = response.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES:
                    return None, dict(receipt, error='response_too_large')
                try:
                    return json.loads(data.decode('utf-8')), receipt
                except (ValueError, UnicodeError):
                    return None, dict(receipt, error='invalid_json')
        except urllib.error.HTTPError as exc:
            status = exc.code
            exc.close()
            return None, dict(receipt, http_status=status, error='http_error')
        except urllib.error.URLError as exc:
            kind = 'dns_error' if isinstance(exc.reason, socket.gaierror) else 'tls_error' if isinstance(exc.reason, ssl.SSLError) else 'connection_error'
            return None, dict(receipt, error=kind)
        except (TimeoutError, OSError):
            return None, dict(receipt, error='connection_or_timeout')


def scrub(value, key, depth=0):
    """Defense in depth before encryption; ciphertext is still mandatory."""
    if depth > 35:
        return '[depth_limit]'
    if isinstance(value, dict):
        return {k: scrub(v, key, depth+1) for k,v in value.items()
                if k not in BLOCKED_FIELDS and not SENSITIVE_KEY.search(str(k))}
    if isinstance(value, list):
        return [scrub(v, key, depth+1) for v in value[:500]]
    if isinstance(value, str):
        if key:
            value = value.replace(key, '[REDACTED_KEY]')
        value = re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[REDACTED_JWT]', value)
        value = re.sub(r'\bEAA[A-Za-z0-9]{25,}\b', '[REDACTED_META_TOKEN]', value)
    return value


def static_controls(value, depth=0):
    if not isinstance(value, dict) or depth > 8:
        return {}
    result = {}
    for key, item in value.items():
        if SENSITIVE_KEY.search(str(key)):
            continue
        if isinstance(item, dict):
            child = static_controls(item, depth+1)
            if child:
                result[key] = child
        elif CONTROL_KEY.search(str(key)) and (item is None or type(item) is bool or type(item) is int and item in (0,1) or isinstance(item,str) and (item.lower() in MODES or STAMP.fullmatch(item))):
            result[key] = item
    return result


def workflow_view(raw, expected_id, key):
    if not isinstance(raw, dict) or raw.get('id') != expected_id:
        return {'valid': False, 'error': 'workflow_identity_or_shape'}
    fields = ('id','name','versionId','activeVersionId','active','isArchived','updatedAt','nodes','connections','settings')
    def version(data):
        result = {k: copy.deepcopy(data[k]) for k in fields if k in data}
        result['static_control_candidates'] = static_controls(data.get('staticData'))
        return scrub(result, key)
    result = {'valid': True, 'current': version(raw), 'published_version_included': isinstance(raw.get('activeVersion'),dict)}
    if isinstance(raw.get('activeVersion'), dict):
        result['published'] = version(raw['activeVersion'])
    result['static_candidates_are_not_runtime_proof'] = True
    return result


def execution_view(raw, workflow_id):
    if not isinstance(raw, dict) or not isinstance(raw.get('data'), list):
        return {'valid': False, 'error': 'execution_list_shape'}
    fields = ('id','workflowId','status','mode','startedAt','stoppedAt','waitTill','retryOf','retrySuccessId','workflowVersionId')
    rows, rejected = [], 0
    for row in raw['data'][:30]:
        if not isinstance(row, dict) or row.get('workflowId') != workflow_id:
            rejected += 1
            continue
        rows.append({k: row[k] for k in fields if k in row and (row[k] is None or isinstance(row[k],str))})
    return {'valid': True, 'sample_only': True, 'more_pages': bool(raw.get('nextCursor')),
            'invalid_or_mismatched_rows': rejected, 'rows': rows,
            'proves_delivery': False, 'proves_current_queue': False}


def collect(client):
    report = {'schema_version':1, 'kind':'aristo_n8n_encrypted_readonly', 'generated_at':now(), 'workflows':[]}
    ok = True
    for alias, wid in TARGETS.items():
        raw, receipt = client.get('/workflows/' + wid)
        entry = {'key':alias, 'configuration_request':receipt, 'configuration':workflow_view(raw,wid,client.key)}
        ok = ok and receipt['http_status'] == 200 and entry['configuration']['valid']
        executions, execution_receipt = client.get('/executions', {'workflowId':wid,'includeData':'false','limit':'30'})
        entry['executions_request'] = execution_receipt
        entry['execution_sample'] = execution_view(executions,wid)
        ok = ok and execution_receipt['http_status'] == 200 and entry['execution_sample']['valid']
        report['workflows'].append(entry)
    report['all_reads_valid'] = bool(ok)
    report['limits'] = ['Retained execution sample is not a live queue or proof of delivery.',
                        'Configuration is not proof that a code branch executed.',
                        'Published version may be absent. No production changes or messages were made.',
                        'Credentials, pinned data and non-control static data are omitted; code secrets are redacted.']
    return report, bool(ok)


def salt_options():
    """Use the common 8-byte enc salt on both OpenSSL 3.0 and newer releases."""
    help_result = subprocess.run(['openssl','enc','-help'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=False)
    return ['-saltlen','8'] if b'-saltlen' in help_result.stdout + help_result.stderr else []


def seal(report, key):
    if not key:
        raise ValueError('missing_secret')
    plaintext = json.dumps(report, ensure_ascii=False, separators=(',',':')).encode()
    env = dict(os.environ, ARISTO_ENCRYPTION_KEY=key)
    command = ['openssl','enc','-aes-256-cbc','-salt','-pbkdf2','-iter',str(ITERATIONS),'-md','sha256','-pass','env:ARISTO_ENCRYPTION_KEY'] + salt_options()
    result = subprocess.run(command, input=plaintext, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=20, check=False)
    if result.returncode != 0:
        raise ValueError('encryption_failed')
    mac_key = hmac.new(key.encode(), MAC_CONTEXT, hashlib.sha256).digest()
    mac = hmac.new(mac_key, result.stdout, hashlib.sha256).hexdigest()
    envelope = {'v':1,'cipher':'AES-256-CBC+HMAC-SHA256','kdf':'PBKDF2-SHA256','iterations':ITERATIONS,
                'ciphertext':base64.b64encode(result.stdout).decode(),'mac':mac}
    return base64.b64encode(json.dumps(envelope,separators=(',',':')).encode()).decode()


def open_report(encoded, key):
    """Local helper; never called by the GitHub workflow."""
    if not key or len(encoded) > 32*1024*1024:
        raise ValueError('invalid_envelope')
    envelope = json.loads(base64.b64decode(encoded, validate=True))
    if (envelope.get('v'),envelope.get('cipher'),envelope.get('kdf'),envelope.get('iterations')) != (1,'AES-256-CBC+HMAC-SHA256','PBKDF2-SHA256',ITERATIONS):
        raise ValueError('invalid_envelope')
    ciphertext = base64.b64decode(envelope['ciphertext'],validate=True)
    mac_key = hmac.new(key.encode(),MAC_CONTEXT,hashlib.sha256).digest()
    if not hmac.compare_digest(hmac.new(mac_key,ciphertext,hashlib.sha256).hexdigest(),envelope['mac']):
        raise ValueError('integrity_check_failed')
    env = dict(os.environ, ARISTO_ENCRYPTION_KEY=key)
    result = subprocess.run(['openssl','enc','-d','-aes-256-cbc','-pbkdf2','-iter',str(ITERATIONS),'-md','sha256','-pass','env:ARISTO_ENCRYPTION_KEY'] + salt_options(),input=ciphertext,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=20,check=False)
    if result.returncode != 0:
        raise ValueError('decryption_failed')
    return json.loads(result.stdout)


def main():
    key = os.environ.get('N8N_API_KEY','').strip()
    _, probe = Client().get('/workflows/' + TARGETS['aristo_tx'], probe=True)
    print('N8N_NETWORK_PROBE=' + json.dumps(probe,separators=(',',':')), flush=True)
    if not key:
        print('N8N_READONLY_STATUS=missing_secret:N8N_API_KEY', flush=True)
        return 2
    if probe['http_status'] is None:
        print('N8N_READONLY_STATUS=network_unavailable', flush=True)
        return 3
    report, ok = collect(Client(key))
    print(PREFIX + seal(report,key), flush=True)
    print('N8N_READONLY_STATUS=' + ('collected_encrypted' if ok else 'incomplete_encrypted'), flush=True)
    return 0 if ok else 4


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('N8N_READONLY_STATUS=internal_error_no_raw_output', flush=True)
        sys.exit(5)
