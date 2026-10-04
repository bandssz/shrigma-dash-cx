'use strict';
// Preparo OCI do listener (revisão 5974202110): base fixada por digest, revisão
// exata obrigatória (ARG validado → LABEL e ENV), COPY literal de todos os
// módulos, padrão OFF funcional sem nenhuma variável externa, sem segredo na
// imagem. Sem Docker aqui: a imagem é emulada copiando exatamente o que os COPY
// pedem para um diretório temporário e subindo `main.cjs` com o ENV declarado.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
const ROOT=path.join(__dirname,'..'),SVC='services/crm-template-read',DF=fs.readFileSync(path.join(ROOT,SVC,'Dockerfile'),'utf8');
const lines=DF.split('\n').filter(l=>!/^\s*#/.test(l)).join('\n').replace(/\\\n/g,' ').split('\n').map(l=>l.trim()).filter(Boolean);
const instr=k=>lines.filter(l=>l.toUpperCase().startsWith(k+' '));

test('Dockerfile: digest fixo, ARG sem padrão validado, revisão no LABEL e no ENV, OFF por padrão, COPY literal e sem segredo',()=>{
 assert.match(instr('FROM')[0],/^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}$/);assert.equal(instr('FROM').length,1);
 assert.deepEqual(instr('ARG'),['ARG CRM_TEMPLATE_READ_REVISION'],'sem valor padrão');
 const check=instr('RUN')[0];assert.match(check,/\*\[!0-9a-f\]\*/);assert.match(check,/-eq 40/);
 assert.ok(lines.indexOf(check)<lines.indexOf(instr('LABEL')[0]),'validação antes de qualquer outro passo');
 assert.match(instr('LABEL')[0],/org\.opencontainers\.image\.revision="\$\{CRM_TEMPLATE_READ_REVISION\}"/);
 const env=instr('ENV')[0];assert.match(env,/CRM_TEMPLATE_READ_REVISION=\$\{CRM_TEMPLATE_READ_REVISION\}/);assert.match(env,/CRM_TEMPLATE_READ_ENABLED=false/);
 assert.doesNotMatch(DF,/CRM_PG_(PASSWORD|HOST|USER|DATABASE)|TOKEN|SECRET|KEY=/i,'nada de banco ou segredo na imagem');
 const copies=instr('COPY');assert.ok(copies.every(c=>!/[*?[]/.test(c)),'COPY sem glob');
 const listed=copies.flatMap(c=>c.split(/\s+/).slice(1,-1).filter(x=>!x.startsWith('--')));
 for(const f of listed)assert.ok(fs.existsSync(path.join(ROOT,f)),f);
 const modules=fs.readdirSync(path.join(ROOT,SVC)).filter(f=>f.endsWith('.cjs')).map(f=>SVC+'/'+f).sort();
 assert.deepEqual(listed.filter(f=>f.startsWith(SVC)&&f.endsWith('.cjs')).sort(),modules,'todo módulo do serviço é copiado, nenhum a mais');
 assert.deepEqual(instr('USER'),['USER node']);assert.match(instr('HEALTHCHECK')[0],/\/healthz/);assert.deepEqual(instr('CMD'),['CMD ["node", "main.cjs"]']);
 const lock=JSON.parse(fs.readFileSync(path.join(ROOT,SVC,'package-lock.json'),'utf8'));assert.equal(lock.packages['node_modules/pg'].version,'8.13.1');
});

test('imagem emulada: com só o ENV do Dockerfile sobe OFF, expõe a revisão exata e recusa leitura sem pool',async t=>{
 const REV=(()=>{try{return execFileSync('git',['-C',ROOT,'rev-parse','HEAD'],{encoding:'utf8'}).trim();}catch{return 'f'.repeat(40);}})();
 const app=fs.mkdtempSync(path.join(os.tmpdir(),'crm-template-read-image-'));t.after(()=>fs.rmSync(app,{recursive:true,force:true}));
 const workdir=path.join(app,'app',SVC);fs.mkdirSync(workdir,{recursive:true});
 // Reproduz os COPY: destino './' = WORKDIR; destino absoluto = caminho dentro de /app.
 for(const c of instr('COPY')){const parts=c.split(/\s+/).slice(1).filter(x=>!x.startsWith('--')),dest=parts.pop();
  for(const src of parts){const to=dest==='./'?path.join(workdir,path.basename(src)):path.join(app,dest);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(path.join(ROOT,src),to);}}
 // Sem node_modules: OFF não pode precisar do driver. Ambiente = só o que o ENV declara.
 const env={PATH:process.env.PATH,NODE_ENV:'production',CRM_TEMPLATE_READ_REVISION:REV,CRM_TEMPLATE_READ_ENABLED:'false'};
 const child=spawn(process.execPath,['-e',"const {start}=require('./main.cjs');const s=start(process.env,{port:0,host:'127.0.0.1'});s.app.server.on('listening',()=>console.log('PORT '+s.app.server.address().port));"],{cwd:workdir,env,stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill('SIGTERM'));
 const port=await new Promise((resolve,reject)=>{let out='';child.stdout.on('data',d=>{out+=d;const m=/PORT (\d+)/.exec(out);if(m)resolve(Number(m[1]));});child.on('exit',c=>reject(Error('saiu '+c)));setTimeout(()=>reject(Error('não subiu')),5000);});
 const h=await fetch(`http://127.0.0.1:${port}/healthz`);assert.equal(h.status,200);
 assert.deepEqual(await h.json(),{service:'crm-template-read',contract:'crm-template-read-v1',revision:REV,enabled:false,stopping:false});
 const r=await fetch(`http://127.0.0.1:${port}/template-read?acao=listar&brand=fish&channel=email&offset=0&limit=20`,{headers:{authorization:'Bearer '+'b'.repeat(64)}});
 assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'TEMPLATE_READ_DISABLED'});
 assert.equal(fs.existsSync(path.join(workdir,'node_modules')),false);
});
