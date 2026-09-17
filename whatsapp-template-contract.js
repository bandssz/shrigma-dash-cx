'use strict';
const WAT={
 vars:s=>[...new Set([...String(s||'').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(m=>+m[1]))].sort((a,b)=>a-b),
 isPix:r=>/^pix(?:-|_|$)/i.test(r.peca||r.piece||'')||/(?:^|_)pix(?:_|$)/i.test(r.nome||'')||/c[oó]digo\s+pix|pix\s+copia/i.test(r.corpo||''),
 card:r=>(r.botoes||[]).some(b=>b.tipo==='order_details'),
 urlError(value){
  const s=String(value||'');
  if(!/^https:\/\/[a-z0-9.-]+(?::443)?(?:[/?#]|$)/i.test(s)||/[\s<>"'\\\u0000-\u001f]/.test(s))return 'Use um link HTTPS válido, sem espaços ou credenciais.';
  const vars=WAT.vars(s);
  if((s.includes('{{')||s.includes('}}'))&&(vars.length!==1||vars[0]!==1||!s.endsWith('{{1}}')||s.split('{{1}}').length!==2))return 'O link dinâmico aceita apenas {{1}}, uma vez, no final da URL.';
  return null;
 },
 warnings(r){
  if(r?.canal!=='whatsapp')return [];
  const text=String(r.corpo||''),out=[];
  if(text.length>500)out.push({codigo:'READABILITY',mensagem:'Prefira uma mensagem curta, com uma ação principal e detalhes no link do pedido.'});
  if(/apenas \d+ unidades|poucas unidades|posso cancelar|não posso segurar|transportadora já retirou/i.test(text))out.push({codigo:'VERIFY_CLAIM',mensagem:'Confirme que estoque, cancelamento ou retirada pela transportadora são comprovados pelo evento que dispara esta mensagem.'});
  if(/me chama|me chame|responder a esta mensagem/i.test(text)&&!(r.botoes||[]).some(b=>b.tipo==='url'&&/\/suporte(?:[/?#]|$)/.test(b.valor||'')))out.push({codigo:'SUPPORT_ROUTE',mensagem:'Confira o atendimento: este número é automático. Ofereça um botão para a equipe ou uma resposta automática que encaminhe o cliente.'});
  return out;
 },
 errors(r){
  if(r?.canal!=='whatsapp')return [];
  const e=[],add=(campo,mensagem)=>e.push({codigo:'WHATSAPP_CONTRACT',campo,mensagem}),buttons=r.botoes||[];
  if(/[\r\n*_~`]|\p{Extended_Pictographic}/u.test(r.cabecalho||''))add('cabecalho','O cabeçalho deve ser texto simples, sem emoji, formatação ou quebra de linha. Use esses recursos no corpo.');
  for(const b of buttons)if(!['url','phone','quick_reply','order_details'].includes(b.tipo))add('botoes','Tipo de botão não suportado.');
  for(const b of buttons)if(b.tipo==='url'){const error=WAT.urlError(b.valor);if(error)add('botoes',error);}
  if(/carrinho|rastreio|pedido.pago|pedido.confirmado/i.test((r.peca||'')+' '+(r.nome||''))&&!WAT.isPix(r)&&!buttons.some(b=>b.tipo==='url'))add('botoes','Esta mensagem precisa de um botão com link para o carrinho, pedido ou rastreio.');
  if(WAT.isPix(r)&&!WAT.card(r))add('botoes','PIX exige cartão de pagamento e botão Copiar código Pix. Não use código no texto nem botão de cupom.');
  if(WAT.card(r)&&(buttons.length!==1||r.categoria!=='UTILITY'))add('botoes','O cartão PIX usa um único botão de pagamento e categoria Utility.');
  if(/000201\d{6}/.test([r.corpo,r.cabecalho,r.rodape,...Object.values(r.exemplos||{})].join(' ')))add('corpo','O código PIX pertence ao cartão de pagamento; remova-o do texto e dos exemplos.');
  if(WAT.card(r)&&/\{\{|https?:\/\//.test(buttons.find(b=>b.tipo==='order_details')?.valor||''))add('botoes','Código, valor e vencimento vêm da cobrança no envio. Não coloque dados de pagamento no template.');
  const filled=String(r.corpo||'').replace(/\{\{\s*(\d+)\s*\}\}/g,(_,n)=>r.exemplos?.[n]||'');
  if(filled.length>1024)add('exemplos','A mensagem preenchida ultrapassa 1024 caracteres. Reduza o conteúdo ou os dados variáveis.');
  return e;
 },
 components(r,components){
  const c=JSON.parse(JSON.stringify(components));
  const h=c.find(x=>x.type==='HEADER');if(h&&WAT.vars(h.text).length)h.example={header_text:[String(r.exemplos?.[1]||'Cliente')]};
  const bt=c.find(x=>x.type==='BUTTONS');if(bt)bt.buttons=(r.botoes||[]).filter(x=>x&&x.texto).map(x=>x.tipo==='order_details'?{type:'ORDER_DETAILS',text:'Copy Pix code'}:x.tipo==='url'?{type:'URL',text:x.texto,url:x.valor,...(x.valor.includes('{{1}}')?{example:[x.valor.replace('{{1}}','exemplo')]}:{})}:x.tipo==='phone'?{type:'PHONE_NUMBER',text:x.texto,phone_number:x.valor}:{type:'QUICK_REPLY',text:x.texto});
  return c;
 },
 runtime(input,template){
  if(!template||String(template.id)!==String(input.template_id)||template.name!==input.template_name||template.language!==input.language||template.status!=='APPROVED')return 'template_nao_aprovado_ou_divergente';
  if((input.flow==='transacional'||WAT.isPix(input))&&template.category!=='UTILITY')return 'template_categoria_incompativel';
  const cs=input.components||[],approved=template.components||[];
  if(!Array.isArray(cs)||!Array.isArray(approved))return 'template_componentes_invalidos';
  for(const type of ['HEADER','BODY']){
   const a=approved.find(c=>c.type===type),sent=cs.filter(c=>c.type===type.toLowerCase());if(sent.length>1)return 'template_componente_duplicado';
   const n=WAT.vars(a?.text).length,params=sent[0]?.parameters||[];
   if(a?.format&&a.format!=='TEXT'){if(params.length!==1||params[0].type!==a.format.toLowerCase())return 'template_midia_ausente';continue;}
   if(params.length!==n||params.some(p=>p.type!=='text'||typeof p.text!=='string'||!p.text.trim()))return 'template_variaveis_incompativeis';
   const rendered=String(a?.text||'').replace(/\{\{\s*(\d+)\s*\}\}/g,(_,i)=>params[+i-1]?.text||'');
   if(rendered.length>(type==='BODY'?1024:60))return 'template_texto_preenchido_longo';
   if(params.some(p=>/000201\d{6}/.test(p.text)))return 'pix_codigo_no_texto_bloqueado';
  }
  const buttons=approved.find(c=>c.type==='BUTTONS')?.buttons||[];
  if(WAT.isPix(input)&&!buttons.some(b=>b.type==='ORDER_DETAILS'))return 'pix_cartao_obrigatorio';
  for(let i=0;i<buttons.length;i++){
   const b=buttons[i],sent=cs.filter(c=>c.type==='button'&&String(c.index)===String(i));
   if(b.type==='URL'&&WAT.urlError(b.url))return 'template_link_invalido';
   const needed=b.type==='ORDER_DETAILS'||(b.type==='URL'&&WAT.vars(b.url).length>0);
   if(sent.length>1||needed&&sent.length!==1)return 'template_botao_obrigatorio';
   if(!sent.length)continue;
   const s=sent[0];
   if(b.type==='ORDER_DETAILS'){
    const d=s.parameters?.[0]?.action?.order_details,p=d?.payment_settings?.[0]?.pix_dynamic_code;
    if(s.sub_type!=='order_details'||s.parameters?.length!==1||s.parameters[0].type!=='action'||!d||d.currency!=='BRL'||d.payment_type!=='br'||!p?.code||!p.key||!p.key_type||!p.merchant_name||!Number.isSafeInteger(d.total_amount?.value)||d.total_amount.value<=0||d.total_amount.offset!==100)return 'pix_cartao_incompleto';
   }else if(b.type==='URL'){
    if(s.sub_type!=='url'||s.parameters?.length!==WAT.vars(b.url).length||s.parameters?.some(p=>p.type!=='text'||!p.text))return 'template_url_incompativel';
    if(WAT.vars(b.url).length&&WAT.urlError(b.url.replace('{{1}}',s.parameters[0].text)))return 'template_link_preenchido_invalido';
   }
  }
  if(cs.some(c=>!['header','body','button'].includes(c.type)||(c.type==='button'&&!buttons[Number(c.index)])))return 'template_componente_inesperado';
  return null;
 }
};
if(typeof module!=='undefined'&&module.exports)module.exports=WAT;
