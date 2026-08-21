/* ================== AVISO DE CREDENCIAL ==================
   Faixa no topo quando uma chave está vencida ou perto de vencer.

   Por que existe: token da Meta e chave do n8n morrem em silêncio. A falha
   nunca aparece como erro — aparece como painel vazio dias depois, e aí o
   dado do intervalo já se perdeu. Este aviso troca "descobrir tarde" por
   "ver todo dia".

   Autônomo de propósito: injeta o próprio CSS em vez de entrar no styles.css.
   As três páginas duplicam o bloco <style> e mexer lá exigiria trocar o hash
   nas três ao mesmo tempo — dívida conhecida, não é hora de pagar.

   Só lê da view crm_credencial_saude, que não carrega o valor da chave. */
(function () {
  var CSS = [
    '.aviso-cred{display:flex;flex-wrap:wrap;gap:10px;align-items:center;',
    'margin:0 0 14px;padding:11px 14px;border-radius:10px;font-size:13px;line-height:1.45;',
    'border:1px solid;font-family:Inter,system-ui,sans-serif}',
    '.aviso-cred.grave{background:#fdf0ee;border-color:#e2a79c;color:#8a2c18}',
    '.aviso-cred.aviso{background:#fdf8e8;border-color:#ddc887;color:#7a5c12}',
    '.aviso-cred b{font-weight:700}',
    '.aviso-cred .cred-chip{display:inline-block;padding:2px 8px;border-radius:999px;',
    'background:rgba(0,0,0,.07);font-weight:600;white-space:nowrap}',
    '.aviso-cred .cred-obs{opacity:.8}'
  ].join('');

  function estilo() {
    if (document.getElementById('css-aviso-cred')) return;
    var s = document.createElement('style');
    s.id = 'css-aviso-cred';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  var ROTULO = {
    meta_token: 'Token da Meta',
    n8n_api: 'Chave do n8n',
    github_pat: 'Token do GitHub'
  };

  /* Recebe crm_credencial da API. Idempotente: pode ser chamado a cada
     repintura sem empilhar faixa. */
  window.avisoCredencial = function (lista) {
    var alvo = document.querySelector('header.topo');
    if (!alvo) return;
    var velho = document.getElementById('aviso-cred');
    if (velho) velho.remove();
    if (!lista || !lista.length) return;

    /* sem_validade não vira aviso: é dívida de cadastro, não risco iminente.
       Alertar por isso todo dia treina a pessoa a ignorar a faixa. */
    var ruins = lista.filter(function (c) {
      return c.estado === 'vencida' || c.estado === 'quebrada' || c.estado === 'vencendo';
    });
    if (!ruins.length) return;

    var grave = ruins.some(function (c) {
      return c.estado === 'vencida' || c.estado === 'quebrada';
    });

    var partes = ruins.map(function (c) {
      var nome = ROTULO[c.chave] || c.chave;
      var d = c.dias_restantes;
      var quando =
        c.estado === 'quebrada' ? 'não está funcionando'
        : c.estado === 'vencida' ? 'venceu'
        : d === 0 ? 'vence hoje'
        : d === 1 ? 'vence amanhã'
        : 'vence em ' + d + ' dias';
      /* origem manual = alguém digitou a data; pode estar errada. Dizer isso
         evita que a faixa seja lida como verdade verificada. */
      var obs = c.origem === 'manual' ? ' <span class="cred-obs">(data informada à mão)</span>' : '';
      return '<span class="cred-chip">' + nome + ' ' + quando + '</span>' + obs;
    });

    var div = document.createElement('div');
    div.id = 'aviso-cred';
    div.className = 'aviso-cred ' + (grave ? 'grave' : 'aviso');
    div.innerHTML =
      '<b>' + (grave ? 'Credencial fora do ar' : 'Credencial vencendo') + '</b>' +
      partes.join(' ') +
      '<span class="cred-obs">Enquanto estiver assim, o painel pode continuar mostrando ' +
      'número velho sem acusar erro.</span>';

    estilo();
    alvo.insertAdjacentElement('afterend', div);
  };
})();
