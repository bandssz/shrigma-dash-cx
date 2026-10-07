'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{Readable,Writable}=require('node:stream');
const {createAuth}=require('../services/dashboard-operational/auth.cjs'),{createNativeMcp}=require('../services/dashboard-operational/crm-native-mcp.cjs');
const {handleDatabaseOperator}=require('../services/dashboard-operational/native-database-operator.cjs'),{canonical,RESOURCE}=require('../services/dashboard-operational/native-database-vault.cjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
async function fixture(enabled=true){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-db-custody-')),dbPath=path.join(dir,'identity.sqlite'),host='manager.synthetic.invalid',origin='https://'+host;
 const opts={dbPath,managerHost:host,areaHosts:{growth:'crm.synthetic.invalid',organico:'organic.synthetic.invalid',influs:'affiliate.synthetic.invalid'},allowedEmailDomains:['synthetic.invalid'],bootstrapAdminEmail:'master@synthetic.invalid',bootstrapTokenSha256:sha('local-bootstrap'),encryptionKey:crypto.randomBytes(32).toString('hex'),crmNativeEnabled:true,crmNativeDatabaseEnabled:enabled};
 let auth=createAuth(opts);await auth.completeBootstrap({email:opts.bootstrapAdminEmail,token:'local-bootstrap',password:'Synthetic-Only-Password-2026!',host,origin});
 const login=await auth.login({email:opts.bootstrapAdminEmail,password:'Synthetic-Only-Password-2026!',host,origin}),ctx={cookieHeader:login.cookie.split(';')[0],host,origin,method:'POST',csrf:login.csrf},ownerId=auth.session(ctx).user.id;
 return {dir,dbPath,host,origin,opts,ctx,ownerId,get auth(){return auth;},restart(){auth.close();auth=createAuth(opts);},close(){auth.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
const password='Synthetic-Database-Only-Secret-2026!';
const bind=f=>f.auth.nativeDatabaseVault.bind({context:f.ctx,username:'synthetic_pg_owner',password,privateNetwork:true});
const denied=(fn,code)=>assert.throws(fn,e=>e.code===code);
function admission(profile,phase='connect'){const {password,...pub}=profile;return {phase,ownerId:pub.ownerId,profileRevision:pub.revision,credentialBindingHash:sha(canonical(pub)),resourceHash:sha(canonical(RESOURCE)),purpose:'read-only-migration-inventory',...(phase==='catalog'?{peer:{database:'listmonk',sessionRole:profile.username,currentRole:profile.username,engine:170011}}:{})};}
async function operator(f,body,ctx=f.ctx){
 const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='POST';req.headers={'content-type':'application/json'};
 const chunks=[],res=new Writable({write(c,_e,done){chunks.push(Buffer.from(c));done();}});res.setHeader=()=>{};
 await handleDatabaseOperator({req,res,url:new URL('/auth/native-database-settings',f.origin),ctx,auth:f.auth,managerHost:f.host});
 return JSON.parse(Buffer.concat(chunks).toString());
}
test('private database custody is default OFF and does not add database profile tables',async()=>{const f=await fixture(false);try{assert.equal(f.auth.nativeDatabaseVault,undefined);const d=new DatabaseSync(f.dbPath);assert.equal(d.prepare("SELECT count(*) n FROM sqlite_master WHERE name='shrigma_native_database_credential_v1'").get().n,0);d.close();}finally{f.close();}});
test('binding requires original browser Master Origin and CSRF; native self-binding is refused',async()=>{const f=await fixture();try{
 denied(()=>f.auth.nativeDatabaseVault.bind({context:{...f.ctx,csrf:'bad'},username:'synthetic_pg_owner',password,privateNetwork:true}),'CSRF_DENIED');
 const key=f.auth.nativeConnections.issue({context:f.ctx,brands:['fish'],scopes:['db.inspect']});
 denied(()=>f.auth.nativeDatabaseVault.bind({context:{...f.auth.nativeConnections.context(key.token),method:'POST'},username:'synthetic_pg_owner',password,privateNetwork:true}),'NATIVE_BROWSER_CONSENT_REQUIRED');
 denied(()=>f.auth.nativeDatabaseVault.bind({context:f.ctx,username:'invalid\nrole',password,privateNetwork:true}),'DB_PRIVATE_INPUT_REFUSED');
 denied(()=>f.auth.nativeDatabaseVault.bind({context:f.ctx,username:'synthetic_pg_owner',password,privateNetwork:false}),'DB_PRIVATE_INPUT_REFUSED');
}finally{f.close();}});
test('private password persists encrypted with MAC in original identity file and is absent from public responses/audit',async()=>{const f=await fixture();try{
 const value=bind(f);assert.equal(value.linked,true);assert.equal(JSON.stringify(value).includes(password),false);const d=new DatabaseSync(f.dbPath),r=d.prepare('SELECT * FROM shrigma_native_database_credential_v1').get();
 assert.equal(JSON.stringify(r).includes(password),false);assert.match(r.encrypted_credential,/^v1\./);assert.equal(JSON.stringify(d.prepare('SELECT * FROM shrigma_native_database_credential_audit_v1').all()).includes(password),false);d.close();
 f.restart();const privateValue=f.auth.nativeDatabaseVault.getPrivateCredential({ownerId:f.ownerId});assert.equal(privateValue.password,password);assert.deepEqual(privateValue.resource,RESOURCE);
}finally{f.close();}});
test('inspection admission binds actual owner/profile/resource and rejects credential drift and an unproved peer',async()=>{const f=await fixture();try{
 bind(f);const p=f.auth.nativeDatabaseVault.getPrivateCredential({ownerId:f.ownerId}),a=admission(p);assert.equal(f.auth.nativeDatabaseVault.admitInspection(a).admitted,true);
 assert.equal(f.auth.nativeDatabaseVault.admitInspection(admission(p,'catalog')).admitted,true);
 denied(()=>f.auth.nativeDatabaseVault.admitInspection({...admission(p,'catalog'),peer:{database:'foreign',sessionRole:p.username,currentRole:p.username,engine:170011}}),'DB_AUTHENTICATED_PEER_REFUSED');
 bind(f);denied(()=>f.auth.nativeDatabaseVault.admitInspection(a),'DB_INSPECTION_ADMISSION_CHANGED');
 denied(()=>f.auth.nativeDatabaseVault.getPrivateCredential({ownerId:'forged-owner'}),'DB_ORIGINAL_MASTER_REQUIRED');
}finally{f.close();}});
test('ciphertext tampering refuses inspection; revocation immediately removes private access without changing CRM credentials',async()=>{const f=await fixture();try{
 bind(f);const d=new DatabaseSync(f.dbPath);d.prepare('UPDATE shrigma_native_database_credential_v1 SET encrypted_credential=?').run('tampered');d.close();denied(()=>f.auth.nativeDatabaseVault.getPrivateCredential({ownerId:f.ownerId}),'DB_PRIVATE_CREDENTIAL_INTEGRITY');
}finally{f.close();}
const f2=await fixture();try{bind(f2);const key=f2.auth.nativeConnections.issue({context:f2.ctx,brands:['fish'],scopes:['crm.read']});f2.auth.nativeDatabaseVault.revoke(f2.ctx);denied(()=>f2.auth.nativeDatabaseVault.getPrivateCredential({ownerId:f2.ownerId}),'DB_PRIVATE_CREDENTIAL_REQUIRED');assert.equal(f2.auth.nativeConnections.authenticate(key.token).userId,f2.ownerId);}finally{f2.close();}});
test('original browser consent extends only db.inspect on the same bearer and leaves CRM scope/brand/expiry unchanged',async()=>{const f=await fixture();try{
 const key=f.auth.nativeConnections.issue({context:f.ctx,brands:['fish'],scopes:['crm.read']}),before=f.auth.nativeConnections.authenticate(key.token);bind(f);
 const out=await operator(f,{action:'authorize-inspection',connectionId:key.connection.id});assert.equal(out.inspectionAuthorized,true);assert.equal(out.installationAuthorized,false);
 const after=f.auth.nativeConnections.authenticate(key.token,{scope:'db.inspect'});assert.deepEqual(after.brands,before.brands);assert.equal(after.expiresAt,before.expiresAt);assert.equal(after.id,before.id);assert.equal(after.scopes.includes('crm.read'),true);
 denied(()=>f.auth.nativeConnections.authenticate(key.token,{scope:'db.install'}),'NATIVE_SCOPE_DENIED');
 const native={...f.auth.nativeConnections.context(key.token),method:'POST'};denied(()=>f.auth.nativeConnections.permitInspection({context:native,connectionId:key.connection.id}),'NATIVE_BROWSER_CONSENT_REQUIRED');
 await operator(f,{action:'authorize-inspection',connectionId:key.connection.id});const d=new DatabaseSync(f.dbPath);assert.equal(d.prepare('SELECT count(*) n FROM crm_native_inspection_consent_v1').get().n,1);d.close();
 f.auth.nativeConnections.revoke({context:f.ctx,connectionId:key.connection.id});denied(()=>f.auth.nativeConnections.permitInspection({context:f.ctx,connectionId:key.connection.id}),'NATIVE_CONNECTION_NOT_FOUND');
}finally{f.close();}});
test('private operator never echoes a supplied password and refuses alternate target/SQL/issuer fields',async()=>{const f=await fixture();try{
 const out=await operator(f,{action:'bind',username:'synthetic_pg_owner',password,privateNetwork:true});assert.equal(out.linked,true);assert.equal(JSON.stringify(out).includes(password),false);
 for(const extra of [{host:'foreign'},{sql:'DROP DATABASE listmonk'},{issuer:'forged'}])await assert.rejects(operator(f,{action:'bind',username:'synthetic_pg_owner',password,privateNetwork:true,...extra}),e=>e.code==='ACTION_DENIED');
 const status=await operator(f,{action:'status'});assert.equal(status.database.sqlInstallerEnabled,false);assert.equal(JSON.stringify(status).includes(password),false);
}finally{f.close();}});
test('MCP database invocation passes authenticated owner separately from untrusted arguments and respects original scope',async()=>{const f=await fixture();try{
 const key=f.auth.nativeConnections.issue({context:f.ctx,brands:['fish'],scopes:['db.inspect']});let seen;
 const m=createNativeMcp({auth:f.auth,managerHost:f.host,invoke:async()=>assert.fail(),installer:{inspect:async(q,context)=>{seen={q,context};return {readOnly:true,sqlInstallerEnabled:false};}}});
 const out=await m.call('db_inspect',{},key.token);assert.equal(out.status,200);assert.deepEqual(seen.q,{});assert.deepEqual(seen.context,{ownerId:f.ownerId,connectionId:key.connection.id});
 await assert.rejects(m.call('db_inspect',{ownerId:'forged'},key.token),e=>e.code==='NATIVE_ARGUMENTS_INVALID');
}finally{f.close();}});
