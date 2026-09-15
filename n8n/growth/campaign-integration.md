# Cadastro de campanhas: dashboard e IA

Estado em 15/09/2026: o painel prepara rascunhos locais e importa/exporta JSON. `campaign-contract.js` centraliza as regras e `campaign-service.js` implementa o núcleo do serviço. **O endpoint de campanhas, seus adaptadores persistentes e o agendamento pelo painel ainda não estão implementados/publicados.** Os testes do serviço usam adaptadores em memória; não comprovam integração com o Listmonk real. A skill do Claude ainda não foi fornecida.

## Escopo

Cadastro de campanhas comerciais de e-mail de Fishermans e O Aristocrata. Criação de templates e edição das jornadas WhatsApp/e-mail já usam as APIs existentes e continuam separadas. Este contrato não habilita disparos de campanhas WhatsApp, Polpa ou Olivas.

A iniciativa comercial une os envios no relatório. `initiative.key` deve preservar a família já registrada em `crm_familia_campanha`, por marca. `utm_campaign` deve preservar o identificador adotado naquela campanha; aliases distintos podem pertencer à mesma iniciativa. Não migrar os históricos para uma convenção nova só por estética.

## Conteúdo compartilhado

Um JSON com `schema_version: "crm-campaign-v1"`, `brand: "fish" | "aristo"`, `channel: "email"`, `initiative: {key, name}`, `utm_campaign`, `name`, `subject`, `from_email`, `reply_to`, `list_ids`, `template_id`, `html`, `text`, `tags` e `send_at` (opcional, ISO 8601 com fuso). Exportar pelo painel fornece esse formato. Importar conteúdo que não passa na validação mantém o rascunho anterior.

A skill poderá conferir a estrutura usando o mesmo código do painel:

```sh
node n8n/growth/campaign-cli.cjs campanha.json > campanha-conferida.json
```

Saída zero significa apenas estrutura válida. Não confirma catálogo, rastreamento final, criação ou agendamento. Saída diferente de zero contém o erro em stderr. Não passar chaves, tokens, listas de contatos ou dados de pedidos nesse arquivo.

## Convenção de acompanhamento

| Campo | Regra |
|---|---|
| `initiative.key` | Família comercial por marca, preservando o mapa existente. |
| `utm_source` | `listmonk` nos e-mails deste emissor; manter a convenção histórica. |
| `utm_medium` | `campanha` nos e-mails comerciais; não renomear para `email`. |
| `utm_campaign` | Identificador estável da campanha, relacionado à iniciativa. |
| `utm_content` | Posição/peça do link existente; na ausência, `link`, `alt-link` ou `cupom-auto`. |
| `utm_term` | `lm-ID-lLISTAS`, com ID real do rascunho Listmonk e listas ordenadas. Se houver termo anterior, preservá-lo com o sufixo `--lm-ID-lLISTAS`. |
| Múltiplas listas | Identifica o conjunto do disparo; não comprova receita separada por lista. |

HTML e texto passam pelo mesmo preparador. O destino interno de cupons também recebe rastreamento. Produto, variante, cupom e parâmetros da oferta devem permanecer intactos. Link externo não é reescrito. O contrato exige ao menos um link comercial identificável e descadastro nas duas versões.

UTMs consistentes reduzem perdas de identificação. Não garantem atribuição de todas as compras: ausência de clique, links removidos, mudanças de dispositivo e jornadas indisponíveis continuam explicitadas nos relatórios. A receita atribuída vem da jornada conciliada; cadastrar uma campanha não cria conversão.

## API planejada — ainda indisponível

Autenticar na API existente, sem expor credenciais Listmonk ao navegador/skill. A chave de conteúdo já existente pode ser reutilizada quando o backend declarar as capacidades; não inventar endpoint ou usar a chave de leitura para gravar.

| Ação `acao` | Capacidade | Comportamento exigido |
|---|---|---|
| `campanha_catalogo` | `read_content` | Listas e templates atuais permitidos para a marca; mapa de iniciativas. |
| `campanha_listar`, `campanha_obter` | `read_content` | Rascunhos da marca, estado e versão atual. |
| `campanha_salvar` | `draft` | Reservar rascunho nativo sem enviar; preparar links com ID real; conferir gravação. |
| `campanha_validar` | `validate` | Conferir versão, catálogo, conteúdo, UTMs e vínculo comercial. |
| `campanha_agendar` | `submit` | Versão validada + `confirm: "agendar"` + data com ≥15 minutos. |
| `campanha_operacao` | `read_content` | Consultar resultado por identidade e chave de idempotência. |

Gravações exigem `idempotency_key` única por operação, reutilizada em consulta/repetição da mesma tentativa. Edições/validação/agendamento exigem `expected_version`. Timeout ou resultado incerto exige consulta; não gerar outra chave para repetir uma criação. Salvar nunca chama envio imediato.

## O que falta no backend

1. Adaptar o núcleo ao runtime real: módulos Node/CommonJS e `URL` não estão disponíveis automaticamente em Code nodes do n8n. O arquivo de serviço não é um workflow importável.
2. Implementar `store` persistente com claim transacional único por ator/chave, hash do pedido, lease, ID nativo, resposta e validação vinculada à versão. Nunca guardar a credencial no pedido/hash/histórico.
3. Implementar `provider` com catálogo atualizado, listas por marca, integração nativa Listmonk e preservação de headers/atributos não pertencentes ao editor. A criação sempre deixa status `draft`.
4. Provar a proteção concorrente na gravação e no agendamento. O núcleo requer troca atômica condicionada à versão; uma sequência GET/PUT sem guarda não cumpre o contrato. As rotas diretas de edição no Listmonk precisam entrar nessa análise.
5. Gravar o mapa de iniciativa em `crm_familia_campanha` com conflito explícito, na mesma operação lógica. Apenas preencher `attribs.crm` não atualiza o agrupamento da API atual. Conferir tags legadas `semana-cliente`/`desodorante`, que hoje também determinam família na view.
6. Validar callbacks, erros, recuperação de resultado incerto e catálogo com provas na instância. Só depois anunciar capacidades e ligar salvar/validar/agendar no painel.
7. Adaptar a skill do Claude e seus scripts para a mesma API. Até lá, criações diretas no Listmonk continuam fora desta proteção automática.

## O que precisamos da skill

`SKILL.md` e os scripts/helpers chamados por ela, ou o diretório/ZIP da skill. Não precisamos receber novamente as credenciais. A adaptação deve preservar o trabalho criativo atual e substituir a montagem livre de UTMs e o transporte direto pelo contrato validado.
