/* Operação de CRM: contagens de envio e atribuição têm fontes e datas distintas. */
'use strict';
const GD = {
  fields: ['registros','aceitos','enviados_provedor','entregues','lidos','falhas',
    'falhas_reportadas','erros_sincronos','pendentes_entrega','sem_disparo_confirmado','conflitos_status'],
  sum(rows, key) { return rows.reduce((n,r) => n + (+r[key] || 0), 0); },
  max(rows, key) { return rows.reduce((v,r) => String(r[key] || '') > v ? String(r[key]) : v, '') || null; },
  filter(rows, marca, ini, fim) {
    return (rows || []).filter(r => (marca === 'todas' || r.marca === marca)
      && String(r.dia).slice(0,10) >= ini && String(r.dia).slice(0,10) <= fim);
  },
  coverage(api, ini, fim) {
    const c = api.crm_wa_cobertura;
    const meta = Array.isArray(c) ? c[0] : c;
    const present = Array.isArray(api.crm_wa_envios) && !!meta;
    const inicio = meta?.inicio ? String(meta.inicio).slice(0,10) : null;
    const final = meta?.fim ? String(meta.fim).slice(0,10) : null;
    return {present, complete:!!(present && inicio && final && ini >= inicio && fim <= final),
      inicio, fim:final, meta:meta || null};
  },
  whatsapp(api, marca, ini, fim) {
    const coverage = GD.coverage(api, ini, fim);
    const allRows = GD.filter(api.crm_wa_envios, marca, ini, fim);
    // Este fluxo é explicitamente de teste. Não inferir modo por telefone/peça.
    const rows = allRows.filter(r => r.flow !== 'teste-motor');
    const out = {coverage, rows, ultimo_registro_em:GD.max(rows,'ultimo_registro_em'),
      ultimo_status_em:GD.max(rows,'ultimo_status_em'),
      testes_aceitos:coverage.complete?GD.sum(allRows.filter(r=>r.flow==='teste-motor'),'aceitos'):null};
    GD.fields.forEach(k => out[k] = coverage.complete ? GD.sum(rows,k) : null);
    out.entrega_pct = out.aceitos ? 100 * out.entregues / out.aceitos : null;
    return out;
  },
  email(G, api, marca, ini, fim) {
    const cs = G.campanhas(api,marca,ini,fim,false,'email');
    const flows = G.regua(api,marca,ini,fim,'email');
    const conv = G.conversao(api,marca,ini,fim,'peca','email');
    const totals = G.totais(cs,conv);
    const present = Array.isArray(api.crm_campanha) && Array.isArray(api.crm_fluxo);
    return {...totals, present, campanhas:cs, reguas:flows,
      campanhas_enviados:present ? GD.sum(cs,'enviados') : null,
      automacoes_enviados:present ? GD.sum(flows,'enviados') : null,
      enviados:present ? GD.sum(cs,'enviados') + GD.sum(flows,'enviados') : null};
  },
  summary(G, api, marca, ini, fim, canal='todos') {
    const wa = GD.whatsapp(api,marca,ini,fim), email = GD.email(G,api,marca,ini,fim);
    const conv = G.conversao(api,marca,ini,fim,'peca',canal);
    const allKnown = wa.aceitos !== null && email.enviados !== null;
    const enviados = canal === 'whatsapp' ? wa.aceitos : canal === 'email' ? email.enviados
      : allKnown ? wa.aceitos + email.enviados : null;
    return {wa,email,conv,enviados,receita:GD.sum(conv,'receita'),pedidos:GD.sum(conv,'pedidos'),
      receita_assist:GD.sum(conv,'receita_assist')};
  },
  flows(G, api, marca, ini, fim, canal='todos') {
    const map = new Map();
    const key = r => [r.marca,r.canal,r.flow,r.piece].join('|');
    const coverage = GD.coverage(api,ini,fim);
    G.regua(api,marca,ini,fim,canal).filter(r=>r.flow!=='teste-motor').forEach(r => {
      const row = {...r,entregues:null,falhas:null,lidos:null,pendentes_entrega:null,
        sem_disparo_confirmado:null,erros_sincronos:null,ultimo_registro_em:null};
      if (r.canal === 'whatsapp') row.enviados = coverage.complete ? 0 : null;
      map.set(key(row),row);
    });
    if (canal !== 'email') GD.filter(api.crm_wa_envios,marca,ini,fim).filter(r=>r.flow!=='teste-motor').forEach(r => {
      const k = key({...r,canal:'whatsapp'});
      if (!map.has(k)) map.set(k,{marca:r.marca,canal:'whatsapp',flow:r.flow,piece:r.piece,
        enviados:coverage.complete?0:null,pedidos:0,receita:0,assist:0,receita_assist:0});
      const row = map.get(k);
      for (const field of ['aceitos','entregues','falhas','lidos','pendentes_entrega','sem_disparo_confirmado','erros_sincronos']) {
        const dest = field === 'aceitos' ? 'enviados' : field;
        row[dest] = coverage.complete ? (row[dest] || 0) + (+r[field] || 0) : null;
      }
      row.ultimo_registro_em = GD.max([row,r],'ultimo_registro_em');
    });
    const owners = new Map();
    for(const r of map.values()) {
      const k=[r.marca,r.canal,r.piece].join('|');
      if(!owners.has(k)) owners.set(k,new Set());
      owners.get(k).add(r.flow);
    }
    for(const r of map.values()) if(owners.get([r.marca,r.canal,r.piece].join('|')).size>1) {
      r.pedidos=null;r.receita=null;r.assist=null;r.receita_assist=null;r.atribuicao_ambigua=true;
    }
    if(!Array.isArray(api.crm_conversao))for(const r of map.values()){r.pedidos=null;r.receita=null;r.assist=null;r.receita_assist=null;}
    return [...map.values()].map(r => ({...r,
      porMil:r.enviados ? 1000*r.pedidos/r.enviados : null}))
      .sort((a,b) => b.receita-a.receita || (+b.enviados||0)-(+a.enviados||0)
        || a.piece.localeCompare(b.piece));
  },
  series(G, api, marca, ini, fim, metrica, canal='todos') {
    const days = []; for (let d=ini;d<=fim;d=G.addDias(d,1)) days.push(d);
    if (!['enviados','entregues','falhas'].includes(metrica)) return G.serie(api,marca,ini,fim,metrica,canal);
    return days.map(d => {
      const s=GD.summary(G,api,marca,d,d,canal);
      return {d,v:metrica==='enviados'?s.enviados:canal==='email'?null:s.wa[metrica]};
    });
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = GD;
