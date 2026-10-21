'use strict';
// Metadata backup, not an operation journal. Persist before each business write.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function open(directory,brand){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||!['aristo','fish'].includes(brand))throw Object.assign(Error('PAID_ACQUISITION_BACKUP_UNAVAILABLE'),{code:'PAID_ACQUISITION_BACKUP_UNAVAILABLE',status:503});
 fs.mkdirSync(directory,{recursive:true,mode:0o700});const st=fs.lstatSync(directory);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077))throw Error('PAID_ACQUISITION_BACKUP_UNAVAILABLE');
 const name=brand+'-'+crypto.randomUUID()+'.jsonl',fd=fs.openSync(path.join(directory,name),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);let closed=false,bytes=0;
 const directoryFd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(directoryFd);}finally{fs.closeSync(directoryFd);}
 return {name,append(rows){if(closed)throw Error('PAID_ACQUISITION_BACKUP_CLOSED');for(const row of rows){const line=JSON.stringify(row),size=Buffer.byteLength(line);if(size>4*1024*1024||bytes+size+1>1024*1024*1024)throw Object.assign(Error('PAID_ACQUISITION_BACKUP_LIMIT'),{code:'PAID_ACQUISITION_BACKUP_LIMIT',status:409});fs.writeFileSync(fd,line+'\n');bytes+=size+1;}fs.fsyncSync(fd);},close(){if(!closed){closed=true;fs.closeSync(fd);}}};
}
function rollback(row){
 if(!['aristo','fish'].includes(row?.brand)||!/^gid:\/\/shopify\/Order\/[1-9][0-9]{0,19}$/.test(row?.orderId)||!row.after||row.after.schema!=='crm-shopify-acquisition-v1')throw Error('PAID_ACQUISITION_BACKUP_INVALID');
 return {sql:"UPDATE public.crm_attribution_order_v2 SET paid_fact=CASE WHEN $3::jsonb='null'::jsonb THEN paid_fact-'acquisition' ELSE jsonb_set(paid_fact,'{acquisition}',$3::jsonb,true) END WHERE brand=$1 AND order_id=$2 AND paid_fact->'acquisition'=$4::jsonb RETURNING order_id",values:[row.brand,row.orderId,JSON.stringify(row.before??null),JSON.stringify(row.after)]};
}
function openRead(directory,brand,name){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||!['aristo','fish'].includes(brand)||typeof name!=='string'||!new RegExp('^'+brand+'-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.jsonl$').test(name))throw Error('PAID_ACQUISITION_BACKUP_INVALID');
 const dir=fs.lstatSync(directory);if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077))throw Error('PAID_ACQUISITION_BACKUP_INVALID');
 const fd=fs.openSync(path.join(directory,name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(!st.isFile()||(st.mode&0o077)||st.size>1024*1024*1024)throw Error('PAID_ACQUISITION_BACKUP_INVALID');return {fd,size:st.size};}catch(e){fs.closeSync(fd);throw e;}
}
function file(directory,brand,name,authorize=()=>{}){
 authorize();const {fd,size}=openRead(directory,brand,name),source=fs.createReadStream(null,{fd,autoClose:true,...(size?{end:size-1}:{})});
 async function* rows(){let pending=Buffer.alloc(0),bytes=0;try{for await(const chunk of source){bytes+=chunk.length;if(bytes>size)throw Error('PAID_ACQUISITION_BACKUP_INVALID');pending=Buffer.concat([pending,chunk]);let end;while((end=pending.indexOf(10))>=0){if(end>4*1024*1024)throw Error('PAID_ACQUISITION_BACKUP_LIMIT');const line=pending.subarray(0,end+1);if(JSON.parse(line.toString('utf8')).brand!==brand)throw Error('PAID_ACQUISITION_BACKUP_INVALID');authorize();yield line;pending=pending.subarray(end+1);}if(pending.length>4*1024*1024)throw Error('PAID_ACQUISITION_BACKUP_LIMIT');}authorize();if(pending.length||bytes!==size)throw Error('PAID_ACQUISITION_BACKUP_INVALID');}finally{source.destroy();}}
 const stream=require('node:stream').Readable.from(rows());stream.on('close',()=>source.destroy());return {stream,size,name};
}
async function read(directory,brand,name,offset=0){
 if(!Number.isSafeInteger(offset)||offset<0||offset>50000)throw Error('PAID_ACQUISITION_BACKUP_INVALID');
 const {fd}=openRead(directory,brand,name);
 const stream=fs.createReadStream(null,{fd,autoClose:true}),lines=require('node:readline').createInterface({input:stream,crlfDelay:Infinity});let at=0,bytes=0,more=false;const rows=[];
 try{for await(const line of lines){if(at++<offset)continue;const size=Buffer.byteLength(line);if(size>4*1024*1024)throw Error('PAID_ACQUISITION_BACKUP_LIMIT');if(rows.length===10||bytes+size>4*1024*1024){more=true;break;}bytes+=size;const row=JSON.parse(line);if(row.brand!==brand)throw Error('PAID_ACQUISITION_BACKUP_INVALID');rows.push(row);}}finally{lines.close();stream.destroy();}
 return {brand,name,rows,more,nextOffset:offset+rows.length};
}
module.exports={open,rollback,read,file};
