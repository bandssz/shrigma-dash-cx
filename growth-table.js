/* Growth: ordenação, busca, exportação CSV local e preservação de estado da tela.
   Só funções puras + dois utilitários de DOM pequenos (captura/restaura, baixar).
   Nada aqui lê a API nem conhece a chave: recebe as linhas já calculadas e exibidas. */
'use strict';
const GT={
  /* ---------- valores ---------- */
  vazio(v){return v===null||v===undefined||v===''||(typeof v==='number'&&!Number.isFinite(v));},
  numero(v){return !GT.vazio(v)&&typeof v!=='boolean'&&Number.isFinite(+v);},
  esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));},

  /* ---------- ordenação ----------
     Vazio (null/undefined/'') fica SEMPRE no fim, subindo ou descendo: "—" não é o menor
     valor, é ausência. Número compara como número; texto compara em pt-BR sem acento. */
  compara(a,b,dir='asc'){
    const va=GT.vazio(a),vb=GT.vazio(b);
    if(va&&vb)return 0; if(va)return 1; if(vb)return -1;
    let r;
    if(GT.numero(a)&&GT.numero(b))r=(+a)-(+b);
    else if(a instanceof Set&&b instanceof Set)r=a.size-b.size;
    else r=String(a).localeCompare(String(b),'pt-BR',{sensitivity:'base',numeric:true});
    return dir==='desc'?-r:r;
  },
  ordena(rows,chave,dir='asc',pega){
    if(!chave)return [...rows];
    const get=typeof pega==='function'?pega:(r=>r[chave]);
    return rows.map((r,i)=>({r,i})).sort((x,y)=>GT.compara(get(x.r),get(y.r),dir)||(x.i-y.i)).map(x=>x.r);
  },
  /* Clique no mesmo cabeçalho inverte; em outro, começa pela direção natural da coluna
     (número desce, texto sobe). */
  proximaOrdem(estado,chave,numerica){
    if(estado.sort===chave)return {sort:chave,dir:estado.dir==='asc'?'desc':'asc'};
    return {sort:chave,dir:numerica?'desc':'asc'};
  },
  marcaCabecalhos(tabela,estado){
    if(!tabela)return;
    tabela.querySelectorAll('th[data-sort]').forEach(th=>{
      const on=th.dataset.sort===estado.sort;
      if(on)th.setAttribute('aria-sort',estado.dir==='asc'?'ascending':'descending');else th.removeAttribute('aria-sort');
      th.classList.toggle('gt-ordenado',on);
    });
  },

  /* ---------- busca ---------- */
  normaliza(s){return String(s??'').toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g,'');},
  busca(rows,texto,campos){
    const q=GT.normaliza(texto).trim();
    if(!q)return rows;
    const termos=q.split(/\s+/);
    return rows.filter(r=>{
      const alvo=campos.map(c=>typeof c==='function'?c(r):r[c]).filter(v=>!GT.vazio(v)).map(GT.normaliza).join(' ');
      return termos.every(t=>alvo.includes(t));
    });
  },

  /* ---------- CSV ----------
     Excel em pt-BR abre `;` + vírgula decimal + BOM sem assistente de importação.
     Ausente vira célula vazia (nunca 0); booleano vira sim/não; texto que começa com
     = + - @ ou tab recebe apóstrofo para não virar fórmula ao abrir. */
  csvCelula(v){
    if(GT.vazio(v))return '';
    if(typeof v==='boolean')return v?'sim':'não';
    if(v instanceof Set)return String(v.size);
    if(typeof v==='number')return String(v).replace('.',',');
    let s=String(v).replace(/\r?\n/g,' ');
    if(/^[=+\-@\t\r]/.test(s))s="'"+s;
    if(/[;"\n\r]/.test(s))s='"'+s.replace(/"/g,'""')+'"';
    return s;
  },
  /* colunas: [{chave, rotulo, pega?}]; meta: colunas de recorte repetidas em toda linha,
     para o CSV continuar legível depois de colado numa planilha maior. */
  csv(colunas,rows,meta={}){
    const metaCols=Object.entries(meta);
    const cab=[...colunas.map(c=>c.rotulo||c.chave),...metaCols.map(([k])=>k)];
    const linhas=rows.map(r=>[
      ...colunas.map(c=>GT.csvCelula(typeof c.pega==='function'?c.pega(r):r[c.chave])),
      ...metaCols.map(([,v])=>GT.csvCelula(v))].join(';'));
    return '\uFEFF'+[cab.map(GT.csvCelula).join(';'),...linhas].join('\r\n')+'\r\n';
  },
  nomeArquivo(base,meta={}){
    const limpa=s=>GT.normaliza(s).replace(/[^a-z0-9_]+/g,'-').replace(/^-|-$/g,'');
    return ['growth',base,meta.recorte_marca,meta.recorte_canal,meta.periodo_inicio&&meta.periodo_fim?`${meta.periodo_inicio}_${meta.periodo_fim}`:null]
      .filter(Boolean).map(limpa).join('-')+'.csv';
  },
  baixar(nome,texto){
    if(typeof document==='undefined'||typeof Blob==='undefined'||typeof URL==='undefined'||!URL.createObjectURL)return false;
    const blob=new Blob([texto],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=nome;a.rel='noopener';document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    return true;
  },

  /* ---------- estado da tela entre renders ----------
     render() troca o innerHTML das tabelas a cada 60 s. Sem isto, a linha que a pessoa
     acabou de abrir fecha sozinha e o campo de busca perde o cursor. */
  captura(root){
    if(!root)return null;
    const doc=root.ownerDocument||root;
    const ativo=doc.activeElement;
    const dentro=ativo&&ativo!==doc.body&&root.contains(ativo)&&ativo.id?ativo:null;
    return {
      foco:dentro?dentro.id:null,
      selecao:dentro&&typeof dentro.selectionStart==='number'?[dentro.selectionStart,dentro.selectionEnd]:null,
      abertos:[...root.querySelectorAll('details[data-gt-key]')].filter(d=>d.open).map(d=>d.dataset.gtKey),
      expandidos:[...root.querySelectorAll('[data-gt-expand]')].filter(el=>el.getAttribute('aria-expanded')==='true').map(el=>el.dataset.gtExpand),
    };
  },
  restaura(root,estado){
    if(!root||!estado)return;
    const doc=root.ownerDocument||root;
    estado.abertos.forEach(k=>{const d=root.querySelector(`details[data-gt-key="${GT.cssAttr(k)}"]`);if(d)d.open=true;});
    estado.expandidos.forEach(k=>{
      const b=root.querySelector(`[data-gt-expand="${GT.cssAttr(k)}"]`);if(!b)return;
      b.setAttribute('aria-expanded','true');
      const alvo=b.dataset.gtAlvo?doc.getElementById(b.dataset.gtAlvo):b.closest('tr')?.nextElementSibling;
      if(alvo)alvo.hidden=false;
      if(b.dataset.gtToggleText)b.textContent=b.dataset.gtToggleText;
    });
    if(estado.foco){const el=doc.getElementById(estado.foco);if(el){el.focus?.();if(estado.selecao&&el.setSelectionRange)try{el.setSelectionRange(...estado.selecao);}catch(_){}}}
  },
  cssAttr(s){return String(s).replace(/["\\]/g,'\\$&');},

  /* ---------- atalho por URL ----------
     #marca=fish&canal=whatsapp&p=7&sec=regua&aba=workflows — quem recebe o link abre a
     mesma tela. Só chaves conhecidas; valores desconhecidos são ignorados na leitura. */
  CHAVES_HASH:['marca','canal','p','ini','fim','sec','aba','flow'],
  leHash(hash){
    const out={};
    const s=String(hash||'').replace(/^#/,'');
    if(!s)return out;
    for(const par of s.split('&')){
      const [k,v='']=par.split('=');
      if(GT.CHAVES_HASH.includes(k)&&v!=='')try{out[k]=decodeURIComponent(v).slice(0,80);}catch(_){}
    }
    return out;
  },
  escreveHash(estado){
    return '#'+GT.CHAVES_HASH.filter(k=>!GT.vazio(estado[k])).map(k=>`${k}=${encodeURIComponent(estado[k])}`).join('&');
  },
};
if(typeof module!=='undefined'&&module.exports)module.exports=GT;
