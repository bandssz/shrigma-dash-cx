/* Bookmarklet "→ Painel CX (RA)" — roda NA PÁGINA da marca no Reclame AQUI.
   Por que existe: o RA bloqueia curl e o n8n (403, anti-bot); um navegador de verdade passa.
   O que faz: lê as metatags meta-reclameaqui:* (fonte oficial da página) e alguns números do
   corpo, e manda um POST para o n8n, que grava cx_ra_dia (fonte='bookmarklet').
   Como instalar: criar um favorito com a URL abaixo (uma linha, começando em javascript:),
   trocando CHAVE pela chave do painel de CX. Uso: abrir a página da marca no RA e clicar no favorito.
   Marcas reconhecidas pela URL: o-aristocrata-1751961 → aristocrata; artigos-de-pesca-fishermans → fishermans.
   Rotina: uma vez por dia útil (ou segunda, no mínimo). O painel mostra a idade da leitura. */

javascript:(function(){
  var K='CHAVE';
  var URL='https://n8n-n8n.tazdb8.easypanel.host/webhook/cx-ra-metatags?k='+encodeURIComponent(K);
  var h=location.pathname;
  var marca=/o-aristocrata/.test(h)?'aristocrata':/fishermans/.test(h)?'fishermans':/olivas/.test(h)?'olivas':null;
  if(!marca){alert('Abra a página da marca no Reclame AQUI antes de clicar.');return;}
  function meta(n){var m=document.querySelector('meta[name="reclameaqui:'+n+'"],meta[property="reclameaqui:'+n+'"],meta[name="meta-reclameaqui:'+n+'"]');return m?m.getAttribute('content'):null;}
  var txt=document.body.innerText||'';
  function corpo(re){var m=txt.match(re);return m?m[1].replace('.','').replace(',','.'):null;}
  var ra={
    nota:meta('reputation-score'),resposta_pct:meta('response-rate'),solucao_pct:meta('solved-rate'),
    voltaria_pct:meta('deal-again-rate'),reclamacoes:meta('total-complaints'),avaliacoes:meta('total-ratings'),
    nota_consumidor:corpo(/nota do consumidor[^0-9]{0,80}([0-9]+[.,]?[0-9]*)/i),
    aguardando:corpo(/([0-9.]+)\s*(?:reclama[cç][oõ]es?\s*)?(?:aguardando|n[aã]o respondid)/i),
    tempo_resposta_dias:corpo(/tempo m[eé]dio de resposta[^0-9]{0,40}([0-9]+[.,]?[0-9]*)/i),
    status_ra:meta('status')||(txt.match(/reputa[cç][aã]o[^A-Za-zÀ-ú]{0,20}(Ótimo|Otimo|Bom|Boa|Regular|Ruim|Não recomendada|Nao recomendada)/i)||[])[1]||null
  };
  if(!ra.resposta_pct&&!ra.nota){alert('Não achei as metatags do RA nesta página. Recarregue e tente de novo.');return;}
  fetch(URL,{method:'POST',mode:'no-cors',headers:{'Content-Type':'text/plain'},body:JSON.stringify({marca:marca,ra:ra})})
    .then(function(){alert('Painel CX · '+marca+'\nresposta '+ra.resposta_pct+'% · solução '+ra.solucao_pct+'% · nota '+ra.nota+'\naguardando '+(ra.aguardando||'?')+' · enviado.');})
    .catch(function(e){alert('Falhou ao enviar: '+e);});
})();
