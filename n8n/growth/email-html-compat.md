# CRM20 · Compatibilidade de HTML de e-mail

A reprodução sintética em Fish e Aristo encontrou três casos: o editor recusava `meta charset="UTF-8"` e o viewport padrão; o plano de teste recusava qualquer variável quando existia um bloco `style`, mesmo se a variável estivesse apenas no texto ou no assunto; e `>` dentro de um atributo confundia a verificação de contexto. CSS com blocos aninhados (`@media`) também era confundido com expressão de template por terminar em `}}`.

O contrato compartilhado lê tags e atributos respeitando aspas, comentários e o conteúdo literal de `style`/`script`. Não reconstrói o documento. O HTML completo permanece byte a byte igual, exceto pela inserção já prevista do pré-header após a abertura real de `body`. Aspas contendo `>` não deslocam essa inserção para dentro de um atributo.

A lista permitida de metadados é deliberadamente curta:

- `charset="UTF-8"`, sem atributos adicionais;
- `name="viewport"` com `width=device-width` e `initial-scale=1` (também `1.0`), sem outra diretiva;
- `http-equiv="Content-Type"` com `content="text/html; charset=UTF-8"`.

Maiúsculas e espaços usuais são aceitos. Atributos duplicados, charset diferente, refresh, CSP e demais metadados são recusados. Outros casos precisam de uma necessidade concreta e testes antes de ampliar a lista. A distinção entre metadados, pragmas e charset segue a [especificação HTML](https://html.spec.whatwg.org/multipage/semantics.html#the-meta-element); aceitar uma forma na especificação não significa aceitá-la neste contrato de e-mail.

CSS estático em atributos ou blocos `style` pode acompanhar variáveis simples no texto ou assunto. Blocos CSS aninhados não são tratados como expressões Go. No plano de **envio de teste com dados fictícios**, variáveis em atributos, comentários, declarações, scripts ou estilos são recusadas. A gravação e a replicação conservam templates dinâmicos já suportados, como `href="{{ .Tx.Data.order_url }}"`; isso não os torna elegíveis ao teste com dados fictícios. Scripts, formulários, conteúdo interativo, `base`, folhas externas, SVG/MathML, eventos e protocolos ativos/data são bloqueados, inclusive representações comuns em entidades HTML e escapes CSS. HTML malformado precisa ser corrigido; o leitor não pretende implementar a recuperação automática de erros de um navegador.

## Backend e verificação

`email-html-compat-patch.cjs` recebe um export fresco e exige sua versão exata. Confere hashes dos blocos anteriores, altera somente o código de `Prepara`, `Decide escrita` e `CRM Email Test plan`, e pode ser aplicado novamente sem mudanças. Autenticação, rotas, credenciais, conexões, configurações, reserva, transporte e recibos ficam idênticos. Não há alteração SQL.

A prova offline usa o export de referência `a0ab3d2e-7cfd-440c-ac61-5f0c4b3e50a6`, com comparação integral do restante do workflow. O fixture público contém somente código validado contra as fontes do repositório, sem dados reais ou credenciais. A regressão local passou em 1.096 testes, e o build exclusivo de Growth e a conferência dos bundles passaram. Os casos específicos exercitam ambas as marcas, os casos aceitos/recusados, `>` em aspas, corpo próximo do limite de 200 mil caracteres, código emitido em sandbox e correspondência exata entre os renderizadores.

O teste continua limitado a `felipebandeira@oaristocrata.com`, assunto `✅ FINAL —`, confirmação explícita, opt-out e tentativa única por versão. Esta entrega é código e validação offline: não comprova aceite na interface, execução no n8n, envio ou entrega SES. A atualização do backend e o teste visual precisam de conferência própria após revisão.
