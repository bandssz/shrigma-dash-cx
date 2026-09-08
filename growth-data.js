/* ================= dados: só matemática, testável com node ================= */
const G = {
  MARCA:{aristo:'Aristocrata',fish:'Fishermans',olivas:'Olivas'},
  // nome por extenso: cabecalho usa o nome cheio, tag de tabela usa o curto
  MARCA_CHEIA:{aristo:'O Aristocrata',fish:'Fishermans',olivas:'Olivas do Campo'},
  TRACKING_DESDE:'2026-07-19',
  // O navegador pode estar em qualquer fuso e o banco roda em UTC. A operacao e em Brasilia:
  // toda data exibida ou comparada passa por aqui. Espelha hoje_br()/dia_br() do Postgres.
  TZ:'America/Sao_Paulo',
  diaBR(x){return new Intl.DateTimeFormat('en-CA',{timeZone:G.TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(x instanceof Date?x:new Date(x));},
  horaBR(x){return +new Intl.DateTimeFormat('en-GB',{timeZone:G.TZ,hour:'2-digit',hour12:false}).format(x instanceof Date?x:new Date(x));},
  // colunas DATE (crm_*.dia) chegam como meia-noite UTC: converter quebraria para o dia anterior.
  // Elas usam slice(0,10) direto. diaBR e so para timestamptz (enviado_em, sent_at) e para "agora".
  iso:d=>G.diaBR(d),
  addDias(s,n){const d=new Date(s+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return G.iso(d);},
  diasEntre(a,b){return Math.round((new Date(b+'T12:00:00Z')-new Date(a+'T12:00:00Z'))/864e5)+1;},
  anterior(ini,fim){const n=G.diasEntre(ini,fim);return{ini:G.addDias(ini,-n),fim:G.addDias(fim,-n)};},
  // Semana comeca na SEGUNDA (convencao BR). getUTCDay da 0 no domingo, entao domingo vira 6.
  segunda(s){const x=new Date(s+'T12:00:00Z');return G.addDias(s,-((x.getUTCDay()+6)%7));},
  preset(p,hoje){
    if(p==='semana')return {ini:G.segunda(hoje),fim:hoje};
    if(p==='semanaant'){const s=G.addDias(G.segunda(hoje),-7);return {ini:s,fim:G.addDias(s,6)};}
    const d=new Date(hoje+'T12:00:00Z');
    if(p==='hoje')return{ini:hoje,fim:hoje};
    if(p==='ontem'){const a=G.addDias(hoje,-1);return{ini:a,fim:a};}
    if(p==='mes')return{ini:hoje.slice(0,8)+'01',fim:hoje};
    if(p==='mesant'){const pm=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),0,12));
      return{ini:G.iso(new Date(Date.UTC(pm.getUTCFullYear(),pm.getUTCMonth(),1,12))),fim:G.iso(pm)};}
    const n=+p||7;return{ini:G.addDias(hoje,-(n-1)),fim:hoje};
  },
  noPeriodo:(dia,ini,fim)=>dia>=ini&&dia<=fim,
  temNumero:v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(+v),
  canal:r=>r.canal||r.channel||null,
  noCanal(r,canal='todos',padrao=null){return canal==='todos'||(G.canal(r)||padrao)===canal;},
  eCRM:r=>r.utm_medium!=='organico'&&['email','whatsapp'].includes(G.canal(r)),
  pct(n,d,c=1){if(!G.temNumero(n)||!G.temNumero(d)||+d<=0)return null;return +(100*n/d).toFixed(c);},

  aberturaConfiavel(p){
    if(!p)return null;
    const bons=(+p.gmail||0)+(+p.outlook||0)+(+p.brasileiro||0);
    const tot=Object.values(p).reduce((a,b)=>a+(+b||0),0);
    return tot?{bons,tot,pct:Math.round(100*bons/tot)}:null;
  },
  // Um dia so => curva por HORA, acumulada, e a comparacao para na mesma hora
  // que o periodo atual (senao "hoje" perde de "ontem inteiro" todo santo dia).
  serieHora(api,marca,dia,metrica,limiteHora,canal='todos'){
    const col = metrica==='receita' ? 'receita' : (metrica==='cliques' ? 'cliques' : null);
    if(!col) return null;
    const h=Array(24).fill(null);
    let viu=false;
    (api.crm_intradia||[])
      .filter(r=>String(r.dia).slice(0,10)===dia)
      .filter(r=>marca==='todas'||r.marca===marca)
      // Sem dimensão de canal não é possível excluir orgânico nem separar CRM.
      // O chamador recorre à série diária, que tem atribuição por canal.
      .filter(r=>G.eCRM(r)&&G.noCanal(r,canal))
      .forEach(r=>{ const v=r[col]; if(!G.temNumero(v)||!Number.isInteger(+r.hora)||+r.hora<0||+r.hora>23) return;
        viu=true; h[r.hora]=(h[r.hora]||0)+(+v||0); });
    if(!viu) return null;
    let acc=0; const out=[];
    for(let i=0;i<24;i++){
      if(limiteHora!==undefined && i>limiteHora){ out.push({d:String(i).padStart(2,'0')+'h',v:null}); continue; }
      acc+=(h[i]||0); out.push({d:String(i).padStart(2,'0')+'h', v:acc});
    }
    return out;
  },
  serie(api,marca,ini,fim,metrica,canal='todos'){
    const dias=[];for(let d=ini;d<=fim;d=G.addDias(d,1))dias.push(d);
    const m={};
    if(metrica==='receita'){
      (api.crm_conversao||[]).forEach(r=>{
        if(marca!=='todas'&&r.marca!==marca)return;
        if(!G.eCRM(r)||!G.noCanal(r,canal)||!G.temNumero(r.receita_ultimo))return;
        const d=String(r.dia).slice(0,10);m[d]=(m[d]||0)+(+r.receita_ultimo||0);});
    }else{
      (api.crm_diario||[]).filter(r=>r.janela==='1d')
        .filter(r=>marca==='todas'||r.marca===marca)
        // A série histórica crm_diario vem do Listmonk; ausência de canal é e-mail.
        .filter(r=>r.utm_medium!=='organico'&&['email','whatsapp'].includes(G.canal(r)||'email'))
        .filter(r=>G.noCanal(r,canal,'email')).forEach(r=>{
          const v=r[metrica];if(v===null||v===undefined)return;
          const d=String(r.dia).slice(0,10);m[d]=(m[d]||0)+(+v||0);});
    }
    return dias.map(d=>({d,v:m[d]??null}));
  },
  delta(a,b,medido){if(!medido||!G.temNumero(a)||!G.temNumero(b)||+b===0)return null;return +(100*(a-b)/b).toFixed(1);},

  // Envios anômalos conhecidos: mostrados como nota, nunca removidos do dado.
  REGUA_ANOMALIAS:[{dia:'2026-08-17',marca:'aristo',piece:'pedido-preparando',
    motivo:'2.408 envios por catch-up manual de fulfillments (backlog pré-J&T) — não é volume orgânico'}],

  // Régua/fluxo agregada no período. Grão: marca × canal × flow × piece.
  // Pedido/receita NULL na crm_fluxo (sem linha de conversão no dia) soma como zero
  // atribuído — a nota da tela explica o porquê. Enviados sempre soma.
  regua(api,marca,ini,fim,canal='todos'){
    const m={};
    (api.crm_fluxo||[])
      .filter(r=>marca==='todas'||r.marca===marca)
      // Payloads antigos de crm_fluxo eram exclusivamente e-mail via SES.
      .filter(r=>G.noCanal(r,canal,'email'))
      .filter(r=>G.noPeriodo(String(r.dia).slice(0,10),ini,fim))
      .forEach(r=>{
        const canalLinha=G.canal(r)||'email';
        const k=r.marca+'|'+canalLinha+'|'+r.flow+'|'+r.piece;
        const o=m[k]||(m[k]={marca:r.marca,canal:canalLinha,flow:r.flow,piece:r.piece,
          enviados:0,pedidos:0,receita:0,assist:0,receita_assist:0});
        o.enviados+=+r.enviados||0;
        o.pedidos+=+r.pedidos_ultimo||0;
        o.receita+=+r.receita_ultimo||0;
        o.assist+=+r.pedidos_assistido||0;
        o.receita_assist+=+r.receita_assistida||0;
      });
    return Object.values(m)
      .map(o=>({...o,porMil:o.enviados?+(1000*o.pedidos/o.enviados).toFixed(1):null}))
      .sort((a,b)=>b.receita-a.receita||b.enviados-a.enviados);
  },
  // A pergunta do bloco: do que sai por e-mail, quanto é campanha e quanto é régua,
  // e qual converte melhor por envio. Campanha: enviados da crm_campanha + conversão
  // com utm_medium='campanha'. Régua: crm_fluxo. Só e-mail nos dois lados.
  campVsRegua(api,marca,ini,fim){
    const cs=G.campanhas(api,marca,ini,fim,false,'email');
    const envC=cs.reduce((a,c)=>a+(+c.enviados||0),0);
    let pedC=0,recC=0;
    (api.crm_conversao||[])
      .filter(r=>(marca==='todas'||r.marca===marca)&&r.canal==='email'&&r.utm_medium==='campanha')
      .filter(r=>G.noPeriodo(String(r.dia).slice(0,10),ini,fim))
      .forEach(r=>{pedC+=+r.pedidos_ultimo||0;recC+=+r.receita_ultimo||0;});
    const fl=G.regua(api,marca,ini,fim,'email');
    const envR=fl.reduce((a,r)=>a+r.enviados,0);
    const pedR=fl.reduce((a,r)=>a+r.pedidos,0);
    const recR=fl.reduce((a,r)=>a+r.receita,0);
    if(!envC&&!envR)return null;
    return{campanha:{env:envC,ped:pedC,rec:recC,porMil:envC?+(1000*pedC/envC).toFixed(1):null},
           regua:{env:envR,ped:pedR,rec:recR,porMil:envR?+(1000*pedR/envR).toFixed(1):null}};
  },

  carrinho(api,marca,ini,fim){
    const linhas=(api.crm_carrinho||[])
      .filter(r=>marca==='todas'||r.marca===marca)
      .filter(r=>G.noPeriodo(String(r.dia).slice(0,10),ini,fim));
    if(!linhas.length)return null;
    const s=(k)=>linhas.reduce((a,r)=>a+(+r[k]||0),0);
    // dias sem cobertura da crm_conversao gravam NULL: separados para nao virar 0%
    const medidos=linhas.filter(r=>r.recuperados!==null&&r.recuperados!==undefined);
    const sm=(k)=>medidos.reduce((a,r)=>a+(+r[k]||0),0);
    const porMarca={};
    linhas.forEach(r=>{
      const a=porMarca[r.marca]||(porMarca[r.marca]={marca:r.marca,carrinhos:0,valor:0,voltou:0,rec:0,receita:0,medido:false});
      a.carrinhos+=+r.carrinhos||0; a.valor+=+r.valor_em_jogo||0;
      a.voltou=(a.voltou||0)+(+r.voltaram_72h||0);
      if(r.recuperados!==null&&r.recuperados!==undefined){a.medido=true;a.rec+=+r.recuperados;a.receita+=+r.receita_recuperada||0;}
    });
    // linhas sao marca x dia: contar DIAS distintos, senao "7 dias" vira "14"
    const dd=new Set(linhas.map(r=>String(r.dia).slice(0,10)));
    const dm=new Set(medidos.map(r=>String(r.dia).slice(0,10)));
    return {carrinhos:s('carrinhos'), valor:s('valor_em_jogo'), consent:s('com_consent'),
      dias:dd.size, diasMedidos:dm.size,
      recuperados:medidos.length?sm('recuperados'):null,
      receita:medidos.length?sm('receita_recuperada'):null,
      valorMedido:sm('valor_em_jogo'),
      carrinhosMedidos:sm('carrinhos'),
      voltaram:s('voltaram_72h'), receitaVoltaram:s('receita_voltaram'),
      voltaramMedidos:sm('voltaram_72h'),
      porMarca:Object.values(porMarca).sort((a,b)=>b.valor-a.valor)};
  },
  // grao: 'peca' (campanha+conteudo, o padrao) | 'campanha' | 'familia'. Familia vem do
  // de-para crm_familia_campanha; campanha sem de-para vira familia dela mesma -- some
  // e o pior estado, entao nada e descartado. Em campanha/familia o canal deixa de
  // fazer parte da chave: a pergunta e "quanto o lancamento vendeu", nao por canal.
  conversao(api,marca,ini,fim,grao='peca',canal='todos'){
    const fam=new Map();(api.crm_familia_campanha||[]).forEach(f=>fam.set(f.marca+'|'+f.utm_campaign,f.familia));
    const agg=new Map();
    (api.crm_conversao||[]).forEach(r=>{
      const dia=String(r.dia).slice(0,10);
      if(marca!=='todas'&&r.marca!==marca)return;
      if(!G.noPeriodo(dia,ini,fim))return;
      // Growth e CRM. Desde que o coletor passou a reconhecer utm_medium=organico,
      // crm_conversao tambem carrega receita de conteudo -- que e outro dominio, com
      // outro dono e outra cadencia, e mora no organico.html. Sem este porteiro a
      // receita de post entraria no funil de e-mail sem ninguem pedir.
      if(!G.eCRM(r)||!G.noCanal(r,canal))return;
      const canalLinha=G.canal(r);
      const familia=fam.get(r.marca+'|'+r.utm_campaign)||r.utm_campaign||'(sem)';
      const k=grao==='peca'?[r.marca,canalLinha,r.utm_campaign,r.utm_content].join('|')
             :grao==='campanha'?[r.marca,r.utm_campaign].join('|'):[r.marca,familia].join('|');
      const a=agg.get(k)||{marca:r.marca,canal:grao==='peca'?canalLinha:'',campanha:r.utm_campaign,peca:r.utm_content,
        familia,canais:new Set(),pecas:new Set(),campanhas:new Set(),
        pedidos:0,receita:0,assist:0,receita_assist:0,novos:0,recorr:0};
      a.canais.add(canalLinha);a.pecas.add(r.utm_campaign+'|'+r.utm_content);a.campanhas.add(r.utm_campaign);
      a.pedidos+=+r.pedidos_ultimo||0;a.receita+=+r.receita_ultimo||0;
      a.assist+=+r.pedidos_assistido||0;a.receita_assist+=+r.receita_assistida||0;
      a.novos+=+r.clientes_novos||0;a.recorr+=+r.clientes_recorrentes||0;
      agg.set(k,a);
    });
    return [...agg.values()].sort((x,y)=>(y.receita-x.receita)||(y.receita_assist-x.receita_assist));
  },
  // Agendada nao entra aqui: 0 enviado sobre 0 entregue nao e taxa, e ruido.
  // Ela aparece no bloco "Na fila", com a data prevista.
  // De-para peca -> receita de ultimo clique, vindo da view crm_campanha_receita.
  // Chave e marca+id porque campanha_id so e unico dentro do Listmonk de cada marca.
  // receita null NAO e zero: significa utm_ambiguo, tupla de UTM que outra peca tambem usa.
  receitaPorPeca(api){
    const m=new Map();
    (api.crm_campanha_receita||[]).forEach(r=>m.set(r.marca+'|'+r.campanha_id,r));
    return m;
  },
  fila(api,marca,canal='todos'){
    const rec=G.receitaPorPeca(api);
    return (api.crm_campanha||[])
      .filter(c=>c.tipo==='agendada')
      .filter(c=>marca==='todas'||c.marca===marca)
      .filter(c=>G.noCanal(c,canal,'email'))
      // Peca so entra em crm_campanha_receita se tiver UTM no corpo: ausencia = sem UTM.
      .map(c=>({...c,canal:G.canal(c)||'email',tem_utm:rec.has(c.marca+'|'+c.campanha_id)}))
      .sort((x,y)=>new Date(x.enviado_em)-new Date(y.enviado_em));
  },
  // agrupar: pecas que reivindicam a mesma tupla de UTM (mesmo e-mail para bases diferentes)
  // viram UMA linha, com envios/aberturas/cliques somados e a receita do GRUPO (view
  // crm_campanha_grupo). Antes cada uma aparecia com receita "indivisivel" e o dinheiro
  // ficava orfao. Testes A/B pedem agrupar=false: la a peca individual e o que importa.
  campanhas(api,marca,ini,fim,agrupar=true,canal='todos'){
    const rec=G.receitaPorPeca(api);
    const lista=G._pecas(api,marca,ini,fim,rec,canal);
    if(!agrupar)return lista;
    const grupos=(api.crm_campanha_grupo||[]);
    const grupoDe=new Map();grupos.forEach(g=>(g.campanha_ids||[]).forEach(id=>grupoDe.set(g.marca+'|'+id,g)));
    const out=[],feito=new Set();
    for(const c of lista){
      const g=grupoDe.get(c.marca+'|'+c.campanha_id);
      if(!g){out.push(c);continue;}
      const chaveGrupo=g.marca+'|'+g.grupo;
      if(feito.has(chaveGrupo))continue; feito.add(chaveGrupo);
      const membros=lista.filter(x=>grupoDe.get(x.marca+'|'+x.campanha_id)===g);
      const soma=k=>membros.reduce((a,x)=>a+(+x[k]||0),0), med=membros.filter(x=>x.medido);
      const medClique=membros.filter(x=>x.medido_clique);
      const m={...membros[0],campanha_id:g.grupo,grupo:g,n_disparos:membros.length,
        nome:`${membros[0].nome} · ${membros.length} disparos`,
        publico:soma('publico'),enviados:soma('enviados'),entregues:soma('entregues'),hard:soma('hard'),complaints:soma('complaints'),
        abriram:med.length?med.reduce((a,x)=>a+(+x.abriram||0),0):null,clicaram:medClique.length?medClique.reduce((a,x)=>a+(+x.clicaram||0),0):null,
        medido:med.length===membros.length,medido_clique:medClique.length===membros.length,truncado:membros.some(x=>x.truncado),real:null,
        enviado_em:membros.map(x=>x.enviado_em).sort().pop(),
        rec:{pedidos:g.pedidos,receita:g.receita,assistidos:g.assistidos,utm_ambiguo:false,grupo:true}};
      m.entrega_pct=G.pct(m.entregues,m.enviados,2);m.abertura_pct=m.medido?G.pct(m.abriram,m.entregues):null;
      m.ctr_pct=m.medido_clique?G.pct(m.clicaram,m.entregues,2):null;
      m.ctor_pct=m.medido&&m.medido_clique?G.pct(m.clicaram,m.abriram):null;m.compl_pct=G.pct(m.complaints,m.entregues,3);
      out.push(m);
    }
    return out.sort((a,b)=>String(b.enviado_em).localeCompare(String(a.enviado_em)));
  },
  _pecas(api,marca,ini,fim,rec,canal='todos'){
    return (api.crm_campanha||[])
      .filter(c=>marca==='todas'||c.marca===marca)
      .filter(c=>G.noCanal(c,canal,'email'))
      .filter(c=>c.tipo!=='agendada')
      .filter(c=>G.noPeriodo(G.diaBR(c.enviado_em),ini,fim))
      .map(c=>({...c,canal:G.canal(c)||'email',
        rec:rec.get(c.marca+'|'+c.campanha_id)||null,
        entrega_pct:G.pct(c.entregues,c.enviados,2),
        abertura_pct:G.pct(c.abriram,c.entregues),
        ctr_pct:G.pct(c.clicaram,c.entregues,2),
        ctor_pct:G.pct(c.clicaram,c.abriram),
        compl_pct:G.pct(c.complaints,c.entregues,3),
        real:G.aberturaConfiavel(c.aberturas_provedor),
        medido:G.temNumero(c.abriram),medido_clique:G.temNumero(c.clicaram)}))
      .sort((a,b)=>String(b.enviado_em).localeCompare(String(a.enviado_em)));
  },
  totais(cs,conv){
    const m=cs.filter(c=>c.medido!==false&&G.temNumero(c.abriram));
    const cl=cs.filter(c=>c.medido_clique!==false&&G.temNumero(c.clicaram));
    const ambos=cl.filter(c=>m.includes(c)),s=(a,k)=>a.reduce((x,c)=>x+(+c[k]||0),0);
    return {pecas:cs.length,medidas:m.length,enviados:s(cs,'enviados'),entregues:s(cs,'entregues'),
      medidasCliques:cl.length,medidasConjuntas:ambos.length,baseAbertura:s(m,'entregues'),baseCliques:s(cl,'entregues'),
      abriram:m.length?s(m,'abriram'):null,clicaram:cl.length?s(cl,'clicaram'):null,hard:s(cs,'hard'),complaints:s(cs,'complaints'),
      abertura:G.pct(m.length?s(m,'abriram'):null,s(m,'entregues')),
      ctr:G.pct(cl.length?s(cl,'clicaram'):null,s(cl,'entregues'),2),ctor:G.pct(ambos.length?s(ambos,'clicaram'):null,s(ambos,'abriram')),
      complPct:G.pct(s(cs,'complaints'),s(cs,'entregues'),3),hardPct:G.pct(s(cs,'hard'),s(cs,'enviados'),2),
      receita:conv.reduce((a,c)=>a+c.receita,0),
      receitaAssist:conv.reduce((a,c)=>a+c.receita_assist,0),
      pedidos:conv.reduce((a,c)=>a+c.pedidos,0)};
  },
  alertas(cs,tot,api){
    const a=[],t=cs.filter(c=>c.truncado);
    if(t.length)a.push({t:'ruim',m:`${t.length} disparo(s) não saíram inteiros — `+
      t.slice(0,2).map(c=>`#${c.campanha_id} enviou ${(c.enviados||0).toLocaleString('pt-BR')} de ${(c.publico||0).toLocaleString('pt-BR')}`).join(' · ')});
    if(tot.hardPct!==null&&tot.hardPct>=0.5)a.push({t:'ruim',
      m:`Rejeição permanente em ${tot.hardPct}% — a SES alerta em 2% e suspende em 5%. Higiene de base antes do próximo disparo.`});
    if(tot.complPct!==null&&tot.complPct>=0.08)a.push({t:'ruim',
      m:`Reclamação em ${tot.complPct}% — limite da SES é 0,1%.`});
    const nm=cs.filter(c=>!c.medido||!c.medido_clique).length;
    if(nm)a.push({t:'aviso',m:`${nm} peça(s) sem medição completa de abertura/clique. As taxas usam apenas a base medida para cada indicador; ausência aparece sem dado, nunca como zero.`});
    const g=api.gerado_em?(Date.now()-new Date(api.gerado_em))/36e5:null;
    if(g!==null&&g>3)a.push({t:'ruim',m:`Última coleta há ${g.toFixed(1)}h — o snapshot deveria rodar a cada 30 min.`});
    return a;
  },

  /* ---------- teste A/B ---------- */
  // Aproximação normal de duas proporções. Só vale com contagens razoáveis;
  // abaixo de 5 sucessos/fracassos por braço devolve poucos_dados e o painel NÃO conclui.
  zParaP(z){
    const x=Math.abs(z),t=1/(1+0.2316419*x),d=0.3989423*Math.exp(-x*x/2);
    const p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));
    return +(2*p).toFixed(4);
  },
  compara(a,b){
    if(!a||!b||!a.n||!b.n)return{status:'sem_dados'};
    const pa=a.x/a.n,pb=b.x/b.n;
    if(a.x<5||b.x<5||a.n-a.x<5||b.n-b.x<5)return{status:'poucos_dados',pa,pb,dif:100*(pb-pa)};
    const pp=(a.x+b.x)/(a.n+b.n),se=Math.sqrt(pp*(1-pp)*(1/a.n+1/b.n));
    if(!se)return{status:'sem_dados'};
    const z=(pb-pa)/se,p=G.zParaP(z);
    return{status:p<0.05?'conclusivo':'inconclusivo',pa,pb,z:+z.toFixed(2),p,
      dif:100*(pb-pa),vencedor:pb>pa?'b':'a'};
  },
  amostraNecessaria(pBase,efeitoPP){
    const p1=pBase,p2=pBase+efeitoPP/100;
    if(p2<=0||p2>=1||!efeitoPP)return null;
    const pm=(p1+p2)/2,d=Math.abs(p2-p1);
    return Math.ceil(2*Math.pow(1.96*Math.sqrt(2*pm*(1-pm))+0.84*Math.sqrt(p1*(1-p1)+p2*(1-p2)),2)/(2*d*d));
  },
  metricaDoBraco(api,teste,braco){
    const c=(api.crm_campanha||[]).find(x=>x.marca===teste.marca&&String(x.campanha_id)===String(braco.campanha_id));
    const m=teste.metrica_primaria;
    if(m==='ctor'&&c&&G.temNumero(c.abriram)&&+c.abriram>0&&G.temNumero(c.clicaram))return{n:+c.abriram,x:+c.clicaram,rot:'CTOR'};
    if(m==='ctr'&&c&&G.temNumero(c.entregues)&&+c.entregues>0&&G.temNumero(c.clicaram))return{n:+c.entregues,x:+c.clicaram,rot:'CTR'};
    if(m==='conversao'&&c&&c.entregues){
      const ped=(api.crm_conversao||[])
        .filter(r=>r.marca===teste.marca&&r.utm_term===braco.utm_term)
        .reduce((a,r)=>a+(+r.pedidos_ultimo||0),0);
      return{n:c.entregues,x:ped,rot:'Conversão'};
    }
    return null;
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = G;
