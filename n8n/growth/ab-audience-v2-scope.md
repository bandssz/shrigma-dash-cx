# Escopo do próximo A/B com público v2

Análise local, sem ativação. Este documento não altera contrato A/B, coordenador, binding, seletor, imagem ou pin publicado. O guard do binding permanece intacto. A correção necessária é formar o conjunto elegível do público v2 **antes** da permutação aleatória e da divisão em braços; filtrar uma coorte da base somente no envio não corrige o denominador já gravado.

## Caminho atual confirmado

| Ponto | Comportamento existente | Consequência para público v2 |
|---|---|---|
| `growth-ab-experiment-contract.js:29` e `ab-experiment-core.sql:33` | Protocolo exato, sem campo de público/binding. | Acrescentar um campo silenciosamente quebra validação; a intenção de público precisa de entrada versionada explícita. |
| `ab-experiment-api.sql:7` e `:49` | Autentica Growth, deriva ator estável e encaminha payload ao controle. | O caminho novo precisa carregar pins verificáveis e revalidar autorização após esperas; um snapshot de caps anterior ao lock não é prova de autorização atual. |
| `ab-experiment-coordinator.sql:85` e `:96` | Lock de operação, runtime/settings e recibo; prepare exige runtime A/B conhecido. | Preservar recibo atômico, replay exato e recusa quando indisponível. O recorte atual não libera essa capacidade. |
| `ab-experiment-core.sql:82` | Duas campanhas draft da marca, MD5 nativo esperado, mesmas listas e dependências bloqueadas. | As duas precisam ter binding explícito do **mesmo público/revisão/contexto/base**, e listas nativas exatamente `[base]`. Hashes dos bindings são diferentes porque incluem campanha; compare cada um com seu pin e compare o escopo semântico entre os dois. |
| `ab-experiment-core.sql:101` | Limita trabalho a 100 mil associados nas listas, bloqueia subscribers/associações e monta `members` só pelo consentimento nativo das listas. | O array atual ignora a regra v2. Aqui deve entrar a seleção completa antes de calcular `n`. Não relaxar o teto de varredura da base só porque o público final é pequeno. |
| `ab-experiment-core.sql:111` | Mínimo por braço usa esse `n`; seed + SHA por id dividem a coorte; `allocated_count` vem de `crm_ab_member_v2`. | Manter algoritmo e denominador fixo, mas alimentá-los exclusivamente com membros do público selecionado. |
| `ab-experiment-coordinator.sql:50` | Review reconta membros alocados com consentimento nas listas fonte, sem regra v2; fingerprint cobre apenas ids elegíveis dessa verificação. | Review deve revalidar escopo fixado e consentimento/regra dos alocados, sem incluir novos inscritos nem redistribuir braços. |
| `ab-experiment-coordinator.sql:127` | Schedule confere versão, validade e evidência atual; atualiza ambos os braços e recibo na transação. | A evidência precisa incluir os pins v2 e fingerprint da coorte elegível, além das verificações atuais. Guard do binding continua barrando schedule até uma futura integração operacional explícita. |
| `ab-experiment-core.sql:142` e `growth-ab-experiment-contract.js:51` | Medição usa `allocated_count`; taxa = cliques únicos/alocados. Se `native_sent != allocated`, o resultado fica inconclusivo. | Não substituir allocated pelo count dinâmico de hoje nem pelo total enviado: isso mudaria a população/estimativa e esconderia exclusões. |
| `segment-listmonk-selection.sql:158` | Predicado atual verifica binding/contexto/base/consentimento para cada membro selecionado. | Prova a interseção braço ∩ público; não cria uma coorte A/B previamente restrita ao público. OFF/unknown vira supressão, não preparação válida. |

O provider de campanha continua necessário para conteúdo, remetente, template, dependências e revisão nativa (`campaign-provider.sql:101`, `:134`, `:161`). Sua revisão da união de listas não atesta a regra v2 e não pode ser reutilizada com outro significado sem evidência adicional explícita.

## Prova negativa executável

`tests/ab-audience-v2-scope.test.cjs` usa PGlite, o fixture real do binding, serviço de conferência/vínculo, guards reais, contador v2, core, provider e coordenador SQL atuais. Para **cada marca**, a base tem dois elegíveis e a regra v2 tem somente um:

1. Dois drafts recebem vínculos reais com a mesma revisão do público. O contador real retorna 1.
2. O controle normal recusa prepare com `AB_V2_TRANSPORT_UNAVAILABLE`; nenhum runtime é habilitado.
3. Uma chamada direta ao **core interno confiável** isola a semântica de alocação: o protocolo com mínimo 1 por braço é aceito e grava 1+1, incluindo a pessoa fora do público. Isso não afirma que o endpoint desligado permita a ação.
4. Reviews reais das campanhas e review A/B continuam reportando 1+1. A medição lê denominador total 2, enquanto o público tem 1 e jamais poderia satisfazer esse mínimo.
5. Schedule continua recusado; as quatro campanhas permanecem draft, sent=0, started_at=NULL e o trigger do binding permanece habilitado.

Resultado local: **1 teste passou**, cobrindo Fish e Aristo. Não houve envio, ativação de runtime, alteração de guard nem simulação de entrega. A prova não depende do arquivo upstream, pois isola preparação/revisão/denominador antes da seleção nativa.

```sh
NODE_PATH='/Users/felipebandeiragoncalves/projetos/GPT- Dashboard Bandeira/.private/test-tools/node_modules' node --test tests/ab-audience-v2-scope.test.cjs
```

## Menor implementação coerente para o próximo recorte

1. **Intenção versionada de preparação.** Introduzir entrada explícita para A/B com público, preservando o protocolo legado. Ela contém o protocolo A/B e pins de ambos os bindings: campaign id/native version, binding version/hash, audience id/revision, definition hash, context hash, base e catalog hash visto. Não aceitar subscriber ids, SQL, ator/caps ou contagens do cliente como fonte da coorte. Reusar o fluxo de operação durável e reconciliação por recibo.

2. **Escopo imutável por experimento.** Uma tabela nova, por exemplo `crm_ab_audience_scope_v2`, ligada 1:1 a `test_id`, guarda a revisão original, definição/contexto/hashes/base, pins dos dois bindings e fingerprint privado do conjunto alocado. Não repontar para o head atual de público/binding ao reabrir. O vínculo deve existir antes do prepare; não tentar vincular depois da alocação. Alteração posterior de binding deve ser recusada enquanto o experimento estiver ativo, ou tornar sua revisão inequivocamente inválida.

3. **Resolver elegibilidade antes da divisão.** Na transação de prepare, após CAS/locks, conferir ambos os bindings e históricos, marca, draft, singleton base, catálogo pronto/fresco e `pins(definition,current)==context_hash`. Inicialmente aceitar somente árvores `in_list` E/OU; qualquer folha externa, mesmo em OU, é indisponibilidade e recusa atômica, nunca conjunto vazio. O resolvedor retorna estado confirmado + relação de membros privados, não somente boolean false. Compartilhar a semântica de base/folhas com contador e seletor; não chamar `selection_allowed` como fonte de prepare porque ele depende do runtime e inclui obrigações de transporte que não são autorização de alocação.

4. **Snapshot e locks reais.** Preservar a ordem inicial operação/runtime/settings/marca/campanhas em ordem numérica. Tomar binding heads depois dos locks das campanhas, seguido de config, catálogos/dependências e público/revisão em ordem compatível com o writer do binding. Bloquear estado global e associações da base **e de todas as folhas utilizadas**, em ordem estável. Materializar um snapshot das associações efetivamente lidas/bloqueadas e derivar a coorte somente dele: um `FOR SHARE` nas linhas existentes não impede phantoms de novas associações, portanto não fazer depois um rescan solto que acrescente membros não bloqueados. Esse limite temporal precisa ser explícito e testado em PostgreSQL real. Autorização, prazo e pins são reavaliados após esperas e antes do recibo/commit.

5. **Alocar uma única vez.** Sobre a relação confirmada, computar `n`, aplicar limite/mínimo e usar a seed/permutação 50/50 atuais. Inserir experimento, escopo, braços, membros, allocated_count e recibo na mesma transação. Não chamar o prepare legado para depois apagar membros, recalcular denominador ou gravar um segundo recibo. Falha/timeout incerto não ganha retry automático; ACK perdido é resolvido por operação existente, mantendo seed, membros e braços.

6. **Review e runtime preservam o conjunto.** Review trabalha sobre os alocados originais, exige contexto imutável válido e reavalia consentimento/regra; novos inscritos não entram e opt-out não é substituído. Denominador permanece o total alocado no prepare. Drift antes de schedule exige nova conferência, sem redistribuição. Indisponibilidade durante execução futura deve suspender com motivo/continuidade registrada; não ser confundida com público vazio ou conclusão normal. O guard atual, os pins de imagem e os flags OFF só podem mudar em outro marco explicitamente validado.

## Testes mínimos da implementação futura

- Para ambas as marcas, AND/OR e singleton base: coorte antes da divisão igual aos ids elegíveis do SQL real, união dos braços igual à coorte, interseção vazia, equilíbrio <=1 e count do painel igual ao total inicial; mínimo calculado sobre o público, não sobre a base. A prova negativa acima deve passar a ser uma recusa do caminho novo.
- Dois bindings com públicos/revisões/contextos diferentes, braço sem binding, CAS velho, audience arquivada, catálogo OFF/vencido/malformado, mudança de opt-in/base/marca e folha externa: nenhuma linha de membro/experimento/escopo nem mutação nativa; rejeição conhecida durável quando aplicável.
- PostgreSQL real com duas conexões: revoke/expiry e drift enquanto espera locks; opt-out de base/folha/global entre leitura e alocação; phantom de associação; rebinding concorrente; refresh de catálogo sem mudança semântica; rollback integral se o segundo braço/recibo falhar.
- Após prepare: inscrito novo não entra, elegibilidade perdida não reequilibra braços nem reduz allocated_count, revisão detecta mudança e não agenda os dois parcialmente. Mudança posterior de contexto não é adotada silenciosamente.
- ACK perdido na preparação: GET operação recupera o mesmo resultado; segundo POST idêntico não muda seed/coorte e POST divergente com a mesma chave é conflito. Resposta incerta sem recibo não é apresentada como rejeição definitiva ou sucesso.
- Legado sem binding permanece equivalente. Query count/batch completas continuam iguais ao conjunto alocado ∩ elegibilidade atual. Só depois, em marco distinto, validar continuidade, suspensão, guard operacional, hash de conteúdo compatível com cursor/counters e desempenho PostgreSQL em volume real; a fixture pequena não resolve CRM27 nem demonstra entrega.
