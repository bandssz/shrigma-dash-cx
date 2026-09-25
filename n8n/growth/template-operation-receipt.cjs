'use strict';
// Read-only receipt projection. No provider call, retry, reservation or SQL mutation.
function sha256Bytes(msg) { // msg: Uint8Array → Uint8Array(32)
  const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const len = msg.length, bitLen = len * 8;
  const padLen = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(padLen); buf.set(msg); buf[len] = 0x80;
  buf[padLen - 4] = (bitLen >>> 24) & 255; buf[padLen - 3] = (bitLen >>> 16) & 255; buf[padLen - 2] = (bitLen >>> 8) & 255; buf[padLen - 1] = bitLen & 255;
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = (buf[off + i*4] << 24) | (buf[off + i*4+1] << 16) | (buf[off + i*4+2] << 8) | buf[off + i*4+3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i-15], 7) ^ rotr(W[i-15], 18) ^ (W[i-15] >>> 3);
      const s1 = rotr(W[i-2], 17) ^ rotr(W[i-2], 19) ^ (W[i-2] >>> 10);
      W[i] = (W[i-16] + s0 + W[i-7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) { out[i*4] = H[i] >>> 24; out[i*4+1] = (H[i] >>> 16) & 255; out[i*4+2] = (H[i] >>> 8) & 255; out[i*4+3] = H[i] & 255; }
  return out;
}

function stable(value){
 if(Array.isArray(value))return value.map(stable);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
 return value;
}
function canonical(value){return JSON.stringify(stable(value));}
function digest(value){
 const text=unescape(encodeURIComponent(canonical(value)));
 return Array.from(sha256Bytes(Uint8Array.from(text,c=>c.charCodeAt(0)))).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function safePayload(p){
 const keys=['acao','rascunho','draft_id','expected_version','confirm'];
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).length!==keys.length||!keys.every(k=>Object.hasOwn(p,k)))return false;
 if(!['rascunho','validar','submeter'].includes(p.acao))return false;
 if(p.draft_id!==null&&typeof p.draft_id!=='string')return false;
 if(p.expected_version!==null&&(!Number.isInteger(p.expected_version)||p.expected_version<1))return false;
 if(p.confirm!==null&&typeof p.confirm!=='string')return false;
 if(p.rascunho===null)return true;
 const r=p.rascunho,fields=['canal','marca','idioma','categoria','nome','peca','cabecalho','corpo','rodape','assunto','from_email','reply_to','preheader'];
 if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!fields.includes(k)&&!['exemplos','botoes'].includes(k)))return false;
 if(fields.some(k=>Object.hasOwn(r,k)&&typeof r[k]!=='string'))return false;
 if(Object.hasOwn(r,'exemplos')&&(!r.exemplos||Array.isArray(r.exemplos)||typeof r.exemplos!=='object'||Object.entries(r.exemplos).some(([k,v])=>!/^\d+$/.test(k)||typeof v!=='string')))return false;
 if(Object.hasOwn(r,'botoes')&&(!Array.isArray(r.botoes)||r.botoes.some(b=>!b||Array.isArray(b)||typeof b!=='object'||Object.entries(b).some(([k,v])=>!['tipo','texto','valor','exemplo_url'].includes(k)||typeof v!=='string'))))return false;
 return true;
}
function cleanResponse(raw){
 if(!raw||!Number.isInteger(raw.status)||raw.status<200||raw.status>599||!raw.body||typeof raw.body!=='object'||Array.isArray(raw.body))return null;
 // Only operator-facing receipt fields. Never echo provider raw requests, headers or credentials.
 const scalar=['draft_id','version','estado','salvo_em','submission_id','provider','provider_id','provider_name','provider_status','template_key','submitted_at','category','rejected_reason','who','operation_id','erro','nothing_changed','current_version','changed_by','changed_at'];
 const body={};for(const k of scalar)if(Object.hasOwn(raw.body,k)&&(raw.body[k]===null||['string','number','boolean'].includes(typeof raw.body[k])))body[k]=raw.body[k];
 for(const k of ['erros','avisos','erros_para_submeter'])if(Array.isArray(raw.body[k]))body[k]=raw.body[k].map(x=>typeof x==='string'?x:x&&typeof x==='object'?Object.fromEntries(['codigo','campo','mensagem'].filter(f=>typeof x[f]==='string').map(f=>[f,x[f]])):null).filter(x=>x!==null);
 return {status:raw.status,body};
}
function operationReceipt(context,row){
 const operation={idempotency_key:context.operation_key,acao:context.operation_action,actor:context.who,request_payload:null,request_sha256:null,hash_schema:'json-stable-sha256-v1',state:'missing',response:null,claim_id:null};
 const result=()=>({contract:'template_operation_v1',operation});
 const receipts=row?.receipts,claims=row?.claims;
 if(!Array.isArray(receipts)||!Array.isArray(claims)||receipts.length>1||claims.length>1){operation.state='inconsistent';return result();}
 const i=receipts[0],cl=claims[0];if(!i&&!cl)return result();
 const records=[i,cl].filter(Boolean);
 if(records.some(r=>r.actor!==context.who||r.idempotency_key!==context.operation_key)){operation.state='inconsistent';return result();}
 if(records.some(r=>!safePayload(r.request_payload))){operation.state='legacy_unverifiable';return result();}
 if(records.some(r=>r.acao!==context.operation_action||r.request_payload.acao!==context.operation_action)||records.some(r=>canonical(r.request_payload)!==canonical(records[0].request_payload))){operation.state='inconsistent';return result();}
 operation.request_payload=records[0].request_payload;operation.request_sha256=digest(operation.request_payload);
 if(cl&&context.operation_action!=='submeter'){operation.state='inconsistent';return result();}
 if(cl){
  if(typeof cl.claim_id!=='string'||!cl.claim_id){operation.state='inconsistent';return result();}
  operation.claim_id=cl.claim_id;
  if(cl.draft_id!==operation.request_payload.draft_id||cl.version!==operation.request_payload.expected_version){operation.state='inconsistent';return result();}
  if(cl.state==='reserved'){
   operation.state=i||cl.response?'inconsistent':'pending';return result();
  }
  if(!['succeeded','rejected','outcome_unknown'].includes(cl.state)){operation.state='inconsistent';return result();}
  const cr=cl.response&&{status:cl.response._http,body:cl.response._body};
  if(!cr||!i||canonical(cr)!==canonical(i.response)||cr.body?.operation_id!==cl.claim_id||cr.body?.who!==context.who){operation.state='inconsistent';return result();}
  operation.response=cleanResponse(cr);
  if(!operation.response){operation.state='inconsistent';return result();}
  operation.state=cl.state==='outcome_unknown'?'outcome_unknown':'completed';
  if(cl.state==='succeeded'&&(cr.body.draft_id!==cl.draft_id||cr.body.submission_id!=='s_'+cl.claim_id.replace(/-/g,'')))operation.state='inconsistent';
  if((cl.state==='succeeded'&&(cr.status<200||cr.status>=300))||(cl.state==='rejected'&&!(cr.status>=400&&cr.body?.nothing_changed===true)))operation.state='inconsistent';
  return result();
 }
 operation.response=cleanResponse(i.response);
 if(!operation.response){operation.state='inconsistent';return result();}
 // Submissions require their durable claim as corroboration; a legacy receipt alone is insufficient.
 if(context.operation_action==='submeter'){operation.state='legacy_unverifiable';return result();}
 const status=operation.response.status,body=operation.response.body,payload=operation.request_payload;
 if(body.who!==context.who){operation.state='inconsistent';return result();}
 if(status>=200&&status<300){
  const expectedVersion=context.operation_action==='rascunho'?(payload.draft_id===null?1:payload.expected_version+1):payload.expected_version;
  if(!Number.isInteger(expectedVersion)||body.version!==expectedVersion||typeof body.draft_id!=='string'||!body.draft_id||(payload.draft_id!==null&&body.draft_id!==payload.draft_id)){operation.state='inconsistent';return result();}
 }
 operation.state=status>=200&&status<300||status>=400&&status<500?'completed':'outcome_unknown';
 return result();
}
const SQL=`SELECT
 COALESCE((SELECT jsonb_agg(jsonb_build_object('idempotency_key',i.chave,'acao',i.rota,'actor',i.actor,'request_payload',i.request_payload,'response',i.resposta))
 FROM public.shrigma_api_idempotencia i WHERE i.chave=$1::text AND i.actor=$2::text),'[]'::jsonb) AS receipts,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('claim_id',c.claim_id,'idempotency_key',c.idem,'acao','submeter','actor',c.actor,'request_payload',c.request_payload,'draft_id',c.draft_id,'version',c.version,'state',c.state,'response',c.response))
 FROM public.shrigma_template_claim_v2 c WHERE c.idem=$1::text AND c.actor=$2::text),'[]'::jsonb) AS claims`;
module.exports={sha256Bytes,stable,canonical,digest,safePayload,cleanResponse,operationReceipt,SQL};
