# Clone nativo imutável do release de grafo

Candidato OFF para Fish e Aristo. Adiciona apenas a reserva e o registro de um clone de template transacional no Listmonk. Não contém `/api/tx`, envio, enrollment, ativação ou alteração de template original. Não foi instalado nem comprovado contra cache de produção por estes testes.

O snapshot é `message_release_v1.material.native`, fixado anteriormente com seu contrato de marca e conteúdo. A criação não relê o original: editar o original depois do release não modifica o clone. Fonte, remetente, consentimento, compra, intenção e dedupe de carrinho continuam sob os contratos de release/fonte/entrega; criar um clone não os comprova.

## Dependências confiáveis

`createNativeProvider({query,nativeCreate,nativeRead,cacheTarget,timeoutMs?})` recebe somente dependências do servidor. O ator de `prepare/operation` vem da autenticação existente, nunca do corpo do operador. Este módulo não instala uma API pública nem concede permissões de operador.

- `query` usa SQL fixo parametrizado. Para `resolve`, pode ser a conexão da transação do consumidor.
- `nativeCreate(body, options)` realiza **uma** chamada ao endpoint nativo de criação de templates, fixo no adaptador do servidor. `nativeRead(id, options)` consulta somente esse ID no mesmo serviço. Não aceitam URL, chave ou destino fornecidos pelo operador. Retornam `{status,body:{data:template}}`.
- `options` contém `{cacheTarget,signal,timeoutMs,maxResponseBytes:350000}`. O transporte deve respeitar abort, limite de resposta, ausência de redirect e de retry. O provider também aplica timeout e limite ao resultado. Timeout padrão10s, máximo30s; não há retentativa interna.
- `cacheTarget` é identidade opaca da **única instância Listmonk verificada** que compila o template e executará o futuro transporte. O texto isolado não prova afinidade, cache, topologia ou ausência de réplicas. A integração precisa provar essa vinculação antes de usar `ready`; um balanceador ou troca de instância exige nova avaliação. Nenhuma chamada GET, hash do banco ou fixture substitui essa prova.

## API e recibo estritos

`prepare(actor,{request_id,brand,release_id,expected_material_sha256})` reserva ou reutiliza o mesmo release/alvo. Ator, payload e alvo ficam ligados à identidade da operação; alteração no replay é recusada. `operation(actor,request)` retorna o recibo atual da mesma reserva, ou `null` se não há operação confirmada. Esse null não autoriza trocar request_id às cegas.

`create(brand,native_id)`, `inspect(brand,native_id)` e `resolve(brand,release_id,material_sha256)` devolvem exatamente:

```js
{
  contract: 'journey_graph_native_v1',
  native_id, brand, release_id, material_sha256, native_sha256, cache_target,
  state: 'reserved' | 'creating' | 'ready',
  clone_template_id: null | integer,
  cache_ack_at: null | timestamp
}
```

Somente `ready` admite ID nativo e carimbo de ACK. Os demais estados têm ambos `null`. O recibo não contém token, HTML, endereço, contato ou payload de envio. O nome reservado é `__shrigma_graph_tx_v1_<native_id>`.

`resolve` chama `crm_graph_candidate.native_resolve_v1(brand,release_id,material_sha256,cacheTarget)`: exige ready e reconfere marca, hash/material do release, conteúdo completo do clone, nome, `is_default=false`, exclusão do catálogo editável e presença de triggers/índice válidos. Não escolhe a versão mais recente. Hash ou marca divergentes, clone alterado ou guardas ausentes impedem o uso.

## Criação, incerteza e confirmação

`reserved → creating → ready` é monotônico. `native_begin_v1` persiste a reserva e retorna token/snapshot somente ao primeiro vencedor. Concorrentes ou chamadas posteriores recebem apenas o estado, sem token e sem novo POST.

Após resposta200 com identidade, conteúdo e `is_default=false` exatos, o provider guarda a capacidade de confirmação **apenas em memória** e chama `native_confirm_v1`. A função reconfere a linha nativa e os guards antes de registrar ready. Se só a resposta SQL se perdeu, `confirm(brand,id)` pode repetir a confirmação com **o mesmo token e ID**, sem repetir criação. Outra instância do provider não recebe esse token: `inspect` informa ready se o commit já ocorreu. Token não confirmado não expira para permitir novo envio/criação.

Se a resposta nativa, a reserva SQL ou o ACK se perderem, o erro é `GRAPH_NATIVE_OUTCOME_UNKNOWN`; nenhum erro do provedor/corpo remoto é exposto. `creating` permanece bloqueado até prova posterior. Não há deleção, reset, nova identidade ou retry automático para “destravar”.

`reconcile(brand,id)` é somente leitura e devolve `{receipt,diagnosis,native_id_candidate}`. Diagnósticos: `ready`, `not_started`, `native_missing`, `native_exists_cache_unconfirmed`, `native_read_unconfirmed`, `native_mismatch`. Encontrar o clone no banco e obter GET exato **não** muda creating para ready: falta o ACK confiável do cache. `native_missing` também não prova que uma criação anterior nunca chegará.

## SQL e isolamento

Instalação transacional exclusiva: exige release/templates/registry existentes e recusa colisão de tabelas, funções, nomes reservados, triggers ou índice. Não é migração para reaplicar automaticamente. O instalador deve comparar a versão exata antes de nova instalação; não substituir guards silenciosamente.

As novas tabelas ficam em `crm_graph_candidate`. Os únicos triggers fora dele protegem o novo prefixo em `public.templates` e impedem sua inclusão em `shrigma_template_email_registry`; B06 usa outro prefixo e permanece independente. O clone não pode ser alterado, renomeado, apagado ou virar padrão. Atualização de `updated_at` e manutenção de `is_default=false` são permitidas. Reservas e pedidos não podem ser apagados. `PUBLIC` é revogado nas tabelas e nas14 assinaturas novas explicitamente; nenhum grant ou credencial é inventado.

## Provas e limites

`tests/journey-graph-native.test.cjs` usa PGlite e API/cache sintéticos: ambas as marcas; original editável; prefixos B06/graph coexistentes; payload/ator/hash/marca/alvo; guardas; conteúdo imutável; perda antes/depois ACK; confirmação exata; timeout/abort; rollback de recibo; ausência de retry; SQL público revogado.

`tests/journey-graph-native-postgres.cjs` usa PostgreSQL17 em banco vazio **journey_graph_native_test**, localhost:5432, usuário `synthetic`, com `GRAPH_TEST_DATABASE_ISOLATED=1`. Prova sessões concorrentes de prepare/create, lock real, token apenas no vencedor, resposta perdida e atomicidade de recibo. Preparado para CI: não afirmar execução real até ler seu resultado. As chamadas nativas nesse runner também são sintéticas; zero envio/HTTP externo.
