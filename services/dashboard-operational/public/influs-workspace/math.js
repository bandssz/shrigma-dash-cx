'use strict';
// Owned calculations retained from the existing Influs page.
const G = {
  MARCA:{aristo:'Aristocrata',fish:'Fishermans',olivas:'Olivas'},
  MARCA_CHEIA:{aristo:'O Aristocrata',fish:'Fishermans',olivas:'Olivas do Campo'},
  // Contadores da aba Influs. Matematica no G, testavel com node.
  // 'pendente' = reconhecido como cupom de influ mas ainda sem dono: e a fila de trabalho.
  // KPIs de influencia. Soma so quem tem receita: quem esta NULL nao vira zero.
  // investimento = custo lancado + comissao. ROI NULL quando investimento=0 (nunca infinito).
  influKPI(roi, marca){
    const value=v=>v===null||v===undefined||v===''||!['number','string'].includes(typeof v)||!Number.isFinite(Number(v))?null:Number(v);
    const todos=(roi||[]).filter(x=>marca==='todas'||x.marca===marca),known=todos.filter(x=>value(x.receita)!==null),unknown=todos.filter(x=>value(x.receita)===null);
    const sum=(rows,k)=>rows.some(x=>value(x[k])===null)?null:rows.reduce((n,x)=>n+value(x[k]),0);
    const receita=sum(todos,'receita'),receitaConhecida=sum(known,'receita'),pedidos=sum(todos,'pedidos'),custo=sum(todos,'custo_lancado'),comissao=sum(todos,'comissao'),patrocinio=sum(todos,'patrocinio');
    const investimento=custo===null||comissao===null?null:custo+comissao,investimentoTotal=investimento===null||patrocinio===null?null:investimento+patrocinio;
    return {creators:known.length,semReceita:unknown.length,custoSemReceita:sum(unknown,'custo_lancado'),receita,receitaConhecida,investimento,investimentoTotal,comissao,custo,patrocinio,pedidos,ticketMedio:null,
      roi:receita!==null&&investimento>0?receita/investimento:null,roiTotal:receita!==null&&investimentoTotal>0?receita/investimentoTotal:null, lucro:receita===null||investimento===null?null:receita-investimento,freteZerado:todos.some(x=>x.frete_zerado===true)};
  },
  // Coverage is per active creator and current competence, not an all-or-none month.
  coberturaCusto(payload, marca, competencia){
    if(!Array.isArray(payload?.influs)||!Array.isArray(payload?.custos))return null;
    const custos=new Set(payload.custos.filter(c=>c.competencia===competencia).map(c=>c.marca+'|'+c.influ));
    const ativos=payload.influs.filter(i=>(marca==='todas'||i.marca===marca)&&i.ativo!==false&&i.modelo!=='encerrado'&&(!i.desde||String(i.desde).slice(0,7)<=competencia));
    return ativos.flatMap(i=>{
      if(!i.modelo||!['fixo','hibrido','permuta','comissao'].includes(i.modelo))return [{...i,motivo:'modelo de remuneração não definido'}];
      if(['fixo','hibrido','permuta'].includes(i.modelo)&&!custos.has(i.marca+'|'+i.influ))return [{...i,motivo:i.modelo==='permuta'?'conferir produto e frete; sem lançamento nesta competência':'cachê desta competência não lançado'}];
      return [];
    });
  },
  // Pending coupon revenue stays at brand + coupon grain. ROI also includes
  // signed-product revenue, so subtracting it from coupon revenue is invalid.
  // Receita de cupom dividida por dono. So conta como "rastreada" o cupom cadastrado como
  // influ E associado a um creator; o resto (campanha da loja, pendente, desconhecido) vai para
  // a etiqueta "sem dono". Assim uma campanha interna nao vira receita de influencia calada.
  receitaCupomDono(payload, marca){
    const dono=new Map();
    for(const c of (payload?.cupons||[])){if(!c||typeof c!=='object'||!c.marca||!c.codigo)continue;
      const k=c.marca+'|'+c.codigo;const d=c.tipo==='influ'&&String(c.influ||'').trim()?c.influ:null;
      dono.set(k,dono.has(k)&&dono.get(k)!==d?null:d);}
    let comDono=0,semDono=0;const sem=new Map();
    for(const x of (payload?.receita_cupom||[])){
      if(!x||typeof x!=='object'||(marca!=='todas'&&x.marca!==marca))continue;
      const v=Number(x.receita);if(x.receita===null||x.receita===''||!Number.isFinite(v))continue;
      if(dono.get(x.marca+'|'+x.codigo))comDono+=v;
      else{semDono+=v;sem.set(x.codigo,(sem.get(x.codigo)||0)+v);}
    }
    return {comDono,semDono,semDonoCupons:[...sem].sort((a,b)=>b[1]-a[1])};
  },
  receitaCuponsPendentes(payload, marca){
    if(!Array.isArray(payload?.cupons)||!Array.isArray(payload?.receita_cupom))return {disponivel:false,receitaConhecida:null,naoConciliadas:null};
    const scope=x=>!x||typeof x!=='object'||!x.marca||marca==='todas'||x.marca===marca;
    const key=x=>JSON.stringify([x.marca,x.codigo]);
    const catalogo=new Map(),quantidades=new Map();
    for(const c of payload.cupons.filter(scope)){if(!c||typeof c!=='object'||!c.marca||!c.codigo)continue;const k=key(c);catalogo.set(k,catalogo.has(k)?null:c);}
    const receitas=payload.receita_cupom.filter(scope);
    for(const r of receitas){if(r&&typeof r==='object'){const k=key(r);quantidades.set(k,(quantidades.get(k)||0)+1);}}
    let receitaConhecida=0,naoConciliadas=0;
    const tipos=new Set(['influ','pendente','nao_influ','crm','cortesia','campanha','suporte','app','desconhecido']);
    for(const r of receitas){
      if(!r||typeof r!=='object'){naoConciliadas++;continue;}
      const k=key(r),c=catalogo.get(k),v=r.receita;
      const numero=(typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v));
      if(!r.marca||!r.codigo||quantidades.get(k)!==1||!c||!tipos.has(c.tipo)||!numero){naoConciliadas++;continue;}
      if(c.tipo==='pendente'||c.tipo==='influ'&&!String(c.influ||'').trim())receitaConhecida+=Number(v);
    }
    return {disponivel:true,receitaConhecida:Number.isFinite(receitaConhecida)?receitaConhecida:null,naoConciliadas};
  },
  // agrupa por porte ou modelo para achar onde o dinheiro rende
  influPor(roi, marca, campo){
    // inclui quem teve receita nula: o custo dele tem que aparecer no corte
    const r = (roi||[]).filter(x => (marca==='todas'||x.marca===marca)
      && (x.receita !== null || +x.investimento > 0));
    const m = new Map();
    for(const x of r){
      const k = x[campo] || '(não informado)';
      const a = m.get(k) || {chave:k, n:0, receita:0, investimento:0};
      a.n++; a.receita += +x.receita||0; a.investimento += +x.investimento||0;
      m.set(k, a);
    }
    return [...m.values()].map(a => ({...a, roi: a.investimento>0 ? a.receita/a.investimento : null}))
      .sort((a,b) => (b.roi??-1)-(a.roi??-1));
  },
  // Nicho e texto livre do time, normalizado no banco (crm_influ_nicho_normalizado).
  nichos(influs, marca){
    return [...new Set((influs||[]).filter(i => (marca==='todas'||i.marca===marca) && i.nicho).map(i => i.nicho))]
      .sort((a,b) => a.localeCompare(b,'pt-BR'));
  },
  // crm_influ_roi nao conhece nicho: ele entra aqui pelo cadastro, sem mexer na funcao do banco.
  comNicho(roi, influs){
    const n = new Map((influs||[]).map(i => [i.marca+'|'+i.influ, i.nicho||null]));
    return (roi||[]).map(x => ({...x, nicho: n.get(x.marca+'|'+x.influ) || null}));
  },
  // '' = todos; '__sem__' = so quem ainda nao tem nicho, para o time preencher.
  passaNicho(nicho, filtro){
    if(!filtro) return true;
    if(filtro==='__sem__') return !nicho;
    return nicho===filtro;
  },
  // Lente de link, separada da de cupom. So 'sem_cupom' soma com cupom sem contar venda duas vezes.
  vendasLink(receitaLink, marca, influ){
    const r = (receitaLink||[]).find(x => x.marca===marca && x.influ===influ);
    return r ? {pedidos:+r.pedidos||0, receita:+r.receita||0, semCupom:+r.pedidos_sem_cupom||0, receitaSemCupom:+r.receita_sem_cupom||0}
             : {pedidos:0, receita:0, semCupom:0, receitaSemCupom:0};
  },
  influResumo(cupons, marca){
    const c = (cupons||[]).filter(x => marca === 'todas' || x.marca === marca);
    const soma = f => c.filter(f).reduce((a,x) => a + (+x.usos_lifetime || 0), 0);
    return {
      pendentes: c.filter(x => x.tipo === 'pendente').length,
      associados: c.filter(x => x.tipo === 'influ').length,
      usosSemDono: soma(x => x.tipo === 'pendente'),
      usosAssociados: soma(x => x.tipo === 'influ'),
      furos: c.filter(x => /FORA da blacklist/.test(x.obs || '')).length,
      // associado porem sem pct: nao gera pagamento. NULL nunca vira 0 escondido.
      semComissao: c.filter(x => x.tipo === 'influ' && x.influ_comissao_pct == null).length,
      total: c.length
    };
  },
};
window.ShrigmaInflusMath=G;
