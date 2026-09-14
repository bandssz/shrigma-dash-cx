/* Bookmarklet "→ Painel CX (RA)" — roda NA PÁGINA da marca no Reclame AQUI.
   Por que existe: o RA bloqueia curl e o n8n (403, anti-bot); um navegador de verdade passa.
   O que faz: lê as metatags meta-reclameaqui:* (fonte oficial da página) e alguns números do
   corpo, e manda um POST para o n8n, que grava cx_ra_dia (fonte='bookmarklet').
   Como instalar: criar um favorito com a URL abaixo (uma linha, começando em javascript:),
   trocando CHAVE pela chave do painel de CX. Uso: abrir a página da marca no RA e clicar no favorito.
   Marcas reconhecidas pela URL: o-aristocrata-1751961 → aristocrata; artigos-de-pesca-fishermans → fishermans.
   Rotina: uma vez por dia útil (ou segunda, no mínimo). O painel mostra a idade da leitura.
   Desde 13/09 existe uma tarefa agendada do Claude (08:30, no Mac do Felipe) que faz a mesma leitura pelo
   navegador; o bookmarklet é o plano B para quando o Mac estiver desligado. Validado ponta a ponta em 13/09
   (as duas marcas gravaram com fonte='bookmarklet').
   Correções de 13/09: "nota média do consumidor" (o texto tem "média"), aguardando lido depois do rótulo
   ("Aguardando resposta 103") e status pela metatag reputation-status (GOOD/REGULAR/BAD).

   14/09 — dois números de "sem resposta". O "aguardando" da página é o da RÉGUA de reputação: janela
   fechada de 6 meses ("Dados de 01/03/2026 até 31/08/2026"), recalculada na virada do mês. Dava 102
   enquanto o Samuel via 260 no RA Empresas. A fila real vem da busca pública do próprio RA
   (iosearch…/companyComplains, status=PENDING, todas as ativas), que só responde de DENTRO da página
   (de fora é 403). Por isso o bookmarklet agora manda também: periodo_ini/periodo_fim (a janela da
   régua), pendentes_agora, respondidas_agora (sem avaliação), avaliadas_agora e ativas_agora. O id da
   empresa sai do JSON-LD da página ("identifier") ou do script de analytics ("raichuId").
   Validado 14/09: Aris 102 régua × 260 fila; Fish 2 × 2. */

javascript:(async function(){
  var K='CHAVE';
  var URL='https://n8n-n8n.tazdb8.easypanel.host/webhook/cx-ra-metatags?k='+encodeURIComponent(K);
  var h=location.pathname;
  var marca=/o-aristocrata/.test(h)?'aristocrata':/fishermans/.test(h)?'fishermans':/olivas/.test(h)?'olivas':null;
  if(!marca){alert('Abra a página da marca no Reclame AQUI antes de clicar.');return;}
  function meta(n){var m=document.querySelector('meta[name="reclameaqui:'+n+'"],meta[property="reclameaqui:'+n+'"],meta[name="meta-reclameaqui:'+n+'"]');return m?m.getAttribute('content'):null;}
  var txt=(document.body.innerText||'').replace(/\s+/g,' ');
  function corpo(re){var m=txt.match(re);return m?m[1].replace('.','').replace(',','.'):null;}
  var ra={
    nota:meta('reputation-score'),resposta_pct:meta('response-rate'),solucao_pct:meta('solved-rate'),
    voltaria_pct:meta('deal-again-rate'),reclamacoes:meta('total-complaints'),avaliacoes:meta('total-ratings'),
    nota_consumidor:corpo(/nota (?:m[eé]dia )?do consumidor[^0-9]{0,80}([0-9]+[.,]?[0-9]*)/i),
    aguardando:corpo(/aguardando resposta\s*([0-9.]+)/i)||corpo(/([0-9.]+)\s*(?:reclama[cç][oõ]es?\s*)?(?:aguardando|n[aã]o respondid)/i),
    tempo_resposta_dias:corpo(/tempo m[eé]dio de resposta[^0-9]{0,40}([0-9]+[.,]?[0-9]*)/i),
    status_ra:meta('reputation-status')||meta('status')||(txt.match(/reputa[cç][aã]o[^A-Za-zÀ-ú]{0,20}(Ótimo|Otimo|Bom|Boa|Regular|Ruim|Não recomendada|Nao recomendada)/i)||[])[1]||null
  };
  if(!ra.resposta_pct&&!ra.nota){alert('Não achei as metatags do RA nesta página. Recarregue e tente de novo.');return;}
  /* janela da régua ("Dados de dd/mm/aaaa até dd/mm/aaaa" na brand page; "período de … a …" na lista) */
  var pp=txt.match(/(?:dados de|per[ií]odo de) (\d{2})\/(\d{2})\/(\d{4}) (?:at[eé]|a) (\d{2})\/(\d{2})\/(\d{4})/i);
  if(pp){ra.periodo_ini=pp[3]+'-'+pp[2]+'-'+pp[1];ra.periodo_fim=pp[6]+'-'+pp[5]+'-'+pp[4];}
  /* fila real: busca pública do RA, chamada de dentro da página */
  var cid=null;for(var s of document.scripts){var m=(s.textContent||'').match(/"(?:raichuId|identifier)":"([A-Za-z0-9_-]{16})"/);if(m){cid=m[1];break;}}
  if(cid){var base='https://iosearch.reclameaqui.com.br/raichu-io-site-search-v1/query/companyComplains/1/0?company='+cid;
    var qs={pendentes_agora:'&status=PENDING&evaluated=bool:false',respondidas_agora:'&status=ANSWERED&evaluated=bool:false',avaliadas_agora:'&evaluated=bool:true',ativas_agora:''};
    for(var k in qs){try{var j=await (await fetch(base+qs[k])).json();ra[k]=j.complainResult.complains.count;}catch(e){ra[k]=null;}}}
  fetch(URL,{method:'POST',mode:'no-cors',headers:{'Content-Type':'text/plain'},body:JSON.stringify({marca:marca,ra:ra})})
    .then(function(){alert('Painel CX · '+marca+'\nresposta '+ra.resposta_pct+'% · solução '+ra.solucao_pct+'% · nota '+ra.nota+'\nsem resposta agora '+(ra.pendentes_agora!=null?ra.pendentes_agora:'?')+' · na régua '+(ra.aguardando||'?')+' · enviado.');})
    .catch(function(e){alert('Falhou ao enviar: '+e);});
})();
