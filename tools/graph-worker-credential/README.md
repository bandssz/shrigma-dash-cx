# Preparação única da credencial com o worker ainda NOLOGIN

Este módulo prepara a credencial de `crm_graph_worker` no mesmo OID já revisado, sem habilitar LOGIN, iniciar serviço, ativar o grafo ou enviar mensagens. A base do grafo, seus planos/recibos originais e os selos de manutenção permanecem intactos. A transição posterior de acesso tem contrato e revisão próprios.

`deploy.cjs` não tem endpoint, CLI, credencial administrativa ou transporte embutido. `Preparer` recebe um transporte isolado e um `FileStore` privado. A instalação é um único `DO`, sem BEGIN/COMMIT nem alteração de configuração compartilhada. Exige PostgreSQL 17.10, administrador `postgres`, READ COMMITTED, `statement_timeout` já configurado entre 1 e 30000 ms e busca efetiva exatamente `pg_catalog, public`. O transporte deve configurar a sua própria sessão antes da captura. `lock_timeout=500ms` limita cada espera por lock; o timeout HTTP não limita a execução no servidor.

A preparação exige grafo e CART do grafo OFF, zero épocas/owners/sources/clones, manutenção CART aberta v2, worker NOLOGIN sem senha anterior e identidade, permissões, selos e shapes iguais à linhagem revisada. Aceita base e TX somente nas ordens explícitas reconhecidas pelo contrato operacional. O inventário completo de bancos e a auditoria de permissões são congelados no `scopeReview`; esta validação estrutural não prova autenticação nem isolamento de conexão. Nenhum serviço existente é alterado.

## Chave local e segredo no servidor

`operator.cjs` usa a dependência fixada no lockfile para gerar uma chave OpenPGP RSA3072 v4, com uma subchave de criptografia e sem expiração. Os arquivos são privados, exclusivos e duráveis; retomadas reabrem os mesmos arquivos. Estado parcial, troca de chave, symlink e hardlink são recusados. Não há regeneração automática nem CLI de decriptação.

- `generate(directory)` cria uma vez e retorna o descritor público.
- `publicEnvelope(directory)` reabre e valida o mesmo descritor.
- `decryptReceipt(directory, projection)` devolve o envelope somente em memória. A projeção aceita exatamente `ciphertext`, `nonce`, `key_sha256`, `key_fingerprint`, `validation_receipt_hash` e só deve ser usada depois da validação do recibo pelo preparador.

O descritor público contém exatamente `public_key_b64`, `key_sha256`, `key_fingerprint`, `nonce` e `validation_receipt_hash`. O hash de validação vincula os dados públicos canônicos ao contrato, versão, role e banco; não é assinatura nem prova independente de origem. A existência e a preservação da chave privada validada continuam sendo responsabilidade do operador.

No banco, a função oficial `pgcrypto.gen_random_bytes(32)` gera a senha, codificada como 64 caracteres hexadecimais. `pgp_pub_encrypt` cifra o envelope `{nonce, role, database, password}` com AES256 e MDC. O servidor então aplica SCRAM por `ALTER ROLE ... NOLOGIN PASSWORD`, dentro de um handler estático que captura cancelamento, assert e demais erros. A senha e o verificador não entram no SQL enviado pelo cliente, no recibo ou nas mensagens devolvidas. Erros são códigos estáticos, sem SQLERRM ou diagnóstico interno. A prova de compatibilidade usa as definições oficiais do [pgcrypto no PostgreSQL 17.10](https://github.com/postgres/postgres/blob/REL_17_10/contrib/pgcrypto/pgcrypto--1.3.sql).

O catálogo exige pgcrypto 1.3 oficial em `public`, proprietário administrativo, funções C, símbolos, tipos e propriedades esperados, vínculo à extensão e hashes de definição congelados. Preloads, pgAudit, auto_explain e event triggers não revisados bloqueiam a preparação. Não se desativa auditoria. Funções builtin usadas pelo módulo e pela metadata expandida são qualificadas com `pg_catalog`, incluindo funções variádicas que poderiam sofrer resolução para overloads em `public`. O qualificador opera apenas sobre os templates confiáveis antes da interpolação de JSON ou chave.

## Guarda, recibo e retomada

O `DO` obtém locks consultivos na ordem manutenção CART → grafo → acesso worker, estabiliza os catálogos de roles, funções, extensão, hooks, bancos e ACLs e bloqueia as tabelas de controle relevantes. A metadata inteira é comparada novamente antes da primeira mutação. O timeout do servidor e a espera por locks continuam limitados.

A criação usa apenas o schema administrativo novo `crm_worker_access_admin_v1` e sua tabela singleton `receipt`, ambos sem acesso PUBLIC ou grants de outros roles. Default ACLs são congeladas; qualquer grant residual não administrativo aborta antes da geração. O schema não pode existir antes da preparação. O recibo contém identidade, nonce, hashes da chave, predecessor e escopo, estados anterior/posterior, ciphertext e seu hash, `auth_proof_hash` e momento de conclusão. A prova de autenticação é o SHA256 server-side do JSONB `{role_oid, role, verifier}`; ela não inclui LOGIN nem divulga o verificador. Flags e identidade são verificadas separadamente.

`METADATA_SQL` consulta somente catálogos para verificar a existência e a forma do schema administrativo. `RECEIPT_SQL` é uma consulta separada, permitida somente depois de comprovar a existência do namespace. Não se usa CASE para tentar ocultar uma referência a tabela ainda ausente.

Fluxo da API:

1. `snapshot()` captura `{metadata, identity, session_pid}`. `identity` contém alvo estável, quatro workflows com ID/versão/hash/referência PostgreSQL e fingerprints da utility. Não contém perfis brutos ou dados de contatos.
2. `prepare({snapshot_sha256, predecessor, scopeReview, publicKey})` exige a captura revisada e grava plano, SQL exato e hashes dos arquivos de implementação. `predecessor` é `{baseAnchor, txReceipt}`; ausência de TX é `null`.
3. `provision(plan_hash)` recaptura metadata e identidade, grava e sincroniza o intent exclusivo antes da única chamada SQL. A resposta bruta e erros do transporte nunca são persistidos.
4. A confirmação exige `independentReadback()` em outro PID e com a mesma identidade estável. Estados, ACLs, ciphertext e recibo devem corresponder ao plano. Somente então se grava `provision-verified`.
5. Resposta incerta mantém o intent e impede outra escrita. `reconcile()` só lê, podendo confirmar a mesma preparação comprometida. Falha sem efeito também permanece bloqueada; não se cria outra senha, não se reseta o role e não se repete automaticamente o SQL.

Os exports `AUTH_SQL`, `METADATA_BODY`, `METADATA_SQL`, `RECEIPT_SCHEMA_SQL`, `RECEIPT_SQL`, `snapshot`, `identity`, `expectedAfter` e `validateReceipt` permitem a fase posterior verificar o mesmo contrato. O resultado de preparação continua declarando `worker_login:false` e `execution_enabled:false`. Não é autorização para LOGIN ou execução.

## Provas

Os testes locais cobrem intenção antes da escrita, resposta perdida, readback independente, replay, adulteração de ciphertext/recibo, mudanças de OID/permissões/workflows/utility/escopo, chave e geração de SQL com comando único. O workflow dedicado executa o SQL exato em PostgreSQL 17.10 descartável: rollback após ALTER, cancelamento real, conexão saudável, NOLOGIN, senha correspondente ao SCRAM apenas em memória, ausência de plaintext/verificador nos logs, overloads hostis ignorados, nenhuma mudança nas tabelas e selos originais. O runner recusa alvos fora do fixture loopback e não publica logs crus. Esses testes não acessam produção e não substituem CI verde e readback independente antes de uso real.
