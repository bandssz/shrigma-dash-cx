'use strict';
// PRIVATE candidate (agente N, 2026-10-03). Carregar este módulo não faz I/O.
// Validador estrito da resposta de biblioteca de mídia (contrato crm-media-v1,
// GET <campaign path>/media?brand&page&per_page de services/crm-campaign/media.cjs)
// para a ponte READ do portal (crm-manager-read-bridge.cjs, #214, rota
// campaigns_media). Autocontido: não requer media.cjs (a imagem do BFF não
// contém crm-campaign); as regras de nome canônico são as mesmas e o teste
// confere a equivalência.
//
// Política de legado (decisão documentada em PARIDADE-LEITURA-PORTAL §9):
// arquivo sem nome canônico crm-<marca>-<uuid>-<sha256>.<ext> não pertence a
// marca nenhuma. O serviço o mostra nas duas marcas; aqui ele sai com
// legacy:true (ou é retirado com legacy:'exclude') e NUNCA é contado como da
// marca. Nome canônico de outra marca é violação de contrato: a resposta
// inteira é recusada (o filtro por marca do serviço não está ativo). A marca
// também é lida no nome da url e da miniatura (thumb_url): ver BRAND_MARK.
const ALLOWED_ORIGIN='https://email.shrigma.com.br';
const BRANDS=Object.freeze(['fish','aristo']);
const TYPES=Object.freeze({'image/png':['png'],'image/jpeg':['jpg','jpeg'],'image/gif':['gif']});
const CANONICAL_EXT=Object.freeze({png:'image/png',jpg:'image/jpeg',gif:'image/gif'});
const ITEM_KEYS=Object.freeze(['id','filename','url','thumb_url','content_type','width','height','created_at']);
const BODY_KEYS=Object.freeze(['contract','brand','items','total','page','per_page','next_page']);
const MAX_PER_PAGE=50,DEFAULT_PER_PAGE=24,MAX_PAGE=10000,MAX_TOTAL=1000000,MAX_PIXELS=4*1024*1024,MAX_URL=2048,MAX_FILENAME=180;
// media.cjs MEDIA_LIST_SCAN_PAGES: uma página nativa só com arquivos da outra
// marca é pulada, no máximo 4 páginas por pedido. Por isso page pode avançar
// até page+3 em relação ao pedido.
const SCAN_PAGES=4;
const UUID4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL=/^crm-(fish|aristo)-([0-9a-fA-F-]{36})-([0-9a-f]{64})[.](png|jpg|gif)$/;
// Prefixo de marca sem nome canônico (inclui olivas e caixa diferente): não é
// legado neutro, parece de uma marca. Só fica se a marca for a pedida.
const BRAND_PREFIX=/^crm-(fish|aristo|olivas)-/i;
// Marca em QUALQUER ponto do nome de um arquivo do item (filename, url e
// thumb_url decodificados), ex.: thumb_crm-aristo-<uuid>-<sha>.png. Serve para
// achar arquivo de outra marca escondido na miniatura ou na URL.
const BRAND_MARK=/crm-(fish|aristo|olivas)-/gi;
const marks=name=>[...name.matchAll(BRAND_MARK)].map(m=>m[1].toLowerCase());
class MediaReadValidationError extends Error{constructor(code){super(code);this.code=code;this.status=502;}}
const deny=(code='MEDIA_READ_RESPONSE_DENIED')=>{throw new MediaReadValidationError(code);};
function plain(v){return !!v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype;}
function record(v,keys){return plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return !!d&&Object.hasOwn(d,'value')&&d.enumerable;});}
const int=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
function filenameParts(name){const m=CANONICAL.exec(typeof name==='string'?name:'');return m&&UUID4.test(m[2])?{brand:m[1],operation_id:m[2],sha256:m[3],ext:m[4]}:null;}
// Pedido canônico de listagem (o mesmo que mediaGet aceita). Recuperação de
// upload (operation_id/filename/sha256) é caminho de escrita e fica fora.
function mediaRequest(query){
 if(!(query instanceof URLSearchParams))deny('MEDIA_READ_REQUEST_INVALID');
 const keys=[...query.keys()];
 if(new Set(keys).size!==keys.length||keys.some(k=>!['brand','page','per_page'].includes(k)))deny('MEDIA_READ_REQUEST_INVALID');
 const brand=query.get('brand');if(!BRANDS.includes(brand))deny('MEDIA_READ_REQUEST_INVALID');
 const page=query.has('page')?query.get('page'):'1',perPage=query.has('per_page')?query.get('per_page'):String(DEFAULT_PER_PAGE);
 if(!/^[1-9][0-9]{0,4}$/.test(page)||Number(page)>MAX_PAGE||!/^[1-9][0-9]?$/.test(perPage)||Number(perPage)>MAX_PER_PAGE)deny('MEDIA_READ_REQUEST_INVALID');
 return Object.freeze({brand,page:Number(page),per_page:Number(perPage),query:new URLSearchParams([['brand',brand],['page',page],['per_page',perPage]])});
}
// URL pública de upload: https, host exato, sem userinfo/porta/query/hash,
// texto já canônico (sem "?" vazio), um único segmento sob /uploads/.
// Falha aqui é de segurança (recusa a resposta inteira); a extensão é
// conferida à parte porque legado irregular só sai da lista.
function uploadUrl(raw,host){
 if(typeof raw!=='string'||raw.length>MAX_URL||/[\s<>"'\\?#]/.test(raw))return null;
 let u;try{u=new URL(raw);}catch{return null;}
 if(u.href!==raw||u.protocol!=='https:'||u.hostname!==host||u.port||u.username||u.password||u.search||u.hash)return null;
 const m=/^\/uploads\/([^/]+)$/.exec(u.pathname);if(!m||/%(?:2f|5c|00)/i.test(m[1]))return null;
 let name;try{name=decodeURIComponent(m[1]);}catch{return null;}
 if(name==='.'||name==='..'||/[/\\\u0000-\u001f\u007f]/.test(name))return null;
 return {name,ext:/[.]([A-Za-z0-9]+)$/.exec(name)?.[1].toLowerCase()||''};
}
function hasSecret(text,secrets){const lower=text.toLowerCase();return secrets.some(s=>s&&lower.includes(s.toLowerCase()));}
function validateMediaLibraryResponse(body,{brand,page,per_page:perPage,allowedOrigin=ALLOWED_ORIGIN,legacy='mark',secrets=[]}={}){
 if(!BRANDS.includes(brand)||!int(page,1,MAX_PAGE)||!int(perPage,1,MAX_PER_PAGE)||!['mark','exclude'].includes(legacy)||!Array.isArray(secrets)||secrets.some(s=>typeof s!=='string'))deny('MEDIA_READ_VALIDATOR_CONFIG');
 let origin;try{origin=new URL(allowedOrigin);}catch{deny('MEDIA_READ_VALIDATOR_CONFIG');}
 if(origin.protocol!=='https:'||origin.origin!==allowedOrigin||origin.username||origin.password||origin.port)deny('MEDIA_READ_VALIDATOR_CONFIG');
 if(!record(body,BODY_KEYS)||body.contract!=='crm-media-v1'||body.brand!==brand||!Array.isArray(body.items))deny();
 // Eco de credencial em qualquer ponto do corpo recusa tudo.
 let text;try{text=JSON.stringify(body);}catch{deny();}
 if(hasSecret(text,secrets))deny('MEDIA_READ_SECRET_ECHO');
 // Paginação coerente com o pedido e com o scan limitado do serviço.
 const {total,page:got,per_page:per,next_page:next,items}=body;
 if(!int(total,0,MAX_TOTAL)||!int(got,page,Math.min(MAX_PAGE,page+SCAN_PAGES-1))||per!==perPage||items.length>per)deny('MEDIA_READ_PAGE_INVALID');
 if(next!==(got*per<total?got+1:null))deny('MEDIA_READ_PAGE_INVALID');
 if(items.length&&(got-1)*per>=total)deny('MEDIA_READ_PAGE_INVALID');
 // Página vazia com continuação só é coerente quando o scan esgotou as 4 páginas.
 if(!items.length&&next!==null&&got<page+SCAN_PAGES-1)deny('MEDIA_READ_PAGE_INVALID');
 if(total===0&&(got!==page||next!==null))deny('MEDIA_READ_PAGE_INVALID');
 const ids=new Set(),out=[],summary={brand_items:0,legacy_items:0,excluded_legacy:0,excluded_foreign_prefix:0,excluded_irregular:0};
 for(const item of items){
  if(!record(item,ITEM_KEYS)||!int(item.id,1,2147483647)||ids.has(item.id))deny('MEDIA_READ_ITEM_INVALID');
  ids.add(item.id);
  const {filename:name,content_type:type,width,height}=item;
  if(typeof name!=='string'||!name.length||name.length>MAX_FILENAME||/[/\\\u0000-\u001f\u007f]/.test(name))deny('MEDIA_READ_ITEM_INVALID');
  if(!Object.hasOwn(TYPES,type)||!int(width,1,MAX_PIXELS)||!int(height,1,MAX_PIXELS)||width*height>MAX_PIXELS)deny('MEDIA_READ_ITEM_INVALID');
  if(item.created_at!==null&&(typeof item.created_at!=='string'||item.created_at.length>64||!Number.isFinite(Date.parse(item.created_at))))deny('MEDIA_READ_ITEM_INVALID');
  const url=uploadUrl(item.url,origin.hostname);if(!url)deny('MEDIA_READ_URL_DENIED');
  const thumb=item.thumb_url===null?null:uploadUrl(item.thumb_url,origin.hostname);
  if(item.thumb_url!==null&&!thumb)deny('MEDIA_READ_URL_DENIED');
  const extOk=TYPES[type].includes(url.ext);
  const parts=filenameParts(name);
  // Marca de cada arquivo apontado pelo item (url e miniatura) e do filename.
  const fileNames=[name,url.name,...(thumb?[thumb.name]:[])];
  // uploadUrl already decodes the admitted single filename segment. Check
  // that same decoded text before filtering any item; an echo poisons the page.
  if(fileNames.some(file=>hasSecret(file,secrets)))deny('MEDIA_READ_SECRET_ECHO');
  const fileMarks=fileNames.flatMap(marks),foreignFile=fileMarks.some(b=>b!==brand);
  if(parts){
   // Nome canônico: a marca é a do nome. Outra marca = filtro do serviço ausente.
   // Vale também para url e miniatura: arquivo de outra marca recusa a página.
   if(parts.brand!==brand||foreignFile)deny('MEDIA_READ_FOREIGN_BRAND');
   // Miniatura sem marca (legado) em item canônico: o legado não pertence a
   // marca nenhuma e não vira da marca por estar na miniatura. Recusa a página.
   if(thumb&&!marks(thumb.name).includes(brand))deny('MEDIA_READ_THUMB_DENIED');
   if(CANONICAL_EXT[parts.ext]!==type||url.name!==name||!extOk)deny('MEDIA_READ_ITEM_INVALID');
   summary.brand_items++;out.push({...pick(item),legacy:false});continue;
  }
  const prefix=BRAND_PREFIX.exec(name);
  // Legado com arquivo de outra marca no nome, na url ou na miniatura: sai da
  // lista como o prefixo de outra marca (o legado aparece nas duas marcas).
  if(prefix&&prefix[1].toLowerCase()!==brand||foreignFile){summary.excluded_foreign_prefix++;continue;}
  // Legado: a URL precisa apontar para o próprio arquivo, com extensão do
  // tipo declarado (o painel só prevê png/jpg/gif); senão sai da lista.
  if(url.name!==name||!extOk){summary.excluded_irregular++;continue;}
  if(legacy==='exclude'){summary.excluded_legacy++;continue;}
  summary.legacy_items++;out.push({...pick(item),legacy:true});
 }
 return Object.freeze({body:{contract:'crm-media-v1',brand,items:out,total,page:got,per_page:per,next_page:next},summary:Object.freeze(summary)});
}
function pick(item){return Object.fromEntries(ITEM_KEYS.map(k=>[k,item[k]]));}
module.exports={validateMediaLibraryResponse,mediaRequest,filenameParts,MediaReadValidationError,ALLOWED_ORIGIN,ITEM_KEYS,BODY_KEYS,SCAN_PAGES,MAX_PER_PAGE,DEFAULT_PER_PAGE};
