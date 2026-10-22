# Recuperação manual READ — proposta OFF

Base de fonte: candidata `9241ff9b412e7971909d41379d0cf6b00f1b8432`; módulos privados usados idênticos ao lote `51fa84aa6384618f17b0b1d3f219151541de69c4`. Este pacote NÃO executou MCP, PostgreSQL, Docker, HTTPS real ou TTY. Os seis testes usam IDs/cápsula/chaves explicitamente sintéticos. OCI dos novos mounts será prova de CI posterior; a prova nativa runtime/PG existente não é repetida aqui.

## Entrada e fronteira

`recovery.cjs` prepara dois planos reconcile distintos a partir do arquivo público ORIGINAL600/SHA: primeiro observador sem PG, depois alvo de reconciliação. Ambos preservam o intent SQL, as duas volumes originais e as fontes9 pinadas. `entry.cjs` compõe o transporte existente; `provider-template.cjs` materializa um único export `createProviders`, restrito a reconcile. Os módulos R/O/E/P/M/F/B/D/S e runtime9 permanecem intactos e têm SHA fechado em `recovery.cjs`.

Para as entradas operacionais, copiar as três fontes públicas pinadas para um bundle local0700/arquivos0600; o provider exige recovery.cjs600 e SHA, não executa diretamente um arquivoGit0644. Os testes copiam essa fonte para uma fixture600 própria, sem depender do mode do checkout.

Nenhum script cria cápsula, troca senha/verifier, reinventa Stage, executa `activate`, renova, instala SQL ou desativa LOGIN. Recuperar ACK não equivale a autorizar LOGIN/issuer. Cada futuro observador/transporte/read-only reconcile exige a autorização explícita do seu escopo. O armazenamento original do diário permanece RW porque o runtime existente precisa anexar o readback durável; a transação PostgreSQL é READ ONLY.

## Sequência finita futura

1. Reter o plano público original e RSA privada/cápsula original em seus diretórios0700/arquivos0600. Os arquivos de entrada não contêm adminPassword nem verifier. Reservar duas novas tuplas suffix/domainId: observador e reconcile, diferentes uma da outra e do Stage. Não converter o projeto original: `isolatedProject` vem do plano original.
2. Preparar somente arquivos públicos com `node entry.cjs --prepare-public INPUT600 INPUT_SHA`. O `INPUT` tem exatamente `schema,plan,directory,custodyDirectory,publicKeyFile,privateKeyFile`. `plan` tem exatamente `runtimeDirectory,originalPlanFile,originalPlanSha256,observerSuffix,observerDomainId,reconcileSuffix,reconcileDomainId,projectCreatedAt`. O diretório de destino deve estar vazio/0700. Essa etapa não abre chaves nem invoca transporte.
3. Coletar por queries nativas já disponíveis `inspectProject`, `listDomains {}` e `getLegacyMonitorSystemStats`. Projetar APENAS valores observados no snapshot abaixo, arquivar600/SHA. Projetos/serviços devem vir de `inspectProject` bem-sucedido, nunca de Compose404. Os dois alvos e domínios novos precisam estar ausentes nessa primeira coleta. Memória livre>=2200MiB, CPU livre>=1core e disco livre>=4.3GiB são snapshot conservador, não reserva absoluta. TTL10s desde início das queries.
4. Antes de iniciar `--observe`, instalar a whitelist pública literal do `observer-scopes.json` no relay existente: **7 queries/10 mutations**. Flags `nativeApproved` e aprovação do transporte continuam OFF até o escopo aprovado. Usar a mesma sessão `stty -echo -icanon; node entry.cjs --observe OBSERVER_CONFIG600 SHA` com TTY. Config exata `enabled,approved,inputFile,inputSha256,snapshotFile,snapshotSha256`; o default é false. A sessão emite READY apenas após bridge/parser prontos. Poll somente o mesmo SID; não reiniciar processo nem repetir frame se ACK faltar.
5. O observador contém o serviço ORIGINAL com stop, env vazio, rota ausente e zero running; E/M valida os valores reais internamente. Cria um public-park sem volumes, atualiza somente para P-probe de fontes/diário ORIGINAIS, deploy uma vez e lê GETHTTPS literal. P exige `ledgerPhase:original_intent_held`, não aceita o empty/pre-Stage. Retém projeção600EXCL/fsync/readback. Depois para o observador, esvazia env e remove sua rota. Retém `original-observation.json` apenas se ambas quiescências forem verificadas. Unknown=>HOLD, sem V1, sem retry de create/Stage.
6. Coletar snapshot nativo novo depois dessa contenção. O observador pode permanecer cadastrado DESABILITADO; seu domínio deve estar ausente. O alvo final reconcile e domínio ainda precisam estar ausentes. A quiescência conserva `allContainersInspected:false`: o MCP lista running, não prova remoção de tarefas/containers parados. Não apagar os volumes originais.
7. Para `--materialize-private CONFIG600 SHA`, enviar na mesma TTY sem eco **um** packet bootstrap7fields seq0<=16KiB após READY privado. Ele tem schema existente, mode reconcile, planSha256 FINAL, `adminPassword` apenasRAM, `servicePassword:null,serviceVerifier:null`. O.openExisting da cápsula ORIGINAL fornece o verifier. O código calcula/fecha o PRIVATE frame<=4096 e a whitelist FINAL **7 queries/13 mutations** antes de efeitos. Retém apenas startup/provedor público600/SHA. A saída com scopes/env é PRIVADA: `functions.exec` captura o retorno nested e guarda em RAM; nunca `text`, `notify`, arquivo público, argv ou env do processo. Registros privados das ferramentas podem retê-la; não se promete zero auditoria/eliminação forense.
8. Instalar EXACTAMENTE esses scopes no relay antes do ACK0/primeiro frame do driver existente. Iniciar `node driver.cjs --opt-in STARTUP600 STARTUP_SHA PROVIDER600 PROVIDER_SHA` na TTY sem eco e enviar bootstrap7fields equivalente após READY seq0. O provider só admite mode reconcile, reabre cápsula original, valida hashes/vetores antes bind, e constrói V1 a partir da observação original e snapshot fresco10s. V1 não é entrada livre de booleans. R faz novamente contenção real ORIGINAL; M executa duas novas projeções P dos volumes originais antes de configurar env privado/PG. O runtime então consulta read-only o MESMO intent/verifier e anexa seu readback no MESMO diário. Nunca novo Stage/ID/senha.
9. Reter as duas postconditions P finais600EXCL/fsync/readback e a resposta supervisor fechada. Confirmar exit0/1 da mesma sessão, não apenas frame final. Executar contenção final existente (stop/env vazio/rota removida), preservando fontes/diário/cápsula e fences. Unknown/EOF/timeout/truncamento=>HOLD e observação posterior/manual; não reexecutar Stage nem gerar outra credencial. Se o diário/source original não puder ser provado, não construir V1 nem acessar PG.

## Snapshot público fechado

```json
{"schema":"crm-manager-read-manual-native-snapshot-v1","startedAt":0,"finishedAt":0,"project":{"name":"PROJECT_ORIGINAL","createdAt":"TIMESTAMP_ORIGINAL","serviceNames":[]},"domains":[],"capacity":{"freeMemMb":0,"cpuCount":0,"cpuUsedPercentage":0,"freeDiskGb":"0"}}
```

Os zeros são EXEMPLO inválido, nunca receipt. `domains` projeta somente `{id,host}` de cada domínio nativo; `serviceNames` projeta nomes do inventário nativo. Somente uma coleta atual que passe as comparações literais/capacidade gera admissão. O arquivo original-observation precisa ter <=10min desde a leitura P e preservar as duas quiescências/intent/volumes/SHAs. TTL fresh snapshot continua10s; execução lenta falha fechada. Não há retry automático para renovar receipt.

## Montagens/recursos/SQL

A fase pública usa o plano reconcile existente, sem initializer, volumes externos ORIGINAIS: source `/review` RO e ledger `/runtime-proof` RW; UID1000, rootRO, caps0, NNP, .35CPU/320MiB/PID64 e tmpfs16MiB. Registry image5ca é pinado, Config.Volumes=[]; não há anonymous volume admitida. A preparação pública park usa o contrato E existente, sem volumes. O observador P não abre PG e não executa runtime, mas fsync/readDurable original no diário. A prova OCI nova remove rede easypanel/env_file e usa networknone, delta explícito de teste; execução futura privada usa o destino PG fixo original, TLSOFF e rede compartilhada (sem alegar firewall).

Runtime9 preserva PG17/listmonk/postgres, core4f, ext plpgsql+pgcrypto1.3 e SET/SHOW transaction_timeout500ms ANTES BEGIN/readback; é orçamento configurado, não limite físico de todos os locks. Não alterar flags/backend/operator/SQL para recuperar resultado. Prova SQL/runtime anterior permanece válida; este pacote prova o transporte e origem dos volumes, ainda requer execução OCI específica na CI.

## Provas desta entrega

6/6 unitários sintéticos PASS com Node22, env-i e unit-guard existentes: OFF sem I/O/import/deps; dois alvos+mounts originais; contenção/projeção/arquivoV1; unknowncreate/malformedledger sem retry; V1 nega mismatch/empty/TTL/capacidade/ocupação; provider retorna apenas verifier original e scopes exatos reconcile, TTL expira. Nenhuma prova declara inventário de stopped containers nem provider nativo executado. `manifest.json` fixa fontes/base/hashes e `proof.json` registra apenas resultados públicos.

## Hook OCI mínimo (proposta; não executado localmente)

Destinos propostos: `tools/crm-manager-read-credential-custody/manual-reconcile/{recovery.cjs,entry.cjs,provider-template.cjs,recovery.test.cjs,README.md,oci/run-oci-proof.sh,oci/oci-proof.cjs}`. O teste local resolve os módulos no diretório pai; `READ_RECOVERY_TEST_RUNTIME` é override dedicado somente de fixture sintética.

No job candidato noSQL já existente, depois de admitir/pull a imagem5ca por digest e configurar Node22/Docker, executar:

```sh
CI=true READ_MANUAL_RECONCILE_OCI_PROOF=1 READ_RECONCILE_RUNTIME_DIRECTORY="$GITHUB_WORKSPACE/tools/crm-manager-read-credential-custody" bash tools/crm-manager-read-credential-custody/manual-reconcile/oci/run-oci-proof.sh
```

Sem opt-in explícito o runner é OFF com Docker/PG0. A CI gera IDs e nomes CSPRNG próprios, cria volumes próprios com labels, usa uma única vez o initializer C congelado para a fixture, persiste somente intent sintético por J e então executa P reconcile gateway-only com source originalRO/ledger originalRW. Nenhum SQL/adminPassword/verifier ou cápsula é necessário ao OCI. O readback exige dois GETs P held, hashes/bytes do diário antes/depois idênticos e cleanup somente IDs/volumes rotulados próprios. Esse job não publica imagem, instala serviço ou acessa rede Easypanel. Resultado real só poderá ser declarado após a CI executar.
