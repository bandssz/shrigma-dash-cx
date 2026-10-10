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
        new=ast.parse(native.read_text())
        expected={'clean_env': '3cf75c11f922cc62ced050287138fa8779ce577dc42b20f554daa0fc4cbb7fd6', 'config': '5f47f942493d529226c09decb00e1c0a7071c16e5d38ae511b4c2feb3a2a2a08', 'settings_sql': '81707546e7997ccf521b141f869df81dbfcf384b8bdb8ac302e8fa3ccfe8cca2'}
        for name,digest in expected.items():
            n=next(n for n in new.body if isinstance(n,ast.FunctionDef) and n.name==name)
            self.assertEqual(hashlib.sha256(ast.dump(n).encode()).hexdigest(),digest)
        f=(FILES/'tests/segment-regular-native-fixture.cjs').read_text()
        self.assertEqual(hashlib.sha256(f[f.index('async function prepare'):].encode()).hexdigest(),'c70b18974814a91040e408b0ddcc496e9200998065e5586725cec2e521ce785e')
    def test_ci_complete_proof_after_measured_binary_and_no_push(self):
        s=(FILES/'tools/listmonk-regular-build/proof-source-only.sh').read_text()
        self.assertLess(s.index('--build-manifest'),s.index('--isolated-source-proof'));self.assertIn('--source-dir "$TASK_OUTPUT/package/source/listmonk"',s);self.assertIn('native-functional-proof.json',s)
        for forbidden in ['docker push','image.py','curl','--isolated-proof-authorization']:self.assertNotIn(forbidden,s)
if __name__=='__main__':unittest.main(verbosity=2)
