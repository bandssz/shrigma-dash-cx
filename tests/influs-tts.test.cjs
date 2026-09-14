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
test('horas até prazo: negativo quando vencido',()=>{
  assert.equal(TTS.horasAte('2026-09-14T10:00:00Z',AGORA),-2);
  assert.equal(TTS.horasAte(null,AGORA),null);
});
test('taxa da target collab só com 10+ convidados',()=>{
  assert.equal(TTS.targetTaxa({invited_count:50,content_creator_count:3}),6);
  assert.equal(TTS.targetTaxa({invited_count:5,content_creator_count:3}),null);
  assert.equal(TTS.targetTaxa({}),null);
});
