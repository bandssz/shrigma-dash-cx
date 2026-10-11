#!/usr/bin/env python3
"""Offline Go proof. Extract real pinned production walker bytes; no driver/model stubs."""
import argparse, hashlib, json, os, pathlib, subprocess, tempfile

BEFORE_SHA='efed406bec03bdac69b029d329eff74e7d692dff70ab1b9ee8b547e711be186a'
AFTER_SHA='a7acf51047320c05dee217f2704813b58b9a8d17bbca12a8d23b6ac1a0ea3e80'
WALKER_TEST_SHA='dab81d74dee8d204677831a95b3094367549e92585d2054cfa292b692047fd91'

def source(path, expected):
    data=path.read_bytes()
    if hashlib.sha256(data).hexdigest()!=expected:
        raise RuntimeError('PUBLIC_SOURCE_PIN_REFUSED')
    return data.decode('utf-8')

def closed_region(text, start):
    at=text.index(start)
    end=text.index('\n}\n',at)+3
    return text[at:end]

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--go',required=True)
    parser.add_argument('--repo-root',type=pathlib.Path,default=pathlib.Path(__file__).resolve().parents[2])
    parser.add_argument('--report',type=pathlib.Path)
    args=parser.parse_args()
    root=args.repo_root.resolve()
    before=source(root/'tests/template-nil-native-proof/fixtures/regular_delivery.original.go',BEFORE_SHA)
    after=source(root/'tools/listmonk-regular-build/overlay/listmonk/internal/manager/regular_delivery.go',AFTER_SHA)
    tests=source(root/'tools/listmonk-regular-build/overlay/listmonk/internal/manager/regular_template_nil_test.go',WALKER_TEST_SHA)
    tests=tests[:tests.index('func TestRegularTemplateNilValidationSlots')]
    tests=tests.replace(' "github.com/knadh/listmonk/models"\n','')
    policy_start='var regularForbiddenTemplateFunctions = map[string]struct{}{'
    policy=closed_region(before,policy_start)
    if policy!=closed_region(after,policy_start):
        raise RuntimeError('FORBIDDEN_POLICY_DRIFT')
    with tempfile.TemporaryDirectory(prefix='template-nil-stdlib-') as stage:
        directory=pathlib.Path(stage)
        env=dict(os.environ,GOTOOLCHAIN='local',GOWORK='off',GOPROXY='off',GOSUMDB='off',GOCACHE=str(directory/'cache'))
        version=subprocess.run([args.go,'version'],env=env,capture_output=True,text=True,timeout=15,check=True).stdout.strip()
        if 'go1.26.1 ' not in version:
            raise RuntimeError('GO_RUNTIME_REFUSED')
        results=[]
        for name,text in [('before',before),('after',after)]:
            work=directory/name;work.mkdir()
            (work/'go.mod').write_text('module template-nil-proof\n\ngo 1.26.1\n')
            walker=closed_region(text,'func walkRegularTemplateNode(')
            (work/'walker.go').write_text('package manager\n\nimport "text/template/parse"\n\n'+policy+'\n'+walker)
            (work/'walker_test.go').write_text(tests)
            pattern='^TestRegularTemplateNilWalkerNoElse$' if name=='before' else '^TestRegularTemplateNilWalker'
            result=subprocess.run([args.go,'test','-count=1','-timeout=60s','-run',pattern,'.'],cwd=work,env=env,capture_output=True,text=True,timeout=180)
            output=result.stdout+result.stderr
            if name=='before':
                established=result.returncode!=0 and 'panic:' in output and ('nil pointer dereference' in output or 'invalid memory address' in output)
                if not established:raise RuntimeError('BASELINE_PANIC_NOT_ESTABLISHED')
                results.append({'variant':'before','expectedPanicEstablished':True,'goTestSucceeded':False,'productionWalkerSha256':hashlib.sha256(walker.encode()).hexdigest()})
            else:
                if result.returncode!=0:raise RuntimeError('CANDIDATE_GO_TEST_REFUSED')
                results.append({'variant':'after','goTestSucceeded':True,'productionWalkerSha256':hashlib.sha256(walker.encode()).hexdigest()})
        report={'schema':'template-nil-stdlib-genuine-go-proof-v1','completed':True,'runtime':version,'results':results,
                'realStandardTemplateAST':True,'forbiddenPolicyByteEqual':True,'productionWalkerExtractedByteExact':True,
                'fullManagerValidationTestsExecuted':False,'originalCalls':0,'sqlExecuted':0,'smtpExecuted':0}
        if args.report:args.report.write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report))

if __name__=='__main__':
    main()

