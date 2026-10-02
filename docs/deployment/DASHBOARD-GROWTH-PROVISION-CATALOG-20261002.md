# Catálogo Growth: terceira e quarta capturas somente leitura

Resultados derivados exclusivamente dos dois relatórios fechados de catálogo, com nomes de alvos fixos, flags, contagens e hashes de metadados; sem linhas de negócio, chaves, e-mails ou corpos de funções.

## Terceira captura: contratos do provisionamento aditivo

A terceira auditoria real terminou com `state=ok`, quatro seções e 19 alvos. Banco, sessão administrativa esperada e transação somente leitura foram confirmados. As duas relações previstas, `crm_dash_chave` e `shrigma_panel_permission_v1`, existem como tabelas ordinárias do dono esperado, sem particionamento/herança, RLS, escrita por `PUBLIC`, triggers de usuário, triggers internos desconhecidos, regras de reescrita, políticas, participação em publicações ou FKs de entrada desconhecidas. Os dois triggers internos de FK esperados por relação estão presentes e nenhum trigger está desativado.

As 13 colunas conhecidas, constraints e índices esperados conferiram. Não foram encontrados defaults inseguros, colunas de domínio ou índices desconhecidos. A tabela de permissões não apresentou objetos adicionais; a tabela de chaves apresentou **uma coluna e um constraint extras**, que impediram tratar a primeira captura desse conjunto como catálogo inteiramente conhecido.

As três funções da cadeia dedicada — autenticação, operador e leitura rápida — conferiram corpo versionado, modo, dono, search_path, linguagem, retorno e assinatura de saída, sem execução por `PUBLIC`. Isso certifica os contratos comparados, não todos os possíveis caminhos do banco ou dos backends.

## Quarta captura: classificação das duas diferenças

A quarta auditoria real terminou com `state=ok`, três seções e quatro alvos. Os fingerprints das duas relações continuaram iguais aos da captura anterior; a classificação refere-se à mesma baseline.

| Diferença | Metadados confirmados |
| --- | --- |
| Única coluna extra | `criado_em`, NOT NULL, coluna simples de tipo builtin não domínio, collation determinística, default `now()`, sem referências a funções fora do catálogo; a omissão no INSERT atende ao contrato de catálogo verificado |
| Único constraint extra | CHECK validado e imediato, sobre `painel`, enumeração fechada de cinco valores, sem referência à coluna extra e sem referências a funções fora do catálogo |

As flags classificam as duas diferenças; nenhum nome desconhecido ou expressão SQL arbitrária foi publicado. **Não houve teste de INSERT, UPDATE, DELETE, emissão/revogação de chave ou DAO**: a indicação `omitted_insert_safe` é uma conclusão do contrato de metadados, não prova funcional de uma inserção.

## Consequência operacional

As capturas reduzem a incerteza do esquema necessário ao provisionamento aditivo de uma identidade nova. Não autorizam DML, migração, alteração de grants, alteração de credenciais ou ativação de backend na produção. Antes de liberar acesso real, ainda é necessário preparar e validar o procedimento aditivo fechado, atestar dono/área/capacidades diretamente na origem e comprovar a revogação, preservando as identidades e envios atuais.

A classificação anterior das 71 funções extras continua separada: 36 de `pgcrypto` e 35 próprias, todas extras SECURITY INVOKER. Os corpos próprios não foram todos certificados; metadados de extensão/volatilidade/invoker não provam ausência de escrita. A superfície HTTP dedicada usa consulta fechada, e a autenticação conhecida incrementa telemetria; portanto GET autenticado não deve ser descrito como zero-write. Nenhuma dessas auditorias executou essa autenticação ou uma ação comercial.

O corte definitivo permanece **NO-GO**. Documentar a remoção dos recursos temporários e a comparação das configurações/rotas com a baseline somente após a confirmação específica do operador; os dois relatórios de catálogo, sozinhos, não provam cleanup do servidor.

Depois de cada captura, o MCP removeu somente o auditor, o leitor e a rota temporários correspondentes. Após a quarta, os oito serviços existentes do projeto e os 118 mappings continuaram byte-idênticos à baseline. Nenhuma leitura de linha comercial, execução de função da aplicação, DML ou migração ocorreu. Os resultados filtrados e os executores ficaram no armazenamento privado; nenhum segredo foi publicado.
