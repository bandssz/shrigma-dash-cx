'use strict';
/* Pure backend shape adapter for the existing cx/cache and organico-links reads.
 * Root injects the real OrganicContractV102 and already-authorized source data.
 * projectRead({query,context,payload,observation?}) returns the gateway.read DTO.
 * Optional observation is a PRIVATE Root read header: existing resource/filters,
 * contextRevision/brandId and source/coverage/freshness/collectedAt/cacheAt/state.
 * It must describe this exact read. Missing header means unknown, never proof.
 * Structural projection is not IAM, installation, source custody or admission.
 * No IO, clocks, callbacks, IDs, journals, transport, writes or per-order output.
 */
const VERSION='1.0.2-proposed';
const BRANDS=Object.freeze({aristo:'aristo',aristocrata:'aristo',fish:'fish',fishermans:'fish',olivas:'olivas'});
const SOURCES=Object.freeze(['own_verified','own_declared','derived','market_estimated','unknown']);
const RESOURCES=Object.freeze(['posts','stories','attribution-aggregate','links']);
const DAILY_TEXT=Object.freeze(['source_system','currency','classification','rule_version','rule_reason','rede','superficie','utm_source','utm_medium','utm_campaign','utm_content','utm_term','utm_provenance','piece_status']);
const QUALITY_COUNTS=Object.freeze(['pedidos_lidos','pagos_elegiveis','jornada_pendente','jornada_parcial','ultima_sessao_conhecida','ultima_sessao_desconhecida','origem_nao_direta_desconhecida']);
const SOCIAL_METRICS=Object.freeze({reach:'alcance',impressions:'impressoes',views:'visualizacoes',plays:'reproducoes',likes:'curtidas',comments:'comentarios',saves:'salvos',shares:'compartilh',replies:'respostas',linkClicks:'link_clicks',exits:'saidas',follows:'seguidores'});
const metadata=Object.freeze({version:VERSION,sourceOnly:true,operational:false,readAdmission:false,writeAuthorized:false,sendAuthorized:false,perOrderSupported:false});
const has=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max=300)=>typeof v==='string'?v.slice(0,max):null;
const id=v=>(typeof v==='string'&&v.trim()!=='')||(typeof v==='number'&&Number.isSafeInteger(v));
const brand=v=>typeof v==='string'&&has(BRANDS,v)?BRANDS[v]:null;
const count=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:typeof v==='string'&&/^(0|[1-9]\d*)$/.test(v)&&Number.isSafeInteger(Number(v))?Number(v):null;
const decimal=v=>typeof v==='string'&&/^-?\d{1,15}(\.\d{1,6})?$/.test(v)?v:typeof v==='number'&&Number.isSafeInteger(v)&&/^-?\d{1,15}$/.test(String(v))?String(v):null;
const currency=v=>typeof v==='string'&&/^[A-Z]{3}$/.test(v)?v:null;
function day(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;const n=Date.parse(v+'T12:00:00Z');return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===v;}
function stamp(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(v)||!day(v.slice(0,10))||!Number.isFinite(Date.parse(v)))return null;return v;}
const dateBR=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'});
function publicationDay(value){if(!stamp(value))return null;const parts=dateBR.formatToParts(new Date(value));const get=k=>parts.find(x=>x.type===k).value;return get('year')+'-'+get('month')+'-'+get('day');}
function dense(v){if(!Array.isArray(v)||v.length>100000)return false;for(let i=0;i<v.length;i++)if(!has(v,i))return false;return true;}
function freeze(v){if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const k of Object.keys(v))freeze(v[k]);Object.freeze(v);}return v;}
function https(v){if(typeof v!=='string'||v.length>2000||/[\s<>"'\x00-\x1f]/.test(v))return null;try{const u=new URL(v);return u.protocol==='https:'&&u.hostname&&!u.username&&!u.password?v:null;}catch{return null;}}
function base(ctx){return{state:'unavailable',contextRevision:ctx?.contextRevision??null,brandId:ctx?.effectiveBrand??null,source:'unknown',coverage:'unknown',collectedAt:null,cacheAt:null,freshness:'unknown',data:null,error:'Fonte de leitura indisponível para este recorte.'};}
function closed(ctx,message='Fonte de leitura indisponível para este recorte.',state='unavailable'){return freeze({...base(ctx),state,error:message});}
function createProjection({normalizer}={}){
 if(!normalizer||normalizer.version!==VERSION||!['normalizeFilters','normalizeContext','normalizeRead','normalizeLink'].every(k=>typeof normalizer[k]==='function'))throw new TypeError('ORGANIC_READ_NORMALIZER_REQUIRED');
 function header(observation,q,ctx){
  const empty={source:'unknown',coverage:'unknown',freshness:'unknown',collectedAt:null,cacheAt:null};
  if(observation===null||observation===undefined)return{meta:empty,state:null};
  if(!obj(observation)||!['resource','filters','contextRevision','brandId'].every(k=>has(observation,k))||observation.resource!==q.resource||observation.contextRevision!==ctx.contextRevision||observation.brandId!==ctx.effectiveBrand)return null;
  const f=normalizer.normalizeFilters({resource:observation.resource,filters:observation.filters});
  if(f.state!=='valid'||JSON.stringify(f.value)!==JSON.stringify(q))return null;
  // Only this read's own metadata can supply evidence. Prototype properties
  // (including getters) never confirm absence, freshness, dates or source state.
  const state=has(observation,'state')?observation.state:undefined;
  if(state!==undefined&&!['ready','empty','unavailable','forbidden'].includes(state))return null;
  return{meta:{source:has(observation,'source')&&SOURCES.includes(observation.source)?observation.source:'unknown',coverage:has(observation,'coverage')&&['complete','partial','unknown'].includes(observation.coverage)?observation.coverage:'unknown',freshness:has(observation,'freshness')&&['fresh','stale','unknown'].includes(observation.freshness)?observation.freshness:'unknown',collectedAt:stamp(has(observation,'collectedAt')?observation.collectedAt:null),cacheAt:stamp(has(observation,'cacheAt')?observation.cacheAt:null)},state:state==='forbidden'?'forbidden':has(observation,'error')&&observation.error!==null?'unavailable':state??null};
 }
 function scoped(row,q,ctx,dateField){
  if(!obj(row)||!has(row,'marca')||!has(row,dateField))return'invalid';const b=brand(row.marca);if(!b)return'invalid';if(b!==ctx.effectiveBrand)return'excluded';
  const d=dateField==='publicado_em'?publicationDay(row.publicado_em):row[dateField];
  if(!day(d))return'invalid';if(dateField==='publicado_em'&&has(row,'dia')&&row.dia!==null&&row.dia!==d)return'invalid';
  return d<q.filters.period.from||d>q.filters.period.to?'excluded':'selected';
 }
 function collection(rows,q,ctx,selector,mapper){
  if(!dense(rows))return null;const items=[],seen=new Set();let dropped=0;
  for(const row of rows){const state=selector(row,q,ctx);if(state==='excluded')continue;if(state!=='selected'){dropped++;continue;}const item=mapper(row,q,ctx);if(!item){dropped++;continue;}if(has(item,'id')){const key=String(item.id);if(seen.has(key))return null;seen.add(key);}items.push(item);}
  return{items,dropped};
 }
 function social(payload,q,ctx){
  const field=q.resource==='posts'?'cx_post':'cx_story',identity=q.resource==='posts'?'post_id':'story_id';
  if(!has(payload,field))return null;let paidClassificationUnknown=false;
  const result=collection(payload[field],q,ctx,(row,query,c)=>{const s=scoped(row,query,c,'publicado_em');if(s!=='selected'||q.resource!=='posts')return s;if(row.impulsionado===true)return'excluded';if(row.impulsionado!==undefined&&row.impulsionado!==null&&row.impulsionado!==false)return'invalid';if(row.impulsionado===undefined||row.impulsionado===null)paidClassificationUnknown=true;return s;},row=>{
   if(!has(row,identity)||!id(row[identity]))return null;
   const metrics={};for(const [key,source]of Object.entries(SOCIAL_METRICS))metrics[key]=count(row[source]);
   // Both explicit spellings occur in public legacy source/fixtures. Conflicting
   // values stay unknown; absent aliases never produce zero or a derived score.
   if(has(row,'compartilhamentos')){const alt=count(row.compartilhamentos);metrics.shares=has(row,'compartilh')&&metrics.shares!==alt?null:alt;}
   const item={id:row[identity],provider:text(row.rede,60),brandId:ctx.effectiveBrand,publishedAt:stamp(row.publicado_em),source:SOURCES.includes(row.source)?row.source:'unknown',metrics};
   if(q.resource==='posts'){item.title=text(row.legenda);item.kind=text(row.formato??row.tipo,60);}else item.expiresAt=stamp(row.expira_em);return item;
  });
  return result&&{data:{items:result.items},dropped:result.dropped+(paidClassificationUnknown?1:0),empty:result.items.length===0};
 }
 function attribution(payload,q,ctx){
  if(!has(payload,'organico_attribution'))return null;const p=payload.organico_attribution;if(!obj(p)||!has(p,'schema_version')||p.schema_version!==1)return null;
  if(has(p,'janela')&&(!obj(p.janela)||p.janela.ini!==q.filters.period.from||p.janela.fim!==q.filters.period.to))return null;
  if(!has(p,'daily')||!dense(p.daily))return null;
  const selected=collection(p.daily,q,ctx,(r,query,c)=>{const s=scoped(r,query,c,'dia');if(s!=='selected')return s;if(!['last_click','last_non_direct'].includes(r.model))return'invalid';return r.model===query.filters.model?'selected':'excluded';},r=>{
   const out={marca:ctx.effectiveBrand,dia:r.dia,model:r.model};for(const k of DAILY_TEXT)out[k]=text(r[k]);out.currency=currency(r.currency);out.detail_level=['utm','channel_summary'].includes(r.detail_level)?r.detail_level:null;out.utm_raw_available=typeof r.utm_raw_available==='boolean'?r.utm_raw_available:null;out.pedidos=count(r.pedidos);out.receita_liquida=decimal(r.receita_liquida);out.leitura_mais_antiga=stamp(r.leitura_mais_antiga);out.coletado_em=stamp(r.coletado_em);return out;
  });if(!selected)return null;
  let dropped=selected.dropped;
  function auxiliary(rows,mapper){if(rows===undefined||rows===null){dropped++;return null;}const r=collection(rows,q,ctx,(x,query,c)=>scoped(x,query,c,'dia'),mapper);if(!r)return false;dropped+=r.dropped;return r.items;}
  const quality=auxiliary(has(p,'quality')?p.quality:null,r=>{const out={marca:ctx.effectiveBrand,dia:r.dia};for(const k of QUALITY_COUNTS)out[k]=count(r[k]);out.receita_elegivel=decimal(r.receita_elegivel);out.leitura_mais_antiga=stamp(r.leitura_mais_antiga);out.coletado_em=stamp(r.coletado_em);return out;});
  const coverage=auxiliary(has(p,'coverage')?p.coverage:null,r=>({marca:ctx.effectiveBrand,dia:r.dia,checked_at:stamp(r.checked_at)}));if(quality===false||coverage===false)return null;
  let cur=currency(p.currency);if(cur&&selected.items.some(r=>r.currency!==null&&r.currency!==cur)){cur=null;dropped++;}
  return{data:{period:{...q.filters.period},model:q.filters.model,currency:cur,window:{days:count(p.window_days),ruleVersion:text(p.rule_version,120),sourceSystem:text(p.source_system,120),utmRawAvailable:typeof p.utm_raw_available==='boolean'?p.utm_raw_available:null,assistanceAvailable:typeof p.assistance_available==='boolean'?p.assistance_available:null,pieceIdentityAvailable:typeof p.piece_identity_available==='boolean'?p.piece_identity_available:null},daily:selected.items,quality,coverage,perOrder:null},dropped,empty:selected.items.length===0&&quality!==null&&coverage!==null&&quality.length===0&&coverage.length===0};
 }
 function links(payload,q,ctx){
  if(!has(payload,'links'))return null;
  const r=collection(payload.links,q,ctx,(x,query,c)=>scoped(x,query,c,'dia'),row=>{
   if(!has(row,'id')||!id(row.id))return null;
   const item={id:row.id,brandId:ctx.effectiveBrand,destination:https(row.destino),url:https(row.url),origin:text(row.utm_source,120),surface:text(row.utm_medium,120),state:row.arquivado===true?'archived':row.arquivado===false?'active':'unknown',revision:typeof row.revision==='string'&&row.revision.trim()&&row.revision!=='0'?row.revision:typeof row.revision==='number'&&Number.isSafeInteger(row.revision)&&row.revision>0?row.revision:null,createdAt:stamp(row.criado_em)};
   const checked=normalizer.normalizeLink(item,ctx.effectiveBrand);return checked.state==='valid'?item:null;
  });
  // The existing SQL listar hides archived records. It cannot prove completeness
  // of the typed historical collection, even when this active snapshot is fresh.
  return r&&{data:{items:r.items},dropped:r.dropped,empty:r.items.length===0,partial:true};
 }
 function projectRead(args){
  let ctx=null;
  try{
   if(!obj(args))return closed(null);const nctx=normalizer.normalizeContext(args.context);if(nctx.state!=='valid')return closed(null);
   ctx=nctx.value;if(!has(BRANDS,ctx.effectiveBrand)||BRANDS[ctx.effectiveBrand]!==ctx.effectiveBrand)return closed(ctx,'Marca efetiva não confirmada para esta leitura.','forbidden');
   const filters=normalizer.normalizeFilters(args.query);if(filters.state!=='valid'||!obj(args.query)||args.query.expectedContextRevision!==ctx.contextRevision)return closed(ctx,'Consulta não confirmada para esta marca, período e revisão.');
   const q=filters.value;if(!RESOURCES.includes(q.resource))return closed(ctx,'Este recurso não possui leitura admitida neste adaptador.');
   const h=header(args.observation,q,ctx);if(!h)return closed(ctx,'Observação da leitura não corresponde a este recorte.');
   if(h.state==='forbidden')return closed(ctx,'Acesso à fonte recusado para esta marca.','forbidden');if(h.state==='unavailable')return closed(ctx);
   const p=args.payload;if(!obj(p)||p.ok===false||(has(p,'erro')&&p.erro!==null)||(has(p,'error')&&p.error!==null))return closed(ctx);
   const result=q.resource==='posts'||q.resource==='stories'?social(p,q,ctx):q.resource==='attribution-aggregate'?attribution(p,q,ctx):links(p,q,ctx);if(!result)return closed(ctx);
   if(h.state==='empty'&&!result.empty)return closed(ctx);
   const meta={...h.meta};if(result.dropped>0||result.partial)meta.coverage=meta.coverage==='unknown'?'unknown':'partial';
   // Complete stale/unknown empty data cannot assert absence in the current read.
   if(result.empty&&(meta.coverage!=='complete'||meta.freshness!=='fresh'||result.dropped>0))return closed(ctx,'Não há dados confirmados para este recorte; cobertura ou frescor indisponíveis.');
   const envelope={...base(ctx),...meta,state:result.empty?'empty':'ready',data:result.empty?{items:[]}:result.data,error:null};
   const valid=normalizer.normalizeRead(args.query,envelope,args.context);if(valid.state!=='valid')return closed(ctx);
   // Return the allowlisted envelope, not normalized presentation derivatives or
   // opaque raw input. Consumer applies the same injected normalizer normally.
   return freeze(envelope);
  }catch{return closed(ctx);}
 }
 return Object.freeze({projectRead});
}
module.exports=Object.freeze({createProjection,metadata});
