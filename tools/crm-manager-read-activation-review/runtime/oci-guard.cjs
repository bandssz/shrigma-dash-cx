'use strict';
const fs=require('node:fs');
function fail(){throw Error('READ_RUNTIME_NATIVE_OCI_REFUSED');}
function guard({proc=process,f=fs}={}){
 if(proc.platform!=='linux'||proc.getuid()!==1000||proc.getgid()!==1000||proc.versions.node.split('.')[0]!=='22'||proc.env.READ_RUNTIME_NATIVE_OCI_PROOF!=='1'||!/^shrigma-read-runtime-[0-9a-f]{16}$/.test(proc.env.READ_RUNTIME_CLUSTER||''))fail();
 const status=f.readFileSync('/proc/self/status','utf8');for(const k of ['CapEff','CapPrm','CapBnd'])if(!new RegExp('^'+k+':\\s*0+$','m').test(status))fail();if(!/^NoNewPrivs:\s*1$/m.test(status))fail();
 const integer=s=>{if(!/^[1-9][0-9]*$/.test(s.trim()))fail();return BigInt(s.trim());};
 if(integer(f.readFileSync('/sys/fs/cgroup/memory.max','utf8'))>335544320n||integer(f.readFileSync('/sys/fs/cgroup/pids.max','utf8'))>64n)fail();
 const cpu=f.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim().split(/\s+/);if(cpu.length!==2||integer(cpu[0])*100n>integer(cpu[1])*35n)fail();
 const mounts=f.readFileSync('/proc/self/mountinfo','utf8').split('\n').filter(Boolean).map(l=>l.split(' '));
 for(const [point,wanted]of [['/','ro'],['/proof','ro'],['/runtime-proof','rw']]){const matches=mounts.filter(p=>p[4]===point);if(matches.length!==1||!matches[0][5].split(',').includes(wanted)||point==='/runtime-proof'&&matches[0][matches[0].indexOf('-')+1]==='tmpfs')fail();}
 if(mounts.some(p=>/docker\.sock|\.ssh|\.aws/.test(p[4])))fail();
 const st=f.lstatSync('/runtime-proof');if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==1000||st.gid!==1000||(st.mode&0o7777)!==0o700||f.readdirSync('/runtime-proof').length!==0)fail();
 return true;
}
module.exports=Object.freeze({guard});
