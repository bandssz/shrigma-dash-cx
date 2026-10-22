# Classificação complementar de permissões

A primeira auditoria de catálogo concluiu sem alterações no banco e encontrou 71 funções de aplicação/extensões executáveis pelo papel leitor além da função dedicada. Essa quantidade sozinha não demonstra vulnerabilidade nem privilégio mínimo. A segunda consulta fechada agrupa somente metadados; não consulta chaves ou linhas comerciais e não chama funções de aplicação. Não autoriza alterações de grants, roles, esquemas ou serviços existentes.

O executor segue o contrato de [DASHBOARD-CATALOG-AUDIT-20261002.md](DASHBOARD-CATALOG-AUDIT-20261002.md): serviço temporário novo, volume/marcador novo antes da conexão, destino interno fixo, senha administrativa somente de runtime, `psql -X -w`, uma transação `REPEATABLE READ READ ONLY`, guardas de banco/administrador/modo, timeouts e `ROLLBACK`. O SQL tem SHA-256 `ce7a32fa6dd2b7c22ce9fd7965e27ac67f80d9d7397e42b0fe8f5b207c7c570e`. Não devolve nomes desconhecidos, corpos de funções ou configurações secretas.

São oito seções com 35 alvos fixos: baseline, extensões registradas da allowlist e buckets desconhecido/ambíguo/sem extensão, modo definer/invoker, volatilidade, prefixo de aplicação, dono, linguagem e cinco assinaturas conhecidas. A comparação com 71 detecta mudança da baseline; não é uma regra de admissão. Extensão, volatilidade ou modo invoker não comprovam comportamento somente leitura.

Antes da execução em 02/10, o MCP confirmou oito CPUs, uso de 29,89%, 20.936 MB de memória e 335,5 GB de disco livres. O auditor recebe limite 0,25 CPU/256 MiB; o leitor separado 0,1 CPU/128 MiB. Ambos têm uma réplica e capacidades removidas; a imagem do cliente PostgreSQL e a do leitor Node 22 são por digest já conferido. O auditor não terá porta/domínio. O leitor receberá somente o diretório do volume novo e um Bearer aleatório, sem credencial PostgreSQL. A rota temporária e ambos os serviços serão removidos após capturar o resultado; comparar as oito configurações originais e os 118 mappings com a baseline.

Preparação: sete testes locais do [leitor fechado](dashboard-catalog-classification-reader-20261002.cjs), sintaxe de shell/Node e contrato estático do SQL passaram. O [executor único](dashboard-catalog-classification-once-20261002.sh) usa o [SQL fechado](dashboard-catalog-classification-20261002.sql) com o checksum acima. O hash versionado já conferido do caminho dedicado usa relações qualificadas com `public`, protegendo esse caminho da substituição por tabelas temporárias. A função legada de templates precisa de análise separada; seu corpo real não foi comparado e ela não é chamada pelo leitor dedicado.

## Resultado

Executado em 02/10/2026 pelo MCP, em serviço temporário novo `comunicacao/dashboard-catalog-classify-20261002`, com volume/marcador próprios. O leitor HTTPS separado recolheu `state=ok`, oito seções e 35 alvos: isso confirma também a execução real do SQL no PostgreSQL ativo. O total permaneceu 71, igual à primeira captura.

| Grupo de funções extras executáveis pelo leitor | Quantidade | Metadados observados |
| --- | ---: | --- |
| Extensão `pgcrypto` instalada | 36 | Todas em C e `SECURITY INVOKER`; 12 voláteis e 24 imutáveis |
| Aplicação, sem associação a extensão | 35 | Todas `SECURITY INVOKER`; 16 SQL e 19 PL/pgSQL; 15 voláteis, cinco imutáveis e 15 estáveis |
| Demais extensões, desconhecidas ou ambíguas | 0 | Nenhum alvo nesses grupos |

As 71 são de propriedade de `postgres` e executáveis por `PUBLIC`; nenhuma das **extras** é `SECURITY DEFINER`. As 35 próprias se dividem em 22 com prefixo `shrigma` e 13 com outros prefixos. Essas flags não certificam ausência de escrita nem segurança dos corpos. A função dedicada de leitura é um alvo separado, `SECURITY DEFINER`, com execução do leitor e sem execução `PUBLIC`, conforme a primeira auditoria.

A inspeção dos fontes do backend implantado, revisão `9bc7ee8`, confirmou uma superfície HTTP fechada: somente `GET /read`, ações `identity` ou `cache_growth` com `painel=growth`, e uma consulta constante com três parâmetros. O conteúdo desses fontes não diverge da revisão pinada. A cadeia conhecida chama apenas autenticação/operador para identidade e lê o cache Growth; as três comparações de corpos da primeira auditoria conferiram. As 35 funções próprias extras não se tornam automaticamente SQL arbitrário acessível por essa rota. Elas continuam sendo uma questão separada em caso de comprometimento da credencial PostgreSQL; seus corpos não foram todos certificados. A autenticação atual incrementa telemetria de uso, portanto o GET autenticado não é tecnicamente zero-write, embora não dispare ação comercial.

Após a captura, o MCP removeu a rota HTTPS e ambos os serviços novos. As oito configurações originais do projeto e os 118 mappings conservaram-se idênticos à baseline. Não foram alterados grants, roles, bancos, chaves, funções ou serviços atuais. O resultado ficou no diretório privado do Mac, sem credenciais ou dados de negócio publicados.

Próxima etapa: conferir os metadados necessários ao provisionamento aditivo de **nova** identidade Growth/leitura, atestar dono/área/capacidades diretamente na origem e testar a revogação. A classificação concluída não concede acesso real, edição ou autorização de corte por si só.
