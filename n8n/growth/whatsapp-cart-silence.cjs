'use strict';
// Local-only repair of the two Growth cart selectors. No network or activation.
const {createHash}=require('node:crypto');
const NODE='Monta SQL elegíveis',MARKER='GROWTH_WA_CART_SILENCE_DEADLINE_V1';
const WORKFLOWS={APG7xy5uY4YzU6vA:'aristo','4YidT1MdzugL4wWB':'fish'};
const sha256=code=>createHash('sha256').update(code).digest('hex');
const STAGES={'carrinho-30min':{wait:30,normal:4,oldSilent:11},'carrinho-24h':{wait:1440,normal:27,oldSilent:34}};
function expressions(brand,piece){
 const stage=STAGES[piece];
 if(!Object.values(WORKFLOWS).includes(brand)||!stage)throw Error('SILENCE_SCOPE_INVALID');
 const wait=`shrigma_flow_wait('${brand}','whatsapp','${piece}',${stage.wait})`,due=`(g.cart_at + ${wait})`,local=`(${due} AT TIME ZONE 'America/Sao_Paulo')`;
 const opening=`((date_trunc('day', ${local}) + CASE WHEN date_part('hour', ${local}) >= 22 THEN interval '1 day' ELSE interval '0 days' END + interval '8 hours') AT TIME ZONE 'America/Sao_Paulo')`;
 const deadline=`CASE WHEN shrigma_wa_silencio${due} THEN ${opening} + interval '4 hours' ELSE g.cart_at + interval '${stage.normal} hours' END`;
 const old=`g.idade < CASE WHEN shrigma_wa_silencio(g.cart_at + ${wait}) AND date_part('hour', now() AT TIME ZONE 'America/Sao_Paulo') < 12 THEN interval '${stage.oldSilent} hours' ELSE interval '${stage.normal} hours' END`;
 return {old,replacement:`now() < ${deadline}`,deadline,opening,due,wait};
}
function once(code,before,after){if(code.split(before).length!==2)throw Error('SILENCE_SOURCE_DRIFT');return code.replace(before,()=>after);}
const OLD_COMMENT=`// Silencio 22h-8h (America/Sao_Paulo): nada sai na janela; o toque e ADIADO, nao descartado.
//  shrigma_wa_silencio(now()) barra o disparo. O teto de cada toque so abre (4h->11h, 27h->34h)
//  quando a elegibilidade caiu dentro do silencio E o relogio local ainda nao passou das 12h:
//  a fila da noite tem as mesmas 4 horas acordado (8h-12h) de qualquer toque normal; nada sai 10h atrasado.
//  Guarda de colisao: teto do t1 (11h) < 24h, entao carrinho liberado de manha nunca pega t1 e t24 juntos.`;
const NEW_COMMENT=`// ${MARKER}: silencio 22h-8h em America/Sao_Paulo ADIA o toque.
//  A guarda global continua barrando envio durante o silencio. Se due=cart_at+wait cai
//  no silencio, o prazo termina quatro horas depois da proxima abertura (08h->12h).
//  Fora desse caso, mantem os tetos normais de idade 4h/27h. O prazo e absoluto;
//  nao depende da hora em que um cron atrasado consegue processar o carrinho.
//  Com espera vigente 30min, o teto maximo t1 e 14h30, ainda menor que o t24 (24h).`;
function patchCode(code,brand){
 if(typeof code!=='string'||code.includes(MARKER))throw Error('SILENCE_CODE_INVALID_OR_ALREADY_PATCHED');
 let next=once(code,OLD_COMMENT,NEW_COMMENT);
 for(const piece of Object.keys(STAGES)){const {old,replacement}=expressions(brand,piece);next=once(next,old,replacement);}
 return next;
}
function patchWorkflow(fresh,{versionId,codeSha256}={}){
 if(!fresh||!WORKFLOWS[fresh.id]||fresh.active!==true||!versionId||fresh.versionId!==versionId||fresh.activeVersionId!==versionId)throw Error('SILENCE_VERSION_DRIFT');
 const active=fresh.activeVersion;
 if(!active||active.versionId!==versionId||JSON.stringify(active.nodes)!==JSON.stringify(fresh.nodes)||JSON.stringify(active.connections)!==JSON.stringify(fresh.connections))throw Error('SILENCE_ACTIVE_CONTENT_UNPROVEN');
 const out=structuredClone(fresh),nodes=out.nodes.filter(n=>n.name===NODE);
 if(nodes.length!==1||nodes[0].type!=='n8n-nodes-base.code'||!/^[0-9a-f]{64}$/.test(codeSha256||'')||sha256(nodes[0].parameters?.jsCode)!==codeSha256)throw Error('SILENCE_NODE_SOURCE_DRIFT');
 nodes[0].parameters.jsCode=patchCode(nodes[0].parameters.jsCode,WORKFLOWS[fresh.id]);
 return {workflow:out,proof:{marker:MARKER,workflowId:fresh.id,versionId,node:NODE,beforeSha256:codeSha256,afterSha256:sha256(nodes[0].parameters.jsCode),candidateOnly:true,productionWrites:0}};
}
module.exports={NODE,MARKER,WORKFLOWS,STAGES,OLD_COMMENT,NEW_COMMENT,sha256,expressions,patchCode,patchWorkflow};
