/* ================== SAÚDE DO WHATSAPP ==================
   Chip permanente no cabeçalho + avisos por conta e horário de verificação.

   Por que existe: em 04/09/2026 a WABA transacional da Fishermans ficou 35h sem
   enviar (cartão cancelado → Meta bloqueou por pagamento, erro 131042) e ninguém
   viu, porque falha de WhatsApp não aparece como erro — aparece como carrinho
   abandonado que ninguém recuperou. Esta faixa troca "descobrir no fim de semana"
   por "ver ao abrir o painel".

   Lê `wa_saude` da API (tabela shrigma_wa_saude, gravada de hora em hora pelo
   workflow "WA · Saúde do canal" a partir do analytics da Meta — inclui o que a
   Reportana envia). Autônomo como alerta-credencial.js: injeta o próprio CSS.

   Cada conta tem seu próprio frescor: uma coleta recente não cobre outra antiga.
   Alerta do monitor não comprova interrupção de todos os envios. */
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
    if (!iso || !Number.isFinite(new Date(iso).getTime())) return 'sem data válida';
    var d = new Date(iso);
    return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function avaliar(lista, agora) {
    var rows = (Array.isArray(lista) ? lista : []).filter(function (w) { return w && typeof w === 'object'; });
    var contas = rows.map(function (w) {
      var stamp = w.verificado_em ? new Date(w.verificado_em).getTime() : NaN;
      var atual = Number.isFinite(stamp) && agora - stamp <= 2 * 3600000 && stamp <= agora + 300000;
      return {dado:w, atual:atual, conhecido:w.estado === 'ok' || w.estado === 'alerta'};
    });
    return {
      contas:contas,
      alertas:contas.filter(function (c) { return c.atual && c.dado.estado === 'alerta'; }),
      semColeta:contas.filter(function (c) { return !c.atual; }),
      desconhecidas:contas.filter(function (c) { return c.atual && !c.conhecido; })
    };
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
    var resumo = avaliar(lista, Date.now());
    var ruins = resumo.alertas;
    var pendentes = resumo.semColeta.length + resumo.desconhecidas.length;
    var total = resumo.contas.length;

    if (c) {
      if (ruins.length) {
        c.className = 'frescor wa-ruim';
        c.textContent = 'WhatsApp · ' + ruins.length + ' conta(s) em alerta' + (pendentes ? ' · ' + pendentes + ' sem confirmação atual' : '');
      } else if (pendentes || !total) {
        c.className = 'frescor wa-velho';
        c.textContent = total ? 'WhatsApp · ' + pendentes + ' conta(s) sem confirmação atual' : 'WhatsApp · saúde indisponível';
      } else {
        c.className = 'frescor wa-ok';
        c.textContent = 'WhatsApp · sem alertas em ' + total + ' conta(s)';
      }
      c.title = 'Saúde geral das contas recebidas nesta consulta; inclui atividade de outros provedores.\n' + resumo.contas.map(function (item) {
        var w = item.dado;
        return (w.nome || 'Conta sem nome') + ': ' + (item.atual ? (item.conhecido ? w.estado : 'estado desconhecido') : 'verificação desatualizada ou inválida') + ' · verificado ' + horaBR(w.verificado_em);
      }).join('\n');
    }

    if (!alvo) return;
    var div = document.createElement('div');
    div.id = 'aviso-wa';

    if (ruins.length || pendentes || !total) {
      div.className = 'aviso-wa ' + (ruins.length ? 'grave' : 'aviso');
      div.innerHTML = '<b>Saúde geral do WhatsApp</b>' + (!total ? '<span>Nenhuma verificação disponível nesta consulta.</span>' : '') +
        ruins.map(function (item) {
          var w = item.dado;
          return '<span class="wa-chip">' + esc(w.nome || 'Conta sem nome') + '</span><span>' + esc(w.motivo || 'Alerta registrado pelo monitor') +
            ' · verificado ' + horaBR(w.verificado_em) + '</span>';
        }).join(' ') +
        resumo.semColeta.map(function (item) {
          var w = item.dado;
          return '<span class="wa-chip">' + esc(w.nome || 'Conta sem nome') + '</span><span>Sem verificação atual · ' + horaBR(w.verificado_em) +
            (w.estado === 'alerta' ? ' · último alerta: ' + esc(w.motivo || 'sem detalhe') : '') + '</span>';
        }).join(' ') +
        resumo.desconhecidas.map(function (item) {
          return '<span class="wa-chip">' + esc(item.dado.nome || 'Conta sem nome') + '</span><span>Estado não reconhecido · verificado ' + horaBR(item.dado.verificado_em) + '</span>';
        }).join(' ') +
        '<span class="wa-obs">O monitor considera toda a atividade da conta, inclusive outros provedores. Confira o motivo e a data de cada conta; este resumo não comprova falha de todos os envios próprios.</span>';
      alvo.insertAdjacentElement('afterend', div);
    }
    return resumo;
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = {avaliar:avaliar};
})();
