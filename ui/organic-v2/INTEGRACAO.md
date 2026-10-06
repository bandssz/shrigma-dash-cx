# ShrigmaOrganicV2 — notas de integração (C2 → Root)

Estado: **fonte de interface preparada, não integrada, não operacional.** Contrato `GATEWAY-ORGANICO-v1` `1.0.1-proposed` (não admitido em produção).

## Montagem

```js
// UMD: window.ShrigmaOrganicV2 no browser; module.exports em CommonJS.
const view = ShrigmaOrganicV2.create({ element, document, gateway });
await view.sync({ filters: { period: { from: '2026-10-01', to: '2026-10-05' }, model: 'last_click' } });
// troca de marca/sessão/papel: Root muda o contexto no gateway e chama view.sync() de novo
view.dispose();
```

- Monta um único `div.sov2` dentro de `element`; listeners só nesse nó; nenhum timer.
- `organic-v2.css` precisa ser incluído pelo build canônico. Tudo é escopado em `.sov2` e consome os tokens do host (`--texto`, `--mudo`, `--borda`, `--card`, `--neutro-bg`, `--ruim*`, `--bom*`, `--ui`, `--marca`) com fallback.
- `create` não lê sozinho: o host chama `sync`.

## Uso do gateway (somente métodos do contrato)

| Método | Uso |
|---|---|
| `context()` | uma vez por sync; `contextRevision` diferente invalida dados, operação local e rascunho de outra marca/principal |
| `read({resource, filters, expectedContextRevision}, {signal})` | 5 recursos do contrato; `filters = {period:{from,to}}` (+ `model` em atribuição e pedidos). A marca nunca vai no filtro |
| `beginMutation({kind, payload, recordId?, expectedRecordRevision?, expectedContextRevision})` | `link.create` / `link.archive`, só por clique e com capability |
| `submit({operationId, expectedContextRevision})` | só depois da revisão do usuário; nunca automático |
| `receipt({operationId, expectedContextRevision})` | só por clique, mesma operação, nunca reenvia |

Envelope com `contextRevision` diferente do contexto lido → a leitura inteira é descartada e refeita **uma** vez; se divergir de novo, nada é exibido.

## Suposições que Root precisa confirmar (ver `changeRequests` no DELIVERY.json)

1. Chaves de capability = nome da mutação (`capabilities['link.create']`, `capabilities['link.archive']`), valor `true` ou `{available, reason}`.
2. Payload de `link.create`: `{destination, origin, surface, campaign, date|null}`; marca, autoria e URL final ficam no servidor. `link.archive`: `payload {}` + `recordId` + `expectedRecordRevision`.
3. `pendingOperations`: array de `operationId` ou `{operationId, kind}`. Ausente = journal desconhecido → gravação fechada.
4. Marca no `binding`: lida de `effectiveBrand`, `brandId` ou `brand` (a primeira que existir). Divergente → resposta descartada.
5. `attribution-aggregate.data`: `daily`, `quality`, `coverage` são exibidos de forma genérica (sem soma nem cálculo). Campos `*Minor` são formatados como moeda com `data.currency`. Fixar os nomes dos campos permite uma tabela dedicada.
6. Item de link com `state === 'archived'` vai para o histórico; qualquer outro estado é tratado como ativo.

## Fora do escopo desta entrega

Rotas, auth, adapters, journal, banco, n8n/Meta, build/manifests, publicação e os seis aceites reais (acesso/marca, leitura/frescor, peça/atribuição, criar/reler/copiar, arquivar/recovery, percurso publicado) — todos com Root.

## Testes

- `node --test tests/organic-v2/*.test.cjs` — sem dependências (DOM em memória + gateway sintético).
- `tests/organic-v2/browser.smoke.test.cjs` usa Playwright/Chromium **se já existir** no ambiente; sem ele, o teste é marcado como `skip` (nada é instalado). Cobre render real, percurso só com teclado, 375px sem rolagem horizontal, alvos de toque ≥ 44px e contraste AA nos temas claro/escuro. `SOV2_SCREENSHOTS=<pasta>` grava capturas fora da entrega.
