/* Isolated real PostgreSQL (PGlite); synthetic events only, no network or production tables.
   ORGANICO_PGLITE_MODULE / CAMPAIGN_PGLITE_MODULE points to installed PGlite. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.ORGANICO_PGLITE_MODULE||process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
const sql=fs.readFileSync(path.join(__dirname,'..','n8n/organico/webhook-comentarios.sql'),'utf8');
let checks=0;const ok=(c,m)=>{assert.ok(c,m);checks++;};const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;};
(async()=>{
 const db=new PGlite();
 await db.exec(`
  CREATE TABLE cx_social_evento(evento_id text PRIMARY KEY,objeto text,campo text,post_id text,autor text,texto text,ts timestamptz,bruto jsonb,recebido_em timestamptz DEFAULT now(),processado boolean DEFAULT false);
  CREATE TABLE cx_social_objetos(obj_id text PRIMARY KEY,rede text,marca text,origem text,conta text,pagina_id text,criado_em timestamptz,visto_em timestamptz DEFAULT now(),ultimo_scan timestamptz,n_scans int DEFAULT 0);
  CREATE TABLE cx_social_comentarios(id text PRIMARY KEY,marca text NOT NULL,rede text NOT NULL,conta text,post_id text,ts timestamptz,autor text,texto text,
   respondido boolean DEFAULT false,oculto boolean DEFAULT false,sentimento text,categoria text,prioridade text,precisa_resposta boolean,classificado_em timestamptz,
   coletado_em timestamptz NOT NULL DEFAULT now(),respondido_pela_marca boolean DEFAULT false,apagado boolean DEFAULT false,visto_em timestamptz,respondido_em timestamptz,origem text);
  INSERT INTO cx_social_objetos(obj_id,rede,marca,origem,conta,pagina_id) VALUES
   ('900001','instagram','aristocrata','ads','@oaristocrata.br',NULL),
   ('900002','instagram','fishermans','organico','@fishermans.com.br',NULL),
   ('749947324865075_1','facebook','aristocrata','organico','O Aristocrata','749947324865075');
  INSERT INTO cx_social_comentarios(id,marca,rede,conta,post_id,ts,autor,texto,respondido,origem,sentimento)
   VALUES('c-scan','fishermans','instagram','@fishermans.com.br','900002','2026-09-20T10:00:00Z','cliente0','da varredura',false,'organico','positivo');`);
 await db.exec(sql);await db.exec(sql); // reinstalavel
 let n=0;const ev=async(objeto,campo,value,at)=>{n++;await db.query(`INSERT INTO cx_social_evento(evento_id,objeto,campo,ts,bruto,recebido_em) VALUES($1,$2,$3,$4,$5::jsonb,$4)`,
   ['e'+n,objeto,campo,at,JSON.stringify({field:campo,value})]);};
 const now=Date.now(),t=(min)=>new Date(now-min*60000).toISOString();
 // IG: cliente comenta anuncio da Aristo; marca responde; outro cliente responde em outro fio
 await ev('instagram','comments',{id:'c1',text:'  quanto custa? R$35 ',from:{id:'u1',username:'cliente1'},media:{id:'900001'}},t(50));
 await ev('instagram','comments',{id:'c1r',text:'oi! te chamei no direct',parent_id:'c1',from:{id:'b1',username:'OAristocrata.br'},media:{id:'900001'}},t(40));
 await ev('instagram','comments',{id:'c2',text:'amei',from:{id:'u2',username:'cliente2'},media:{id:'900001'}},t(45));
 await ev('instagram','comments',{id:'c2r',text:'eu tambem',parent_id:'c2',from:{id:'u3',username:'cliente3'},media:{id:'900001'}},t(44));
 // IG: comentario em post desconhecido (fica pendente) e comentario ja vindo da varredura (nao sobrescreve)
 await ev('instagram','comments',{id:'c3',text:'post novo',from:{id:'u4',username:'cliente4'},media:{id:'999999'}},t(30));
 await ev('instagram','comments',{id:'c-scan',text:'texto do webhook',from:{id:'u0',username:'cliente0'},media:{id:'900002'}},t(29));
 // IG: comentario da propria marca no primeiro nivel nao vira linha
 await ev('instagram','comments',{id:'c4',text:'sorteio!',from:{id:'b2',username:'fishermans.com.br'},media:{id:'900002'}},t(28));
 // IG: resposta cujo pai nao existe ainda (pendente)
 await ev('instagram','comments',{id:'c5r',text:'?',parent_id:'nao-existe',from:{id:'u5',username:'x'},media:{id:'900002'}},t(27));
 // FB: comentario de primeiro nivel, resposta da pagina, ocultar, reexibir, ocultar de novo, editar, apagar
 const fb=(v)=>({item:'comment',post_id:'749947324865075_1',created_time:Math.floor(now/1000),...v});
 await ev('page','feed',fb({verb:'add',comment_id:'f1',parent_id:'749947324865075_1',message:'chegou quebrado',from:{id:'p1',name:'Cliente FB'}}),t(20));
 await ev('page','feed',fb({verb:'add',comment_id:'f1r',parent_id:'f1',message:'vamos resolver',from:{id:'749947324865075',name:'O Aristocrata'}}),t(19));
 await ev('page','feed',fb({verb:'hide',comment_id:'f1',parent_id:'749947324865075_1'}),t(18));
 await ev('page','feed',fb({verb:'unhide',comment_id:'f1',parent_id:'749947324865075_1'}),t(17));
 await ev('page','feed',fb({verb:'edited',comment_id:'f1',parent_id:'749947324865075_1',message:'chegou quebrado, troca?'}),t(16));
 await ev('page','feed',fb({verb:'add',comment_id:'f2',parent_id:'749947324865075_1',message:'spam',from:{id:'p2',name:'Spam'}}),t(15));
 await ev('page','feed',fb({verb:'remove',comment_id:'f2',parent_id:'749947324865075_1'}),t(14));
 // eventos que nao sao comentario ficam intocados
 await ev('instagram','mentions',{media_id:'1',comment_id:'2'},t(10));
 await ev('page','feed',{item:'reaction',verb:'add',post_id:'749947324865075_1'},t(9));

 const r1=(await db.query(`SELECT cx_social_ingere_eventos_v1() AS r`)).rows[0].r;
 eq(r1.eventos,15,'so eventos de comentario entram');
 const c=async id=>(await db.query(`SELECT * FROM cx_social_comentarios WHERE id=$1`,[id])).rows[0];
 const c1=await c('c1');
 ok(c1&&c1.marca==='aristocrata'&&c1.origem==='ads'&&c1.conta==='@oaristocrata.br'&&c1.rede==='instagram','marca/conta/origem vem do objeto');
 eq(c1.texto,'quanto custa? R$35','texto aparado e $ preservado');
 ok(c1.respondido===true&&c1.respondido_pela_marca===true&&c1.respondido_em,'resposta da marca (handle sem diferenciar caixa)');
 const c2=await c('c2');ok(c2.respondido===true&&c2.respondido_pela_marca===false&&c2.respondido_em===null,'resposta de cliente nao conta como da marca');
 ok(!(await c('c1r'))&&!(await c('c2r')),'resposta nao vira linha');
 ok(!(await c('c3')),'post desconhecido nao entra');
 const cs=await c('c-scan');eq([cs.texto,cs.sentimento],['da varredura','positivo'],'varredura tem prioridade');
 ok(!(await c('c4')),'comentario da propria marca nao entra');
 const f1=await c('f1');
 ok(f1&&f1.rede==='facebook'&&f1.marca==='aristocrata'&&f1.respondido_pela_marca===true,'FB: primeiro nivel e resposta da pagina');
 eq(f1.oculto,false,'vale o ultimo hide/unhide');
 eq([f1.texto,f1.sentimento],['chegou quebrado, troca?',null],'edicao troca o texto e volta para a fila de sentimento');
 eq((await c('f2')).apagado,true,'remove marca apagado');
 const pend=(await db.query(`SELECT evento_id FROM cx_social_evento WHERE NOT processado ORDER BY evento_id`)).rows.map(x=>x.evento_id);
 eq(pend,['e16','e17','e5','e8'],'pendentes: post desconhecido, resposta sem pai e eventos que nao sao comentario');

 // segunda rodada: nada muda; o inventario passa a conhecer o post e o comentario entra
 const antes=(await db.query(`SELECT count(*)::int n FROM cx_social_comentarios`)).rows[0].n;
 const r2=(await db.query(`SELECT cx_social_ingere_eventos_v1() AS r`)).rows[0].r;
 eq([r2.eventos,r2.inseridos],[2,0],'rodar de novo nao duplica');
 eq((await db.query(`SELECT count(*)::int n FROM cx_social_comentarios`)).rows[0].n,antes,'mesma contagem');
 await db.query(`INSERT INTO cx_social_objetos(obj_id,rede,marca,origem,conta) VALUES('999999','instagram','aristocrata','organico','@oaristocrata.br')`);
 const r3=(await db.query(`SELECT cx_social_ingere_eventos_v1() AS r`)).rows[0].r;
 eq(r3.inseridos,1,'post que o inventario passou a conhecer entra');
 ok((await c('c3')).marca==='aristocrata','marca do objeto');
 // evento velho sem casamento e encerrado (nao fica pendente para sempre)
 await db.query(`UPDATE cx_social_evento SET recebido_em=now()-interval '3 days' WHERE evento_id='e8'`);
 await db.query(`SELECT cx_social_ingere_eventos_v1()`);
 eq((await db.query(`SELECT processado FROM cx_social_evento WHERE evento_id='e8'`)).rows[0].processado,true,'resposta orfa encerrada apos 2 dias');
 eq((await db.query(`SELECT cx_social_ingere_eventos_v1() AS r`)).rows[0].r,{eventos:0},'fila vazia');
 console.log(`organico-webhook-comentarios-postgres: ${checks} checks ok`);
 await db.close();
})().catch(e=>{console.error(e);process.exit(1);});
