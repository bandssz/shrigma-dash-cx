# StageRunner READ — fonte inativa

`stage-runner.cjs` compõe a custódia, os fences, o operador remoto, o adapter MCP e a ponte STDIO. `status-reader.cjs` fornece o observador HTTPS separado. São ferramentas do operador, fora do pacote do dashboard e desligadas por padrão. Nenhuma dessas fontes instala LOGIN, issuer, usuário ou SQL ao importar.

## API e dependências

`createStageRunner()` ou `{enabled:false}` não importa os componentes compostos, lê ambiente, cria diretórios/timers, toca streams ou faz chamadas. Stage/reconcile retornam o estado disabled.

ON exige `{enabled:true,stageApproved:boolean,readonlyReconcileApproved:boolean}` e:

- `custody:{directory,privateKey}`, `effectsDirectory` e `requestDirectory`; diretórios próprios/canônicos0700. Custódia e fences persistem; requests usa um diretório novo por sessão. Nenhuma geração ou descoberta implícita de chave/credencial.
- `transport:{input,output}`; streams explícitos, ponte lazy e somente `execute(frame)`/`M.mcpArguments`. O relay externo tem aprovação e scopes literais próprios. O runner não aprova ferramentas nativas.
- `admission(request)`, `getAdminPassword(request)` e `observeStatus(request)`; callbacks privados fixos, sem evidência default/noop. `timers:{setTimeout,clearTimeout}` é injeção opcional para provas; runtime usa timers durante a invocação.

`stage({plan,password,verifier,publicKey})` exige plano branded de `R.buildStagePlan` e os inputs explícitos da custódia. `reconcile({plan})` exige `R.buildReconcilePlan`, a cápsula original e os mesmos IDs/volumes; não gera intenção ou senha nova. `close()` impede chamadas, aborta o canal e cancela awaits. Há uma invocação local por vez; sem retry, scheduler ou novo journal.

## Callbacks fechados

Admission recebe exatamente `{schema:'crm-manager-read-stage-admission-request-v1',planSha256,mode}`. Um provider fechado sobre o plano devolve somente o contrato remoto V1 ou V2 admitido por R/M. SHA, modo, capacidade, alvo, domínio, imagem e fontes são reconferidos. Ausência, recusa, SHA errado ou gate falso impedem create. O runner não deriva evidência de nomes, do bootstrap ou do recibo esperado.

V1 exige ausência observada dos novos volumes para execute. V2 vale apenas para um stage novo: registra `newVolumesAbsent:false` e `volumeExistence:'unobserved'`, exige namespace128 derivado dos dois IDs originais, nomes exatos e volumes próprios não externos. Mantém os outros gates. Namespace forte reduz colisão acidental, mas não prova ausência: um volume estrangeiro vazio root0755 poderia ser preenchido. Não há inventário global nem registro global de intenções. Não reinterpretar cápsulas/planos antigos48 como128, reutilizar IDs ou criar nova intenção após resultado incerto.

Reconcile aceita somente V1: volumes externos originais, fonte/ledger originais e quiescência anterior observada **antes** de create. O postcondition futuro não é essa evidência. O provider real de admissão ainda precisa ser implementado e provado; booleans das fixtures são sintéticos.

Admin recebe exatamente `{schema:'crm-manager-read-stage-admin-request-v1',planSha256,mode}`; devolve somente string1–1024 sem CR/LF/NUL/backslash/apóstrofo. O callback ocorre depois das duas barreiras públicas. O runner não busca senha em serviço, arquivo ou ambiente.

Observe recebe somente `{schema,planSha256,url,method,maxBytes,timeoutMs}`: HTTPS literal do host do plano + `/status`, GET, 4096 bytes para postcondition ou2048 para supervisor, prazo35000ms. O reader usa Host/SNI/certificado e TLS mínimo1.2, sem auth/cookie/corpo/redirecionamento; recusa erro HTTP, encoding, UTF8 ou limite inválido. Retorna apenas o contrato validado/canonicalizado, não corpo bruto ou mensagem de upstream. Seus testes usam transporte injetado, sem comprovar TLS/GET remoto.

Deadlines: GET35000, callbacks40000, ponte45000; relay externo40000. Timeout/close não desfaz RPC/GET iniciado; resposta tardia não abre a próxima etapa. Dados privados podem existir nos registros internos das ferramentas; não há promessa de limpeza forense.

## Validação e limite operacional

Onze testes do runner exercitam OFF/gates, plano não branded, composição com duas barreiras públicas, um deploy privado, V1 recusado/V2 explícito com namespace128, cápsula/fences, perda de ACK, reconciliação original, concorrência/close/deadline e admin inválido. A ponte usa PassThrough e MCP simulado, scopes literais e RSA4096/password/SCRAM sintéticos. Sete casos do reader são igualmente sintéticos. O lote integrado de nove arquivos de teste passou70/70 antes do caso V2 adicional; a execução final dos onze casos do runner também passou11/11, incluindo o novo caso V2.

A ponte admite apenas `kind:'mcp'`; helpers antigos são recusados antes de callbacks. A consulta MCP real anterior comprova somente listDomains V24, sem mutação/PG. Os readbacks públicos de78093/7903/1937 bytes chegaram completos via ferramenta neste ambiente; não comprovam uma mutação MCP com esses argumentos.

Ainda faltam o processo real, bootstrap privado antes da ponte, scopes privados previamente ligados, provider observável de admissão e prova de transporte com esses contratos. Fonte/mock/OCI públicos não comprovam canal de credencial real, LOGIN/issuer ou uso de gestor. Stage e ativação exigem aprovação concreta separada.
