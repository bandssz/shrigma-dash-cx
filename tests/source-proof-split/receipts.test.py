import ast, copy, os, unittest, hashlib
from pathlib import Path
ROOT=Path(os.environ['SOURCE_SPLIT_TEST_ROOT'])
class Build:
    @staticmethod
    def require(value,message):
        if not value: raise RuntimeError(message)
def extract(path,name,extra=None):
    tree=ast.parse(path.read_text());node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name==name)
    ns={'require':Build.require,'build':Build};ns.update(extra or {})
    exec(compile(ast.Module(body=[node],type_ignores=[]),str(path),'exec'),ns);return ns[name]
FILES=ROOT/'files' if (ROOT/'files').is_dir() else ROOT
native=FILES/'tools/listmonk-regular-build/native_proof.py'
image=FILES/'tools/listmonk-regular-package/image.py'
receipt=extract(native,'isolated_source_receipt');verify=extract(image,'verify_source_functional_receipt')
def fixture():
    p={'isolatedSourceProofAuthorized':True,'isolatedProofAuthorized':False,'isolatedProofAuthorization':None,
       'binaryExpectedSha256':'b'*64,'querySha256':'q'*64,'kernelSha256':'k'*64,
       'workerTransactionSha256':'w'*64,'composedRecipientQuerySha256':'r'*64}
    r={'status':'PASSED_EPHEMERAL_ONLY_NOT_DEPLOYED','cluster_stopped':True,'workerProcessesEnded':True,
       'smtpServerEnded':True,'local_disposable':True,'production_changed':False,'remote_hosts':0,
       'binary_sha256':p['binaryExpectedSha256'],'query_sha256':p['querySha256'],
       'batch_full_recipient_proof':{'accepted':True},'proofPurpose':'isolated-source-functional',
       'originalPerformanceAccepted':False,'originalOperational':False,'originalDispatchProved':False}
    r['batch_full_recipient_proof'].update({'scope':'ephemeral-synthetic-running-campaigns','platform':'linux','architecture':'amd64','postgres_version':'17.10','running_status_required_by_exact_query':True,'production_operational':False,
        'binary_sha256':p['binaryExpectedSha256'],'query_sha256':p['querySha256'],'kernel_sha256':p['kernelSha256'],'worker_transaction_sha256':p['workerTransactionSha256'],'composed_recipient_query_sha256':p['composedRecipientQuerySha256']})
    r['isolated_source_proof']=receipt(r,p);return r,p,{'binary_sha256':p['binaryExpectedSha256']}
class Tests(unittest.TestCase):
    def test_positive_synthetic_receipt_no_native_execution(self):
        r,p,m=fixture();self.assertTrue(r['isolated_source_proof']['accepted']);verify(r,p,m)
    def test_each_incomplete_runtime_has_no_acceptance(self):
        for key,value in [('status','FAILED'),('cluster_stopped',False),('workerProcessesEnded',False),('smtpServerEnded',False),('local_disposable',False),('production_changed',True),('remote_hosts',1),('binary_sha256','wrong'),('query_sha256','wrong'),('batch_full_recipient_proof',{'accepted':False})]:
            with self.subTest(key=key):
                r,p,m=fixture();r[key]=value;r['isolated_source_proof']=receipt(r,p);self.assertFalse(r['isolated_source_proof']['accepted']);self.assertFalse(r['isolated_source_proof']['loopbackSMTPAccepted'])
                with self.assertRaises(RuntimeError):verify(r,p,m)
    def test_full_recipient_proof_requires_exact_native_identity_and_running_status(self):
        for key,value in [('scope','scheduled-read-preview'),('platform','darwin'),('architecture','arm64'),('postgres_version','17.5'),('running_status_required_by_exact_query',False),('production_operational',True),('binary_sha256','wrong'),('query_sha256','wrong'),('kernel_sha256','wrong'),('worker_transaction_sha256','wrong'),('composed_recipient_query_sha256','wrong')]:
            with self.subTest(key=key):
                r,p,m=fixture();r['batch_full_recipient_proof'][key]=value
                self.assertFalse(receipt(r,p)['accepted'])
    def test_source_purpose_cannot_import_original_read_authority(self):
        for key,value in [('isolatedSourceProofAuthorized',False),('isolatedProofAuthorized',True),('isolatedProofAuthorization',{})]:
            r,p,m=fixture();p[key]=value
            with self.assertRaises(RuntimeError):receipt(r,p)
    def test_oci_refuses_preview_identity_promotion_and_unknown_end(self):
        for key,value in [('purpose','scheduled-read-preview'),('synthetic',False),('accepted',False),('fullSyntheticRecipientAccepted',False),('loopbackSMTPAccepted',False),('originalPerformanceAccepted',True),('originalOperational',True),('originalDispatchProved',True),('binarySha256','wrong'),('querySha256','wrong'),('kernelSha256','wrong'),('workerTransactionSha256','wrong'),('composedRecipientQuerySha256','wrong')]:
            with self.subTest(key=key):
                r,p,m=fixture();r['isolated_source_proof'][key]=value
                with self.assertRaises(RuntimeError):verify(r,p,m)
    def test_no_profile_optin_fails_before_any_subprocess(self):
        fn=extract(native,'run',{'LOCAL_PG':Path('/invalid'),'LOCAL_SOURCE':Path('/invalid'),'LOCAL_RUNTIME':Path('/invalid'),'LOCAL_NODE_PATH':'/invalid','os':os})
        old=os.environ.get('REGULAR_NATIVE_PROOF_ISOLATED');os.environ['REGULAR_NATIVE_PROOF_ISOLATED']='1'
        try:
            with self.assertRaisesRegex(RuntimeError,'explicit batch profile'):fn(Path('/invalid'),Path('/invalid'),isolated_source_proof=True)
        finally:
            if old is None:os.environ.pop('REGULAR_NATIVE_PROOF_ISOLATED',None)
            else:os.environ['REGULAR_NATIVE_PROOF_ISOLATED']=old
    def test_fixture_requires_existing_disposable_guard_and_explicit_profile(self):
        s=(FILES/'tests/segment-regular-native-fixture.cjs').read_text()
        self.assertIn("isolatedSourceProof&&(!batchPath||dependencyOnly)",s);self.assertIn("u.hostname!=='127.0.0.1'",s);self.assertIn("u.port==='5432'",s);self.assertIn('forRun:!dependencyOnly,isolatedSourceProof',s)
    def test_default_algorithm_and_original_guards_preserved(self):
        # Parse explicit frozen public source with the same Python AST version.
        # FunctionDef.type_params added in 3.12 must not change this contract.
        frozen_source = r"""def clean_env(extra=None):
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
"""
        expected_nodes = {n.name: n for n in ast.parse(frozen_source).body
                          if isinstance(n, ast.FunctionDef)}
        actual_nodes = {n.name: n for n in ast.parse(native.read_text()).body
                        if isinstance(n, ast.FunctionDef)}
        self.assertEqual(set(expected_nodes), {'clean_env', 'config', 'settings_sql'})
        for name, expected in expected_nodes.items():
            with self.subTest(frozen_function=name):
                self.assertIn(name, actual_nodes)
                self.assertEqual(ast.dump(actual_nodes[name], include_attributes=False),
                                 ast.dump(expected, include_attributes=False),
                                 'Frozen default function changed: ' + name)

        # Exercise only pure helpers, with a synthetic environment. No process,
        # database, real environment value or native proof is evaluated here.
        from types import SimpleNamespace
        controlled_env = {'PATH': '/synthetic/bin', 'PGHOST': 'outside.invalid',
                          'UNAPPROVED_TOKEN': 'synthetic-blocked'}
        clean = extract(native, 'clean_env', {'os': SimpleNamespace(environ=controlled_env)})
        expected_env = {'PATH': '/synthetic/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC'}
        self.assertEqual(clean(), expected_env)
        self.assertEqual(clean({'NODE_PATH': '/synthetic/modules'}),
                         dict(expected_env, NODE_PATH='/synthetic/modules'))
        self.assertEqual(controlled_env, {'PATH': '/synthetic/bin', 'PGHOST': 'outside.invalid',
                                        'UNAPPROVED_TOKEN': 'synthetic-blocked'})
        fallback = extract(native, 'clean_env', {'os': SimpleNamespace(environ={})})
        self.assertEqual(fallback(), {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC'})

        config_text = extract(native, 'config')(15432, 15000)
        self.assertIn('[app]\naddress="127.0.0.1:15000"\n', config_text)
        self.assertIn('[db]\nhost="127.0.0.1"\nport=15432\n', config_text)
        self.assertIn('database="listmonk"\n', config_text)
        import json, re
        settings = {}
        for line in extract(native, 'settings_sql', {'json': json})(15425, 15000).splitlines():
            item = re.fullmatch(r"UPDATE settings SET value='(.*)'::jsonb WHERE key='([^']+)';", line)
            self.assertIsNotNone(item)
            self.assertNotIn(item.group(2), settings)
            settings[item.group(2)] = json.loads(item.group(1).replace("''", "'"))
        self.assertEqual(len(settings['smtp']), 1)
        smtp = settings['smtp'][0]
        for key, value in {'enabled': True, 'host': '127.0.0.1', 'port': 15425,
                           'auth_protocol': 'none', 'username': '', 'password': '',
                           'tls_type': 'none', 'max_msg_retries': 0}.items():
            self.assertEqual(smtp[key], value)
        self.assertEqual(settings['app.root_url'], 'http://127.0.0.1:15000')
        self.assertEqual(settings['messengers'], [])
        self.assertEqual(settings['app.batch_size'], 1)
        self.assertFalse(settings['app.check_updates'])
        self.assertFalse(settings['app.cache_slow_queries'])
        f=(FILES/'tests/segment-regular-native-fixture.cjs').read_text()
        start=f.index(' // A canonical worker now references')
        end=f.index(' if(batch){const result=',start)
        reviewed_exclusion_block=f[start:end]
        self.assertEqual(hashlib.sha256(reviewed_exclusion_block.encode()).hexdigest(),'9e9010c8f6de88f1d43b37bd60b2e5cb8cd87a38894485c37cbedeb78e99cad2')
        self.assertIn('if(!dependencyOnly){',reviewed_exclusion_block)
        self.assertIn('readPermanentExclusionFixture(root)',reviewed_exclusion_block)
        self.assertNotIn('INSERT INTO',reviewed_exclusion_block)
        f=f[:start]+f[end:]
        self.assertEqual(hashlib.sha256(f[f.index('async function prepare'):].encode()).hexdigest(),'c70b18974814a91040e408b0ddcc496e9200998065e5586725cec2e521ce785e')
    def test_ci_complete_proof_after_measured_binary_and_no_push(self):
        s=(FILES/'tools/listmonk-regular-build/proof-source-only.sh').read_text()
        self.assertLess(s.index('--build-manifest'),s.index('--isolated-source-proof'));self.assertIn('--source-dir "$TASK_OUTPUT/package/source/listmonk"',s);self.assertIn('native-functional-proof.json',s)
        for forbidden in ['docker push','image.py','curl','--isolated-proof-authorization']:self.assertNotIn(forbidden,s)
if __name__=='__main__':unittest.main(verbosity=2)
