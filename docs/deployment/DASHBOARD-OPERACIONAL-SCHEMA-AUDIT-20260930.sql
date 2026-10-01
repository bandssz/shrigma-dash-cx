-- Auditoria futura e SOMENTE de catalogo para o canario real do dashboard.
-- Entregar ao DBA para revisao e execucao com papel pessoal limitado a metadados.
-- Nao executar via webhook SQL do n8n, papel de aplicacao ou credencial compartilhada.
-- Nao consulta linhas das tabelas de negocio, valores de chaves, corpos de funcoes
-- (o hash de prosrc e comparado no servidor, sem retorna-lo), definicoes de
-- constraints ou configuracoes secretas.
-- Resultados: nomes fixos, booleanos e contagens agregadas. NULL significa objeto/papel ausente ou
-- atributo nao aplicavel; FALSE exige investigacao, nao instalacao automatica.
-- Fontes versionadas: n8n/access/panel-{auth,short-keys,operator}.sql,
-- n8n/growth/crm-{read-fast,panel-reader-role}.sql.
-- A comparacao booleana de hash cobre tres funcoes versionadas; as demais
-- funcoes e os grants fora da lista ainda exigem classificacao do DBA. Esta
-- auditoria NAO verifica identidade/permissoes de uma chave real ou efeito tecnico
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

-- Assinaturas fixas, flags e hash booleano das tres funcoes com corpo pinado.
-- Nenhum corpo ou hash calculado e retornado ao operador.
WITH esperado(assinatura, linguagem, volatilidade, definer, search_path_exato, body_md5) AS (
  VALUES
    ('public.shrigma_panel_auth_v1(text,text,text)', 'sql', 'v', false, 'search_path=pg_catalog, public', '488ee373b461fd61418c0489c42e3df7'),
    ('public.shrigma_panel_operator_v1(text,text)', 'sql', 's', false, 'search_path=pg_catalog, public', '2092629644f901de260051084d2fb2c2'),
    ('public.shrigma_crm_operator_auth_v1(text)', 'sql', 's', false, 'search_path=pg_catalog, public', NULL),
    ('public.shrigma_template_auth_v2(text)', 'sql', 's', false, 'search_path=public, pg_catalog', NULL),
    ('public.shrigma_crm_read_fast_v1(text,text,jsonb)', 'plpgsql', 'v', true, 'search_path=pg_catalog, public', '0c3b2e1b3094cccae44fa2b89fbfb18b')
)
SELECT e.assinatura AS alvo,
       p.oid IS NOT NULL AS existe,
       CASE WHEN p.oid IS NOT NULL THEN l.lanname = e.linguagem END AS linguagem_confere,
       CASE WHEN p.oid IS NOT NULL THEN p.provolatile::text = e.volatilidade END AS volatilidade_confere,
       CASE WHEN p.oid IS NOT NULL THEN p.prosecdef = e.definer END AS definer_confere,
       CASE WHEN p.oid IS NOT NULL THEN pg_get_userbyid(p.proowner) = 'postgres' END AS dono_postgres,
       CASE WHEN p.oid IS NOT NULL THEN p.proconfig = ARRAY[e.search_path_exato] END AS search_path_confere,
       CASE WHEN p.oid IS NOT NULL AND e.body_md5 IS NOT NULL
         THEN md5(p.prosrc) = e.body_md5 END AS corpo_versionado_confere,
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
       CASE WHEN r.oid IS NOT NULL THEN r.rolinherit END AS herda_papeis,
       CASE WHEN r.oid IS NOT NULL THEN r.rolreplication END AS replica,
       CASE WHEN r.oid IS NOT NULL THEN r.rolconnlimit = 4 END AS limite_quatro_conexoes,
       CASE WHEN r.oid IS NOT NULL THEN has_database_privilege(r.oid,current_database(),'CREATE') END AS pode_criar_no_banco,
       CASE WHEN r.oid IS NOT NULL THEN has_database_privilege(r.oid,current_database(),'TEMP') END AS pode_criar_temporarios,
       CASE WHEN r.oid IS NOT NULL THEN coalesce(
         cardinality(r.rolconfig) = 3
         AND 'statement_timeout=8s' = ANY(r.rolconfig)
         AND 'lock_timeout=500ms' = ANY(r.rolconfig)
         AND 'search_path=pg_catalog, public' = ANY(r.rolconfig), false)
       END AS configuracao_versionada_confere,
       CASE WHEN r.oid IS NOT NULL THEN EXISTS (
         SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid
       ) END AS membro_de_outro_papel,
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

-- Inventario agregado de privilegios efetivos em TODOS os objetos de aplicacao.
-- Zero e necessario para o isolamento pretendido; resultados nao zero exigem
-- revisao antes de qualquer revogacao coordenada. Nao retornar nomes ou dados.
SELECT 'crm_panel_reader_privilegios_fora_da_funcao' AS alvo,
       CASE WHEN r.oid IS NOT NULL THEN (
         SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE left(n.nspname,3) <> 'pg_' AND n.nspname <> 'information_schema'
           AND c.relkind IN ('r','p','v','m','f')
           AND (has_table_privilege(r.oid,c.oid,'SELECT')
             OR has_table_privilege(r.oid,c.oid,'INSERT')
             OR has_table_privilege(r.oid,c.oid,'UPDATE')
             OR has_table_privilege(r.oid,c.oid,'DELETE')
             OR has_table_privilege(r.oid,c.oid,'TRUNCATE')
             OR has_table_privilege(r.oid,c.oid,'REFERENCES')
             OR has_table_privilege(r.oid,c.oid,'TRIGGER')
             OR has_any_column_privilege(r.oid,c.oid,'SELECT')
             OR has_any_column_privilege(r.oid,c.oid,'INSERT')
             OR has_any_column_privilege(r.oid,c.oid,'UPDATE')
             OR has_any_column_privilege(r.oid,c.oid,'REFERENCES'))
       ) END AS relacoes_com_privilegio,
       CASE WHEN r.oid IS NOT NULL THEN (
         SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE left(n.nspname,3) <> 'pg_' AND n.nspname <> 'information_schema'
           AND c.relkind = 'S'
           AND (has_sequence_privilege(r.oid,c.oid,'USAGE')
             OR has_sequence_privilege(r.oid,c.oid,'SELECT')
             OR has_sequence_privilege(r.oid,c.oid,'UPDATE'))
       ) END AS sequencias_com_privilegio,
       CASE WHEN r.oid IS NOT NULL THEN (
         SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE left(n.nspname,3) <> 'pg_' AND n.nspname <> 'information_schema'
           AND p.oid <> to_regprocedure('public.shrigma_crm_read_fast_v1(text,text,jsonb)')
           AND has_function_privilege(r.oid,p.oid,'EXECUTE')
       ) END AS outras_funcoes_executaveis,
       CASE WHEN r.oid IS NOT NULL THEN (
         SELECT count(*) FROM pg_namespace n
         WHERE left(n.nspname,3) <> 'pg_' AND n.nspname <> 'information_schema'
           AND has_schema_privilege(r.oid,n.oid,'CREATE')
       ) END AS esquemas_com_create
FROM (SELECT 1) raiz LEFT JOIN pg_roles r ON r.rolname = 'crm_panel_reader';

ROLLBACK;
