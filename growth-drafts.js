/* Rascunhos locais de template (WhatsApp e e-mail).
   O que isto é: um bloco de notas estruturado, salvo SÓ neste navegador (localStorage), para
   escrever e revisar um template antes de existir backend de cadastro. O que isto NÃO é:
   cadastro na Meta, no Listmonk ou no n8n. Não há publicar, submeter ou ativar aqui; a
   integração real está especificada em BACKEND_REQUESTS.md (R5) e depende do Codex.
   Checagens abaixo usam um perfil local conservador e não certificam aprovação pela Meta.
   Antes de implementar submissão, rever limites e combinações na documentação oficial. */
'use strict';
const GR={
  VERSAO:1,
  CHAVE:'shrigma_growth_rascunhos',
  LIMITES:{corpo:1024,cabecalho:60,rodape:60,botao:25,botoes:10,nome:512,assunto:150},
  MARCAS:[['fish','Fishermans'],['aristo','O Aristocrata'],['olivas','Olivas do Campo']],
  CANAIS:[['whatsapp','WhatsApp'],['email','E-mail']],
  CATEGORIAS:[['UTILITY','Utility · cita a transação do cliente'],['MARKETING','Marketing · oferta ou aviso genérico']],
  TIPOS_BOTAO:[['quick_reply','Resposta rápida'],['url','Abrir link'],['phone','Ligar']],
  esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));},
  agora(){return new Date().toISOString();},
  id(){return 'r'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);},
  novo(base={}){
    return {id:GR.id(),versao:GR.VERSAO,canal:'whatsapp',marca:'fish',idioma:'pt_BR',categoria:'UTILITY',
      nome:'',peca:'',cabecalho:'',corpo:'',rodape:'',assunto:'',exemplos:{},botoes:[],
      criado_em:GR.agora(),atualizado_em:GR.agora(),...base};
  },
  /* ---------- variáveis ---------- */
  variaveis(texto){
    const vistas=[];(String(texto||'').match(/\{\{\s*(\d+)\s*\}\}/g)||[]).forEach(m=>{const n=+m.replace(/\D/g,'');if(!vistas.includes(n))vistas.push(n);});
    return vistas.sort((a,b)=>a-b);
  },
  /* ---------- validação local ----------
     Devolve {erros:[], avisos:[]}. Erro = não faz sentido salvar como candidato a template;
     aviso = a Meta costuma recusar, mas o rascunho pode ser salvo para continuar depois. */
  valida(r){
    const erros=[],avisos=[],L=GR.LIMITES;
    if(!r||typeof r!=='object')return {erros:['Rascunho inválido.'],avisos:[]};
    if(!String(r.nome||'').trim())erros.push('Dê um nome ao rascunho.');
    if(!['whatsapp','email'].includes(r.canal))erros.push('Canal precisa ser WhatsApp ou E-mail.');
    if(!GR.MARCAS.some(([k])=>k===r.marca))erros.push('Marca não reconhecida.');
    if(!String(r.corpo||'').trim())erros.push('O corpo está vazio.');
    if(r.canal==='whatsapp'){
      const nome=String(r.nome||'');
      if(nome&&!/^[a-z0-9_]+$/.test(nome))avisos.push('Nome de template na Meta usa só letras minúsculas, números e _ (ex.: fishermans_rastreio_v2).');
      if(nome.length>L.nome)erros.push(`Nome com mais de ${L.nome} caracteres.`);
      if(!['UTILITY','MARKETING'].includes(r.categoria))erros.push('Escolha a categoria esperada (Utility ou Marketing).');
      if(String(r.corpo||'').length>L.corpo)erros.push(`Corpo com ${r.corpo.length} caracteres; este editor aceita até ${L.corpo}.`);
      if(String(r.cabecalho||'').length>L.cabecalho)erros.push(`Cabeçalho com mais de ${L.cabecalho} caracteres.`);
      if(String(r.rodape||'').length>L.rodape)erros.push(`Rodapé com mais de ${L.rodape} caracteres.`);
      const vars=GR.variaveis(r.corpo);
      vars.forEach((n,i)=>{if(n!==i+1&&!erros.some(e=>e.startsWith('Variáveis')))erros.push('Variáveis precisam ser numeradas em sequência a partir de {{1}}, sem pular.');});
      vars.forEach(n=>{if(!String((r.exemplos||{})[n]||'').trim())avisos.push(`Sem exemplo para {{${n}}}. A Meta exige exemplo de cada variável na submissão.`);});
      if(/^\s*\{\{\s*\d+\s*\}\}/.test(r.corpo||'')||/\{\{\s*\d+\s*\}\}\s*$/.test(r.corpo||''))avisos.push('Corpo que começa ou termina com variável costuma ser recusado pela Meta.');
      if(GR.variaveis(r.cabecalho).length>1)avisos.push('Cabeçalho de texto aceita no máximo uma variável.');
      const botoes=Array.isArray(r.botoes)?r.botoes:[];
      if(botoes.length>L.botoes)erros.push(`Mais de ${L.botoes} botões.`);
      botoes.forEach((b,i)=>{
        if(!String(b.texto||'').trim())erros.push(`Botão ${i+1} sem texto.`);
        else if(b.texto.length>L.botao)erros.push(`Botão ${i+1} com mais de ${L.botao} caracteres.`);
        if(b.tipo==='url'){
          if(!/^https:\/\/\S+$/i.test(b.valor||''))erros.push(`Botão ${i+1}: link precisa começar com https://.`);
          else if(/wa\.me|api\.whatsapp\.com/i.test(b.valor))avisos.push(`Botão ${i+1}: wa.me abre atendimento. Para pagamento ou rastreio, confira se o link leva à página correta do pedido.`);
        }
        if(b.tipo==='phone'&&!/^\+?\d{8,15}$/.test(String(b.valor||'').replace(/[\s()-]/g,'')))erros.push(`Botão ${i+1}: telefone no formato internacional (+55…).`);
        if(!['quick_reply','url','phone'].includes(b.tipo))erros.push(`Botão ${i+1}: tipo desconhecido.`);
      });
      if(r.categoria==='UTILITY'&&/desconto|cupom|oferta|promo|%\s*off/i.test(r.corpo||''))avisos.push('Corpo fala de desconto/oferta: a Meta tende a reclassificar Utility para Marketing (regra registrada em 07/09: Utility precisa citar a transação do cliente).');
    }
    if(r.canal==='email'){
      if(!String(r.assunto||'').trim())erros.push('E-mail precisa de assunto.');
      else if(r.assunto.length>L.assunto)avisos.push(`Assunto com mais de ${L.assunto} caracteres; provedores cortam.`);
      if(Array.isArray(r.botoes)&&r.botoes.some(b=>b.tipo==='url'&&b.valor&&!/utm_/.test(b.valor)))avisos.push('Link sem UTM: a atribuição de receita por esta peça pode ficar incompleta. Confira os parâmetros da campanha antes do envio.');
    }
    return {erros,avisos};
  },
  /* ---------- prévia do que foi digitado ----------
     Substitui {{n}} pelo exemplo digitado; sem exemplo, mostra o marcador. É prévia do rascunho,
     nunca do template publicado — o contrato atual não traz corpo de template. */
  preenche(texto,exemplos={}){
    return String(texto||'').replace(/\{\{\s*(\d+)\s*\}\}/g,(_,n)=>{const v=exemplos[n];return v!==undefined&&String(v).trim()!==''?String(v):`{{${n}}}`;});
  },
  /* ---------- armazenamento local ---------- */
  store(){return typeof localStorage!=='undefined'?localStorage:null;},
  lista(){
    try{const raw=GR.store()?.getItem(GR.CHAVE);const arr=raw?JSON.parse(raw):[];return Array.isArray(arr)?arr.filter(r=>r&&typeof r==='object'&&r.id):[];}catch(_){return [];}
  },
  salva(lista){try{const store=GR.store();if(!store)return false;store.setItem(GR.CHAVE,JSON.stringify(lista));return true;}catch(_){return false;}},
  guarda(r){
    const lista=GR.lista(),i=lista.findIndex(x=>x.id===r.id),item={...r,versao:GR.VERSAO,atualizado_em:GR.agora()};
    if(i>=0)lista[i]=item;else lista.unshift(item);
    return GR.salva(lista)?item:null;
  },
  remove(id){return GR.salva(GR.lista().filter(r=>r.id!==id));},
  /* ---------- arquivo ---------- */
  /* Conteúdo do rascunho, e só ele: os 12 campos do contrato R5.3 (`rascunho`), em lista explícita.
     É o que vai no arquivo exportado e no POST rascunho; id local, estado no servidor e datas ficam fora. */
  conteudo(r){
    const campos=['canal','marca','idioma','categoria','nome','peca','cabecalho','corpo','rodape','assunto'];
    const c=Object.fromEntries(campos.map(k=>[k,r[k]===undefined||r[k]===null?'':String(r[k])]));
    c.exemplos=Object.fromEntries(Object.entries(r.exemplos||{}).filter(([k,v])=>/^\d+$/.test(k)&&typeof v==='string'));
    c.botoes=(r.botoes||[]).map(b=>({tipo:b.tipo,texto:b.texto,valor:b.valor||''}));
    return c;
  },
  exporta(r){
    const resto={versao:GR.VERSAO,...GR.conteudo(r)};
    ['criado_em','atualizado_em'].forEach(k=>{if(r[k]!==undefined)resto[k]=r[k];});
    return JSON.stringify({tipo:'shrigma-growth-rascunho',versao:GR.VERSAO,exportado_em:GR.agora(),origem:'rascunho local · não é template publicado',rascunho:resto},null,2)+'\n';
  },
  nomeArquivo(r){return `rascunho-${r.canal}-${r.marca}-${String(r.nome||'sem-nome').toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9_]+/g,'-').replace(/^-|-$/g,'')||'sem-nome'}.json`;},
  importa(texto){
    let j;try{j=JSON.parse(texto);}catch(_){return {erro:'Arquivo não é JSON válido.'};}
    if(j?.tipo==='shrigma-growth-rascunho'&&j.versao!==GR.VERSAO)return {erro:'Versão de arquivo não suportada.'};
    const r=j&&j.tipo==='shrigma-growth-rascunho'&&j.rascunho&&typeof j.rascunho==='object'?j.rascunho:(j&&typeof j==='object'&&typeof j.corpo==='string'?j:null);
    if(!r||Array.isArray(r))return {erro:'Arquivo não contém um rascunho reconhecido.'};
    const permitidas=['canal','marca','idioma','categoria','nome','peca','cabecalho','corpo','rodape','assunto','exemplos','botoes','criado_em'];
    const textual=v=>v===undefined||v===null||['string','number','boolean'].includes(typeof v);
    if(permitidas.filter(k=>!['exemplos','botoes'].includes(k)).some(k=>!textual(r[k])))return {erro:'Arquivo inválido: campos de texto precisam conter valores simples.'};
    if(r.exemplos&&(typeof r.exemplos!=='object'||Array.isArray(r.exemplos)||Object.values(r.exemplos).some(v=>!textual(v))))return {erro:'Arquivo inválido: exemplos precisam conter texto.'};
    if(Array.isArray(r.botoes)&&r.botoes.some(b=>!b||typeof b!=='object'||Array.isArray(b)||['tipo','texto','valor'].some(k=>!textual(b[k]))))return {erro:'Arquivo inválido: botões precisam conter texto.'};
    const limpo={};permitidas.forEach(k=>{if(r[k]!==undefined)limpo[k]=r[k];});
    limpo.botoes=Array.isArray(limpo.botoes)?limpo.botoes.filter(b=>b&&typeof b==='object').map(b=>({tipo:String(b.tipo||'quick_reply'),texto:String(b.texto||''),valor:String(b.valor||'')})).slice(0,GR.LIMITES.botoes):[];
    limpo.exemplos=limpo.exemplos&&typeof limpo.exemplos==='object'?Object.fromEntries(Object.entries(limpo.exemplos).map(([k,v])=>[k,String(v)])):{};
    ['nome','peca','cabecalho','corpo','rodape','assunto','idioma'].forEach(k=>{if(limpo[k]!==undefined)limpo[k]=String(limpo[k]);});
    return {rascunho:GR.novo({...limpo,id:GR.id(),criado_em:typeof limpo.criado_em==='string'?limpo.criado_em:GR.agora()})};
  },
};
if(typeof module!=='undefined'&&module.exports)module.exports=GR;
