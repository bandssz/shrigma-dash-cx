'use strict';
// Leitura de templates com marca obrigatória (agente N). PGlite: um banco por teste.
// Prova a proposta SQL NÃO executada n8n/growth/crm-template-read-access.sql:
// zero efeito, isolamento de marca, principal individual e papel sem tabelas.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const X=require('./claude-template-read-fixture.cjs'),B=require('../services/dashboard-operational/crm-template-read-bridge.cjs');
async function fixture(t){const db=new PGlite();t.after(()=>db.close());await X.install(db);return db;}
// Sessão do papel de leitura: READ ONLY, papel sem tabelas, ROLLBACK sempre.
async function asReader(db,sql,args=[],{readOnly=true}={}){
 await db.query(readOnly?'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY':'BEGIN');
 try{await db.query('SET LOCAL ROLE crm_template_reader');const r=await db.query(sql,args);const x=(await db.query('SELECT txid_current_if_assigned() AS x')).rows[0].x;assert.equal(x,null,'nenhum xid atribuído');return r.rows;}
 finally{await db.query('ROLLBACK');}
}
const call=async(db,fn,args)=>(await asReader(db,`SELECT crm_template_read.${fn}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS r`,args))[0].r;
const err=async(p,code)=>{await assert.rejects(p,e=>(e.message||'').includes(code)||e.code===code,code);};
const accepts=(query,body)=>{const d=B.decision('templates','GET',new URLSearchParams(query));B.responseShape(d,JSON.parse(JSON.stringify(body)));return true;};

test('listar: só e-mail registrado da marca pedida, nas duas marcas, paginado e aceito pela ponte; zero efeito',async t=>{
 const db=await fixture(t),before=await X.snapshot(db);
 const fish=await call(db,'listar',[X.KEY,'fish',0,20]);
 assert.deepEqual(fish.templates.map(x=>x.id),['1','6','8'],'sem legado sem registro, ambíguo, olivas, clone interno ou outra marca');
 assert.ok(fish.templates.every(x=>x.brand==='fish'&&x.channel==='email'&&x.key==='email.template.'+x.id));
 const [t1,t6,t8]=fish.templates;
 assert.equal(t1.draft_id,'d_fish_1');assert.equal(t1.components.subject,'Assunto 1');assert.match(t1.content_hash,/^[a-f0-9]{64}$/);assert.equal(t1.content_available,true);
 assert.equal(t6.content_available,false);assert.equal(t6.components,null,'corpo acima de 400 000 não é truncado nem enviado');
 assert.equal(t8.draft_id,null,'dois rascunhos registrados: vínculo não é escolhido');
 assert.equal(fish.total,3);assert.equal(fish.next_offset,null);assert.equal(fish.coverage,'registered_email_only');assert.equal(fish.schedule_proof,false);
 assert.ok(accepts({acao:'listar',marca:'fish'},fish));
 const aristo=await call(db,'listar',[X.KEY,'aristo',0,20]);assert.deepEqual(aristo.templates.map(x=>x.id),['2','9']);assert.ok(accepts({acao:'listar',marca:'aristo',canal:'email'},aristo));
 // A resposta de uma marca nunca passa como da outra.
 assert.throws(()=>accepts({acao:'listar',marca:'aristo'},fish),{code:'TEMPLATE_READ_RESPONSE_DENIED'});
 const p1=await call(db,'listar',[X.KEY,'fish',0,2]),p2=await call(db,'listar',[X.KEY,'fish',2,2]);
 assert.deepEqual([p1.templates.map(x=>x.id),p1.next_offset,p2.templates.map(x=>x.id),p2.next_offset],[['1','6'],2,['8'],null]);
 assert.ok(accepts({acao:'listar',marca:'fish',offset:'0',limit:'2'},p1));assert.ok(accepts({acao:'listar',marca:'fish',offset:'2',limit:'2'},p2));
 for(const [b,o,l,code] of [['olivas',0,20,'CRM_TEMPLATE_READ_BRAND'],['todas',0,20,'CRM_TEMPLATE_READ_BRAND'],[null,0,20,'CRM_TEMPLATE_READ_BRAND'],['fish',-1,20,'CRM_TEMPLATE_READ_PAGE'],['fish',0,51,'CRM_TEMPLATE_READ_PAGE'],['fish',0,0,'CRM_TEMPLATE_READ_PAGE']])
  await err(call(db,'listar',[X.KEY,b,o,l]),code);
 assert.deepEqual(await X.snapshot(db),before,'nenhuma linha, xmin ou xmax mudou');
});

test('histórico e submissão: marca do rascunho, outra marca vira "não encontrado", nada consulta o provedor',async t=>{
 const db=await fixture(t),before=await X.snapshot(db);
 const h=await call(db,'historico',[X.KEY,'fish','d_fish_1']);
 assert.deepEqual(h.events.map(e=>[e.action,e.to_version,e.who]),[['rascunho',1,'gestor fish'],['validate',2,'gestor fish'],['submeter',2,null]]);
 assert.equal(h.events[0].from_version,null,'coluna ausente sai null, não deduzida');assert.equal(h.truncated,false);assert.ok(accepts({acao:'historico',marca:'fish',draft_id:'d_fish_1'},h));
 assert.ok(accepts({acao:'historico',marca:'aristo',draft_id:'d_aristo_1'},await call(db,'historico',[X.KEY,'aristo','d_aristo_1'])));
 assert.ok(accepts({acao:'historico',marca:'fish',draft_id:'d_fish_2'},await call(db,'historico',[X.KEY,'fish','d_fish_2'])),'rascunho WhatsApp da marca: histórico vazio, sem erro');
 for(const [b,d] of [['aristo','d_fish_1'],['fish','d_aristo_1'],['fish','d_olivas_1'],['fish','d_nada']])await err(call(db,'historico',[X.KEY,b,d]),'CRM_TEMPLATE_READ_NOT_FOUND');
 await err(call(db,'historico',[X.KEY,'fish',"d' OR true--"]),'CRM_TEMPLATE_READ_REQUEST');
 const s=await call(db,'submissao',[X.KEY,'fish','s_fish_1']);
 assert.deepEqual([s.draft_id,s.draft_version,s.provider,s.estado,s.provider_status,s.rejected_reason,s.checked_at,s.provider_polled],['d_fish_1',2,'meta','submetido','PENDING',null,null,false]);
 assert.ok(accepts({acao:'submissao',marca:'fish',submission_id:'s_fish_1'},s));
 assert.ok(accepts({acao:'submissao',marca:'aristo',submission_id:'s_aristo_1'},await call(db,'submissao',[X.KEY,'aristo','s_aristo_1'])));
 for(const [b,id] of [['aristo','s_fish_1'],['fish','s_aristo_1'],['fish','s_olivas_1'],['fish','s_orfa'],['aristo','s_orfa']])await err(call(db,'submissao',[X.KEY,b,id]),'CRM_TEMPLATE_READ_NOT_FOUND');
 assert.throws(()=>accepts({acao:'submissao',marca:'aristo',submission_id:'s_fish_1'},s),{code:'TEMPLATE_READ_RESPONSE_DENIED'});
 assert.deepEqual(await X.snapshot(db),before);
});

test('principal individual com a capacidade da ação; chaves legadas, revogadas ou sem capacidade não leem',async t=>{
 const db=await fixture(t);
 assert.ok((await call(db,'listar',[X.NOCAP_KEY,'fish',0,20])).templates.length);
 await err(call(db,'historico',[X.NOCAP_KEY,'fish','d_fish_1']),'CRM_TEMPLATE_READ_ACCESS_DENIED');
 await err(call(db,'submissao',[X.NOCAP_KEY,'fish','s_fish_1']),'CRM_TEMPLATE_READ_ACCESS_DENIED');
 for(const k of [X.REVOKED_KEY,X.LEGACY_KEY,X.TEMPLATE_V2_KEY,'0'.repeat(64),X.KEY.toUpperCase(),'',null])await err(call(db,'listar',[k,'fish',0,20]),'CRM_TEMPLATE_READ_UNAUTHORIZED');
 // Contraprova: o caminho legado do handler aceita essas chaves (todas as marcas).
 assert.ok((await db.query('SELECT public.shrigma_crm_operator_auth_v1($1) AS a',[X.LEGACY_KEY])).rows[0].a);
 assert.ok((await db.query('SELECT public.shrigma_crm_operator_auth_v1($1) AS a',[X.TEMPLATE_V2_KEY])).rows[0].a);
 // Expiração real conferida pelo banco a cada chamada.
 await db.query("UPDATE public.crm_dash_chave SET expira_em=now()-interval '1 second' WHERE chave=$1",[X.PRINCIPAL]);
 await err(call(db,'listar',[X.KEY,'fish',0,20]),'CRM_TEMPLATE_READ_UNAUTHORIZED');
});

test('papel sem tabelas e funções STABLE sem escrita: leitura direta, autenticação e escrita recusadas',async t=>{
 const db=await fixture(t);
 for(const sql of ['SELECT * FROM public.templates','SELECT * FROM public.shrigma_template_draft','SELECT * FROM public.crm_dash_chave',
  `SELECT crm_template_read.principal('${X.KEY}','read_content')`,`SELECT public.shrigma_panel_operator_v1('${X.KEY}','growth')`,`SELECT * FROM public.shrigma_panel_auth_v1('${X.KEY}','growth','header')`])
  await assert.rejects(asReader(db,sql),e=>e.code==='42501',sql);
 // Mesmo numa transação de escrita, o papel não grava nada.
 for(const sql of ["INSERT INTO public.templates(id,name,type) VALUES(99,'x','tx')","UPDATE public.shrigma_template_submissao SET estado='publicado'","DELETE FROM public.shrigma_template_evento"])
  await assert.rejects(asReader(db,sql,[],{readOnly:false}),e=>e.code==='42501',sql);
 // O owner também lê em READ ONLY: as funções não escrevem nem bloqueiam linha.
 await db.query('BEGIN READ ONLY');
 try{for(const [fn,args] of [['listar',[X.KEY,'fish',0,20]],['historico',[X.KEY,'fish','d_fish_1']],['submissao',[X.KEY,'fish','s_fish_1']]])
  await db.query(`SELECT crm_template_read.${fn}(${args.map((_,i)=>'$'+(i+1)).join(',')})`,args);}finally{await db.query('ROLLBACK');}
 const procs=(await db.query("SELECT proname,provolatile,prosecdef,prosrc,proconfig FROM pg_proc WHERE pronamespace='crm_template_read'::regnamespace ORDER BY 1")).rows;
 assert.deepEqual(procs.map(p=>p.proname),['historico','listar','principal','submissao']);
 for(const p of procs){assert.equal(p.provolatile,'s');assert.equal(p.prosecdef,true);assert.deepEqual(p.proconfig,['search_path=pg_catalog']);assert.doesNotMatch(p.prosrc,/\b(INSERT|UPDATE|DELETE|FOR\s+(SHARE|UPDATE)|shrigma_panel_auth_v1|nextval|pg_advisory|dblink|http)\b/i,p.proname);}
 const grants=(await db.query("SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE grantee='crm_template_reader'")).rows[0].n;assert.equal(grants,0);
 const role=(await db.query("SELECT rolcanlogin,rolinherit,rolconfig FROM pg_roles WHERE rolname='crm_template_reader'")).rows[0];
 assert.equal(role.rolcanlogin,false);assert.equal(role.rolinherit,false);assert.ok(role.rolconfig.includes('default_transaction_read_only=on'));
 await assert.rejects(db.exec(X.accessSQL()),/CRM_TEMPLATE_READ_INSTALL_COLLISION/);
});

test('instalação recusa dependência ausente e mantém a trava de owner/listmonk no arquivo real',async t=>{
 const db=new PGlite();t.after(()=>db.close());await X.schema(db);await db.exec('DROP TABLE public.shrigma_template_evento');
 await assert.rejects(db.exec(X.accessSQL()),/CRM_TEMPLATE_READ_DEPENDENCY/);
 await assert.rejects(db.exec(X.accessSQL({strict:true})),/CRM_TEMPLATE_READ_OWNER/,'PGlite não é o database listmonk');
 assert.equal((await db.query("SELECT to_regnamespace('crm_template_read') IS NULL AS n")).rows[0].n,true,'nada ficou instalado');
});
