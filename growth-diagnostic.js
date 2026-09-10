/* Diagnóstico agregado de pedido pago. Somente leitura; não autoriza reenvio. */
'use strict';
const GDI = ((control, delivery) => {
  const COUNT_FIELDS = ['registros','aceitos','entregues','lidos','falhas','erros_sincronos','pendentes_entrega','sem_disparo_confirmado','conflitos_status'];
  const BRANDS = {aristo:'O Aristocrata',fish:'Fishermans'};
  const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const stamp = x => Number.isFinite(control.time(x)) ? new Date(x).toISOString() : null;
  const day = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && Number.isFinite(Date.parse(x+'T12:00:00Z')) && new Date(x+'T12:00:00Z').toISOString().slice(0,10)===x;
  function configSnapshot(raw) {
    if (!object(raw) || !Array.isArray(raw.workflows)) return raw;
    return {...raw,workflows:raw.workflows.map(w => {
      if (!object(w) || !Object.hasOwn(w,'config_collection')) return w;
      const c=object(w.config_collection)?w.config_collection:{};
      return {...w,collection_status:c.status,collection_error_code:c.error_code,
        checked_at:c.checked_at,last_good_at:c.last_good_at};
    })};
  }
  function workflow(rows,key,brand,readFailed) {
    const found=rows.filter(w=>w.key===key && w.brand===brand);
    const row=found.length===1?found[0]:null;
    const current=!!(row && row.collection.current && row.fieldsValid && !readFailed);
    const modes=row?row.modes.filter(m=>m.key==='modo_pedido_pago'):[];
    const mode=current && modes.length===1?modes[0].value:null;
    const stage={key,current,state:'unknown',label:'Configuração não confirmada',mode,
      checked_at:row?stamp(row.checked_at):null,active:current?row.active:null,
      published:current?row.published:null,unpublished_changes:current?row.has_unpublished_changes===true:null};
    if (!current) return stage;
    if (!row.active) return {...stage,state:'blocked',label:'Automação inativa na coleta'};
    if (!row.published) return {...stage,state:'blocked',label:'Sem versão publicada na coleta'};
    if (row.has_unpublished_changes===true) return {...stage,state:'unknown',mode:null,label:'Há alterações não publicadas; modo em execução precisa ser conferido'};
    if (key==='motor') return {...stage,state:'configured',label:'Motor ativo e publicado na coleta'};
    if (mode==='sombra') return {...stage,state:'blocked',label:'Pedido pago em sombra: não faz disparo real'};
    if (mode==='interno') return {...stage,state:'blocked',label:'Pedido pago em modo interno: não confirma envio ao cliente'};
    if (mode!=='real') return {...stage,state:'unknown',label:'Modo de pedido pago não confirmado'};
    return {...stage,state:'configured',label:'Pedido pago publicado em modo real'};
  }
  function template(rows,readFailed) {
    const found=rows.filter(t=>t.piece==='pedido-pago' && t.usage==='current');
    if (found.length!==1) return {state:'unknown',label:found.length?'Mais de um template mapeado: seleção não comprovada':'Template atual de pedido pago não informado',checked_at:null};
    const t=found[0],current=t.collection.current && t.fieldsValid && !readFailed;
    if (!current) return {state:'unknown',label:'Consulta do template não confirmada como atual',checked_at:stamp(t.checked_at)};
    if (!t.eligible || t.category!=='UTILITY') return {state:'blocked',label:'Template não aprovado como Utility na coleta',checked_at:stamp(t.checked_at)};
    return {state:'configured',label:'Template APPROVED / UTILITY na coleta',checked_at:stamp(t.checked_at)};
  }
  function metrics(api,brand,ini,fim) {
    const empty=Object.fromEntries(COUNT_FIELDS.map(k=>[k,null]));
    const c=Array.isArray(api.crm_wa_cobertura)?(api.crm_wa_cobertura.length===1?api.crm_wa_cobertura[0]:null):api.crm_wa_cobertura;
    const start=object(c)&&typeof c.inicio==='string'?c.inicio.slice(0,10):null;
    const end=object(c)&&typeof c.fim==='string'?c.fim.slice(0,10):null;
    const source=api.crm_wa_envios;
    const complete=Array.isArray(source)&&day(start)&&day(end)&&start<=end&&ini>=start&&fim<=end;
    const rows=Array.isArray(source)?source.filter(r=>object(r)&&r.marca===brand&&r.flow==='transacional'&&r.piece==='pedido-pago'):[];
    const validRows=Array.isArray(source)&&source.every(r=>object(r)&&typeof r.marca==='string'&&r.marca.length>0&&typeof r.flow==='string'&&typeof r.piece==='string'&&typeof r.dia==='string'&&day(r.dia.slice(0,10)));
    const chosen=rows.filter(r=>typeof r.dia==='string'&&r.dia.slice(0,10)>=ini&&r.dia.slice(0,10)<=fim);
    const counts=complete&&validRows?Object.fromEntries(COUNT_FIELDS.map(k=>[k,delivery.sumKnown(chosen,k)])):empty;
    for (const k of COUNT_FIELDS) if (counts[k]!==null&&!Number.isSafeInteger(counts[k])) counts[k]=null;
    const inconsistent=[['entregues','aceitos'],['lidos','entregues'],['falhas','aceitos'],['aceitos','registros']]
      .some(([a,b])=>counts[a]!==null&&counts[b]!==null&&counts[a]>counts[b]);
    const timestamps=k=>chosen.map(r=>stamp(r[k])).filter(Boolean).sort().at(-1)||null;
    let state='unknown',label='Medição incompleta para este intervalo';
    if (complete&&validRows) {
      if (inconsistent||counts.conflitos_status>0) {state='warning';label='Contagens ou status conflitantes: conferir a origem';}
      else if (counts.falhas>0||counts.erros_sincronos>0) {state='warning';label='Há falhas ou rejeições registradas no intervalo';}
      else if (counts.entregues>0) {state='observed';label='Há entregas registradas no intervalo';}
      else if (counts.aceitos>0) {state='warning';label='Há aceites; entrega ainda não confirmada neste recorte';}
      else if (counts.registros>0) {state='warning';label='Há registros, mas nenhum aceite confirmado neste recorte';}
      else if (counts.registros===0) {state='empty';label='Nenhum registro próprio de pedido pago neste recorte';}
    }
    return {state,label,coverage_complete:!!complete,rows_valid:validRows,counts,
      coverage_start:day(start)?start:null,coverage_end:day(end)?end:null,
      last_record_at:timestamps('ultimo_registro_em'),last_status_at:timestamps('ultimo_status_em')};
  }
  function model(api,options={}) {
    if (!object(api)) api={};
    const brand=Object.hasOwn(BRANDS,options.brand)?options.brand:'aristo';
    if (!day(options.ini)||!day(options.fim)||options.ini>options.fim) throw new Error('invalid_period');
    const now=Number.isFinite(options.now)?options.now:Date.now();
    const readFailed=options.readFailed===true;
    const view=control.model(configSnapshot(api.crm_operacao),{now,marca:brand,canal:'whatsapp'});
    const stages={transactional:workflow(view.workflows,brand+'_tx',brand,readFailed),
      motor:workflow(view.workflows,'motor','shared',readFailed),template:template(view.templates,readFailed)};
    const history=metrics(api,brand,options.ini,options.fim);
    const blockers=Object.values(stages).filter(s=>s.state==='blocked');
    const unknown=Object.values(stages).some(s=>s.state==='unknown');
    const state=blockers.length?'blocked':unknown?'unknown':'configured';
    const label=state==='blocked'?'Há impedimento de configuração na coleta atual':state==='unknown'?'Parte da configuração atual não está comprovada':'Configuração básica conferida; envio depende das demais regras';
    return {schema_version:1,kind:'payment_diagnostic',brand,brand_label:BRANDS[brand],
      period:{start:options.ini,end:options.fim,time_zone:'America/Sao_Paulo'},
      evaluated_at:new Date(now).toISOString(),response_received_at:stamp(options.receivedAt),
      read_failed:readFailed,inventory_at:stamp(view.meta.generated_at),configuration:{state,label,stages},history,
      limits:['Configuração atual e histórico do intervalo são evidências distintas.',
        'Uma entrega no intervalo não comprova a entrega de um pedido específico nem que ocorreu após o corte da Reportana.',
        'Este GET agregado não mostra entrada individual da Shopify, elegibilidade, opt-out ou deduplicação.',
        'Última execução retida não comprova fila atual nem entrega. Não reenviar antes de conferir o pedido na origem.']};
  }
  return {model,day};
})(typeof GC!=='undefined'?GC:require('./growth-control.js'),typeof GD!=='undefined'?GD:require('./growth-delivery.js'));
if (typeof module!=='undefined'&&module.exports) module.exports=GDI;
