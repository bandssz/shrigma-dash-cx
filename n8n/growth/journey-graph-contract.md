# Contrato puro de jornadas — candidato desativado

`journey-graph-contract.js` exporta CommonJS e `JourneyGraphContract` no navegador,
com `VERSION=journey_graph_v1` e `ENABLED=false`. Não está no manifesto do painel.
Não instala SQL, cadastra fontes, autoriza destinatários, agenda jobs ou envia.
Esta é a primeira peça do construtor completo, não a entrega operacional.

## Desenho e catálogo

`validateGraph(definition, {catalog})` retorna `{ok, version, errors}`; cada erro
contém `code`, `path` e orientação. A definição editável contém somente
`{version, brand, name, nodes, edges}`. Marcas: `fish` e `aristo`. Não recebe ID de
jornada, versão publicada, identidade de participante ou flag de ativação.
IDs dos nós são identificadores locais editáveis. Layout fica fora deste contrato
de execução; a futura API deverá armazenar a apresentação separadamente.

Um DAG de 2–32 nós tem exatamente um `trigger`, todos os nós alcançáveis e todos
os caminhos terminando em `exit`. Não há ciclos, fan-out ou execução paralela.
Dois caminhos podem reencontrar um nó, mas somente um deles é percorrido por
participação. Nós e conexões:

| Tipo | Configuração além de `id/type` | Saídas |
|---|---|---|
| trigger | `event`: chave de fonte disponível | next |
| wait | `seconds`: inteiro 1–2.592.000 | next |
| condition | `expression`, `on_unknown:{max_wait_seconds,retry_seconds}` | yes/no distintos |
| message | `binding`: chave de release do catálogo | next |
| exit | `reason`: código de saída | nenhuma |

Cada aresta tem `{from,to,port}`. Condições usam `{field,op,value}`, `{all:[...]}`
ou `{any:[...]}`, no máximo 16 comparações e profundidade 4. Operadores e tipos
constam de `CATALOG`, congelado. Sem coerção de string para número/booleano,
expressões de código, SQL, regex ou caminhos de propriedades livres.

O **servidor** fornece catálogo `{version,brand,triggers,fields,messages}`:

- Trigger: `{key,brand,available,fields:[chaves]}`.
- Campo: `{key,type,available,max_age_seconds}`; tipos `boolean`, `number`,
  `string`, `timestamp`, `string_set`.
- Mensagem: `{key,brand,channel,available,release,required_fields:[chaves]}`.
  Canais `email`/`whatsapp`; release opaco e imutável, sem segredo ou endereço.

Fonte/campo/mensagem indisponível ou de outra marca impede validação. A mensagem
só aceita dados expostos pelo gatilho. `available=true` é evidência que o adaptador
futuro terá de provar; os fixtures deste pacote não habilitam capacidade real.

## Tempo, dados e transições

Todos os instantes são UTC canônico com milissegundos (`...00.000Z`), recebidos por
argumento. Não há relógio ambiente. A primeira versão suporta espera relativa à
conclusão efetiva do predecessor; calendários, fuso/horário local e janela diária
não estão implementados. O futuro catálogo não deverá oferecê-los como executáveis.

`evaluateCondition(expression,{catalog,trigger,facts,now})` retorna
`{value:true|false|'unknown',reasons}`. Cada fato é
`{value,observed_at,complete:true}`. Dado ausente, incompleto, vencido, futuro ou
com tipo inválido é desconhecido, inclusive em `ne`/`not_contains`. `all/any`
usam lógica de três valores: falso conhecido decide `all`; verdadeiro conhecido
decide `any`; nos demais casos o desconhecido permanece. Não se converte ausência
em “Não”. Uma condição desconhecida conserva o instante de entrada e o prazo
máximo (até 24h), indica a próxima conferência e bloqueia ao vencer. Depois de
registrado `waiting_data`, dado que chegue no prazo final ou depois dele não
libera a participação, inclusive após pausa; exige tratamento operacional futuro.
Mensagem sem valores obrigatórios válidos bloqueia sem produzir intenção.

`createState(definition,{catalog,identity,started_at})` exige identidade **do
servidor** `{entry_id,journey_id,revision,event_id,brand,trigger}`. Não gera UUID,
não inscreve contatos e não substitui persistência/autorização. Estado conserva
identidade e representação canônica da definição/catálogo; qualquer divergência
posterior é recusada. Isso é guarda de consistência, não assinatura criptográfica.

`nextTransition(definition,state,{catalog,identity,now,facts,messageReceipt,paused})`
retorna `{kind,state,authorizes_send:false,...}` sem alterar argumentos. Estados
incluem `ready`, `waiting`, `waiting_data`, `waiting_message`, `unknown`,
`blocked`, `failed`, `completed`. Um `message_intent` contém apenas ligação de
release/canal/marca e chave determinística `[version,entry_id,node_id]`. Persistido
o estado, nova avaliação aguarda o mesmo recibo; não produz outra intenção.

Recibo confiável do adaptador é `{attempt_key,status}`, com `accepted`, `rejected`
ou `outcome_unknown`. Aceitação avança, rejeição encerra em falha e resultado
incerto permanece bloqueado até conciliação da mesma tentativa. Aceitação não
significa entrega. Pausa não gera intenção nova; permite conciliar o recibo já
em trânsito. O pacote não promete cancelar uma aceitação externa.

## Simulação e integração restante

`simulate(definition,{catalog,now,facts,receipts,maxSteps})` chama exatamente
`nextTransition`, usa identidades sintéticas, avança o relógio nas esperas e usa
aceitação **hipotética** para mensagens, salvo cenário explícito. Para em dado
indisponível, saída, falha, incerteza ou limite (1–256 passos). Retorna trace,
`simulated:true`, `sends:0`, `persistence_writes:0`; nunca recibo operacional.

O [adapter candidato](journey-graph-runtime.md) acrescenta persistência transacional,
revisões imutáveis, CAS, deduplicação e recuperação de recibos internos para o recorte
`cart.abandoned`/intenção de e-mail. Continua OFF, sem instalar ou tocar jornadas atuais.
Sua fonte e elegibilidade são sintéticas; não há transporte nem prova de integração real.
Faltam fonte por marca, releases/cache reais, scheduler/claim, consentimento/opt-out/silêncio
e rechecagem final no emissor, recibos de transporte, revisão operacional de atrasados,
autorização/API e editor. Não ligar este núcleo diretamente a HTTP de envio.

Teste: `node --test tests/journey-graph-contract.test.cjs`. Fixtures sintéticas,
ambas as marcas e canais; nenhum transporte, credencial ou dado de cliente.
