/* Fluxos — camada de regras (Fase C · leitura · 11/09/2026).
   Duas origens, sempre rotuladas:
   1. `crm_fluxo_def` (contrato R6 em BACKEND_REQUESTS.md, ainda não existe): a DEFINIÇÃO — gatilho, etapas, esperas,
      condições de saída, versão. Validada linha a linha; inválida é contada e não exibida.
   2. Observado: o que o motor registrou (`crm_fluxo`, `crm_wa_envios`) cruzado com o inventário (`crm_operacao`:
      workflows, templates.mapped_in) e com `wa_fluxo_saude`. Diz QUAIS peças e canais existem e em que modo o workflow
      está — não diz o gatilho, a espera nem a ordem, porque a API não declara isso. Nada é inferido do nome da peça.
   Sem DOM: tudo testável em Node. A tela fica em growth-flows-ui.js. Não há edição: depende da API de fluxos (Fase B). */
'use strict';
const GF={
  CANAIS:{whatsapp:'WhatsApp',email:'E-mail',sms:'SMS'},
  MODOS:['real','sombra','interno'],
  TIPOS_ETAPA:['mensagem','espera','condicao','fim'],
  obj(v){return !!v&&typeof v==='object'&&!Array.isArray(v);},
  str(v){return typeof v==='string'&&v.trim()?v.trim():null;},
  data(v){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)?v:null;},
  iso(v){return typeof v==='string'&&Number.isFinite(Date.parse(v))?v:null;},
  marca(v){return ['fish','aristo','olivas'].includes(v)?v:null;},

  /* ---------- 1. definição declarada (R6) ---------- */
  definidos(api){
    const raw=api&&api.crm_fluxo_def;
    if(!GF.obj(raw)||!Array.isArray(raw.fluxos))return {presente:false,fluxos:[],invalidos:0,schema_version:null};
    const fluxos=[],erros=[];
    raw.fluxos.forEach((f,i)=>{
      const v=GF.validaFluxo(f);
      if(v.erros.length){erros.push({indice:i,key:GF.obj(f)?GF.str(f.key):null,erros:v.erros});return;}
      fluxos.push(v.fluxo);
    });
    return {presente:true,schema_version:raw.schema_version??null,fluxos,invalidos:erros.length,erros,gerado_em:GF.iso(raw.generated_at)};
  },
  validaFluxo(f){
    const erros=[];
    if(!GF.obj(f))return {erros:['fluxo não é objeto']};
    const key=GF.str(f.key),marca=GF.marca(f.marca),nome=GF.str(f.nome)||key;
    if(!key)erros.push('key ausente');if(!marca)erros.push('marca inválida');
    const g=GF.obj(f.gatilho)?f.gatilho:null;
    if(!g)erros.push('gatilho ausente');
    const gatilho=g?{evento:GF.str(g.evento),chave_evento:GF.str(g.chave_evento),reentrada:['nunca','apos_fim','sempre'].includes(g.reentrada)?g.reentrada:null,
      saida:Array.isArray(g.saida)?g.saida.filter(GF.str):[],descricao:GF.str(g.descricao)}:null;
    if(g&&!gatilho.evento)erros.push('gatilho.evento ausente');
    if(g&&!gatilho.chave_evento)erros.push('gatilho.chave_evento ausente (identidade do evento para deduplicar)');
    if(g&&!gatilho.reentrada)erros.push('gatilho.reentrada inválida (nunca | apos_fim | sempre)');
    const vr=GF.obj(f.versao)?f.versao:null;
    if(!vr)erros.push('versao ausente');
    const versao=vr?{id:GF.str(vr.id),numero:Number.isSafeInteger(+vr.numero)&&+vr.numero>0?+vr.numero:null,publicada_em:GF.iso(vr.publicada_em),ativa:typeof vr.ativa==='boolean'?vr.ativa:null,rascunho_pendente:vr.rascunho_pendente===true}:null;
    if(vr&&!versao.id)erros.push('versao.id ausente');if(vr&&versao.ativa===null)erros.push('versao.ativa precisa ser booleano');
    const modo=GF.MODOS.includes(f.modo)?f.modo:null;if(!modo)erros.push('modo inválido (real | sombra | interno)');
    const etapasRaw=Array.isArray(f.etapas)?f.etapas:null;if(!etapasRaw||!etapasRaw.length)erros.push('etapas ausentes');
    const etapas=[];let invalidas=0;
    (etapasRaw||[]).forEach((e,i)=>{const r=GF.validaEtapa(e,i);if(r.erros.length){invalidas++;erros.push(`etapa ${i+1}: ${r.erros.join(', ')}`);}else etapas.push(r.etapa);});
    return {erros,fluxo:erros.length?null:{key,marca,nome,gatilho,versao,modo,etapas,etapas_invalidas:invalidas,motor:GF.str(f.motor),origem:'definido'}};
  },
  validaEtapa(e,i){
    const erros=[];
    if(!GF.obj(e))return {erros:['não é objeto']};
    const tipo=GF.TIPOS_ETAPA.includes(e.tipo)?e.tipo:null;if(!tipo)erros.push('tipo inválido');
    const etapa={ordem:Number.isSafeInteger(+e.ordem)?+e.ordem:i+1,key:GF.str(e.key)||`etapa-${i+1}`,tipo,nome:GF.str(e.nome),modo:GF.MODOS.includes(e.modo)?e.modo:null,
      canal:null,template_ref:null,template_nome:null,peca:null,espera_seg:null,condicoes:[],saida_para:GF.str(e.saida_para)};
    if(tipo==='mensagem'){
      etapa.canal=GF.CANAIS[e.canal]?e.canal:null;if(!etapa.canal)erros.push('canal inválido');
      etapa.template_ref=GF.str(e.template_ref);etapa.template_nome=GF.str(e.template_nome);etapa.peca=GF.str(e.peca);
      if(!etapa.template_ref&&!etapa.template_nome)erros.push('mensagem sem template_ref/template_nome');
    }
    if(tipo==='espera'){etapa.espera_seg=Number.isSafeInteger(+e.espera_seg)&&+e.espera_seg>0?+e.espera_seg:null;if(etapa.espera_seg===null)erros.push('espera_seg ausente');}
    if(tipo==='condicao'){etapa.condicoes=Array.isArray(e.condicoes)?e.condicoes.filter(GF.obj).map(c=>({se:GF.str(c.se),entao:GF.str(c.entao)})).filter(c=>c.se):[];if(!etapa.condicoes.length)erros.push('condicao sem regras');}
    return {erros,etapa};
  },
  espera(seg){if(!Number.isFinite(seg))return '—';if(seg%86400===0)return `${seg/86400} dia(s)`;if(seg%3600===0)return `${seg/3600} h`;if(seg%60===0)return `${seg/60} min`;return `${seg} s`;},

  /* ---------- 2. observado (só o que a API já devolve) ----------
     Grão: (marca, flow). Peças vêm de crm_fluxo/crm_wa_envios (estrutura: todas as linhas do payload; volume: só o
     período). Workflow/modo vêm de templates.mapped_in → workflows (inventário). Sem mapped_in, "workflow não declarado".
     `teste-motor` fica fora (mesma regra de Envios). */
  observados(api,ctx={}){
    const {ini='',fim='',marca='todas'}=ctx;
    const linhas=[...(Array.isArray(api?.crm_fluxo)?api.crm_fluxo:[]).map(r=>({...r,fonte:'crm_fluxo'})),...(Array.isArray(api?.crm_wa_envios)?api.crm_wa_envios:[]).map(r=>({...r,fonte:'crm_wa_envios'}))];
    const validas=linhas.filter(r=>GF.obj(r)&&GF.str(r.flow)&&GF.str(r.piece)&&GF.marca(r.marca)&&r.flow!=='teste-motor');
    const invalidas=linhas.filter(r=>!(GF.obj(r)&&GF.str(r.flow)&&GF.str(r.piece)&&GF.marca(r.marca))).length;
    const op=GF.obj(api?.crm_operacao)?api.crm_operacao:{};
    const workflows=(Array.isArray(op.workflows)?op.workflows:[]).filter(GF.obj);
    const templates=(Array.isArray(op.templates)?op.templates:[]).filter(GF.obj);
    const saude=(Array.isArray(api?.wa_fluxo_saude)?api.wa_fluxo_saude:[]).filter(r=>GF.obj(r)&&GF.str(r.chave));
    const wfModel=ctx.workflowsModel||null; // linhas de GC.model quando a tela passa (traz collection.current/fieldsValid)
    const mapa=new Map();
    validas.forEach(r=>{
      if(marca!=='todas'&&r.marca!==marca)return;
      const k=`${r.marca}|${r.flow}`;
      if(!mapa.has(k))mapa.set(k,{key:k,marca:r.marca,flow:r.flow,nome:r.flow,origem:'observado',etapas:new Map(),saude:[]});
      const f=mapa.get(k),pk=`${r.piece}|${r.canal||'?'}`;
      if(!f.etapas.has(pk))f.etapas.set(pk,{peca:r.piece,canal:GF.CANAIS[r.canal]?r.canal:null,canal_bruto:r.canal??null,fontes:new Set(),volume:{enviados:undefined,aceitos:undefined,entregues:undefined,linhas:0,linhas_periodo:0},workflows:[],templates:[]});
      const e=f.etapas.get(pk);e.fontes.add(r.fonte);e.volume.linhas++;
      const noPeriodo=typeof r.dia==='string'&&(!ini||r.dia>=ini)&&(!fim||r.dia<=fim);
      if(noPeriodo){e.volume.linhas_periodo++;
        if(r.fonte==='crm_fluxo')e.volume.enviados=GF.somaConhecida(e.volume.enviados,r.enviados);
        if(r.fonte==='crm_wa_envios'){e.volume.aceitos=GF.somaConhecida(e.volume.aceitos,r.aceitos);e.volume.entregues=GF.somaConhecida(e.volume.entregues,r.entregues);}}
    });
    // inventário: template → workflow(s) por peça, com modo e validade da consulta
    templates.forEach(t=>{
      if(!Array.isArray(t.mapped_in))return;
      t.mapped_in.filter(l=>GF.obj(l)&&GF.str(l.workflow_key)&&GF.str(l.piece)).forEach(l=>{
        mapa.forEach(f=>{if(f.marca!==t.brand)return;
          f.etapas.forEach(e=>{if(e.peca!==l.piece||e.canal!=='whatsapp')return;
            const wf=workflows.find(w=>w.key===l.workflow_key),wm=wfModel?wfModel.find(w=>w.key===l.workflow_key):null;
            const mode=wf?(Array.isArray(wf.modes)?wf.modes:[]).find(m=>GF.obj(m)&&m.key===l.mode_key):null;
            const atual=wm?!!(wm.collection?.current&&wm.fieldsValid):null; // null = tela não passou o modelo; não afirmar
            e.workflows.push({key:l.workflow_key,label:GF.str(wf?.label)||l.workflow_key,modo:mode?(GF.MODOS.includes(mode.value)?mode.value:'nao_confirmado'):'nao_informado',ativo:typeof wf?.active==='boolean'?wf.active:null,atual,last_good_at:wm?.last_good_at||null});
            if(!e.templates.some(x=>x.name===t.name))e.templates.push({name:t.name,status:GF.str(t.status)||'desconhecido',category:GF.str(t.category)});
          });});
      });
    });
    saude.forEach(s=>{const m=String(s.chave).match(/^gatilho:([a-z]+):(.+)$/);mapa.forEach(f=>{if(f.marca!==s.brand)return;if(m&&m[1]===s.brand&&[...f.etapas.values()].some(e=>e.peca===m[2]))f.saude.push(s);else if(!m&&String(s.chave).startsWith('aceite:'))f.saude.push(s);});});
    const fluxos=[...mapa.values()].map(f=>({...f,etapas:[...f.etapas.values()].map(e=>({...e,fontes:[...e.fontes]})).sort((a,b)=>a.peca.localeCompare(b.peca,'pt-BR')||String(a.canal).localeCompare(String(b.canal))),
      modo:GF.modoResumo([...f.etapas.values()]),gatilho:null,versao:null})).sort((a,b)=>a.marca.localeCompare(b.marca)||a.flow.localeCompare(b.flow,'pt-BR'));
    return {fluxos,invalidas};
  },
  count(v){return (typeof v==='number'||(typeof v==='string'&&v.trim()!==''))&&Number.isSafeInteger(+v)&&+v>=0?+v:null;},
  somaConhecida(acc,v){const n=GF.count(v);if(acc===undefined)return n;if(acc===null||n===null)return null;return acc+n;},
  // Resumo do modo de um fluxo observado: só afirma "real" se TODOS os workflows conhecidos das etapas WA estão em real
  // com consulta atual; qualquer mistura vira "misto"; sem workflow declarado, "não declarado".
  modoResumo(etapas){
    const wfs=etapas.flatMap(e=>e.workflows);
    if(!wfs.length)return {valor:'nao_declarado',rotulo:'Workflow não declarado no manifesto',tone:'neutral'};
    const desat=wfs.filter(w=>w.atual===false);
    if(desat.length)return {valor:'nao_confirmado',rotulo:`Modo não confirmado (consulta desatualizada em ${[...new Set(desat.map(w=>w.key))].join(', ')})`,tone:'warning'};
    const semConsulta=wfs.filter(w=>w.atual!==true);
    if(semConsulta.length)return {valor:'nao_confirmado',rotulo:`Modo não confirmado (consulta não confirmada em ${[...new Set(semConsulta.map(w=>w.key))].join(', ')})`,tone:'warning'};
    const vals=[...new Set(wfs.map(w=>w.modo))];
    const semWf=etapas.filter(e=>!e.workflows.length).length; // etapas sem workflow declarado: o modo não cobre o fluxo inteiro
    if(vals.length===1&&GF.MODOS.includes(vals[0]))return {valor:vals[0],rotulo:`Modo ${vals[0]}${vals[0]==='real'&&wfs.some(w=>w.ativo===false)?' · workflow inativo':''}${semWf?` (${etapas.length-semWf} de ${etapas.length} etapas com workflow declarado)`:''}`,tone:vals[0]==='real'&&wfs.every(w=>w.ativo===true)&&!semWf?'verified':'neutral'};
    if(vals.length===1)return {valor:'nao_confirmado',rotulo:'Modo não confirmado pelo inventário',tone:'warning'};
    return {valor:'misto',rotulo:`Modo misto (${vals.map(v=>v==='nao_confirmado'?'não confirmado':v==='nao_informado'?'não informado':v).join(', ')})`,tone:'warning'};
  },

  /* ---------- 3. junção: definido manda; observado complementa ---------- */
  lista(api,ctx={}){
    if(ctx.configuredReadOnly===true)return GF.configuredRead(api,ctx);
    const def=GF.definidos(api),obs=GF.observados(api,ctx);
    const marca=ctx.marca||'todas';
    const definidos=def.fluxos.filter(f=>marca==='todas'||f.marca===marca);
    // Observado que não tem definição declarada continua na lista, rotulado.
    const cobertos=new Set(definidos.map(f=>`${f.marca}|${f.key}`));
    const soObservados=obs.fluxos.filter(f=>!cobertos.has(`${f.marca}|${f.flow}`));
    return {presenteDef:def.presente,definidos,observados:soObservados,invalidosDef:def.invalidos,errosDef:def.erros||[],invalidasObs:obs.invalidas,gerado_em:def.gerado_em||null};
  },
  /* Colunas do CSV (uma linha por etapa), mesma projeção da tela. */
  colunas:[
    {chave:'origem',rotulo:'Origem'},{chave:'marca',rotulo:'Marca'},{chave:'fluxo',rotulo:'Fluxo'},{chave:'gatilho',rotulo:'Gatilho'},{chave:'modo',rotulo:'Modo'},{chave:'versao',rotulo:'Versão'},
    {chave:'ordem',rotulo:'Etapa'},{chave:'tipo',rotulo:'Tipo'},{chave:'canal',rotulo:'Canal'},{chave:'peca',rotulo:'Peça'},{chave:'template',rotulo:'Template'},{chave:'espera',rotulo:'Espera'},{chave:'condicoes',rotulo:'Condições'},
    {chave:'workflows',rotulo:'Workflow(s)'},{chave:'volume',rotulo:'Volume no período'},
  ],
  linhasCsv(lista){
    if(lista.configuredReadOnly===true)return GF.configuredRowsCsv(lista);
    const out=[];
    lista.definidos.forEach(f=>f.etapas.forEach(e=>out.push({origem:'definição declarada',marca:f.marca,fluxo:f.nome,gatilho:f.gatilho?`${f.gatilho.evento} · reentrada ${f.gatilho.reentrada}${f.gatilho.saida.length?` · sai em ${f.gatilho.saida.join(', ')}`:''}`:null,
      modo:e.modo||f.modo,versao:f.versao?`v${f.versao.numero??'?'} · ${f.versao.ativa?'ativa':'não ativa'}`:null,ordem:e.ordem,tipo:e.tipo,canal:e.canal?GF.CANAIS[e.canal]:null,peca:e.peca,template:e.template_nome||e.template_ref,
      espera:e.tipo==='espera'?GF.espera(e.espera_seg):null,condicoes:e.condicoes.length?e.condicoes.map(c=>`se ${c.se}${c.entao?` → ${c.entao}`:''}`).join(' | '):null,workflows:null,volume:null})));
    lista.observados.forEach(f=>f.etapas.forEach((e,i)=>out.push({origem:'observado no motor',marca:f.marca,fluxo:f.flow,gatilho:null,modo:f.modo.rotulo,versao:null,ordem:null,tipo:'mensagem',canal:e.canal?GF.CANAIS[e.canal]:e.canal_bruto,peca:e.peca,
      template:e.templates.map(t=>`${t.name} (${t.status})`).join(' | ')||null,espera:null,condicoes:null,workflows:e.workflows.map(w=>`${w.label} · ${GF.modoTexto(w)}`).join(' | ')||null,volume:GF.volumeTexto(e)})));
    return out;
  },
  modoTexto(w){const m=w.modo==='nao_confirmado'?'não confirmado':w.modo==='nao_informado'?'modo não informado':w.modo;return w.atual===false?`último modo observado: ${m} · consulta desatualizada`:w.atual===true?`modo configurado: ${m}`:`modo ${m}`;},
  volumeTexto(e){
    const nf=v=>v===null||v===undefined?'—':new Intl.NumberFormat('pt-BR').format(v);
    if(!e.volume.linhas_periodo)return 'sem linha no período';
    if(e.canal==='email')return `${nf(e.volume.enviados)} envios registrados (entregas no quadro de e-mail medido)`;
    return `${nf(e.volume.aceitos)} aceitos · ${nf(e.volume.entregues)} entregues`;
  },
};
/* Configured READ: one immutable projection for cards, declared-link diagram and CSV.
   No history/editor/draft client can become a current definition. */
Object.assign(GF,{
  configuredLimits:Object.freeze({flows:100,steps:200,conditions:100,string:2048,bytes:2097152}),
  configuredCopy(value,depth=0){
    if(depth>16)throw Error('shape');
    if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
    if(Array.isArray(value)){if(value.length>20000)throw Error('limit');const a=[];for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value'))throw Error('shape');a.push(GF.configuredCopy(d.value,depth+1));}return a;}
    if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('shape');
    const o={};for(const k of Object.keys(value)){const d=Object.getOwnPropertyDescriptor(value,k);if(!Object.hasOwn(d,'value')||['__proto__','constructor','prototype'].includes(k))throw Error('shape');o[k]=GF.configuredCopy(d.value,depth+1);}return o;
  },
  configuredFreeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(GF.configuredFreeze);Object.freeze(v);}return v;},
  configuredText(v,required=false){if(v===undefined||v===null||v===''){if(required)throw Error('required');return null;}if(typeof v!=='string'||v.length>GF.configuredLimits.string||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)||!v.trim())throw Error('text');return v;},
  configuredISO(v){if(v==null)return null;if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)||!Number.isFinite(Date.parse(v)))throw Error('timestamp');const year=+v.slice(0,4),month=+v.slice(5,7),day=+v.slice(8,10);if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||+v.slice(11,13)>23||+v.slice(14,16)>59||+v.slice(17,19)>59)throw Error('timestamp');return v;},
  configuredVersion(v){if(!GF.obj(v)||typeof v.ativa!=='boolean'||!Number.isSafeInteger(v.numero)||v.numero<1||v.rascunho_pendente!==undefined&&typeof v.rascunho_pendente!=='boolean')throw Error('version');return {id:GF.configuredText(v.id,true),numero:v.numero,ativa:v.ativa,publicada_em:GF.configuredISO(v.publicada_em),rascunho_pendente:v.rascunho_pendente===true};},
  configuredFlow(f){
    if(!GF.obj(f)||!['fish','aristo'].includes(f.marca)||!GF.MODOS.includes(f.modo))throw Error('flow');
    const key=GF.configuredText(f.key,true),nome=GF.configuredText(f.nome)||key,versao=GF.configuredVersion(f.versao),g=f.gatilho;
    if(!GF.obj(g)||!['nunca','apos_fim','sempre'].includes(g.reentrada)||g.saida!==undefined&&!Array.isArray(g.saida))throw Error('trigger');
    const gatilho={evento:GF.configuredText(g.evento,true),chave_evento:GF.configuredText(g.chave_evento,true),reentrada:g.reentrada,descricao:GF.configuredText(g.descricao),saida:(g.saida||[]).map(v=>GF.configuredText(v,true))};
    if(!Array.isArray(f.etapas)||!f.etapas.length||f.etapas.length>GF.configuredLimits.steps)throw Error('steps');
    const etapas=f.etapas.map((e,index)=>{
      if(!GF.obj(e)||!GF.TIPOS_ETAPA.includes(e.tipo)||e.modo!==undefined&&e.modo!==null&&!GF.MODOS.includes(e.modo))throw Error('step');
      if(e.ordem!==undefined&&(!Number.isSafeInteger(e.ordem)||e.ordem<1))throw Error('order');
      const v={id:'n'+index,key:GF.configuredText(e.key,true),tipo:e.tipo,nome:GF.configuredText(e.nome),ordem:e.ordem??null,modo:e.modo??null,canal:null,template_ref:null,template_nome:null,peca:null,espera_seg:null,condicoes:[],saida_para:GF.configuredText(e.saida_para)};
      if(e.tipo==='mensagem'){if(!Object.hasOwn(GF.CANAIS,e.canal))throw Error('channel');v.canal=e.canal;v.template_ref=GF.configuredText(e.template_ref);v.template_nome=GF.configuredText(e.template_nome);v.peca=GF.configuredText(e.peca);if(!v.template_ref&&!v.template_nome)throw Error('template');}
      if(e.tipo==='espera'){if(!Number.isSafeInteger(e.espera_seg)||e.espera_seg<1)throw Error('wait');v.espera_seg=e.espera_seg;}
      if(e.tipo==='condicao'){if(!Array.isArray(e.condicoes)||!e.condicoes.length||e.condicoes.length>GF.configuredLimits.conditions)throw Error('conditions');v.condicoes=e.condicoes.map(c=>{if(!GF.obj(c))throw Error('condition');return {se:GF.configuredText(c.se,true),entao:GF.configuredText(c.entao)};});}
      return v;
    });
    const byKey=new Map();etapas.forEach(e=>{const a=byKey.get(e.key)||[];a.push(e);byKey.set(e.key,a);});
    const links=[],problemas=[];byKey.forEach((a,k)=>{if(a.length>1)problemas.push({kind:'duplicate-stage-key',key:k,count:a.length});});
    const link=(e,to,label,kind)=>{const matches=to?byKey.get(to)||[]:[],status=!to?'undeclared':matches.length===0?'missing':matches.length>1?'ambiguous':'resolved';const edge={id:'l'+links.length,fromId:e.id,fromKey:e.key,toId:status==='resolved'?matches[0].id:null,toKey:to,label,kind,status};links.push(edge);if(status!=='resolved')problemas.push({kind:'destination-'+status,fromKey:e.key,toKey:to,label});if(e.tipo==='fim')problemas.push({kind:'terminal-has-transition',fromKey:e.key,toKey:to});};
    etapas.forEach(e=>{if(e.saida_para!==null)link(e,e.saida_para,null,'saida_para');e.condicoes.forEach(c=>link(e,c.entao,c.se,'condicoes.entao'));});
    return {key,marca:f.marca,nome,versao,modo:f.modo,gatilho,etapas,origem:'definido',motor:GF.configuredText(f.motor),graph:{nodes:etapas,links,problemas,entry:'not-declared',fidelity:'declared-links-only',connectionState:links.length?'declared':'not-declared',executionConfirmed:false,deliveryConfirmed:false}};
  },
  configuredRead(api,ctx={}){
    const marca=ctx.marca,now=Number.isFinite(ctx.now)?ctx.now:Date.now();
    const out={configuredReadOnly:true,marca,definidos:[],observados:[],presenteDef:false,invalidosDef:0,errosDef:[],invalidasObs:0,gerado_em:null,source:{state:'absent',revision:null,generatedAt:null,expiresAt:null,freshness:'unknown'},history:{state:'absent'},mutateAllowed:false,executionConfirmed:false,deliveryConfirmed:false};
    if(!['fish','aristo'].includes(marca)){out.source.state='scope-required';return GF.configuredFreeze(out);}
    let a={};try{if(!GF.obj(api))return GF.configuredFreeze(out);for(const k of ['crm_fluxo_def','crm_fluxo','crm_wa_envios','crm_operacao','wa_fluxo_saude','error','erro','_historical_export']){const d=Object.getOwnPropertyDescriptor(api,k);if(d){if(!Object.hasOwn(d,'value'))throw Error('shape');a[k]=d.value===undefined?null:GF.configuredCopy(d.value);}}if(new TextEncoder().encode(JSON.stringify(a)).length>GF.configuredLimits.bytes)throw Error('limit');}catch{out.source.state='invalid-input';out.history.state='invalid-input';return GF.configuredFreeze(out);}
    if(a._historical_export===true){out.source.state='historical-not-current';out.history.state='historical-not-current';return GF.configuredFreeze(out);}
    if(a.error||a.erro){out.source.state='error';out.history.state='error';return GF.configuredFreeze(out);}
    const raw=a.crm_fluxo_def;
    if(raw!=null){
      if(!GF.obj(raw)||raw.error||raw.erro){out.source.state=GF.obj(raw)&&(raw.error||raw.erro)?'error':'invalid';}
      else if(raw.historical===true||raw.snapshot_kind==='historical-export'){out.source.state='historical-not-current';}
      else if(raw.schema_version!==1){out.source.state='unsupported-schema';}
      else if(!Array.isArray(raw.fluxos)||raw.fluxos.length>GF.configuredLimits.flows){out.source.state='invalid';}
      else{
        out.presenteDef=true;out.source.state='loaded';
        try{out.source.generatedAt=GF.configuredISO(raw.generated_at);out.source.expiresAt=GF.configuredISO(raw.expires_at);if(out.source.generatedAt&&Date.parse(out.source.generatedAt)>now+1000)throw Error('future');if(out.source.expiresAt&&(!out.source.generatedAt||Date.parse(out.source.expiresAt)<=Date.parse(out.source.generatedAt)))throw Error('expiry');out.source.freshness=out.source.expiresAt?(Date.parse(out.source.expiresAt)<=now?'expired':'within-declared-validity'):out.source.generatedAt?'validity-not-declared':'unknown';}catch{out.source.freshness='invalid-metadata';}
        out.gerado_em=out.source.generatedAt;out.source.revision=typeof raw.revision==='string'&&raw.revision.length<=2048||Number.isSafeInteger(raw.revision)?String(raw.revision):null;
        const rows=raw.fluxos.filter(f=>GF.obj(f)&&f.marca===marca);let unknownBrand=raw.fluxos.filter(f=>!GF.obj(f)||!GF.marca(f.marca)).length;
        const byKey=new Map();rows.forEach(f=>{if(typeof f.key==='string')byKey.set(f.key,(byKey.get(f.key)||0)+1);});
        for(const f of rows){try{if(byKey.get(f.key)>1)throw Error('duplicate');out.definidos.push(GF.configuredFlow(f));}catch{out.invalidosDef++;out.errosDef.push({kind:'invalid-definition',key:typeof f.key==='string'&&f.key.length<=2048?f.key:null});}}
        out.invalidosDef+=unknownBrand;if(unknownBrand)out.errosDef.push({kind:'unscoped-invalid-definition',key:null});
        out.source.state=out.invalidosDef?(out.definidos.length?'partial':'invalid'):out.definidos.length?'loaded':'empty';
      }
    }
    const hasHistory=Array.isArray(a.crm_fluxo)||Array.isArray(a.crm_wa_envios),badHistory=['crm_fluxo','crm_wa_envios'].some(k=>a[k]!=null&&!Array.isArray(a[k]));
    if(hasHistory&&!badHistory){
      const scoped={...a,crm_fluxo:(a.crm_fluxo||[]).filter(r=>GF.obj(r)&&r.marca===marca),crm_wa_envios:(a.crm_wa_envios||[]).filter(r=>GF.obj(r)&&r.marca===marca),wa_fluxo_saude:(Array.isArray(a.wa_fluxo_saude)?a.wa_fluxo_saude:[]).filter(r=>GF.obj(r)&&r.brand===marca)};
      const op=GF.obj(a.crm_operacao)?a.crm_operacao:{},branded=(Array.isArray(op.workflows)?op.workflows:[]).filter(w=>GF.obj(w)&&(w.brand===marca||w.marca===marca)),counts=new Map();branded.forEach(w=>counts.set(w.key,(counts.get(w.key)||0)+1));
      scoped.crm_operacao={...op,workflows:branded.filter(w=>counts.get(w.key)===1),templates:(Array.isArray(op.templates)?op.templates:[]).filter(t=>GF.obj(t)&&t.brand===marca)};
      const wfModel=(Array.isArray(ctx.workflowsModel)?ctx.workflowsModel:[]).filter(w=>GF.obj(w)&&(w.brand===marca||w.marca===marca)&&counts.get(w.key)===1);
      const unknown=[...(a.crm_fluxo||[]),...(a.crm_wa_envios||[])].filter(r=>!GF.obj(r)||!GF.marca(r.marca)).length;
      const observed=GF.observados(scoped,{ini:ctx.ini,fim:ctx.fim,marca,workflowsModel:wfModel});out.observados=observed.fluxos;out.invalidasObs=observed.invalidas+unknown;out.history.state=out.invalidasObs?'partial':observed.fluxos.length?'loaded':'empty';
    }else if(badHistory)out.history.state='invalid';
    return GF.configuredFreeze(out);
  },
  configuredFilter(model,{q='',origem='todas'}={}){const query=String(q).normalize('NFKC').toLocaleLowerCase('pt-BR');const match=f=>!query||[f.nome,f.key,f.flow,...f.etapas.map(e=>e.nome||e.peca||e.template_nome||e.template_ref||'')].join(' ').normalize('NFKC').toLocaleLowerCase('pt-BR').includes(query);return GF.configuredFreeze({...model,definidos:origem==='observados'?[]:model.definidos.filter(match),observados:origem==='definidos'?[]:model.observados.filter(match)});},
  configuredColumns:[{chave:'origem',rotulo:'Origem'},{chave:'estado',rotulo:'Estado da definição'},{chave:'marca',rotulo:'Marca'},{chave:'fluxo',rotulo:'Jornada'},{chave:'revisao',rotulo:'Revisão declarada'},{chave:'coleta',rotulo:'Coleta declarada'},{chave:'frescor',rotulo:'Frescor'},{chave:'ativa',rotulo:'Ativa na fonte'},{chave:'modo',rotulo:'Modo declarado'},{chave:'gatilho',rotulo:'Gatilho declarado'},{chave:'reentrada',rotulo:'Reentrada'},{chave:'saidas',rotulo:'Eventos de saída'},{chave:'key',rotulo:'Etapa key'},{chave:'ordem',rotulo:'Ordem declarada'},{chave:'tipo',rotulo:'Tipo'},{chave:'nome',rotulo:'Nome da etapa'},{chave:'canal',rotulo:'Canal'},{chave:'template',rotulo:'Template'},{chave:'espera_seg',rotulo:'Espera segundos'},{chave:'transicoes',rotulo:'Transições declaradas'},{chave:'problemas',rotulo:'Problemas de destino'},{chave:'volume',rotulo:'Volume registrado'}],
  configuredRowsCsv(model){const rows=[];model.definidos.forEach(f=>f.etapas.forEach(e=>{const links=f.graph.links.filter(l=>l.fromId===e.id);rows.push({origem:'definicao-declarada',estado:model.source.state,marca:f.marca,fluxo:f.nome,revisao:f.versao.id+' · v'+f.versao.numero,coleta:model.source.generatedAt,frescor:model.source.freshness,ativa:f.versao.ativa?'sim (declarada)':'não (declarada)',modo:e.modo||f.modo,gatilho:f.gatilho.evento,reentrada:f.gatilho.reentrada,saidas:f.gatilho.saida.join(' | '),key:e.key,ordem:e.ordem,tipo:e.tipo,nome:e.nome,canal:e.canal,template:e.template_nome||e.template_ref,espera_seg:e.espera_seg,transicoes:links.map(l=>(l.label?'se '+l.label+' → ':'→ ')+(l.toKey??'destino não declarado')).join(' | '),problemas:links.filter(l=>l.status!=='resolved').map(l=>l.status+': '+(l.toKey??'não declarado')).join(' | '),volume:null});}));model.observados.forEach(f=>f.etapas.forEach(e=>rows.push({origem:'historico-observado',estado:model.source.state,marca:f.marca,fluxo:f.flow,revisao:null,coleta:null,frescor:'não confirma configuração atual',ativa:null,modo:f.modo.rotulo,gatilho:null,reentrada:null,saidas:null,key:null,ordem:null,tipo:'mensagem observada',nome:e.peca,canal:e.canal,template:e.templates.map(t=>t.name).join(' | '),espera_seg:null,transicoes:null,problemas:'histórico não declara grafo',volume:GF.volumeTexto(e)})));return rows;},
  configuredCsv(model){const cell=value=>{let s=value==null?'':String(value);if(/^[\s\u0000-\u001f]*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};return [GF.configuredColumns.map(c=>cell(c.rotulo)).join(';'),...GF.configuredRowsCsv(model).map(row=>GF.configuredColumns.map(c=>cell(row[c.chave])).join(';'))].join('\r\n');},
});

if(typeof module!=='undefined'&&module.exports)module.exports=GF;

