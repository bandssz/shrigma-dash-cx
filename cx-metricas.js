// ================== CX · MÉTRICAS NOVAS (camada de dados) ==================
// Funções puras sobre os blocos novos da API do painel de CX:
//   cx_csat    — view cx_csat_dia: marca × canal × dia × motivo × escalado
//                (tickets, csat_enviado, avaliadas, bom, neutro, ruim, kai_pode_atender, abertos,
//                 fechados, resposta_humana, kai_fechou, fechado_inatividade — estas quatro desde 14/09)
//   cx_pedidos — cx_pedido_dia: marca × dia × pedidos (Shopify)
//   cx_ra      — cx_ra_dia: marca × dia × índices do Reclame Aqui (metatags da brand page)
// Nenhum DOM aqui — testável com `node --test tests/cx-metricas.test.cjs`.
//
// Regras que este arquivo respeita (não mude sem entender):
// 1. CSAT do Gleap tem TRÊS opções (2 ruim / 6 neutro / 10 bom). Nunca vira média:
//    o que se mostra é % bom / % neutro / % ruim sobre avaliadas.
// 2. Percentual só com base >= MIN_BASE (30) avaliadas. Abaixo disso devolve null e a
//    tela mostra a contagem.
// 3. Escalado = transferência real (processingTeam/processingUser). E-mail é SEMPRE
//    escalado pelo roteamento e não recebe tag de motivo: sai de qualquer conta de Kai
//    e de qualquer conta de motivo. Entra só no volume total de contatos.
// 4. Contatos por 100 pedidos usa pedidos CRIADOS no mesmo intervalo. Em janela curta
//    (< 7 dias) a razão é frágil: WISMO de hoje é sobre pedido de semana passada.
// 5. Delta entre períodos só quando os dois lados têm dado. Ausência nunca vira queda.

const CX_MIN_BASE = 30;

// ordem fixa (não é ranking): quem lê aprende a posição de cada motivo
const CX_MOTIVOS = [
  { k: "wismo",        r: "Cadê meu pedido",  curto: "WISMO" },
  { k: "pre-venda",    r: "Pré-venda",        curto: "Pré-venda" },
  { k: "problema",     r: "Problema",         curto: "Problema" },
  { k: "troca",        r: "Troca",            curto: "Troca" },
  { k: "cancelamento", r: "Cancelamento",     curto: "Cancel." },
  { k: "outros",       r: "Outros",           curto: "Outros" },
  { k: "sem-tag",      r: "Sem tag",          curto: "Sem tag" },
];
const CX_ROTULO_MOTIVO = Object.fromEntries(CX_MOTIVOS.map((m) => [m.k, m.r]));

// Kai não roda em e-mail; widget é resíduo (< 1%) mas é chat, fica.
const CX_CANAIS_KAI = ["whatsapp", "instagram", "widget"];

function cxDia(v) { return String(v || "").slice(0, 10); }

// filtro comum: {marca:'todas'|m, ini, fim, canais:[...]|null, escalado:true|false|null, motivo:k|null}
function cxFiltra(rows, f) {
  const out = [];
  for (const l of rows || []) {
    if (!l) continue;
    const dia = cxDia(l.dia);
    if (dia < f.ini || dia > f.fim) continue;
    if (f.marca && f.marca !== "todas" && l.marca !== f.marca) continue;
    if (f.canais && !f.canais.includes(l.canal)) continue;
    if (f.escalado === true && l.escalado !== true) continue;
    if (f.escalado === false && l.escalado !== false) continue;
    if (f.motivo && l.motivo !== f.motivo) continue;
    out.push(l);
  }
  return out;
}

const CX_CAMPOS = ["tickets", "csat_enviado", "avaliadas", "bom", "neutro", "ruim", "kai_pode_atender", "abertos", "fechados", "resposta_humana", "kai_fechou", "fechado_inatividade"];
function cxSoma(rows) {
  const a = { tickets: 0, csat_enviado: 0, avaliadas: 0, bom: 0, neutro: 0, ruim: 0, kai_pode_atender: 0, abertos: 0, fechados: 0, resposta_humana: 0, kai_fechou: 0, fechado_inatividade: 0, linhas: 0 };
  for (const l of rows) { a.linhas++; for (const k of CX_CAMPOS) a[k] += Number(l[k] || 0); }
  return a;
}

// agregado + percentuais prontos; pct = null quando a base é curta
function csatAgg(rows, f) {
  const a = cxSoma(cxFiltra(rows, f));
  const n = a.avaliadas;
  const ok = n >= CX_MIN_BASE;
  a.baseOk = ok;
  a.pctBom = ok ? (a.bom / n) * 100 : null;
  a.pctNeutro = ok ? (a.neutro / n) * 100 : null;
  a.pctRuim = ok ? (a.ruim / n) * 100 : null;
  // resposta = avaliadas / tickets (denominador é o contato, não o "csat enviado":
  // a tag é limpa para re-rating, então "enviado" subconta)
  a.pctResposta = a.tickets ? (n / a.tickets) * 100 : null;
  return a;
}

// CSAT do Kai sozinho × passou por pessoa, só nos canais em que o Kai atende
function csatKaiVsPessoa(rows, f) {
  const base = Object.assign({}, f, { canais: CX_CANAIS_KAI });
  return {
    kai: csatAgg(rows, Object.assign({}, base, { escalado: false })),
    pessoa: csatAgg(rows, Object.assign({}, base, { escalado: true })),
    todos: csatAgg(rows, base),
  };
}

// Volume e CSAT por motivo, com delta de volume contra o período anterior.
// Só canais do Kai: e-mail não tem tag (vira 'sem-tag' e é reportado à parte).
function porMotivo(rows, f, fAnt) {
  const base = Object.assign({}, f, { canais: f.canais || CX_CANAIS_KAI });
  const tot = csatAgg(rows, base);
  const ant = fAnt ? csatAgg(rows, Object.assign({}, fAnt, { canais: base.canais })) : null;
  const linhas = CX_MOTIVOS.map((m) => {
    const a = csatAgg(rows, Object.assign({}, base, { motivo: m.k }));
    const kai = csatAgg(rows, Object.assign({}, base, { motivo: m.k, escalado: false }));
    const pes = csatAgg(rows, Object.assign({}, base, { motivo: m.k, escalado: true }));
    const aa = ant ? csatAgg(rows, Object.assign({}, fAnt, { canais: base.canais, motivo: m.k })) : null;
    return {
      motivo: m.k, rotulo: m.r, curto: m.curto,
      tickets: a.tickets, share: tot.tickets ? (a.tickets / tot.tickets) * 100 : null,
      anterior: aa ? aa.tickets : null,
      delta: aa && aa.tickets > 0 ? ((a.tickets - aa.tickets) / aa.tickets) * 100 : null,
      avaliadas: a.avaliadas, bom: a.bom, neutro: a.neutro, ruim: a.ruim, pctResposta: a.pctResposta,
      pctBom: a.pctBom, pctNeutro: a.pctNeutro, pctRuim: a.pctRuim, baseOk: a.baseOk,
      // kaiShare (14/09): fatia do motivo que o Kai de fato FECHOU sozinho (kai_fechou), não 'não foi transferido' —
      // ticket não transferido e ainda aberto não é vitória do Kai. Sem coluna nova na API, cai para o critério antigo.
      kaiTickets: kai.tickets, kaiFechou: a.kai_fechou,
      kaiShare: a.tickets ? ((a.linhas && rows.some((l) => l.kai_fechou !== undefined) ? a.kai_fechou : kai.tickets) / a.tickets) * 100 : null,
      kaiBom: kai.pctBom, kaiAvaliadas: kai.avaliadas,
      pessoaBom: pes.pctBom, pessoaAvaliadas: pes.avaliadas,
    };
  }).filter((l) => l.tickets > 0 || l.anterior > 0);
  // e-mail à parte: volume que existe mas não tem motivo
  const email = csatAgg(rows, Object.assign({}, f, { canais: ["email"] }));
  return { linhas, total: tot, anterior: ant, email };
}

// segunda-feira (ymd) da semana de um dia — mesma regra de app.js/growth
function cxSegunda(ymd) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// Série semanal de CSAT (bom %) e taxa de resposta, no intervalo. Semana parcial marcada.
function serieCsatSemanal(rows, f, hoje) {
  const sel = cxFiltra(rows, Object.assign({}, f, { canais: f.canais || CX_CANAIS_KAI }));
  const por = {};
  for (const l of sel) {
    const s = cxSegunda(cxDia(l.dia));
    const a = por[s] || (por[s] = { semana: s, tickets: 0, avaliadas: 0, bom: 0, dias: new Set() });
    a.tickets += Number(l.tickets || 0); a.avaliadas += Number(l.avaliadas || 0); a.bom += Number(l.bom || 0);
    a.dias.add(cxDia(l.dia));
  }
  return Object.values(por).sort((x, y) => (x.semana < y.semana ? -1 : 1)).map((a) => ({
    semana: a.semana, tickets: a.tickets, avaliadas: a.avaliadas,
    pctBom: a.avaliadas >= CX_MIN_BASE ? (a.bom / a.avaliadas) * 100 : null,
    pctResposta: a.tickets ? (a.avaliadas / a.tickets) * 100 : null,
    parcial: a.dias.size < 7 && (hoje ? cxSegunda(hoje) === a.semana : false),
  }));
}

// ---------- contatos por pedido ----------
function somaPedidos(pedidos, marca, ini, fim) {
  let n = 0, dias = 0;
  for (const p of pedidos || []) {
    const dia = cxDia(p.dia);
    if (dia < ini || dia > fim) continue;
    if (marca !== "todas" && p.marca !== marca) continue;
    if (typeof p.pedidos === "number") { n += p.pedidos; dias++; }
  }
  return { pedidos: dias ? n : null, dias };
}

// contatos = TODOS os canais (e-mail inclusive). wismo = tag wismo (só chat: e-mail não tem tag,
// então o WISMO de e-mail fica de fora e a taxa é piso, não teto).
function contatosPorPedido(csatRows, pedidos, f) {
  const tudo = csatAgg(csatRows, Object.assign({}, f, { canais: null, escalado: null, motivo: null }));
  const wismo = csatAgg(csatRows, Object.assign({}, f, { canais: CX_CANAIS_KAI, escalado: null, motivo: "wismo" }));
  const ped = somaPedidos(pedidos, f.marca || "todas", f.ini, f.fim);
  const nDias = Math.round((new Date(f.fim + "T12:00Z") - new Date(f.ini + "T12:00Z")) / 864e5) + 1;
  return {
    contatos: tudo.tickets, wismo: wismo.tickets, pedidos: ped.pedidos, diasPedidos: ped.dias, dias: nDias,
    contatosDia: nDias ? tudo.tickets / nDias : null,
    wismoDia: nDias ? wismo.tickets / nDias : null,
    por100: ped.pedidos ? (tudo.tickets / ped.pedidos) * 100 : null,
    wismoRate: ped.pedidos ? (wismo.tickets / ped.pedidos) * 100 : null,
    wismoShare: tudo.tickets ? (wismo.tickets / tudo.tickets) * 100 : null,
    janelaCurta: nDias < 7,
  };
}

// ---------- Reclame Aqui ----------
// linha mais recente por marca até `fim` (a mais recente disponível se o período não tem)
function raUltimo(rows, marca, fim) {
  let melhor = null;
  for (const r of rows || []) {
    if (!r || r.marca !== marca) continue;
    const dia = cxDia(r.dia);
    if (fim && dia > fim) continue;
    if (!melhor || dia > cxDia(melhor.dia)) melhor = r;
  }
  return melhor;
}
// critérios RA1000 (blog do Reclame AQUI, confirmados 08/2026)
const CX_RA1000 = [
  ["nota", "Nota média", 7, 10, "nota"],
  ["resposta_pct", "Respondidas", 90, 100, "pct"],
  ["solucao_pct", "Índice de solução", 90, 100, "pct"],
  ["voltaria_pct", "Voltaria a fazer negócio", 70, 100, "pct"],
  ["avaliacoes", "Avaliações", 50, null, "int"],
];
function raAvalia(linha) {
  if (!linha) return null;
  const crit = CX_RA1000.map(([c, rot, min, max, tipo]) => {
    const v = linha[c] === null || linha[c] === undefined ? null : Number(linha[c]);
    return { c, rot, min, max, tipo, v, bate: typeof v === "number" && !Number.isNaN(v) && v >= min };
  });
  return { crit, ra1000: crit.every((x) => x.bate), faltam: crit.filter((x) => !x.bate).length };
}
// Sem resposta no RA (14/09): a página pública tem DOIS números. `aguardando` é o da régua de reputação —
// janela fechada de 6 meses (periodo_ini..periodo_fim), que ficava em 102 enquanto o Samuel via 260 no
// RA Empresas. `pendentes_agora` é a fila real (busca pública, status=PENDING, todas as ativas). O painel
// mostra a fila real e cai para a régua só em leitura antiga que não tem o campo.
function raPendentes(linha) {
  if (!linha) return { v: null, regua: null, real: false };
  const n = (x) => x === null || x === undefined || x === "" ? null : Number(x);
  const real = n(linha.pendentes_agora), regua = n(linha.aguardando);
  return real !== null ? { v: real, regua, real: true } : { v: regua, regua, real: false };
}
// rótulo da janela da régua: "01/03–31/08" (null quando a leitura não trouxe o período)
function raPeriodo(linha) {
  if (!linha || !linha.periodo_ini || !linha.periodo_fim) return null;
  const f = (s) => { const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}` : null; };
  const a = f(linha.periodo_ini), b = f(linha.periodo_fim);
  return a && b ? `${a}–${b}` : null;
}

// dias distintos com linha no intervalo (para não comparar contra período sem histórico)
function cxDiasComDado(rows, f) {
  const s = new Set();
  for (const l of cxFiltra(rows, { marca: f.marca, ini: f.ini, fim: f.fim })) s.add(cxDia(l.dia));
  return s.size;
}

// ---------- delta genérico ----------
function cxDelta(atual, anterior) {
  if (typeof atual !== "number" || typeof anterior !== "number" || anterior === 0) return null;
  return ((atual - anterior) / Math.abs(anterior)) * 100;
}


// ---------- desfecho maduro (14/09): o Kai medido sobre TODOS os tickets, não só os fechados ----------
// Por que: "Kai resolveu ÷ (Kai + fechados por pessoa)" ignorava o ticket transferido e ainda aberto. Na semana
// de 06–12/09 isso deu 43% no Aristocrata quando o Kai fechou 26% dos tickets e 38% foram transferidos e ninguém
// respondeu (fila de 1.257). Aqui o denominador é o ticket de chat MADURO — com 2 dias de expediente depois dele (quem ia fechar já fechou);
// o que sobra em aberto é estado real, não ruído. Colunas vêm da view cx_csat_dia (fechados, resposta_humana,
// kai_fechou, fechado_inatividade). Ticket transferido sem resposta humana = linhas escalado=true: tickets − resposta_humana.
// Maturação conta DIAS DE EXPEDIENTE: sexta e sábado não têm atendimento humano (só o Kai), então ticket de quinta
// só tem desfecho justo na terça. CX_DIAS_SEM_EXPEDIENTE usa getUTCDay (0 = dom … 6 = sáb). Domingo está como SEM
// expediente até o Felipe confirmar — errar para esse lado só atrasa a maturação, nunca infla "ninguém respondeu".
const CX_MATURACAO_DIAS = 2;
const CX_DIAS_SEM_EXPEDIENTE = [0, 5, 6];
function diasAtrasCx(n, base) { const d = new Date(base + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }
function cxEhExpediente(ymd) { return !CX_DIAS_SEM_EXPEDIENTE.includes(new Date(ymd + "T12:00:00Z").getUTCDay()); }
// teto = último dia cujos tickets já tiveram CX_MATURACAO_DIAS dias completos de expediente depois (hoje não conta: está em andamento)
function cxFimMaduro(fim, hoje) {
  let d = diasAtrasCx(1, hoje), n = 0, guarda = 0;
  while (guarda++ < 14) { if (cxEhExpediente(d)) n++; if (n >= CX_MATURACAO_DIAS) break; d = diasAtrasCx(1, d); }
  const teto = diasAtrasCx(1, d);
  return fim < teto ? fim : teto;
}
function desfechoMaduro(rows, f, hoje) {
  const fim = cxFimMaduro(f.fim, hoje);
  const sel = cxFiltra(rows, Object.assign({}, f, { fim, canais: f.canais || CX_CANAIS_KAI }));
  const a = cxSoma(sel);
  const esc = cxSoma(sel.filter((l) => l.escalado === true));
  const kai = a.kai_fechou, pessoa = a.resposta_humana;
  const semResp = Math.max(0, esc.tickets - esc.resposta_humana);       // transferido e ninguém respondeu (aberto ou fechado)
  const inat = a.fechado_inatividade;
  const abertoSemTransf = Math.max(0, a.tickets - kai - pessoa - semResp - inat);
  const t = a.tickets, ok = t >= CX_MIN_BASE;
  const pct = (x) => (ok ? (x / t) * 100 : null);
  return { ini: f.ini, fim, maduro: fim >= f.ini, tickets: t, kai, pessoa, semResp, inat, abertoSemTransf, baseOk: ok,
    pctKai: pct(kai), pctPessoa: pct(pessoa), pctSemResp: pct(semResp), pctAberto: pct(abertoSemTransf + inat) };
}
// série semanal do desfecho maduro; semana que passa de D-2 é parcial (o que ainda vai fechar não fechou)
function serieSemanalDesfecho(rows, f, hoje) {
  const semanas = cxSemanas(f.ini, f.fim); const teto = cxFimMaduro('9999-12-31', hoje);
  const pontos = semanas.map((s) => {
    const fimSem = diasAtrasCx(-6, s); const fim = fimSem < teto ? fimSem : teto;
    if (fim < s) return { semana: s, tickets: 0, kai: 0, pessoa: 0, semResp: 0, aberto: 0, y: null, ySemResp: null, parcial: true };
    const d = desfechoMaduro(rows, { marca: f.marca, ini: s, fim, canais: f.canais }, hoje);
    return { semana: s, tickets: d.tickets, kai: d.kai, pessoa: d.pessoa, semResp: d.semResp, aberto: d.abertoSemTransf + d.inat, y: d.pctKai, ySemResp: d.pctSemResp, parcial: fimSem > teto };
  });
  return { semanas, pontos };
}


// ---------- tempo até a 1ª resposta humana (14/09): cx_tempo (por marca × canal × dia) e cx_tempo_agente ----------
// A view traz mediana e p90 POR DIA (em segundos de expediente seg–qui 8–18 e em relógio corrido). Mediana de
// medianas não existe: para o período usa-se a mediana das medianas diárias PONDERADA pelo volume do dia, marcada
// com "≈" na tela. A fatia "em até 1h" é exata (contagem). Dia de criação do ticket = dia da linha; resposta
// tardia entra quando acontece, por isso dias recentes ainda mudam — a tela lê dias completos.
function medianaPonderada(pares) {   // [[valor, peso]] → valor no ponto em que a soma dos pesos passa da metade
  const v = pares.filter((p) => typeof p[0] === "number" && p[1] > 0).sort((a, b) => a[0] - b[0]);
  const tot = v.reduce((s, p) => s + p[1], 0); if (!tot) return null;
  let acc = 0; for (const p of v) { acc += p[1]; if (acc >= tot / 2) return p[0]; }
  return v[v.length - 1][0];
}
function tempoAgg(rows, f) {
  const sel = cxFiltra(rows, f);
  const a = { tickets: 0, respondidos: 0, transfSemResp: 0, comTempo: 0, ate1h: 0, ate4h: 0, dias: new Set() };
  const p50c = [], p90c = [], p50r = [];
  for (const l of sel) {
    a.tickets += Number(l.tickets || 0); a.respondidos += Number(l.respondidos || 0); a.transfSemResp += Number(l.transferidos_sem_resposta || 0);
    const n = Number(l.com_tempo || 0); a.comTempo += n; a.ate1h += Number(l.ate_1h || 0); a.ate4h += Number(l.ate_4h || 0);
    if (n) { a.dias.add(cxDia(l.dia)); p50c.push([Number(l.p50_comercial_seg), n]); p90c.push([Number(l.p90_comercial_seg), n]); p50r.push([Number(l.p50_relogio_seg), n]); }
  }
  a.dias = a.dias.size;
  a.p50Comercial = medianaPonderada(p50c); a.p90Comercial = medianaPonderada(p90c); a.p50Relogio = medianaPonderada(p50r);
  a.aproximado = a.dias > 1;                  // um dia só = a mediana do dia, exata
  a.pctAte1h = a.comTempo ? (a.ate1h / a.comTempo) * 100 : null;
  a.pctAte4h = a.comTempo ? (a.ate4h / a.comTempo) * 100 : null;
  a.pctRespondidos = a.tickets ? (a.respondidos / a.tickets) * 100 : null;
  return a;
}
// série diária da mediana em expediente, uma linha por marca (todos os canais)
function serieDiariaTempo(rows, marcas, ini, fim) {
  const dias = cxDiasIntervalo(ini, fim);
  // dia sem expediente (sex/sáb/dom) fica em branco: o expediente zera por definição, não por mérito
  return { dias, series: marcas.map((m) => ({ marca: m, pontos: dias.map((d) => { const a = tempoAgg(rows, { marca: m, ini: d, fim: d }); return { dia: d, y: a.comTempo >= 5 && cxEhExpediente(d) ? a.p50Comercial : null, n: a.comTempo, ate1h: a.pctAte1h }; }) })) };
}
// por pessoa que deu a 1ª resposta, no período
function tempoPorAgente(rows, f) {
  const acc = {};
  for (const l of cxFiltra(rows, f)) {
    const a = acc[l.agente_id] || (acc[l.agente_id] = { agente_id: l.agente_id, nome: l.agente_nome, marcas: new Set(), respondidos: 0, ate1h: 0, p50c: [], p50r: [] });
    a.nome = a.nome || l.agente_nome; a.marcas.add(l.marca);
    const n = Number(l.respondidos || 0); a.respondidos += n; a.ate1h += Number(l.ate_1h || 0);
    a.p50c.push([Number(l.p50_comercial_seg), n]); a.p50r.push([Number(l.p50_relogio_seg), n]);
  }
  return Object.values(acc).map((a) => ({ agente_id: a.agente_id, nome: a.nome, marcas: [...a.marcas], respondidos: a.respondidos,
    p50Comercial: medianaPonderada(a.p50c), p50Relogio: medianaPonderada(a.p50r), pctAte1h: a.respondidos ? (a.ate1h / a.respondidos) * 100 : null, aproximado: a.p50c.length > 1 }))
    .sort((x, y) => y.respondidos - x.respondidos);
}


// ---------- fechamentos (15/09): cx_fechamento_dia (marca × canal × dia do fechamento) e cx_fechamento_agente_dia ----------
// "Fechados" do Gleap conta fechamento, não resolução: o mesmo ticket fechado três vezes conta três, e reabertura
// concentra em incidente. Aqui cada fechamento é uma linha em cx_fechamento com quem fechou e se o cliente VOLTOU
// em 7 dias corridos (mensagem dele depois do fechamento, ignorando a resposta do CSAT). Resolutivo = maduro
// (7 dias passados) e sem volta. FCR = primeiro fechamento do ticket por pessoa, um agente só, sem volta.
// A view já traz maduros/resolutivos calculados na hora da consulta; a tela só soma e só mostra % em base ≥ 30.
const CX_VOLTA_DIAS = 7;
function fechamentoAgg(rows, f) {
  const a = { fechados: 0, porPessoa: 0, porKai: 0, porSistema: 0, maduros: 0, resolutivos: 0, voltaram: 0, voltaramHumano: 0,
    pessoaMaduros: 0, pessoaResolutivos: 0, kaiMaduros: 0, kaiResolutivos: 0, fcrBase: 0, fcr: 0, dias: new Set() };
  const p50h = [], p50c = [];
  for (const l of cxFiltra(rows, f)) {
    const n = (k) => Number(l[k] || 0);
    a.fechados += n("fechados"); a.porPessoa += n("por_pessoa"); a.porKai += n("por_kai"); a.porSistema += n("por_sistema");
    a.maduros += n("maduros"); a.resolutivos += n("resolutivos"); a.voltaram += n("voltaram"); a.voltaramHumano += n("voltaram_humano");
    a.pessoaMaduros += n("pessoa_maduros"); a.pessoaResolutivos += n("pessoa_resolutivos"); a.kaiMaduros += n("kai_maduros"); a.kaiResolutivos += n("kai_resolutivos");
    a.fcrBase += n("fcr_base"); a.fcr += n("fcr");
    if (n("por_pessoa")) { a.dias.add(cxDia(l.dia)); p50h.push([Number(l.msgs_humanas_p50), n("por_pessoa")]); p50c.push([Number(l.msgs_cliente_p50), n("por_pessoa")]); }
  }
  const pct = (x, b) => b >= CX_MIN_BASE ? (x / b) * 100 : null;
  return Object.assign(a, {
    dias: a.dias.size,
    pctVoltouPessoa: pct(a.pessoaMaduros - a.pessoaResolutivos, a.pessoaMaduros),   // fechou, cliente voltou em 7 dias
    pctVoltouKai: pct(a.kaiMaduros - a.kaiResolutivos, a.kaiMaduros),
    pctResolutivoPessoa: pct(a.pessoaResolutivos, a.pessoaMaduros),
    pctFcr: pct(a.fcr, a.fcrBase),
    msgsHumanasP50: medianaPonderada(p50h), msgsClienteP50: medianaPonderada(p50c), aproximado: p50h.length > 1,
    imaturos: a.fechados - a.maduros,
  });
}
// último dia cujos fechamentos já estão maduros (7 dias corridos) — etiqueta "maduro até dd/mm"
function cxFimMaduroVolta(hoje) { return diasAtrasCx(CX_VOLTA_DIAS, hoje); }
// % voltou (fechamento por pessoa) por semana, uma linha por marca; semana sem dia maduro = null, parcialmente madura = parcial
function serieSemanalVolta(rows, f, hoje) {
  const semanas = cxSemanas(f.ini, f.fim); const teto = cxFimMaduroVolta(hoje);
  const pontos = semanas.map((s) => {
    const fimSem = diasAtrasCx(-6, s); const fim = fimSem < teto ? fimSem : teto;
    if (fim < s) return { semana: s, y: null, yKai: null, n: 0, parcial: true };
    const a = fechamentoAgg(rows, { marca: f.marca, ini: s, fim, canais: f.canais });
    return { semana: s, y: a.pctVoltouPessoa, yKai: a.pctVoltouKai, n: a.pessoaMaduros, nKai: a.kaiMaduros, parcial: fimSem > teto };
  });
  return { semanas, pontos };
}
// por agente (só fechamentos por pessoa): fechados, dias com fechamento, maduros, resolutivos, voltaram, FCR, mensagens
function fechamentoPorAgente(rows, f) {
  const acc = {};
  for (const l of cxFiltra(rows, f)) {
    const a = acc[l.agente_id] || (acc[l.agente_id] = { agente_id: l.agente_id, nome: l.agente_nome, marcas: new Set(), dias: new Set(), fechados: 0, maduros: 0, resolutivos: 0, voltaram: 0, voltaramHumano: 0, fcrBase: 0, fcr: 0, p50h: [], p50c: [] });
    a.nome = a.nome || l.agente_nome; a.marcas.add(l.marca);
    const n = (k) => Number(l[k] || 0);
    if (n("fechados")) a.dias.add(cxDia(l.dia));
    a.fechados += n("fechados"); a.maduros += n("maduros"); a.resolutivos += n("resolutivos"); a.voltaram += n("voltaram"); a.voltaramHumano += n("voltaram_humano");
    a.fcrBase += n("fcr_base"); a.fcr += n("fcr");
    a.p50h.push([Number(l.msgs_humanas_p50), n("fechados")]); a.p50c.push([Number(l.msgs_cliente_p50), n("fechados")]);
  }
  const pct = (x, b) => b >= CX_MIN_BASE ? (x / b) * 100 : null;
  return Object.values(acc).map((a) => ({ agente_id: a.agente_id, nome: a.nome, marcas: [...a.marcas], fechados: a.fechados, dias: a.dias.size,
    porDia: a.dias.size ? a.fechados / a.dias.size : null, maduros: a.maduros, resolutivos: a.resolutivos, voltaram: a.voltaram, voltaramHumano: a.voltaramHumano,
    pctResolutivo: pct(a.resolutivos, a.maduros), pctVoltou: pct(a.maduros - a.resolutivos, a.maduros), fcrBase: a.fcrBase, fcr: a.fcr, pctFcr: pct(a.fcr, a.fcrBase),
    msgsHumanasP50: medianaPonderada(a.p50h), msgsClienteP50: medianaPonderada(a.p50c), aproximado: a.p50h.length > 1 }))
    .sort((x, y) => y.fechados - x.fechados);
}

// ---------- tempo de resposta dentro da conversa (15/09): cx_resposta_dia / cx_resposta_agente_dia ----------
// Resposta humana logo depois de mensagem do cliente; espera desde a PRIMEIRA mensagem do cliente da sequência, em
// EXPEDIENTE. A 1ª resposta do ticket fica fora (é a fila, medida em cx_tempo). Meta do N1: mediana < 8 min.
const CX_META_RESPOSTA_SEG = 8 * 60;
function respostaAgg(rows, f) {
  const a = { respostas: 0, ate8: 0, ate30: 0 }; const p50c = [], p90c = [], p50r = [];
  for (const l of cxFiltra(rows, f)) {
    const n = Number(l.respostas || 0); if (!n) continue;
    a.respostas += n; a.ate8 += Number(l.ate_8min || 0); a.ate30 += Number(l.ate_30min || 0);
    p50c.push([Number(l.p50_comercial_seg), n]); p90c.push([Number(l.p90_comercial_seg), n]); p50r.push([Number(l.p50_relogio_seg), n]);
  }
  return Object.assign(a, { p50Comercial: medianaPonderada(p50c), p90Comercial: medianaPonderada(p90c), p50Relogio: medianaPonderada(p50r),
    pctAte8: a.respostas ? (a.ate8 / a.respostas) * 100 : null, pctAte30: a.respostas ? (a.ate30 / a.respostas) * 100 : null, aproximado: p50c.length > 1 });
}
function respostaPorAgente(rows, f) {
  const acc = {};
  for (const l of cxFiltra(rows, f)) {
    const n = Number(l.respostas || 0); if (!n) continue;
    const a = acc[l.agente_id] || (acc[l.agente_id] = { agente_id: l.agente_id, nome: l.agente_nome, marcas: new Set(), respostas: 0, ate8: 0, p50c: [], p50r: [] });
    a.nome = a.nome || l.agente_nome; a.marcas.add(l.marca); a.respostas += n; a.ate8 += Number(l.ate_8min || 0);
    a.p50c.push([Number(l.p50_comercial_seg), n]); a.p50r.push([Number(l.p50_relogio_seg), n]);
  }
  return Object.values(acc).map((a) => ({ agente_id: a.agente_id, nome: a.nome, marcas: [...a.marcas], respostas: a.respostas,
    p50Comercial: medianaPonderada(a.p50c), p50Relogio: medianaPonderada(a.p50r), pctAte8: a.respostas ? (a.ate8 / a.respostas) * 100 : null, aproximado: a.p50c.length > 1 }));
}

// ---------- fila agora (14/09): tickets abertos, um por linha (cx_fila) ----------
// segundos de expediente entre dois instantes (mesma regra do coletor: seg–qui 8h–18h SP)
function cxSegExpediente(iniUtc, fimUtc) {
  const a0 = new Date(iniUtc), b0 = new Date(fimUtc); if (!(b0 > a0)) return 0;
  const sp = (d) => new Date(d.getTime() - 3 * 3600 * 1000); const a = sp(a0), b = sp(b0);
  let total = 0; const d = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()));
  const fimDia = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()));
  let guarda = 0;
  while (d <= fimDia && guarda++ < 400) {
    if (!CX_DIAS_SEM_EXPEDIENTE.includes(d.getUTCDay())) {
      const ab = new Date(d); ab.setUTCHours(8, 0, 0, 0); const fe = new Date(d); fe.setUTCHours(18, 0, 0, 0);
      const ini = a > ab ? a : ab, fim = b < fe ? b : fe; if (fim > ini) total += (fim - ini) / 1000;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return Math.round(total);
}
function mediana(v) { const s = v.filter((x) => typeof x === "number").sort((a, b) => a - b); if (!s.length) return null; const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
// agora = Date (UTC). Esperando pessoa = transferido e sem resposta humana; com o Kai = aberto sem transferência.
function filaAgora(rows, marca, agora, canais) {
  const sel = (rows || []).filter((l) => (marca === "todas" || l.marca === marca) && (!canais || canais.includes(l.canal)));
  const esp = sel.filter((l) => l.escalado && !l.has_agent_reply).map((l) => Object.assign({}, l, { espera: cxSegExpediente(l.criado_em, agora), esperaRelogio: Math.round((agora - new Date(l.criado_em)) / 1000) }));
  esp.sort((x, y) => y.espera - x.espera);
  const idades = esp.map((x) => x.espera);
  return { total: sel.length, esperandoPessoa: esp.length, comPessoa: sel.filter((l) => l.has_agent_reply).length, comKai: sel.filter((l) => !l.escalado && !l.has_agent_reply).length,
    idadeMediana: mediana(idades), idadeP90: idades.length ? idades.slice().sort((a, b) => a - b)[Math.floor(0.9 * (idades.length - 1))] : null,
    maisDe1dia: esp.filter((x) => x.espera > 10 * 3600).length, maisDe1semana: esp.filter((x) => x.espera > 40 * 3600).length, top: esp.slice(0, 10) };
}
// ---------- séries no tempo para as abas (todas puras) ----------
// grupos de motivo para o gráfico (7 motivos viram 4 séries; cores fixas na tela)
const CX_GRUPOS_MOTIVO = [
  { k: "wismo", r: "Cadê meu pedido", motivos: ["wismo"] },
  { k: "pre-venda", r: "Pré-venda", motivos: ["pre-venda"] },
  { k: "resolucao", r: "Problema · troca · cancel.", motivos: ["problema", "troca", "cancelamento"] },
  { k: "outros", r: "Outros / sem tag", motivos: ["outros", "sem-tag"] },
];
// semanas (segunda) cobrindo [ini, fim]
function cxSemanas(ini, fim) {
  const out = []; let s = cxSegunda(ini);
  while (s <= fim) { out.push(s); const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 7); s = d.toISOString().slice(0, 10); }
  return out;
}
function cxDiasIntervalo(ini, fim) {
  const out = []; let d = ini;
  while (d <= fim) { out.push(d); const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); d = x.toISOString().slice(0, 10); }
  return out;
}
// contatos por 100 pedidos, por dia, por marca (todos os canais; dias sem pedido = null)
function serieDiariaPor100(csatRows, pedidos, marcas, ini, fim) {
  const dias = cxDiasIntervalo(ini, fim);
  const cont = {}, ped = {};
  for (const l of cxFiltra(csatRows, { marca: "todas", ini, fim })) { const k = l.marca + "|" + cxDia(l.dia); cont[k] = (cont[k] || 0) + Number(l.tickets || 0); }
  for (const p of pedidos || []) { const d = cxDia(p.dia); if (d < ini || d > fim || typeof p.pedidos !== "number") continue; ped[p.marca + "|" + d] = (ped[p.marca + "|" + d] || 0) + p.pedidos; }
  return { dias, series: marcas.map((m) => ({ marca: m, pontos: dias.map((d) => {
    const c = cont[m + "|" + d], pd = ped[m + "|" + d];
    return { dia: d, y: pd ? ((c || 0) / pd) * 100 : null, contatos: c || 0, pedidos: pd || null };
  }) })) };
}
// contatos por semana por grupo de motivo (só chat)
function serieSemanalMotivos(rows, f) {
  const semanas = cxSemanas(f.ini, f.fim);
  const sel = cxFiltra(rows, Object.assign({}, f, { canais: f.canais || CX_CANAIS_KAI }));
  const acc = {};
  for (const l of sel) { const s = cxSegunda(cxDia(l.dia)); const g = CX_GRUPOS_MOTIVO.find((x) => x.motivos.includes(l.motivo)) || CX_GRUPOS_MOTIVO[3]; acc[s + "|" + g.k] = (acc[s + "|" + g.k] || 0) + Number(l.tickets || 0); }
  return { semanas, series: CX_GRUPOS_MOTIVO.map((g) => ({ k: g.k, nome: g.r, valores: semanas.map((s) => acc[s + "|" + g.k] || 0) })) };
}
// CSAT por semana em três níveis (contagens) — para a barra 100%
function serieSemanalCsat3(rows, f) {
  const semanas = cxSemanas(f.ini, f.fim);
  const sel = cxFiltra(rows, Object.assign({}, f, { canais: f.canais || CX_CANAIS_KAI }));
  const acc = {};
  for (const l of sel) { const s = cxSegunda(cxDia(l.dia)); const a = acc[s] || (acc[s] = { ruim: 0, neutro: 0, bom: 0, tickets: 0 }); a.ruim += Number(l.ruim || 0); a.neutro += Number(l.neutro || 0); a.bom += Number(l.bom || 0); a.tickets += Number(l.tickets || 0); }
  const g = (k) => semanas.map((s) => (acc[s] ? acc[s][k] : 0));
  return { semanas, ruim: g("ruim"), neutro: g("neutro"), bom: g("bom"), tickets: g("tickets"),
    pctBom: semanas.map((s) => { const a = acc[s]; const n = a ? a.ruim + a.neutro + a.bom : 0; return n >= CX_MIN_BASE ? (a.bom / n) * 100 : null; }) };
}
// Kai resolve sozinho por semana (cx_desfecho: resolvido_kai ÷ (resolvido_kai + escalado), sem e-mail)
function serieSemanalKai(desfecho, marca, ini, fim) {
  const semanas = cxSemanas(ini, fim); const acc = {};
  for (const l of desfecho || []) {
    const d = cxDia(l.dia); if (d < ini || d > fim || l.canal === "email") continue;
    if (marca !== "todas" && l.marca !== marca) continue;
    const s = cxSegunda(d); const a = acc[s] || (acc[s] = { kai: 0, esc: 0 }); a.kai += Number(l.resolvido_kai || 0); a.esc += Number(l.escalado || 0);
  }
  return { semanas, pontos: semanas.map((s) => { const a = acc[s]; const t = a ? a.kai + a.esc : 0; return { semana: s, y: t >= CX_MIN_BASE ? (a.kai / t) * 100 : null, n: t }; }) };
}
// NPS por semana por marca (votos: {marca:'aristo'|'fish'|'olivas', score, bucket, data})
function serieSemanalNps(votos, marcas, ini, fim, mapaMarca) {
  const semanas = cxSemanas(ini, fim); const acc = {};
  for (const v of votos || []) {
    const m = (mapaMarca && mapaMarca[v.marca]) || v.marca;
    const d = new Date(new Date(v.data).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    if (d < ini || d > fim) continue;
    const s = cxSegunda(d); const a = acc[m + "|" + s] || (acc[m + "|" + s] = { n: 0, prom: 0, detr: 0 });
    a.n++; if (v.bucket === "promotor") a.prom++; if (v.bucket === "detrator") a.detr++;
  }
  return { semanas, series: marcas.map((m) => ({ marca: m, pontos: semanas.map((s) => { const a = acc[m + "|" + s]; return { semana: s, y: a && a.n >= 10 ? Math.round(((a.prom - a.detr) / a.n) * 100) : null, n: a ? a.n : 0 }; }) })) };
}
// comentários por semana: total, respondidos pela marca, sentimento (social: linhas por marca × rede × dia)
function serieSemanalSocial(social, marca, ini, fim) {
  const semanas = cxSemanas(ini, fim); const acc = {};
  for (const l of social || []) {
    const d = cxDia(l.dia); if (d < ini || d > fim) continue; if (marca !== "todas" && l.marca !== marca) continue;
    const s = cxSegunda(d); const a = acc[s] || (acc[s] = { total: 0, respondidos: 0, pos: 0, neg: 0, neu: 0 });
    a.total += Number(l.total || 0); a.respondidos += Number(l.respondidos || 0); a.pos += Number(l.pos || 0); a.neg += Number(l.neg || 0); a.neu += Number(l.neu || 0);
  }
  const g = (k) => semanas.map((s) => (acc[s] ? acc[s][k] : 0));
  return { semanas, total: g("total"), respondidos: g("respondidos"), semResposta: semanas.map((s) => (acc[s] ? Math.max(0, acc[s].total - acc[s].respondidos) : 0)), pos: g("pos"), neg: g("neg"), neu: g("neu") };
}
// Reclame Aqui no tempo: uma linha por (marca, dia)
function serieRa(rows, marcas, campo) {
  const dias = [...new Set((rows || []).map((r) => cxDia(r.dia)))].sort();
  return { dias, series: marcas.map((m) => ({ marca: m, pontos: dias.map((d) => { const r = (rows || []).find((x) => x.marca === m && cxDia(x.dia) === d); return { dia: d, y: r && r[campo] !== null && r[campo] !== undefined ? Number(r[campo]) : null }; }) })) };
}

// contatos por 100 pedidos, por SEMANA, por marca (dia a dia oscila com o fim de semana: poucos pedidos, mesma fila)
function serieSemanalPor100(csatRows, pedidos, marcas, ini, fim) {
  const semanas = cxSemanas(ini, fim); const cont = {}, ped = {};
  for (const l of cxFiltra(csatRows, { marca: "todas", ini, fim })) { const k = l.marca + "|" + cxSegunda(cxDia(l.dia)); cont[k] = (cont[k] || 0) + Number(l.tickets || 0); }
  for (const p of pedidos || []) { const d = cxDia(p.dia); if (d < ini || d > fim || typeof p.pedidos !== "number") continue; const k = p.marca + "|" + cxSegunda(d); ped[k] = (ped[k] || 0) + p.pedidos; }
  return { semanas, series: marcas.map((m) => ({ marca: m, pontos: semanas.map((s) => { const c = cont[m + "|" + s], pd = ped[m + "|" + s]; return { semana: s, y: pd ? ((c || 0) / pd) * 100 : null, contatos: c || 0, pedidos: pd || null }; }) })) };
}
// corta semanas iniciais sem nenhum dado (a API devolve 120 dias, mas cx_ticket começa em 16/07)
function cxCortaVazioInicial(semanas, colunas) {
  let i = 0; while (i < semanas.length - 1 && colunas.every((c) => !(c[i] > 0))) i++;
  return { semanas: semanas.slice(i), colunas: colunas.map((c) => c.slice(i)) };
}

if (typeof module !== "undefined") {
  module.exports = { CX_MIN_BASE, CX_MOTIVOS, CX_ROTULO_MOTIVO, CX_CANAIS_KAI, CX_RA1000,
    cxFiltra, csatAgg, csatKaiVsPessoa, porMotivo, serieCsatSemanal, cxSegunda,
    somaPedidos, contatosPorPedido, raUltimo, raAvalia, raPendentes, raPeriodo, cxDelta, cxDiasComDado,
    CX_GRUPOS_MOTIVO, cxSemanas, cxDiasIntervalo, serieDiariaPor100, serieSemanalMotivos, serieSemanalCsat3, serieSemanalKai, filaAgora, cxSegExpediente, mediana, tempoAgg, serieDiariaTempo, tempoPorAgente, medianaPonderada, fechamentoAgg, fechamentoPorAgente, serieSemanalVolta, cxFimMaduroVolta, CX_VOLTA_DIAS, respostaAgg, respostaPorAgente, CX_META_RESPOSTA_SEG, desfechoMaduro, serieSemanalDesfecho, cxFimMaduro, cxEhExpediente, CX_MATURACAO_DIAS, CX_DIAS_SEM_EXPEDIENTE, serieSemanalNps, serieSemanalSocial, serieRa, serieSemanalPor100, cxCortaVazioInicial };
}
