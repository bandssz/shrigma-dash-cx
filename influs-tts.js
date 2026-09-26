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

    regrasEditaveis(dados) { return dados?.regra_contrato === 'atomic_v1' && !dados._cache && !dados._caiu; },

    // The complete rule contains the exact database timestamp; do not round it through Date.
    pedidoRegra(base, campos) {
      if (!base || !base.marca || typeof base.atualizado_em !== 'string' || !base.atualizado_em) throw new Error('Recarregue a regra antes de salvar.');
      const regra = {};
      for (const [k,v] of Object.entries(campos)) {
        if (typeof v === 'number' ? Number(base[k]) !== v : base[k] !== v) regra[k] = v;
      }
      if (!Object.keys(regra).length) throw new Error('Nenhuma alteração para salvar.');
      return {acao:'regra',marca:base.marca,regra,esperado_atualizado_em:base.atualizado_em};
    },
    regraRecebida(dados, atual) {
      if (!dados || !atual || !TTS.MARCAS.includes(atual.marca) || !atual.atualizado_em) return dados;
      const update = rows => (rows || []).map(r => r.marca === atual.marca ? {...r,...atual} : r);
      return {...dados,regra:update(dados.regra),cobranca_regra:update(dados.cobranca_regra)};
    },

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
    // Nenhuma marca visivel pode ser encoberta pela coleta mais recente de outra.
    frescor(p, marca, agora, limiteH) {
      const f = TTS.filtra(p.frescor, marca);
      if (!f.length) return { txt: 'coleta —', velho: true, title: 'nenhuma coleta registrada' };
      const now = agora ?? Date.now();
      const idade = x => { const t = Date.parse(x.ultima_ok || ''); return Number.isFinite(t) && t <= now + 60000 ? Math.max(0, Math.round((now - t) / 6e4)) : null; };
      const fmt = m => m === null ? '—' : m < 60 ? m + ' min' : m < 48 * 60 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d';
      const idades = f.map(idade).filter(x => x !== null);
      const maisFresca = idades.length ? Math.min(...idades) : null;
      const falhou = f.some(x => x.ultima_ok_todas === false);
      const esperadas = marca === 'todas' ? TTS.MARCAS : [marca];
      const semConfirmacao = esperadas.filter(m => !f.some(x => x.marca === m && idade(x) !== null));
      const paradas = f.filter(x => idade(x) !== null && idade(x) > (limiteH || 26) * 60);
      const velho = semConfirmacao.length > 0 || paradas.length > 0 || falhou;
      return {
        txt: 'coleta há ' + fmt(maisFresca) + (semConfirmacao.length ? ' · ' + semConfirmacao.join(', ') + ' sem confirmação' : paradas.length ? ' · ' + paradas.map(x => x.marca + ' há ' + fmt(idade(x))).join(', ') : '') + (falhou ? ' · última execução com erro' : ''),
        velho,
        title: [...f.map(x => `${x.marca}: OK há ${fmt(idade(x))}${x.erros ? ' · erro: ' + x.erros : ''}`), ...semConfirmacao.map(m => m + ': sem confirmação de coleta')].join('\n'),
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
    conciliacaoOrigem(rows, marca) {
      const numero = v => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v)) ? Number(v) : null;
      const soma = k => rows.length && rows.every(r => numero(r[k]) !== null) ? rows.reduce((s, r) => s + numero(r[k]), 0) : null;
      const esperadas = marca === 'todas' ? TTS.MARCAS : [marca];
      const contrato = rows.length > 0 && esperadas.every(m => rows.some(r => r.marca === m)) && rows.every(r => r.origem_modelo === 'analytics_total_menos_pedidos_afiliados' && ['saldo_calculado', 'divergente', 'indisponivel'].includes(r.origem_estado));
      if (!contrato) return { contrato: false, estado: 'indisponivel', saldo: null, ajuste: null, ajusteAbsoluto: null, diasDivergentes: null, diasIndisponiveis: null };
      const diasDivergentes = soma('origem_dias_divergentes'), diasIndisponiveis = soma('origem_dias_indisponiveis');
      const divergente = rows.some(r => r.origem_estado === 'divergente') || diasDivergentes > 0;
      const indisponivel = rows.some(r => r.origem_estado === 'indisponivel') || diasIndisponiveis === null || diasIndisponiveis > 0 || diasDivergentes === null;
      const saldo = soma('gmv_saldo_nao_afiliado');
      return { contrato: true, estado: divergente ? 'divergente' : indisponivel || saldo === null ? 'indisponivel' : 'saldo_calculado',
        saldo: divergente || indisponivel ? null : saldo,
        ajuste: indisponivel ? null : soma('gmv_ajuste_origem'), ajusteAbsoluto: indisponivel ? null : soma('gmv_ajuste_origem_absoluto'),
        diasDivergentes, diasIndisponiveis };
    },
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
        origem: TTS.conciliacaoOrigem(tot, marca), origemLinhas: dias,
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
    // Presentation coverage only. Keep every existing financial aggregation unchanged.
    camposConhecidos(rows, fields) {
      const known = v => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v));
      return Array.isArray(rows) && rows.length > 0 && rows.every(r => fields.every(k => known(r[k])));
    },
    coberturaLiveVideo(p, marca) {
      const selected = marca === 'todas' ? TTS.MARCAS : [marca];
      const collection = key => ({disponivel:Array.isArray(p[key]),recebidos:Array.isArray(p[key]) ? p[key].length : null,
        selecionados:Array.isArray(p[key]) ? TTS.filtra(p[key],marca).length : null});
      return {lives:collection('lives'),produtos:collection('live_produtos'),videos:collection('videos'),
        retratos:selected.map(m => ({marca:m,dias:[...new Set((Array.isArray(p.videos)?p.videos:[]).filter(v=>v.marca===m)
          .map(v=>String(v.retrato_em||'').slice(0,10)).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)))].sort()}))};
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
      const idade = (agora ?? Date.now()) - Date.parse(c.em);
      return Number.isFinite(idade) && idade >= -60000 && idade < 24 * 36e5;
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
  let CACHE_TTS = null, READ_TTS = null; // Data and read identity stay in this page's memory.
  try { localStorage.removeItem('shrigma_tts_cache'); } catch (_) {} // Retire the unscoped legacy data cache only.
  const marcaAtual = () => (typeof MARCA !== 'undefined' ? MARCA : 'todas');
  const per = () => (typeof PER !== 'undefined' ? PER : { ini: null, fim: null });

  // ---- escrita (aprovar/rejeitar amostra, editar regra): chave PRÓPRIA, nunca a de leitura ----
  const ACESSO_TTS = { k:'', autor:'' }; // New values stay in this page's memory.
  let ACAO_TTS_EM_CURSO = false;
  // The v2 ledger requires exact GET receipts; legacy reservations remain frozen.
  let JOURNAL_TTS, MANUAL_TTS_CAPS = null;
  function journalTTS() {
    if (!JOURNAL_TTS) {
      let storage = null, locks = null;
      try { storage = localStorage; locks = navigator.locks; } catch (_) {}
      if (typeof TTSManual === 'undefined') throw new Error('Proteção da decisão manual indisponível. Recarregue o painel; a consulta continua disponível.');
      JOURNAL_TTS = TTSManual.create({storage,locks,crypto:globalThis.crypto,fetch:(...args)=>fetch(...args),endpoint:typeof TTS_ACAO_URL === 'string' ? TTS_ACAO_URL : ''});
    }
    return JOURNAL_TTS;
  }
  function identidadeAmostraTTS(corpo) {
    if (corpo.acao !== 'revisar') return null;
    if (!TTS.MARCAS.includes(corpo.marca) || !/^[0-9]+$/.test(String(corpo.application_id || '')) || !['APPROVE','REJECT'].includes(corpo.resultado)) throw new Error('Identidade da amostra inválida. Recarregue a fila.');
    return {brand:corpo.marca,application_id:String(corpo.application_id),result:corpo.resultado};
  }
  function mensagemAcaoTTS(texto) {
    const area = $('#tts-area'); if (!area?.parentNode) return;
    let msg = $('#tts-acao-msg');
    if (!msg) { msg = document.createElement('p'); msg.id = 'tts-acao-msg'; msg.className = 'nota'; msg.setAttribute('role','status'); msg.setAttribute('aria-live','polite'); area.parentNode.insertBefore(msg,area); }
    msg.textContent = texto; msg.hidden = !texto;
  }
  function manualDisponivelTTS() {
    return !!DADOS && MANUAL_TTS_CAPS?.write === true && MANUAL_TTS_CAPS.key === ACESSO_TTS.k && Date.now()-MANUAL_TTS_CAPS.checkedAt < 60000 && !DADOS?._cache && !DADOS?._caiu;
  }
  function travaAmostrasTTS() {
    const pronto = manualDisponivelTTS(), nota = $('#tts-manual-status');
    const verificar=$('#tts-manual-check');if(verificar)verificar.onclick=()=>acionaConsultaTTS({acao:'capacidades',marca:marcaAtual()},verificar);
    if (nota) nota.textContent = pronto ? 'Serviço disponível. Cada decisão exige nova conferência e confirmação; consulta do recibo não repete a ação.' : MANUAL_TTS_CAPS?.write === false ? 'Decisões indisponíveis: o serviço mantém a operação protegida. A fila, as regras e os recibos continuam disponíveis.' : 'Decisões protegidas. Consulte a disponibilidade com seu acesso de escrita antes de decidir.';
    document.querySelectorAll('#tts-area .tts-acoes').forEach(td => {
      let estado;
      try { estado = journalTTS().inspect({marca:td.dataset.marca,application_id:td.dataset.id}); }
      catch (e) { estado = {state:'blocked',message:e.message}; }
      td.querySelectorAll('.tts-ok,.tts-nao').forEach(b => { b.disabled = !!estado || !pronto || b.dataset.plataformaBloqueada === 'true'; });
      let aviso = td.querySelector('.tts-decisao-estado');
      if (!aviso && estado) { aviso = document.createElement('span'); aviso.className = 'mini tts-decisao-estado'; aviso.setAttribute('role','status'); td.append(aviso); }
      if (aviso) aviso.textContent = !estado ? '' : estado.state === 'accepted' ? 'Decisão aceita; recibo confirmado. Consulte a fila para o estado da amostra.' : estado.legacy ? estado.message : estado.state === 'blocked' ? (estado.message || 'Tentativa bloqueada pelo serviço; reserva preservada.') : 'Decisão já reservada. Não repita; consulte o recibo da mesma tentativa.';
      let consulta = td.querySelector('.tts-consultar');
      if (estado?.operation_id && !consulta) {
        consulta = document.createElement('button'); consulta.className='btn tts-btn tts-consultar'; consulta.type='button'; consulta.textContent='Consultar recibo'; td.append(consulta);
        consulta.onclick=()=>acionaConsultaTTS({acao:'operacao',marca:td.dataset.marca,application_id:td.dataset.id},consulta);
      }
    });
    renderTentativasTTS();
  }
  function renderTentativasTTS() {
    const area=$('#tts-area');if(!area)return;
    let box=$('#tts-tentativas-locais');
    if(!box){box=document.createElement('section');box.id='tts-tentativas-locais';box.className='nota';box.setAttribute('aria-labelledby','tts-tentativas-titulo');area.append(box);}
    let lista;try{lista=journalTTS().list({marca:marcaAtual()});}catch(e){box.hidden=false;box.textContent=e.message;return;}
    box.hidden=!lista.length;if(!lista.length){box.textContent='';return;}
    box.innerHTML='<h3 id="tts-tentativas-titulo">Tentativas neste navegador</h3><p class="mini">Inclui amostras que já saíram da fila. Consultar o recibo não repete a decisão. Registros antigos ficam preservados para conciliação.</p>';
    for(const op of lista){
      const linha=document.createElement('p'),texto=document.createElement('span');
      const status=op.state==='accepted'?'aceite confirmado':op.state==='blocked'?'registro bloqueado':op.legacy?'registro anterior preservado':'resultado sem confirmação';
      texto.textContent=(MARCA_N[op.marca]||op.marca)+' · amostra '+op.application_id+' · '+status+'. ';linha.append(texto);
      if(op.operation_id){const btn=document.createElement('button');btn.className='btn tts-btn tts-recibo-local';btn.id='tts-recibo-'+op.marca+'-'+op.application_id;btn.type='button';btn.textContent='Consultar recibo';btn.onclick=()=>acionaConsultaTTS({acao:'operacao',marca:op.marca,application_id:op.application_id},btn);linha.append(btn);}
      else {const aviso=document.createElement('span');aviso.className='mini';aviso.textContent=op.message||'Sem identificador consultável. Preserve o registro e peça conciliação ao integrador.';linha.append(aviso);}
      box.append(linha);
    }
  }
  async function acionaConsultaTTS(corpo,caller) {
    caller.disabled=true;
    try{await consultaManualTTS(corpo);}catch(e){mensagemAcaoTTS(e.message);}
    finally{caller.disabled=false;const target=caller.isConnected?caller:caller.id?document.getElementById(caller.id):null;(target||$('#tts-abas button.ativo'))?.focus();}
  }
  async function consultaManualTTS(corpo) {
    if (ACAO_TTS_EM_CURSO) throw new Error('Conclua ou cancele a consulta que já está aberta.');
    ACAO_TTS_EM_CURSO=true;
    try {
      const leitura=SEQ,pane=PANE,marca=marcaAtual(),acesso=await pedeAcessoTTS(corpo);
      if (!acesso) { const e=new Error('Consulta cancelada. Nenhuma decisão foi enviada.');e.code='TTS_CANCELLED';throw e; }
      if (SEQ!==leitura || PANE!==pane || marcaAtual()!==marca) throw new Error('A tela foi atualizada. Consulte novamente.');
      if (corpo.acao==='capacidades') {
        MANUAL_TTS_CAPS=null;travaAmostrasTTS();
        const cap=await journalTTS().capabilities(acesso.k);
        if (SEQ!==leitura || PANE!==pane || acesso.k!==ACESSO_TTS.k) throw new Error('A tela ou o acesso mudou. Consulte novamente.');
        MANUAL_TTS_CAPS={...cap,key:acesso.k,checkedAt:Date.now()};
        mensagemAcaoTTS(cap.write ? 'Disponibilidade confirmada. Nenhuma decisão foi enviada.' : TTSManual.CLOSED);
      } else {
        const found=await journalTTS().lookup(corpo,acesso.k);
        mensagemAcaoTTS(found.state==='accepted' ? 'Recibo confirmado: a API aceitou esta decisão. A evolução da amostra continua na fila.' : found.state==='blocked' ? 'O serviço bloqueou esta tentativa. A reserva foi preservada; não repita.' : TTSManual.UNKNOWN);
      }
    } catch(e) { if(e.code==='TTS_AUTH_REQUIRED')esqueceAcessoTTS();throw e; }
    finally { ACAO_TTS_EM_CURSO=false;travaAmostrasTTS(); }
  }
  function acessoGuardadoTTS() {
    try {
      if (!ACESSO_TTS.k) ACESSO_TTS.k = (localStorage.getItem('shrigma_tts_wkey') || '').trim();
      if (!ACESSO_TTS.autor) ACESSO_TTS.autor = (localStorage.getItem('shrigma_autor') || '').trim().slice(0,40);
    } catch (_) {} // Storage may be unavailable; the inline form still works.
    return {...ACESSO_TTS};
  }
  function esqueceAcessoTTS() {
    ACESSO_TTS.k = ''; MANUAL_TTS_CAPS = null;
    try { localStorage.removeItem('shrigma_tts_wkey'); } catch (_) {}
  }
  function pedeAcessoTTS(corpo) {
    const salvo = acessoGuardadoTTS(), consulta = ['capacidades','operacao'].includes(corpo.acao);
    if (salvo.k && (consulta || salvo.autor)) return Promise.resolve(salvo);
    const area = $('#tts-area');
    if (!area?.parentNode) return Promise.reject(new Error('Abra a aba TikTok antes de continuar.'));
    let painel = $('#tts-acesso');
    if (!painel) { painel = document.createElement('section'); painel.id = 'tts-acesso'; painel.className = 'nota'; area.parentNode.insertBefore(painel,area); }
    painel.hidden = false; painel.setAttribute('aria-labelledby','tts-acesso-titulo');
    const acao = consulta ? (corpo.acao === 'operacao' ? 'Consultar o recibo da tentativa' : 'Consultar a disponibilidade de decisões') : corpo.acao === 'regra' ? 'Salvar a regra' : corpo.resultado === 'APPROVE' ? 'Aprovar a amostra selecionada' : 'Rejeitar a amostra selecionada';
    painel.innerHTML = `<form id="tts-acesso-form" novalidate aria-labelledby="tts-acesso-titulo">
      <h3 id="tts-acesso-titulo">Continuar no TikTok Shop</h3>
      <p id="tts-acesso-ajuda">${esc(acao)} · ${esc(MARCA_N[corpo.marca] || corpo.marca)}. ${consulta ? 'Informe o acesso de escrita da mesma tentativa. Esta consulta não envia uma decisão.' : 'Informe o acesso de escrita e quem está realizando a ação.'}</p>
      <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px">
        <div id="tts-acesso-chave-linha" ${salvo.k ? 'hidden' : ''} style="flex:1 1 220px;min-width:0"><label for="tts-acesso-chave">Chave de escrita</label><br>
          <input class="i-sel" id="tts-acesso-chave" type="password" ${salvo.k ? '' : 'required'} autocomplete="off" spellcheck="false" aria-describedby="tts-acesso-ajuda tts-acesso-msg" style="width:100%;box-sizing:border-box"></div>
        <div ${consulta ? 'hidden' : ''} style="flex:1 1 220px;min-width:0"><label for="tts-acesso-autor">Seu nome</label><br>
          <input class="i-sel" id="tts-acesso-autor" type="text" ${consulta ? '' : 'required'} maxlength="40" autocomplete="name" aria-describedby="tts-acesso-ajuda tts-acesso-msg" style="width:100%;box-sizing:border-box"></div>
      </div>
      <p class="mini">O novo acesso fica somente nesta página aberta. Cancelar não executa a ação.</p>
      ${!consulta && corpo.acao==='revisar' ? '<p class="mini">A decisão e o nome do operador ficam no registro da tentativa neste navegador e no serviço. A chave não é salva nesse registro. Não inclua dados de cliente ou segredos no nome.</p>' : ''}
      <button class="btn tts-btn" type="submit">Confirmar e continuar</button>
      <button class="btn tts-btn" id="tts-acesso-cancelar" type="button">Cancelar</button>
      <p id="tts-acesso-msg" role="status" aria-live="polite"></p>
    </form>`;
    const form = $('#tts-acesso-form'), chave = $('#tts-acesso-chave'), autor = $('#tts-acesso-autor'), msg = $('#tts-acesso-msg');
    autor.value = salvo.autor;
    (salvo.k && !consulta ? autor : chave).focus();
    return new Promise(resolve => {
      let concluido = false;
      const terminar = valor => {
        if (concluido) return; concluido = true;
        chave.value = ''; autor.value = ''; painel.hidden = true;
        resolve(valor);
      };
      form.onsubmit = e => {
        e.preventDefault(); if (concluido || painel.hidden) return;
        const k = salvo.k || chave.value.trim(), nome = autor.value.trim();
        chave.removeAttribute('aria-invalid'); autor.removeAttribute('aria-invalid');
        if (!k || !consulta && (!nome || nome.length>40)) {
          const campo = !k ? chave : autor;
          msg.textContent = !k ? 'Informe a chave de escrita.' : 'Informe seu nome, com até 40 caracteres.';
          campo.setAttribute('aria-invalid','true'); campo.focus(); return;
        }
        if (ACESSO_TTS.k !== k) MANUAL_TTS_CAPS=null;
        ACESSO_TTS.k = k; if (!consulta) ACESSO_TTS.autor = nome;
        terminar({k,autor:nome});
      };
      $('#tts-acesso-cancelar').onclick = () => terminar(null);
      form.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); terminar(null); } });
    });
  }
  async function acaoTTS(corpo) {
    if (corpo.acao === 'regra' && !TTS.regrasEditaveis(DADOS)) throw new Error('Edição temporariamente indisponível. Aguarde a confirmação do serviço e recarregue.');
    if (typeof TTS_ACAO_URL === 'undefined') throw new Error('TTS_ACAO_URL não configurada em config.js');
    const identidade = identidadeAmostraTTS(corpo);
    if (identidade) {
      const estado = journalTTS().inspect(identidade);
      if (estado) { const erro = new Error(estado.message || 'Esta amostra já tem uma decisão solicitada neste navegador. Não repita; confira o resultado com o integrador.'); erro.code = estado.state === 'blocked' ? 'TTS_WRITE_UNAVAILABLE' : ['accepted','confirmed'].includes(estado.state) ? 'TTS_DECISION_RECORDED' : 'TTS_OUTCOME_UNKNOWN'; throw erro; }
    }
    if (ACAO_TTS_EM_CURSO) throw new Error('Conclua ou cancele a ação que já está aberta.');
    ACAO_TTS_EM_CURSO = true;
    const pedido = {...corpo,regra:corpo.regra ? {...corpo.regra} : undefined}, leitura = SEQ, pane = PANE, marca = marcaAtual();
    try {
    const acesso = await pedeAcessoTTS(pedido);
    if (!acesso) { const erro = new Error('Ação cancelada.'); erro.code = 'TTS_CANCELLED'; throw erro; }
    if (SEQ !== leitura || PANE !== pane || marcaAtual() !== marca || (pedido.acao === 'regra' && !TTS.regrasEditaveis(DADOS))) throw new Error('A tela foi atualizada. Revise os dados e confirme a ação novamente.');
    const {k,autor} = acesso;
    if (identidade) {
      const result=await journalTTS().run({...pedido,autor,observacao:pedido.observacao??''},k,{guard:()=>SEQ===leitura && PANE===pane && marcaAtual()===marca && ACESSO_TTS.k===k});
      if (result.state!=='accepted') { const erro=new Error(result.state==='blocked'?'O serviço bloqueou esta tentativa. A reserva foi preservada; não repita.':TTSManual.UNKNOWN);erro.code='TTS_OUTCOME_UNKNOWN';throw erro; }
      return {ok:true,operation_id:result.operation_id};
    }
    const enviar = async () => {
    if (identidade) travaAmostrasTTS();
    const r = await fetch(TTS_ACAO_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...pedido, k, autor }) });
    const recebido = await r.json().catch(() => null), j = recebido && typeof recebido === 'object' && !Array.isArray(recebido) ? recebido : {};
    if (r.status === 401 || r.status === 403) { esqueceAcessoTTS(); throw new Error('Acesso de escrita recusado. Confira a chave antes de tentar novamente.'); }
    if (!j.ok && /chave/i.test(j.erro || '')) { esqueceAcessoTTS(); throw new Error('Acesso de escrita recusado. Confira a chave antes de tentar novamente.'); }
    for (const campo of ['erro','mensagem']) if (typeof j[campo] === 'string') j[campo] = j[campo].split(k).join('[acesso ocultado]');
    if (corpo.acao === 'regra' && j.regra_atual) {
      DADOS = TTS.regraRecebida(DADOS,j.regra_atual);
      if (!r.ok || !j.ok) {
        renderPane();
        const aviso = document.createElement('div'); aviso.className = 'nota'; aviso.setAttribute('role','alert');
        aviso.textContent = (j.erro || j.mensagem || 'Alteração recusada.') + ' A regra atual foi exibida para revisão.';
        $('#tts-area')?.prepend(aviso);
      }
    }
    if (!r.ok || j.ok !== true) throw new Error(j.erro || j.mensagem || ('HTTP ' + r.status));
    return {status:r.status,body:j};
    };
    return (await enviar()).body;
    } catch(e) { if(e.code==='TTS_CONTRACT')MANUAL_TTS_CAPS=null;if(e.code==='TTS_WRITE_CLOSED')MANUAL_TTS_CAPS={write:false,key:ACESSO_TTS.k,checkedAt:Date.now()};if(e.code==='TTS_AUTH_REQUIRED')esqueceAcessoTTS();throw e; } finally { ACAO_TTS_EM_CURSO = false; travaAmostrasTTS(); }
  }
  // botão de duas etapas: 1º clique arma ("Confirmar?"), 2º clique executa; desarma sozinho em 6 s
  function armar(btn, rotuloConfirma, fn) {
    if (btn.disabled) return;
    if (btn.dataset.armado) { btn.dataset.armado = ''; btn.disabled = true; btn.textContent = '…'; Promise.resolve().then(fn).catch(e => { btn.disabled = e.code === 'TTS_OUTCOME_UNKNOWN'; btn.textContent = e.code === 'TTS_CANCELLED' ? (btn.dataset.original || 'Continuar') : e.code === 'TTS_OUTCOME_UNKNOWN' ? 'Resultado incerto' : 'erro: ' + e.message; mensagemAcaoTTS(e.code === 'TTS_CANCELLED' ? 'Ação cancelada. Nenhuma solicitação foi enviada.' : e.message); travaAmostrasTTS(); if (e.code === 'TTS_CANCELLED') (btn.isConnected ? btn : $('#tts-abas button.ativo'))?.focus(); }); return; }
    const orig = btn.dataset.original || btn.textContent; btn.dataset.armado = '1'; btn.textContent = rotuloConfirma;
    btn.dataset.original = orig;
    mensagemAcaoTTS('');
    setTimeout(() => { if (btn.dataset.armado) { btn.dataset.armado = ''; btn.textContent = orig; } }, 6000);
  }

  function vazio(titulo, detalhe, retry) {
    if (!DADOS) { const f = $('#tts-frescor'); if (f) { f.textContent = 'coleta sem confirmação'; f.title = ''; f.classList.add('velho'); } }
    if (!DADOS) {
      const a = $('#tts-autorizacao'), aviso = $('#tts-aviso');
      if (a) { a.hidden = true; a.textContent = ''; }
      if (aviso) { aviso.hidden = true; aviso.textContent = ''; }
      document.querySelectorAll('#tts-abas .n').forEach(el => { el.textContent = ''; });
    }
    $('#tts-kpis').innerHTML = '';
    $('#tts-area').innerHTML = `<div class="vazio"><strong>${titulo}</strong><br>${detalhe}${retry ? '<br><br><button class="btn" id="tts-retry">Tentar de novo</button>' : ''}</div>`;
    const b = $('#tts-retry'); if (b) b.onclick = carregarTTS;
  }

  async function carregarTTS() {
    const seq = ++SEQ, periodo = { ini: per().ini, fim: per().fim };
    if (READ_TTS) READ_TTS.cancel();
    DADOS = null;
    if (typeof TTS_API_URL === 'undefined') { vazio('Consulta indisponível', 'Não foi possível localizar o serviço de afiliados.', true); return; }
    const k = (typeof chaveLeitura === 'function' ? chaveLeitura() : '') || '';
    const acessoAtual = () => typeof INFLU_ACCESS !== 'undefined' ? INFLU_ACCESS.current('read') : (typeof chaveLeitura === 'function' ? chaveLeitura() : '');
    const vigente = () => seq === SEQ && acessoAtual() === k;
    if (!k) { CACHE_TTS = null; vazio('Chave de acesso não informada', 'A mesma chave do painel de Influs abre esta aba.'); return; }
    if (CACHE_TTS?.key !== k) CACHE_TTS = null;
    if (TTS.cacheServe(CACHE_TTS, periodo.ini, periodo.fim)) {
      DADOS = {...CACHE_TTS.payload, _periodo:periodo, _cache:CACHE_TTS.em, _caiu:null};
      renderTTS(); // Cached data is visible, but all mutation guards remain closed until readback.
    } else vazio('Carregando afiliados TikTok…', 'Lendo o período selecionado.');
    const anterior = DADOS, controller = new AbortController();
    let timer, cancel;
    const limite = new Promise((_, reject) => {
      cancel = () => { controller.abort(); reject(new Error('Consulta substituída.')); };
      timer = setTimeout(() => { controller.abort(); reject(new Error('A consulta demorou mais de 20 segundos. Tente atualizar novamente.')); }, 20000);
    });
    const leitura = {cancel}; READ_TTS = leitura;
    try {
      const consulta = (async () => {
        let r;
        try { r = await fetch(TTS_API_URL, { method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+k},
          body:JSON.stringify(periodo), signal:controller.signal, redirect:'error', credentials:'omit', cache:'no-store' }); }
        catch (_) { throw new Error('Não foi possível consultar os afiliados agora.'); }
        if (r.status === 401 || r.status === 403) { const erro = new Error('Chave inválida ou sem acesso a esta consulta.'); erro.status = r.status; throw erro; }
        if (!r.ok) throw new Error('Consulta indisponível (HTTP ' + r.status + ').');
        let novo; try { novo = await r.json(); } catch (_) { throw new Error('Resposta de consulta inválida. Tente atualizar novamente.'); }
        if (!novo || Array.isArray(novo) || !['kpis','amostras','fila'].every(c => Array.isArray(novo[c])) ||
            novo.janela?.ini !== periodo.ini || novo.janela?.fim !== periodo.fim) throw new Error('A resposta não confirmou os dados e o período solicitado.');
        return novo;
      })();
      const novo = await Promise.race([consulta, limite]);
      if (!vigente()) return;
      CACHE_TTS = {key:k,em:new Date().toISOString(),...periodo,payload:novo};
      DADOS = {...novo,_periodo:periodo,_caiu:null,_cache:null};
      renderTTS();
    } catch (e) {
      if (!vigente()) return;
      if (e.status === 401 || e.status === 403) {
        DADOS = null; CACHE_TTS = null;
        if (typeof INFLU_ACCESS !== 'undefined') INFLU_ACCESS.reject('read', k, e.message);
        else if (typeof shrigmaEsqueceChave === 'function') shrigmaEsqueceChave('influs');
        vazio('Acesso não confirmado', esc(e.message), true); return;
      }
      if (anterior) { DADOS = {...anterior,_caiu:e.message}; renderTTS(); }
      else vazio('Falha ao carregar afiliados TikTok', esc(e.message) + '<br><span class="mini">Os dados desta consulta não foram confirmados.</span>', true);
    } finally {
      clearTimeout(timer);
      if (READ_TTS === leitura) READ_TTS = null;
    }
  }

  function renderTTS() {
    if (!DADOS) return;
    const m = marcaAtual();
    if (m === 'olivas') { $('#tts-frescor').textContent = ''; vazio('Olivas do Campo não vende no TikTok Shop', 'Só O Aristocrata e Fishermans têm loja e programa de afiliados lá.'); return; }
    const f = TTS.frescor(DADOS, m);
    const fe = $('#tts-frescor'); fe.textContent = f.txt + (DADOS._caiu ? ' · leitura falhou agora, mostrando a última' : '') + (DADOS._cache && !DADOS._caiu ? ' · atualizando…' : ''); fe.title = f.title + (DADOS._caiu ? '\nerro: ' + DADOS._caiu : ''); fe.classList.toggle('velho', f.velho || !!DADOS._caiu);
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
    const kp = $('#tts-kpis'); if (kp?.dataset) kp.dataset.pane = PANE;
    if (PANE === 'canal') { kp.innerHTML = cardsCanal(); return; }
    const m = marcaAtual(), k = TTS.kpis(DADOS, m), j = DADOS.janela || {};
    const urg = k.urgente ? TTS.horasAte(k.urgente) : null;
    const cards = [
      { r: 'GMV via afiliado', v: rf(k.gmv), s: `${nf(k.pedidos)} pedidos · ${nf(k.criadores)} criadores venderam · ${j.ini} a ${j.fim}` },
      { r: 'Comissão paga', v: rf(k.comissao), s: k.comissaoPct !== null ? `${pf(k.comissaoPct, 1)} do GMV` : 'sem pedido na janela' },
      { r: 'Vídeo × Live', v: k.pctVideo === null ? '—' : `${pf(k.pctVideo)} <span class="mini">vídeo</span>`, s: k.pctVideo === null ? 'base menor que 30 pedidos' : `${pf(k.pctLive)} live · resto shop/link`, title: 'percentual do GMV por formato de conteúdo que gerou o pedido' },
      { r: 'Amostras pendentes', v: `<span class="${k.pendentes && urg !== null && urg < 24 ? 'vm' : ''}">${nf(k.pendentes)}</span>`, s: (k.pendentes ? (urg === null ? 'aguardando decisão' : urg < 0 ? 'há pedido vencido' : `a mais urgente vence em ${urg < 24 ? urg + ' h' : Math.round(urg / 24) + ' d'}`) : 'nada a decidir agora') + ' · agora', title: 'estado atual da fila no TikTok — não depende do período selecionado' },
      { r: 'Perda operacional', v: k.perdaPct === null ? nf(k.perda) : pf(k.perdaPct), s: `${nf(k.perda)} de ${nf(k.amostrasTotal)} amostras · histórico completo`, title: 'venceu sem decisão ou aprovada e não enviada. Histórico completo — a API do TikTok não devolve a data do pedido de amostra, então não dá para recortar por período' },
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
    const m = marcaAtual(), fila = TTS.fila(DADOS, m), envio = TTS.filtra(DADOS.envio, m), todas = m === 'todas';
    const modo = (TTS.filtra(DADOS.regra, m)[0] || {}).modo || 'dry_run';
    const thM = todas ? '<th>Marca</th>' : '', tdM = x => todas ? `<td>${tag(x.marca)}</td>` : '';
    // Trava explicada: quem libera e o que fazer enquanto isso. O estado real vem de travaAmostrasTTS().
    let html = `<div class="tts-trava"><div><p id="tts-manual-status" role="status" aria-live="polite">Decisões protegidas. Consulte a disponibilidade antes de decidir.</p>
      <p class="mini">Aprovar e Rejeitar só destravam depois de conferir o serviço com um acesso de escrita. Enquanto estiverem cinza, a decisão continua no Seller Center e esta fila serve para priorizar.</p></div>
      <button class="btn tts-btn" id="tts-manual-check" type="button">Consultar disponibilidade</button></div>`;
    if (envio.length) html += `<div class="painel-cab" style="margin-top:4px"><h3 style="margin:0">Aprovadas e ainda não enviadas <span class="tag alerta">${envio.length}</span></h3><span class="mini" title="prazo de envio da plataforma; passou = SELLER_NOT_SHIP_CANCELLED">enviar antes do prazo</span></div>
      <div class="rolagem"><table class="comparativo tts-compacta"><thead><tr><th>Prazo</th>${thM}<th>Criador</th><th>Produto</th><th>Pedido</th></tr></thead><tbody>${envio.map(e => `<tr><td class="nowrap">${prazo(TTS.horasAte(e.envio_expira_em))}</td>${tdM(e)}<td>@${esc(e.username)}</td><td class="tts-prod"><span class="tts-1linha" title="${esc(e.product_title)}">${esc(e.product_title)}</span>${e.sku_name ? `<span class="tag nulo tts-sku">${esc(e.sku_name)}</span>` : ''}</td><td class="tabn">${esc(e.order_id || '—')}</td></tr>`).join('')}</tbody></table></div>`;
    if (!fila.length) { $('#tts-area').innerHTML = html + '<div class="vazio">Nenhum pedido de amostra aguardando decisão.</div>'; travaAmostrasTTS(); return; }
    const sugestoes = [...new Set(fila.map(x => x.tier.rot))];
    html += `<div class="tts-filtros" role="search"><label class="tts-busca"><span class="mini">Buscar</span><input type="search" id="tts-fila-busca" placeholder="criador ou produto" autocomplete="off"></label>
      <label><span class="mini">Sugestão · ${esc(modo === 'dry_run' ? 'simulação' : modo)}</span><select id="tts-fila-sug"><option value="">todas</option>${sugestoes.map(t => `<option value="${esc(t)}">${esc(t)} (${fila.filter(x => x.tier.rot === t).length})</option>`).join('')}</select></label>
      <span class="mini" id="tts-fila-conta" aria-live="polite">${fila.length} pedido(s)</span></div>`;
    html += `<div class="rolagem"><table class="comparativo tts-compacta tts-fila"><thead><tr>
      <th title="prazo da plataforma para decidir (7 dias); vencido vira OVERDUE_CANCELLED">Vence em</th>${thM}<th>Criador</th>
      <th class="num" title="GMV do criador no TikTok Shop nos últimos 30 dias, todas as lojas (dado da plataforma), em R$">GMV 30d</th>
      <th class="num" title="Postagem: % das amostras recebidas (todas as marcas, 90 dias) que viraram conteúdo; 0% = sem histórico recente, não é 'não posta'. Aqui: amostras completas / pedidas nesta marca">Histórico <span class="mini">postagem · aqui</span></th>
      <th class="num" title="pedidos · GMV em R$ que esse criador já gerou para esta marca nos últimos 90 dias">Vendeu aqui 90d</th>
      <th>Produto pedido</th>
      <th title="Sugestão: o que a esteira faria com a regra atual (crm_tts_regra). Modo ${esc(modo)}: a decisão continua sendo humana. Decidir depende da disponibilidade do serviço e de confirmação; o recibo é consultado sem repetir a decisão">Sugestão · decidir</th></tr></thead><tbody>
      ${fila.map(x => `<tr data-busca="${esc([x.nickname, x.username, x.product_title, x.sku_name].filter(Boolean).join(' ').toLowerCase())}" data-sug="${esc(x.tier.rot)}">
        <td class="nowrap tts-f-prazo" data-rot="Vence em">${prazo(x.horas)}</td>${tdM(x)}
        <td class="tts-quem tts-f-cheia"><div class="nome tts-1linha">${esc(x.nickname || x.username)}</div><span class="mini tts-1linha">@${esc(x.username)} · ${nf(x.seguidores)} seg.</span></td>
        <td class="num tabn" data-rot="GMV 30d">${x.gmv_30d === null || x.gmv_30d === undefined ? '—' : nf(Math.round(x.gmv_30d))}</td>
        <td class="num tabn" data-rot="Postagem">${pf(x.fulfillment_pct)}<span class="mini tts-sub">${nf(x.amostras_completas)}/${nf(x.amostras_total)} aqui</span></td>
        <td class="num tabn" data-rot="Vendeu 90d">${x.pedidos_90d ? `${nf(x.pedidos_90d)} · ${nf(Math.round(x.gmv_90d_marca))}` : '—'}</td>
        <td class="tts-prod tts-f-cheia"><span class="tts-1linha" title="${esc(x.product_title)}">${esc(x.product_title)}</span>${x.sku_name ? `<span class="tag nulo tts-sku" title="variante pedida">${esc(x.sku_name)}</span>` : ''}${x.is_approvable === false ? ` <span class="tag alerta" title="${esc(x.motivo_nao_aprovavel || '')}">não aprovável</span>` : ''}</td>
        <td class="tts-acoes tts-f-cheia" data-marca="${esc(x.marca)}" data-id="${esc(x.application_id)}"><span class="tag ${x.tier.cls} tts-sug" title="${esc(x.tier.det)}">${x.tier.rot}</span><button class="btn tts-btn tts-ok" ${x.is_approvable === false ? 'disabled data-plataforma-bloqueada="true" title="plataforma não permite aprovar"' : ''}>Aprovar</button><button class="btn tts-btn tts-nao">Rejeitar</button></td></tr>`).join('')}</tbody></table></div>`;
    $('#tts-area').innerHTML = html;
    travaAmostrasTTS();
    const busca = $('#tts-fila-busca'), sug = $('#tts-fila-sug'), conta = $('#tts-fila-conta');
    const filtra = () => {
      const q = String(busca?.value || '').trim().toLowerCase(), t = sug?.value || '';
      let n = 0;
      document.querySelectorAll('#tts-area .tts-fila tbody tr').forEach(tr => { const ok = (!q || (tr.dataset.busca || '').includes(q)) && (!t || tr.dataset.sug === t); tr.hidden = !ok; if (ok) n++; });
      if (conta) conta.textContent = n === fila.length ? `${fila.length} pedido(s)` : `${n} de ${fila.length} pedido(s)`;
    };
    if (busca) busca.oninput = filtra;
    if (sug) sug.onchange = filtra;
    document.querySelectorAll('#tts-area .tts-acoes .tts-ok,#tts-area .tts-acoes .tts-nao').forEach(b => b.onclick = () => {
      const td = b.closest('td'), aprova = b.classList.contains('tts-ok');
      armar(b, aprova ? 'Confirmar aprovação?' : 'Confirmar rejeição?', async () => {
        await acaoTTS({ acao: 'revisar', marca: td.dataset.marca, application_id: td.dataset.id, resultado: aprova ? 'APPROVE' : 'REJECT', motivo_rejeicao: aprova ? null : 'NOT_MATCH', observacao: '' });
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

  // Mensagem longa abre no toque (funciona no celular, ao contrário do title).
  const msgTTS = t => { const txt = String(t || ''), primeira = txt.split('\n')[0]; if (!txt) return '<span class="mini">—</span>';
    return txt.length <= 90 && !txt.includes('\n') ? esc(txt) : `<details class="tts-msg-det"><summary>${esc(primeira.slice(0, 90))}${primeira.length > 90 || txt.includes('\n') ? '…' : ''}</summary><div>${esc(txt)}</div></details>`; };
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
        <td class="msg">${msgTTS(x.ultimo_texto)}</td><td class="mini tabn">${dt(x.ultima_msg_em)}</td></tr>`), 10, 'todos')}</tbody></table></div>`;
    const linhas = fila.map(x => `<tr>
      <td>${tag(x.marca)}</td>
      <td>@${esc(x.username)}</td>
      <td>${esc(ETAPA[x.etapa] || x.etapa)}</td>
      <td class="num tabn" title="toque ${x.tentativa} da régua">${x.tentativa || 1}</td>
      <td><span class="tag ${x.dry_run ? 'neutro' : (x.ok ? 'bom' : 'ruim')}">${x.dry_run ? 'simulada' : (x.ok ? 'enviada' : 'falhou')}</span></td>
      <td class="msg">${msgTTS(x.texto)}</td>
      <td class="mini tabn">${x.erro ? esc(x.erro) : dt(x.enviado_em)}</td></tr>`);
    $('#tts-area').innerHTML = topo + `${fila.length ? `<div class="painel-cab" style="margin-top:${topo ? 18 : 4}px"><h3 style="margin:0">Toques da régua <span class="tag nulo">${fila.length}</span> <span class="tag neutro" title="Ativação indisponível enquanto as guardas de envio e de concorrência não estiverem integradas e comprovadas. A configuração permite pausar ou simular.">só simulação · nada é enviado</span></h3><span class="mini">${c.conversasAtivas ? c.conversasAtivas + ' pulados por conversa em andamento' : ''}</span></div>` : '<p class="mini">Ativação indisponível enquanto as guardas de envio e de concorrência não estiverem integradas e comprovadas. A configuração permite pausar ou simular.</p>'}${fila.length ? `<div class="rolagem"><table class="comparativo tts-compacta">
      <thead><tr><th>Marca</th><th>Criador</th><th>Por quê</th><th class="num" title="qual toque da régua">Toque</th>
        <th title="simulada = gravada, nada foi enviado ao criador">Estado</th>
        <th>Mensagem <span class="mini">toque para ler inteira</span></th><th>Quando</th></tr></thead>
      <tbody>${dobra(linhas, 12, 'todos os toques')}</tbody></table></div>` : `<div class="vazio">${nf(c.pendentes)} criador(es) devendo conteúdo, nenhum toque registrado ainda nesta marca.</div>`}
      <div class="painel-cab" style="margin-top:16px"><h3 style="margin:0">Configuração da cobrança</h3>
        <span class="mini">${c.modo === 'ativo' ? `até ${c.tetoDia} por dia · ${c.pendentes} na fila`
          : `${c.simuladas} prontas, nenhuma enviada · ${c.pendentes} devendo conteúdo`}</span></div>
      <div class="rolagem"><table class="comparativo"><thead><tr><th>Marca</th><th>Cobrança</th><th class="num">Máx/dia</th><th class="num" title="quantas vezes cobrar a mesma pessoa">Toques</th><th class="num" title="dias entre um toque e o próximo">Intervalo</th><th></th></tr></thead><tbody>
      ${TTS.filtra(DADOS.cobranca_regra || [], m).map(r => `<tr data-marca="${esc(r.marca)}">
        <td>${tag(r.marca)}</td>
        <td><select class="i-sel tts-c" data-campo="cobranca_modo" title="Ativação indisponível enquanto as guardas de envio estiverem pendentes.">${['dry_run', 'pausado'].concat(r.cobranca_modo === 'ativo' ? ['ativo'] : []).map(o => `<option value="${o}" ${o === 'ativo' ? 'disabled' : ''} ${r.cobranca_modo === o ? 'selected' : ''}>${o === 'dry_run' ? 'simulação' : o}</option>`).join('')}</select></td>
        <td class="num"><input type="number" class="i-sel tts-c" data-campo="cobranca_max_dia" value="${esc(r.cobranca_max_dia)}" step="5" min="0" style="width:88px" title="teto de mensagens por dia nesta marca"></td>
        <td class="num"><input type="number" class="i-sel tts-c" data-campo="cobranca_max_tentativas" value="${esc(r.cobranca_max_tentativas)}" step="1" min="1" style="width:80px" title="quantas vezes cobrar a mesma pessoa antes de parar"></td>
        <td class="num"><input type="number" class="i-sel tts-c" data-campo="cobranca_dias_entre" value="${esc(r.cobranca_dias_entre)}" step="1" min="1" style="width:80px" title="dias de espera entre um toque e o próximo"></td>
        <td><button class="btn tts-btn tts-salvar-cob" ${TTS.regrasEditaveis(DADOS) ? '' : 'disabled title="Edição temporariamente indisponível; recarregue após a confirmação do serviço."'}>Salvar</button> <span class="mini tts-msg"></span></td></tr>`).join('')}
      </tbody></table></div>`;
    if (!TTS.regrasEditaveis(DADOS)) $('#tts-area').insertAdjacentHTML('afterbegin','<div class="nota" role="status">Edição de regras temporariamente indisponível. A confirmação do serviço precisa estar atualizada.</div>');
    const regrasLidas = new Map((DADOS.regra || []).map(r => [r.marca,{...r}]));
    document.querySelectorAll('#tts-area .tts-salvar-cob').forEach(b => b.onclick = () => {
      const tr = b.closest('tr'), msg = tr.querySelector('.tts-msg'), regra = {};
      tr.querySelectorAll('.tts-c').forEach(el => { regra[el.dataset.campo] = el.tagName === 'SELECT' ? el.value : Number(el.value); });
      armar(b, 'Confirmar?', async () => {
        const j = await acaoTTS(TTS.pedidoRegra(regrasLidas.get(tr.dataset.marca),regra));
        msg.textContent = j.mensagem || 'ok'; b.disabled = false; b.textContent = 'Salvar';
        await carregarTTS();
      });
    });
    ligarDobras();
  }

  // Aba Canal: a loja inteira (Shop Analytics), para responder "quanto do que vendemos veio de afiliado,
  // de live, de vídeo, de ads?" — e para ver o que uma live faz com o dia.
  const pctOu = (v, d) => (v === null || v === undefined) ? '—' : pf(+v, d ?? 0);
  const moedaOrigem = v => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v)) ? Number(v).toLocaleString('pt-BR', {style:'currency',currency:'BRL'}) : 'indisponível';
  function resumoOrigemCanal(c) {
    const o = c.origem, rot = {saldo_calculado:'Saldo calculado',divergente:'Fontes divergentes',indisponivel:'Conciliação indisponível'};
    const aviso = !o.contrato ? 'Esta consulta ainda não confirma o contrato de conciliação para todas as marcas selecionadas.' : o.estado === 'divergente' ? 'Há dias em que as fontes não conciliam. O saldo não afiliado permanece indisponível.' : o.estado === 'indisponivel' ? 'Falta componente necessário em parte do período. Ausência não é receita zero.' : 'O saldo é total da loja menos pedidos de afiliados. Não comprova venda própria atribuída.';
    const cls = o.estado === 'saldo_calculado' && o.contrato ? 'bom' : o.estado === 'divergente' ? 'neutro' : 'nulo';
    return `<div class="tts-origem" role="status"><span class="tag ${cls}">${rot[o.estado] || rot.indisponivel}</span> <span>${aviso}</span></div>
      <details class="ressalvas tts-conc"><summary>Conferir conciliação de origem</summary><p>Shop Analytics e pedidos de afiliados são fontes distintas; não somar seus valores. GMV Max e live/vídeo/vitrine são outros cortes.</p><p>Saldo não afiliado: <strong>${moedaOrigem(o.saldo)}</strong>. Diferença assinada: ${moedaOrigem(o.ajuste)}. Soma das diferenças absolutas por dia: ${moedaOrigem(o.ajusteAbsoluto)}.</p>
      <p>${nf(o.diasDivergentes)} dia(s) × marca divergentes; ${nf(o.diasIndisponiveis)} sem componente confirmado. Diferença é ajuste de conciliação, não receita, reembolso ou crédito atribuído. Ausência de linha não comprova cobertura do período. “Próprio anterior” preserva o campo histórico apenas para auditoria.</p>
      <div class="rolagem" tabindex="0" role="region" aria-label="Conciliação de origem por dia e marca"><table class="comparativo"><thead><tr><th>Dia / marca</th><th>Total da loja</th><th>Afiliado</th><th>Próprio anterior</th><th>Saldo calculado</th><th>Diferença</th><th>Estado</th></tr></thead><tbody>${c.origemLinhas.map(r => `<tr><td>${esc(String(r.dia||'').slice(0,10))}<br>${esc(r.marca)}</td><td>${moedaOrigem(r.gmv)}</td><td>${moedaOrigem(r.gmv_afiliado)}</td><td>${moedaOrigem(r.gmv_proprio)}</td><td>${moedaOrigem(r.gmv_saldo_nao_afiliado)}</td><td>${moedaOrigem(r.gmv_ajuste_origem)}</td><td>${esc(rot[r.origem_estado]||'Conciliação indisponível')}</td></tr>`).join('')||'<tr><td colspan="7">Sem linhas diárias disponíveis.</td></tr>'}</tbody></table></div></details>`;
  }
  function cardsCanal() {
    const m = marcaAtual(), c = TTS.canal(DADOS, m), j = DADOS.janela || {};
    if (!c.temDados) return '';
    const cards = [
      { r: 'GMV da loja', v: rf(c.gmv), s: `${nf(c.pedidos)} pedidos · ticket ${rf(c.ticket)} · ${j.ini} a ${j.fim}`, t: 'GMV total da loja no TikTok Shop (plataforma), todas as origens' },
      { r: 'GMV de afiliados', v: rf(c.afiliado), s: `${pctOu(c.pctAfiliado)} do total da loja · comparação de fontes`, t: 'Pedidos de afiliados e total da loja vêm de fontes distintas. Divergências permanecem explícitas, sem limitar artificialmente o valor a 100%.' },
      { r: 'Saldo não afiliado · calculado', v: c.origem.saldo === null ? '—' : moedaOrigem(c.origem.saldo), s: c.origem.estado === 'saldo_calculado' ? 'total menos afiliados · não é venda própria atribuída' : 'indisponível · conferir conciliação de origem', t: 'Só calculado quando todos os dias conhecidos conciliam. Não substitui atribuição de venda própria.' },
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
  const indisponivelTTS = '<span class="mini" title="Dado ausente ou não confirmado neste recorte">indisponível</span>';
  const metricaSessaoTTS = (e, fields, value, format = nf) => TTS.camposConhecidos(e.sessoes,fields) ? format(value) : indisponivelTTS;
  const valorTTS = (value, format = nf) => TTS.camposConhecidos([{value}],['value']) ? format(value) : indisponivelTTS;
  // Canal em três partes (visão geral, lives, vídeos): tudo é renderizado de uma vez e só a parte escolhida fica visível,
  // assim trocar de parte é instantâneo e as ressalvas continuam no documento (recolhidas).
  const VISTAS_CANAL = ['resumo', 'lives', 'videos'];
  let canalVista = 'resumo';
  try { const v = localStorage.getItem('shrigma_tts_canal_vista'); if (VISTAS_CANAL.includes(v)) canalVista = v; } catch (_) {}
  const linkVideoTTS = v => /^\d{6,25}$/.test(String(v.video_id || '')) && /^[A-Za-z0-9._]{2,30}$/.test(String(v.username || '')) ? `https://www.tiktok.com/@${v.username}/video/${v.video_id}` : '';
  function renderCanal() {
    const m = marcaAtual(), c = TTS.canal(DADOS, m), todas = m === 'todas', cobertura = TTS.coberturaLiveVideo(DADOS,m), janela = DADOS.janela || {};
    const thM = todas ? '<th>Marca</th>' : '', tdM = x => todas ? `<td>${tag(x.marca)}</td>` : '';
    const ev = c.eventos, vd = c.videos, evVenda = ev.filter(e => e.gmv > 0).length, emFech = ev.filter(e => e.emFechamento && e.gmv > 0).length;
    const topLive = ev.reduce((a, e) => (e.gmv > 0 && (!a || e.gmv > a.gmv) ? e : a), null), topVideo = vd.reduce((a, v) => (Number(v.gmv) > 0 && (!a || Number(v.gmv) > Number(a.gmv)) ? v : a), null);
    const quem = x => x.origem === 'proprio' ? '<span class="tag bom">loja</span>' : x.username ? '@' + esc(x.username) : '<span class="mini">criador não informado</span>';
    const retratos = cobertura.retratos.map(r => `${esc(MARCA_N[r.marca] || r.marca)}: ${r.dias.length ? 'retrato de '+r.dias.map(esc).join(', ') : 'data do retrato indisponível nesta resposta'}`).join(' · ');
    const limiteLives = cobertura.lives.disponivel && cobertura.lives.recebidos >= 60, limiteVideos = cobertura.videos.disponivel && cobertura.videos.recebidos >= 30;

    let html = `<div class="tts-vistas" id="tts-canal-vistas" role="tablist" aria-label="Partes do canal">
      <button type="button" role="tab" data-v="resumo">Visão geral</button>
      <button type="button" role="tab" data-v="lives">Lives <span class="n">${ev.length}</span></button>
      <button type="button" role="tab" data-v="videos">Vídeos <span class="n">${vd.length}</span></button></div>`;

    // 1. Visão geral: origem da venda, GMV por dia e atalhos para as listas
    html += '<section class="tts-vista" data-canal-vista="resumo" role="tabpanel">';
    html += c.temDados ? resumoOrigemCanal(c) + graficoCanal(c.serie) : '<div class="vazio"><strong>Dados diários do canal indisponíveis nesta janela.</strong><br>Isso não comprova zero vendas. Lives e vídeos abaixo mantêm seus próprios recortes e cobertura.</div>';
    html += `<div class="tts-atalhos">
      <button type="button" class="tts-atalho" data-ir="lives"><span class="tts-atalho-rot">Lives · janela selecionada</span>
        <strong>${nf(ev.length)} evento(s)</strong><span class="mini">${nf(evVenda)} com GMV registrado${topLive ? ` · maior: ${rf(topLive.gmv)} em ${esc(dtHora(topLive.inicio_em))}` : ''}</span><span class="tts-atalho-ir">ver lives →</span></button>
      <button type="button" class="tts-atalho" data-ir="videos"><span class="tts-atalho-rot">Vídeos · retrato de 30 dias</span>
        <strong>${nf(vd.length)} vídeo(s) com venda</strong><span class="mini">${topVideo ? `maior: ${valorTTS(topVideo.gmv,rf)} · ${topVideo.origem === 'proprio' ? 'loja' : '@' + esc(topVideo.username || '—')}` : 'nenhum vídeo recebido neste filtro'}</span><span class="tts-atalho-ir">ver vídeos →</span></button></div>`;
    html += '</section>';

    // 2. Lives — por evento (sessões agrupadas), com sessões e produtos ao clicar
    html += '<section class="tts-vista" data-canal-vista="lives" role="tabpanel">';
    html += `<div class="painel-cab"><h3 style="margin:0">Eventos de live <span class="tag nulo">${ev.length}</span>${emFech ? ` <span class="tag neutro" title="terminou há menos de 72 h: a plataforma ainda revisa pedidos pagos, cancelados e pendentes">${emFech} em fechamento</span>` : ''}</h3><span class="mini">${evVenda} com GMV positivo · toque na linha para ver sessões e produtos</span></div>`;
    html += `<p class="tts-cobertura">Janela <strong>${esc(janela.ini || 'indisponível')} a ${esc(janela.fim || 'indisponível')}</strong>${cobertura.lives.disponivel ? ` · ${nf(cobertura.lives.selecionados)} de ${nf(cobertura.lives.recebidos)} sessões recebidas` : ''}${limiteLives ? ' <span class="tag neutro" title="a lista chegou ao limite de 60 sessões entre as marcas; pode haver lives fora dela">no limite · lista pode estar cortada</span>' : ''}</p>`;
    html += `<details class="ressalvas"><summary>Como ler esta lista</summary><ul>
      <li>Esta lista recebe até <strong>60 sessões com maior GMV entre as marcas</strong>, antes do filtro de marca e do agrupamento. ${cobertura.lives.disponivel ? `${nf(cobertura.lives.recebidos)} sessões recebidas no total; ${nf(cobertura.lives.selecionados)} neste filtro.` : 'Lista de sessões indisponível.'}</li>
      <li>Um evento pode estar incompleto. Sessões da mesma conta com intervalo de até 30 minutos são agrupadas; a contagem é de grupos das sessões recebidas, não um inventário completo de lives.</li>
      <li><strong>Espectadores são somados por sessão, não pessoas únicas do evento.</strong> Quem retorna em outra sessão pode aparecer novamente.</li>
      <li>GMV = pago; pedido criado e não pago aparece como “+N” ao lado dos pedidos. A plataforma revisa os números por ~72 h (◔).</li>
      <li>Zero só é exibido quando o campo foi informado; “indisponível” não é zero.</li></ul></details>`;
    if (!ev.length) html += '<div class="vazio">Nenhuma sessão de live recebida neste filtro. O limite global ou a cobertura da coleta podem omitir sessões; isso não comprova ausência de lives ou de vendas.</div>';
    else html += `<div class="rolagem"><table class="comparativo tts-ev tts-compacta"><thead><tr>
      <th>Quando</th>${thM}<th>Quem</th><th class="num" title="minutos ao vivo, somando as sessões">Duração</th>
      <th class="num" title="espectadores únicos por sessão, somados — quem voltou depois da queda conta de novo">Espectadores <span class="mini">soma</span></th>
      <th class="num" title="CTR = cliques em produto / impressões de produto · clique→pedido = pedidos pagos / cliques">CTR <span class="mini">· cl→ped</span></th>
      <th class="num" title="pedidos pagos · +pendentes de pagamento">Pedidos</th><th class="num" title="GMV pago somando as sessões">GMV</th>
      <th class="num" title="GMV nas 24 h após a live (a plataforma fecha com atraso)">GMV 24 h</th><th class="num" title="novos seguidores">Seguid.</th><th aria-hidden="true"></th></tr></thead><tbody>
      ${dobra(ev.slice(0, 60).map((e, i) => `<tr class="tts-ev-linha" data-i="${i}" tabindex="0" aria-expanded="false" style="cursor:pointer">
        <td class="tabn nowrap">${dtHora(e.inicio_em)}${e.sessoes.length > 1 ? ` <span class="tag nulo" title="${e.sessoes.length} sessões agrupadas por conta e intervalo">${e.sessoes.length}×</span>` : ''}${e.emFechamento && e.gmv > 0 ? ' <span class="mini" title="terminou há menos de 72 h — números ainda em revisão pela plataforma">◔</span>' : ''}</td>${tdM(e)}
        <td class="tts-quem"><div class="nome">${quem(e)}</div>${e.titulo ? `<span class="mini tts-1linha" title="${esc(e.titulo)}">${esc(String(e.titulo).slice(0, 70))}</span>` : ''}</td>
        <td class="num tabn">${metricaSessaoTTS(e,['duracao_min'],e.duracao_min,v=>nf(v)+' min')}</td>
        <td class="num tabn">${metricaSessaoTTS(e,['espectadores'],e.espectadores)}</td>
        <td class="num tabn">${metricaSessaoTTS(e,['cliques','impressoes_produto'],e.ctr_pct,v=>pctOu(v,1))}<span class="mini tts-sub">${metricaSessaoTTS(e,['pedidos','cliques'],e.clique_pedido_pct,v=>pctOu(v,1))}</span></td>
        <td class="num tabn">${metricaSessaoTTS(e,['pedidos'],e.pedidos)}${TTS.camposConhecidos(e.sessoes,['pedidos','pedidos_criados']) && e.pendentes ? ` <span class="mini" title="${e.pendentes} pedido(s) criado(s) e ainda não pago(s) — COD/PayLater; entra no GMV quando pagar">+${e.pendentes}</span>` : ''}</td><td class="num tabn"><b>${metricaSessaoTTS(e,['gmv'],e.gmv,rf)}</b></td>
        <td class="num tabn">${metricaSessaoTTS(e,['gmv_24h'],e.gmv_24h,rf)}</td>
        <td class="num tabn">${metricaSessaoTTS(e,['novos_seguidores'],e.novos_seguidores,v=>(v>0?'+':'')+nf(v))}</td><td class="tts-abre" aria-hidden="true"><span>▸</span></td></tr>`), 10, 'todas as lives')}</tbody></table></div>`;
    html += '</section>';

    // 3. Vídeos (retrato 30 dias)
    html += '<section class="tts-vista" data-canal-vista="videos" role="tabpanel">';
    html += `<div class="painel-cab"><h3 style="margin:0">Vídeos · retrato acumulado de 30 dias <span class="tag nulo">${vd.length}</span></h3><span class="mini">Este bloco não segue a janela de vendas selecionada</span></div>`;
    html += `<p class="tts-cobertura">${retratos}${cobertura.videos.disponivel ? ` · ${nf(cobertura.videos.recebidos)} vídeos recebidos no total; ${nf(cobertura.videos.selecionados)} neste filtro.` : ' · Lista de vídeos indisponível.'}${limiteVideos ? ' <span class="tag neutro" title="a lista chegou ao limite de 30 vídeos entre as marcas">no limite · lista pode estar cortada</span>' : ''}</p>`;
    html += `<details class="ressalvas"><summary>Como ler esta lista</summary><ul>
      <li>Até <strong>30 vídeos com GMV positivo, ordenados por GMV entre as marcas</strong>, no último retrato disponível de cada marca. O limite é aplicado antes do filtro de marca.</li>
      <li>São valores acumulados de 30 dias da plataforma; não somar aos totais diários da janela escolhida.</li>
      <li>GPM = GMV por mil views, o rendimento do vídeo. CTR = cliques em produto / views.</li></ul></details>`;
    if (!vd.length) html += '<div class="vazio">Nenhum vídeo recebido neste filtro. Isso não comprova zero vendas: pode haver limite global, retrato ausente ou cobertura incompleta.</div>';
    else html += `<div class="rolagem"><table class="comparativo tts-compacta"><thead><tr>
      <th>#</th><th>Criador</th>${thM}<th>Vídeo</th><th>Retrato</th><th class="num">Publicado</th><th class="num">Views · 30 dias</th>
      <th class="num" title="cliques em produto / views">CTR</th><th class="num">Pedidos · 30 dias</th><th class="num">GMV · 30 dias</th><th class="num" title="GMV por mil views — o rendimento do vídeo">GPM</th></tr></thead><tbody>
      ${dobra(vd.slice(0, 50).map((v, i) => { const url = linkVideoTTS(v), titulo = esc(String(v.titulo || '—').slice(0, 90)); return `<tr><td class="tabn">${i + 1}</td>
        <td class="nowrap">${quem(v)}</td>${tdM(v)}
        <td class="tts-prod"><span class="tts-1linha" title="${esc(v.titulo || '')}">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${titulo}</a>` : titulo}</span>${v.duracao_s ? `<span class="mini tts-sub">${v.duracao_s}s</span>` : ''}</td>
        <td class="tabn nowrap mini" title="${esc(String(v.retrato_em || '').slice(0,10))}">${v.retrato_em ? esc(String(v.retrato_em).slice(8,10) + '/' + String(v.retrato_em).slice(5,7)) : indisponivelTTS}</td><td class="num tabn">${dt(v.publicado_em)}</td><td class="num tabn">${valorTTS(v.visualizacoes)}</td>
        <td class="num tabn">${valorTTS(v.ctr_pct,v=>pctOu(+v,1))}</td>
        <td class="num tabn">${valorTTS(v.pedidos)}</td><td class="num tabn"><b>${valorTTS(v.gmv,rf)}</b></td><td class="num tabn">${valorTTS(v.gpm,rf)}</td></tr>`; }), 12, 'todos os vídeos')}</tbody></table></div>`;
    html += '</section>';

    const area = $('#tts-area');
    area.innerHTML = html;
    ligarDobras();
    const mostra = v => {
      canalVista = VISTAS_CANAL.includes(v) ? v : 'resumo';
      try { localStorage.setItem('shrigma_tts_canal_vista', canalVista); } catch (_) {}
      area.querySelectorAll('[data-canal-vista]').forEach(s => { s.hidden = s.dataset.canalVista !== canalVista; });
      area.querySelectorAll('#tts-canal-vistas button').forEach(b => { const on = b.dataset.v === canalVista; b.classList.toggle('ativo', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    };
    area.querySelectorAll('#tts-canal-vistas button').forEach(b => { b.onclick = () => mostra(b.dataset.v); });
    area.querySelectorAll('.tts-atalho').forEach(b => { b.onclick = () => { mostra(b.dataset.ir); area.querySelector('#tts-canal-vistas button.ativo')?.focus?.(); }; });
    mostra(canalVista);
    area.querySelectorAll('.tts-ev-linha').forEach(tr => {
      tr.onkeydown = k => { if (k.key === 'Enter' || k.key === ' ') { k.preventDefault?.(); tr.onclick(); } };
      tr.onclick = () => {
      const prox = tr.nextElementSibling;
      if (prox && prox.classList.contains('tts-ev-det')) { prox.remove(); tr.setAttribute('aria-expanded', 'false'); return; }
      tr.setAttribute('aria-expanded', 'true');
      const e = ev[+tr.dataset.i], prods = TTS.produtosDoEvento(e, c.liveProdutos);
      const camposProduto = (p,keys) => TTS.camposConhecidos(c.liveProdutos.filter(x => e.live_ids.includes(String(x.live_id)) && x.product_id === p.product_id),keys);
      const metricaProduto = (p,keys,value,format=nf) => camposProduto(p,keys) ? format(value) : indisponivelTTS;
      const det = document.createElement('tr'); det.className = 'tts-ev-det';
      det.innerHTML = `<td colspan="12"><div class="tts-ev-grid">
        <div><div class="mini" style="margin-bottom:4px"><b>Sessões</b> · ${e.sessoes.length}</div><table class="comparativo mini"><tbody>${e.sessoes.map(x => `<tr><td class="tabn">${dtHora(x.inicio_em)}</td><td class="num tabn">${valorTTS(x.duracao_min,v=>nf(v)+' min')}</td><td class="num tabn">${valorTTS(x.espectadores)} esp./sessão</td><td class="num tabn">${valorTTS(x.pedidos)} ped.</td><td class="num tabn"><b>${valorTTS(x.gmv,rf)}</b></td></tr>`).join('')}</tbody></table></div>
        <div><div class="mini" style="margin-bottom:4px"><b>Produtos</b> · ${prods.length ? `exibindo ${Math.min(prods.length,12)} de ${prods.length} produtos recebidos deste grupo` : 'nenhum registro de produto recebido para este grupo'}</div>
          <p class="mini">O detalhe cobre lives próprias e recebe até 400 registros de sessão/produto entre as marcas na janela, ordenados por GMV direto; entram registros com GMV direto positivo ou pelo menos 10 cliques. O limite vem antes do agrupamento. ${cobertura.produtos.disponivel ? nf(cobertura.produtos.recebidos)+' registros de produto recebidos no total.' : 'Lista de produtos indisponível.'} Ausência não comprova zero; estes produtos não conciliam, por si só, o GMV completo da live.</p>
          ${prods.length ? `<table class="comparativo mini"><thead><tr><th>Produto</th><th class="num">Impr.</th><th class="num">Cliques</th><th class="num" title="cliques / impressões">CTR</th><th class="num" title="pedidos pagos / cliques">Cl→ped</th><th class="num">Pedidos</th><th class="num">GMV direto</th></tr></thead><tbody>
          ${prods.slice(0, 12).map(p => `<tr><td class="tts-prod" title="${esc(p.nome || '')}">${esc(String(p.nome || p.product_id).slice(0, 48))}</td><td class="num tabn">${metricaProduto(p,['impressoes'],p.impressoes)}</td><td class="num tabn">${metricaProduto(p,['cliques'],p.cliques)}</td><td class="num tabn">${metricaProduto(p,['cliques','impressoes'],p.ctr_pct,v=>pctOu(v,1))}</td><td class="num tabn">${metricaProduto(p,['pedidos','cliques'],p.clique_pedido_pct,v=>pctOu(v,1))}</td><td class="num tabn">${metricaProduto(p,['pedidos'],p.pedidos)}${camposProduto(p,['pedidos','pedidos_criados']) && p.pedidos_criados > p.pedidos ? ` <span class="mini">+${p.pedidos_criados - p.pedidos}</span>` : ''}</td><td class="num tabn"><b>${metricaProduto(p,['gmv_direto'],p.gmv_direto,rf)}</b></td></tr>`).join('')}</tbody></table>` : ''}</div></div></td>`;
      tr.after(det);
      };
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
        <td><select class="i-sel tts-r" data-campo="modo" title="Aprovação automática indisponível enquanto as guardas de concorrência estiverem pendentes.">${['dry_run', 'pausado'].concat(r.modo === 'ativo' ? ['ativo'] : []).map(o => `<option value="${o}" ${o === 'ativo' ? 'disabled' : ''} ${r.modo === o ? 'selected' : ''}>${o === 'dry_run' ? 'simulação' : o}</option>`).join('')}</select></td>
        <td class="num">${inp(r, 'gmv_auto', 500, 'R$, GMV 30d')}</td><td class="num">${inp(r, 'gmv_manual', 500, 'R$, GMV 30d')}</td>
        <td class="num">${inp(r, 'fulfillment_min', 1, '% de amostras postadas em 90 dias')}</td><td class="num">${inp(r, 'teto_mensal', 5, 'amostras por mês')}</td>
        <td>${r.sku_regex ? `<span class="mini" title="${esc(r.sku_regex)}">padrão: ${esc(r.marca === 'fish' ? 'multi 150 m · mono 300 m' : r.marca === 'aristo' ? 'unitário ou kit de até 3' : 'regex')}</span>` : ''}${(r.skus_permitidos || []).length ? `<span class="mini"> + ${r.skus_permitidos.length} SKU(s)</span>` : ''}${!r.sku_regex && !(r.skus_permitidos || []).length ? '<span class="tag alerta" title="sem lista nem padrão, a regra de SKU não filtra nada">sem filtro</span>' : ''}</td>
        <td class="mini">${esc(r.atualizado_por || '')} · ${dt(r.atualizado_em)}</td>
        <td><button class="btn tts-btn tts-salvar" ${TTS.regrasEditaveis(DADOS) ? '' : 'disabled title="Edição temporariamente indisponível; recarregue após a confirmação do serviço."'}>Salvar</button> <span class="mini tts-msg"></span></td></tr>`).join('')}</tbody></table></div>
      <div class="tts-origem"><span class="tag neutro">decisão manual</span> <span>A esteira roda a cada 2 h só em <strong>simulação</strong>: grava o que faria, não toca no TikTok. Aprovação automática indisponível enquanto as guardas de concorrência não estiverem comprovadas.</span></div>`;
    if (!TTS.regrasEditaveis(DADOS)) $('#tts-area').insertAdjacentHTML('afterbegin','<div class="nota" role="status">Edição de regras temporariamente indisponível. A confirmação do serviço precisa estar atualizada.</div>');
    const regrasLidas = new Map((DADOS.regra || []).map(r => [r.marca,{...r}]));
    document.querySelectorAll('#tts-area .tts-salvar').forEach(b => b.onclick = () => {
      const tr = b.closest('tr'), msg = tr.querySelector('.tts-msg'), regra = {};
      tr.querySelectorAll('.tts-r').forEach(el => { regra[el.dataset.campo] = el.tagName === 'SELECT' ? el.value : Number(el.value); });
      armar(b, 'Confirmar?', async () => {
        const j = await acaoTTS(TTS.pedidoRegra(regrasLidas.get(tr.dataset.marca),regra));
        msg.textContent = j.mensagem || 'ok'; b.disabled = false; b.textContent = 'Salvar';
        await carregarTTS();
      });
    });
  }

  // ligações com a página
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('#tts-abas button').forEach(b => b.onclick = () => { PANE = b.dataset.p; try { localStorage.setItem('shrigma_tts_pane', PANE); } catch (e) {} renderPane(); });
  });
  window.addEventListener('storage', e => { if (e.key?.startsWith('shrigma_tts_manual_v1:')) travaAmostrasTTS(); });
  window.carregarTTS = carregarTTS;
  window.renderTTS = renderTTS;
})();
