-- Auditoria futura e SOMENTE de catalogo para o canario real do dashboard.
-- Entregar ao DBA para revisao e execucao com papel pessoal limitado a metadados.
-- Nao executar via webhook SQL do n8n, papel de aplicacao ou credencial compartilhada.
-- Nao consulta linhas das tabelas de negocio, valores de chaves, corpos de funcoes
-- (prosrc/pg_get_functiondef), definicoes de constraints ou configuracoes secretas.
-- Resultados: nomes fixos e booleanos. NULL significa objeto/papel ausente ou
-- atributo nao aplicavel; FALSE exige investigacao, nao instalacao automatica.
-- Fontes versionadas: n8n/access/panel-{auth,short-keys,operator}.sql,
-- n8n/growth/crm-{read-fast,panel-reader-role}.sql.
-- Esta auditoria NAO demonstra equivalencia do codigo SQL em producao, nem
-- verifica identidade/permissoes de uma chave real ou ausencia de efeito tecnico
-- da autenticacao (shrigma_panel_auth_v1 atualiza telemetria de uso).

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SET LOCAL search_path TO pg_catalog;
SET LOCAL statement_timeout TO '5s';
SET LOCAL lock_timeout TO '250ms';

SELECT 'listmonk_database' AS alvo,
       current_database() = 'listmonk' AS ok,
       current_setting('transaction_read_only') = 'on' AS transacao_somente_leitura;

-- Apenas tres relacoes conhecidas. Privilegios do reader sao efetivos, inclusive
-- heranca/PUBLIC; os flags PUBLIC consultam as ACLs do objeto explicitamente.
WITH esperado(nome) AS (
  VALUES ('crm_dash_chave'),
         ('shrigma_panel_permission_v1'),
         ('dash_payload_cache')
)
SELECT 'public.' || e.nome AS alvo,
       c.oid IS NOT NULL AS existe,
       CASE WHEN c.oid IS NOT NULL THEN c.relkind = 'r' END AS tabela_comum,
       CASE WHEN c.oid IS NOT NULL THEN pg_get_userbyid(c.relowner) = 'postgres' END AS dono_postgres,
       CASE WHEN c.oid IS NOT NULL THEN c.relrowsecurity END AS rls_habilitado,
       CASE WHEN c.oid IS NOT NULL THEN EXISTS (
         SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
         WHERE a.grantee = 0 AND a.privilege_type = 'SELECT'
       ) END AS public_pode_ler,
       CASE WHEN c.oid IS NOT NULL THEN EXISTS (
         SELECT 1 FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
         WHERE a.grantee = 0 AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
       ) END AS public_pode_escrever,
       CASE WHEN c.oid IS NOT NULL AND r.oid IS NOT NULL
         THEN has_table_privilege(r.oid, c.oid, 'SELECT') END AS reader_pode_ler,
       CASE WHEN c.oid IS NOT NULL AND r.oid IS NOT NULL
         THEN has_table_privilege(r.oid, c.oid, 'INSERT')
           OR has_table_privilege(r.oid, c.oid, 'UPDATE')
           OR has_table_privilege(r.oid, c.oid, 'DELETE')
           OR has_table_privilege(r.oid, c.oid, 'TRUNCATE') END AS reader_pode_escrever
FROM esperado e
LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || e.nome)
LEFT JOIN pg_roles r ON r.rolname = 'crm_panel_reader'
ORDER BY e.nome;

-- Colunas que os patches e o leitor usam. Tipo NULL significa que a criacao
-- original nao consta desses patches: a consulta confirma so a existencia.
WITH esperado(relacao, coluna, tipo, exige_not_null) AS (
  VALUES
    ('crm_dash_chave', 'chave', NULL::regtype, false),
    ('crm_dash_chave', 'painel', NULL::regtype, false),
    ('crm_dash_chave', 'dono', NULL::regtype, false),
    ('crm_dash_chave', 'ativo', 'boolean'::regtype, false),
    ('crm_dash_chave', 'revogada_em', NULL::regtype, false),
    ('crm_dash_chave', 'ultimo_uso', NULL::regtype, false),
    ('crm_dash_chave', 'usos', NULL::regtype, false),
    ('crm_dash_chave', 'chave_hash', 'text'::regtype, false),
    ('crm_dash_chave', 'chave_hash_curta', 'text'::regtype, false),
    ('crm_dash_chave', 'expira_em', 'timestamp with time zone'::regtype, false),
    ('shrigma_panel_permission_v1', 'principal_id', 'text'::regtype, true),
    ('shrigma_panel_permission_v1', 'area', 'text'::regtype, true),
    ('shrigma_panel_permission_v1', 'caps', 'jsonb'::regtype, true),
    ('dash_payload_cache', 'painel', 'text'::regtype, false),
    ('dash_payload_cache', 'payload', 'jsonb'::regtype, false),
    ('dash_payload_cache', 'gerado_em', 'timestamp with time zone'::regtype, false)
)
SELECT 'public.' || e.relacao || '.' || e.coluna AS alvo,
       a.attnum IS NOT NULL AS existe,
       CASE WHEN a.attnum IS NOT NULL AND e.tipo IS NOT NULL
         THEN a.atttypid = e.tipo::oid END AS tipo_confere,
       CASE WHEN a.attnum IS NOT NULL AND e.exige_not_null
         THEN a.attnotnull END AS not_null_exigido_confere
FROM esperado e
LEFT JOIN pg_attribute a
  ON a.attrelid = to_regclass('public.' || e.relacao)
 AND a.attname = e.coluna AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY e.relacao, e.coluna;

-- Nomes gerados pelo DDL versionado. A existencia com tipo/validade nao prova
-- colunas nem expressao dos CHECKs; o DBA deve confirmar a semantica separadamente.
WITH esperado(nome, tipo) AS (
  VALUES
    ('shrigma_panel_permission_v1_pkey', 'p'),
    ('shrigma_panel_permission_v1_principal_id_fkey', 'f'),
    ('shrigma_panel_permission_v1_area_check', 'c'),
    ('shrigma_panel_permission_v1_caps_check', 'c')
)
SELECT e.nome AS alvo,
       co.oid IS NOT NULL AS existe,
       CASE WHEN co.oid IS NOT NULL THEN co.contype::text = e.tipo END AS tipo_confere,
       CASE WHEN co.oid IS NOT NULL THEN co.convalidated END AS validada
FROM esperado e
LEFT JOIN pg_constraint co
  ON co.conrelid = to_regclass('public.shrigma_panel_permission_v1')
 AND co.conname = e.nome
ORDER BY e.nome;

-- Indices parciais esperados. Nao compara o predicado ou colunas por meio de
-- pg_get_indexdef; o resultado sozinho nao valida a unicidade pretendida.
WITH esperado(nome) AS (
  VALUES ('crm_dash_chave_hash_uq'), ('crm_dash_chave_curta_uq')
)
SELECT e.nome AS alvo,
       i.oid IS NOT NULL AS existe,
       CASE WHEN i.oid IS NOT NULL THEN x.indisunique END AS unico,
       CASE WHEN i.oid IS NOT NULL THEN x.indisvalid END AS valido,
       CASE WHEN i.oid IS NOT NULL THEN x.indpred IS NOT NULL END AS parcial
FROM esperado e
LEFT JOIN pg_class i
  ON i.oid = to_regclass('public.' || e.nome)
 AND i.relkind IN ('i', 'I')
LEFT JOIN pg_index x
  ON x.indexrelid = i.oid
 AND x.indrelid = to_regclass('public.crm_dash_chave')
ORDER BY e.nome;

-- Assinaturas fixas e flags de seguranca; nenhuma leitura de prosrc/probin.
WITH esperado(assinatura, linguagem, volatilidade, definer, search_path_exato) AS (
  VALUES
    ('public.shrigma_panel_auth_v1(text,text,text)', 'sql', 'v', false, 'search_path=pg_catalog, public'),
    ('public.shrigma_panel_operator_v1(text,text)', 'sql', 's', false, 'search_path=pg_catalog, public'),
    ('public.shrigma_crm_operator_auth_v1(text)', 'sql', 's', false, 'search_path=pg_catalog, public'),
    ('public.shrigma_template_auth_v2(text)', 'sql', 's', false, 'search_path=public, pg_catalog'),
    ('public.shrigma_crm_read_fast_v1(text,text,jsonb)', 'plpgsql', 'v', true, 'search_path=pg_catalog, public')
)
SELECT e.assinatura AS alvo,
       p.oid IS NOT NULL AS existe,
       CASE WHEN p.oid IS NOT NULL THEN l.lanname = e.linguagem END AS linguagem_confere,
       CASE WHEN p.oid IS NOT NULL THEN p.provolatile::text = e.volatilidade END AS volatilidade_confere,
       CASE WHEN p.oid IS NOT NULL THEN p.prosecdef = e.definer END AS definer_confere,
       CASE WHEN p.oid IS NOT NULL THEN pg_get_userbyid(p.proowner) = 'postgres' END AS dono_postgres,
       CASE WHEN p.oid IS NOT NULL THEN p.proconfig = ARRAY[e.search_path_exato] END AS search_path_confere,
       CASE WHEN p.oid IS NOT NULL THEN EXISTS (
         SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       ) END AS public_pode_executar,
       CASE WHEN p.oid IS NOT NULL AND r.oid IS NOT NULL
         THEN has_function_privilege(r.oid, p.oid, 'EXECUTE') END AS reader_pode_executar
FROM esperado e
LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.assinatura)
LEFT JOIN pg_language l ON l.oid = p.prolang
LEFT JOIN pg_roles r ON r.rolname = 'crm_panel_reader'
ORDER BY e.assinatura;

-- O leitor de CRM deve poder executar somente a funcao dedicada e nao obter
-- SELECT/DML direto por grants herdados. Essas flags nao substituem revisao
-- de todos os papeis e de grants indiretos de outras identidades de workflow.
SELECT 'crm_panel_reader' AS alvo,
       r.oid IS NOT NULL AS existe,
       CASE WHEN r.oid IS NOT NULL THEN r.rolcanlogin END AS pode_login,
       CASE WHEN r.oid IS NOT NULL THEN r.rolsuper END AS superusuario,
       CASE WHEN r.oid IS NOT NULL THEN r.rolbypassrls END AS ignora_rls,
       CASE WHEN r.oid IS NOT NULL THEN r.rolcreatedb OR r.rolcreaterole END AS pode_administrar,
       CASE WHEN r.oid IS NOT NULL AND n.oid IS NOT NULL
         THEN has_schema_privilege(r.oid, n.oid, 'USAGE') END AS pode_usar_public,
       CASE WHEN r.oid IS NOT NULL AND n.oid IS NOT NULL
         THEN has_schema_privilege(r.oid, n.oid, 'CREATE') END AS pode_criar_em_public,
       CASE WHEN n.oid IS NOT NULL THEN EXISTS (
         SELECT 1 FROM aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
         WHERE a.grantee = 0 AND a.privilege_type = 'CREATE'
       ) END AS public_pode_criar_em_public
FROM (SELECT 1) raiz
LEFT JOIN pg_roles r ON r.rolname = 'crm_panel_reader'
LEFT JOIN pg_namespace n ON n.nspname = 'public';

ROLLBACK;
