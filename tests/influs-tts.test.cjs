const test=require('node:test'),assert=require('node:assert/strict');
const TTS=require('../influs-tts.js');

const P={
  kpis:[{marca:'aristo',pedidos:20,gmv:1000,comissao:150,pct_video:100,pct_live:null},
        {marca:'fish',pedidos:40,gmv:3000,comissao:450,pct_video:80,pct_live:20}],
  amostras:[{marca:'aristo',total:20,pendentes:2,venceu_sem_decisao:5,aprovada_nao_enviada:1,aguardando_envio:0,em_transito_ou_conteudo:0,completas:10,pendente_mais_urgente:'2026-09-16T00:00:00Z'},
            {marca:'fish',total:100,pendentes:3,venceu_sem_decisao:20,aprovada_nao_enviada:10,aguardando_envio:1,em_transito_ou_conteudo:2,completas:50,pendente_mais_urgente:'2026-09-15T12:00:00Z'}],
  frescor:[{marca:'aristo',ultima_ok:'2026-09-14T03:40:00Z',ultima_ok_todas:true},{marca:'fish',ultima_ok:'2026-09-13T03:40:00Z',ultima_ok_todas:false,erros:'pedidos: 401'}],
  fila:[{marca:'fish',username:'a',approve_expira_em:'2026-09-16T12:00:00Z',tier_sugerido:'comprovado'},
        {marca:'fish',username:'b',approve_expira_em:'2026-09-15T00:00:00Z',tier_sugerido:'xpto'},
        {marca:'aristo',username:'c',approve_expira_em:null,tier_sugerido:'fora_sku'}],
};
const AGORA=Date.parse('2026-09-14T12:00:00Z');

test('KPIs somam por marca e percentuais só com base >= 30 pedidos',()=>{
  const t=TTS.kpis(P,'todas');
  assert.equal(t.gmv,4000); assert.equal(t.comissao,600); assert.equal(t.pedidos,60);
  assert.equal(Math.round(t.comissaoPct*10)/10,15);
  assert.equal(Math.round(t.pctVideo),85);   // (1000*1 + 3000*.8)/4000
  assert.equal(Math.round(t.pctLive),15);
  assert.equal(t.pendentes,5); assert.equal(t.perda,36); assert.equal(t.perdaPct,30);
  assert.equal(t.urgente,'2026-09-15T12:00:00Z');
  const a=TTS.kpis(P,'aristo');
  assert.equal(a.pctVideo,null,'20 pedidos < 30: sem percentual');
  assert.equal(a.perdaPct,null,'20 amostras < 30: mostra contagem, não %');
  assert.equal(a.perda,6);
});
test('marca sem dado devolve zeros, nunca NaN',()=>{
  const o=TTS.kpis(P,'olivas');
  assert.equal(o.gmv,0); assert.equal(o.comissaoPct,null); assert.equal(o.pctVideo,null); assert.equal(o.urgente,null);
});
test('frescor usa a coleta OK mais recente e fica vermelho se qualquer última execução falhou',()=>{
  const a=TTS.frescor(P,'aristo',AGORA);
  assert.equal(a.txt,'coleta há 8 h'); assert.equal(a.velho,false);
  const t=TTS.frescor(P,'todas',AGORA);
  assert.equal(t.velho,true); assert.match(t.txt,/erro/); assert.match(t.title,/pedidos: 401/);
  const v=TTS.frescor(P,'aristo',AGORA+27*36e5);
  assert.equal(v.velho,true,'mais de 26 h vira velho');
  assert.equal(TTS.frescor({frescor:[]},'todas',AGORA).velho,true);
});
test('fila ordena pelo prazo mais curto, sem prazo por último, e tier desconhecido vira sem_regra',()=>{
  const f=TTS.fila(P,'todas',AGORA);
  assert.deepEqual(f.map(x=>x.username),['b','a','c']);
  assert.equal(f[0].horas,12); assert.equal(f[1].horas,48); assert.equal(f[2].horas,null);
  assert.equal(f[0].tier.rot,'Sem regra'); assert.equal(f[1].tier.cls,'bom'); assert.equal(f[2].tier.rot,'Fora · SKU');
  assert.equal(TTS.fila(P,'fish',AGORA).length,2);
});
test('decisão gravada pela esteira vence o tier calculado e marca simulação',()=>{
  const r=TTS.rotulo({tier_sugerido:'comprovado',decisao:'auto_rejeitada',dry_run:true,decisao_motivo:'SKU fora'});
  assert.equal(r.rot,'Rejeitar (simulado)'); assert.equal(r.cls,'ruim'); assert.equal(r.det,'SKU fora');
  assert.equal(TTS.rotulo({tier_sugerido:'descoberta'}).rot,'Avaliar');
  assert.equal(TTS.rotulo({tier_sugerido:'sku_fora_comprovado'}).rot,'Avaliar · SKU','criador comprovado com SKU fora nunca é rejeição automática');
  assert.equal(TTS.rotulo({tier_sugerido:'comprovado',decisao:'auto_aprovada',dry_run:false}).rot,'Aprovar');
});
test('horas até prazo: negativo quando vencido',()=>{
  assert.equal(TTS.horasAte('2026-09-14T10:00:00Z',AGORA),-2);
  assert.equal(TTS.horasAte(null,AGORA),null);
});
test('taxa da target collab só com 10+ convidados',()=>{
  assert.equal(TTS.targetTaxa({invited_count:50,content_creator_count:3}),6);
  assert.equal(TTS.targetTaxa({invited_count:5,content_creator_count:3}),null);
  assert.equal(TTS.targetTaxa({}),null);
});

test('autorização: loja sem linha em crm_tts_token vira aviso de reautorizar', () => {
  const vazio = TTS.autorizacao({ autorizacao: [] }, 'fish');
  assert.equal(vazio.estado, 'ausente');

  const agora = Date.parse('2026-09-15T12:00:00Z');
  const ok = TTS.autorizacao({ autorizacao: [
    { marca: 'fish', loja: 'fishermans', refresh_expira_em: '2026-12-01T00:00:00Z', expira_em_breve: false, ultimo_erro_canal: null },
  ] }, 'fish', agora);
  assert.equal(ok.estado, 'ok');

  const venceu = TTS.autorizacao({ autorizacao: [
    { marca: 'fish', loja: 'fishermans', refresh_expira_em: '2026-09-01T00:00:00Z', expira_em_breve: true, ultimo_erro_canal: null },
  ] }, 'fish', agora);
  assert.equal(venceu.estado, 'vencida');

  // escopo faltando: a autorização é válida, mas o coletor do canal bate em 105005.
  const semEscopo = TTS.autorizacao({ autorizacao: [
    { marca: 'fish', loja: 'fishermans', refresh_expira_em: '2026-12-01T00:00:00Z', expira_em_breve: false,
      ultimo_erro_canal: '105005 The access token does not include any scope' },
  ] }, 'fish', agora);
  assert.equal(semEscopo.estado, 'sem_escopo');
});

test('autorização válida sem o escopo do canal manda para o app, não para reautorizar de novo', () => {
  const base = { marca: 'fish', loja: 'fishermans', refresh_expira_em: '2125-08-15T22:26:30Z', expira_em_breve: false, ultimo_erro_canal: null };
  const agora = Date.parse('2026-09-16T12:00:00Z');

  const semEscopo = TTS.autorizacao({ autorizacao: [
    { ...base, granted_scopes: ['seller.affiliate_collaboration.read'], escopos_faltando: ['seller.data.read'] },
  ] }, 'fish', agora);
  assert.equal(semEscopo.estado, 'sem_escopo');
  assert.equal(semEscopo.app, true, 'tem que apontar para o Partner Center: reautorizar de novo não resolve');
  assert.match(semEscopo.txt, /seller\.data\.read/);

  // com todos os escopos, a faixa some — mesmo com a autorização válida por 99 anos
  const completo = TTS.autorizacao({ autorizacao: [
    { ...base, granted_scopes: ['seller.data.read', 'seller.order.read', 'seller.product.read'], escopos_faltando: [] },
  ] }, 'fish', agora);
  assert.equal(completo.estado, 'ok');
});

test('sonda: reautorizar só quando algo mudou desde a última autorização', () => {
  const tok = [{ marca: 'fish', loja: 'fishermans', refresh_expira_em: '2125-08-15T22:26:30Z',
                 expira_em_breve: false, ultimo_erro_canal: null, granted_scopes: [], escopos_faltando: [] }];
  const agora = Date.parse('2026-09-16T14:00:00Z');

  // o caso que me pegou: reautorizou, a sonda conferiu depois e nada entrou -> NÃO pedir de novo
  const jaTentou = TTS.autorizacao({ autorizacao: tok, escopos: [
    { marca: 'fish', mudou_desde_autorizacao: null, aguardando_tiktok: ['Shop Analytics', 'Order Information'],
      autorizado_em: '2026-09-16T13:43:23Z', conferido_apos_autorizar: true },
  ] }, 'fish', agora);
  assert.equal(jaTentou.estado, 'sem_escopo');
  assert.match(jaTentou.txt, /não resolve/, 'tem que dizer que reautorizar de novo não adianta');
  assert.doesNotMatch(jaTentou.txt, /Reautorize as duas/);

  // mudou de estado depois da autorização -> aí sim vale reautorizar
  const mudou = TTS.autorizacao({ autorizacao: tok, escopos: [
    { marca: 'fish', mudou_desde_autorizacao: ['Shop Analytics'], aguardando_tiktok: ['Promotion'],
      autorizado_em: '2026-09-16T13:43:23Z', conferido_apos_autorizar: true },
  ] }, 'fish', agora);
  assert.equal(mudou.estado, 'reautorizar_agora');

  // tudo ok -> faixa some
  const ok = TTS.autorizacao({ autorizacao: tok, escopos: [
    { marca: 'fish', mudou_desde_autorizacao: null, aguardando_tiktok: null, conferido_apos_autorizar: true },
  ] }, 'fish', agora);
  assert.equal(ok.estado, 'ok');
});

test('cobrança: soma por marca e distingue simulada de enviada', () => {
  const p = {
    cobranca: [{ marca: 'fish', enviadas: 0, falhas: 0, simuladas: 15 },
               { marca: 'aristo', enviadas: 3, falhas: 1, simuladas: 0 }],
    cobranca_regra: [{ marca: 'fish', cobranca_modo: 'dry_run', cobranca_max_dia: 15 },
                     { marca: 'aristo', cobranca_modo: 'ativo', cobranca_max_dia: 15 }],
    cobranca_pendentes: [{ marca: 'fish', pendentes: 62 }, { marca: 'aristo', pendentes: 20 }],
  };
  const fish = TTS.cobranca(p, 'fish');
  assert.equal(fish.simuladas, 15);
  assert.equal(fish.enviadas, 0, 'em simulação nada pode contar como enviado');
  assert.equal(fish.pendentes, 62);
  assert.equal(fish.modo, 'dry_run');

  // visão das duas marcas em modos diferentes não pode mentir que está tudo ligado
  const todas = TTS.cobranca(p, 'todas');
  assert.equal(todas.modo, 'misto');
  assert.equal(todas.pendentes, 82);
  assert.equal(todas.falhas, 1);
});

test('régua: toque nunca some da fila mostrada', () => {
  // o painel precisa distinguir 1o toque de 3o: sem isso ninguém sabe se a pessoa já foi insistida
  const p = { cobranca_fila: [
    { marca: 'fish', etapa: 'vitrine_sem_video', username: 'a', tentativa: 1, dry_run: true, ok: true },
    { marca: 'fish', etapa: 'vitrine_sem_video', username: 'b', tentativa: 3, dry_run: false, ok: true },
  ] };
  const f = TTS.filtra(p.cobranca_fila, 'fish');
  assert.equal(f.length, 2);
  assert.deepEqual(f.map(x => x.tentativa), [1, 3]);
});

// ---- Canal (Shop Analytics) ----
const PC={
  canal_total:[{marca:'fish',gmv:1000,gmv_live:400,gmv_video:300,gmv_vitrine:300,gmv_afiliado:500,gmv_proprio:500,gmv_ads:100,pedidos:10,visitantes:500,reembolso:50},
               {marca:'aristo',gmv:1000,gmv_live:0,gmv_video:200,gmv_vitrine:800,gmv_afiliado:100,gmv_proprio:900,gmv_ads:0,pedidos:10,visitantes:1500,reembolso:0}],
  canal:[{marca:'fish',dia:'2026-09-16T00:00:00.000Z',gmv:700,gmv_live:400,gmv_video:200,gmv_vitrine:100,gmv_afiliado:200,gmv_proprio:500,gmv_ads:60,pedidos:7,visitantes:300},
         {marca:'fish',dia:'2026-09-17T00:00:00.000Z',gmv:300,gmv_live:0,gmv_video:100,gmv_vitrine:200,gmv_afiliado:300,gmv_proprio:0,gmv_ads:40,pedidos:3,visitantes:200},
         {marca:'aristo',dia:'2026-09-16T00:00:00.000Z',gmv:1000,gmv_live:0,gmv_video:200,gmv_vitrine:800,gmv_afiliado:100,gmv_proprio:900,gmv_ads:0,pedidos:10,visitantes:1500}],
  lives:[{marca:'fish',live_id:'1',gmv:761.76,inicio_em:'2026-09-16T15:06:09Z',origem:'proprio',username:'fishermans.com.br'},
         {marca:'fish',live_id:'2',gmv:179.46,inicio_em:'2026-09-12T15:00:00Z',origem:'afiliado',username:'bibi'},
         {marca:'aristo',live_id:'3',gmv:0,inicio_em:'2026-09-11T22:00:00Z',origem:'afiliado',username:'clecio'}],
  videos:[{marca:'fish',video_id:'a',gmv:100},{marca:'fish',video_id:'b',gmv:1286.51},{marca:'aristo',video_id:'c',gmv:194.95}],
};
test('canal: soma as marcas em "todas" e os percentuais saem do GMV total da loja',()=>{
  const t=TTS.canal(PC,'todas','2026-09-17');
  assert.equal(t.temDados,true); assert.equal(t.gmv,2000); assert.equal(t.pedidos,20);
  assert.equal(t.pctLive,20); assert.equal(t.pctVideo,25); assert.equal(t.pctVitrine,55);
  assert.equal(t.pctAfiliado,30); assert.equal(t.pctAds,5);
  assert.equal(t.conversao,1); assert.equal(t.ticket,100);
});
test('canal: série por dia soma marcas, marca hoje como parcial e acha o melhor dia',()=>{
  const t=TTS.canal(PC,'todas','2026-09-17');
  assert.equal(t.serie.length,2);
  assert.deepEqual(t.serie.map(x=>x.dia),['2026-09-16','2026-09-17']);
  assert.equal(t.serie[0].gmv,1700); assert.equal(t.serie[0].live,400); assert.equal(t.serie[0].parcial,false);
  assert.equal(t.serie[1].parcial,true,'o dia de hoje é parcial');
  assert.equal(t.melhorDia.dia,'2026-09-16');
  assert.equal(Math.round(t.serie[0].pctAfiliado*10)/10,17.6);  // 300/1700
});
test('canal: filtro por marca, lives e vídeos ordenados por GMV',()=>{
  const f=TTS.canal(PC,'fish','2026-09-17');
  assert.equal(f.gmv,1000); assert.equal(f.pctLive,40); assert.equal(f.pctAfiliado,50);
  assert.deepEqual(f.lives.map(l=>l.live_id),['1','2']);
  assert.deepEqual(f.videos.map(v=>v.video_id),['b','a']);
  assert.equal(f.lives[0].origem,'proprio');
});
test('canal: marca sem coleta não inventa zero — diz que não tem dado',()=>{
  const o=TTS.canal(PC,'olivas','2026-09-17');
  assert.equal(o.temDados,false); assert.equal(o.pctLive,null); assert.equal(o.conversao,null); assert.equal(o.serie.length,0);
  const v=TTS.canal({}, 'todas','2026-09-17'); assert.equal(v.temDados,false);
});
test('cache só serve na mesma janela e com menos de 24 h',()=>{
  const c={em:'2026-09-17T12:00:00Z',ini:'2026-08-18',fim:'2026-09-17',payload:{kpis:[]}};
  const agora=Date.parse('2026-09-17T15:00:00Z');
  assert.equal(TTS.cacheServe(c,'2026-08-18','2026-09-17',agora),true);
  assert.equal(TTS.cacheServe(c,'2026-08-01','2026-09-17',agora),false,'janela diferente');
  assert.equal(TTS.cacheServe(c,'2026-08-18','2026-09-17',agora+25*36e5),false,'velho demais');
  assert.equal(TTS.cacheServe(null,'2026-08-18','2026-09-17',agora),false);
  assert.equal(TTS.cacheServe({em:'2026-09-17T12:00:00Z',ini:null,fim:null,payload:{}},null,null,agora),true,'janela padrão (null) casa com null');
});
test('cobrança: quem respondeu vem separado, ordenado por não lidas, e não conta como toque',()=>{
  const P2={cobranca:[{marca:'fish',enviadas:3,falhas:0,simuladas:0}],cobranca_regra:[{marca:'fish',cobranca_modo:'ativo',cobranca_max_dia:15}],
    cobranca_pendentes:[{marca:'fish',pendentes:40}],
    cobranca_pulos:[{marca:'fish',username:'a',motivo:'respondeu',nao_lidas:0,ultima_msg_em:'2026-09-17T10:00:00Z'},
                    {marca:'fish',username:'b',motivo:'respondeu',nao_lidas:7,ultima_msg_em:'2026-09-16T10:00:00Z'},
                    {marca:'fish',username:'c',motivo:'conversa_ativa',nao_lidas:0},
                    {marca:'aristo',username:'d',motivo:'respondeu',nao_lidas:1}]};
  const f=TTS.cobranca(P2,'fish');
  assert.deepEqual(f.responderam.map(x=>x.username),['b','a']);
  assert.equal(f.naoLidas,7); assert.equal(f.conversasAtivas,1); assert.equal(f.enviadas,3);
  assert.equal(TTS.cobranca(P2,'todas').responderam.length,3);
  assert.equal(TTS.cobranca({}, 'fish').responderam.length,0);
});
