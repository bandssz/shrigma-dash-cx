# CRM20 · Compatibilidade de HTML de e-mail

A reprodução sintética em Fish e Aristo encontrou três casos: o editor recusava `meta charset="UTF-8"` e o viewport padrão; o plano de teste recusava qualquer variável quando existia um bloco `style`, mesmo se a variável estivesse apenas no texto ou no assunto; e `>` dentro de um atributo confundia a verificação de contexto. CSS com blocos aninhados (`@media`) também era confundido com expressão de template por terminar em `}}`.

O contrato compartilhado lê tags e atributos respeitando aspas, comentários e o conteúdo literal de `style`/`script`. Não reconstrói o documento. O HTML completo permanece byte a byte igual, exceto pela inserção já prevista do pré-header após a abertura real de `body`. Aspas contendo `>` não deslocam essa inserção para dentro de um atributo.

A lista permitida de metadados é deliberadamente curta:

- `charset="UTF-8"`, sem atributos adicionais;
- `name="viewport"` com `width=device-width` e `initial-scale=1` (também `1.0`), sem outra diretiva;
- `http-equiv="Content-Type"` com `content="text/html; charset=UTF-8"`;
- `name="color-scheme"` com `content="light dark"` ou `content="light only"`;
- `name="supported-color-schemes"` com `content="light dark"` ou `content="light"`.

As duas opções de aparência foram verificadas nos templates nativos: 16 usam o par `light dark` e 15 usam `color-scheme: light only` junto de `supported-color-schemes: light`. Esses valores controlam apresentação, conforme a [especificação de ajustes de cores](https://drafts.csswg.org/css-color-adjust-1/#color-scheme-prop); nenhuma URL ou instrução de execução é aceita nesses campos. A forma encontrada foi `light only`; outras combinações não entram automaticamente na lista.

Maiúsculas e espaços usuais são aceitos. Atributos duplicados, charset diferente, refresh, CSP e demais metadados são recusados. Outros casos precisam de uma necessidade concreta e testes antes de ampliar a lista. A distinção entre metadados, pragmas e charset segue a [especificação HTML](https://html.spec.whatwg.org/multipage/semantics.html#the-meta-element); aceitar uma forma na especificação não significa aceitá-la neste contrato de e-mail.

CSS estático em atributos ou blocos `style` pode acompanhar variáveis simples no texto ou assunto. Blocos CSS aninhados não são tratados como expressões Go. No plano de **envio de teste com dados fictícios**, variáveis em atributos, comentários, declarações, scripts ou estilos são recusadas. A gravação e a replicação conservam templates dinâmicos já suportados, como `href="{{ .Tx.Data.order_url }}"`; isso não os torna elegíveis ao teste com dados fictícios. Scripts, formulários, conteúdo interativo, `base`, folhas externas fora da exceção abaixo, SVG/MathML, eventos e protocolos ativos/data são bloqueados, inclusive representações comuns em entidades HTML e escapes CSS. HTML malformado precisa ser corrigido; o leitor não pretende implementar a recuperação automática de erros de um navegador.

A única exceção de `link` é a folha de Google Fonts observada: `rel="stylesheet"`, atributos apenas `rel` e `href`, URL canônica `https://fonts.googleapis.com/css2`, parâmetros apenas `family` e `display`. Nomes/famílias e opções de apresentação têm validação própria; hosts, paths, protocolos, redirecionamentos, parâmetros adicionais, eventos e expressões dinâmicas são recusados. A validação não busca CSS e conserva a tag original. Links dentro de comentários condicionais continuam recusados.

## Backend e verificação

`email-html-compat-patch.cjs` recebe um export fresco e exige sua versão exata. Confere hashes dos blocos anteriores, altera somente o código de `Prepara`, `Decide escrita` e `CRM Email Test plan`, e pode ser aplicado novamente sem mudanças. Autenticação, rotas, credenciais, conexões, configurações, reserva, transporte e recibos ficam idênticos. Não há alteração SQL.

A prova offline usa o export de referência `a0ab3d2e-7cfd-440c-ac61-5f0c4b3e50a6`, com comparação integral do restante do workflow. O fixture público contém somente código validado contra as fontes do repositório, sem dados reais ou credenciais. A regressão local passou em 1.106 testes, e o build exclusivo de Growth e a conferência dos bundles passaram. Os casos específicos exercitam ambas as marcas, os casos aceitos/recusados, `>` em aspas, corpo próximo do limite de 200 mil caracteres, código emitido em sandbox e correspondência exata entre os renderizadores.

O teste continua limitado a `felipebandeira@oaristocrata.com`, assunto `✅ FINAL —`, confirmação explícita, opt-out e tentativa única por versão. Esta entrega é código e validação offline: não comprova aceite na interface, execução no n8n, envio ou entrega SES. A atualização do backend e o teste visual precisam de conferência própria após revisão.

## Limitações encontradas no catálogo publicado

A conferência somente de leitura examinou 35 templates nativos registrados em Fish (15) e Aristo (20), com corpos abaixo de 30 KB. Todos os 35 passaram na segurança/estrutura HTML após as exceções passivas: 33 antes recusados por metadados e 2 já aceitos. Nenhum template antes aceito passou a ser recusado. Os 15 que usam Google Fonts correspondem à única forma de `link` permitida acima. Isso não prova compatibilidade total com o editor: os mesmos 33 continuam recusados pelo schema por expressões nativas mais amplas que os campos simples permitidos, incluindo condicionais, laços, campos do item, campos de assinante, pipelines e helpers. As expressões e recursos existentes não foram removidos ou simplificados. Sua edição precisa de um contrato separado, sem confundi-la com o plano restrito de teste fictício. Nenhum HTML real foi copiado para o repositório ou persistido na auditoria.
