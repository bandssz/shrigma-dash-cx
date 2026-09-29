# Material declarado da campanha A/B — contrato em sombra

`ab-audience-material.cjs` define `crm-ab-audience-material-v1`. É um módulo puro, privado, sem I/O, autenticação, rota HTTP, seleção, agendamento, transporte ou escrita nativa. `ENABLED` permanece `false`. Seu hash identifica as linhas declaradas da campanha e suas dependências; não constitui autorização nem garante os bytes finais renderizados ou enviados.

## Entrada e leitor confiável

O chamador deve obter, em uma leitura consistente do banco, um snapshot completo destas linhas:

```js
{
  campaign: /* to_jsonb(campaigns row) */,
  template: /* to_jsonb(templates row), template_id explícito */,
  lists: [
    {relation: /* campaign_lists row */, list: /* lists row */}
  ],
  media: [
    {relation: /* campaign_media row */, media: /* media row */}
  ]
}
```

O leitor deve devolver o JSON como **texto** e chamar `parseDatabaseSnapshot(text)` antes de qualquer desserialização automática do driver. Uma fração como `1.00000000000000001` pode virar o inteiro JavaScript `1`; validar apenas o objeto já desserializado não detecta essa perda. O parser verifica os tokens numéricos originais, exige inteiros seguros escritos sem fração/expoente, rejeita `-0`, chaves duplicadas e JSON malformado, e só então desserializa. Números dentro de strings, HTML ou código de template não são interpretados.

O objeto resultante segue para `normalize(snapshot, {brand, campaignId})`, `hash(snapshot, {brand, campaignId})` ou `materialize(snapshot, {brand, campaignId})`. `brand` aceita `fish` e `aristo`; `campaignId` é um inteiro positivo de 32 bits. A identidade precisa corresponder à campanha e a `attribs.crm.policy='crm-campaign-v1'` / `attribs.crm.brand`. Uma definição enviada por cliente, um MD5 legado ou um objeto parcial não substitui a leitura confiável. O contrato não autentica o chamador nem comprova por si só a origem/completude da captura.

`REQUIRED_FIELDS` expõe as colunas obrigatórias do esquema Listmonk 6.1.0. Colunas adicionais dentro das linhas são preservadas integralmente e entram no hash; campos adicionais no envelope ou nos pares de dependências são recusados. As colunas obrigatórias são:

| Linha | Colunas |
| --- | --- |
| `campaigns` | `id`, `uuid`, `name`, `subject`, `from_email`, `body`, `body_source`, `altbody`, `content_type`, `send_at`, `headers`, `attribs`, `status`, `tags`, `type`, `messenger`, `template_id`, `to_send`, `sent`, `max_subscriber_id`, `last_subscriber_id`, `archive`, `archive_slug`, `archive_template_id`, `archive_meta`, `started_at`, `created_at`, `updated_at` |
| `templates` | `id`, `name`, `type`, `subject`, `body`, `body_source`, `is_default`, `created_at`, `updated_at` |
| `lists` | `id`, `uuid`, `name`, `type`, `optin`, `status`, `tags`, `description`, `created_at`, `updated_at` |
| `campaign_lists` | `id`, `campaign_id`, `list_id`, `list_name` |
| `media` | `id`, `uuid`, `provider`, `filename`, `content_type`, `thumb`, `meta`, `created_at` |
| `campaign_media` | `campaign_id`, `media_id`, `filename` |

Não existe fallback para o esquema reduzido de fixtures antigas. Campos de data nullable permanecem `null` quando o banco informa `null`; nenhuma data é sintetizada.

A v1 exige campanha `regular`/`email`, template explícito existente do tipo `campaign`, ao menos uma lista, relações consistentes e IDs de dependências únicos. Recusa dependência ausente/deletada, template implícito/default e `archive_template_id` não nulo. Um template explícito pode ser também o default; nesse caso sua linha ainda está declarada e fixada. O contrato não valida disponibilidade operacional da lista, consentimento, capacidade do operador, reputação do remetente ou validade funcional do conteúdo.

## Material e progresso operacional

Após validar a forma e o tipo, somente estes sete campos da linha **campaigns** são removidos:

```text
status, sent, to_send, max_subscriber_id, last_subscriber_id,
started_at, updated_at
```

São os campos de estado, contadores e checkpoint que as consultas nativas modificam durante o processamento. Assunto, remetente, todos os headers, HTML, texto alternativo, origem do corpo, template, tags, horário agendado, UUID, atributos, metadados de arquivo/publicação e qualquer coluna futura continuam no material.

Todas as colunas das dependências permanecem hashadas, inclusive `created_at` e `updated_at` quando existentes no esquema. Portanto tocar apenas `templates.updated_at` ou `lists.updated_at` **invalida conservadoramente** o material. Não inferimos equivalência operacional dessas datas, nem introduzimos timestamp de captura no hash. Uma nova captura idêntica produz o mesmo resultado.

Esse material estável é separado do MD5 retornado por `shrigma_campaign_current()`, que inclui a linha inteira e muda com o progresso. Não substitui esse MD5 no contrato de edição, vínculo, preparo, conferência ou agendamento existente.

## Canonicalização, hash e limites

`HASH_CONTRACT` é `json-utf8-key-order-safe-integer-sha256-v1`:

- Objetos têm chaves ordenadas lexicograficamente pelos bytes UTF-8. Unicode deve conter somente sequências válidas de valores escalares; substituição de surrogate inválido é recusada. Não há normalização NFC/NFD: strings distintas permanecem distintas. NUL é recusado, conforme a fronteira JSONB do PostgreSQL.
- Números são apenas inteiros seguros JavaScript, sem `-0`. Valores fracionários ou fora desse intervalo em `attribs`, `meta` ou outra coluna tornam esta v1 indisponível, sem arredondamento ou conversão silenciosa para strings. Precisão decimal irrestrita exigiria outro contrato e parser.
- `lists` é ordenado por `relation.list_id`; `media`, por `relation.media_id`. IDs duplicados são recusados. Arrays internos, inclusive headers e tags, preservam sua ordem exata.
- O encoder não executa `toJSON`, getters ou traps de proxies. Recusa protótipos personalizados, proxies, símbolos, propriedades não enumeráveis, arrays esparsos/com propriedades extras, ciclos e valores não JSON. Objetos simples e de protótipo nulo são aceitos. Chaves textuais como `__proto__` são tratadas como dados próprios, sem alterar protótipos.
- O texto original, a representação canônica e o envelope normalizado têm limite de **8 MiB** cada. Não existe limite de 32 KiB por string. HTML grande é aceito dentro do orçamento total. Limites adicionais: **1.000 dependências** contando template + listas + mídias, profundidade 32 e 300.000 nós JSON. IDs nativos de 32 bits e IDs `BIGSERIAL` de relação que excedam a precisão segura são recusados.

`normalize()` devolve, profundamente congelado:

```js
{contract: VERSION, brand, campaign_id, snapshot}
```

`digest(value)` calcula SHA-256 dos bytes UTF-8 de `canonical(value)`. `hash(rawSnapshot, scope)` equivale a `digest(normalize(rawSnapshot, scope))`. A identidade da campanha, a marca e a versão do contrato participam do hash. `materialize()` devolve o mesmo envelope, profundamente congelado, com:

```js
{
  material_hash: /* hash SHA-256 hexadecimal de 64 caracteres */,
  authorizes_selection: false,
  authorizes_send: false,
  execution_blocked: true,
  external_dependencies_complete: false
}
```

Não há hora atual, ID aleatório ou estado operacional externo nesse resultado. O chamador pode armazenar um instante de captura separadamente, se necessário, sem acrescentá-lo ao material hashado.

## Limites de anexos, configuração e renderização

As linhas `campaign_media` e `media` fixam apenas relações e metadados declarados. O módulo não resolve URLs, consulta APIs, lê armazenamento remoto ou baixa arquivos. Um arquivo substituído no mesmo endereço pode conservar os mesmos metadados no banco e o mesmo hash. O tamanho em `media.meta` não é prova dos bytes do arquivo; não há garantia de digest do anexo nesta v1.

Configurações globais, transportes, headers globais de SMTP, URLs/tracking, funções de template, conteúdo remoto e dados de assinantes não fazem parte deste snapshot. O Listmonk expõe campanha e assinante ao template e oferece funções de tempo/Sprig. Um template pode consultar campos operacionais excluídos, como `.Campaign.Sent` ou `.Campaign.Status`, ou gerar resultado dependente do horário e do assinante. **O mesmo material hashado pode produzir bytes renderizados diferentes.** Capturar as linhas de template não torna essas funções nem seus inputs externos imutáveis. Por isso `external_dependencies_complete` permanece `false` inclusive sem anexos.

O leitor de banco deve comprovar identidade e conjunto completo das dependências e detectar deriva entre leituras sob seus próprios locks/limites. Autorização, consentimento atual, congelamento de público, seleção nativa e execução de envio exigem contratos separados. Este módulo não muda flags nem conecta esse material ao percurso operacional existente.

## Base e verificação local

A seleção de campos foi conferida contra `campaign-provider.sql:shrigma_campaign_current`, o esquema reduzido de `tests/campaign-provider-schema.sql`, o schema nativo local e as consultas da versão fixada por `tools/listmonk-ab-build/upstream.lock.json`: Listmonk 6.1.0, commit `1b5e8d38c778e869003486d3c38bc7a964661e91`. A consulta nativa `campaigns.sql` inspecionada corresponde ao SHA-256 fixado `37b1b131a6b9005141b1bf2e32dde53a68838184bc4348f6c97fb61b581c5882`. Ela documenta o fallback de template, as relações de mídia e as atualizações dos sete campos operacionais. O schema oficial inspecionado tem SHA-256 `9d94ea32ee76aab91f6fc5c1179539513a8a955984951570ed537b1916230a8f`.

`tests/ab-audience-material-contract.test.cjs` verifica estabilidade durante progresso, sensibilidade semântica, colunas futuras, dependências/datas, limites, HTML grande, precisão numérica antes do parse, Unicode, coerções e imutabilidade. O teste de MD5 modela seu input de linhas inteiras; não simula a representação textual exata de JSONB do PostgreSQL. A integração do leitor deve testar o MD5 real e concorrência em banco separadamente. Nada nesta prova usa produção, credenciais, browser, envio ou ativação.
