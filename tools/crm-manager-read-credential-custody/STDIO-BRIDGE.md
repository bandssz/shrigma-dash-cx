# Ponte STDIO — QUERY somente

A entrega inicial do agente foi somente fonte e testes sintéticos, sem MCP, PG, Docker ou chave real. A raiz integrou os arquivos no worktree exclusivo e executou depois uma única consulta MCP de leitura, descrita ao final. Não contém StageRunner. Node/relay estão OFF por padrão; `nativeApproved` também é false, listas autorizadas vazias. O único escopo nativo exercitado pela raiz foi: `execute_query` / `listDomains`, com input exato `{projectName: "dashboard-image-20260930", serviceName: "web-access-v24-f58dfa73"}`. Nenhuma mutação está admitida.

## Comando de canal

Criar um diretório NOVO, canonical, do usuário atual, mode 0700. Iniciar uma sessão `exec_command` com `tty:true`, `login:false`, `yield_time_ms:250`. Neste ambiente pipes / `tty:false` entregam EOF ao Node; não servem para sessão de stdin viva. Usar:

```sh
set -e
stty -echo -icanon
exec env -i PATH=/usr/bin:/bin '/Users/felipebandeiragoncalves/projetos/GPT- Dashboard Bandeira/.private/test-tools/node22-rfm-proof/node' /Users/felipebandeiragoncalves/projetos/GPT- Dashboard Bandeira/.private/worktrees/dashboard-candidate-crm-fix-20261002/tools/crm-manager-read-credential-custody/synthetic-demo.cjs --readonly-list-domains /private/tmp/NOVO-DIRETORIO-0700 dashboard-image-20260930 web-access-v24-f58dfa73
```

A demo emite uma única linha `read-stdio-request-v1` com seq1, executor `execute_query`, visibility `public` e file `{path,bytes,sha256}`. Capturar output INTERNAMENTE no mesmo `functions.exec`; não imprimir resultado cru. Requisições PUBLIC têm campos/tipos fechados antes de criar arquivo. O fluxo PRIVATE só teve testes sintéticos; o canal de credenciais reais não foi validado.

## Leitura pública e relay

Dentro de `functions.exec`, ler a descrição e chamar o leitor abaixo (somente argumentos públicos, com shell quoting correto):

```sh
env -i PATH=/usr/bin:/bin '/Users/felipebandeiragoncalves/projetos/GPT- Dashboard Bandeira/.private/test-tools/node22-rfm-proof/node' /Users/felipebandeiragoncalves/projetos/GPT- Dashboard Bandeira/.private/worktrees/dashboard-candidate-crm-fix-20261002/tools/crm-manager-read-credential-custody/public-readback.cjs 'PATH-DO-FILE' 'SHA256' 'BYTES'
```

O leitor valida arquivo regular/nlink1/UID/mode0600/caminho/UTF8/hash e retorna `read-stdio-public-readback-v1`. Parsear output internamente, recusar exit diferente de zero ou output incompleto; não confiar em texto truncado. Executar o código puro de `functions-relay.js` no mesmo isolate, sem eval de input e sem Node/crypto em functions.

Criar `createFunctionsRelay` com enabled e nativeApproved explicitamente true APENAS para esta QUERY, `allowedQueries:[{procedure:'listDomains',input:{projectName:'dashboard-image-20260930',serviceName:'web-access-v24-f58dfa73'}}]`, `allowedMutations:[]`, timeoutMs15000 e tools com SOMENTE `mcp__easypanel__execute_query`. `readPublic` devolve o envelope já validado. `retainPrivate` deve ser síncrono e guardar resposta em `store`, nunca `text`/notify/arquivo. `writeToNode` chama `tools.write_stdin` na sessão capturada; guarda o retorno internamente e publica apenas a projeção final fechada da demo. A sessão deve receber ACK dentro de 15s; executar start/readback/relay/write no mesmo exec evita tempo de interação entre células.

O relay envia `read-stdio-response-v1` / seq1 / oktrue / result (envelope MCP completo) como uma linha stdin. A demo aceita structuredContent ou único bloco text do procedimento correto; publica apenas `{schema:'read-stdio-demo-v1',state:'received-list-domains',domainCount:N,mutationSent:false}`. Isso comprova transporte de resposta; atribuir MCP real depende do callback real observado pela raiz. Em timeout/EOF/abort/correlação errada: terminal `unknown`, sem retry. RPC já enviado pode continuar do lado remoto; não alegar cancelamento físico/forense nem exit zero sem readback.

## Limites explícitos

PRIVATE é derivado de env não vazio/campos sensíveis reconhecidos, não de boolean do caller. Inputs MCP têm shape/tipos fechados. Na futura integração com adapter v2, ainda não validada, materialize deve ser `mcpArguments` branded. `source.content` é texto opaco público fornecido pelo materializer confiável, não um detector semântico genérico de segredo. Regras de scope/approval e fences existentes continuam antes de efeitos.

Os helper kinds `admin-password`, `admission` e `observe` continuam FUTUROS, não admitidos nesta prova. Seus payloads opacos não têm contrato fechado completo; não conectar, aprovar nem usar request(helper) com credenciais ou planos até revisão separada. Não há StageRunner nem ativação READ/LOGIN/issuer autorizada pela ponte.

Capturar stdout PRIVATE internamente e manter respostas MCP em RAM são regras do futuro executor. O transporte privado teve testes somente com sentinelas sintéticas; a consulta nativa usa apenas identificadores públicos e não acessa credenciais. Ferramentas e stdin/stdout internos podem ter registros privados. Não há promessa zero logs privados, zero forense ou purge.

## Provas

17 casos autor PASS (16 de transporte + 1 projeção da demo), Node22/env-i/guard externo. Revisão child: 16 transporte PASS, probes abort/readback e abort/write PASS. Revisão peer: 3 probes independentes de unknownkeys/tipos/timeout PASS. Sessão TTY real sintética: requestfile600/hash/readback, seq/ACK, sem eco, exit0; MCPcalls0/mutations0. Sintaxe dos cinco arquivos verificada separadamente. A prova do agente não usou MCP real nem helper privado.

## Consulta MCP nativa executada pela raiz

Em 03/10/2026, o transporte fez uma única chamada real ao conector Easypanel: execute_query/listDomains, no alvo exato acima. O relay respondeu seq1, Node terminou com exit0 e a projeção pública confirmou quatro domínios; mutações0, PGfalse e nenhuma credencial privada utilizada. A prova pública foi retida fora do Git com SHA aed3ef368f49fa75d4ded25210a3708442c8963f6f308258d75c267920922309. Ela comprova o transporte desta consulta; não comprova StageRunner, helpers privados, custódia/executor com credenciais reais, recursos/volumes no servidor, LOGIN, issuer, instalação SQL, gestores ou ativação. Nenhum desses efeitos está autorizado pela prova.
