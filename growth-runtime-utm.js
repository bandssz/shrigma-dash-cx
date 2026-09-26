/* Read-only emitter snapshot; no transport, evaluation, or live-runtime claim.
 * Evidence: runtime-rules-safe.json SHA256
 * 14a6fae4fabb81dd2d72586f3541c6259e474210a06b99702b15dc8cc875d9f5.
 * Revalidation 2026-09-26 SHA256 b89cbe3b01023597a64ed229f36fc034511a5f6e7ac9655ca284d5b79c1448dc.
 * Catalog rows are verified identities, not rules inferred from display names.
 */
'use strict';
const GURT=(()=>{
 // brand, journey, step, channel, flow, piece, variant, campaign, template, min published version, evidence kind
 const catalog=[
  ["aristo","aristo:carrinho","email:carrinho-30min","email","carrinho","carrinho-30min","","aristo-carrinho",null,0,"cart"],
  ["aristo","aristo:carrinho","whatsapp:carrinho-30min:a","whatsapp","carrinho","carrinho-30min","a","aristocrata-carrinho",null,0,"cart"],
  ["aristo","aristo:carrinho","whatsapp:carrinho-30min:b","whatsapp","carrinho","carrinho-30min","b","aristocrata-carrinho",null,0,"cart"],
  ["aristo","aristo:carrinho","email:carrinho-1h","email","carrinho","carrinho-1h","","aristo-carrinho",null,0,"cart"],
  ["aristo","aristo:carrinho","email:carrinho-2h","email","carrinho","carrinho-2h","","aristo-carrinho",null,0,"cart"],
  ["aristo","aristo:carrinho","email:carrinho-24h","email","carrinho","carrinho-24h","","aristo-carrinho",null,0,"cart"],
  ["aristo","aristo:carrinho","whatsapp:carrinho-24h:a","whatsapp","carrinho","carrinho-24h","a","aristocrata-carrinho",null,0,"cart"],
  ["aristo","aristo:carrinho","whatsapp:carrinho-24h:b","whatsapp","carrinho","carrinho-24h","b","aristocrata-carrinho",null,0,"cart"],
  ["aristo","aristo:carrinho","email:carrinho-48h","email","carrinho","carrinho-48h","","aristo-carrinho",null,0,"cart"],
  ["fish","fish:carrinho","email:carrinho-30min","email","carrinho","carrinho-30min","","fish-carrinho",null,0,"cart"],
  ["fish","fish:carrinho","whatsapp:carrinho-30min:a","whatsapp","carrinho","carrinho-30min","a","fishermans-carrinho",null,0,"cart"],
  ["fish","fish:carrinho","whatsapp:carrinho-30min:b","whatsapp","carrinho","carrinho-30min","b","fishermans-carrinho",null,0,"cart"],
  ["fish","fish:carrinho","email:carrinho-1h","email","carrinho","carrinho-1h","","fish-carrinho",null,0,"cart"],
  ["fish","fish:carrinho","email:carrinho-2h","email","carrinho","carrinho-2h","","fish-carrinho",null,0,"cart"],
  ["fish","fish:carrinho","email:carrinho-24h","email","carrinho","carrinho-24h","","fish-carrinho",null,0,"cart"],
  ["fish","fish:carrinho","whatsapp:carrinho-24h:a","whatsapp","carrinho","carrinho-24h","a","fishermans-carrinho",null,0,"cart"],
  ["fish","fish:carrinho","whatsapp:carrinho-24h:b","whatsapp","carrinho","carrinho-24h","b","fishermans-carrinho",null,0,"cart"],
  ["fish","fish:carrinho","email:carrinho-48h","email","carrinho","carrinho-48h","","fish-carrinho",null,0,"cart"],
  ["aristo","aristo:pedido-recebido","whatsapp:pedido-pago","whatsapp","transacional","pedido-pago","","aristo-pos-compra","28334022989557583",4,"order"],
  ["aristo","aristo:rastreio","whatsapp:rastreio-criado:28123064554028655","whatsapp","transacional","rastreio-criado","","aristocrata-pos-compra","1358013072775819",4,"order"],
  ["aristo","aristo:rastreio","whatsapp:rastreio-criado:960254843767524","whatsapp","transacional","rastreio-criado","","aristocrata-pos-compra","1074482701958396",4,"order"],
  ["fish","fish:pedido-recebido","whatsapp:pedido-pago","whatsapp","transacional","pedido-pago","","fish-pos-compra","3544648535693418",5,"order"],
  ["fish","fish:rastreio","whatsapp:rastreio-criado:4613810428763952","whatsapp","transacional","rastreio-criado","","fishermans-pos-compra","1394726182217364",3,"order"],
  ["fish","fish:rastreio","whatsapp:rastreio-criado:966738019748435","whatsapp","transacional","rastreio-criado","","fishermans-pos-compra","2041581613228628",3,"order"],
  ["fish","fish:pix","whatsapp:pix-15min","whatsapp","transacional","pix-15min","",null,"1378177134340410",6,"pix"],
  ["aristo","aristo:pix","whatsapp:pix-3min","whatsapp","pix","pix-3min","",null,"1132506052775113",6,"pix"],
  ["aristo","aristo:auto-resposta","whatsapp:auto-resposta","whatsapp","mensagem-automatica","auto-resposta","",null,null,0,"interactive"],
  ["aristo","aristo:popup","email:cupom-boas-vindas","email","popup","cupom-boas-vindas","",null,"22",0,"popup"],
  ["aristo","aristo:rastreio","whatsapp:rastreio-criado:1079624764765476","whatsapp","transacional","rastreio-criado","",null,null,0,"carrier"],
  ["aristo","aristo:rastreio","whatsapp:rastreio-criado:1400400164925082","whatsapp","transacional","rastreio-criado","",null,null,0,"carrier"],
  ["aristo","aristo:rastreio","whatsapp:rastreio-criado:1615754763391281","whatsapp","transacional","rastreio-criado","",null,null,0,"carrier"],
  ["fish","fish:auto-resposta","whatsapp:auto-resposta","whatsapp","mensagem-automatica","auto-resposta","",null,null,0,"interactive"],
  ["fish","fish:rastreio","whatsapp:rastreio-criado:1047166964972141","whatsapp","transacional","rastreio-criado","",null,null,0,"carrier"],
  ["fish","fish:rastreio","whatsapp:rastreio-criado:1981691425877218","whatsapp","transacional","rastreio-criado","",null,null,0,"carrier"],
  ["fish","fish:rastreio","whatsapp:rastreio-criado:1607954397645813","whatsapp","transacional","rastreio-criado","",null,null,0,"carrier"]
 ];
 const identity=['key','channel','flow','piece','variant'];
 const sameIdentity=(step,row)=>identity.every((key,i)=>step[key]===row[i+2]);
 function read(f,step){
  if(!f||!step||!['fish','aristo'].includes(f.brand)||!Array.isArray(f.available_steps))return null;
  const matches=catalog.filter(r=>r[0]===f.brand&&r[1]===f.key&&sameIdentity(step,r));
  if(matches.length!==1)return null;
  const r=matches[0],slots=f.available_steps.filter(s=>s&&s.key===step.key);
  if(slots.length!==1||!sameIdentity(slots[0],r))return null;
  const slot=slots[0];
  if([step,slot].some(s=>s.brand!==undefined&&s.brand!==f.brand))return null;
  if(r[8]!==null&&(String(step.template_id)!==r[8]||String(slot.template_id)!==r[8]))return null;
  if(r[9]&&(!Number.isSafeInteger(f.published_version)||f.published_version<r[9]))return null;
  const kind=r[10],email=r[3]==='email';
  const evidence=kind==='cart'||kind==='pix'?'Conferido em 26/09/2026, 10:14:17 BRT · registro da regra':kind==='order'?'Conferido em 25/09/2026, 15:07:37 BRT · versão de envio alterada':'Conferido em 25/09/2026, 15:07:37 BRT · registro da regra';
  const result={rows:[],label:'Regra do envio conferida',evidence,empty:'',sourceExpression:'',scope:''};
  if(kind==='cart'||kind==='order'){
   const source=email?'email':'whatsapp',fallback=kind==='cart'&&!email&&r[0]==='fish'&&r[6]==='a';
   result.rows=[{source,medium:'fluxo',campaign:r[7],content:r[5],...(r[6]?{term:r[6]}:{})}];
   if(fallback)result.rows.push({...result.rows[0],term:'b'});
   result.sourceExpression='Valor literal "'+source+'" definido pelo emissor.';
   if(kind==='cart'){
    result.scope=(email?'Endereço em .Tx.Data.checkout_url. A guarda SQL confere a URL montada. ':'Endereço no parâmetro {{1}} do botão de checkout. ')+
     'O emissor acrescenta essas UTMs e preserva a query anterior, que pode conter outros valores. '+
     (email?'utm_term não é acrescentado. ':'utm_term acompanha a variante efetivamente selecionada. ')+
     (fallback?'Alternativas condicionais: utm_term=a se A for usada; sem imagem hospedada para A, o emissor usa B e utm_term=b. Apenas a variante escolhida é enviada. ':'')+
     'A regra cobre esse endereço dinâmico; outros links dependem do template.';
   }else result.scope='Endereço de Order.statusPageUrl no botão 0, parâmetro {{1}}, deste template. O motor só acrescenta as UTMs ausentes; valores já recebidos prevalecem. utm_term não é acrescentado. A regra exige a identidade publicada desta etapa e deste template.';
  }else if(kind==='pix'){
   result.empty='O botão de pagamento PIX é nativo (order_details), sem URL de rastreamento.';
   result.sourceExpression='Não se aplica ao botão de pagamento nativo.';
   result.scope='O componente final substitui o botão URL. Isso não declara ausência de outros links no template.';
  }else if(kind==='popup'){
   result.empty='Endereço recebido da integração em checkout_url.';
   result.sourceExpression='Origem de utm_source não comprovada.';
   result.scope='O emissor repassa .Tx.Data.checkout_url sem acrescentar UTMs; os parâmetros dependem da origem recebida.';
  }else if(kind==='carrier'){
   result.empty='Rastreio formado pelo botão aprovado e pelo código ou caminho da transportadora.';
   result.sourceExpression='Confira utm_source no conteúdo atual do template.';
   result.scope='O emissor não acrescenta UTMs ao parâmetro de rastreio. A URL completa e seus parâmetros também dependem da base do botão aprovado.';
  }else{
   if(step.kind!=='interactive'||slot.kind!=='interactive')return null;
   result.evidence='Definição da jornada conferida em 25/09/2026. O emissor da resposta não foi auditado nesta conferência.';
   result.empty='Mensagem interativa, sem template vinculado.';
   result.sourceExpression='Não há regra de UTM comprovada nesta conferência.';
   result.scope='A ausência de template não comprova ausência de links ou de rastreamento.';
  }
  result.scope='Registro da conferência; não é consulta da configuração ao vivo. '+(kind==='order'?'O código que monta as UTMs foi reconferido em 26/09/2026, 10:14:17 BRT, sem alteração; o restante da nova versão não foi reconferido. ':'')+result.scope;
  return result;
 }
 return {read};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=GURT;
