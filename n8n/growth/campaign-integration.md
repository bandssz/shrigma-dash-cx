# Cadastro de campanhas: dashboard e IA

Estado em 18/09/2026: o painel prepara rascunhos locais e importa/exporta JSON. `campaign-contract.js` centraliza as regras e `campaign-service.js` implementa o núcleo do serviço. **O endpoint de campanhas, a ligação do adaptador ao runtime e o agendamento pelo painel ainda não estão implementados/publicados.** O armazenamento PostgreSQL de operações/validações está implementado em `campaign-store.sql` e `campaign-store.js`; a ativação é registrada abaixo. Os testes do serviço usam adaptadores em memória; não comprovam integração com o Listmonk real. A skill do Claude foi recebida nesta rodada e revisada em pacote separado, com os mesmos módulos de contrato/preparo e um CLI local. Isso ainda não habilita o endpoint remoto.

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
2. Integrar o `store` PostgreSQL implementado ao runtime autenticado: claim único por ator/chave, hash do pedido, token de dono, ID nativo, resposta e validação vinculada à versão. Nunca guardar a credencial no pedido/hash/histórico. O token não expira para autorizar reenvio; resultados incertos exigem conciliação.
3. Implementar `provider` com catálogo atualizado, listas por marca, integração nativa Listmonk e preservação de headers/atributos não pertencentes ao editor. A criação sempre deixa status `draft`.
4. Provar a proteção concorrente na gravação e no agendamento. O núcleo requer troca atômica condicionada à versão; uma sequência GET/PUT sem guarda não cumpre o contrato. As rotas diretas de edição no Listmonk precisam entrar nessa análise.
5. Gravar o mapa de iniciativa em `crm_familia_campanha` com conflito explícito, na mesma operação lógica. Apenas preencher `attribs.crm` não atualiza o agrupamento da API atual. Conferir tags legadas `semana-cliente`/`desodorante`, que hoje também determinam família na view.
6. Validar callbacks, erros, recuperação de resultado incerto e catálogo com provas na instância. Só depois anunciar capacidades e ligar salvar/validar/agendar no painel.
7. Adaptar a skill do Claude e seus scripts para a mesma API. Até lá, criações diretas no Listmonk continuam fora desta proteção automática.

## Integração com a skill revisada

O pacote Claude v2 preserva a criação e o repertório de marca, inclui normalização/preparo locais com cópias versionadas destes módulos e um checklist HTML/texto/wrapper. O catálogo e os snapshots fornecidos aos helpers precisam vir de consultas reais; o sucesso local não comprova autenticação ou disponibilidade do provedor. O transporte central será ligado quando os adaptadores acima estiverem implementados e verificados. Não é necessário repassar credenciais.


Olivas foi adiada por Felipe em 18/09; o escopo de entrega atual é Aristo e Fishermans. O contrato Olivas já existente permanece preservado, sem novas ativações: remetente/Reply-To existentes em `olivasdocampo.com`, loja e links em `olivasdocampo.com.br`. `CampaignContract.STORES` separa domínio comercial de `BRANDS` (domínio do e-mail). Aplicam-se as mesmas UTMs, catálogo por marca, identidade de disparo e guardas. Preparador local disponível; conexão persistente do servidor e atualização do pacote Claude para incluir Olivas ainda devem ser concluídas.


## Persistência das operações — 18/09

Migração aplicada em 18/09: criação confirmada por consulta após COMMIT. A primeira tentativa retornou 502; antes da segunda, a leitura confirmou que nenhum dos três objetos existia. 33 testes Node passaram e os cenários SQL passaram com rollback. Ainda não há endpoint ou ligação ao emissor/painel; nenhuma campanha foi criada/agendada por esta implantação.

`campaign-store.sql` cria duas tabelas próprias e uma função interna, sem alterar tabelas Listmonk ou enviar mensagens. `campaign-store.js` adapta consultas PostgreSQL parametrizadas ao núcleo do serviço. O adaptador exige retorno `{rows:[{result:...}]}` e confirmação explícita das escritas; resposta vazia não vira sucesso.

- Reserva única por ator autenticado/chave, com hash do pedido e identidade do rascunho remoto. O token de escrita só é devolvido ao primeiro dono da reserva; a consulta de operação não o expõe.
- Operações pendentes/incertas nunca são recuperadas automaticamente por idade. Mesmo depois de um timeout, outra tentativa com a mesma chave não recebe uma nova reserva.
- Finalização terminal é idempotente apenas para o mesmo resultado. Outra resposta ou outra identidade remota é recusada; conciliação administrativa futura requer seu próprio procedimento auditado.
- Validação guarda a versão revisada. O serviço já exige correspondência de versão antes de agendar; o adaptador do provedor ainda precisa implementar comparação e troca atômicas.
- Sem SECURITY DEFINER, acesso PUBLIC revogado. Backend deve autenticar antes da chamada e usar o dono/grant explícito; não expor esta função como endpoint SQL genérico. Escopo desta etapa: aristo/fish.

A validação SQL em `tests/campaign-store.sql` deve rodar junto da migração dentro de BEGIN/ROLLBACK, em ambiente sem essas tabelas, usando apenas operações sintéticas. Os testes Node cobrem parametrização e falhas de confirmação; testes do serviço incluem chamadas simultâneas com adaptadores em memória. Isso não é prova de concorrência do futuro endpoint/provedor real.

Permanecem necessários: adaptador Listmonk com proteção atômica contra edições externas, API autenticada, catálogo por marca, gravação do mapa de iniciativa, consulta de operações no painel e ligação salvar/validar/agendar. Não anunciar essas capacidades no navegador/skill até a prova ponta a ponta. A existência destas tabelas, por si só, não protege criações diretas no Listmonk.


## Adaptador do provedor — preparado, ainda sem ativação

`campaign-provider.sql` e `campaign-provider.js` implementam catálogo por marca, leitura de revisões e operações condicionadas à versão. `campaign-native.js` prepara criação nativa como rascunho sem data e compilação por prévia, sem envio. Nenhum desses módulos é, isoladamente, um endpoint n8n. O armazenamento da etapa anterior continua instalado; este novo adaptador ainda não foi aplicado permanentemente.

- O catálogo usa tags de marca inequívocas e o vínculo conhecido das bases 16/17. Listas sem vínculo, cross, aposentadas ou de outra marca ficam fora; arquivadas não podem ser usadas. Títulos de listas não são prova de propriedade. Templates transacionais ficam fora do cadastro comercial.
- A versão inclui dados atuais da campanha, listas, mídia e wrapper. O SQL bloqueia a campanha, confere estado/versão, revalida listas e template, preserva cabeçalhos e atributos alheios ao editor, grava a iniciativa e invalida a validação anterior na mesma transação. Não modifica anexos/arquivo público.
- Agendamento exige operação pendente da marca, rascunho não iniciado, validação correspondente à versão, iniciativa mapeada e antecedência mínima de 15 minutos. A gravação do estado é atômica, sem endpoint de envio imediato.
- Compilação usa três prévias separadas (HTML, assunto e texto), com wrapper, antes da gravação. O backend gera a prova; não aceitar contentValidated do navegador. O adaptador de transporte deve manter credenciais no servidor, origem fixa e não seguir redirects autenticados.
- O comparador detecta mudanças externas anteriores à operação, inclusive se updated_at não mudou. **Não protege edições que continuem sendo feitas diretamente no Listmonk por um caminho que não exige versão.** Coordenar esses caminhos continua sendo condição para declarar concorrência ponta a ponta resolvida.

Provas locais: 42 testes JavaScript aprovados e PostgreSQL isolado com PGlite 0.3.14. O teste integrado executa serviço, store e provider contra o banco isolado, incluindo duas solicitações iguais, preparo das UTMs, validação e agendamento; criação/compilação nativas são simuladas e não existe transporte. Isso não é prova de campanha agendada em produção. O CI agora executa também os cenários SQL isolados.

Uma prévia nativa POST /api/campaigns/126/preview, com conteúdo técnico próprio, retornou HTTP 200 e o texto esperado, sem envio. Isso comprova a rota/formato de prévia, não a integração completa nem criação/agendamento reais.

Na tentativa de integração, a API n8n oscilou com 502; healthz respondeu 200, sem provar saúde da API/execuções. A consulta de compatibilidade em transação com rollback não retornou JSON utilizável. O workflow temporário de inspeção foi desativado e removido (200). Nenhum emissor de produção foi alterado e os botões remotos continuam indisponíveis.

Próximos gates: conferir o schema real das relações usadas; executar prova com rollback na instância; montar autenticação e orquestração nativa no n8n; conferir compilação/rascunho reais; coordenar escrita direta Listmonk; só então publicar capacidades e ligar o painel/skill. A/B e editor de jornadas não foram ativados por esta etapa.

Referências primárias usadas na revisão: [API de campanhas](https://listmonk.app/docs/apis/campaigns/), [core de campanhas v6.1.0](https://github.com/knadh/listmonk/blob/v6.1.0/internal/core/campaigns.go) e [consultas v6.1.0](https://github.com/knadh/listmonk/blob/v6.1.0/queries/campaigns.sql). Manter compatibilidade com a versão instalada antes de aplicar novas versões.
