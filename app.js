// ================== RENDER ==================
// Hierarquia de decisão: alertas → 4 KPIs grandes → marcas lado a lado → pessoas/NPS.
// Toda a matemática vive em dados.js. URL params: ?marca=aristocrata&janela=7d

const estado = {
  corteCX: "classe",   // corte do bloco de detalhe: classe|caixa|esforco
  marca: new URLSearchParams(location.search).get("marca") || "todas",
  preset: (() => {
    const q = new URLSearchParams(location.search);
    const mapaAntigo = { dia: "hoje", "7d": "7d", "30d": "30d" };
    // Padrão: últimos 7 dias. "Hoje" é dia em andamento (ticket ainda sem nota e sem motivo) e
    // distorce os seis números; a fila e o saldo de hoje continuam visíveis na Operação.
    return q.get("periodo") || mapaAntigo[q.get("janela")] || "7d";
  })(), // hoje|ontem|7d|30d|mes|mes-1|custom
  ini: null, fim: null,          // resolvidos em resolverPeriodo()
  comparar: true,
  compAuto: true, cIni: null, cFim: null,
  agente: "todos",
  dados: null,
};
// Semana comeca na SEGUNDA (convencao BR). getUTCDay da 0 no domingo, entao domingo vira 6.
// Mesma regra usada em growth.html e influs.html - os tres paineis tem que concordar
// sobre o que e "esta semana", senao o mesmo numero muda de painel para painel.
function segundaDe(ymd) {
  const d = new Date(ymd + "T12:00:00Z");
  return diasAtras((d.getUTCDay() + 6) % 7, ymd);
}
function resolverPeriodo(hoje) {
  const p = estado.preset;
  let ini, fim, rotulo;
  if (p === "hoje") { ini = fim = hoje; rotulo = "hoje"; }
  else if (p === "ontem") { ini = fim = diasAtras(1, hoje); rotulo = "ontem"; }
  else if (p === "semana") { ini = segundaDe(hoje); fim = hoje; rotulo = "esta semana"; }
  else if (p === "semana-1") {
    const seg = segundaDe(hoje);
    ini = diasAtras(7, seg); fim = diasAtras(1, seg); rotulo = "semana passada";
  }
  else if (p === "7d") { ini = diasAtras(7, hoje); fim = diasAtras(1, hoje); rotulo = "últimos 7 dias"; }
  else if (p === "30d") { ini = diasAtras(30, hoje); fim = diasAtras(1, hoje); rotulo = "últimos 30 dias"; }
  else if (p === "mes") { ini = hoje.slice(0, 8) + "01"; fim = hoje; rotulo = "este mês (parcial)"; }
  else if (p === "mes-1") {
    const d1 = new Date(hoje.slice(0, 8) + "01T12:00Z"); d1.setUTCMonth(d1.getUTCMonth() - 1);
    ini = d1.toISOString().slice(0, 8) + "01";
    const dfim = new Date(hoje.slice(0, 8) + "01T12:00Z"); dfim.setUTCDate(0);
    fim = dfim.toISOString().slice(0, 10); rotulo = "mês passado";
  } else { // custom
    ini = estado.ini || hoje; fim = estado.fim || hoje;
    if (ini > fim) [ini, fim] = [fim, ini];
    rotulo = ini === fim ? fmtDia(ini) : fmtDia(ini) + " – " + fmtDia(fim);
  }
  estado.ini = ini; estado.fim = fim;
  const auto = rangeAnterior(ini, fim);
  const cIni = estado.compAuto ? auto.ini : (estado.cIni || auto.ini);
  const cFim = estado.compAuto ? auto.fim : (estado.cFim || auto.fim);
  const rotComp = estado.compAuto ? "vs período anterior" : "vs " + fmtDia(cIni) + " – " + fmtDia(cFim);
  return { ini, fim, cIni, cFim, rotulo, rotComp };
}
function fmtDia(ymd) { return ymd.slice(5).split("-").reverse().join("/"); }

const CORES_HEX = { aristocrata: "#b9822d", fishermans: "#22808d", olivas: "#6f7f33", todas: "#55524c" };
const corHex = (m) => CORES_HEX[m] || CORES_HEX.todas;
const $ = (s) => document.querySelector(s);

// ---------- chave de acesso ----------
// A API exige ?k=<chave>. A chave fica só neste dispositivo (localStorage),
// nunca no código. Errou a chave → a API devolve 401 e o painel pede de novo.
function chave() { return shrigmaChave("cx"); }
function pedeChave(erro) {
  if ($("#gate")) { $("#gate .gate-erro").textContent = erro || ""; return; }
  const div = document.createElement("div");
  div.id = "gate";
  div.innerHTML = `<form class="gate-card">
      <h2>Painel CX · Grupo Shrigma</h2>
      <p>Digite a chave de acesso do time.</p>
      <input type="password" autofocus autocomplete="current-password" aria-label="Chave de acesso">
      <button type="submit">Entrar</button>
      <p class="gate-erro">${erro || ""}</p>
    </form>`;
  document.body.appendChild(div);
  div.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    shrigmaGuardaChave("cx", div.querySelector("input").value.trim());
    div.remove();
    carrega();
  });
}

// ---------- carga ----------
const CX_CACHE_MAX_MS = 20 * 60 * 1000; // duas geracoes esperadas do cache (10 min)
let CX_CARREGANDO = false;
function payloadCXValido(p) {
  return p && (!p._escopo || p._escopo === 'cx') &&
    ['snapshot_1d', 'janelas', 'agentes_1d', 'agentes_janelas'].every(k => Array.isArray(p[k]));
}
function cacheCXValido(p, agora = Date.now()) {
  const t = Date.parse(p && p.gerado_em || '');
  return payloadCXValido(p) && Number.isFinite(t) && agora - t >= -60000 && agora - t <= CX_CACHE_MAX_MS;
}
async function consultaCX(url, timeoutMs) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    return { response, payload: response.ok ? await response.json() : null };
  } finally { clearTimeout(timer); }
}
async function carrega() {
  if (CX_CARREGANDO) return;
  if (!chave()) { pedeChave(); return; }
  CX_CARREGANDO = true;
  try {
    // 1º o cache (payload pronto, montado a cada 10 min, < 1 s); se ele falhar, a API viva com &painel=cx
    // (com a chave-mestra, sem &painel= a API montava os quatro painéis, ~40 s de Postgres, e descartava três).
    let dados = null, r = null;
    if (typeof CX_CACHE_URL === "string" && CX_CACHE_URL) {
      try {
        const leitura = await consultaCX(CX_CACHE_URL + "?k=" + encodeURIComponent(chave()), 8000);
        r = leitura.response;
        if (r.ok && cacheCXValido(leitura.payload)) dados = leitura.payload;
      } catch (e) { dados = null; }
    }
    if (!dados && !(r && (r.status === 401 || r.status === 403))) {
      const leitura = await consultaCX(CX_API_URL + "?k=" + encodeURIComponent(chave()) + "&painel=cx", 45000);
      r = leitura.response;
      if (r.ok && payloadCXValido(leitura.payload)) dados = leitura.payload;
    }
    if (r && (r.status === 401 || r.status === 403)) {
      shrigmaEsqueceChave("cx");
      pedeChave("Chave incorreta — tente de novo.");
      return;
    }
    if (!dados) throw new Error("HTTP " + (r ? r.status : "sem resposta"));
    estado.dados = dados;
    shrigmaMarcaMestra(chave(), (estado.dados || {})._painel);
    pinta();
  } catch (e) {
    $("#faixa-alertas").innerHTML =
      `<div class="erro-carga">Sem dados agora (${e.message}). Nova tentativa em ${CX_REFRESH_SEG}s — se persistir, confira o workflow “CX — Dashboard · API de leitura” no n8n.</div>`;
  } finally { CX_CARREGANDO = false; }
}

function hojeRef() {
  const s = estado.dados.snapshot_1d;
  return s.length ? s[s.length - 1].dia : new Date().toISOString().slice(0, 10);
}

// ---------- pintura ----------
let PER = null; // período resolvido do render atual
function pinta() {
  const d = estado.dados;
  const hoje = hojeRef();
  PER = resolverPeriodo(hoje);
  const porMarca = {};
  const lenComp = diffDias(PER.cIni, PER.cFim) + 1;
  for (const m of MARCAS) {
    let anterior = estado.comparar ? agregaRange(d, m, PER.cIni, PER.cFim, hoje) : null;
    // honestidade: se o período de comparação não tem histórico suficiente no banco,
    // não comparamos — % contra dado parcial é mentira com casas decimais.
    if (anterior && lenComp > 1 && (anterior.dias || 0) < lenComp * 0.8) anterior = { __semHistorico: true };
    porMarca[m] = {
      atual: agregaRange(d, m, PER.ini, PER.fim, hoje),
      anterior,
      rotuloComp: estado.comparar ? PER.rotComp : "",
    };
  }
  const porMarcaCons = {};
  for (const m of MARCAS) porMarcaCons[m] = {
    atual: porMarca[m].atual,
    anterior: porMarca[m].anterior && porMarca[m].anterior.__semHistorico ? null : porMarca[m].anterior,
    rotuloComp: porMarca[m].rotuloComp,
  };
  const grupo = consolida(porMarcaCons);
  if (grupo && estado.comparar && !grupo.anterior) grupo.anterior = { __semHistorico: true };
  const escopo = estado.marca === "todas" ? grupo : porMarca[estado.marca];

  pintaFrescor(d);
  pintaAlertas(porMarca, d);
  // pintaDesfecho resolve PER_DESF (o periodo que realmente tem desfecho); os cartoes de Kai
  // leem esse mesmo recorte -- por isso vem antes.
  pintaDesfecho(d);
  // abas (cx-tela.js): cartoes de tres camadas → um grafico, uma tabela. Tudo e pintado sempre.
  pintaSeisNumeros(d);
  pintaMotivos(d);
  pintaChat(d, escopo, porMarca);
  pintaWismoSituacao(d);
  pintaRanking(d, hoje);
  pintaRaAba(d);
  pintaNpsAba(d);
  pintaNps(d, hoje);
  pintaFrustracoes(d);
  pintaSocialAba(d);
  pintaSocial(d);
  pintaTrocasAba(d);
  pintaConcessaoAba(d);
  $("#rotulo-janela").textContent = PER.rotulo;
  $("#btn-periodo").innerHTML = PER.rotulo.charAt(0).toUpperCase() + PER.rotulo.slice(1) + ' <span class="caret">▾</span>';
}

function pintaFrescor(d) {
  const el = $("#frescor");
  if (!dentroDoExpediente()) { el.textContent = "coleta retoma às 06h"; el.classList.remove("velho"); return; }
  // frescor.js: idade do bloco mais fresco + alerta se qualquer bloco parou (>26h)
  // limiteFrescoMin 40: snapshot do Gleap a cada 30 min + cache do payload a cada 10 min
  shrigmaFrescor(d, el, { limiteFrescoMin: 40, nomes: { snapshot_1d: "Gleap", agentes_1d: "Gleap agentes", cx_csat: "tickets Gleap", cx_fila: "fila Gleap", cx_tempo: "tempos Gleap", cx_fechamento: "fechamentos", cx_resposta: "respostas", cx_ra: "Reclame Aqui", cx_troca: "Troque", cx_concessao: "ClickUp", cx_pedidos: "Shopify", cx_despacho: "despacho Shopify", wa_saude: "WhatsApp", janelas: "janelas Gleap" } });
}

// alertas: sempre sobre AGORA/HOJE, independente do período selecionado na tela
function dentroDoExpediente() {
  const sp = new Date(Date.now() - 3 * 3600 * 1000);
  const h = sp.getUTCHours();
  return h >= 6 && h < 23; // janela do coletor (06–23h SP)
}
function pintaAlertas(_, d) {
  const avisos = [];
  const hoje = hojeRef();
  const ult = d.snapshot_1d.map((l) => l.coletado_em).sort().pop();
  if (ult && Date.now() - new Date(ult).getTime() > 25 * 60000 && dentroDoExpediente())
    avisos.push("Coleta atrasada — painel pode estar defasado.");
  for (const m of MARCAS) {
    const a = agregaRange(d, m, hoje, hoje, hoje);
    if (!a) continue;
    if (typeof a.primeira_resposta_seg === "number" && a.primeira_resposta_seg > 12 * 3600)
      avisos.push(`${ROTULOS[m]} com 1ª resposta em ${fmtDur(a.primeira_resposta_seg)} hoje.`);
    // CSAT em três níveis: alerta quando 'ruim' passa de 30% com base mínima (cx_csat, só chat)
    const cs = csatAgg(d.cx_csat || [], { marca: m, ini: hoje, fim: hoje, canais: CX_CANAIS_KAI });
    if (cs.baseOk && cs.pctRuim >= 30)
      avisos.push(`${ROTULOS[m]}: ${Math.round(cs.pctRuim)}% de CSAT ruim hoje (${fmtNum(cs.ruim)} de ${fmtNum(cs.avaliadas)}).`);
  }
  $("#faixa-alertas").innerHTML = avisos.length
    ? `<div class="alerta">⚠ ${avisos.join("  ·  ")}</div>` : "";
}

function chipHtml(metrica, atual, anterior, fmt) {
  if (!estado.comparar) return "";
  const dl = delta(metrica, atual, anterior);
  if (!dl.texto) return "";
  const ant = typeof anterior === "number" ? " · ant. " + (fmt || fmtNum)(anterior) : "";
  return `<span class="chip ${dl.classe}">${dl.texto}${ant}</span>`;
}
// contagens acumuladas do dia comparam com ontem ATÉ A MESMA HORA (estilo Shopify);
// taxas e tempos (CSAT, 1ª resposta, deflexão, fila) comparam com o dia anterior inteiro.
const METRICAS_ACUMULADAS = ["novos", "fechados", "trabalhados", "respostas"];
function mesmaHoraAgora() {
  const sp = new Date(Date.now() - 3 * 3600 * 1000);
  return sp.getUTCHours() * 60 + sp.getUTCMinutes();
}
// devolve {valor, mesmaHora:boolean} para comparar uma métrica no modo "hoje"
function anteriorProgressivo(metrica, marca, antCheio) {
  const base = antCheio ? antCheio[metrica] : null;
  if (!(PER.ini === PER.fim && estado.comparar)) return { valor: base, mesmaHora: false };
  if (!METRICAS_ACUMULADAS.includes(metrica)) return { valor: base, mesmaHora: false };
  const v = valorMesmaHora(estado.dados.intradia, marca, PER.cIni, metrica, mesmaHoraAgora());
  return v === null ? { valor: null, mesmaHora: false, cheio: base } : { valor: v, mesmaHora: true, cheio: base };
}

/* Desfecho do ticket: cinco estados exclusivos que somam 100%.
   Substitui a deflexão do Gleap, que mentia em três camadas empilhadas:
     1. denominador só com conversas em que o Kai chegou a um veredito (exclui 56%
        dos tickets no Aristocrata);
     2. ticket ainda aberto contado como sucesso;
     3. ticket em que o Kai prometeu humano e ninguém veio, também contado como
        sucesso -- 306 no Aristocrata na janela medida.
   Resultado: o Gleap dizia 73,4%; a resolução real do Kai sozinho é 25,9%.
   Base pequena não vira percentual: abaixo de 30 encerrados mostra contagem. */
const MIN_BASE = 30;
let PER_DESF = { ini: "0000-00-00", fim: "9999-99-99" };

/* Tres cortes do mesmo dado, um de cada vez. Painel separado para cada um daria
   quatro blocos empilhados dizendo a mesma coisa por angulos diferentes -- e o
   problema do painel de organico que a gente acabou de desfazer. */
const CORTES = {
  desfecho: { rot: "Desfecho",
    seg: [
      { k: "resolvido_kai",  r: "Kai resolve",    c: "d-kai"  },
      { k: "escalado",       r: "Escalou",        c: "d-esc"  },
      { k: "promessa_vazia", r: "Promessa vazia", c: "d-prom" },
      { k: "inatividade",    r: "Abandonou",      c: "d-inat" },
      { k: "pendente",       r: "Pendente",       c: "d-pend" },
    ], destaque: "resolvido_kai" },
  classe: { rot: "Classificação",
    seg: [
      { k: "nunca_outros",     r: "Acertou de primeira", c: "d-kai"  },
      { k: "outros_corrigido", r: "Errou e corrigiu",    c: "d-esc"  },
      { k: "so_outros",        r: "Só 'outros'",         c: "d-prom" },
    ], destaque: "so_outros", inverso: true },
  caixa: { rot: "Caixa",
    seg: [
      { k: "pend_cliente", r: "Cliente falou por último", c: "d-prom" },
      { k: "pend_bot",     r: "Bot falou por último",     c: "d-esc"  },
      { k: "pend_agente",  r: "Agente participou",        c: "d-kai"  },
      { k: "pend_vazio",   r: "Ticket vazio",             c: "d-pend" },
    ], destaque: "pend_cliente", inverso: true },
};
const CAMPOS = [...new Set(Object.values(CORTES).flatMap((c) => c.seg.map((s) => s.k)))]
  .concat(["csat_enviado", "escalado_sem_resposta"]);

function desfechoAgg(d, marca, ini, fim) {
  const acc = {};
  for (const l of (d.cx_desfecho || [])) {
    const dia = String(l.dia).slice(0, 10);
    if (dia < ini || dia > fim) continue;
    if (marca !== "todas" && l.marca !== marca) continue;
    const a = acc[l.canal] || (acc[l.canal] = { canal: l.canal, tickets: 0 });
    a.tickets += Number(l.tickets || 0);
    for (const k of CAMPOS) a[k] = (a[k] || 0) + Number(l[k] || 0);
  }
  return Object.values(acc).sort((x, y) => y.tickets - x.tickets);
}


/* Esforco do Kai quando ele falha. Nao e barra empilhada: sao dois numeros por
   canal, e forcar barra aqui seria grafico enfeitando numero.
   "turnos" e ambiguo -- pode ser mensagem ou troca. O que esta medido e MENSAGEM do
   Kai (BOT + BOT_REPLY) antes do primeiro humano; uma unica resposta do Kai costuma
   sair como 1 BOT_REPLY e 2 BOT. O rotulo diz mensagens, nao turnos. */
function esforcoAgg(d, marca, ini, fim) {
  const acc = {};
  for (const l of (d.cx_esforco || [])) {
    const dia = String(l.dia).slice(0, 10);
    if (dia < ini || dia > fim) continue;
    if (marca !== "todas" && l.marca !== marca) continue;
    const a = acc[l.canal] || (acc[l.canal] = { canal: l.canal, esc: 0, comKai: 0, som: 0 });
    const n = Number(l.escalados || 0);
    a.esc += n; a.comKai += Number(l.com_kai_antes || 0);
    // Mediana de medianas nao existe: pondera a mediana do dia pelo volume do dia.
    if (l.turnos_mediana !== null && l.turnos_mediana !== undefined) a.som += Number(l.turnos_mediana) * n;
  }
  return Object.values(acc).sort((x, y) => y.esc - x.esc);
}

function reaberturaAgg(d, marca, ini, fim) {
  let reab = 0, hum = 0;
  for (const l of (d.cx_reabertura || [])) {
    const dia = String(l.dia).slice(0, 10);
    if (dia < ini || dia > fim) continue;
    if (marca !== "todas" && l.marca !== marca) continue;
    reab += Number(l.reabertos || 0); hum += Number(l.com_humano || 0);
  }
  return { reab, hum };
}

function pintaDesfecho(d) {
  const faixa = $("#desfecho-faixa");
  let canais = desfechoAgg(d, estado.marca, PER.ini, PER.fim);
  let aviso = "";

  /* O desfecho vem da consolidacao, que fecha o dia anterior: pedir "hoje" antes dela
     rodar devolve vazio. Em vez de sumir com o painel, cai para o ultimo dia que
     existe e DIZ que caiu. */
  if (!canais.length) {
    const dias = (d.cx_desfecho || [])
      .filter((l) => estado.marca === "todas" || l.marca === estado.marca)
      .map((l) => String(l.dia).slice(0, 10)).sort();
    if (!dias.length) {
      $("#desfecho-rot").textContent = "";
      if (faixa) faixa.innerHTML = "";
      $("#area-desfecho").innerHTML = `<div class="vazio">Sem desfecho coletado ainda.
        A consolidação roda 01:15 e fecha o dia anterior.</div>`;
      return;
    }
    const ate = dias[dias.length - 1];
    const de = dias.find((x) => x >= new Date(new Date(ate + "T12:00:00Z").getTime()
      - 29 * 864e5).toISOString().slice(0, 10)) || dias[0];
    canais = desfechoAgg(d, estado.marca, de, ate);
    const br = (x) => x.slice(8, 10) + "/" + x.slice(5, 7);
    aviso = `<span class="tag alerta">período sem dado — mostrando ${br(de)} a ${br(ate)}</span>`;
    PER_DESF = { ini: de, fim: ate };
  } else {
    PER_DESF = { ini: PER.ini, fim: PER.fim };
  }

  /* O Kai NAO roda em e-mail (zero mensagem dele em 246 tickets/30d). Pela transferencia
     e-mail da 0% "Kai sozinho" porque o roteamento sempre atribui time -- mostrar isso
     como desempenho do Kai seria nota para quem nunca jogou. E-mail sai das cifras e da
     lista e vai para o rodape, com a contagem. */
  const email = canais.find((x) => x.canal === "email");
  canais = canais.filter((x) => x.canal !== "email");
  const tot = canais.reduce((a, x) => {
    a.tickets += x.tickets;
    for (const k of CAMPOS) a[k] = (a[k] || 0) + (x[k] || 0);
    return a;
  }, { canal: "todos", tickets: 0 });

  /* Duas linhas, uma pergunta: o que o Kai fechou sozinho e o que caiu no colo do
     agente. O denominador e o ticket que JA TEVE DESFECHO. Aberto, abandonado e
     promessa vazia ficam fora e aparecem como rodape -- contar isso como vitoria do
     Kai foi exatamente o erro da taxa do Gleap. */
  const decid = (x) => (x.resolvido_kai || 0) + (x.escalado || 0);
  const semDesfecho = (x) => (x.promessa_vazia || 0) + (x.inatividade || 0) + (x.pendente || 0);

  /* Ticket ainda aberto e "pendente" e fica fora do denominador; nos ultimos ~2 dias
     essa fatia e grande e o numero ainda vai andar. */
  const limite = new Date(Date.now() - 48 * 3600 * 1000).toISOString().slice(0, 10);
  const imaturos = (d.cx_desfecho || []).filter((l) => {
    const dia = String(l.dia).slice(0, 10);
    return dia >= PER_DESF.ini && dia <= PER_DESF.fim && dia > limite
      && (estado.marca === "todas" || l.marca === estado.marca);
  }).reduce((a, l) => a + Number(l.tickets || 0), 0);
  const fatia = tot.tickets ? imaturos / tot.tickets : 0;
  const selo = fatia > 0.15
    ? `<span class="tag alerta" title="Ticket ainda aberto conta como pendente e fica fora do denominador; nos últimos ~2 dias essa fatia é grande e o número ainda vai andar">${
        Math.round(fatia * 100)}% do período ainda maturando</span>` : "";
  /* O aviso vira etiqueta no cabecalho, nao paragrafo: a tabela e para bater o olho.
     Desde 02/09 "vai para agente" e medido pela TRANSFERENCIA (processingTeam ou
     processingUser), nao por quem respondeu. Ticket que o Kai passou e ninguem respondeu
     e do agente, nao do Kai. Antes disso o painel dava 30,9%; o certo era 19,8%. */
  $("#desfecho-rot").innerHTML = `${fmtNum(tot.tickets)} tickets ${aviso} ${selo}
    <span class="tag nota" title="Escalado = ticket transferido para time ou agente (processingTeam/processingUser), não 'quem respondeu'. Corrigido em 02/09: o critério anterior dava 30,9% ao Kai; o real era 19,8%.">por transferência</span>`;

  const dTot = decid(tot);
  const linha = (x, nome) => {
    const dd = decid(x);
    if (!dd) return "";
    /* Tres destinos exclusivos do ticket decidido: Kai resolveu; pessoa respondeu e
       fechou; transferido e fechado SEM resposta humana (a regua fechou na fila). Antes
       os dois ultimos eram um so "agente", e o time levava credito pelo que ninguem fez. */
    const pk = ((x.resolvido_kai || 0) / dd) * 100;
    const psr = ((x.escalado_sem_resposta || 0) / dd) * 100;
    const pp = Math.max(0, 100 - pk - psr);
    return `<div class="k-linha">
      <div class="k-nome">${nome}<span class="mini">${fmtNum(dd)} com desfecho</span></div>
      <div class="k-barra">
        <i class="d-kai" style="width:${pk}%" title="Kai resolveu"></i><i class="d-esc" style="width:${pp}%" title="pessoa respondeu e fechou"></i><i class="d-semresp" style="width:${psr}%" title="transferido e fechado sem resposta humana"></i>
      </div>
      <div class="k-num"><strong class="tabn">${fmtPct(pk)}</strong>
        <span class="mini">Kai</span></div>
      <div class="k-num"><strong class="tabn">${fmtPct(pp)}</strong>
        <span class="mini">pessoa</span></div>
      <div class="k-num"><strong class="tabn ${psr >= 10 ? "vm" : ""}">${fmtPct(psr)}</strong>
        <span class="mini">ninguém</span></div>
    </div>`;
  };

  const kTopo = (dTot
      ? `<div class="k-topo">
           <div><span class="k-rot">Kai resolve sozinho</span>
             <strong class="k-big tabn">${fmtPct(((tot.resolvido_kai || 0) / dTot) * 100)}</strong></div>
           <div><span class="k-rot">Pessoa resolve</span>
             <strong class="k-big tabn">${fmtPct((((tot.escalado || 0) - (tot.escalado_sem_resposta || 0)) / dTot) * 100)}</strong></div>
           <div title="Transferido para time ou agente e fechado sem nenhuma resposta pública de pessoa: a régua fechou na fila."><span class="k-rot">Transferido, ninguém respondeu</span>
             <strong class="k-big tabn ${(tot.escalado_sem_resposta || 0) / dTot >= 0.1 ? "vm" : ""}">${fmtPct(((tot.escalado_sem_resposta || 0) / dTot) * 100)}</strong></div>
         </div>` : "");
  const kCanais = canais.map((x) => linha(x, x.canal)).join("")
    + `<div class="k-rodape mini">${fmtNum(semDesfecho(tot))} sem desfecho, fora da conta${
        email ? ` · ${fmtNum(email.tickets)} por e-mail, fora: o Kai não roda lá` : ""}</div>`;
  if (faixa) { faixa.innerHTML = kTopo; $("#area-desfecho").innerHTML = kCanais; }
  else $("#area-desfecho").innerHTML = kTopo + kCanais;

  pintaDetalhe(d, canais, tot);
}

/* Tudo que nao e a pergunta principal vive aqui dentro, fechado. */
function pintaDetalhe(d, canais, tot) {
  const alvo = $("#area-detalhe");
  if (!alvo) return;
  const { reab, hum } = reaberturaAgg(d, estado.marca, PER_DESF.ini, PER_DESF.fim);
  const wa = canais.find((c) => c.canal === "whatsapp");
  const cobertura = wa && wa.tickets ? (wa.csat_enviado / wa.tickets) * 100 : null;
  const fora = canais.filter((c) => c.canal !== "whatsapp").reduce((a, c) => a + c.tickets, 0);
  $("#tiras-cx").innerHTML = `<div class="tiras">
    <div class="tira" title="cx_reabertura_dia NÃO é reabertura: é ticket criado ANTES do período com atividade DENTRO dele (volume que não entra em 'novos' e consome atendente). Reabertura de verdade — cliente voltou depois do fechamento — está no cartão 'Voltou em 7 dias' da aba Chat e na tabela por agente."><span class="tira-rot">Ativos de antes do período</span>
      <strong class="tabn">${fmtNum(reab)}</strong>
      <span class="mini">${reab ? Math.round((hum / reab) * 100) : 0}% com humano</span></div>
    <div class="tira"><span class="tira-rot">CSAT coberto</span>
      <strong class="tabn">${cobertura === null ? "—" : fmtPct(cobertura)}</strong>
      <span class="mini">só WhatsApp · ${fmtNum(fora)} fora</span></div>
  </div>`;

  if (estado.corteCX === "esforco") {
    const linhas = esforcoAgg(d, estado.marca, PER_DESF.ini, PER_DESF.fim).filter((x) => x.esc);
    const t = linhas.reduce((a, x) => ({ esc: a.esc + x.esc, comKai: a.comKai + x.comKai,
                                         som: a.som + x.som }), { esc: 0, comKai: 0, som: 0 });
    const linha = (x, nome) => `<div class="d-linha esf">
      <div class="d-nome">${nome}<span class="mini">${fmtNum(x.esc)} escalados</span></div>
      <div class="esf-num"><strong class="tabn ${x.comKai / x.esc > 0.5 ? "vm" : ""}">${
        fmtPct((x.comKai / x.esc) * 100)}</strong><span class="mini">passaram pelo Kai antes</span></div>
      <div class="esf-num"><strong class="tabn">${(x.som / x.esc).toFixed(1).replace(".", ",")}</strong>
        <span class="mini">mensagens do Kai antes</span></div></div>`;
    alvo.innerHTML = (t.esc ? linha(t, "<strong>Todos os canais</strong>") : "")
      + linhas.map((x) => linha(x, x.canal)).join("");
    return;
  }

  const corte = CORTES[estado.corteCX] || CORTES.classe;
  const base = (x) => corte.seg.reduce((a, { k }) => a + (x[k] || 0), 0);
  const barra = (x, nome) => {
    const b = base(x);
    if (!b) return "";
    const seg = corte.seg.map(({ k, c, r }) => {
      const v = x[k] || 0;
      return v ? `<i class="${c}" style="width:${(v / b) * 100}%" title="${r}: ${fmtNum(v)}"></i>` : "";
    }).join("");
    return `<div class="d-linha">
      <div class="d-nome">${nome}<span class="mini">${fmtNum(b)}</span></div>
      <div class="d-barra">${seg}</div>
      <div class="d-val tabn ${corte.inverso ? "vm" : ""}">${b < MIN_BASE
        ? `<span class="mini">base curta</span>` : fmtPct(((x[corte.destaque] || 0) / b) * 100)}</div>
    </div>`;
  };
  alvo.innerHTML = barra(tot, "<strong>Todos os canais</strong>")
    + canais.map((x) => barra(x, x.canal)).join("")
    + `<div class="d-legenda">` + corte.seg.map(({ r, c, k }) =>
        `<span><i class="${c}"></i> ${r} <small>${fmtNum(tot[k] || 0)}</small></span>`).join("")
    + `</div>`;
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("#det-desfecho .seg-mini button");
  if (!b) return;
  document.querySelectorAll("#det-desfecho .seg-mini button")
    .forEach((x) => x.classList.toggle("ativo", x === b));
  estado.corteCX = b.dataset.v;
  if (estado.dados) pintaDesfecho(estado.dados);
});

function pintaRanking(d, hoje) {
  // Por agente (18/09): RESOLUÇÃO, não fechamento. Duas fontes medidas por nós ticket a ticket:
  //  - cx_agente (view cx_agente_dia): fechamentos por pessoa separando descarte (0 msg humana) de efetivo; maduro/resolutivo/voltou
  //    só sobre efetivos, 7 dias corridos; mensagens do cliente por atendimento; CSAT 2/6/10 do ticket fechado;
  //  - cx_resposta_agente: cadência dentro da conversa em expediente (fatia ≤ 8 min e p90).
  //  - cx_handoff (view cx_handoff_dia): quantos tickets chegam ao humano por dia útil — o denominador do time (rodapé).
  // Saíram: Trabalhados/Horas/CSAT do Gleap (o snapshot por agente parou em 12/09), FCR (redundante com "voltou" enquanto a
  // volta está em 30% pra todo mundo) e 1ª resposta por agente (a fila é meta de escala, não do N1).
  const rows = d.cx_agente || [];
  const temAgente = Array.isArray(d.cx_agente) && d.cx_agente.length > 0;
  const jm = cxJanelaMadura({ ini: PER.ini, fim: PER.fim }, hoje);
  const f = { marca: estado.marca, ini: jm.ini, fim: jm.fim };
  const linhas = agenteAgg(rows, f);
  const resps = new Map(respostaPorAgente(d.cx_resposta_agente || [], f).map((r) => [r.agente_id, r]));
  const time = agenteTime(linhas, d.cx_handoff || [], f);
  const sel = $("#sel-agente");
  const atual = estado.agente;
  const nomeDe = (a) => String(a.nome || a.agente_id).replace(/\s+null$/i, "");
  sel.innerHTML = `<option value="todos">Todos os agentes</option>` +
    linhas.map((a) => `<option value="${a.agente_id}" ${a.agente_id === atual ? "selected" : ""}>${nomeDe(a)}</option>`).join("");
  const filtradas = atual === "todos" ? linhas : linhas.filter((a) => a.agente_id === atual);

  $("#ranking-rotulo").innerHTML = `${fmtDia(jm.ini)}–${fmtDia(jm.fim)}` +
    (jm.caiu ? ` <span class="tag alerta" title="O período da página não tem ${CX_AGENTE_MIN_DIAS} dias úteis maduros (fechamento só conta como resolutivo ou 'voltou' ${CX_VOLTA_DIAS} dias depois). A tabela caiu para os últimos ${CX_AGENTE_DIAS_QUEDA} dias úteis maduros.">caiu para o maduro</span>` :
      jm.cortou ? ` <span class="tag nota" title="Fechamento só conta como resolutivo ou 'voltou' ${CX_VOLTA_DIAS} dias depois; os dias do período depois de ${fmtDia(jm.fim)} ainda estão maturando e ficam fora da tabela.">maduro até ${fmtDia(jm.fim)}</span>` : "") +
    (!temAgente ? ` <span class="tag alerta" title="A API ainda não devolve cx_agente (bloco novo de 18/09). Rode n8n/api_patch_agente.py e force o cache.">sem cx_agente</span>` : "") +
    (time.temHandoff && typeof time.chegamDia === "number" && typeof time.resolutivosDia === "number"
      ? ` <span class="tag ${time.resolutivosDia >= time.chegamDia ? "ok" : "alerta"}" title="Chegam ao humano (transferido para pessoa, ou com resposta de pessoa, ou e-mail; Aris + Fish) por dia útil da janela, contra o que o time resolve por dia útil (fechou com mensagem e o cliente não voltou em 7 dias). Negativo = a fila cresce.">chegam ${fmtDec(time.chegamDia, 0)}/dia útil · time resolve ${fmtDec(time.resolutivosDia, 0)} · saldo ${time.resolutivosDia - time.chegamDia >= 0 ? "+" : "−"}${fmtDec(Math.abs(time.resolutivosDia - time.chegamDia), 0)}</span>` : "");

  const st = (m, v) => { const s = cxStatus(m, v); return s ? ` st-${s}` : ""; };
  const stAlto = (v, bom, aten) => typeof v !== "number" ? "" : v >= bom ? " st-bom" : v >= aten ? " st-atencao" : " st-ruim";
  const stBaixo = (v, bom, aten) => typeof v !== "number" ? "" : v <= bom ? " st-bom" : v <= aten ? " st-atencao" : " st-ruim";
  const vazio = `<span class="mini">—</span>`;
  const resCel = (a) => typeof a.resolutivosDia !== "number" ? `<span class="tabn">${fmtNum(a.resolutivos)}</span><div class="mini">${a.maduros ? "nada maduro por dia" : "nada maduro ainda"}</div>`
    : `<strong class="tabn${st("ag_fechados_dia", a.resolutivosDia)}">${fmtDec(a.resolutivosDia, 0)}</strong><div class="mini">${fmtNum(a.resolutivos)} de ${fmtNum(a.maduros)} maduros · fechou ${a.fechadosDia === null ? "—" : fmtDec(a.fechadosDia, 0)}/dia</div>`;
  const volCel = (a) => typeof a.pctVoltou === "number" ? `<strong class="tabn${st("voltou", a.pctVoltou)}">${fmtPct0(a.pctVoltou)}</strong><div class="mini">${fmtNum(a.voltaram)} voltaram</div>`
    : `<span class="tabn">${fmtNum(a.voltaram)}<span class="mini"> de ${fmtNum(a.maduros)}</span></span><div class="mini">base curta</div>`;
  const cliCel = (a) => typeof a.msgsClientePorAt !== "number" ? vazio : `<strong class="tabn${stBaixo(a.msgsClientePorAt, 4, 6)}">${fmtDec(a.msgsClientePorAt, 1)}</strong><div class="mini">pessoa ${fmtDec(a.msgsHumanasPorAt, 1)}</div>`;
  const csatCel = (a) => typeof a.pctCsatBom !== "number" ? `<span class="tabn">${fmtNum(a.csatAvaliados)}<span class="mini"> aval.</span></span><div class="mini">base curta</div>`
    : `<strong class="tabn${st("ag_csat", a.pctCsatBom)}">${fmtPct0(a.pctCsatBom)}</strong><span class="mini"> · </span><span class="tabn${a.pctCsatRuim >= 25 ? " st-ruim" : ""}">${fmtPct0(a.pctCsatRuim)}</span><div class="mini">${fmtNum(a.csatAvaliados)} avaliados</div>`;
  const respCel = (r) => !r || !r.respostas ? vazio : `<strong class="tabn${stAlto(r.pctAte8, 50, 40)}">${fmtPct0(r.pctAte8)}</strong><div class="mini">p90 ${fmtDur(r.p90Comercial)} · ${fmtNum(r.respostas)} resp.</div>`;
  const descCel = (a) => !a.fechados ? vazio : `<strong class="tabn${typeof a.pctDescartes === "number" ? stBaixo(a.pctDescartes, 15, 25) : ""}">${fmtNum(a.descartes)}</strong><div class="mini">${typeof a.pctDescartes === "number" ? fmtPct0(a.pctDescartes) + " dos fechamentos" : "de " + fmtNum(a.fechados)}</div>`;
  const respAg = (a) => { const r = resps.get(a.agente_id); return r; };
  const linha = (a) => `
    <tr class="${a.agente_id === atual ? "destaque" : ""}" style="--cor-tag:${corHex(a.marcas.length === 1 ? a.marcas[0] : "todas")}">
      <td><div class="pessoa">
        <span class="avatar">${nomeDe(a).trim().split(/\s+/).map((x) => x[0]).slice(0, 2).join("").toUpperCase()}</span>
        <div><div class="nome">${nomeDe(a)}</div>
        <div class="pessoa-marca">${a.marcas.length === 1 ? ROTULOS[a.marcas[0]] || a.marcas[0] : "duas marcas"} · ${fmtNum(a.dias)} dia${a.dias === 1 ? "" : "s"}</div></div>
      </div></td>
      <td class="num">${resCel(a)}</td>
      <td class="num">${volCel(a)}</td>
      <td class="num">${cliCel(a)}</td>
      <td class="num">${csatCel(a)}</td>
      <td class="num">${respCel(respAg(a))}</td>
      <td class="num">${descCel(a)}</td>
    </tr>`;
  $("#tabela-ranking tbody").innerHTML = filtradas.map(linha).join("") ||
    `<tr><td colspan="7" class="vazio-tabela">${temAgente ? "Nenhum fechamento por pessoa na janela." : "Sem dado por agente (a API ainda não devolve cx_agente)."}</td></tr>`;
  // rodapé: o time inteiro na mesma régua — só quando a página está em "todos os agentes"
  const tf = $("#tabela-ranking tfoot");
  if (tf) tf.innerHTML = atual !== "todos" || !linhas.length ? "" : `
    <tr class="total">
      <td><div class="pessoa"><div><div class="nome">Time · ${fmtNum(time.agentes)} pessoas</div><div class="pessoa-marca">${time.temHandoff && typeof time.chegamDia === "number" ? `chegam ao humano ${fmtDec(time.chegamDia, 0)}/dia útil` : `${fmtNum(time.diasUteis)} dias úteis`}</div></div></div></td>
      <td class="num">${typeof time.resolutivosDia === "number" ? `<strong class="tabn${time.temHandoff && typeof time.chegamDia === "number" ? (time.resolutivosDia >= time.chegamDia ? " st-bom" : " st-ruim") : ""}">${fmtDec(time.resolutivosDia, 0)}</strong><div class="mini">${fmtNum(time.resolutivos)} de ${fmtNum(time.maduros)} maduros · por dia útil</div>` : vazio}</td>
      <td class="num">${typeof time.pctVoltou === "number" ? `<strong class="tabn${st("voltou", time.pctVoltou)}">${fmtPct0(time.pctVoltou)}</strong><div class="mini">${fmtNum(time.voltaram)} voltaram</div>` : vazio}</td>
      <td class="num">${typeof time.msgsClientePorAt === "number" ? `<strong class="tabn${stBaixo(time.msgsClientePorAt, 4, 6)}">${fmtDec(time.msgsClientePorAt, 1)}</strong><div class="mini">pessoa ${fmtDec(time.msgsHumanasPorAt, 1)}</div>` : vazio}</td>
      <td class="num">${typeof time.pctCsatBom === "number" ? `<strong class="tabn${st("ag_csat", time.pctCsatBom)}">${fmtPct0(time.pctCsatBom)}</strong><span class="mini"> · </span><span class="tabn${time.pctCsatRuim >= 25 ? " st-ruim" : ""}">${fmtPct0(time.pctCsatRuim)}</span><div class="mini">${fmtNum(time.csatAvaliados)} avaliados</div>` : vazio}</td>
      <td class="num">${(() => { const r = respostaAgg(d.cx_resposta_agente || [], f); return respCel(r); })()}</td>
      <td class="num">${typeof time.pctDescartes === "number" ? `<strong class="tabn${stBaixo(time.pctDescartes, 15, 25)}">${fmtNum(time.descartes)}</strong><div class="mini">${fmtPct0(time.pctDescartes)} dos fechamentos</div>` : vazio}</td>
    </tr>`;
}


// Reclame Aqui: pintaRaNovo em cx-tela.js (lê cx_ra_dia; critérios RA1000 em cx-metricas.js).

// Comentários orgânicos via Meta Graph (volume, respondidos, ocultos, sentimento próprio).
// Independe da Replient: quando a API deles sair, entra como fonte adicional.
// Aba Comentários: os cartões e o gráfico estão em cx-tela.js (pintaSocialAba); aqui a tabela por
// marca (com quem respondeu: bot × pessoa, inferido pelo tempo) e as duas filas de pendência.
function pintaSocial(d) {
  const alvo = $("#area-social"); if (!alvo) return;
  const marcas = estado.marca === "todas" ? MARCAS : [estado.marca];
  const linhas = (d.social || []).filter((l) => l.dia >= PER.ini && l.dia <= PER.fim && marcas.includes(l.marca));
  const agg = {};
  for (const l of linhas) {
    const a = (agg[l.marca] = agg[l.marca] || { total: 0, respondidos: 0, ocultos: 0, apagados: 0, pos: 0, neg: 0, neu: 0, sem: 0, aguardando: 0 });
    for (const k of ["total", "respondidos", "ocultos", "aguardando", "apagados"]) a[k] += Number(l[k] || 0);
    a.pos += Number(l.pos || 0); a.neg += Number(l.neg || 0); a.neu += Number(l.neu || 0); a.sem += Number(l.sem_classificacao || 0);
  }
  const comDados = marcas.filter((m) => agg[m] && agg[m].total);
  const urg = $("#area-social-urgentes");
  if (!comDados.length) { alvo.innerHTML = `<p class="mini">Nenhum comentário no período selecionado.</p>`; if (urg) urg.innerHTML = ""; return; }
  const aut = autoriaAgg(d, marcas);
  alvo.innerHTML = `<div class="rolagem"><table class="comparativo soc-tab">
    <thead><tr><th>Marca</th><th class="num">Comentários</th><th class="num" title="Resposta pública da conta da marca">Respondidos</th><th class="num" title="Pediam resposta e não têm">Aguardando</th><th title="Classificação própria (OpenAI) · negativo | neutro | positivo">Sentimento</th><th class="num" title="Inferido pelo tempo até responder: até 10 min é o bot da Replient">Bot · pessoa</th><th class="num" title="Ocultados pela marca / apagados pelo autor">Ocultos / apagados</th></tr></thead>
    <tbody>${comDados.map((m) => {
      const a = agg[m], clas = a.pos + a.neg + a.neu, pc = (x) => (clas ? (x / clas) * 100 : 0), au = aut[m];
      return `<tr>
        <td><span class="ponto" style="--cor:${corHex(m)}"></span> <span class="nome">${ROTULOS[m]}</span>${a.sem ? `<div class="mini">${fmtNum(a.sem)} na fila de classificação</div>` : ""}</td>
        <td class="num">${fmtNum(a.total)}</td>
        <td class="num">${fmtNum(a.respondidos)}<span class="mini"> ${Math.round((a.respondidos / a.total) * 100)}%</span></td>
        <td class="num ${a.aguardando ? "vm" : ""}">${fmtNum(a.aguardando)}</td>
        <td>${clas ? `<div class="csat-cel"><div class="b3 fina" role="img" aria-label="${Math.round(pc(a.neg))}% negativo"><i class="s-ruim" style="width:${pc(a.neg)}%" title="negativo: ${fmtNum(a.neg)}"></i><i class="s-neutro" style="width:${pc(a.neu)}%" title="neutro: ${fmtNum(a.neu)}"></i><i class="s-bom" style="width:${pc(a.pos)}%" title="positivo: ${fmtNum(a.pos)}"></i></div><strong class="tabn ${pc(a.neg) >= 25 ? "vm" : ""}">${Math.round(pc(a.neg))}%<span class="mini"> neg</span></strong></div>` : "<span class='mini'>—</span>"}</td>
        <td class="num">${au && au.bot + au.humano ? `<span class="tabn">${Math.round((au.bot / (au.bot + au.humano)) * 100)}%<span class="mini"> · ${Math.round((au.humano / (au.bot + au.humano)) * 100)}%</span></span><div class="mini">bot ${au.medBot || "—"} · pessoa ${au.medHum || "—"}</div>` : "<span class='mini'>—</span>"}</td>
        <td class="num"><span class="tabn">${fmtNum(a.ocultos)}<span class="mini"> / ${fmtNum(a.apagados)}</span></span></td>
      </tr>`; }).join("")}</tbody></table></div>`;

  // duas filas distintas: problema (atenção) e dinheiro (oportunidade)
  const fila = (titulo, itens, classe, sub) => itens.length
    ? `<div class="soc-urg"><div class="soc-urg-cab ${classe}">${titulo} <span class="mini">${sub}</span></div>
        ${itens.slice(0, 5).map((u) => `<div class="soc-urg-item">
          <span class="ponto" style="--cor:${corHex(u.marca)}"></span>
          <div><div class="soc-urg-txt">${(u.texto || "").replace(/</g, "&lt;")}</div>
          <div class="mini">@${u.autor || "?"} · ${u.rede} · ${u.categoria || "—"}${u.sentimento === "negativo" ? ' · <span class="vm">negativo</span>' : ""}</div></div>
        </div>`).join("")}</div>`
    : "";
  const at = (d.social_atencao || []).filter((u) => marcas.includes(u.marca));
  const op = (d.social_oportunidade || []).filter((u) => marcas.includes(u.marca));
  if (urg) urg.innerHTML =
    fila("⚠ Precisam de atenção", at, "urg-ruim", "negativos ou reclamações sem resposta da marca · 14 dias") +
    fila("💰 Oportunidades sem resposta", op, "urg-bom", "intenção de compra, preço ou dúvida de produto · 7 dias") +
    (!at.length && !op.length ? `<div class="soc-urg-ok mini">Nada pendente: sem reclamação e sem oportunidade esperando resposta. ✓</div>`
      : (!at.length ? `<div class="soc-urg-ok mini">Nenhuma reclamação sem resposta. ✓</div>` : ""));
}

/* Quem respondeu: bot da Replient ou gente.
   O corte não é estatístico, é de processo: quando a Replient não consegue responder,
   ela deixa o chat em aberto e a resposta vira encargo do agente. A partir de 10
   minutos é sempre humano — não existe faixa cinzenta.
   Os números concordam. Medido em 2.186 respostas, olhando o RELÓGIO DA RESPOSTA:
     até 10min   51,5% fora do expediente, 7,4% de madrugada -> bot
     10 a 60min  15,8% fora                                  -> humano
     acima de 1h  6,5% caindo para 1,1%                      -> humano
   A faixa abaixo de 1 minuto também é bot: com 64,3% fora do expediente ela é mais
   bot do que a própria faixa de 1 a 10 minutos.
   Limite conhecido: o texto da resposta não é coletado, então isto mede QUEM respondeu
   e QUANTO demorou — não se a resposta prestou. */
function autoriaAgg(d, marcas) {
  const agg = {};
  for (const l of (d.social_autoria || [])) {
    if (l.dia < PER.ini || l.dia > PER.fim || !marcas.includes(l.marca)) continue;
    const a = (agg[l.marca] = agg[l.marca] || { bot: 0, humano: 0, botSeg: [], humSeg: [] });
    if (l.autoria === "bot" || l.autoria === "humano") a[l.autoria] += Number(l.n || 0);
    if (l.espera_mediana_seg !== null && l.espera_mediana_seg !== undefined) {
      const par = [Number(l.espera_mediana_seg), Number(l.n || 0)];
      if (l.autoria === "bot") a.botSeg.push(par); if (l.autoria === "humano") a.humSeg.push(par);
    }
  }
  // Mediana de medianas diárias não existe: pondera pelo volume do dia.
  const pond = (pares) => { const den = pares.reduce((s, p) => s + p[1], 0); return den ? pares.reduce((s, p) => s + p[0] * p[1], 0) / den : null; };
  const dur = (x) => x === null ? null : x < 90 ? Math.round(x) + "s" : x < 5400 ? Math.round(x / 60) + " min" : x < 172800 ? Math.round(x / 3600) + " h" : Math.round(x / 86400) + " d";
  for (const m of Object.keys(agg)) { agg[m].medBot = dur(pond(agg[m].botSeg)); agg[m].medHum = dur(pond(agg[m].humSeg)); }
  return agg;
}

// Aba NPS: cartões e gráfico em cx-tela.js (pintaNpsAba); aqui a tabela por marca.
function pintaNps(d, hoje) {
  const alvo = $("#area-nps"); if (!alvo) return;
  const marcas = estado.marca === "todas" ? MARCAS : [estado.marca];
  const linhas = marcas.map((m) => ({ m, n: calculaNps(d.nps, m, PER.ini, PER.fim), a: estado.comparar ? calculaNps(d.nps, m, PER.cIni, PER.cFim) : { n: 0 } }));
  if (!linhas.some((l) => l.n.n)) { alvo.innerHTML = `<p class="mini">Sem votos no período.</p>`; return; }
  const f1 = (v) => typeof v === "number" ? v.toFixed(1).replace(".", ",") : "—";
  alvo.innerHTML = `<div class="rolagem"><table class="comparativo nps-tab">
    <thead><tr><th>Marca</th><th class="num" title="% promotores − % detratores">NPS</th><th class="num">Nota</th><th title="detratores | passivos | promotores">Distribuição</th><th class="num">Promotores</th><th class="num">Passivos</th><th class="num">Detratores</th><th class="num">Votos</th></tr></thead>
    <tbody>${linhas.map(({ m, n, a }) => {
      if (!n.n) return `<tr><td><span class="ponto" style="--cor:${corHex(m)}"></span> <span class="nome">${ROTULOS[m]}</span></td><td colspan="7" class="mini">sem votos no período</td></tr>`;
      const pc = (x) => (x / n.n) * 100;
      const chip = n.n >= 10 && a.n >= 10 ? cxChipPts(n.nps, a.nps, "alto") : (n.n < 10 ? `<span class="chip">amostra pequena</span>` : "");
      return `<tr>
        <td><span class="ponto" style="--cor:${corHex(m)}"></span> <span class="nome">${ROTULOS[m]}</span></td>
        <td class="num">${n.nps}${chip ? `<div>${chip}</div>` : ""}</td>
        <td class="num">${f1(n.media)}<span class="mini">/10</span></td>
        <td><div class="b3 fina" role="img" aria-label="${Math.round(pc(n.detr))}% detratores"><i class="s-ruim" style="width:${pc(n.detr)}%" title="detratores: ${n.detr}"></i><i class="s-neutro" style="width:${pc(n.pass)}%" title="passivos: ${n.pass}"></i><i class="s-bom" style="width:${pc(n.prom)}%" title="promotores: ${n.prom}"></i></div></td>
        <td class="num">${fmtNum(n.prom)}<span class="mini"> ${Math.round(pc(n.prom))}%</span></td>
        <td class="num">${fmtNum(n.pass)}<span class="mini"> ${Math.round(pc(n.pass))}%</span></td>
        <td class="num ${pc(n.detr) >= 25 ? "vm" : ""}">${fmtNum(n.detr)}<span class="mini"> ${Math.round(pc(n.detr))}%</span></td>
        <td class="num">${fmtNum(n.n)}</td>
      </tr>`; }).join("")}</tbody></table></div>`;
}


// Categorias do NPS: o que o cliente escolheu ao votar (campo "área" da landing).
// Sem interpretação de IA — é a própria seleção dele.
function pintaFrustracoes(d) {
  const alvo = $("#area-frustracoes");
  const mapa = { aristocrata: "aristo", fishermans: "fish", olivas: "olivas" };
  const alvoMarcas = estado.marca === "todas" ? ["aristo", "fish", "olivas"] : [mapa[estado.marca]];
  const lista = (d.nps_frustracoes || []).filter((f) =>
    alvoMarcas.includes(f.marca) && f.dia >= PER.ini && f.dia <= PER.fim);
  if (!lista.length) { alvo.innerHTML = ""; return; }
  const porArea = {};
  let negativos = 0;
  for (const f of lista) {
    const n = Number(f.n || 0);
    porArea[f.area] = (porArea[f.area] || 0) + n;
    if (f.bucket !== "promotor") negativos += n;
  }
  const top = Object.entries(porArea).sort((a, b) => b[1] - a[1]);
  const max = top[0][1];
  const total = top.reduce((s, [, n]) => s + n, 0);
  alvo.innerHTML = `<div class="frust">
    <div class="frust-cab">Área apontada por quem votou
      <span class="mini">${fmtNum(total)} escolhas · ${fmtNum(negativos)} de detratores e passivos</span></div>
    ${top.map(([area, n]) => `<div class="frust-linha">
      <span class="frust-tema">${area}</span>
      <span class="frust-barra"><i style="width:${(n / max) * 100}%"></i></span>
      <span class="frust-n">${fmtNum(n)}</span></div>`).join("")}</div>`;
}

// ---------- interação ----------
function ligaFiltros() {
  $("#seg-marca").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    estado.marca = b.dataset.marca; estado.agente = "todos";
    [...$("#seg-marca").children].forEach((x) => x.classList.toggle("ativo", x === b));
    pinta();
  });
  // seletor de período
  const pop = $("#pop-periodo");
  $("#btn-periodo").addEventListener("click", () => { pop.hidden = !pop.hidden; });
  document.addEventListener("click", (e) => {
    if (!pop.hidden && !e.target.closest(".periodo-wrap")) pop.hidden = true;
  });
  $("#lista-presets").addEventListener("click", (e) => {
    const li = e.target.closest("li"); if (!li) return;
    [...$("#lista-presets").children].forEach((x) => x.classList.toggle("ativo", x === li));
    if (li.dataset.p !== "custom") {
      estado.preset = li.dataset.p;
      pop.hidden = true; pinta();
      // reflete o intervalo resolvido nos calendários
      $("#dt-ini").value = PER.ini; $("#dt-fim").value = PER.fim;
    }
  });
  for (const id of ["dt-ini", "dt-fim"]) $("#" + id).addEventListener("change", () => {
    estado.preset = "custom";
    [...$("#lista-presets").children].forEach((x) => x.classList.toggle("ativo", x.dataset.p === "custom"));
  });
  $("#chk-comparar-pop").addEventListener("change", (e) => { estado.comparar = e.target.checked; });
  for (const r of document.querySelectorAll('input[name="modo-comp"]')) r.addEventListener("change", (e) => {
    estado.compAuto = e.target.value === "auto";
    $("#dt-cini").disabled = $("#dt-cfim").disabled = estado.compAuto;
  });
  $("#btn-aplicar").addEventListener("click", () => {
    if (estado.preset === "custom") { estado.ini = $("#dt-ini").value || estado.ini; estado.fim = $("#dt-fim").value || estado.fim; }
    estado.comparar = $("#chk-comparar-pop").checked;
    if (!estado.compAuto) { estado.cIni = $("#dt-cini").value || null; estado.cFim = $("#dt-cfim").value || null; }
    pop.hidden = true; pinta();
  });
  $("#sel-agente").addEventListener("change", (e) => { estado.agente = e.target.value; pinta(); });
  for (const b of $("#seg-marca").children) b.classList.toggle("ativo", b.dataset.marca === estado.marca);
  for (const li of $("#lista-presets").children) li.classList.toggle("ativo", li.dataset.p === estado.preset);
}

function relogio() {
  const f = () => ($("#relogio").textContent =
    new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }));
  f(); setInterval(f, 15000);
}

ligaFiltros();
relogio();
carrega();
if (typeof module === "undefined" || !module.exports) setInterval(carrega, CX_REFRESH_SEG * 1000);
