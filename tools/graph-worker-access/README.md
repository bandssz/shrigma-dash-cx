# Contrato de linhagem do acesso do worker

`contract.cjs` é um validador puro. Não cria credencial, não gera SQL de LOGIN, não conecta ao banco, não instala serviço e não habilita execução. Seu resultado é sempre `online_auth_verified:false`, `login_authorized:false` e `execution_authorized:false`. `policy_valid:true` significa apenas que os dados fornecidos satisfazem a política de auditoria congelada.

## Entrada de `validateOperational`

```js
validateOperational({
  metadata,       // estado corrente do grafo/retencao e worker_role_identity
  baseAnchor,     // provas historicas da base + leitura NOLOGIN fresca revisada
  accessReceipt,  // null antes da transicao de acesso
  accessPlan,    // plano integral; null quando nao ha accessReceipt
  accessReview,  // pins revisados independentes; null sem accessReceipt
  txReceipt,     // null antes da extensao TX
});
```

Os objetos de revisão são entradas confiáveis do operador, obtidas antes da chamada; nunca devem ser derivados automaticamente do recibo que se quer aprovar. O validador confere os hashes e o encadeamento, mas não prova a origem de um objeto entregue pelo chamador. A fronteira de implantação deve fixar essas entradas em seu plano/intent aprovado.

`baseAnchor` contém exatamente `plan`, `install_verified`, `metadata`, `role_identity` e `reviewed`. Preserva o plano/recibo originais sem editar hashes ou substituir o código de instalação antigo pela main atual. `reviewed` fixa `plan_hash`, `receipt_hash`, `metadata_hash`, `identity_hash` e o mapa histórico `sources`. A identidade/OID vem de uma nova leitura NOLOGIN revisada ligada ao mesmo selo, pois o recibo original não capturava esse OID. `ROLE_IDENTITY_SQL` é uma expressão somente leitura para essa captura.

`role_identity` contém `oid` decimal em string, `role` com os nove campos de `G.ROLE_SQL`, `settings:null`, `valid_until:null`, `connection_limit:-1` e `database_settings:[]`. O mesmo OID e todos os atributos são preservados; somente `role.login` passa de false para true na transição representada. Nenhum caminho SET ROLE ou membership novo é aceito. Outros settings/limites exigirão um contrato específico, não adoção silenciosa.

`accessPlan` contém exatamente `contract`, `nonce`, `before`, `connection_scope`, `database_inventory`, `auth_proof_hash`, `sources`, `migration` e `hash`. O hash é calculado sobre o plano sem o campo `hash`. `migration` tem `body` (corpo não secreto revisado), `sql` (instrução completa revisada) e `extension`. Este módulo somente recebe/verifica esses bytes; não os constrói nem executa. `accessReview` fixa `plan_hash`, `receipt_hash`, `sql_hash`, `body_hash`, `sources`, `database_inventory` e `diagnostic_read_exceptions`. SQL, corpo, fontes, extensão, scope e predecessor precisam coincidir com esses pins e com o recibo.

`accessReceipt` tem `contract`, `nonce`, `plan_hash`, `sql_hash`, `before`, `after`, `connection_scope` e `auth_proof_hash`. Cada estado before/after tem somente `graph_seal`, `maintenance_seal` e `role_identity`. Os selos são objetos JSON nesses estados; `metadata` também aceita o JSON textual retornado pelo banco. A extensão `worker_access_extension` exige:

```text
contract, nonce, ddl, base_plan_hash, base_receipt_hash,
previous_graph_seal_hash, role_oid, previous_role,
connection_scope_hash, credential_version, auth_proof_hash
```

`ddl` corresponde ao hash do corpo não secreto do plano. O hash do SQL completo fica no plano/intent/recibo externo, evitando referência circular. `credential_version` é uma referência opaca, nunca a senha. `auth_proof_hash` é comparado ao plano/recibo pinado; o módulo não interpreta a prova de autenticação e não a transforma em autorização online.

## Ordens e diferenças permitidas

Aceita base, base→TX, base→acesso, base→acesso→TX e base→TX→acesso. Cada extensão aparece no máximo uma vez; o predecessor inteiro deve ser exatamente a saída do passo anterior. A extensão de acesso muda apenas `worker_role.login` e acrescenta seu recibo ao comentário do grafo; não muda os shapes, o selo da manutenção ou a extensão TX. TX preserva o acesso byte a byte e muda apenas os campos de manutenção previstos pelo seu contrato.

`txReceipt` contém `contract`, `before`, `after` e `extension`; deve vir da preparação/readback TX revisados. No integrador TX, esses dados são reconstruídos do plano TX imutável e da leitura corrente: não são inferidos de um comentário isolado. O resultado estrutural deste módulo não substitui `G.OFF_SQL`, os controles e guardas de workflows da instalação, a auditoria atual de privilégios efetivos, o protocolo de intent/readback ou a prova de autenticação real.

## Escopo de bancos e exceções de diagnóstico

`connection_scope` segue a política `audited-current-database-privileges-v1`, fixa `database:listmonk`, `role:crm_graph_worker`, `role_oid` e `database_audits`. O inventário independente deve conter **todos** os bancos não-template com `datallowconn`, em ordem numérica de OID, com `{oid,name}`. Os audits precisam cobrir exatamente esse inventário; omitir um banco é erro.

Cada audit contém `oid`, `name`, `connect`, `temporary`, `create`, `catalog_hash`, `non_system_read`, `non_system_write`, `non_system_create`, `non_system_definer_execute`, `foreign_server_usage` e `diagnostic_read_exceptions`. Todos os acessos são booleans. CREATE é recusado em qualquer banco. Fora de listmonk, os cinco acessos de aplicação devem ser false. CONNECT/TEMP podem permanecer concedidos por PUBLIC, portanto o resultado registra `connection_isolated:false`.

`non_system_read` exclui somente as views de diagnóstico individualmente comprovadas e pinadas. Cada exceção contém `relation_oid`, `extension_oid`, `extension_name`, `extension_version`, `definition_hash`, `acl_hash` e `dependency_hash`. A revisão independente contém as mesmas entradas com `database_oid`; exige igualdade exata e no máximo duas por banco, restritas à extensão **pg_stat_statements1.11**. Não há allowlist por nome de view/schema, nem autorização genérica para objetos de uma extensão. A prova de catálogo precisa comprovar os objetos e dependências antes de fixar esses pins.

## Integração TX e provas

`tools/maintenance-tx-deploy/deploy.cjs` continua exigindo NOLOGIN sem prova de acesso. Quando o selo inclui `worker_access_extension`, `prepare` exige `guard.worker_access` com `{baseAnchor,accessReceipt,accessPlan,accessReview}`. O proof completo fica no plano TX e é revalidado no readback; o DO TX compara também `graph_worker_identity`, incluindo OID/settings/memberships. O novo campo de metadata é somente leitura. O instalador histórico `G.Installer` permanece intacto e continua recusando LOGIN fora de seu contrato.

Os testes puros cobrem os dois encadeamentos, pins de fontes/plano/SQL/recibo, OID/settings/flags/memberships, inventário completo, exceções exatas e adulterações. Os testes de protocolo TX comprovam recusa antes do intent, manutenção do proof e reconciliação de resposta perdida sem segundo SQL. A regressão PostgreSQL17.10 existente continua verificando o SQL TX e a nova leitura de identidade em base NOLOGIN.

## Preparação cifrada e liberação de LOGIN

`../graph-worker-credential/deploy.cjs` prepara uma única senha no servidor e grava seu envelope cifrado em recibo administrativo, mantendo NOLOGIN. O [operador local](../graph-worker-credential/README.md) preserva a chave antes da escrita e recupera o envelope somente em memória. Nunca se envia senha ou verificador dentro do SQL, do plano ou do log do cliente.

`finalize.cjs` implementa a transição posterior e separada. Exige o plano de preparação original, confirmação independente, recibo integral, pins revisados e uma declaração de recuperação em memória vinculada à mesma chave/ciphertext/recibo. Essa declaração não é teste de autenticação PostgreSQL. A transição muda somente LOGIN no mesmo OID e acrescenta a extensão de acesso ao selo do grafo; não altera senha, grants, admissão, workflows ou serviços.

O operador fornece `io.snapshot()`, `io.sql()`, `io.independentReadback()` e `io.scopeAudit({worker_login})`. A auditoria de escopo deve executar consultas novas em todos os bancos a cada chamada; devolver um arquivo previamente salvo viola esse contrato. `prepare()` fixa a captura revisada, a recuperação e o escopo; `finalize(plan_hash)` recaptura estado/recibo/identidades e repete a auditoria imediatamente antes do intent durável. O SQL único toma locks consultivos e de catálogos, confere novamente os estados e o recibo completo, habilita LOGIN e confere o resultado na mesma transação. Há timeout de servidor e de lock. Alteração em timestamp do recibo, OID, permissões, hooks, defaults ou controles aborta.

A verificação posterior usa outro PID e uma nova auditoria de todos os bancos. Os hashes de catálogo normalizam apenas a flag LOGIN, depois de exigir seu valor esperado em cada fase. Os demais privilégios e atributos permanecem cobertos. As consultas entre bancos são observações sequenciais; não constituem um snapshot transacional global nem garantem contra concessões administrativas futuras. Nenhuma ACL de outro produto é modificada.

Resposta incerta mantém o intent e impede uma segunda escrita. `reconcile()` apenas lê. Readback incompleto ou divergente mantém a fase sem confirmação; não existe reset de senha nem rollback automático por nova escrita. Os arquivos `access-receipt`, `access-review` e `finalize-verified` permitem retomar a gravação local somente quando o conteúdo existente é idêntico.

O resultado confirmado ainda declara `online_auth_verified:false`, `execution_enabled:false` e `service_created:false`. A implantação posterior precisa demonstrar autenticação real, identidade do usuário e recusas de privilégios pela própria conexão do worker, além da saúde do serviço com execução OFF. Somente outro contrato explícito pode admitir fontes e ativar execução.

`snapshot.cjs` verifica os quatro workflows ativos e publicados. A normalização operacional nova ignora apenas dois campos de data válidos dos perfis de acesso (`updatedAt` e `lastActiveAt`); mantém presença e todos os demais campos. Os planos, recibos e normalizador históricos do instalador não são reescritos.

O workflow `crm-worker-credential-prepare.yml` executa o processo composto em PostgreSQL17.10 descartável: preparação NOLOGIN, recuperação, falhas/rollback, drift de escopo e recibo, LOGIN separado, resposta perdida, conexão real com senha correta/incorreta e negativas de privilégios. Usa somente fixture isolado e mantém logs crus em memória. O sucesso no fixture não prova implantação em produção.
