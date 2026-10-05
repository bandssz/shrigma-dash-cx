'use strict';
const fs=require('node:fs'),path=require('node:path'),A=require('./activation.cjs'),{intent}=require('./runtime.cjs');
function refuse(){throw Error('READ_ACTIVATION_JOURNAL_REFUSED');}
function exact(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))refuse();}
function createJournal(directory,{uid=1000}={}){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||path.resolve(directory)!==directory||!Number.isSafeInteger(uid)||uid<0)refuse();
 const root=fs.lstatSync(directory);if(!root.isDirectory()||root.isSymbolicLink()||root.uid!==uid||(root.mode&0o777)!==0o700||fs.realpathSync(directory)!==directory)refuse();
 function syncDir(dir){const fd=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 function checkedDir(id){if(!/^[0-9a-f-]{36}$/.test(id))refuse();const dir=path.join(directory,id),st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==uid||(st.mode&0o777)!==0o700||fs.realpathSync(dir)!==dir)refuse();return dir;}
 function write(dir,name,value){const data=Buffer.from(JSON.stringify(value)+'\n');if(data.length>4096)refuse();const fd=fs.openSync(path.join(dir,name),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDir(dir);}
 function read(dir,name){const fd=fs.openSync(path.join(dir,name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(!st.isFile()||st.uid!==uid||(st.mode&0o777)!==0o600||st.nlink!==1||st.size<2||st.size>4096)refuse();return JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}}
 function event(v){
  if(v?.kind==='dispatch'){exact(v,['kind','backend']);exact(v.backend,['pid','backendStart']);if(!Number.isSafeInteger(v.backend.pid)||v.backend.pid<1||v.backend.pid>2147483647||typeof v.backend.backendStart!=='string'||v.backend.backendStart.length>80||!/^\d{4}-\d\d-\d\d [\d:.]+[+-]\d\d(?::\d\d)?$/.test(v.backend.backendStart))refuse();}
  else if(v?.kind==='commit_ack')exact(v,['kind']);
  else if(v?.kind==='readback'){exact(v,['kind','state','phase']);if(!['confirmed','before_verified','not_dispatched'].includes(v.state)||!['empty','staged','active','disabled'].includes(v.phase))refuse();}
  else refuse();return v;
 }
 function load(id){
  const dir=checkedDir(id),names=fs.readdirSync(dir).sort();if(names.length<1||names.length>12||names.some((n,i)=>n!==String(i).padStart(2,'0')+'.json'))refuse();
  const first=read(dir,names[0]);exact(first,['schema','spec','sourcePins','intent']);
  if(first.schema!=='crm-manager-read-runtime-ledger-v1'||JSON.stringify(first.spec)!==JSON.stringify(A.SPEC)||JSON.stringify(first.sourcePins)!==JSON.stringify(A.PINS)||intent(first.intent).operationId!==id)refuse();
  const events=names.slice(1).map(n=>event(read(dir,n)));let dispatch=false,ack=false;
  for(const e of events){if(e.kind==='dispatch'){if(dispatch||events[0]!==e)refuse();dispatch=true;}else if(e.kind==='commit_ack'){if(!dispatch||ack||events[1]!==e)refuse();ack=true;}}
  return {intent:first.intent,events};
 }
 function create(v){const i=intent(v),dir=path.join(directory,i.operationId);fs.mkdirSync(dir,{mode:0o700});syncDir(directory);write(dir,'00.json',{schema:'crm-manager-read-runtime-ledger-v1',spec:A.SPEC,sourcePins:A.PINS,intent:i});}
 function append(id,value){const e=event(value),h=load(id);if(h.events.length>=11)refuse();if(e.kind==='dispatch'&&h.events.length||e.kind==='commit_ack'&&(h.events.length!==1||h.events[0].kind!=='dispatch'))refuse();const dir=checkedDir(id);write(dir,String(h.events.length+1).padStart(2,'0')+'.json',e);}
 function readDurable(id){const before=load(id),dir=checkedDir(id);for(const name of fs.readdirSync(dir).sort()){const fd=fs.openSync(path.join(dir,name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}syncDir(dir);syncDir(directory);const after=load(id);if(JSON.stringify(before)!==JSON.stringify(after))refuse();return after;}
 return Object.freeze({create,append,load,readDurable});
}
module.exports=Object.freeze({createJournal});
