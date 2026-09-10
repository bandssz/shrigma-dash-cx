import base64
import contextlib
import copy
import io
import json
import os
import socket
import ssl
import subprocess
import unittest
import urllib.error
from unittest import mock
import n8n_aristo_readonly as m

KEY = 'synthetic-only-api-key-not-a-real-credential'
WID = m.TARGETS['aristo_tx']

class Response:
    def __init__(self, payload=None, status=200, raw=None):
        self.status = status
        self.data = raw if raw is not None else json.dumps(payload).encode()
        self.read_calls = 0
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self,n):
        self.read_calls += 1
        return self.data[:n]

class TransportTests(unittest.TestCase):
    def client(self,response=None, error=None):
        client = m.Client(KEY)
        client.opener = mock.Mock()
        if error: client.opener.open.side_effect = error
        else: client.opener.open.return_value = response
        return client
    def test_fixed_https_host_get_key_header(self):
        c = self.client(Response({'id':WID}))
        raw,rec = c.get('/workflows/'+WID)
        req = c.opener.open.call_args.args[0]
        self.assertEqual(req.full_url,'https://n8n.shrigma.com.br/api/v1/workflows/'+WID)
        self.assertEqual(req.method,'GET')
        self.assertEqual(req.get_header('X-n8n-api-key'),KEY)
        self.assertEqual(rec['http_status'],200)
    def test_denies_other_routes(self):
        c = self.client()
        for route in ['/workflows','/credentials','/workflows/evil','/executions/123/retry','//example.com']:
            with self.subTest(route=route), self.assertRaises(ValueError): c.get(route)
        c.opener.open.assert_not_called()
    def test_denies_execution_payload_and_extra_query(self):
        c = self.client()
        for q in [{'workflowId':WID,'includeData':'true','limit':'30'},
                  {'workflowId':'other','includeData':'false','limit':'30'},
                  {'workflowId':WID,'includeData':'false','limit':'100'},
                  {'workflowId':WID,'includeData':'false','limit':'30','cursor':'x'}]:
            with self.subTest(q=q), self.assertRaises(ValueError): c.get('/executions',q)
    def test_denies_workflow_query(self):
        with self.assertRaises(ValueError): self.client().get('/workflows/'+WID, {'x':'1'})
    def test_no_key_without_probe_is_rejected(self):
        c=m.Client('')
        with self.assertRaises(ValueError):c.get('/workflows/'+WID)
    def test_probe_has_no_key_and_does_not_read_body(self):
        r=Response({'private':'MUST_NOT_READ'})
        c=self.client(r)
        body,receipt=c.get('/workflows/'+WID,probe=True)
        self.assertIsNone(body)
        self.assertEqual(r.read_calls,0)
        self.assertIsNone(c.opener.open.call_args.args[0].get_header('X-n8n-api-key'))
    def test_denies_non_probe_target(self):
        with self.assertRaises(ValueError):self.client().get('/workflows/'+m.TARGETS['aristo_retry'],probe=True)
    def test_no_redirect_key_forwarding(self):
        self.assertIsNone(m.NoRedirect().redirect_request(None,None,302,'',{},'https://evil.example'))
    def test_http_error_has_no_raw_body_or_key(self):
        err=urllib.error.HTTPError('https://example.invalid',401,KEY,{},io.BytesIO(KEY.encode()))
        _,receipt=self.client(error=err).get('/workflows/'+WID)
        self.assertEqual(receipt['http_status'],401)
        self.assertNotIn(KEY,json.dumps(receipt))
    def test_dns_and_tls_errors_are_classified(self):
        for cause,kind in [(socket.gaierror(-3,KEY),'dns_error'),(ssl.SSLError(KEY),'tls_error')]:
            _,r=self.client(error=urllib.error.URLError(cause)).get('/workflows/'+WID)
            self.assertEqual(r['error'],kind)
            self.assertNotIn(KEY,json.dumps(r))
    def test_invalid_json_is_safe(self):
        _,r=self.client(Response(raw=KEY.encode())).get('/workflows/'+WID)
        self.assertEqual(r['error'],'invalid_json')
    def test_oversize_is_rejected(self):
        with mock.patch.object(m,'MAX_BYTES',10):
            _,r=self.client(Response(raw=b'x'*20)).get('/workflows/'+WID)
        self.assertEqual(r['error'],'response_too_large')

class DataTests(unittest.TestCase):
    def test_wrong_workflow_identity_is_not_used(self):
        self.assertFalse(m.workflow_view({'id':'other'},WID,KEY)['valid'])
    def test_pinned_data_credentials_and_secret_headers_are_omitted(self):
        raw={'id':WID,'active':True,'pinData':{'customer':'PRIVATE'},'nodes':[{'name':'set','credentials':{'x':'PRIVATE'},'parameters':{'headers':{'authorization':KEY},'jsCode':'const pausa = true;'}}]}
        result=m.workflow_view(raw,WID,KEY)
        s=json.dumps(result)
        self.assertNotIn('PRIVATE',s)
        self.assertNotIn('authorization',s)
        self.assertIn('const pausa = true;',s)
    def test_known_and_pattern_secrets_are_redacted(self):
        content=KEY+' eyJhbGci.test.signature '+'EAA'+'a'*40
        out=m.scrub({'jsCode':content},KEY)
        self.assertNotIn(KEY,json.dumps(out))
        self.assertNotIn('eyJhbGci',json.dumps(out))
        self.assertNotIn('EAA'+'a'*40,json.dumps(out))
    def test_static_state_is_control_only(self):
        data={'global':{'pausa':True,'modo_pedido_pago':'real','cutoff':'2026-09-10T17:00:00Z','orders':[1,2],'email':'x@y.test','random':'PRIVATE','pausa_token':KEY}}
        out=m.static_controls(data)
        self.assertEqual(out,{'global':{'pausa':True,'modo_pedido_pago':'real','cutoff':'2026-09-10T17:00:00Z'}})
    def test_draft_and_published_remain_distinct(self):
        raw={'id':WID,'versionId':'draft-v','activeVersionId':'live-v','activeVersion':{'versionId':'live-v','nodes':[]}}
        out=m.workflow_view(raw,WID,KEY)
        self.assertEqual(out['current']['versionId'],'draft-v')
        self.assertEqual(out['published']['versionId'],'live-v')
    def test_absent_published_is_not_filled_with_draft(self):
        out=m.workflow_view({'id':WID,'nodes':[]},WID,KEY)
        self.assertFalse(out['published_version_included'])
        self.assertNotIn('published',out)
    def test_execution_rows_are_bounded_and_payload_free(self):
        row={'id':'1','workflowId':WID,'status':'success','data':{'email':KEY},'customData':KEY}
        out=m.execution_view({'data':[row]*40,'nextCursor':'PRIVATE'},WID)
        self.assertEqual(len(out['rows']),30)
        self.assertTrue(out['more_pages'])
        self.assertNotIn(KEY,json.dumps(out))
        self.assertNotIn('PRIVATE',json.dumps(out))
    def test_wrong_execution_workflow_is_rejected(self):
        out=m.execution_view({'data':[{'workflowId':'other'}]},WID)
        self.assertEqual(out['rows'],[])
        self.assertEqual(out['invalid_or_mismatched_rows'],1)
    def test_sample_does_not_claim_delivery_or_queue(self):
        out=m.execution_view({'data':[]},WID)
        self.assertTrue(out['sample_only'])
        self.assertFalse(out['proves_delivery'])
        self.assertFalse(out['proves_current_queue'])
    def test_invalid_execution_shape(self):
        self.assertFalse(m.execution_view(None,WID)['valid'])
    def test_collector_makes_only_four_scoped_reads(self):
        client=mock.Mock(key=KEY)
        def read(route,query=None):
            if route.startswith('/workflows/'):
                return {'id':route.split('/')[-1],'nodes':[]},{'http_status':200}
            return {'data':[]},{'http_status':200}
        client.get.side_effect=read
        report,ok=m.collect(client)
        self.assertTrue(ok)
        self.assertEqual(client.get.call_count,4)
        self.assertEqual(len(report['workflows']),2)

class EnvelopeTests(unittest.TestCase):
    def test_roundtrip_with_authenticated_encryption_envelope(self):
        report={'key':'aristo_tx','name':'Informação privada','mode':'real'}
        sealed=m.seal(report,KEY)
        self.assertNotIn('Informação',sealed)
        self.assertEqual(m.open_report(sealed,KEY),report)
    def test_same_plaintext_has_randomized_ciphertext(self):
        self.assertNotEqual(m.seal({'x':1},KEY),m.seal({'x':1},KEY))
    def test_wrong_key_fails_before_decrypt(self):
        sealed=m.seal({'x':1},KEY)
        with mock.patch.object(m.subprocess,'run') as run, self.assertRaisesRegex(ValueError,'integrity'):
            m.open_report(sealed,'different-key')
        run.assert_not_called()
    def test_tampered_ciphertext_is_rejected(self):
        e=json.loads(base64.b64decode(m.seal({'x':1},KEY)))
        c=bytearray(base64.b64decode(e['ciphertext']));c[-1]^=1
        e['ciphertext']=base64.b64encode(c).decode()
        with self.assertRaisesRegex(ValueError,'integrity'):
            m.open_report(base64.b64encode(json.dumps(e).encode()).decode(),KEY)
    def test_parameters_cannot_be_downgraded(self):
        e=json.loads(base64.b64decode(m.seal({'x':1},KEY)));e['iterations']=1
        with self.assertRaisesRegex(ValueError,'invalid_envelope'):
            m.open_report(base64.b64encode(json.dumps(e).encode()).decode(),KEY)
    def test_no_secret_in_openssl_argv(self):
        original=subprocess.run
        args=[]
        def wrapped(command,*a,**kw):
            args.append(command)
            return original(command,*a,**kw)
        with mock.patch.object(m.subprocess,'run',side_effect=wrapped):m.seal({'x':1},KEY)
        self.assertNotIn(KEY,json.dumps(args))
    def test_missing_key_refused(self):
        with self.assertRaises(ValueError):m.seal({},'')
    def test_missing_secret_main_reports_only_probe(self):
        receipt={'checked_at':'2026-09-10T19:00:00Z','http_status':401,'error':'http_error'}
        output=io.StringIO()
        with mock.patch.dict(os.environ,{'N8N_API_KEY':''}),mock.patch.object(m.Client,'get',return_value=(None,receipt)),contextlib.redirect_stdout(output):
            status=m.main()
        self.assertEqual(status,2)
        self.assertIn('missing_secret:N8N_API_KEY',output.getvalue())
        self.assertNotIn(m.PREFIX,output.getvalue())
    def test_main_report_is_never_printed_raw(self):
        receipt={'http_status':401}
        output=io.StringIO()
        with mock.patch.dict(os.environ,{'N8N_API_KEY':KEY}),mock.patch.object(m.Client,'get',return_value=(None,receipt)),mock.patch.object(m,'collect',return_value=({'private':'SENSITIVE_SAMPLE'},True)),contextlib.redirect_stdout(output):
            status=m.main()
        self.assertEqual(status,0)
        self.assertNotIn('SENSITIVE_SAMPLE',output.getvalue())
        self.assertNotIn(KEY,output.getvalue())
        sealed=[line[len(m.PREFIX):] for line in output.getvalue().splitlines() if line.startswith(m.PREFIX)][0]
        self.assertEqual(m.open_report(sealed,KEY),{'private':'SENSITIVE_SAMPLE'})

if __name__=='__main__':unittest.main()
