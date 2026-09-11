/* Regras da API de templates (Fase A) sem DOM e sem rede: fetch falso. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const GR=require('../growth-drafts.js');global.GR=GR;
const GTA=require('../growth-templates-api.js');
const FIX=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/growth-templates-contract.synthetic.json'),'utf8'));
const END='https://exemplo.invalid/webhook/crm-template-api-x';
const comEndpoint=extra=>({capabilities:{...FIX.capabilities,endpoints:{templates:END},...extra}});

test('capacidades: ausentes → tudo false; declaradas sem endpoint → nada "pode"; com endpoint → só as true',()=>{
 const nada=GTA.caps({});assert.equal(nada.declaradas,false);assert.deepEqual(Object.values(nada.pode).every(v=>v===false),true);
 const semEnd=GTA.caps({capabilities:FIX.capabilities});
 assert.equal(semEnd.draft,true);assert.equal(semEnd.pode.draft,false);assert.equal(semEnd.semEndpoint,true);
 const ok=GTA.caps(comEndpoint());
 assert.equal(ok.pode.draft,true);assert.equal(ok.pode.validate,true);assert.equal(ok.pode.submit,false);assert.equal(ok.pode.read_content,true);assert.equal(ok.semEndpoint,false);
 const global_=GTA.caps({capabilities:FIX.capabilities},{TEMPLATE_API_URL:END});assert.equal(global_.pode.draft,true); // endpoint por config.js também vale
 assert.equal(GTA.caps({capabilities:{templates:{draft:'true'},endpoints:{templates:'http://inseguro'}}}).pode.draft,false); // string não é true; http não é endpoint
});
test('erros traduzidos por status (R5.7): 401 esquece chave, 409 diz quem/quando, 502 distingue "nada alterado" de incerto',()=>{
 const e=(status,body,rede=false)=>GTA.erro({ok:false,status,body,rede},'submit');
 assert.equal(e(401,FIX.erros['401']).chaveInvalida,true);
 assert.match(e(403,FIX.erros['403']).texto,/capacidade "submit"/);
 const c=e(409,FIX.erros['409']);assert.match(c.texto,/Alterado por chave-exemplo às 09\/09, 16:59 \(versão 4\)\. Recarregue e refaça; nada foi sobrescrito\./);assert.equal(c.conflito.current_version,4);
 assert.match(e(409,{erro:'idempotency_replay_mismatch'}).texto,/idempotência/);
 const v=e(422,FIX.validar_422);assert.equal(v.tipo,'validacao');assert.match(v.texto,/1025 caracteres/);assert.equal(v.erros[0].campo,'corpo');
 assert.match(e(502,FIX.erros['502']).texto,/nada foi alterado\. Tente em 60 s/);
 assert.match(e(502,{erro:'upstream_error'}).texto,/estado incerto/);
 assert.match(e(429,{retry_after:5}).texto,/Tente em 5 s/);
 assert.match(e(0,null,true).texto,/Falha de rede: nada foi confirmado/);
});
test('situação e ações: local → servidor → validado → submetido; conteúdo alterado bloqueia validar/submeter; submit exige validado quando a API valida',()=>{
 const caps=GTA.caps(comEndpoint({templates:{...FIX.capabilities.templates,submit:true}}));
 const r=GR.novo({nome:'a_b',corpo:'Oi {{1}}.',exemplos:{1:'Ana'}});
 assert.equal(GTA.situacao(r).estado,'local');
 let a=GTA.acoes(caps,r);assert.deepEqual([a.salvarServidor,a.validar,a.submeter,a.verificar],[true,false,false,false]);
 r.servidor={draft_id:'d_1',version:1,estado:'rascunho',hash:GTA.hash(GR.conteudo(r))};
 a=GTA.acoes(caps,r);assert.deepEqual([a.validar,a.submeter],[true,false]); // rascunho no servidor: valida, mas não submete sem validar
 r.servidor.estado='validado';a=GTA.acoes(caps,r);assert.equal(a.submeter,true);
 r.corpo='Oi {{1}}!';const s=GTA.situacao(r);assert.equal(s.sujo,true);a=GTA.acoes(caps,r);assert.deepEqual([a.validar,a.submeter,a.salvarServidor],[false,false,true]);
 assert.match(GTA.rotuloEstado(r).texto,/Alterado após salvar no servidor \(v1\)/);
 r.corpo='Oi {{1}}.';r.servidor.estado='submetido';r.servidor.submission_id='s_1';r.servidor.submitted_at='2026-09-11T12:00:00Z';
 a=GTA.acoes(caps,r);assert.deepEqual([a.validar,a.submeter,a.verificar],[false,false,true]);assert.match(GTA.rotuloEstado(r).texto,/Submetido · aguardando Meta desde 11\/09, 09:00/);
 const semValidar=GTA.caps(comEndpoint({templates:{draft:true,validate:false,submit:true}}));
 r.servidor.estado='rascunho';assert.equal(GTA.acoes(semValidar,r).submeter,true); // API que não valida: submeter direto do rascunho no servidor
 assert.equal(GTA.acoes(semValidar,r).validar,false);
});
test('publicado ≠ ativo: só é ativo com workflow do inventário ativo e o modo do template em real; sem mapped_in é desconhecido',()=>{
 const wfs=[{key:'fish_tx',active:true,modes:[{key:'modo_rastreio',value:'real'},{key:'modo_pedido_pago',value:'sombra'}]},{key:'aristo_tx',active:false,modes:[{key:'modo_rastreio',value:'real'}]}];
 const at=GTA.publicadoAtivo({status:'APPROVED',mapped_in:[{workflow_key:'fish_tx',piece:'x',mode_key:'modo_rastreio'}]},wfs);
 assert.equal(at.situacao,'ativo');assert.match(at.rotulo,/ativo em modo real \(fish_tx\)/);
 assert.equal(GTA.publicadoAtivo({status:'APPROVED',mapped_in:[{workflow_key:'fish_tx',piece:'x',mode_key:'modo_pedido_pago'}]},wfs).situacao,'nao_ativo'); // sombra
 assert.equal(GTA.publicadoAtivo({status:'APPROVED',mapped_in:[{workflow_key:'aristo_tx',piece:'x',mode_key:'modo_rastreio'}]},wfs).situacao,'nao_ativo'); // workflow inativo
 assert.equal(GTA.publicadoAtivo({status:'APPROVED',mapped_in:[]},wfs).rotulo,'Publicado · não ativo (sem workflow mapeado)');
 const velho=[{key:'fish_tx',active:true,fieldsValid:true,collection:{current:false,key:'error'},modes:[{key:'modo_rastreio',value:'real'}]}]; // F03: consulta com falha não confirma nada
 const pv=GTA.publicadoAtivo({status:'APPROVED',mapped_in:[{workflow_key:'fish_tx',piece:'x',mode_key:'modo_rastreio'},null]},velho);
 assert.equal(pv.situacao,'desconhecido');assert.equal(pv.rotulo,'Publicado · ativação não confirmada (fish_tx: último modo observado real · consulta com falha)');
 assert.equal(GTA.publicadoAtivo({status:'APPROVED'},wfs).situacao,'desconhecido');
 assert.equal(GTA.publicadoAtivo({status:'PENDING',mapped_in:[]},wfs).situacao,'nao_publicado');
 const r=GR.novo({nome:'x',corpo:'Oi.',servidor:{draft_id:'d',version:2,estado:'publicado',hash:null}});
 assert.equal(GTA.rotuloEstado(r,{workflows:wfs}).texto,'Publicado · não ativo (sem workflow mapeado)'); // rascunho publicado: nada o usa até o manifesto dizer
});
test('cliente: GET leva chave de leitura, POST leva chave de escrita + Idempotency-Key; rede/JSON quebrado nunca lançam; sem endpoint não chama',async()=>{
 const calls=[];const fx=async(url,init)=>{calls.push({url,init});return {status:201,json:async()=>FIX.rascunho_response};};
 const c=GTA.cliente({endpoint:END,fetch:fx,chaveLeitura:'LEITURA',chaveEscrita:'ESCRITA'});
 const l=await c.listar('fish');assert.match(calls[0].url,/\?k=LEITURA&acao=listar&marca=fish$/);assert.equal(l.ok,true);
 await c.listar('todas');assert.doesNotMatch(calls[1].url,/marca=/);
 await c.rascunho(FIX.rascunho_request.rascunho,{idempotency_key:'idem-1',draft_id:'d_1',expected_version:1});
 const body=JSON.parse(calls[2].init.body);assert.equal(body.k,'ESCRITA');assert.equal(body.acao,'rascunho');assert.equal(body.draft_id,'d_1');assert.equal(body.expected_version,1);assert.deepEqual(body.rascunho,FIX.rascunho_request.rascunho);
 assert.equal(calls[2].init.headers['Idempotency-Key'],'idem-1');assert.doesNotMatch(calls[2].url,/LEITURA|ESCRITA/);
 await c.submeter('d_1',1,'submeter','idem-2');const sb=JSON.parse(calls[3].init.body);assert.equal(sb.confirm,'submeter');assert.equal(sb.expected_version,1);
 const quebra=GTA.cliente({endpoint:END,fetch:async()=>{throw new Error('offline');}});assert.deepEqual(await quebra.validar('d',''),{ok:false,status:0,body:null,rede:true});
 const semJson=GTA.cliente({endpoint:END,fetch:async()=>({status:502,json:async()=>{throw new Error('html');}})});assert.deepEqual(await semJson.validar('d',''),{ok:false,status:502,body:null,rede:false});
 const semEnd=GTA.cliente({endpoint:null,fetch:fx});assert.equal((await semEnd.listar()).rede,true);assert.equal(calls.length,4);
});
test('prévia de components é só texto escapado: e-mail nunca injeta body_html; WhatsApp preenche exemplos',()=>{
 const wa=GTA.previaComponents(FIX.listar.templates[0].components);
 assert.match(wa,/Seu pedido saiu/);assert.match(wa,/Olá Ana, o pedido #48213 está a caminho\. Código: XX0000123BR/);assert.match(wa,/↗ Acompanhar pedido/);
 const mail=GTA.previaComponents({subject:'Oi <b>x</b>',body_html:'<script>alert(1)</script><p>Olá</p>',altbody:''});
 assert.doesNotMatch(mail,/<script>|<b>x<\/b>/);assert.match(mail,/&lt;b&gt;x&lt;\/b&gt;/);assert.match(mail,/alert\(1\) Olá/);
 assert.match(GTA.previaComponents(null),/não disponível/);
 assert.match(GTA.previaComponents([{type:'HEADER',format:'IMAGE'},{type:'BODY',text:'x'}]),/\[image\]/);
});
test('hash e idempotência: mesmo conteúdo → mesmo hash; uuid tem formato v4',()=>{
 const a=GR.novo({nome:'n',corpo:'c'}),b=GR.novo({nome:'n',corpo:'c',atualizado_em:'2000-01-01T00:00:00Z'});
 assert.equal(GTA.hash(GR.conteudo(a)),GTA.hash(GR.conteudo(b))); // datas e id local não entram
 assert.notEqual(GTA.hash(GR.conteudo(a)),GTA.hash(GR.conteudo({...a,corpo:'d'})));
 assert.match(GTA.uuid(),/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
