---
name: "email-shrigma"
description: "Criar, adaptar e revisar e-mails da Fishermans e de O Aristocrata; salvar modelos, consultar públicos e operar campanhas pelo CRM com a conta individual conectada. Inclui assunto, preheader, HTML, texto, Shopify, UTMs, teste interno, agendamento e cancelamento quando pedidos e liberados. Pedido de peça não autoriza envio. Operação depende das ferramentas CRM da pessoa; não usa chave do proprietário nem acesso direto ao Listmonk."
metadata:
  version: "3.1.0"
  updated: "2026-10-20"
---

# E-mail — criação de peças do Grupo Shrigma

A skill cria a peça e, quando solicitado, chama o CRM com a conta individual do analista. O CRM aplica permissões, marca e liberação; o Listmonk executa o envio. Entregue assunto, preheader, HTML e texto conferidos. Peça pronta não autoriza criar campanha, TEST nem agendamento.

A operação nova está restrita às contas QA admitidas pelo CRM. Abertura geral depende do “passou” de Felipe. Não matricule contas, promova permissões ou amplie listas para contornar uma recusa.

## Começar pelo pedido

1. Identifique a **marca** (`fish` ou `aristo`) e o modo: **criar** peça nova, **revisar**, **ajustar** ou **adaptar para a outra marca**. Pedido de peça nunca vira envio.
2. Reúna oferta, destino (produto, coleção ou página), prazo e prova social. Se faltar algo indispensável, faça o resto e peça só o que falta. Não invente preço, estoque, prazo, depoimento nem link.
3. Puxe os dados de produto da Shopify (abaixo) em vez de digitar de memória.
4. Monte a peça pelas regras de HTML, rode o pré-voo em modo modelo e entregue (ver **Entrega**).
5. Informe o que foi conferido. Se houver pedido de operação, confira a sessão individual e siga [operação pelo CRM](references/operacao-crm.md). **Peça pronta não é campanha agendada nem e-mail enviado.**

## Produtos pela Shopify

Use o conector da Shopify quando estiver disponível:

- **Confira a loja ativa** antes de buscar e troque para a loja da marca da peça. Produto da Fishermans nunca entra em peça da marca O Aristocrata, e vice-versa.
- Busque o produto e use **título, preço, variante e imagem da leitura atual**. Preço e disponibilidade mudam: não reaproveite valor de peça antiga.
- **Imagem:** use a URL da imagem na CDN da Shopify, com `alt` descrevendo o que se vê. Não suba imagem para outro lugar nem use foto de banco.
- **Link:** a página do produto ou da coleção na loja da marca (`/products/<handle>`, `/collections/<handle>`), com as UTMs abaixo.
- Sem conector, peça ao analista o link do produto e a imagem, e marque o que não pôde ser conferido.

## Regras de HTML

| # | Regra | Como verificar |
|---|---|---|
| 1 | **Bloco único de largura total** | Nada de cartões duplos lado a lado ("blocos tortos"). Conferir no celular antes de entregar. |
| 2 | **Dark mode nos dois mecanismos** | Toda classe com cor tem regra em `@media (prefers-color-scheme: dark)` **e** em `[data-ogsc]`/`[data-ogsb]`. O pré-voo avisa a falta; cubra ou registre a decisão. |
| 3 | **Alt text descritivo** | Descreva o que se vê. Decorativa: `alt=""` **com** `role="presentation"`. |
| 4 | **Versão texto completa** | Mesma oferta, mesmos links (com UTM) e descadastro. |
| 5 | **Preheader** | Bloco oculto no topo + fio de caracteres invisíveis. |
| 6 | **Componentes, nunca prosa corrida** | Esqueleto de blocos; cada peça com **um dispositivo visual próprio**, sem repetir o da peça anterior da mesma campanha. |
| 7 | **Descadastro + dados legais da marca certa** | `{{ UnsubscribeURL }}`, razão social, CNPJ, políticas e contato. |
| 8 | **`{{ TrackLink }}` em todo link comercial; nenhum `{{ TrackView }}` na peça** | O pixel de abertura mora no wrapper do envio. Pixel na peça dobra as aberturas. |
| 9 | **Leve e sem conteúdo ativo** | Sem script, formulário ou handler. HTML e texto em UTF-8, até 200 KB cada. |

**Dispositivos já usados** (não repetir em sequência): equação/veredito, barra de lavagens, parede de versões com fichas, mural de quotes com estrelas, balcão em bolhas de WhatsApp, relógio do cheiro em barras horárias, régua do portão com barra decrescente, ficha do bastão, placar comparativo, cartão de acesso, as duas portas, camadas do cheiro, três selos, o bilhete, a dupla (sabonete + desodorante), placar de escassez.

**Cada marca com a sua identidade.** Paleta, rodapé, CNPJ e template são de cada marca. `assets/base-aristocrata.html` é o ponto de partida obrigatório da marca O Aristocrata e proibido na Fishermans, que parte de uma peça Fish aprovada.

**Adaptar para a outra marca** é reescrever: troque produto, links, rodapé, paleta e tom, e rode o pré-voo com a marca de **destino**. Link que sobrou da loja de origem reprova.

## UTMs

```
utm_source=listmonk                     nunca "email"
utm_medium=campanha
utm_campaign=<alias da campanha>         ex.: desodorante-frescor · semana-do-cliente-2026
utm_content=<peca>-<posicao>            posicao ∈ hero | cta1 | texto | ps | rodape
utm_term                                identidade do disparo: fica para a campanha no CRM
```

- A **identidade do disparo** (`utm_term`) depende do ID real da campanha, que só existe no CRM. A skill **não inventa** esse valor: deixa o `utm_term` fora e avisa que ele é conferido na campanha antes de agendar.
- `utm_campaign` usa o valor confirmado na campanha. No CRM, iniciativa e identificação dos links derivam do nome e são editáveis em **Avançado**; alinhe o alias da peça ao valor confirmado na campanha.
- UTM no destino **final** do clique, inclusive dentro do `redirect` de `/discount/CUPOM`.
- Sem encurtador, sem e-mail, telefone, nome ou ID de cliente em UTM.

Detalhes e duplicações legítimas (CTA + VML na mesma posição): [rastreamento](references/rastreamento.md).

## Pré-voo da peça

```sh
python3 scripts/checklist.py peca.html --text peca.txt --brand aristo --campaign <utm_campaign> --modelo --json
```

- `--brand` é obrigatório e é a marca da peça. `--modelo` aceita a identidade do disparo pendente (aviso `DISPATCH_PENDING`); um `utm_term` malformado continua reprovando.
- Conteúdo sem `__PLACEHOLDER__`; oferta e prova social verificáveis; assunto em uma linha.
- Pelo menos um link para `/products`, `/pages` ou `/collections` (só a home reprova).
- Avisos de dark mode revisados e decididos, não ignorados.
- **Saída de build nova:** grave em temporário, renomeie no sucesso e confira o SHA256 que o script imprime contra o arquivo entregue.
- `ok: true` é ausência de erro local naquele arquivo. **Não** prova consentimento, público, entrega, inbox nem autorização. Antes de acreditar numa acusação, abra o HTML: a heurística já deu falso positivo.

## Entrega

1. **Assunto**, **preheader**, **HTML** e **texto**, em arquivos separados (UTF-8, até 200 KB cada).
2. Resultado do pré-voo e uma lista curta do que foi conferido e do que fica pendente (por exemplo, `utm_term` e remetente na campanha).
3. Quando o pedido incluir salvar no CRM e a conta estiver liberada, use `crm_model_save` e releia com `crm_model_get`; preserve o HTML. Caso contrário, entregue os arquivos e o caminho **Modelos → Importar peça pronta → Conferir prévia → Salvar novo rascunho → Reabrir rascunho**. Detalhes em [operação pelo CRM](references/operacao-crm.md) e [tela do CRM](references/crm.md).

## Nada falso

Oferta, prazo, estoque, contador e prova social refletem fato verificável. Escassez fabricada é publicidade enganosa (CDC, art. 37), e o público printa e cobra. Quando o estoque é grande, o eixo real quase sempre existe: janela de tempo, condição que expira, lote de estreia efetivamente alocado. Não inventar depoimento nem progresso.

## Entregabilidade que muda a copy

- Assunto sem cara de spam: sem caixa alta gritada, sem excesso de pontuação ou de símbolos de dinheiro.
- Público frio pede peça mais leve e promessa mais contida; o portão de envio é do CRM.
- O Gmail mede reclamação pela taxa de spam: peça que irrita custa reputação para as duas marcas.

Detalhes e números datados: [entregabilidade](references/entregabilidade.md) e [aprendizados](references/aprendizados.md).

## Quando o pedido é de operação

Confira `crm_status`: exige `operator: "crm"`, o e-mail da própria pessoa e a marca pedida. Login acontece no OAuth; nunca peça senha, cookie ou chave no chat. O MCP original do proprietário, que retorna apenas papel superadmin, não comprova acesso individual do analista.

Use as ferramentas CRM descritas em [operação pelo CRM](references/operacao-crm.md). TEST e agendamento exigem o pedido específico e o resumo da campanha; esta liberação permite somente QA e destinatário interno. Ativação comercial de jornada continua desligada. Ausência de ferramenta ou recusa não autoriza API direta, Terminal, SQL ou troca de conector.

Em resultado incerto, não repita POST. Peça/modelo usa sua mesma chave em `crm_model_operation`. Campanha usa releitura por ID, ou listagem se o ID não voltou; ausência na listagem não prova ausência de efeito. Não invente journal ou chave de campanha.

O contrato antigo `listmonk_*` permanece descrito em [ponte Listmonk](references/ponte-listmonk.md) para as contas antigas que só têm essas ferramentas e já possuem autorização própria. Não é fallback automático após recusa do CRM e não substitui o fluxo novo.

## Referências

| Trabalho | Ler |
|---|---|
| Operar pelo chat com a conta individual | [operação pelo CRM](references/operacao-crm.md) |
| Levar a peça ao CRM pela tela | [CRM](references/crm.md) |
| Oferta, copy e diagnóstico de conversão | [conversão](references/conversao.md) |
| HTML, prévia e dark mode | [qualidade](references/qualidade-ui.md); `assets/base-aristocrata.html` só na marca O Aristocrata |
| UTMs e duplicações legítimas | [rastreamento](references/rastreamento.md) |
| Teste da peça e o que ele prova | [teste controlado](references/teste-controlado.md) |
| Supressão, SES e rampas | [entregabilidade](references/entregabilidade.md) |
| Métricas e leitura de resultado | [medição](references/medicao.md) |
| Números observados e lições datadas | [aprendizados](references/aprendizados.md) — fonte única dos números |
| Conta antiga que só expõe listmonk_* e já tem autorização própria | [ponte Listmonk](references/ponte-listmonk.md) |

## Scripts

- `scripts/checklist.py`: pré-voo local da peça. Não envia nada nem chama API.
- `scripts/*.cjs` e `scripts/lib/`: preparo offline do contrato antigo Listmonk; não gere seu operation_id para as ferramentas CRM.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p 'test_checklist.py'
node --test scripts/test_campaign_cli.cjs scripts/test_mcp_campaign_cli.cjs
```

Gerador em `f-string` Python colapsa `{{ }}`: escreva `{{{{ TrackLink ... }}}}` no fonte.
