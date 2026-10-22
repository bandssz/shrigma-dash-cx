import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Store} from './store.mjs';

function privateJSON(file,value){fs.writeFileSync(file,JSON.stringify(value),{mode:0o600,flag:'wx'});}
export function settings(env=process.env){
  const environment=env.ENVIRONMENT;
  if(!['test','production'].includes(environment))throw Error('ENVIRONMENT_REQUIRED');
  const u=new URL(env.PUBLIC_ORIGIN);
  if(u.origin!==env.PUBLIC_ORIGIN||u.username||u.password||u.protocol!=='https:'&&!(environment==='test'&&u.hostname==='127.0.0.1'&&u.protocol==='http:'))throw Error('PUBLIC_ORIGIN_REFUSED');
  const data=path.resolve(env.DATA_DIRECTORY??'/data');
  if(!env.OAUTH_CLIENT_ID||!/^[a-z0-9_-]{8,100}$/.test(env.OAUTH_CLIENT_ID))throw Error('OAUTH_CLIENT_ID_REQUIRED');
  return{environment,origin:u.origin,data,clientId:env.OAUTH_CLIENT_ID,upstream:environment==='production'?'https://email.shrigma.com.br':env.LISTMONK_TEST_ORIGIN,port:Number(env.PORT??3000)};
}
export function initialize(config,adminToken,ownerPublicKey){
  fs.mkdirSync(config.data,{recursive:true,mode:0o700});
  const secretsFile=path.join(config.data,'secrets.json'),dbFile=path.join(config.data,'ledger.sqlite');
  if(fs.existsSync(secretsFile)||fs.existsSync(dbFile)){
    if(!fs.existsSync(secretsFile)||!fs.existsSync(dbFile))throw Error('PARTIAL_INITIALIZATION_REFUSED');
    return;
  }
  let ownerEnrollment;
  if(!adminToken&&ownerPublicKey){
    const key=crypto.createPublicKey(Buffer.from(ownerPublicKey,'base64'));
    if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<3072)throw Error('OWNER_PUBLIC_KEY_REFUSED');
    adminToken=crypto.randomBytes(32).toString('base64url');
    ownerEnrollment={algorithm:'RSA-OAEP-SHA256',ciphertext:crypto.publicEncrypt({key,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(adminToken)).toString('base64')};
  }
  if(typeof adminToken!=='string'||!/^[A-Za-z0-9_-]{43,}$/.test(adminToken))throw Error('OWNER_TOKEN_OR_PUBLIC_KEY_REQUIRED');
  const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk=privateKey.export({format:'jwk'});jwk.use='sig';jwk.alg='RS256';jwk.kid=crypto.randomUUID();
  const secret={environment:config.environment,origin:config.origin,clientId:config.clientId,key:crypto.randomBytes(32).toString('base64'),cookieKeys:[crypto.randomBytes(48).toString('base64url')],jwks:{keys:[jwk]},adminSha:crypto.createHash('sha256').update(adminToken).digest('hex'),...(ownerEnrollment?{ownerEnrollment}:{} )};
  privateJSON(secretsFile,secret);
  const store=new Store(dbFile,Buffer.from(secret.key,'base64'),{initialize:true,environment:config.environment});
  store.audit('administrator',null,'initialize',null,'succeeded',{ledgerId:store.meta('ledger_id'),firstRealUseEnabled:false});store.close();
}
export function open(config){
  const file=path.join(config.data,'secrets.json');
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw Error('SECRET_FILE_PERMISSIONS_REFUSED');
  const secret=JSON.parse(fs.readFileSync(file,'utf8'));
  if(secret.environment!==config.environment||secret.origin!==config.origin||secret.clientId!==config.clientId)throw Error('ENVIRONMENT_IDENTITY_CHANGED');
  const store=new Store(path.join(config.data,'ledger.sqlite'),Buffer.from(secret.key,'base64'),{environment:config.environment});
  return{store,secret};
}
