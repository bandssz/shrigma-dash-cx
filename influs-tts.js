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
    // Cobrança de conteúdo: junta o que saiu, o que está simulado e quantos ainda faltam.
    cobranca(p, marca) {
      const c = TTS.filtra(p.cobranca || [], marca);
      const r = TTS.filtra(p.cobranca_regra || [], marca);
      const pend = TTS.filtra(p.cobranca_pendentes || [], marca);
      const pulos = TTS.filtra(p.cobranca_pulos || [], marca);
      const soma = (a, k) => a.reduce((t, x) => t + (Number(x[k]) || 0), 0);
      const modos = [...new Set(r.map(x => x.cobranca_modo))];
      // quem respondeu está esperando gente, não robô: é a linha mais urgente da aba
      const responderam = pulos.filter(x => x.motivo === 'respondeu').sort((a, b) => (+b.nao_lidas || 0) - (+a.nao_lidas || 0) || String(b.ultima_msg_em).localeCompare(String(a.ultima_msg_em)));
      return {
        responderam, naoLidas: soma(responderam, 'nao_lidas'), conversasAtivas: pulos.filter(x => x.motivo === 'conversa_ativa').length,
        enviadas: soma(c, 'enviadas'), falhas: soma(c, 'falhas'), simuladas: soma(c, 'simuladas'),
        pendentes: soma(pend, 'pendentes'),
        tetoDia: soma(r, 'cobranca_max_dia'),
        // 'misto' quando as duas marcas estão em modos diferentes e a visão é das duas
        modo: modos.length === 1 ? modos[0] : (modos.length ? 'misto' : null),
      };
    },
    // Canal (Shop Analytics): a loja inteira por dia, não só afiliado. Soma as marcas quando a visão é 'todas'.
    // Regra de leitura: gmv_afiliado vem dos pedidos de afiliado (crm_tts_pedido); live/vídeo/vitrine vem da
    // plataforma. São cortes DIFERENTES do mesmo GMV — uma live de afiliado conta nos dois. Não somar entre cortes.
    canal(p, marca, hoje) {
      const dias = TTS.filtra(p.canal || [], marca);
      const tot = TTS.filtra(p.canal_total || [], marca);
      const soma = k => TTS.soma(tot, k);
      const gmv = soma('gmv'), ped = soma('pedidos'), vis = soma('visitantes');
      const pct = v => gmv > 0 ? 100 * v / gmv : null;
      // série por dia somando marcas (quando 'todas'); cada dia vira 1 barra empilhada por superfície
      const porDia = {};
      for (const d of dias) {
        const k = String(d.dia).slice(0, 10);
        const x = porDia[k] || (porDia[k] = { dia: k, gmv: 0, live: 0, video: 0, vitrine: 0, afiliado: 0, proprio: 0, ads: 0, pedidos: 0, visitantes: 0, reembolso: 0 });
        x.gmv += +d.gmv || 0; x.live += +d.gmv_live || 0; x.video += +d.gmv_video || 0; x.vitrine += +d.gmv_vitrine || 0;
        x.afiliado += +d.gmv_afiliado || 0; x.proprio += +d.gmv_proprio || 0; x.ads += +d.gmv_ads || 0;
        x.pedidos += +d.pedidos || 0; x.visitantes += +d.visitantes || 0; x.reembolso += +d.reembolso || 0;
      }
      const serie = Object.values(porDia).sort((a, b) => a.dia < b.dia ? -1 : 1);
      const h = hoje || new Date().toISOString().slice(0, 10);
      for (const x of serie) { x.parcial = x.dia >= h; x.pctAfiliado = x.gmv > 0 ? 100 * x.afiliado / x.gmv : null; x.conversao = x.visitantes > 0 ? 100 * x.pedidos / x.visitantes : null; }
      const melhor = serie.reduce((m, x) => (!m || x.gmv > m.gmv ? x : m), null);
      return {
        temDados: tot.length > 0, dias: serie.length,
        gmv, pedidos: ped, visitantes: vis, reembolso: soma('reembolso'),
        live: soma('gmv_live'), video: soma('gmv_video'), vitrine: soma('gmv_vitrine'),
        afiliado: soma('gmv_afiliado'), proprio: soma('gmv_proprio'), ads: soma('gmv_ads'),
        pctLive: pct(soma('gmv_live')), pctVideo: pct(soma('gmv_video')), pctVitrine: pct(soma('gmv_vitrine')),
        pctAfiliado: pct(soma('gmv_afiliado')), pctAds: pct(soma('gmv_ads')),
        conversao: vis > 0 ? 100 * ped / vis : null, ticket: ped > 0 ? gmv / ped : null,
        serie, melhorDia: melhor,
        lives: TTS.filtra(p.lives || [], marca).slice().sort((a, b) => (+b.gmv || 0) - (+a.gmv || 0) || String(b.inicio_em).localeCompare(String(a.inicio_em))),
        eventos: TTS.agruparLives(TTS.filtra(p.lives || [], marca), 30),
        liveProdutos: TTS.filtra(p.live_produtos || [], marca),
        videos: TTS.filtra(p.videos || [], marca).slice().sort((a, b) => (+b.gmv || 0) - (+a.gmv || 0)),
      };
    },
    // Live como a equipe vê, não como a API entrega. A API devolve SESSÕES: caiu o sinal, virou sessão
    // nova. A live da Fishermans de 16/09 foram 3 sessões (61 + 101 + 16 min) com ~1 min entre elas —
    // "a live deu R$ 762" e "a live deu R$ 1.064" eram a mesma live, contada de dois jeitos. Sessões da
    // mesma conta com intervalo <= gapMin viram um EVENTO; o número da live é a soma das sessões.
    // gmv da API é PAGO; pedidos_criados inclui não pago (COD/PayLater) — o valor se mexe por ~72 h.
    agruparLives(lives, gapMin, agora) {
      const gap = (gapMin || 30) * 6e4, now = agora || Date.now();
      const ord = (lives || []).slice().sort((a, b) => String(a.username) < String(b.username) ? -1 : String(a.username) > String(b.username) ? 1 : String(a.inicio_em).localeCompare(String(b.inicio_em)));
      const evs = [];
      for (const l of ord) {
        const ini = new Date(l.inicio_em).getTime();
        const fim = l.fim_em ? new Date(l.fim_em).getTime() : ini + (+l.duracao_min || 0) * 6e4;
        const ult = evs[evs.length - 1];
        if (ult && ult.marca === l.marca && ult.username === l.username && ini - ult.fimMs <= gap) { ult.sessoes.push(l); ult.fimMs = Math.max(ult.fimMs, fim); }
        else evs.push({ marca: l.marca, username: l.username, origem: l.origem, titulo: l.titulo || null, inicio_em: l.inicio_em, iniMs: ini, fimMs: fim, sessoes: [l] });
      }
      const soma = (a, k) => a.reduce((t, x) => t + (+x[k] || 0), 0);
      for (const e of evs) {
        const ss = e.sessoes;
        e.fim_em = new Date(e.fimMs).toISOString();
        e.titulo = e.titulo || (ss.map(x => x.titulo).filter(Boolean)[0] || null);
        e.gmv = soma(ss, 'gmv'); e.pedidos = soma(ss, 'pedidos'); e.pedidos_criados = soma(ss, 'pedidos_criados');
        e.pendentes = Math.max(0, e.pedidos_criados - e.pedidos);           // criados e ainda não pagos
        e.duracao_min = soma(ss, 'duracao_min'); e.espectadores = soma(ss, 'espectadores'); e.cliques = soma(ss, 'cliques'); e.impressoes = soma(ss, 'impressoes_produto');
        e.novos_seguidores = soma(ss, 'novos_seguidores'); e.compradores = soma(ss, 'compradores');
        e.ctr_pct = e.impressoes > 0 ? 100 * e.cliques / e.impressoes : null;
        e.clique_pedido_pct = e.cliques > 0 ? 100 * e.pedidos / e.cliques : null;
        e.gmv_24h = ss.every(x => x.gmv_24h !== null && x.gmv_24h !== undefined) ? soma(ss, 'gmv_24h') : null;
        e.emFechamento = now - e.fimMs < 72 * 36e5;                         // a plataforma ainda revisa
        e.live_ids = ss.map(x => String(x.live_id));
      }
      return evs.sort((a, b) => b.gmv - a.gmv || b.iniMs - a.iniMs);
    },
    // Produtos de um evento: soma as sessões por produto (a mesma linha pinada nas 3 sessões é 1 produto).
    produtosDoEvento(ev, produtos) {
      const ids = new Set(ev.live_ids || []), m = new Map();
      for (const p of (produtos || [])) {
        if (!ids.has(String(p.live_id))) continue;
        const x = m.get(p.product_id) || { product_id: p.product_id, nome: p.nome, gmv_direto: 0, pedidos: 0, pedidos_criados: 0, compradores: 0, impressoes: 0, cliques: 0 };
        for (const k of ['gmv_direto', 'pedidos', 'pedidos_criados', 'compradores', 'impressoes', 'cliques']) x[k] += +p[k] || 0;
        m.set(p.product_id, x);
      }
      return [...m.values()].map(x => ({ ...x, ctr_pct: x.impressoes > 0 ? 100 * x.cliques / x.impressoes : null, clique_pedido_pct: x.cliques > 0 ? 100 * x.pedidos / x.cliques : null }))
        .sort((a, b) => b.gmv_direto - a.gmv_direto || b.cliques - a.cliques);
    },
    // Pintura instantânea: o payload da última leitura serve como primeira tela se for da MESMA janela
    // e tiver menos de 24 h. A API leva 3–7 s (n8n) — sem isto a aba abre em "Carregando…" toda vez.
    cacheServe(c, ini, fim, agora) {
      if (!c || !c.payload || !c.em) return false;
      if (String(c.ini || '') !== String(ini || '') || String(c.fim || '') !== String(fim || '')) return false;
      return ((agora || Date.now()) - new Date(c.em).getTime()) < 24 * 36e5;
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
      // Autorização válida mas sem os escopos do canal. A Sonda (6h) separa os dois casos, que pedem
      // ações opostas: permissão já liberada no app -> reautorizar resolve AGORA; ainda em análise na
      // TikTok -> reautorizar não muda nada, é esperar. Sem essa distinção a faixa manda fazer trabalho à toa.
      const e = TTS.filtra(p.escopos || [], marca)[0];
      const dia = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('pt-BR') + ' ' + d.toTimeString().slice(0, 5); };
      // Só pede reautorização quando a família MUDOU de estado depois da última autorização.
      // A mensagem de erro da API sozinha não prova que a permissão foi aprovada.
      if (e && (e.mudou_desde_autorizacao || []).length) {
        return { estado: 'reautorizar_agora',
          txt: 'Mudou algo em ' + e.mudou_desde_autorizacao.join(', ') + ' depois da última autorização' +
               (e.autorizado_em ? ' (' + dia(e.autorizado_em) + ')' : '') + '. Vale reautorizar as duas lojas.' };
      }
      if (e && (e.aguardando_tiktok || []).length && e.conferido_apos_autorizar) {
        return { estado: 'sem_escopo', app: true,
          txt: e.aguardando_tiktok.join(', ') + ' não chegam no token. A reautorização de ' +
               dia(e.autorizado_em) + ' já foi conferida e não trouxe nenhuma delas, então reautorizar de novo ' +
               'não resolve — falta a TikTok aprovar no app. A sonda avisa aqui quando mudar.' };
      }
      if (e && (e.aguardando_tiktok || []).length) {
        return { estado: 'sem_escopo', app: true,
          txt: e.aguardando_tiktok.join(', ') + ' ainda não chegam no token — falta a TikTok liberar no app.' };
      }
      const faltam = a.filter(x => (x.escopos_faltando || []).length);
      if (faltam.length) {
        const s = [...new Set(faltam.flatMap(x => x.escopos_faltando))];
        return { estado: 'sem_escopo', app: true,
          txt: 'A autorização de ' + faltam.map(x => x.loja).join(' e ') + ' está válida, mas não carrega ' +
               s.join(', ') + ' — sem isso os dados de canal (ads, lives, orgânico) não vêm.' };
      }
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
    if (!DADOS) {  // primeira abertura: pinta a última leitura guardada enquanto a API responde
      let c = null; try { c = JSON.parse(localStorage.getItem('shrigma_tts_cache') || 'null'); } catch (e) {}
      if (TTS.cacheServe(c, per().ini, per().fim)) { DADOS = c.payload; DADOS._cache = c.em; renderTTS(); }
    }
    try {
      const r = await fetch(TTS_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ k, ini: per().ini, fim: per().fim }) });
      if (r.status === 401) throw new Error('chave inválida para esta API');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const novo = await r.json();
      if (seq !== SEQ) return;            // chegou uma resposta mais nova antes desta: descarta a velha
      DADOS = novo;
      DADOS._caiu = null; DADOS._cache = null;
      try { localStorage.setItem('shrigma_tts_cache', JSON.stringify({ em: new Date().toISOString(), ini: per().ini, fim: per().fim, payload: novo })); } catch (e) {}
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
    const fe = $('#tts-frescor'); fe.textContent = f.txt + (DADOS._caiu ? ' · leitura falhou agora, mostrando a última' : '') + (DADOS._cache ? ' · atualizando…' : ''); fe.title = f.title + (DADOS._caiu ? '\nerro: ' + DADOS._caiu : ''); fe.classList.toggle('velho', f.velho || !!DADOS._caiu);
    renderAutorizacao(m); renderPane();
  }

  // Faixa de autorização: existe para que "escopo faltando" nunca mais apareça como tabela vazia sem motivo.
  function renderAutorizacao(m) {
    const el = $('#tts-autorizacao');
    if (!el) return;
    const a = TTS.autorizacao(DADOS, m);
    const aviso = $('#tts-aviso');
    if (aviso) { aviso.hidden = true; aviso.textContent = ''; }
    if (a.estado === 'ok') { el.hidden = true; el.innerHTML = ''; return; }
    // Esperar a TikTok não é tarefa de ninguém aqui: vira etiqueta ao lado do frescor, com o texto no title.
    if (a.estado === 'sem_escopo' && a.app && aviso) {
      el.hidden = true; el.innerHTML = '';
      const n = (TTS.filtra(DADOS.escopos || [], m)[0] || {}).aguardando_tiktok || [];
      aviso.hidden = false; aviso.textContent = `${n.length || ''} permiss${n.length === 1 ? 'ão' : 'ões'} em análise na TikTok`; aviso.title = a.txt;
      return;
    }
    el.hidden = false;
    el.innerHTML = `<b>Autorização da loja</b> · ${esc(a.txt)}
      ${a.app && a.estado !== 'reautorizar_agora'
        ? `<a class="tts-btn" href="https://partner.tiktokshop.com/" target="_blank" rel="noopener">Abrir o Partner Center</a>
           <span class="mini">liberar o escopo no app &rarr; só então reautorizar as duas lojas</span>`
        : `<a class="tts-btn" href="https://services.tiktokshop.com/open/authorize?service_id=7670181171502434055" target="_blank" rel="noopener">Reautorizar no TikTok</a>
           <span class="mini">abra logado como vendedor da loja; a captura grava sozinha e o coletor volta na próxima rodada</span>`}`;
  }

  function renderKpisTTS() {
    if (PANE === 'canal') { $('#tts-kpis').innerHTML = cardsCanal(); return; }
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
    const n = { fila: TTS.filtra(DADOS.fila, m).length, criadores: TTS.filtra(DADOS.criadores, m).length, colabs: TTS.filtra(DADOS.target, m).length + TTS.filtra(DADOS.open, m).length, cobranca: TTS.cobranca(DADOS, m).pendentes };
    document.querySelectorAll('#tts-abas button').forEach(b => { b.classList.toggle('ativo', b.dataset.p === PANE); const s = b.querySelector('.n'); if (s) s.textContent = n[b.dataset.p] ?? ''; });
    renderKpisTTS();   // a linha de cartões muda com a aba (Canal = loja inteira; demais = afiliado)
    ({ fila: renderFila, criadores: renderCriadores, colabs: renderColabs, cobranca: renderCobranca, canal: renderCanal, regras: renderRegras })[PANE]();
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
      ${dobra(lista.map((c, i) => `<tr><td class="tabn">${i + 1}</td>
        <td><div class="nome">${esc(c.nickname || c.username)}</div><span class="mini">@${esc(c.username)}${c.seguidores ? ' · ' + nf(c.seguidores) + ' seg.' : ''}</span></td>
        <td>${tag(c.marca)}</td><td class="num tabn">${nf(c.pedidos)}</td><td class="num tabn">${rf(c.gmv)}</td>
        <td class="num tabn">${tot ? pf(100 * c.gmv / tot, 1) : '—'}</td><td class="num tabn">${rf(c.comissao)}</td>
        <td class="num tabn">${pf(c.pct_video)}</td><td class="num tabn">${c.gmv_30d === null || c.gmv_30d === undefined ? '—' : rf(c.gmv_30d)}</td>
        <td class="num tabn">${pf(c.fulfillment_pct)}</td><td class="num tabn">${c.amostras_total ? `${nf(c.amostras_completas)}/${nf(c.amostras_total)}` : '—'}</td></tr>`), 15, 'todos os criadores')}</tbody></table></div>`;
    ligarDobras();
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

  function renderCobranca() {
    const m = marcaAtual(), c = TTS.cobranca(DADOS, m);
    const fila = TTS.filtra(DADOS.cobranca_fila || [], m);
    if (!fila.length && !c.pendentes && !c.responderam.length) { $('#tts-area').innerHTML = '<div class="vazio">Ninguém devendo conteúdo agora.</div>'; return; }
    const ETAPA = { vitrine_sem_video: 'Pôs na vitrine, não gravou', amostra_sem_video: 'Recebeu amostra, não postou' };
    // Responderam: o robô parou de propósito — a próxima palavra é da Marcela, no Seller Center.
    let topo = '';
    if (c.responderam.length) topo = `<div class="painel-cab" style="margin-top:4px"><h3 style="margin:0">Responderam e estão esperando <span class="tag alerta">${c.responderam.length}</span></h3>
        <span class="mini" title="o robô leu a conversa antes de cobrar e parou: a última mensagem é do criador. Responder é no chat do Seller Center.">${c.naoLidas ? c.naoLidas + ' mensagens sem ler · ' : ''}robô não cobra quem respondeu</span></div>
      <div class="rolagem"><table class="comparativo"><thead><tr><th>Marca</th><th>Criador</th><th>Devia</th><th class="num" title="mensagens do criador que ninguém da loja abriu">Sem ler</th><th>Última mensagem</th><th>Quando</th></tr></thead><tbody>
      ${dobra(c.responderam.map(x => `<tr><td>${tag(x.marca)}</td><td>@${esc(x.username)}</td><td class="mini">${esc(ETAPA[x.etapa] || x.etapa)}</td>
        <td class="num tabn">${+x.nao_lidas ? `<span class="vm">${nf(x.nao_lidas)}</span>` : '—'}</td>
        <td class="msg" title="${esc(x.ultimo_texto || '')}">${esc(x.ultimo_texto || '')}</td><td class="mini tabn">${dt(x.ultima_msg_em)}</td></tr>`), 10, 'todos')}</tbody></table></div>`;
    const linhas = fila.map(x => `<tr>
      <td>${tag(x.marca)}</td>
      <td>@${esc(x.username)}</td>
      <td>${esc(ETAPA[x.etapa] || x.etapa)}</td>
      <td class="num tabn" title="toque ${x.tentativa} da régua">${x.tentativa || 1}</td>
      <td><span class="tag ${x.dry_run ? 'neutro' : (x.ok ? 'bom' : 'ruim')}">${x.dry_run ? 'simulada' : (x.ok ? 'enviada' : 'falhou')}</span></td>
      <td class="msg" title="${esc(x.texto || '')}">${esc((x.texto || '').split('\n')[0])}</td>
      <td class="mini tabn">${x.erro ? esc(x.erro) : dt(x.enviado_em)}</td></tr>`);
    $('#tts-area').innerHTML = topo + `${fila.length ? `<div class="painel-cab" style="margin-top:${topo ? 18 : 4}px"><h3 style="margin:0">Toques da régua <span class="tag nulo">${fila.length}</span></h3><span class="mini">${c.conversasAtivas ? c.conversasAtivas + ' pulados por conversa em andamento' : ''}</span></div>` : ''}<div class="rolagem"><table class="comparativo">
      <thead><tr><th>Marca</th><th>Criador</th><th>Por quê</th><th class="num" title="qual toque da régua">Toque</th>
        <th title="simulada = gravada, nada foi enviado ao criador">Estado</th>
        <th>Mensagem <span class="mini">passe o mouse para ler inteira</span></th><th>Quando</th></tr></thead>
      <tbody>${dobra(linhas, 12, 'todos os toques')}</tbody></table></div>
      <div class="painel-cab" style="margin-top:16px"><h3 style="margin:0">Ligar a cobrança</h3>
        <span class="mini">${c.modo === 'ativo' ? `até ${c.tetoDia} por dia · ${c.pendentes} na fila`
          : `${c.simuladas} prontas, nenhuma enviada · ${c.pendentes} devendo conteúdo`}</span></div>
      <div class="rolagem"><table class="comparativo"><thead><tr><th>Marca</th><th>Cobrança</th><th class="num">Máx/dia</th><th class="num" title="quantas vezes cobrar a mesma pessoa">Toques</th><th class="num" title="dias entre um toque e o próximo">Intervalo</th><th></th></tr></thead><tbody>
      ${TTS.filtra(DADOS.cobranca_regra || [], m).map(r => `<tr data-marca="${esc(r.marca)}">
        <td>${tag(r.marca)}</td>
        <td><select class="i-sel tts-c" data-campo="cobranca_modo" title="simulação grava a mensagem e não envia nada; ativo envia de verdade, respeitando o teto — e lê a conversa antes: quem respondeu ou está conversando não recebe robô">${['dry_run', 'ativo', 'pausado'].map(o => `<option value="${o}" ${r.cobranca_modo === o ? 'selected' : ''}>${o === 'dry_run' ? 'simulação' : o}</option>`).join('')}</select></td>
        <td class="num"><input type="number" class="i-sel tts-c" data-campo="cobranca_max_dia" value="${esc(r.cobranca_max_dia)}" step="5" min="0" style="width:88px" title="teto de mensagens por dia nesta marca"></td>
        <td class="num"><input type="number" class="i-sel tts-c" data-campo="cobranca_max_tentativas" value="${esc(r.cobranca_max_tentativas)}" step="1" min="1" style="width:80px" title="quantas vezes cobrar a mesma pessoa antes de parar"></td>
        <td class="num"><input type="number" class="i-sel tts-c" data-campo="cobranca_dias_entre" value="${esc(r.cobranca_dias_entre)}" step="1" min="1" style="width:80px" title="dias de espera entre um toque e o próximo"></td>
        <td><button class="btn tts-btn tts-salvar-cob">Salvar</button> <span class="mini tts-msg"></span></td></tr>`).join('')}
      </tbody></table></div>`;
    document.querySelectorAll('#tts-area .tts-salvar-cob').forEach(b => b.onclick = () => {
      const tr = b.closest('tr'), msg = tr.querySelector('.tts-msg'), regra = {};
      tr.querySelectorAll('.tts-c').forEach(el => { regra[el.dataset.campo] = el.tagName === 'SELECT' ? el.value : Number(el.value); });
      // confirmação extra quando o clique liga o envio real: daqui sai mensagem em nome da marca
      const liga = regra.cobranca_modo === 'ativo';
      armar(b, liga ? 'Enviar de verdade?' : 'Confirmar?', async () => {
        const j = await acaoTTS({ acao: 'regra', marca: tr.dataset.marca, regra });
        msg.textContent = j.mensagem || 'ok'; b.disabled = false; b.textContent = 'Salvar';
        await carregarTTS();
      });
    });
    ligarDobras();
  }

  // Aba Canal: a loja inteira (Shop Analytics), para responder "quanto do que vendemos veio de afiliado,
  // de live, de vídeo, de ads?" — e para ver o que uma live faz com o dia.
  const pctOu = (v, d) => (v === null || v === undefined) ? '—' : pf(+v, d ?? 0);
  function cardsCanal() {
    const m = marcaAtual(), c = TTS.canal(DADOS, m), j = DADOS.janela || {};
    if (!c.temDados) return '';
    const cards = [
      { r: 'GMV da loja', v: rf(c.gmv), s: `${nf(c.pedidos)} pedidos · ticket ${rf(c.ticket)} · ${j.ini} a ${j.fim}`, t: 'GMV total da loja no TikTok Shop (plataforma), todas as origens' },
      { r: 'Veio de afiliado', v: pctOu(c.pctAfiliado), s: `${rf(c.afiliado)} afiliado · ${rf(c.proprio)} próprio`, t: 'GMV dos pedidos com criador afiliado (crm_tts_pedido) sobre o GMV total da loja' },
      { r: 'Live · Vídeo · Vitrine', v: `${pctOu(c.pctLive)} <span class="mini">live</span>`, s: `${pctOu(c.pctVideo)} vídeo · ${pctOu(c.pctVitrine)} vitrine/link`, t: 'corte da plataforma por tipo de conteúdo que gerou o pedido — inclui lives e vídeos de afiliados' },
      { r: 'GMV Max (ads TikTok)', v: pctOu(c.pctAds, 1), s: c.ads ? `${rf(c.ads)} com ads da própria TikTok` : 'sem GMV Max na janela', t: 'parte da receita bruta que a plataforma marca como GMV Max' },
      { r: 'Conversão', v: pctOu(c.conversao, 2), s: `${nf(c.visitantes)} visitantes · reembolso ${rf(c.reembolso)}`, t: 'pedidos / visitantes únicos da loja (plataforma)' },
    ];
    return cards.map(x => `<div class="kpi" title="${esc(x.t)}"><div class="kpi-rot">${x.r}</div><div class="kpi-val tabn">${x.v}</div><div class="kpi-sub">${x.s}</div></div>`).join('');
  }
  // Linhas além de N ficam escondidas atrás de um "ver mais": a aba abre leve e quem quer o rabo da lista clica.
  const dobra = (linhas, n, rotulo) => linhas.length <= n ? linhas.join('')
    : linhas.map((l, i) => i < n ? l : l.replace('<tr', '<tr class="tts-oculto"')).join('')
      + `<tr class="tts-mais-tr"><td colspan="20"><button class="btn tts-btn tts-mais">ver ${rotulo || 'todos'} (${linhas.length - n} a mais)</button></td></tr>`;
  function ligarDobras() {
    document.querySelectorAll('#tts-area .tts-mais').forEach(b => b.onclick = () => {
      const tb = b.closest('tbody'); tb.querySelectorAll('.tts-oculto').forEach(tr => tr.classList.remove('tts-oculto')); b.closest('tr').remove();
    });
  }
  function renderCanal() {
    const m = marcaAtual(), c = TTS.canal(DADOS, m), todas = m === 'todas';
    if (!c.temDados) { $('#tts-area').innerHTML = '<div class="vazio"><strong>Sem dado de canal nesta janela.</strong><br>O coletor de canal roda às 04:10 e depende do escopo Shop Analytics em cada loja — veja a faixa de autorização no topo.</div>'; return; }
    const thM = todas ? '<th>Marca</th>' : '', tdM = x => todas ? `<td>${tag(x.marca)}</td>` : '';
    // barras empilhadas por dia (live / vídeo / vitrine) — SVG inline, sem biblioteca
    let html = graficoCanal(c.serie);

    // lives — por evento (sessões agrupadas), com sessões e produtos ao clicar
    const ev = c.eventos, evVenda = ev.filter(e => e.gmv > 0).length, emFech = ev.filter(e => e.emFechamento && e.gmv > 0).length;
    html += `<div class="painel-cab" style="margin-top:18px"><h3 style="margin:0" title="a API devolve sessões; queda de sinal vira sessão nova. Sessões da mesma conta com até 30 min de intervalo são mostradas como uma live só. GMV = pago; pedido criado e não pago aparece como pendente. A plataforma revisa os números por ~72 h.">Lives no período <span class="tag nulo">${ev.length}</span>${emFech ? ` <span class="tag neutro" title="terminou há menos de 72 h: a plataforma ainda revisa pedidos pagos, cancelados e pendentes">${emFech} em fechamento</span>` : ''}</h3><span class="mini">${evVenda} com venda · loja e afiliados · clique na linha para ver sessões e produtos</span></div>`;
    if (!ev.length) html += '<div class="vazio">Nenhuma live no período.</div>';
    else html += `<div class="rolagem"><table class="comparativo tts-ev"><thead><tr>
      <th>Quando</th>${thM}<th>Quem</th><th class="num" title="minutos ao vivo, somando as sessões">Duração</th>
      <th class="num" title="espectadores únicos por sessão, somados — quem voltou depois da queda conta de novo">Espectadores</th><th class="num" title="cliques em produto / impressões de produto">CTR</th>
      <th class="num" title="pedidos pagos / cliques em produto">Clique→pedido</th><th class="num" title="pedidos pagos · pendentes de pagamento">Pedidos</th><th class="num" title="GMV pago somando as sessões">GMV</th>
      <th class="num" title="GMV nas 24 h após a live (a plataforma fecha com atraso)">GMV 24 h</th><th class="num">Seguidores</th></tr></thead><tbody>
      ${dobra(ev.slice(0, 60).map((e, i) => `<tr class="tts-ev-linha" data-i="${i}" style="cursor:pointer">
        <td class="tabn">${dtHora(e.inicio_em)}${e.sessoes.length > 1 ? ` <span class="tag nulo" title="${e.sessoes.length} sessões: a live caiu e voltou">${e.sessoes.length}×</span>` : ''}${e.emFechamento && e.gmv > 0 ? ' <span class="mini" title="terminou há menos de 72 h — números ainda em revisão pela plataforma">◔</span>' : ''}</td>${tdM(e)}
        <td><div class="nome">${e.origem === 'proprio' ? '<span class="tag bom">loja</span>' : '@' + esc(e.username || '—')}</div>${e.titulo ? `<span class="mini" title="${esc(e.titulo)}">${esc(String(e.titulo).slice(0, 40))}</span>` : ''}</td>
        <td class="num tabn">${e.duracao_min ? nf(e.duracao_min) + ' min' : '—'}</td>
        <td class="num tabn">${e.espectadores ? nf(e.espectadores) : '—'}</td><td class="num tabn">${pctOu(e.ctr_pct, 1)}</td>
        <td class="num tabn">${pctOu(e.clique_pedido_pct, 1)}</td>
        <td class="num tabn">${nf(e.pedidos)}${e.pendentes ? ` <span class="mini" title="${e.pendentes} pedido(s) criado(s) e ainda não pago(s) — COD/PayLater; entra no GMV quando pagar">+${e.pendentes}</span>` : ''}</td><td class="num tabn"><b>${rf(e.gmv)}</b></td>
        <td class="num tabn">${e.gmv_24h === null ? '<span class="mini" title="a plataforma ainda não fechou as 24 h">…</span>' : rf(e.gmv_24h)}</td>
        <td class="num tabn">${e.novos_seguidores ? '+' + nf(e.novos_seguidores) : '—'}</td></tr>`), 8, 'todas as lives')}</tbody></table></div>`;

    // vídeos (retrato 30 dias)
    const vd = c.videos, retrato = vd[0] ? dt(vd[0].retrato_em) : null;
    html += `<div class="painel-cab" style="margin-top:18px"><h3 style="margin:0">Vídeos que venderam <span class="tag nulo">${vd.length}</span></h3><span class="mini" title="a plataforma devolve o acumulado dos últimos 30 dias, não por dia — este bloco não segue o período">últimos 30 dias · retrato de ${retrato || '—'}</span></div>`;
    if (!vd.length) html += '<div class="vazio">Nenhum vídeo com venda nos últimos 30 dias.</div>';
    else html += `<div class="rolagem"><table class="comparativo"><thead><tr>
      <th>#</th><th>Criador</th>${thM}<th>Vídeo</th><th class="num">Publicado</th><th class="num">Views</th>
      <th class="num" title="cliques em produto / views">CTR</th><th class="num">Pedidos</th><th class="num">GMV</th><th class="num" title="GMV por mil views — o rendimento do vídeo">GPM</th></tr></thead><tbody>
      ${dobra(vd.slice(0, 50).map((v, i) => `<tr><td class="tabn">${i + 1}</td>
        <td>${v.origem === 'proprio' ? '<span class="tag bom">loja</span>' : '@' + esc(v.username || '—')}</td>${tdM(v)}
        <td class="tts-prod" title="${esc(v.titulo || '')}">${esc(String(v.titulo || '—').slice(0, 60))}${(v.titulo || '').length > 60 ? '…' : ''}${v.duracao_s ? ` <span class="mini">${v.duracao_s}s</span>` : ''}</td>
        <td class="num tabn">${dt(v.publicado_em)}</td><td class="num tabn">${nf(v.visualizacoes)}</td>
        <td class="num tabn">${pctOu(v.ctr_pct === null || v.ctr_pct === undefined ? null : +v.ctr_pct, 1)}</td>
        <td class="num tabn">${nf(v.pedidos)}</td><td class="num tabn"><b>${rf(v.gmv)}</b></td><td class="num tabn">${rf(v.gpm)}</td></tr>`), 10, 'todos os vídeos')}</tbody></table></div>`;
    $('#tts-area').innerHTML = html;
    ligarDobras();
    document.querySelectorAll('#tts-area .tts-ev-linha').forEach(tr => tr.onclick = () => {
      const prox = tr.nextElementSibling;
      if (prox && prox.classList.contains('tts-ev-det')) { prox.remove(); return; }
      const e = ev[+tr.dataset.i], prods = TTS.produtosDoEvento(e, c.liveProdutos);
      const det = document.createElement('tr'); det.className = 'tts-ev-det';
      det.innerHTML = `<td colspan="12"><div class="tts-ev-grid">
        <div><div class="mini" style="margin-bottom:4px"><b>Sessões</b> · ${e.sessoes.length}</div><table class="comparativo mini"><tbody>${e.sessoes.map(x => `<tr><td class="tabn">${dtHora(x.inicio_em)}</td><td class="num tabn">${nf(x.duracao_min)} min</td><td class="num tabn">${nf(x.espectadores) } esp.</td><td class="num tabn">${nf(x.pedidos)} ped.</td><td class="num tabn"><b>${rf(x.gmv)}</b></td></tr>`).join('')}</tbody></table></div>
        <div><div class="mini" style="margin-bottom:4px"><b>Produtos</b> · ${prods.length ? 'o que vendeu e o que só foi clicado' : (e.origem === 'proprio' ? 'sem dado de produto ainda' : 'a plataforma não abre produto de live de afiliado')}</div>
          ${prods.length ? `<table class="comparativo mini"><thead><tr><th>Produto</th><th class="num">Impr.</th><th class="num">Cliques</th><th class="num" title="cliques / impressões">CTR</th><th class="num" title="pedidos pagos / cliques">Cl→ped</th><th class="num">Pedidos</th><th class="num">GMV</th></tr></thead><tbody>
          ${prods.slice(0, 12).map(p => `<tr><td class="tts-prod" title="${esc(p.nome || '')}">${esc(String(p.nome || p.product_id).slice(0, 48))}</td><td class="num tabn">${nf(p.impressoes)}</td><td class="num tabn">${nf(p.cliques)}</td><td class="num tabn">${pctOu(p.ctr_pct, 1)}</td><td class="num tabn">${pctOu(p.clique_pedido_pct, 1)}</td><td class="num tabn">${nf(p.pedidos)}${p.pedidos_criados > p.pedidos ? ` <span class="mini">+${p.pedidos_criados - p.pedidos}</span>` : ''}</td><td class="num tabn"><b>${p.gmv_direto ? rf(p.gmv_direto) : '—'}</b></td></tr>`).join('')}</tbody></table>` : ''}</div></div></td>`;
      tr.after(det);
    });
  }
  const dtHora = iso => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  // Barras empilhadas por dia. Cores fixas por superfície; barra com contorno = dia parcial (hoje).
  function graficoCanal(serie) {
    if (!serie.length) return '';
    const W = 960, H = 190, PAD = { l: 44, r: 8, t: 10, b: 26 };
    const max = Math.max(1, ...serie.map(x => x.gmv));
    const iw = (W - PAD.l - PAD.r) / serie.length, bw = Math.max(2, iw * 0.68);
    const y = v => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
    const COR = { live: '#c0392b', video: '#2c6fbb', vitrine: '#9aa5b1' };
    const passo = Math.max(1, Math.ceil(serie.length / 12));
    let g = '';
    for (const t of [0.5, 1]) g += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(max * t)}" y2="${y(max * t)}" stroke="#e6e2dc"/><text x="${PAD.l - 6}" y="${y(max * t) + 4}" text-anchor="end" font-size="10" fill="#888">${Math.round(max * t / 1000 * 10) / 10}k</text>`;
    serie.forEach((x, i) => {
      const cx = PAD.l + iw * i + (iw - bw) / 2; let base = 0;
      const title = `${x.dia.slice(8, 10)}/${x.dia.slice(5, 7)} · R$ ${Math.round(x.gmv).toLocaleString('pt-BR')} · live ${Math.round(x.live)} · vídeo ${Math.round(x.video)} · vitrine ${Math.round(x.vitrine)} · afiliado ${x.pctAfiliado === null ? '—' : Math.round(x.pctAfiliado) + '%'}${x.parcial ? ' · parcial' : ''}`;
      g += `<g><title>${esc(title)}</title>`;
      for (const k of ['vitrine', 'video', 'live']) {
        const v = x[k] || 0; if (v <= 0) continue;
        g += `<rect x="${cx.toFixed(1)}" y="${y(base + v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(y(base) - y(base + v)).toFixed(1)}" fill="${COR[k]}" ${x.parcial ? 'opacity=".45"' : ''}/>`;
        base += v;
      }
      if (i % passo === 0) g += `<text x="${(cx + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#777">${x.dia.slice(8, 10)}/${x.dia.slice(5, 7)}</text>`;
      g += '</g>';
    });
    const leg = Object.entries({ live: 'Live', video: 'Vídeo', vitrine: 'Vitrine / link' }).map(([k, r]) => `<span class="mini"><span style="display:inline-block;width:10px;height:10px;background:${COR[k]};border-radius:2px;vertical-align:-1px;margin-right:4px"></span>${r}</span>`).join(' &nbsp; ');
    return `<div class="painel-cab" style="margin-top:6px"><h3 style="margin:0" title="Shop Analytics da plataforma, coletado às 04:10 com ~1 dia de atraso. Hoje é parcial (barra clara). Afiliado e live/vídeo/vitrine são cortes diferentes do mesmo GMV — uma live de afiliado conta nos dois.">GMV por dia e por tipo de conteúdo <span class="mini">plataforma · hoje parcial</span></h3><span>${leg}</span></div>
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="display:block" role="img" aria-label="GMV por dia">${g}</svg>`;
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
