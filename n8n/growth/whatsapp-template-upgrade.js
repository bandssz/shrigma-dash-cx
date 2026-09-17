'use strict';
// Explicit migrations: producers keep their original identity and business guards.
const FRIENDLY_MEDIA_MIGRATIONS=[{"brand": "fish", "old_id": "1876931797020477", "new_name": "fishermans_carrinho_t1_a_claro_v1"}, {"brand": "fish", "old_id": "1791682188635768", "new_name": "fishermans_pedido_pago_claro_v1"}];
function friendlyComponents(input,selected){
 const change=FRIENDLY_MEDIA_MIGRATIONS.find(m=>m.brand===input.brand&&m.old_id===String(input.template_id)&&m.new_name===selected.template_name);
 if(!change)return input.components;
 return (input.components||[]).filter(c=>c.type!=='header');
}
module.exports={friendlyComponents};
