'use strict';
// Manual secret input only. No token in argv, shell history, stdout or Git.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),DIR=path.join(ROOT,'.private/github-bootstrap'),FILE=path.join(DIR,'credential.json');
function fail(code){throw Object.assign(new Error(code),{code});}
function hiddenInput(input=process.stdin,output=process.stdout){
 if(!input.isTTY||!output.isTTY)fail('TERMINAL_INTERATIVO_NECESSARIO');
 output.write('Cole o token Shrigma-bootstrap (oculto) e pressione Enter: ');
 return new Promise((resolve,reject)=>{let token='',done=false;const previous=input.isRaw===true;const finish=(error)=>{if(done)return;done=true;input.removeListener('data',data);input.removeListener('error',onerror);input.setRawMode(previous);input.pause();output.write('\n');if(error){token='';reject(error);}else resolve(token);};const onerror=()=>finish(Object.assign(new Error('ENTRADA_INTERROMPIDA'),{code:'ENTRADA_INTERROMPIDA'}));
  function data(chunk){for(const ch of chunk.toString('utf8')){if(ch==='\u0003'||ch==='\u0004')return finish(Object.assign(new Error('CANCELADO'),{code:'CANCELADO'}));if(ch==='\r'||ch==='\n')return finish();if(ch==='\u007f'||ch==='\b')token=token.slice(0,-1);else if(/^[A-Za-z0-9_]$/.test(ch))token+=ch;else return finish(Object.assign(new Error('FORMATO_INVALIDO'),{code:'FORMATO_INVALIDO'}));if(token.length>512)return finish(Object.assign(new Error('FORMATO_INVALIDO'),{code:'FORMATO_INVALIDO'}));}}
  input.setRawMode(true);input.on('data',data);input.once('error',onerror);input.resume();
 });
}
async function validate(token,request=fetch){
 if(typeof token!=='string'||! /^(?:github_pat_|ghp_)[A-Za-z0-9_]{20,500}$/.test(token))fail('FORMATO_INVALIDO');
 const r=await request('https://api.github.com/repos/bandssz/shrigma-dash-cx',{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json'}});
 if(r.status!==200){await r.body?.cancel();fail('GITHUB_HTTP_'+r.status);}const j=await r.json();if(j.full_name!=='bandssz/shrigma-dash-cx')fail('REPOSITORIO_DIFERENTE');return{repository:j.full_name,expiresAtProvider:r.headers.get('github-authentication-token-expiration')||null,repositoryPermissions:j.permissions||null};
}
function assertDirectory(dir){const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)fail('PASTA_PRIVADA_INVALIDA');}
function sealedBackup(bytes,publicKey){const key=crypto.randomBytes(32),iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv),encrypted=Buffer.concat([c.update(bytes),c.final()]);try{return JSON.stringify({schema:'shrigma-secret-backup-v1',algorithm:'RSA-OAEP-SHA256/AES-256-GCM',wrappedKey:crypto.publicEncrypt({key:publicKey,oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')})+'\n';}finally{key.fill(0);}}
function save(token,metadata,{dir=DIR,publicKeyFile=path.join(ROOT,'operacao/runtime/sprint-curto-20261018/consent-job/native-v3/owner-public-key.pem')}={}){
 const parent=path.dirname(dir);if(fs.existsSync(parent)&&fs.lstatSync(parent).isSymbolicLink())fail('PASTA_PRIVADA_INVALIDA');fs.mkdirSync(dir,{recursive:true,mode:0o700});assertDirectory(dir);const file=path.join(dir,'credential.json');let backup=false;
 if(fs.existsSync(file)){const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0)fail('ARQUIVO_PRIVADO_INVALIDO');const bytes=fs.readFileSync(file);try{const encrypted=sealedBackup(bytes,fs.readFileSync(publicKeyFile));fs.writeFileSync(path.join(dir,'before-'+Date.now()+'-'+crypto.randomUUID()+'.sealed.json'),encrypted,{flag:'wx',mode:0o600});backup=true;}finally{bytes.fill(0);}}
 const temporary=path.join(dir,'.credential-'+crypto.randomUUID()),record={schema:'shrigma-github-bootstrap-v1',savedAtUtc:new Date().toISOString(),repository:'bandssz/shrigma-dash-cx',declaredLifetime:'1 year, Felipe20Oct2026',...metadata,token};try{fs.writeFileSync(temporary,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}catch(e){try{fs.unlinkSync(temporary);}catch{}throw e;}
 return{saved:true,path:'.private/github-bootstrap/credential.json',mode:'600',repository:record.repository,expiresAtProvider:record.expiresAtProvider||null,encryptedPreviousBackup:backup,consumersUpdated:false,deployProven:false};
}
async function main(){let token;try{token=(await hiddenInput()).trim();const metadata=await validate(token),result=save(token,metadata);console.log(JSON.stringify(result,null,2));console.log('Salvo. Avise o Codex para concluir consumidores e prova de deploy.');}finally{token='';}}
if(require.main===module)main().catch(e=>{const code=/^[A-Z0-9_]+$/.test(e.code||'')?e.code:'GRAVACAO_NAO_CONFIRMADA';console.error('Nao salvo: '+code+'. Nenhum token foi exibido.');process.exitCode=1;});
module.exports={hiddenInput,validate,save};
