'use strict';
// Acesso único no TikTok (26/09/2026, decisão do Felipe): quem entra no painel de Influs com uma chave
// que tem `creators_edit` (gestor da área e mestre) decide amostra e edita regra sem digitar outra chave.
//
// O que muda na API de ação (LCODPC1y6kRPQ6hI):
//  - a chave aceita é a de escrita antiga OU uma chave de painel cujo SHA-256 está na lista PAINEL_ESCRITA
//    (hashes de crm_dash_chave; a chave em si nunca entra no workflow). Revogar = tirar o hash daqui.
//  - o principal do recibo passa a ser o hash da chave usada (antes era sempre o da chave antiga), para o
//    navegador conferir o recibo com a mesma chave que iniciou a decisão.
//  - os portões de corte e admissão abrem (cutover/admission = true). Pré-condições conferidas em produção:
//    a esteira automática não tem mais transporte de decisão; nenhum log `acao_painel` antigo; as regras só
//    aceitam dry_run/pausado (o SQL recusa decisão manual se o modo for outro).
// Tudo o mais — reserva, CAS de envio, recibo, ausência de nova tentativa — continua como está.

const ANCORA = /^const ESCRITA = '[^'\n]+';\n/;
const helper = hashes => `// Chaves de painel com escrita em Influs (SHA-256 de crm_dash_chave). Revogar = remover o hash.
const PAINEL_ESCRITA=new Set(${JSON.stringify(hashes)});
function sha256HexPainel(t){const s=unescape(encodeURIComponent(String(t)));return Array.from(sha256Bytes(Uint8Array.from(s,c=>c.charCodeAt(0)))).map(b=>b.toString(16).padStart(2,'0')).join('');}
const chaveOk=k=>typeof k==='string'&&k.length>0&&k.length<=256&&(k===ESCRITA||PAINEL_ESCRITA.has(sha256HexPainel(k)));
`;

const TROCAS = {
  Valida: [
    ["if (String(b.k || '') !== ESCRITA) throw new Error('chave invalida');", "if (!chaveOk(String(b.k || ''))) throw new Error('chave invalida');"],
    ["if(typeof incoming.k!=='string'||incoming.k!==ESCRITA)throw Error('chave invalida');", "if(!chaveOk(incoming.k))throw Error('chave invalida');"],
    ["digest({scope:'tts-manual-v1',credential:ESCRITA})", "digest({scope:'tts-manual-v1',credential:incoming.k})"],
  ],
  'Manual consulta': [
    ["if(typeof $json.headers?.['x-tts-write-key']!=='string'||$json.headers['x-tts-write-key']!==ESCRITA)", "if(!chaveOk($json.headers?.['x-tts-write-key']))"],
    ['write:false,cutover_verified:false,admission_verified:false', 'write:true,cutover_verified:true,admission_verified:true'],
    ["digest({scope:'tts-manual-v1',credential:ESCRITA})", "digest({scope:'tts-manual-v1',credential:$json.headers['x-tts-write-key']})"],
  ],
  'Manual preflight': [
    ['const readiness={cutoverVerified:false,admissionVerified:false};', 'const readiness={cutoverVerified:true,admissionVerified:true};'],
  ],
};

function patchWorkflow(fresh, { expectedVersionId, hashes } = {}) {
  if (fresh?.id !== 'LCODPC1y6kRPQ6hI' || fresh.versionId !== expectedVersionId || fresh.activeVersionId !== expectedVersionId) throw Error('workflow fresco e ativo esperado');
  if (!Array.isArray(hashes) || !hashes.length || hashes.some(h => !/^[a-f0-9]{64}$/.test(h))) throw Error('lista de hashes inválida');
  const w = structuredClone(fresh);
  for (const [nome, trocas] of Object.entries(TROCAS)) {
    const n = w.nodes.find(x => x.name === nome);
    if (!n?.parameters?.jsCode) throw Error('nó ausente: ' + nome);
    let c = n.parameters.jsCode;
    if (c.includes('chaveOk(')) throw Error('já aplicado: ' + nome);
    if (nome !== 'Manual preflight') {
      if (!ANCORA.test(c) || !c.includes('function sha256Bytes(')) throw Error('âncora ausente: ' + nome);
      c = c.replace(ANCORA, m => m + helper(hashes));
    }
    for (const [de, para] of trocas) {
      if (c.split(de).length !== 2) throw Error(`trecho ausente ou repetido em ${nome}: ${de.slice(0, 60)}`);
      c = c.replace(de, () => para);
    }
    n.parameters.jsCode = c;
  }
  return w;
}

module.exports = { patchWorkflow, TROCAS, helper };
