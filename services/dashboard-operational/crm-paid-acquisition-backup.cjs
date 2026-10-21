'use strict';
// Metadata backup, not an operation journal. Persist before each business write.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function open(directory,brand){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||!['aristo','fish'].includes(brand))throw Object.assign(Error('PAID_ACQUISITION_BACKUP_UNAVAILABLE'),{code:'PAID_ACQUISITION_BACKUP_UNAVAILABLE',status:503});
 fs.mkdirSync(directory,{recursive:true,mode:0o700});const st=fs.lstatSync(directory);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077))throw Error('PAID_ACQUISITION_BACKUP_UNAVAILABLE');
 const name=brand+'-'+crypto.randomUUID()+'.jsonl',fd=fs.openSync(path.join(directory,name),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);let closed=false;
 const directoryFd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(directoryFd);}finally{fs.closeSync(directoryFd);}
 return {name,append(rows){if(closed)throw Error('PAID_ACQUISITION_BACKUP_CLOSED');for(const row of rows)fs.writeFileSync(fd,JSON.stringify(row)+'\n');fs.fsyncSync(fd);},close(){if(!closed){closed=true;fs.closeSync(fd);}}};
}
function rollback(row){
 if(!['aristo','fish'].includes(row?.brand)||!/^gid:\/\/shopify\/Order\/[1-9][0-9]{0,19}$/.test(row?.orderId)||!row.after||row.after.schema!=='crm-shopify-acquisition-v1')throw Error('PAID_ACQUISITION_BACKUP_INVALID');
 return {sql:"UPDATE public.crm_attribution_order_v2 SET paid_fact=CASE WHEN $3::jsonb='null'::jsonb THEN paid_fact-'acquisition' ELSE jsonb_set(paid_fact,'{acquisition}',$3::jsonb,true) END WHERE brand=$1 AND order_id=$2 AND paid_fact->'acquisition'=$4::jsonb RETURNING order_id",values:[row.brand,row.orderId,JSON.stringify(row.before??null),JSON.stringify(row.after)]};
}
async function read(directory,brand,name,offset=0){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||!['aristo','fish'].includes(brand)||typeof name!=='string'||!new RegExp('^'+brand+'-[a-f0-9-]{36}\\.jsonl$').test(name)||!Number.isSafeInteger(offset)||offset<0||offset>50000)throw Error('PAID_ACQUISITION_BACKUP_INVALID');
 const fd=fs.openSync(path.join(directory,name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const st=fs.fstatSync(fd);if(!st.isFile()||(st.mode&0o077)||st.size>1024*1024*1024){fs.closeSync(fd);throw Error('PAID_ACQUISITION_BACKUP_INVALID');}
 const stream=fs.createReadStream(null,{fd,autoClose:true}),lines=require('node:readline').createInterface({input:stream,crlfDelay:Infinity});let at=0,bytes=0,more=false;const rows=[];
 try{for await(const line of lines){if(at++<offset)continue;if(rows.length===10){more=true;break;}bytes+=Buffer.byteLength(line);if(bytes>4*1024*1024)throw Error('PAID_ACQUISITION_BACKUP_LIMIT');const row=JSON.parse(line);if(row.brand!==brand)throw Error('PAID_ACQUISITION_BACKUP_INVALID');rows.push(row);}}finally{lines.close();stream.destroy();}
 return {brand,name,rows,more,nextOffset:offset+rows.length};
}
module.exports={open,rollback,read};
