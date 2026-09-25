/* Bounded Go-template syntax and native-preview envelope. No rendering, eval or transport. */
'use strict';
const GEE=(()=>{
 const LIMITS=Object.freeze({source:200000,actions:1500,action:4096,depth:12,string:4096,items:20,context:40000,envelope:300000,outputBound:1000000});
 const ITEM_FIELDS=new Set(['image','name','price','qty','quantity','title','variant']);
 const DATA_FIELDS=new Set(('address cancel_reason carrier checkout_url coupon_code coupon_heading coupon_text coupon_value cta_text delivered_at delivered_by delivery_estimate e first_name has_discount headline items items_count last_update nps_url order_number order_url p paragraph_1 paragraph_2 paragraph_3 paragraph_4 payment_deadline payment_method preheader refund_method refund_status review_url s shipping_label shipping_name shipping_value status subtotal total tracking_company tracking_number tracking_status tracking_updated_at tracking_url urgency_text urgency_title').split(' '));
 const URL_FIELDS=new Set(['checkout_url','nps_url','order_url','review_url','tracking_url','image']);
 const NUMBER_FIELDS=new Set(['items_count','qty','quantity']);
 const ATTRIBUTES=new Set(['href','src','background','title','alt','aria-label']);
 const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
 const plain=o=>!!o&&typeof o==='object'&&!Array.isArray(o)&&(Object.getPrototypeOf(o)===Object.prototype||Object.getPrototypeOf(o)===null);
 const bad=(code,start=0,end=start)=>{const e=Error(code);e.code=code;e.start=start;e.end=end;throw e;};
 const wellFormed=s=>!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);
 const stringOK=s=>typeof s==='string'&&s.length<=LIMITS.string&&wellFormed(s)&&!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s);
 const err=e=>({code:e.code||'EMAIL_EXPRESSION_INVALID',message:e.code||'EMAIL_EXPRESSION_INVALID',start:e.start||0,end:e.end||e.start||0});
 function quoted(source,start,end){
  let i=start+1,value='';
  while(i<end){
   const c=source[i++];if(c==='"'){if(!stringOK(value))bad('EMAIL_EXPRESSION_STRING',start,i);return {type:'string',value,start,end:i};}
   if(c==='\n'||c==='\r')bad('EMAIL_EXPRESSION_STRING',start,i);
   if(c!=='\\'){value+=c;continue;}
   const esc=source[i++],short={a:'\x07',b:'\b',f:'\f',n:'\n',r:'\r',t:'\t',v:'\v','\\':'\\','"':'"'};
   if(own(short,esc)){value+=short[esc];continue;}
   let digits,base;
   if(esc==='x'||esc==='u'||esc==='U'){const n=esc==='x'?2:esc==='u'?4:8;digits=source.slice(i,i+n);if(digits.length!==n||!/^[0-9a-f]+$/i.test(digits))bad('EMAIL_EXPRESSION_ESCAPE',start,i+n);i+=n;base=16;}
   else if(/[0-7]/.test(esc||'')){digits=esc+source.slice(i,i+2);if(!/^[0-7]{3}$/.test(digits))bad('EMAIL_EXPRESSION_ESCAPE',start,i+2);i+=2;base=8;}
   else bad('EMAIL_EXPRESSION_ESCAPE',start,i);
   // Go byte escapes above ASCII require byte-level UTF-8 interpretation. Reject
   // that unobserved form; Unicode itself and \u/\U remain unambiguous.
   const cp=parseInt(digits,base);if(cp>0x10ffff||cp>=0xd800&&cp<=0xdfff||(base===8||esc==='x')&&cp>127)bad('EMAIL_EXPRESSION_ESCAPE',start,i);value+=String.fromCodePoint(cp);
  }
  bad('EMAIL_EXPRESSION_STRING',start,end);
 }
 function lex(source){
  const actions=[],literals=[];let cursor=0;
  while(cursor<source.length){
   const start=source.indexOf('{{',cursor);if(start<0)break;
   if(actions.length>=LIMITS.actions)bad('EMAIL_EXPRESSION_LIMIT',start);
   let i=start+2,trimLeft=false,trimRight=false;
   if(source[i]==='-'&&/\s/.test(source[i+1]||'')){trimLeft=true;i++;}
   const bodyStart=i,tokens=[];let end=-1;
   while(i<source.length&&i-start<=LIMITS.action){
    if(/\s/.test(source[i])){i++;continue;}
    if(source.startsWith('}}',i)){end=i+2;break;}
    if(source.startsWith('-}}',i)&&/\s/.test(source[i-1]||'')){trimRight=true;end=i+3;break;}
    if(source[i]==='"'){const token=quoted(source,i,Math.min(source.length,start+LIMITS.action));tokens.push(token);literals.push(token);i=token.end;continue;}
    if(source[i]==='|'){tokens.push({type:'pipe',value:'|',start:i,end:++i});continue;}
    const field=source.slice(i).match(/^\.[A-Za-z][A-Za-z0-9_.]*/);
    if(field){tokens.push({type:'field',value:field[0],start:i,end:i+field[0].length});i+=field[0].length;continue;}
    const number=source.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?=\s|\}\})/);
    if(number){const n=Number(number[0]);if(!Number.isFinite(n)||Math.abs(n)>1e12)bad('EMAIL_EXPRESSION_NUMBER',i);const token={type:'number',value:n,start:i,end:i+number[0].length};tokens.push(token);literals.push(token);i=token.end;continue;}
    const word=source.slice(i).match(/^[A-Za-z][A-Za-z0-9_]*/);
    if(word){tokens.push({type:'word',value:word[0],start:i,end:i+word[0].length});i+=word[0].length;continue;}
    bad('EMAIL_EXPRESSION_TOKEN',i,i+1);
   }
   if(end<0)bad(i-start>LIMITS.action?'EMAIL_EXPRESSION_LIMIT':'EMAIL_EXPRESSION_UNCLOSED',start,i);
   if(!tokens.length)bad('EMAIL_EXPRESSION_EMPTY',start,end);
   actions.push({type:'action',start,end,bodyStart,bodyEnd:i,trimLeft,trimRight,tokens});cursor=end;
  }
  return {actions,literals};
 }
 function syntax(source,actions){
  const ast=[],stack=[],fields=new Set(),keys=new Set();let nodes=ast,cursor=0;
  const rangeActive=()=>stack.some(x=>x.kind==='range'&&!x.inElse);
  const field=t=>{
   if(!t||t.type!=='field')bad('EMAIL_EXPRESSION_FIELD',t?.start||0);
   const p=t.value,root=/^\.Tx\.Data\.([A-Za-z][A-Za-z0-9_]{0,63})$/.exec(p),subscriber=/^\.Subscriber\.(Name|UUID)$/.test(p),item=/^\.([a-z]+)$/.exec(p);
   if(root&&['__proto__','constructor','prototype'].includes(root[1]))bad('EMAIL_EXPRESSION_FIELD',t.start,t.end);
   if(root||subscriber){if(rangeActive())bad('EMAIL_EXPRESSION_SCOPE',t.start,t.end);if(root)keys.add(root[1]);}
   else if(!item||!ITEM_FIELDS.has(item[1])||!rangeActive())bad('EMAIL_EXPRESSION_FIELD',t.start,t.end);
   fields.add(p);return {type:'field',path:p,start:t.start,end:t.end};
  };
  function expression(ts,condition=false){
   if(ts.length===1){const value=field(ts[0]);if(!condition&&value.path==='.Tx.Data.items')bad('EMAIL_EXPRESSION_COLLECTION',value.start);return value;}
   if(!condition&&ts.length===3&&ts[0].value==='default'&&['string','number'].includes(ts[1].type)){
    const value=field(ts[2]);if(value.path==='.Tx.Data.items')bad('EMAIL_EXPRESSION_COLLECTION',value.start);return {type:'default',fallback:ts[1],value};
   }
   if(!condition&&ts.length===3&&ts[0].value==='.Tx.Data.first_name'&&ts[1].type==='pipe'&&ts[2].value==='upper')return {type:'upper',value:field(ts[0])};
   if(condition&&ts[0]?.value==='or'&&ts.length>=3&&ts.length<=5)return {type:'or',values:ts.slice(1).map(field)};
   bad('EMAIL_EXPRESSION_UNSUPPORTED',ts[0]?.start||0,ts.at(-1)?.end||0);
  }
  for(const a of actions){
   if(a.start>cursor)nodes.push({type:'text',start:cursor,end:a.start});cursor=a.end;
   const t=a.tokens,head=t[0].value;
   if(head==='if'||head==='range'){
    if(stack.length>=LIMITS.depth)bad('EMAIL_EXPRESSION_DEPTH',a.start,a.end);
    let exp;if(head==='range'){if(rangeActive()||t.length!==2||t[1].value!=='.Tx.Data.items')bad('EMAIL_EXPRESSION_RANGE',a.start,a.end);exp=field(t[1]);}else exp=expression(t.slice(1),true);
    a.kind=head;a.expression=exp;const node={type:head,expression:exp,start:a.start,end:null,body:[],alternate:[]};nodes.push(node);stack.push({kind:head,parent:nodes,node,inElse:false});nodes=node.body;
   }else if(head==='else'){
    const top=stack.at(-1);if(t.length!==1||!top||top.inElse)bad('EMAIL_EXPRESSION_ELSE',a.start,a.end);a.kind='else';top.inElse=true;nodes=top.node.alternate;
   }else if(head==='end'){
    if(t.length!==1||!stack.length)bad('EMAIL_EXPRESSION_END',a.start,a.end);a.kind='end';const top=stack.pop();top.node.end=a.end;nodes=top.parent;
   }else{a.kind='output';a.expression=expression(t);nodes.push({type:'output',expression:a.expression,start:a.start,end:a.end});}
  }
  if(cursor<source.length)nodes.push({type:'text',start:cursor,end:source.length});
  if(stack.length)bad('EMAIL_EXPRESSION_UNCLOSED_CONTROL',stack[0].node.start,source.length);
  return {ast,fields:[...fields],keys:[...keys]};
 }
 // A Go-aware lexical HTML context walk. Static HTML safety remains the consumer's job.
 // Branches must rejoin the same lexical state; native html/template validates escaping again.
 function htmlContexts(source,actions){
  const attributes=[],stack=[];let state={mode:'text'},cursor=0;
  const copy=()=>({...state});
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  function finishTag(){state=state.closing?{mode:'text'}:['style','script'].includes(state.tag)?{mode:'raw',tag:state.tag}:{mode:'text'};}
  function literal(start,end){
   let i=start;
   while(i<end){
    const c=source[i];
    if(state.mode==='comment'){const close=source.indexOf('-->',i);if(close<0||close>=end)return;state={mode:'text'};i=close+3;continue;}
    if(state.mode==='raw'){
     if(source[i]==='<'&&source[i+1]==='/'&&source.slice(i+2,i+2+state.tag.length).toLowerCase()===state.tag&&/[\s>]/.test(source[i+2+state.tag.length]||'')){state={mode:'tagName',tag:'',closing:true};i+=2;continue;}i++;continue;
    }
    if(state.mode==='text'){
     if(source.startsWith('}}',i))bad('EMAIL_EXPRESSION_UNEXPECTED_CLOSE',i,i+2);
     if(c!=='<'){i++;continue;}
     if(source.startsWith('<!--',i)){state={mode:'comment'};i+=4;continue;}
     if(/^<!doctype\b/i.test(source.slice(i,i+10))){state={mode:'declaration',quote:''};i+=2;continue;}
     const closing=source[i+1]==='/';state={mode:'tagName',tag:'',closing};i+=closing?2:1;continue;
    }
    if(state.mode==='declaration'){if(state.quote){if(c===state.quote)state.quote='';}else if(c==='"'||c==="'")state.quote=c;else if(c==='>')state={mode:'text'};i++;continue;}
    if(state.mode==='tagName'){
     if(/[A-Za-z0-9:_-]/.test(c)){state.tag+=c.toLowerCase();i++;continue;}
     if(!/^[a-z][a-z0-9:_-]*$/.test(state.tag))bad('EMAIL_EXPRESSION_HTML',i);
     state.mode='between';continue;
    }
    if(state.mode==='between'){
     if(/\s/.test(c)){i++;continue;}if(c==='>'){finishTag();i++;continue;}if(c==='/'&&source[i+1]==='>'){state={mode:'text'};i+=2;continue;}
     if(state.closing)bad('EMAIL_EXPRESSION_HTML',i);state.mode='attrName';state.attr='';state.attrStart=i;continue;
    }
    if(state.mode==='attrName'){
     if(/[A-Za-z0-9:_.-]/.test(c)){state.attr+=c.toLowerCase();i++;continue;}
     if(!/^[a-z_:][a-z0-9:_.-]*$/.test(state.attr))bad('EMAIL_EXPRESSION_HTML',i);state.mode='afterAttr';continue;
    }
    if(state.mode==='afterAttr'){
     if(/\s/.test(c)){i++;continue;}if(c==='='){state.mode='beforeValue';i++;continue;}state.mode='between';continue;
    }
    if(state.mode==='beforeValue'){
     if(/\s/.test(c)){i++;continue;}state.quote=c==='"'||c==="'"?c:'';state.valueStart=i+(state.quote?1:0);state.mode=state.quote?'quoted':'unquoted';if(state.quote)i++;continue;
    }
    if(state.mode==='quoted'||state.mode==='unquoted'){
     const closed=state.mode==='quoted'?c===state.quote:/[\s>]/.test(c);
     if(closed){attributes.push({tag:state.tag,name:state.attr,start:state.attrStart,end:i+(state.quote?1:0),valueStart:state.valueStart,valueEnd:i,quote:state.quote});state.mode='between';delete state.attr;delete state.attrStart;delete state.valueStart;const quote=state.quote;delete state.quote;if(quote)i++;continue;}
     if(state.mode==='unquoted'&&/["'`=<>]/.test(c))bad('EMAIL_EXPRESSION_HTML',i);i++;continue;
    }
   }
  }
  for(const a of actions){
   literal(cursor,a.start);cursor=a.end;
   if(state.mode!=='text'&&state.mode!=='quoted')bad('EMAIL_EXPRESSION_CONTEXT',a.start,a.end);
   if(state.mode==='quoted'&&(!ATTRIBUTES.has(state.attr)||['meta','link'].includes(state.tag)))bad('EMAIL_EXPRESSION_ATTRIBUTE',a.start,a.end);
   if(a.kind==='range'&&state.mode!=='text')bad('EMAIL_EXPRESSION_RANGE_CONTEXT',a.start,a.end);
   a.context=state.mode==='text'?{type:'text'}:{type:'attribute',tag:state.tag,name:state.attr,valueStart:state.valueStart,quote:state.quote};
   if(a.kind==='if'||a.kind==='range')stack.push({before:copy(),branch:null,kind:a.kind});
   else if(a.kind==='else'){const top=stack.at(-1);top.branch=copy();state={...top.before};}
   else if(a.kind==='end'){
    const top=stack.pop(),expected=top.branch||top.before;if(!same(state,expected)||top.kind==='range'&&!same(state,top.before))bad('EMAIL_EXPRESSION_BRANCH_CONTEXT',a.start,a.end);
   }
  }
  literal(cursor,source.length);if(state.mode!=='text')bad('EMAIL_EXPRESSION_HTML',source.length);
  return attributes;
 }
 function parse(source,{html=false}={}){
  const empty={ok:false,ast:[],actions:[],fields:[],keys:[],errors:[],safetySource:'',attributes:[],literals:[]};
  try{
   if(typeof source!=='string'||source.length>LIMITS.source||!wellFormed(source)||source.includes('\0'))bad('EMAIL_EXPRESSION_SOURCE');
   const {actions,literals}=lex(source),parsed=syntax(source,actions),attributes=html?htmlContexts(source,actions):[];
   if(!html){let i=0;for(const a of actions){if(source.slice(i,a.start).includes('}}'))bad('EMAIL_EXPRESSION_UNEXPECTED_CLOSE',i,a.start);a.context={type:'text'};i=a.end;}if(source.slice(i).includes('}}'))bad('EMAIL_EXPRESSION_UNEXPECTED_CLOSE',i,source.length);}
   let cursor=0,safetySource='';for(const a of actions){safetySource+=source.slice(cursor,a.start)+'x'.repeat(a.end-a.start);cursor=a.end;}safetySource+=source.slice(cursor);
   return {ok:true,...parsed,actions,errors:[],safetySource,attributes,literals};
  }catch(e){return {...empty,errors:[err(e)]};}
 }
 function safeURL(s){
  if(s==='')return true;
  if(!stringOK(s)||/[\s\\<>"'`{}]/.test(s)||!/^https:\/\//i.test(s))return false;
  // Preview data uses canonical HTTPS DNS destinations only. Do not depend on
  // URL being exposed by n8n's Code sandbox (or silently accept credentials).
  const m=/^https:\/\/([a-z0-9.-]+)(?::443)?(?:[/?#].*)?$/i.exec(s);
  if(!m||m[1].length>253||!m[1].includes('.')||/%(?![0-9a-f]{2})/i.test(s))return false;
  return m[1].split('.').every(label=>label.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
 }
 function validateContext(context){
  try{
   if(!plain(context)||Object.keys(context).some(k=>!['Tx','Subscriber'].includes(k))||!plain(context.Tx)||Object.keys(context.Tx).some(k=>k!=='Data')||!plain(context.Tx.Data)||!plain(context.Subscriber)||Object.keys(context.Subscriber).some(k=>!['Name','UUID'].includes(k)))bad('EMAIL_CONTEXT_SHAPE');
   const data={},subscriber={};
   function scalar(k,v){
    if(v===null)return null;
    if(k==='has_discount'){if(typeof v!=='boolean')bad('EMAIL_CONTEXT_TYPE');return v;}
    if(NUMBER_FIELDS.has(k)){if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0||v>1000000)bad('EMAIL_CONTEXT_TYPE');return v;}
    if(!stringOK(v))bad('EMAIL_CONTEXT_TYPE');if(URL_FIELDS.has(k)&&!safeURL(v))bad('EMAIL_CONTEXT_URL');return v;
   }
   for(const [k,v] of Object.entries(context.Tx.Data)){
    if(!DATA_FIELDS.has(k))bad('EMAIL_CONTEXT_FIELD');
    if(k==='items'){
     if(!Array.isArray(v)||v.length>LIMITS.items)bad('EMAIL_CONTEXT_ITEMS');data.items=v.map(item=>{if(!plain(item))bad('EMAIL_CONTEXT_ITEMS');const out={};for(const [key,value]of Object.entries(item)){if(!ITEM_FIELDS.has(key))bad('EMAIL_CONTEXT_FIELD');out[key]=scalar(key,value);}return out;});
    }else data[k]=scalar(k,v);
   }
   for(const [k,v] of Object.entries(context.Subscriber)){
    if(typeof v!=='string'||!stringOK(v)||k==='Name'&&v.length>200||k==='UUID'&&v!==''&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))bad('EMAIL_CONTEXT_SUBSCRIBER');subscriber[k]=v;
   }
   const value={Tx:{Data:data},Subscriber:subscriber};if(JSON.stringify(value).length>LIMITS.context)bad('EMAIL_CONTEXT_LIMIT');return {ok:true,value,errors:[]};
  }catch(e){return {ok:false,value:null,errors:[err(e)]};}
 }
 function encodeLiteral(value){if(!stringOK(value))bad('EMAIL_CONTEXT_STRING');return JSON.stringify(value);}
 function buildPreviewEnvelope(source,context){
  const parsed=parse(source,{html:true});if(!parsed.ok)bad(parsed.errors[0].code,parsed.errors[0].start,parsed.errors[0].end);
  const checked=validateContext(context);if(!checked.ok)bad(checked.errors[0].code);
  for(const path of parsed.fields){
   if(path.startsWith('.Tx.Data.')&&!DATA_FIELDS.has(path.slice(9)))bad('EMAIL_CONTEXT_FIELD');
   if(path.startsWith('.Subscriber.')&&!own(checked.value.Subscriber,path.slice(12)))bad('EMAIL_CONTEXT_SUBSCRIBER_REQUIRED');
  }
  // This is a conservative size bound, never a second implementation of Go's
  // truthiness/default/rendering. Count both possible branches by their maximum,
  // and every bounded item; native compilation/rendering still decides output.
  const fieldSize=(path,item)=>{
   const v=path.startsWith('.Tx.Data.')?checked.value.Tx.Data[path.slice(9)]:path.startsWith('.Subscriber.')?checked.value.Subscriber[path.slice(12)]:item?.[path.slice(1)];
   return v===null||v===undefined?16:String(v).length;
  };
  const expSize=(exp,item)=>exp.type==='field'?fieldSize(exp.path,item):exp.type==='default'?Math.max(String(exp.fallback.value).length,expSize(exp.value,item)):exp.type==='upper'?2*expSize(exp.value,item):0;
  const bound=(nodes,item)=>nodes.reduce((sum,n)=>sum+(n.type==='text'?3*(n.end-n.start):n.type==='output'?12*expSize(n.expression,item):n.type==='if'?Math.max(bound(n.body,item),bound(n.alternate,item)):n.type==='range'?Math.max((checked.value.Tx.Data.items||[]).reduce((size,row)=>size+bound(n.body,row),0),bound(n.alternate,item)):0),0);
  if(bound(parsed.ast,null)>LIMITS.outputBound)bad('EMAIL_CONTEXT_OUTPUT_LIMIT');
  const go=v=>v===null?'nil':typeof v==='string'?encodeLiteral(v):typeof v==='boolean'||typeof v==='number'?String(v):Array.isArray(v)?'(list'+(v.length?' '+v.map(go).join(' '):'')+')':'(dict'+Object.entries(v).map(([k,value])=>' '+encodeLiteral(k)+' '+go(value)).join('')+')';
  const body='{{ with '+go(checked.value)+' }}'+source+'{{ end }}';if(body.length>LIMITS.envelope)bad('EMAIL_CONTEXT_LIMIT');return body;
 }
 return {parse,validateContext,buildPreviewEnvelope,encodeLiteral,LIMITS};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GEE;
