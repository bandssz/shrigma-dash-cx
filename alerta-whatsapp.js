/* ================== SAÚDE DO WHATSAPP ==================
   Chip permanente no cabeçalho + faixa vermelha quando uma WABA está parada.

   Por que existe: em 04/09/2026 a WABA transacional da Fishermans ficou 35h sem
   enviar (cartão cancelado → Meta bloqueou por pagamento, erro 131042) e ninguém
   viu, porque falha de WhatsApp não aparece como erro — aparece como carrinho
   abandonado que ninguém recuperou. Esta faixa troca "descobrir no fim de semana"
   por "ver ao abrir o painel".

   Lê `wa_saude` da API (tabela shrigma_wa_saude, gravada de hora em hora pelo
   workflow "WA · Saúde do canal" a partir do analytics da Meta — inclui o que a
   Reportana envia). Autônomo como alerta-credencial.js: injeta o próprio CSS.

   Regras do painel: nunca calar sobre dado velho — se a última verificação tem
   mais de 2h, a faixa diz isso em âmbar em vez de mostrar "ok" antigo. */
(function () {
  var CSS = [
    '.aviso-wa{display:flex;flex-wrap:wrap;gap:10px;align-items:center;',
    'margin:0 0 14px;padding:11px 14px;border-radius:10px;font-size:13px;line-height:1.45;',
    'border:1px solid;font-family:Inter,system-ui,sans-serif}',
    '.aviso-wa.grave{background:#fdf0ee;border-color:#e2a79c;color:#8a2c18}',
    '.aviso-wa.aviso{background:#fdf8e8;border-color:#ddc887;color:#7a5c12}',
    '.aviso-wa b{font-weight:700}',
    '.aviso-wa .wa-chip{display:inline-block;padding:2px 8px;border-radius:999px;',
    'background:rgba(0,0,0,.07);font-weight:600}',
    '.aviso-wa .wa-obs{opacity:.8}',
    '#wa-saude{cursor:default}',
    '#wa-saude.wa-ok{color:#1e8e4e}',
    '#wa-saude.wa-ruim{color:#cf3f36;font-weight:700}',
    '#wa-saude.wa-velho{color:#7a5c12}'
  ].join('');

  function estilo() {
    if (document.getElementById('css-aviso-wa')) return;
    var s = document.createElement('style');
    s.id = 'css-aviso-wa';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function horaBR(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  /* Chip no bloco .status do cabeçalho, ao lado do frescor. Criado uma vez. */
  function chip() {
    var el = document.getElementById('wa-saude');
    if (el) return el;
    var status = document.querySelector('.status');
    if (!status) return null;
    el = document.createElement('span');
    el.id = 'wa-saude';
    el.className = 'frescor';
    status.appendChild(el);
    return el;
  }

  /* Recebe wa_saude da API. Idempotente: pode ser chamado a cada repintura. */
  window.avisoWhatsApp = function (lista) {
    estilo();
    var alvo = document.querySelector('header.topo');
    var velho = document.getElementById('aviso-wa');
    if (velho) velho.remove();
    var c = chip();
    lista = lista || [];

    if (!lista.length) {
      if (c) { c.className = 'frescor wa-velho'; c.textContent = 'WhatsApp · sem saúde'; c.title = 'Tabela shrigma_wa_saude vazia — o workflow "WA · Saúde do canal" ainda não rodou.'; }
      return;
    }

    var ruins = lista.filter(function (w) { return w.estado === 'alerta'; });
    var ultima = Math.max.apply(null, lista.map(function (w) { return new Date(w.verificado_em).getTime() || 0; }));
    var velhoMs = Date.now() - ultima;
    var semColeta = velhoMs > 2 * 3600 * 1000;

    if (c) {
      if (ruins.length) {
        c.className = 'frescor wa-ruim';
        c.textContent = 'WhatsApp · ' + ruins.length + ' de ' + lista.length + ' parada' + (ruins.length > 1 ? 's' : '');
      } else if (semColeta) {
        c.className = 'frescor wa-velho';
        c.textContent = 'WhatsApp · saúde de ' + horaBR(new Date(ultima).toISOString());
      } else {
        c.className = 'frescor wa-ok';
        c.textContent = 'WhatsApp ok · ' + lista.length + ' WABAs';
      }
      c.title = lista.map(function (w) {
        return w.nome + ': ' + w.sent_3h + ' envios/3h · ' + w.sent_24h + '/24h · média ' + Math.round(w.media_dia_7d) + '/dia';
      }).join('\n') + '\nVerificado ' + horaBR(new Date(ultima).toISOString());
    }

    if (!alvo) return;
    var div = document.createElement('div');
    div.id = 'aviso-wa';

    if (ruins.length) {
      div.className = 'aviso-wa grave';
      div.innerHTML = '<b>WhatsApp parado</b>' + ruins.map(function (w) {
        return '<span class="wa-chip">' + w.nome + '</span> <span>' + (w.motivo || '') +
               ' · desde ' + horaBR(w.alerta_desde) + '</span>';
      }).join(' ') +
      '<span class="wa-obs">Enquanto estiver assim, carrinho, rastreio e pedido pago não chegam ao cliente. ' +
      'Conferir Faturamento → WhatsApp no Business Manager da marca.</span>';
      alvo.insertAdjacentElement('afterend', div);
      return;
    }
    if (semColeta) {
      div.className = 'aviso-wa aviso';
      div.innerHTML = '<b>Saúde do WhatsApp sem coleta</b><span>última verificação ' + horaBR(new Date(ultima).toISOString()) +
        '</span><span class="wa-obs">O "ok" acima é velho. O workflow "WA · Saúde do canal" roda de hora em hora — ver execuções no n8n.</span>';
      alvo.insertAdjacentElement('afterend', div);
    }
  };
})();
