#!/usr/bin/env python3
"""Closed public source/delta admission and directed checks. No production access."""
import hashlib,json,os,pathlib,re,subprocess,sys
ROOT=pathlib.Path(__file__).resolve().parents[2]
CONTRACT=ROOT/'tools/crm-sprint-final-portal/source-contract.json'
BASE='781653e546b08531c0b968aa75fc9edf3409f65f'
def require(value):
 if not value:raise RuntimeError('SOURCE_REFUSED')
def git(*args):
 result=subprocess.run(['git',*args],cwd=ROOT,check=True,capture_output=True,timeout=30)
 require(len(result.stdout)<100000);return result.stdout.decode().strip()
def validate():
 contract=json.loads(CONTRACT.read_text())
 require(set(contract)=={'schema','baseRevision','baseTree','sourceBranch','defaultPublisherEnabled','expectedDeltaPaths','files','tests'})
 require(contract['schema']=='crm-sprint-final-source-contract-v1' and contract['baseRevision']==BASE and contract['baseTree']=='023af67e692e4b63761087725c28aecab6fc752f' and contract['defaultPublisherEnabled'] is False)
 require(contract['sourceBranch']=='codex/dashboard-candidate-crm-fix-20261002')
 require(os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('GITHUB_REPOSITORY')=='bandssz/shrigma-dash-cx' and os.environ.get('GITHUB_EVENT_NAME')=='pull_request' and os.environ.get('SOURCE_HEAD_REF')==contract['sourceBranch'] and os.environ.get('SOURCE_PR')=='214' and os.environ.get('SOURCE_REPOSITORY')=='bandssz/shrigma-dash-cx')
 head=git('rev-parse','HEAD');require(head==os.environ.get('SOURCE_REVISION') and re.fullmatch('[a-f0-9]{40}',head) and head!=BASE)
 require(git('rev-parse',BASE+'^{tree}')==contract['baseTree'])
 git('merge-base','--is-ancestor',BASE,head)
 require(git('diff','--name-only')=='' and git('diff','--cached','--name-only')=='')
 changed=git('diff','--name-only','--no-renames',BASE,head).splitlines()
 require(len(changed)==len(set(changed)) and sorted(changed)==sorted(contract['expectedDeltaPaths']))
 require(sorted(contract['files'])==sorted(path for path in changed if path!='tools/crm-sprint-final-portal/source-contract.json'))
 for name,record in contract['files'].items():
  require(name in changed and set(record)=={'bytes','sha256'} and re.fullmatch('[A-Za-z0-9._/-]+',name) and '..' not in pathlib.PurePosixPath(name).parts)
  file=ROOT/name;require(file.is_file() and not file.is_symlink());data=file.read_bytes()
  require(len(data)==record['bytes'] and hashlib.sha256(data).hexdigest()==record['sha256'])
 require(contract['tests'] and len(contract['tests'])==len(set(contract['tests'])))
 for name in contract['tests']:
  require(re.fullmatch('(tests|services/dashboard-operational)/[A-Za-z0-9._-]+\.test\.cjs',name) and (ROOT/name).is_file() and not (ROOT/name).is_symlink())
 return contract,head
try:
 require(len(sys.argv)==2 and sys.argv[1] in ['delta','test'])
 contract,head=validate()
 if sys.argv[1]=='test':
  result=subprocess.run(['node','--test','--test-concurrency=2','--test-timeout=120000',*contract['tests']],cwd=ROOT,timeout=300)
  require(result.returncode==0)
 else:
  print(json.dumps({'schema':'crm-sprint-final-source-delta-proof-v1','baseRevision':BASE,'sourceRevision':head,'changedFiles':len(contract['files']),'tests':contract['tests'],'defaultPublisherEnabled':False},sort_keys=True))
except BaseException:
 raise SystemExit('SOURCE_REFUSED:'+sys.argv[-1])
