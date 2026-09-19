'use strict';
// Entirely synthetic provider responses. No customer or operational message copy.
function catalogs(){
 return Object.fromEntries(['aristo','fish'].map((brand,b)=>[brand,['pedido_pago','rastreio','rastreio_criado'].map((type,i)=>{
  const host=brand==='fish'?'fishermans.com.br':'oaristocrata.com',prefix=brand==='fish'?'fishermans':'aristocrata';
  const count=type==='pedido_pago'?4:type==='rastreio'?3:2;
  const text='Mensagem sintética: '+Array.from({length:count},(_,n)=>'campo {{'+(n+1)+'}}').join(', ')+'. Fim do exemplo.';
  return {brand,id:String(90000+b*10+i),name:prefix+'_'+type+'_claro_v1',status:'APPROVED',category:'UTILITY',language:'pt_BR',components:[{type:'HEADER',format:'TEXT',text:'Título sintético'},{type:'BODY',text,example:{body_text:[Array.from({length:count},(_,n)=>'EXEMPLO'+n)]}},{type:'FOOTER',text:'Rodapé sintético'},{type:'BUTTONS',buttons:[{type:'URL',text:'Acompanhar pedido',url:'https://conta.'+host+'/?utm_source=whatsapp&utm_campaign=synthetic-test'},{type:'URL',text:'Equipe exemplo',url:'https://'+host+'/suporte'}]}]};
 })]));
}
module.exports={catalogs};
