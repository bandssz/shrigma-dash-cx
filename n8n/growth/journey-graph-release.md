# Versão imutável do primeiro e-mail de carrinho

Candidato isolado para Fish e Aristo. Guarda a mensagem e seu contrato de dados antes de uma futura publicação de grafo. Não altera templates, listas, jornadas legadas ou participantes; não cria clone no Listmonk, não publica e não envia.

## Fonte concreta

A configuração existente do emissor de carrinho associa o primeiro e-mail a Fish **60** e Aristo **95**. Os catálogos privados consultados em 26/09/2026 foram processados localmente sem copiar HTML para o Git: ambos passaram pelo parser e pelo novo preparador. Os dois remetentes e Reply-To são os valores da configuração atual conhecida de cada marca. A implantação deve reconferir essa configuração; a constante no código não é uma consulta ao emissor ao vivo.

O SQL confirma, em cada preparação, a associação exclusiva do template à marca e o vínculo publicado `email:carrinho-30min`, com canal, peça e template exatos. A fonte é relida sob trava da definição, template e registro antes de persistir. Publicação/edição do template posterior não altera a versão já guardada.

Os templates usam o descadastro nativo `email.shrigma.com.br/subscription/.../{{ .Subscriber.UUID }}`. O UUID vem da identidade nativa validada na fonte; não é um identificador inventado nem um novo cadastro. `e`, `p` e `s` pertencem a outros modelos, como NPS, e não são necessários nesses dois e-mails. O preparador não aceita desviar a rota de descadastro para outro endereço.

## Variáveis e rastreamento

| Expressão | Origem fixada |
| --- | --- |
| `Tx.Data.checkout_url` | fato `cart.checkout_url`, completo e recente, com domínio da própria marca |
| `Tx.Data.items` | fato `cart.items`, completo e recente; todos os campos usados no AST devem estar presentes |
| `Tx.Data.first_name` / `total` | `contact.first_name` / `cart.total`, se a mensagem os usar |
| `Subscriber.UUID` | `source.subject_id`, validado contra a identidade do assinante pela fonte |
| `Tx.Data.preheader` | único default literal presente no template, fixado no snapshot |
| `Tx.Data.order_number` | somente default literal inequívoco: no Aristo95, **iniciada**; não representa número de pedido conhecido |

Um campo sem suporte, ausente, nulo, antigo ou sem prova de completude bloqueia a montagem. Texto opcional explicitamente vazio continua sendo um valor conhecido; não se inventam imagem, variante, preço ou quantidade. Default de `order_number` fora de uma saída `default` única — por exemplo, como condição — é recusado. A renderização Go continua sendo responsabilidade do renderer nativo; não há uma segunda implementação em JavaScript.

O snapshot preserva assunto, HTML, `body_source`, remetente, Reply-To, pré-header e regras de tracking. A montagem do checkout usa `utm_source=email`, `utm_medium=fluxo`, `utm_campaign=<marca>-carrinho`, `utm_content=carrinho-30min`, removendo UTMs antigos/duplicados e preservando outros parâmetros. HTTPS de outra marca, credenciais na URL e protocolos ativos são recusados. Checkout em domínio alternativo Shopify exige um vínculo de loja comprovado antes de ampliar a lista de hosts.

`required_fields` neste módulo é o contrato **material da mensagem**, incluindo `cart.items`. A ponte `graph_v1` o converte em `message.material.fields`, separado de `catalog.fields`, que continua contendo somente dados de condição. `cart_items` é um tipo material restrito, com lista explícita dos campos exigidos em cada item; nunca vira `string_set`. O descriptor não contém HTML, remetente, destinatário ou valores de fatos.

## Integração confiável

1. Instalar o SQL somente após o schema do candidato e com papéis/grants revisados. A instalação usa transação implícita única, recusa colisões, revoga `PUBLIC` e não escolhe credencial.
2. `createReleaseProvider({query}).prepare(actor,p)` recebe ator autenticado pelo backend e `{request_id,brand,binding,expected_snapshot}`. Reutilizar a mesma identidade/payload devolve a mesma versão. Conflito de ator/payload é recusado. `operation(actor,p)` reconcilia um resultado incerto sem nova identidade; `read(brand,id)` lê o snapshot original.
3. `catalogMessage(release)` produz o binding fixado por `id` e `material_sha256`; `bindCatalog(catalog,releases)` substitui somente bindings da mesma marca cujo snapshot de origem ainda corresponde ao catálogo informado. Essa composição é interna e não altera a disponibilidade global. O runtime verifica o descriptor contra o registro imutável na publicação do grafo e antes de persistir a intenção, usando a mesma conexão transacional. Não procura automaticamente a versão mais nova. Catálogos antigos de planejamento continuam compatíveis, mas `required_fields: []` não passa a significar variáveis comprovadas.
4. Validação/simulação reconhecem os materiais tipados; compra desconhecida ou positiva e consentimento ausente/negado bloqueiam uma mensagem com esse descriptor, mesmo se o grafo omitir uma condição explícita. A leitura precisa comprovar `purchase.confirmed=false` e `contact.email_allowed=true`, além de dados materiais completos e recentes. A fonte atual não inventa cobertura negativa de compras: sem um provedor completo verificado, o caminho fica bloqueado. A simulação não renderiza conteúdo nem prova entrega. `materialize(material,source,{now})` ainda confere domínio, contrato nativo, fonte elegível, consentimento e ausência de supressão; falha nessa etapa reverte a transição, o recibo e a intenção. Seu resultado fica apenas em memória e é descartado no executor candidato: não registrar contexto em logs/recibos nem expor a função ao cliente.
5. **Ainda não há vínculo de cache nativo ou transporte.** `snapshot_only=true`, `native_cache_bound=false`, `transport=false`. O adapter de clone/cache de B06 existente serve como referência, mas sua instalação antiga, restrita a Fish, não é aplicada nem ampliada aqui. Antes de enviar: vincular versão imutável ao cache Listmonk correto, participar da mesma exclusão/claim de carrinho legado e persistir o recibo de transporte. A preparação não autoriza repetir envio nem duplicar participantes.

## Provas

- `journey-graph-release.test.cjs`: PGlite, oito casos de isolamento por marca, duas formas reais de template sintetizadas, fontes/variáveis, idempotência, conteúdo imutável, falha atômica de recibo e privilégios/escopo da migração.
- `journey-graph-material.test.cjs`: seis casos locais de fonte SQL → release → contrato/simulação → executor sem transporte, nas duas marcas; arrays tipados, dados ausentes/antigos, compra desconhecida, opt-out, revisão fixada e rollback de montagem. Usa um provedor negativo **sintético**, sem afirmar que a cobertura de compras já existe em produção. O schema nasce OFF; habilitação dos testes ocorre somente na base descartável.
- `journey-graph-release-postgres.cjs`: runner separado de PostgreSQL real para concorrência da mesma solicitação, deduplicação de conteúdo, mudança de template enquanto aguarda trava e rollback do recibo. Exige base vazia `journey_graph_release_test`, usuário `synthetic`, localhost:5432 e `GRAPH_TEST_DATABASE_ISOLATED=1`. Preparado para CI; não afirmar executado até obter seu resultado.
- Prova dos dois corpos atuais permanece em arquivo privado somente com IDs, campos e hashes (`release-native-shape-safe.json`). Não é prova de cache, entrega ou ativação.
