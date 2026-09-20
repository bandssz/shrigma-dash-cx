/* Durable browser fence for A/B registration. The server contract reconciles
   only exact durable receipts; legacy uncertainty is preserved. No assignment. */
(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GABJ=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const SLOT='shrigma_ab_registry_v1:grupo-shrigma'; // Independent of endpoint, key and new test ID.
 const phases=['pending','uncertain','accepted','confirmed','rejected'],unresolved=p=>['pending','uncertain','accepted'].includes(p);
 const copy=v=>JSON.parse(JSON.stringify(v)),fail=(code,message)=>Object.assign(new Error(message),{code});
 function normalize(input){
  if(!input||!['criar','encerrar'].includes(input.acao)||!input.teste||typeof input.teste.teste_id!=='string'||!input.teste.teste_id.trim()||input.teste.teste_id.length>256)throw fail('AB_INPUT','Confira o identificador e a ação do cadastro.');
  const fields=input.acao==='criar'?['teste_id','marca','canal','nome','hipotese','variavel','metrica_primaria','efeito_minimo']:['teste_id','status','vencedor','conclusao'];
  const valid=v=>v===null||['string','boolean'].includes(typeof v)||typeof v==='number'&&Number.isFinite(v);
  const teste={};for(const f of fields){const v=input.teste[f];if(v!==undefined){if(!valid(v))throw fail('AB_INPUT','Campo do cadastro inválido.');teste[f]=v;}}
  const out={acao:input.acao,teste};
  if(input.acao==='criar')out.bracos=(input.bracos||[]).map(b=>Object.fromEntries(['braco','campanha_id','utm_term','descricao'].filter(k=>b[k]!==undefined).map(k=>{const v=b[k];if(!valid(v))throw fail('AB_INPUT','Braço do cadastro inválido.');return[k,v];})));
  if(JSON.stringify(out).length>65536)throw fail('AB_INPUT','Registro muito extenso.');return out;
 }
 function definitiveRejection(status,body){
  if(status===401&&body?.erro==='chave invalida')return true;
  return status===400&&typeof body?.erro==='string'&&(/^(teste_id obrigatorio|um teste precisa de pelo menos 2 bracos)$/.test(body.erro)||/^campo obrigatorio faltando: (teste_id|marca|nome|hipotese|variavel|metrica_primaria)$/.test(body.erro));
 }
 function create({endpoint,storage,locks,match,receipt,serverContract=false,validServer,now=()=>Date.now(),uuid=()=>crypto.randomUUID()}={}){
  let normalized=null;try{const u=new URL(endpoint);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash)normalized=u.href;}catch{}
  let memory=null;
  const available=()=>!!(normalized&&storage?.getItem&&storage?.setItem&&locks?.request&&typeof match==='function'&&typeof receipt==='function'&&(!serverContract||typeof validServer==='function'));
  function read(){
   let raw;try{raw=storage.getItem(SLOT);}catch{throw fail('AB_STORAGE','Não foi possível ler o registro da tentativa. Preserve este navegador e consulte o integrador.');}
   if(raw===null){if(memory?.operations?.length)throw fail('AB_JOURNAL_REMOVED','O registro local desapareceu. Não repita a operação; concilie com o integrador.');return {version:1,revision:0,operations:[]};}
   try{const j=JSON.parse(raw);if(j.version!==1||!Number.isSafeInteger(j.revision)||j.revision<0||!Array.isArray(j.operations)||j.operations.some(p=>typeof p.id!=='string'||!phases.includes(p.phase)||typeof p.endpoint!=='string'||!Number.isFinite(p.startedAt)||JSON.stringify(normalize(p.expected))!==JSON.stringify(p.expected)||p.server&&serverContract&&!validServer(p)))throw Error();memory=copy(j);return j;}
   catch{throw fail('AB_JOURNAL_INVALID','O registro local precisa de conferência. Nenhuma nova gravação será enviada.');}
  }
  function persist(j){const next={...j,revision:j.revision+1},raw=JSON.stringify(next);try{storage.setItem(SLOT,raw);if(storage.getItem(SLOT)!==raw)throw Error();j.revision=next.revision;memory=copy(next);return next;}catch{throw fail('AB_STORAGE','Não foi possível preservar a tentativa. Nenhuma nova operação será enviada.');}}
  function inspect(){try{const j=read();return {...copy(j),available:available(),blocked:!available(),message:available()?'':'A escrita exige armazenamento local e proteção entre abas. A consulta continua disponível.'};}catch(e){return {operations:[],available:false,blocked:true,message:e.message};}}
  async function exclusive(work){if(!available())throw fail('AB_UNAVAILABLE','A escrita exige armazenamento local e proteção entre abas. A consulta continua disponível.');return locks.request(SLOT,{mode:'exclusive',ifAvailable:true},lock=>{if(!lock)throw fail('AB_BUSY','Outra aba está conferindo este cadastro. Aguarde e atualize os dados.');return work();});}
  const fresh=r=>r&&Number.isFinite(r.startedAt)&&Number.isFinite(r.completedAt)&&r.completedAt>=r.startedAt&&r.completedAt<=now()+1000&&now()-r.completedAt<=120000;
  async function reconcile(api,readProof){
   if(serverContract)return {confirmed:[],changed:false}; // Never upgrade a legacy unknown by coincidental registry state.
   if(!available()||!fresh(readProof))return {confirmed:[],changed:false};
   if(!read().operations.some(p=>unresolved(p.phase)))return {confirmed:[],changed:false};
   return exclusive(()=>{const j=read(),confirmed=[];
    for(const p of j.operations){if(!unresolved(p.phase)||p.endpoint!==normalized||readProof.startedAt<p.startedAt||!match(api,p.expected))continue;p.phase='confirmed';p.confirmedAt=now();p.readback={startedAt:readProof.startedAt,completedAt:readProof.completedAt};confirmed.push(copy(p));}
    if(confirmed.length)persist(j);return {confirmed,changed:!!confirmed.length};
   });
  }
  async function reconcileRemote(remote){
   if(!serverContract||!remote||typeof remote.lookup!=='function')return {confirmed:[],changed:false};
   return exclusive(async()=>{const j=read(),confirmed=[];let changed=false;
    for(const p of j.operations){if(!unresolved(p.phase)||!p.server||p.endpoint!==normalized)continue;
     const result=await remote.lookup(copy(p));
     if(!['confirmed','rejected'].includes(result.phase))continue;
     p.phase=result.phase;p.confirmedAt=now();if(result.receipt)p.receipt=copy(result.receipt);if(result.rejection)p.rejection=copy(result.rejection);changed=true;confirmed.push(copy(p));persist(j);
    }
    return {confirmed,changed};
   });
  }
  async function run(input,{api,readProof,remote,guard=()=>true}={},transport){
   const expected=normalize(input);if(!serverContract&&typeof transport!=='function')throw fail('AB_INPUT','Transporte ausente.');
   return exclusive(async()=>{
    const j=read(),id=expected.teste.teste_id;
    if(j.operations.some(p=>unresolved(p.phase)&&(p.expected.teste.teste_id===id||expected.acao==='criar'&&p.expected.acao==='criar')))throw fail('AB_PENDING','Gravação aguardando confirmação. Consulte o mesmo registro; não crie outro identificador para repetir.');
    if(j.operations.some(p=>unresolved(p.phase)&&p.endpoint!==normalized))throw fail('AB_ENDPOINT_CHANGED','O endereço do cadastro mudou com uma tentativa pendente. Concilie antes de gravar.');
    if(!fresh(readProof)||!Array.isArray(api?.crm_teste)||!Array.isArray(api?.crm_teste_braco))throw fail('AB_READ_REQUIRED','Atualize os dados do cadastro antes de gravar.');
    const rows=api.crm_teste.filter(t=>t.teste_id===id);
    if(expected.acao==='criar'&&(rows.length||j.operations.some(p=>p.phase==='confirmed'&&p.expected.acao==='criar'&&p.expected.teste.teste_id===id)))throw fail('AB_EXISTS','Este identificador já foi registrado. Atualize os dados; o cadastro não será sobrescrito.');
    if(expected.acao==='encerrar'&&(rows.length!==1||rows[0].status!=='rodando'||j.operations.some(p=>p.phase==='confirmed'&&p.expected.acao==='encerrar'&&p.expected.teste.teste_id===id)))throw fail('AB_CHANGED','Este registro não está disponível para encerrar. Atualize os dados.');
    const op={id:uuid(),endpoint:normalized,expected,phase:'pending',startedAt:now()};
    if(serverContract){if(!remote||typeof remote.prepare!=='function'||typeof remote.send!=='function'||typeof remote.lookup!=='function')throw fail('AB_SERVER_REQUIRED','O contrato seguro do cadastro está indisponível.');op.server=await remote.prepare(copy(expected),op.id,{api});if(!validServer(op))throw fail('AB_SERVER_INVALID','O contrato retornado não corresponde à tentativa. Nenhuma gravação foi enviada.');}
    if(guard()!==true)throw fail('AB_CONTEXT_CHANGED','O formulário ou o acesso mudou durante a conferência. Nenhuma gravação foi enviada.');
    j.operations.push(op);persist(j); // Durable before the only transport.
    let response;try{response=serverContract?await remote.send(copy(op)):await transport(copy(expected));}catch{op.phase='uncertain';try{persist(j);}catch{}return {phase:'uncertain',id:op.id};}
    if(serverContract){
     // POST receipt alone never releases a reservation. Only exact durable GET does.
     op.phase='uncertain';persist(j);
     try{const result=await remote.lookup(copy(op));if(['confirmed','rejected'].includes(result.phase)){const terminal={...op,phase:result.phase,confirmedAt:now()};if(result.receipt)terminal.receipt=copy(result.receipt);if(result.rejection)terminal.rejection=copy(result.rejection);const next={...j,operations:j.operations.map(p=>p.id===op.id?terminal:p)};persist(next);Object.assign(op,terminal);}}catch{}
     return {phase:op.phase,id:op.id,rejection:op.rejection||null};
    }
    if(definitiveRejection(response?.status,response?.body)){op.phase='rejected';op.rejection={status:response.status,error:response.body.erro};}
    else if(response?.status>=200&&response.status<300&&receipt(response.body,op.startedAt,now()))op.phase='accepted';
    else op.phase='uncertain';
    // A failed terminal journal write leaves the original pending entry intact.
    persist(j);return {phase:op.phase,id:op.id,rejection:op.rejection||null};
   });
  }
  return Object.freeze({inspect,reconcile,reconcileRemote,run});
 }
 return Object.freeze({SLOT,create,normalize,definitiveRejection});
});
