# Instalação WRITER individual — preparação OFF

O componente de edição é instalado separadamente do READ. Este executor reutiliza os planos, guardas e SQL já revisados: não altera o corpo do componente, não habilita LOGIN, não ativa emissores e não cria usuários ou chaves. O escopo vazio contém quatro tabelas, sete funções e dois papéis sem login. Instalação em produção exige um escopo e autorização próprios.

`installer.cjs` nasce OFF, sem driver, arquivo, conexão ou credencial. O plano fechado exige Node22, pg8.13.1, UID1000 e `comunicacao_postgres:5432/listmonk` com ator `postgres`. Os testes nativos usam um cluster descartável próprio; não admitem um destino de produção como fixture.

O executor aceita os estados READ vazio, preparado e ativo pelo contrato de fase e pelo perfil de estrutura `4f5b8b…`. Confere orçamento de transação de 500 ms antes de qualquer `BEGIN`; isso não garante um limite físico de 500 ms para limpeza ou liberação dos bloqueios. Reconfere o estado e o legado na mesma transação. Antes do DDL, persiste intenção própria; após o DDL e antes/depois do COMMIT, exige que os hashes READ e legado permaneçam iguais.

Resultado desconhecido conserva UUID, pin das fontes, contexto, PID e início do backend original. `reconcile` só lê, exige a intenção durável original e prova que esse backend terminou; não repete DDL. `rollback` remove apenas a estrutura WRITER exata, vazia e inativa, com RESTRICT. Não é revogação de gestores ativos.

Provas locais: 22 testes de instalação, perdas de ACK, preservação e deriva de catálogo passaram em isolamento, com transportes externos bloqueados. O teste de perfil usa o mesmo `search_path=pg_catalog` do instalador; o hash congelado não foi alterado. A CI candidata reutiliza o executor PostgreSQL17 descartável existente para `native.test.cjs`.

Pendentes: resultado da prova PostgreSQL17 nativa da candidata, montagem/transporte operacional com intenção e limites próprios, aprovação do escopo concreto, instalação e aceite real. Nenhuma prova local ou CI autoriza SQL, LOGIN, ativação, envio ou corte em produção.
