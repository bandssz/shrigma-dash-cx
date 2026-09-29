#!/usr/bin/env python3
"""Fetch pinned public build inputs and verify modules. Does not build/run Listmonk."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request
import build


def download(url, target, expected, limit=64*1024*1024):
    request=urllib.request.Request(url,headers={'User-Agent':'crm-regular-reproducible-build'})
    with urllib.request.urlopen(request,timeout=45) as response:
        body=response.read(limit+1)
    build.require(len(body)<=limit and hashlib.sha256(body).hexdigest()==expected,'Pinned download drift: '+target.name)
    target.write_bytes(body)


def bootstrap(out, go):
    build.require(not out.exists(),'Use a new input cache')
    out.mkdir(parents=True)
    official=build.module('regular_official_release',build.REPO/'tools/listmonk-ab-build/build.py').LOCK
    download('https://api.github.com/repos/knadh/listmonk/tarball/1b5e8d38c778e869003486d3c38bc7a964661e91',out/'listmonk-upstream.tar.gz',build.SOURCE_SHA)
    download('https://proxy.golang.org/github.com/knadh/smtppool/v2/@v/v2.0.2.zip',out/'smtppool.zip',build.SMTP_ZIP_SHA,128*1024)
    for entry in (official['checksums'],official['releases']['linux_amd64']):
        download('https://github.com/knadh/listmonk/releases/download/v6.1.0/'+entry['name'],out/entry['name'],entry['sha256'])
    source=out/'source';build.extract_source(out/'listmonk-upstream.tar.gz',source)
    env=dict(os.environ,GOTOOLCHAIN='local',GOWORK='off',GOFLAGS='-mod=readonly',GOPROXY='https://proxy.golang.org',GOSUMDB='sum.golang.org')
    for name in ('GOOS','GOARCH'):
        env.pop(name,None)
    subprocess.run([str(go),'mod','download'],cwd=source,env=env,check=True,timeout=600)
    subprocess.run([str(go),'mod','verify'],cwd=source,env=env,check=True,timeout=60)
    print(json.dumps({'status':'PINNED_INPUTS_ONLY','source_sha256':build.SOURCE_SHA,'smtp_zip_sha256':build.SMTP_ZIP_SHA}))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',required=True,type=Path)
    parser.add_argument('--go',required=True,type=Path)
    args=parser.parse_args();bootstrap(args.out.resolve(),args.go.resolve())
