/* Aba "Afiliados TikTok Shop" do influs.html.
   Dados: workflow n8n "TikTok Shop - API do painel" (POST, chave de leitura do painel de Influs),
   que lê as tabelas crm_tts_* alimentadas pelo coletor diário (03:30). Lane SEPARADA dos cupons Shopify:
   comissão de afiliado é apurada dentro do TikTok — somar com cupom contaria a mesma venda duas vezes.
   Janela de datas vale para PEDIDOS. Amostras não têm data na API → blocos de amostra são "agora/histórico".
   A matemática fica em TTS (objeto puro, testável com node: tests/influs-tts.test.cjs). */
(function (root) {
  const TTS = {
    MARCAS: ['aristo', 'fish'],
    TIER: {
      comprovado:       { rot: 'Aprovar',        cls: 'bom',    det: 'GMV 30d acima do corte automático' },
      descoberta:       { rot: 'Avaliar',        cls: 'neutro', det: 'GMV 30d na faixa de descoberta — decisão manual' },
      fora_gmv:         { rot: 'Fora · GMV',     cls: 'ruim',   det: 'GMV 30d abaixo do mínimo' },
      fora_sku:         { rot: 'Fora · SKU',     cls: 'ruim',   det: 'variante pedida não está na lista de amostras permitidas' },
      fora_fulfillment: { rot: 'Fora · postagem', cls: 'ruim',  det: 'taxa de postagem de amostras abaixo do mínimo' },
      sku_fora_comprovado: { rot: 'Avaliar · SKU', cls: 'neutro', det: 'variante fora da regra, mas o criador passa do corte de GMV — decisão humana, nunca rejeição automática' },
      sem_regra:        { rot: 'Sem regra',      cls: 'nulo',   det: 'marca sem linha em crm_tts_regra' },
    },
    filtra(arr, marca) { return (arr || []).filter(x => marca === 'todas' || x.marca === marca); },
    soma(arr, k) { return (arr || []).reduce((a, x) => a + (+x[k] || 0), 0); },

    // KPIs do topo da aba. Percentuais só com base >= 30 pedidos (regra do painel).
    kpis(p, marca) {
      const k = TTS.filtra(p.kpis, marca), a = TTS.filtra(p.amostras, marca);
      const gmv = TTS.soma(k, 'gmv'), com = TTS.soma(k, 'comissao'), ped = TTS.soma(k, 'pedidos');
      const gmvVideo = k.reduce((s, x) => s + (+x.gmv || 0) * ((+x.pct_video || 0) / 100), 0);
      const gmvLive = k.reduce((s, x) => s + (+x.gmv || 0) * ((+x.pct_live || 0) / 100), 0);
      const total = TTS.soma(a, 'total');
      const perda = TTS.soma(a, 'venceu_sem_decisao') + TTS.soma(a, 'aprovada_nao_enviada');
      const urg = a.map(x => x.pendente_mais_urgente).filter(Boolean).sort()[0] || null;
      return {
        gmv, comissao: com, pedidos: ped,
        comissaoPct: gmv > 0 ? 100 * com / gmv : null,
        criadores: TTS.soma(k, 'criadores'),
        pctVideo: ped >= 30 && gmv > 0 ? 100 * gmvVideo / gmv : null,
        pctLive: ped >= 30 && gmv > 0 ? 100 * gmvLive / gmv : null,
        pendentes: TTS.soma(a, 'pendentes'), aguardandoEnvio: TTS.soma(a, 'aguardando_envio'),
        emConteudo: TTS.soma(a, 'em_transito_ou_conteudo'),
        amostrasTotal: total, perda, perdaPct: total >= 30 ? 100 * perda / total : null,
        completas: TTS.soma(a, 'completas'), urgente: urg,
      };
    },
    // Horas até um prazo (negativo = vencido). null sem prazo.
    horasAte(iso, agora) { if (!iso) return null; return Math.round((new Date(iso).getTime() - (agora || Date.now())) / 36e5); },
    // Etiqueta de frescor: idade da coleta OK mais recente entre as marcas visíveis; vermelho se > limite ou se a última execução falhou.
    frescor(p, marca, agora, limiteH) {
      const f = TTS.filtra(p.frescor, marca);
      if (!f.length) return { txt: 'coleta —', velho: true, title: 'nenhuma coleta registrada' };
      const now = agora || Date.now();
      const idade = x => x.ultima_ok ? Math.round((now - new Date(x.ultima_ok).getTime()) / 6e4) : null;
      const fmt = m => m === null ? '—' : m < 60 ? m + ' min' : m < 48 * 60 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d';
      const idades = f.map(idade).filter(x => x !== null);
      const maisFresca = idades.length ? Math.min(...idades) : null;
      const falhou = f.some(x => x.ultima_ok_todas === false);
      const velho = maisFresca === null || maisFresca > (limiteH || 26) * 60 || falhou;
      return {
        txt: 'coleta há ' + fmt(maisFresca) + (falhou ? ' · última execução com erro' : ''),
        velho,
        title: f.map(x => `${x.marca}: OK há ${fmt(idade(x))}${x.erros ? ' · erro: ' + x.erros : ''}`).join('\n'),
      };
    },
    // Estado da autorização da loja. Sem linha em crm_tts_token a loja nunca foi (re)autorizada desde que
    // passamos a guardar o refresh token no banco — e é isso que prende os escopos novos (analytics do canal).
    autorizacao(p, marca, agora) {
      const a = TTS.filtra(p.autorizacao || [], marca);
      if (!a.length) return { estado: 'ausente', txt: 'Esta loja ainda não foi reautorizada — os dados de canal (ads, lives, orgânico) ficam vazios até isso acontecer.' };
      const now = agora || Date.now();
      const venc = a.filter(x => x.refresh_expira_em && new Date(x.refresh_expira_em).getTime() < now);
      if (venc.length) return { estado: 'vencida', txt: 'A autorização de ' + venc.map(x => x.loja).join(' e ') + ' venceu. A coleta para hoje até reautorizar.' };
      const perto = a.filter(x => x.expira_em_breve);
      if (perto.length) return { estado: 'expirando', txt: 'A autorização de ' + perto.map(x => x.loja).join(' e ') + ' vence em menos de 14 dias.' };
      const erro = a.find(x => x.ultimo_erro_canal);
      if (erro) return { estado: 'sem_escopo', txt: 'A coleta do canal falhou em ' + erro.loja + ': ' + erro.ultimo_erro_canal };
      return { estado: 'ok', txt: '' };
    },
    // Decisão já gravada pela esteira (dry-run ou real) tem prioridade sobre o tier calculado na hora.
    DECISAO: { auto_aprovada: { rot: 'Aprovar', cls: 'bom' }, auto_rejeitada: { rot: 'Rejeitar', cls: 'ruim' }, fila_manual: { rot: 'Avaliar', cls: 'neutro' },
               manual_aprovada: { rot: 'Aprovada', cls: 'bom' }, manual_rejeitada: { rot: 'Rejeitada', cls: 'ruim' } },
    rotulo(x) {
      const t = TTS.TIER[x.tier_sugerido] || TTS.TIER.sem_regra;
      const d = x.decisao && TTS.DECISAO[x.decisao];
      if (!d) return { rot: t.rot, cls: t.cls, det: t.det };
      return { rot: d.rot + (x.dry_run ? ' (simulado)' : ''), cls: d.cls, det: x.decisao_motivo || t.det };
    },
    // Fila ordenada por urgência (prazo mais curto primeiro), com o rótulo já resolvido.
    fila(p, marca, agora) {
      return TTS.filtra(p.fila, marca).map(x => ({ ...x, horas: TTS.horasAte(x.approve_expira_em, agora), tier: TTS.rotulo(x) }))
        .sort((a, b) => (a.horas ?? 1e9) - (b.horas ?? 1e9));
    },
    // Target collab: taxa convidado→conteúdo, só com base >= 10 convidados.
    targetTaxa(t) { const n = +t.invited_count || 0; return n >= 10 ? 100 * (+t.content_creator_count || 0) / n : null; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = TTS;
  root.TTS = TTS;
})(typeof window !== 'undefined' ? window : globalThis);

/* ---------------- tela (só roda no navegador) ---------------- */
if (typeof window !== 'undefined' && typeof document !== 'undefined') (function () {
  const $ = s => document.querySelector(s);
  const nf = n => (n === null || n === undefined) ? '—' : (+n).toLocaleString('pt-BR');
  const rf = n => (n === null || n === undefined) ? '—' : 'R$ ' + (+n).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const pf = (n, d) => (n === null || n === undefined) ? '—' : (+n).toLocaleString('pt-BR', { maximumFractionDigits: d ?? 0 }) + '%';
  const esc = s => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const MARCA_N = { aristo: 'Aristocrata', fish: 'Fishermans' };
  const tag = m => `<span class="tag ${esc(m)}">${esc(MARCA_N[m] || m)}</span>`;
  const dt = iso => iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '—';
  const prazo = h => h === null ? '<span class="tag nulo">sem prazo</span>'
    : h < 0 ? `<span class="tag alerta">vencida</span>`
    : h < 24 ? `<span class="tag alerta">${h} h</span>`
    : `<span class="tag nulo">${Math.round(h / 24)} d</span>`;

  let DADOS = null, SEQ = 0, PANE = (() => { try { return localStorage.getItem('shrigma_tts_pane') || 'fila'; } catch (e) { return 'fila'; } })();
  const marcaAtual = () => (typeof MARCA !== 'undefined' ? MARCA : 'todas');
  const per = () => (typeof PER !== 'undefined' ? PER : { ini: null, fim: null });

  // ---- escrita (aprovar/rejeitar amostra, editar regra): chave PRÓPRIA, nunca a de leitura ----
  function chaveEscritaTTS() {
    let wk = null; try { wk = localStorage.getItem('shrigma_tts_wkey'); } catch (e) {}
    if (!wk) { wk = (prompt('Chave de ESCRITA do TikTok Shop (aprovar/rejeitar amostra e editar regra):') || '').trim(); if (!wk) return null; try { localStorage.setItem('shrigma_tts_wkey', wk); } catch (e) {} }
    return wk;
  }
  function autorTTS() { try { if (typeof autorAtual === 'function') return autorAtual(); } catch (e) {} let a = ''; try { a = localStorage.getItem('shrigma_autor') || ''; } catch (e) {} if (!a) { a = (prompt('Seu nome (fica registrado na decisão):') || '').trim(); try { if (a) localStorage.setItem('shrigma_autor', a); } catch (e) {} } return a || 'painel'; }
  async function acaoTTS(corpo) {
    if (typeof TTS_ACAO_URL === 'undefined') throw new Error('TTS_ACAO_URL não configurada em config.js');
    const k = chaveEscritaTTS(); if (!k) throw new Error('sem chave de escrita');
    const r = await fetch(TTS_ACAO_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...corpo, k, autor: autorTTS() }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { if (/chave/i.test(j.erro || '')) { try { localStorage.removeItem('shrigma_tts_wkey'); } catch (e) {} } throw new Error(j.erro || j.mensagem || ('HTTP ' + r.status)); }
    return j;
  }
  // botão de duas etapas: 1º clique arma ("Confirmar?"), 2º clique executa; desarma sozinho em 6 s
  function armar(btn, rotuloConfirma, fn) {
    if (btn.dataset.armado) { btn.dataset.armado = ''; btn.disabled = true; btn.textContent = '…'; fn().catch(e => { btn.disabled = false; btn.textContent = 'erro: ' + e.message; }); return; }
    const orig = btn.textContent; btn.dataset.armado = '1'; btn.textContent = rotuloConfirma;
    setTimeout(() => { if (btn.dataset.armado) { btn.dataset.armado = ''; btn.textContent = orig; } }, 6000);
  }

  function vazio(titulo, detalhe, retry) {
    $('#tts-kpis').innerHTML = '';
    $('#tts-area').innerHTML = `<div class="vazio"><strong>${titulo}</strong><br>${detalhe}${retry ? '<br><br><button class="btn" id="tts-retry">Tentar de novo</button>' : ''}</div>`;
    const b = $('#tts-retry'); if (b) b.onclick = carregarTTS;
  }

  async function carregarTTS() {
    if (typeof TTS_API_URL === 'undefined') { vazio('TTS_API_URL não configurada', 'Falta a URL da API do TikTok Shop em config.js.'); return; }
    const k = (typeof chaveLeitura === 'function' ? chaveLeitura() : '') || '';
    if (!k) { vazio('Chave de acesso não informada', 'A mesma chave do painel de Influs abre esta aba.'); return; }
    const anterior = DADOS, seq = ++SEQ;
    try {
      const r = await fetch(TTS_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ k, ini: per().ini, fim: per().fim }) });
      if (r.status === 401) throw new Error('chave inválida para esta API');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const novo = await r.json();
      if (seq !== SEQ) return;            // chegou uma resposta mais nova antes desta: descarta a velha
      DADOS = novo;
      DADOS._caiu = null;
      renderTTS();
    } catch (e) {
      // Nunca tela branca: se já havia dado, mantém e avisa que caiu; senão, aviso com retry.
      if (anterior) { DADOS = anterior; DADOS._caiu = e.message; renderTTS(); }
      else vazio('Falha ao carregar afiliados TikTok', esc(e.message) + '<br><span class="mini">Se persistir, o workflow "TikTok Shop - API do painel" pode estar desativado no n8n.</span>', true);
    }
  }

  function renderTTS() {
    if (!DADOS) return;
    const m = marcaAtual();
    if (m === 'olivas') { $('#tts-frescor').textContent = ''; vazio('Olivas do Campo não vende no TikTok Shop', 'Só O Aristocrata e Fishermans têm loja e programa de afiliados lá.'); return; }
    const f = TTS.frescor(DADOS, m);
    const fe = $('#tts-frescor'); fe.textContent = f.txt + (DADOS._caiu ? ' · leitura falhou agora, mostrando a última' : ''); fe.title = f.title + (DADOS._caiu ? '\nerro: ' + DADOS._caiu : ''); fe.classList.toggle('velho', f.velho || !!DADOS._caiu);
    renderAutorizacao(m); renderKpisTTS(); renderPane();
  }

  // Faixa de autorização: existe para que "escopo faltando" nunca mais apareça como tabela vazia sem motivo.
  function renderAutorizacao(m) {
    const el = $('#tts-autorizacao');
    if (!el) return;
    const a = TTS.autorizacao(DADOS, m);
    if (a.estado === 'ok') { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = `<b>Autorização da loja</b> · ${esc(a.txt)}
      <a class="tts-btn" href="https://services.tiktokshop.com/open/authorize?service_id=7670181171502434055" target="_blank" rel="noopener">Reautorizar no TikTok</a>
      <span class="mini">abra logado como vendedor da loja; a captura grava sozinha e o coletor volta na próxima rodada</span>`;
  }

  function renderKpisTTS() {
    const m = marcaAtual(), k = TTS.kpis(DADOS, m), j = DADOS.janela || {};
    const urg = k.urgente ? TTS.horasAte(k.urgente) : null;
    const cards = [
      { r: 'GMV via afiliado', v: rf(k.gmv), s: `${nf(k.pedidos)} pedidos · ${nf(k.criadores)} criadores venderam · ${j.ini} a ${j.fim}` },
      { r: 'Comissão paga', v: rf(k.comissao), s: k.comissaoPct !== null ? `${pf(k.comissaoPct, 1)} do GMV` : 'sem pedido na janela' },
      { r: 'Vídeo × Live', v: k.pctVideo === null ? '—' : `${pf(k.pctVideo)} <span class="mini">vídeo</span>`, s: k.pctVideo === null ? 'base menor que 30 pedidos' : `${pf(k.pctLive)} live · resto shop/link`, title: 'percentual do GMV por formato de conteúdo que gerou o pedido' },
      { r: 'Amostras pendentes', v: `<span class="${k.pendentes && urg !== null && urg < 24 ? 'vm' : ''}">${nf(k.pendentes)}</span>`, s: (k.pendentes ? (urg === null ? 'aguardando decisão' : urg < 0 ? 'há pedido vencido' : `a mais urgente vence em ${urg < 24 ? urg + ' h' : Math.round(urg / 24) + ' d'}`) : 'nada a decidir agora') + ' · agora, não segue o período', title: 'estado atual da fila no TikTok — não depende do período selecionado' },
      { r: 'Perda operacional', v: k.perdaPct === null ? nf(k.perda) : pf(k.perdaPct), s: `${nf(k.perda)} de ${nf(k.amostrasTotal)} amostras · venceu sem decisão ou aprovada e não enviada · histórico completo, não segue o período`, title: 'histórico completo — a API do TikTok não devolve a data do pedido de amostra, então não dá para recortar por período' },
    ];
    $('#tts-kpis').innerHTML = cards.map(x => `<div class="kpi"${x.title ? ` title="${esc(x.title)}"` : ''}><div class="kpi-rot">${x.r}</div><div class="kpi-val tabn">${x.v}</div><div class="kpi-sub">${x.s}</div></div>`).join('');
  }

  function renderPane() {
    if (!DADOS) return;
    const m = marcaAtual();
    const n = { fila: TTS.filtra(DADOS.fila, m).length, criadores: TTS.filtra(DADOS.criadores, m).length, colabs: TTS.filtra(DADOS.target, m).length + TTS.filtra(DADOS.open, m).length };
    document.querySelectorAll('#tts-abas button').forEach(b => { b.classList.toggle('ativo', b.dataset.p === PANE); const s = b.querySelector('.n'); if (s) s.textContent = n[b.dataset.p] ?? ''; });
    ({ fila: renderFila, criadores: renderCriadores, colabs: renderColabs, regras: renderRegras })[PANE]();
  }

  function renderFila() {
    const m = marcaAtual(), fila = TTS.fila(DADOS, m), envio = TTS.filtra(DADOS.envio, m);
    const modo = (TTS.filtra(DADOS.regra, m)[0] || {}).modo || 'dry_run';
    let html = '';
    if (envio.length) html += `<div class="painel-cab" style="margin-top:4px"><h3 style="margin:0">Aprovadas e ainda não enviadas <span class="tag alerta">${envio.length}</span></h3><span class="mini" title="prazo de envio da plataforma; passou = SELLER_NOT_SHIP_CANCELLED">enviar antes do prazo</span></div>
      <div class="rolagem"><table class="comparativo"><thead><tr><th>Prazo</th><th>Marca</th><th>Criador</th><th>Produto</th><th>Pedido</th></tr></thead><tbody>${envio.map(e => `<tr><td>${prazo(TTS.horasAte(e.envio_expira_em))}</td><td>${tag(e.marca)}</td><td>@${esc(e.username)}</td><td>${esc(e.product_title)} <span class="mini">${esc(e.sku_name)}</span></td><td class="tabn">${esc(e.order_id || '—')}</td></tr>`).join('')}</tbody></table></div>`;
    if (!fila.length) { $('#tts-area').innerHTML = html + '<div class="vazio">Nenhum pedido de amostra aguardando decisão.</div>'; return; }
    html += `<div class="rolagem"><table class="comparativo"><thead><tr>
      <th title="prazo da plataforma para decidir (7 dias); vencido vira OVERDUE_CANCELLED">Vence em</th><th>Marca</th><th>Criador</th>
      <th class="num" title="GMV do criador no TikTok Shop nos últimos 30 dias, todas as lojas (dado da plataforma), em R$">GMV 30d</th>
      <th class="num" title="% das amostras recebidas (todas as marcas, 90 dias) que viraram conteúdo. 0% = sem histórico recente, não é 'não posta'">Postagem</th>
      <th class="num" title="amostras completas / pedidas AQUI, nesta marca (histórico)">Amostras aqui</th>
      <th class="num" title="pedidos · GMV em R$ que esse criador já gerou para esta marca nos últimos 90 dias">Vendeu aqui 90d</th>
      <th>Produto pedido</th>
      <th title="o que a esteira faria com a regra atual (crm_tts_regra). Modo ${esc(modo)}: a decisão continua sendo humana">Sugestão · ${esc(modo === 'dry_run' ? 'simulação' : modo)}</th>
      <th title="executa no TikTok na hora (mesma API do Seller Center) e registra quem decidiu. Clique 2× para confirmar">Decidir</th></tr></thead><tbody>
      ${fila.map(x => `<tr>
        <td>${prazo(x.horas)}</td><td>${tag(x.marca)}</td>
        <td><div class="nome">${esc(x.nickname || x.username)}</div><span class="mini">@${esc(x.username)} · ${nf(x.seguidores)} seg.</span></td>
        <td class="num tabn">${x.gmv_30d === null || x.gmv_30d === undefined ? '—' : nf(Math.round(x.gmv_30d))}</td>
        <td class="num tabn">${pf(x.fulfillment_pct)}</td>
        <td class="num tabn">${nf(x.amostras_completas)}/${nf(x.amostras_total)}</td>
        <td class="num tabn">${x.pedidos_90d ? `${nf(x.pedidos_90d)} · ${nf(Math.round(x.gmv_90d_marca))}` : '—'}</td>
        <td class="tts-prod" title="${esc(x.product_title)}">${esc(String(x.product_title || '').length > 52 ? String(x.product_title).slice(0, 50) + '…' : x.product_title)}<br><span class="mini">${esc(x.sku_name)}${x.is_approvable === false ? ` · <span class="tag alerta" title="${esc(x.motivo_nao_aprovavel || '')}">não aprovável</span>` : ''}</span></td>
        <td><span class="tag ${x.tier.cls}" title="${esc(x.tier.det)}">${x.tier.rot}</span></td>
        <td class="tts-acoes" data-marca="${esc(x.marca)}" data-id="${esc(x.application_id)}"><button class="btn tts-btn tts-ok" ${x.is_approvable === false ? 'disabled title="plataforma não permite aprovar"' : ''}>Aprovar</button><button class="btn tts-btn tts-nao">Rejeitar</button></td></tr>`).join('')}</tbody></table></div>`;
    $('#tts-area').innerHTML = html;
    document.querySelectorAll('#tts-area .tts-acoes button').forEach(b => b.onclick = () => {
      const td = b.closest('td'), aprova = b.classList.contains('tts-ok');
      armar(b, aprova ? 'Confirmar aprovação?' : 'Confirmar rejeição?', async () => {
        await acaoTTS({ acao: 'revisar', marca: td.dataset.marca, application_id: td.dataset.id, resultado: aprova ? 'APPROVE' : 'REJECT', motivo_rejeicao: 'NOT_MATCH' });
        await carregarTTS();
      });
    });
  }

  function renderCriadores() {
    const m = marcaAtual(), lista = TTS.filtra(DADOS.criadores, m);
    if (!lista.length) { $('#tts-area').innerHTML = '<div class="vazio">Nenhum criador vendeu nesta janela.</div>'; return; }
    const tot = TTS.soma(lista, 'gmv');
    $('#tts-area').innerHTML = `<div class="rolagem"><table class="comparativo"><thead><tr>
      <th>#</th><th>Criador</th><th>Marca</th><th class="num">Pedidos</th><th class="num">GMV</th><th class="num" title="participação no GMV da janela">Fatia</th>
      <th class="num">Comissão</th><th class="num" title="% do GMV vindo de vídeo (resto: live, shop, link)">Vídeo</th>
      <th class="num" title="GMV do criador em todo o TikTok Shop, 30 dias (plataforma)">GMV 30d TikTok</th>
      <th class="num" title="taxa de postagem de amostras, 90 dias, todas as marcas">Postagem</th>
      <th class="num" title="amostras completas / pedidas nesta marca">Amostras</th></tr></thead><tbody>
      ${lista.map((c, i) => `<tr><td class="tabn">${i + 1}</td>
        <td><div class="nome">${esc(c.nickname || c.username)}</div><span class="mini">@${esc(c.username)}${c.seguidores ? ' · ' + nf(c.seguidores) + ' seg.' : ''}</span></td>
        <td>${tag(c.marca)}</td><td class="num tabn">${nf(c.pedidos)}</td><td class="num tabn">${rf(c.gmv)}</td>
        <td class="num tabn">${tot ? pf(100 * c.gmv / tot, 1) : '—'}</td><td class="num tabn">${rf(c.comissao)}</td>
        <td class="num tabn">${pf(c.pct_video)}</td><td class="num tabn">${c.gmv_30d === null || c.gmv_30d === undefined ? '—' : rf(c.gmv_30d)}</td>
        <td class="num tabn">${pf(c.fulfillment_pct)}</td><td class="num tabn">${c.amostras_total ? `${nf(c.amostras_completas)}/${nf(c.amostras_total)}` : '—'}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function renderColabs() {
    const m = marcaAtual(), tg = TTS.filtra(DADOS.target, m), op = TTS.filtra(DADOS.open, m);
    const st = s => s === 'ONGOING' ? '<span class="tag bom">em curso</span>' : s === 'EXPIRING' ? '<span class="tag alerta">expirando</span>' : `<span class="tag nulo">${esc(String(s || '').toLowerCase())}</span>`;
    const ps = s => s === 'LIVE' ? '<span class="tag bom">no ar</span>' : `<span class="tag alerta" title="${esc(s)}">${esc(s === 'OUT_OF_STOCK' ? 'sem estoque' : s === 'SELLER_DEACTIVATE' ? 'desativado' : s === 'PLATFORM_DEACTIVATE' ? 'desativado pela plataforma' : String(s || '').toLowerCase())}</span>`;
    let html = `<div class="painel-cab" style="margin-top:4px"><h3 style="margin:0">Target collabs <span class="mini">${tg.length}</span></h3><span class="mini" title="convidados → adicionaram à vitrine → postaram conteúdo. Taxa só com 10+ convidados">funil por campanha</span></div>`;
    html += tg.length ? `<div class="rolagem"><table class="comparativo"><thead><tr><th>Campanha</th><th>Marca</th><th>Status</th><th>Período</th><th class="num">Convidados</th><th class="num">Vitrine</th><th class="num">Conteúdo</th><th class="num" title="conteúdo ÷ convidados">Taxa</th><th class="num">Comissão</th><th>Produtos</th></tr></thead><tbody>
      ${tg.map(t => { const tx = TTS.targetTaxa(t); return `<tr><td class="nome">${esc(t.nome)}</td><td>${tag(t.marca)}</td><td>${st(t.status)}</td><td class="tabn mini">${dt(t.inicio_em)}–${dt(t.fim_em)}</td>
        <td class="num tabn">${nf(t.invited_count)}</td><td class="num tabn">${nf(t.showcase_count)}</td><td class="num tabn">${nf(t.content_creator_count)}</td>
        <td class="num tabn ${tx !== null ? (tx >= 30 ? 'vd' : tx < 10 ? 'vm' : '') : ''}">${tx === null ? '—' : pf(tx)}</td><td class="num tabn">${pf(t.comissao_pct, 1)}</td>
        <td><span class="mini" title="${esc((t.produtos || []).join('\n'))}">${nf(t.product_count)} produto(s)${t.produtos_fora_do_ar ? ` · <span class="tag alerta">${t.produtos_fora_do_ar} fora do ar</span>` : ''}</span></td></tr>`; }).join('')}</tbody></table></div>` : '<div class="vazio">Nenhuma target collab.</div>';
    html += `<div class="painel-cab" style="margin-top:18px"><h3 style="margin:0">Open collab <span class="mini">${op.length} produtos</span></h3><span class="mini" title="quantos criadores adicionaram à vitrine e quantos já postaram, acumulado desde que o produto entrou na open">vitrine e conteúdo acumulados</span></div>`;
    html += op.length ? `<div class="rolagem"><table class="comparativo"><thead><tr><th>Produto</th><th>Marca</th><th>Status</th><th class="num">Comissão</th><th class="num">Vitrine</th><th class="num">Conteúdo</th><th class="num">Estoque</th><th class="num">Preço</th></tr></thead><tbody>
      ${op.map(o => `<tr><td class="nome">${esc(o.product_title)}</td><td>${tag(o.marca)}</td><td>${ps(o.product_status)}</td><td class="num tabn">${pf(o.comissao_pct, 1)}</td>
        <td class="num tabn">${nf(o.showcase_count)}</td><td class="num tabn">${nf(o.content_creator_count)}</td><td class="num tabn">${nf(o.inventario)}</td>
        <td class="num tabn mini">${o.preco_min === o.preco_max ? rf(o.preco_min) : rf(o.preco_min) + '–' + rf(o.preco_max)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="vazio">Nenhum produto na open collab.</div>';
    $('#tts-area').innerHTML = html;
  }

  function renderRegras() {
    const m = marcaAtual(), rs = TTS.filtra(DADOS.regra, m);
    if (!rs.length) { $('#tts-area').innerHTML = '<div class="vazio">Sem regra cadastrada.</div>'; return; }
    const inp = (r, campo, passo, titulo) => `<input type="number" class="i-sel tts-r" data-campo="${campo}" value="${esc(r[campo])}" step="${passo}" min="0" style="width:96px" title="${esc(titulo)}">`;
    $('#tts-area').innerHTML = `<div class="rolagem"><table class="comparativo"><thead><tr><th>Marca</th>
      <th title="dry_run: a esteira só registra o que faria (simulação); ativo: a esteira EXECUTA aprovação/rejeição automática no TikTok; pausado: esteira não toca">Modo</th>
      <th class="num" title="GMV 30d do criador a partir do qual a amostra é aprovada automaticamente">Aprova ≥</th><th class="num" title="entre este valor e o de aprovação: fila manual">Avalia ≥</th>
      <th class="num" title="abaixo disto (e acima de 0%) rejeita; 0% não penaliza">Postagem mín. %</th><th class="num" title="amostras aprovadas por mês (auto + manual) antes de tudo virar fila manual">Teto/mês</th>
      <th title="variantes que podem virar amostra: padrão (regex sobre título | variante) e/ou lista explícita de sku_id">SKUs permitidos</th><th>Atualizado</th><th></th></tr></thead><tbody>
      ${rs.map(r => `<tr data-marca="${esc(r.marca)}"><td>${tag(r.marca)}</td>
        <td><select class="i-sel tts-r" data-campo="modo" title="a decisão de amostra é manual: o painel só liga simulação ou pausado. Ligar o automático é decisão do Felipe, direto em crm_tts_regra.modo">${['dry_run', 'pausado'].concat(r.modo === 'ativo' ? ['ativo'] : []).map(o => `<option value="${o}" ${r.modo === o ? 'selected' : ''}>${o === 'dry_run' ? 'simulação' : o}</option>`).join('')}</select></td>
        <td class="num">${inp(r, 'gmv_auto', 500, 'R$, GMV 30d')}</td><td class="num">${inp(r, 'gmv_manual', 500, 'R$, GMV 30d')}</td>
        <td class="num">${inp(r, 'fulfillment_min', 1, '% de amostras postadas em 90 dias')}</td><td class="num">${inp(r, 'teto_mensal', 5, 'amostras por mês')}</td>
        <td>${r.sku_regex ? `<span class="mini" title="${esc(r.sku_regex)}">padrão: ${esc(r.marca === 'fish' ? 'multi 150 m · mono 300 m' : r.marca === 'aristo' ? 'unitário ou kit de até 3' : 'regex')}</span>` : ''}${(r.skus_permitidos || []).length ? `<span class="mini"> + ${r.skus_permitidos.length} SKU(s)</span>` : ''}${!r.sku_regex && !(r.skus_permitidos || []).length ? '<span class="tag alerta" title="sem lista nem padrão, a regra de SKU não filtra nada">sem filtro</span>' : ''}</td>
        <td class="mini">${esc(r.atualizado_por || '')} · ${dt(r.atualizado_em)}</td>
        <td><button class="btn tts-btn tts-salvar">Salvar</button> <span class="mini tts-msg"></span></td></tr>`).join('')}</tbody></table></div>
      <div class="nota">Aprovar e rejeitar amostra é <strong>manual</strong> — pelos botões da fila. A esteira roda a cada 2 h só em <strong>simulação</strong>: grava o que faria, não toca no TikTok. Ligar o automático e alterar o padrão de SKU são tarefas de banco (<code>crm_tts_regra.modo</code> e <code>.sku_regex</code>).</div>`;
    document.querySelectorAll('#tts-area .tts-salvar').forEach(b => b.onclick = () => {
      const tr = b.closest('tr'), msg = tr.querySelector('.tts-msg'), regra = {};
      tr.querySelectorAll('.tts-r').forEach(el => { regra[el.dataset.campo] = el.tagName === 'SELECT' ? el.value : Number(el.value); });
      armar(b, 'Confirmar?', async () => {
        const j = await acaoTTS({ acao: 'regra', marca: tr.dataset.marca, regra });
        msg.textContent = j.mensagem || 'ok'; b.disabled = false; b.textContent = 'Salvar';
        await carregarTTS();
      });
    });
  }

  // ligações com a página
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('#tts-abas button').forEach(b => b.onclick = () => { PANE = b.dataset.p; try { localStorage.setItem('shrigma_tts_pane', PANE); } catch (e) {} renderPane(); });
  });
  window.carregarTTS = carregarTTS;
  window.renderTTS = renderTTS;
})();
