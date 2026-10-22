'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const AREAS={growth:'growth',organico:'organico',influs:'influs',afiliados:'influs'},STATES=['Aberto','Em correção','Instalado'],KINDS=['Problema','Melhoria'],MAX_IMAGE=2*1024*1024;
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
function screenshot(value){
 if(value===undefined||value===null)return null;
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join(',')!=='base64,mime'||!['image/png','image/jpeg'].includes(value.mime)||typeof value.base64!=='string'||value.base64.length>Math.ceil(MAX_IMAGE/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64))fail('ISSUE_SCREENSHOT_INVALID');
 const b=Buffer.from(value.base64,'base64');if(b.length<12||b.length>MAX_IMAGE||b.toString('base64')!==value.base64)fail('ISSUE_SCREENSHOT_INVALID');
 const png=b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')),jpeg=b[0]===255&&b[1]===216&&b[2]===255&&b.at(-2)===255&&b.at(-1)===217;
 if(value.mime==='image/png'?!png:!jpeg)fail('ISSUE_SCREENSHOT_INVALID');return {mime:value.mime,bytes:b};
}
function create({db,dbPath,authorize,now=Date.now}={}){
 if(!db||typeof authorize!=='function')fail('ISSUE_CONFIGURATION_REQUIRED',500);
 let migration={schema:'product-issues-v1',created:false,backupCreated:false};
 if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='product_issues'").get()){
  if(dbPath!==':memory:'){
   const dir=path.join(path.dirname(dbPath),'product-issue-backups');fs.mkdirSync(dir,{recursive:true,mode:0o700});if(!fs.lstatSync(dir).isDirectory()||fs.lstatSync(dir).isSymbolicLink())fail('ISSUE_BACKUP_UNAVAILABLE',503);fs.chmodSync(dir,0o700);
   const backup=path.join(dir,'before-product-issues-v1-'+Date.now()+'-'+crypto.randomUUID()+'.sqlite');
   {db.exec("VACUUM INTO '"+backup.replaceAll("'","''")+"'");fs.chmodSync(backup,0o600);migration.backupCreated=true;}
   const st=fs.lstatSync(backup);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size<1)fail('ISSUE_BACKUP_UNAVAILABLE',503);fs.chmodSync(backup,0o600);migration.backupSha256=crypto.createHash('sha256').update(fs.readFileSync(backup)).digest('hex');
  }
  db.exec(`CREATE TABLE product_issues (id TEXT PRIMARY KEY,reporter_id TEXT NOT NULL,brand TEXT NOT NULL,front TEXT NOT NULL,screen TEXT NOT NULL,screen_title TEXT NOT NULL,kind TEXT NOT NULL,message TEXT NOT NULL,state TEXT NOT NULL,responsible TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,screenshot_mime TEXT,screenshot_bytes BLOB)`);migration.created=true;
 }
 const valid=(q)=>{if(!q||!Object.hasOwn(AREAS,q.front)||!['aristo','fish'].includes(q.brand))fail('ISSUE_CONTEXT_INVALID');};
 function access(context,q,admin=false){valid(q);return authorize({...context,...(admin?{admin:true}:{}),area:AREAS[q.front],productFront:q.front,brand:q.brand,edit:false});}
 const present=row=>({id:row.id,reporterUserId:row.reporter_id,brand:row.brand,front:row.front,screen:row.screen,screenTitle:row.screen_title,kind:row.kind,message:row.message,state:row.state,responsible:row.responsible,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),hasScreenshot:!!row.screenshot_mime});
 const columns='id,reporter_id,brand,front,screen,screen_title,kind,message,state,responsible,created_at,updated_at,screenshot_mime';
 function own(context,q){
  if(context.nativeBearer!==undefined)fail('ISSUE_BROWSER_REQUIRED',403);const user=access(context,q);return {user,where:'reporter_id=? AND brand=? AND front=?',params:[user.id,q.brand,q.front]};
 }
 function list(context,q){
  let where,params;const admin=q.scope==='all';if(q.scope!==undefined&&!['all','own'].includes(q.scope))fail('ISSUE_SCOPE_INVALID');
  if(admin){access(context,q,true);where='brand=?';params=[q.brand];}else({where,params}=own(context,q));
  const offset=q.offset===undefined?0:Number(q.offset);if(!Number.isSafeInteger(offset)||offset<0||offset>100000)fail('ISSUE_OFFSET_INVALID');
  const total=Number(db.prepare('SELECT count(*) AS n FROM product_issues WHERE '+where).get(...params).n),rows=db.prepare('SELECT '+columns+' FROM product_issues WHERE '+where+" ORDER BY CASE WHEN state='Instalado' THEN 1 ELSE 0 END, CASE WHEN kind='Problema' THEN 0 ELSE 1 END, created_at DESC,id LIMIT 100 OFFSET ?").all(...params,offset);
  access(context,q,admin);return {schema:'product-issues-v1',brand:q.brand,front:q.front,scope:admin?'all':'own',total,offset,nextOffset:offset+rows.length<total?offset+rows.length:null,records:rows.map(present),migration:{...migration},checkedAt:new Date(now()).toISOString()};
 }
 function createIssue(context,q){
  if(context.method!=='POST')fail('METHOD_DENIED',405);const {user}=own(context,q);
  if(Object.keys(q).some(k=>!['action','brand','front','screen','screenTitle','kind','message','screenshot'].includes(k)))fail('ISSUE_FIELDS_INVALID');
  if(!KINDS.includes(q.kind)||typeof q.message!=='string'||q.message.trim().length<3||q.message.trim().length>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(q.message))fail('ISSUE_MESSAGE_INVALID');
  if(typeof q.screen!=='string'||q.screen.length>1000||/[\r\n\\]/.test(q.screen)||!q.screen.startsWith('/app/')||q.screen.startsWith('//'))fail('ISSUE_SCREEN_INVALID');
  const url=new URL(q.screen,'https://screen.invalid'),prefix=q.front==='growth'?'/app/crm/':'/app/'+q.front+'/';if(url.origin!=='https://screen.invalid'||!(url.pathname.startsWith(prefix)||url.pathname==='/app/pedidos-problemas/'))fail('ISSUE_SCREEN_INVALID');
  if(url.searchParams.has('brand')&&url.searchParams.get('brand')!==q.brand)fail('ISSUE_SCREEN_BRAND_INVALID');
  const title=typeof q.screenTitle==='string'?q.screenTitle.trim():'';if(!title||title.length>160||/[\x00-\x1f]/.test(title))fail('ISSUE_SCREEN_INVALID');
  const image=screenshot(q.screenshot),stamp=now(),id=crypto.randomUUID();access(context,q);
  db.prepare('INSERT INTO product_issues (id,reporter_id,brand,front,screen,screen_title,kind,message,state,responsible,created_at,updated_at,screenshot_mime,screenshot_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,user.id,q.brand,q.front,url.pathname+url.search,title,q.kind,q.message.trim(),'Aberto','Produto',stamp,stamp,image?.mime??null,image?.bytes??null);
  return {record:present(db.prepare('SELECT '+columns+' FROM product_issues WHERE id=?').get(id))};
 }
 function update(context,q){
  if(context.method!=='POST')fail('METHOD_DENIED',405);access(context,q,true);
  if(Object.keys(q).some(k=>!['action','brand','front','id','state','expectedState','responsible'].includes(k))||!STATES.includes(q.state)||!STATES.includes(q.expectedState)||typeof q.responsible!=='string'||q.responsible.trim().length<2||q.responsible.length>100||/[\x00-\x1f]/.test(q.responsible))fail('ISSUE_STATE_INVALID');
  const row=db.prepare('SELECT '+columns+' FROM product_issues WHERE id=? AND brand=?').get(q.id,q.brand);if(!row)fail('ISSUE_NOT_FOUND',404);if(row.state!==q.expectedState)fail('ISSUE_STATE_CHANGED',409);
  const result=db.prepare('UPDATE product_issues SET state=?,responsible=?,updated_at=? WHERE id=? AND brand=? AND state=?').run(q.state,q.responsible.trim(),now(),q.id,q.brand,q.expectedState);if(Number(result.changes)!==1)fail('ISSUE_STATE_CHANGED',409);
  return {previousState:row.state,record:present(db.prepare('SELECT '+columns+' FROM product_issues WHERE id=?').get(q.id))};
 }
 function image(context,q){
  let where,params;if(q.scope==='all'){access(context,q,true);where='brand=?';params=[q.brand];}else({where,params}=own(context,q));
  const row=db.prepare('SELECT screenshot_mime,screenshot_bytes FROM product_issues WHERE id=? AND '+where).get(q.id,...params);if(!row?.screenshot_mime)fail('ISSUE_NOT_FOUND',404);return {mime:row.screenshot_mime,bytes:Buffer.from(row.screenshot_bytes)};
 }
 return Object.freeze({authorize:access,list,create:createIssue,update,image,migration:Object.freeze({...migration})});
}
module.exports={create,screenshot,STATES,KINDS,MAX_IMAGE};
