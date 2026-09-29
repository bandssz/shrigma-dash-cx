#!/usr/bin/env python3
"""Build, export and verify an OCI candidate. No registry push or deployment."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import build

BASE='listmonk/listmonk@sha256:dbecf49c2ea6f3ebf400f2a8f102ec676d6b8a9a948ccbba14320b0a3bcb1999'


def command(args,limit=1024*1024):
    p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=600,check=True)
    build.require(len(p.stdout)+len(p.stderr)<=limit,'Image tool output limit')
    return p.stdout.decode()


def verify_package(package):
    expected_files=set()
    for line in build.read(package/'SHA256SUMS',2*1024*1024).decode().splitlines():
        build.require('  ' in line,'Malformed package inventory')
        expected,relative=line.split('  ',1)
        build.require(re.fullmatch('[0-9a-f]{64}',expected) is not None,'Invalid package digest')
        build.require(relative and not relative.startswith('/') and '..' not in Path(relative).parts
                      and Path(relative).as_posix()==relative and '\\' not in relative
                      and relative!='SHA256SUMS','Unsafe package path')
        build.require(relative not in expected_files,'Duplicate package inventory entry')
        expected_files.add(relative)
        build.require(build.sha(build.read(package/relative))==expected,'Package source drift')
    actual_files=set()
    for p in package.rglob('*'):
        build.require(not p.is_symlink() and (p.is_file() or p.is_dir()),'Unsafe package entry')
        if p.is_file() and p!=package/'SHA256SUMS':actual_files.add(p.relative_to(package).as_posix())
    build.require(expected_files and actual_files==expected_files,'Package inventory mismatch')


def build_image(args):
    build.require(re.fullmatch('[0-9a-f]{40}',args.revision) is not None,'Commit revision required')
    manifest=json.loads(build.read(args.package/'manifest.json'))
    native=json.loads(build.read(args.native_proof))
    binary=build.read(args.package/'candidate/listmonk')
    build.require(manifest['target']=='linux_amd64' and manifest['source_lock_sha256']==build.sha(build.read(build.REPO/'tools/listmonk-regular-build/upstream.lock.json')),'Current Linux package required')
    build.require(manifest['binary_sha256']==build.sha(binary)==native['binary_sha256'] and native['status']=='PASSED_EPHEMERAL_ONLY_NOT_DEPLOYED' and native['cluster_stopped'] is True,'Matching Linux native proof required')
    # Reject added or missing files as well as changed bytes before archiving.
    verify_package(args.package)
    build.require(not args.out.exists(),'Use a fresh image directory')
    args.out.mkdir(parents=True);context=args.out/'context';context.mkdir()
    (context/'listmonk').write_bytes(binary);(context/'listmonk').chmod(0o755)
    source=io.BytesIO()
    with tarfile.open(fileobj=source,mode='w') as archive:
        for p in sorted((args.package/'source').rglob('*')):
            if p.is_dir():continue
            body=build.read(p)
            info=tarfile.TarInfo(p.relative_to(args.package).as_posix());info.size=len(body);info.mode=0o644;info.mtime=build.STAMP
            archive.addfile(info,io.BytesIO(body))
    source_bytes=gzip.compress(source.getvalue(),mtime=build.STAMP)
    (context/'source.tar.gz').write_bytes(source_bytes)
    (context/'LICENSE').write_bytes(build.read(args.package/'LICENSE'))
    (context/'manifest.json').write_bytes(build.read(args.package/'manifest.json'))
    (context/'Dockerfile').write_text('FROM '+BASE+'\nCOPY --chmod=0755 listmonk /listmonk/listmonk\nCOPY source.tar.gz LICENSE manifest.json /usr/share/doc/listmonk-regular/\nLABEL org.opencontainers.image.source="https://github.com/bandssz/shrigma-dash-cx" org.opencontainers.image.revision="'+args.revision+'" org.opencontainers.image.licenses="AGPL-3.0" crm.regular.status="OFF_NOT_DEPLOYED" crm.regular.binary-sha256="'+manifest['binary_sha256']+'"\n')
    tag='crm-regular-build:'+args.revision
    command(['docker','pull','--platform','linux/amd64',BASE])
    command(['docker','build','--platform','linux/amd64','--network=none','--tag',tag,str(context)])
    base=json.loads(command(['docker','image','inspect',BASE]))[0]
    built=json.loads(command(['docker','image','inspect',tag]))[0]
    for key in ('Entrypoint','Cmd','WorkingDir','Env','ExposedPorts','User','Volumes','StopSignal','Healthcheck'):
        build.require(built['Config'].get(key)==base['Config'].get(key),'Inherited runtime config drift: '+key)
    build.require(built['Architecture']=='amd64' and built['Os']=='linux','Wrong image platform')
    command(['skopeo','copy','docker-daemon:'+tag,'oci:'+str(args.out/'oci')+':candidate'])
    imported='crm-regular-oci-verified:'+args.revision
    command(['skopeo','copy','oci:'+str(args.out/'oci')+':candidate','docker-daemon:'+imported])
    index=json.loads(build.read(args.out/'oci/index.json'));build.require(len(index['manifests'])==1,'Single manifest required')
    descriptor=index['manifests'][0]
    def blob(desc):
        digest=desc['digest'];build.require(re.fullmatch('sha256:[0-9a-f]{64}',digest) is not None,'Invalid OCI digest')
        body=build.read(args.out/'oci/blobs/sha256'/digest.split(':')[1],128*1024*1024)
        build.require(len(body)==desc['size'] and 'sha256:'+build.sha(body)==digest,'OCI content drift');return body
    oci_manifest=json.loads(blob(descriptor));config=json.loads(blob(oci_manifest['config']))
    for layer in oci_manifest['layers']:blob(layer)
    actual=json.loads(command(['docker','image','inspect',imported]))[0]
    build.require(actual['Id']==oci_manifest['config']['digest'] and actual['RootFS']['Layers']==config['rootfs']['diff_ids'],'Imported OCI identity mismatch')
    for key in ('Entrypoint','Cmd','WorkingDir','Env','ExposedPorts','User','Volumes','StopSignal','Healthcheck'):
        build.require(actual['Config'].get(key)==base['Config'].get(key),'OCI runtime config drift: '+key)
    container=command(['docker','create','--network=none','--entrypoint','/bin/true',actual['Id']]).strip()
    try:
        extracted=args.out/'verified-listmonk';command(['docker','cp',container+':/listmonk/listmonk',str(extracted)])
        build.require(build.sha(build.read(extracted))==manifest['binary_sha256'],'OCI executable differs from native proof')
        extracted.unlink()
    finally:command(['docker','rm',container])
    version=command(['docker','run','--rm','--network=none','--entrypoint','/listmonk/listmonk',actual['Id'],'--version'],16384)
    build.require('v6.1.0' in version,'OCI executable version unconfirmed')
    shutil.copyfile(args.package/'manifest.json',args.out/'package-manifest.json');shutil.copyfile(args.native_proof,args.out/'native-proof.json')
    shutil.copyfile(context/'source.tar.gz',args.out/'source.tar.gz');shutil.copyfile(context/'LICENSE',args.out/'LICENSE')
    shutil.rmtree(context)
    report={'schema':'crm-regular-oci-v1','status':'VERIFIED_IMAGE_OFF_NOT_DEPLOYED','revision':args.revision,'base_image':BASE,'manifest_digest':descriptor['digest'],'config_digest':oci_manifest['config']['digest'],'binary_sha256':manifest['binary_sha256'],'source_sha256':build.sha(source_bytes),'native_proof_sha256':build.sha(build.read(args.native_proof)),'source_lock_sha256':manifest['source_lock_sha256'],'runtime_config_preserved':True,'oci_binary_matches_native_proof':True,'version_command_network_none':True,'registry_push':False,'production_changed':False}
    (args.out/'image-proof.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for n in ('package','native-proof','out'):p.add_argument('--'+n,required=True,type=Path)
    p.add_argument('--revision',required=True);a=p.parse_args()
    a.package=a.package.resolve();a.native_proof=a.native_proof.resolve();a.out=a.out.resolve();build_image(a)
