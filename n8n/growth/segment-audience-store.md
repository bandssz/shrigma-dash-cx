# Públicos v2: persistência e API local em sombra

Candidato local para `crm-audience-v2`. Não instalado, sem listener HTTP, workflow, credencial, pool, serviço, anúncio de capacidade em produção ou envio. Não altera o store v1 nem migra seus públicos. O prazo de trabalho atual é sexta, 02/10; os testes abaixo não constituem aceite de produção.

## Arquivos e interfaces

- `segment-audience-store.sql`: instalação fresca, em um único `DO`, do schema privado `crm_audience_v2`. Colisão aborta tudo. As duas marcas começam com `enabled=false`, sem base/catálogo configurados. Não concede acesso a nenhum papel de aplicação.
- `segment-audience-store.cjs`: `createAudienceStore({transaction,countProvider=null,timeoutMs=25000})`; expõe `execute({key,request,signal})`. É a única entrada de escrita prevista. Sempre valida o request, autentica no servidor e normaliza a definição com `segment-audience-contract.js` antes da escrita parametrizada.
- `segment-audience-api.cjs`: `createAudienceAPI({store}).handle({method,request:{headers,body/query}},{signal})`; retorna `{status,headers,body}`. É uma fronteira com formato HTTP para composição local; não abre porta nem chama rede.
- Helpers server-only: `readAuth(query,key,needed)`, `readCatalog(query,brand)`, `readDefinition(query,{brand,id})`, `pins(definition,current)` e `publicSegment(row,current)`. As leituras que usam `FOR SHARE` precisam da mesma transação normal e exclusiva; não aceitam uma transação PostgreSQL `READ ONLY`.

`query(text,values)` retorna `{rows}`. Nenhuma API do painel aceita SQL, `actor`, `caps`, contexto, base, catálogo ou fonte enviados pelo cliente. A definição é validada novamente mesmo quando um integrador chama `store.execute` diretamente, sem a camada HTTP. O schema não tem função pública que receba definições arbitrárias: a credencial de escrita pertence ao backend confiável, que executa o contrato JS. Acesso SQL direto de administrador continua fora dessa fronteira.

## Contrato de transação do host

`transaction(async ({query}) => result, {signal,readOnly:false,isolation:'read committed'})` deve adquirir uma conexão exclusiva, iniciar uma transação real em READ COMMITTED, executar o callback e resolver **somente depois do COMMIT confirmado**. Exceção no callback exige rollback; rollback/commit com resposta incerta exige descartar a conexão e propagar falha. Nenhuma tentativa é repetida automaticamente. Não é válido implementar esse adaptador chamando o callback sobre consultas autocommit de um pool ou sobre o utilitário SQL compartilhado.

A sessão exclusiva deve ter `statement_timeout` efetivo positivo e de no máximo 30 segundos antes das consultas. O serviço verifica esse limite e o isolamento; fixa `search_path=pg_catalog,public` e `lock_timeout=500ms` somente na sua transação. O timeout de JavaScript aborta o resultado local, mas não comprova cancelamento do servidor. Uma escrita sem confirmação fica incerta e só é conciliada por leitura do recibo, sem replay automático. A transação usa `readOnly:false` também para consultas, porque os bloqueios de leitura `FOR SHARE` exigem isso; listar/obter/contar/operação não gravam no store.

O helper Growth continua como autoridade de identidade/permissões. A fronteira local também confere, com `clock_timestamp()`, uma única linha ativa da mesma identidade e área, sem revogação, correspondendo ao hash da chave longa ou curta. Isso impede que `now()` congelado no começo da transação mantenha válida uma chave que venceu durante uma espera. A autenticação é repetida após locks e antes do resultado/commit. Não usa fallback legado nem altera o helper compartilhado.

## Wire do cliente

Usa os nomes já conhecidos pelo cliente:

| Método | Ação | Campos além de `acao` e `brand` |
| --- | --- | --- |
| GET | `segmentos_listar` | `limit`, `offset` (padrões 50/0) |
| GET | `segmento_obter` | `id` UUID |
| GET | `segmento_operacao` | `idempotency_key` |
| POST | `segmento_criar` | `definition`, `expected_catalog_hash`, `idempotency_key` |
| POST | `segmento_salvar` | `id`, `expected_version`, `definition`, `expected_catalog_hash`, `idempotency_key` |
| POST | `segmento_arquivar` | `id`, `expected_version`, `idempotency_key` |
| POST | `segmento_contar` | `expected_catalog_hash` e `definition`, ou `id` + `expected_version` |

Somente `Authorization: Bearer`. Chaves duplicadas, credencial em outro canal, campos extras, marcas fora de Fish/Aristo, coerções numéricas frouxas e métodos divergentes são recusados. Respostas usam `Cache-Control: no-store`.

O objeto `segment` conserva os campos de identidade, definição, versão, arquivo e auditoria esperados pelo cliente, acrescentando no v2 `semantic_context:{currency,timezone,current}`. Moeda/fuso são derivados da revisão **salva**; nunca vêm do catálogo atual para relabelar dados antigos. `current=false` preserva consulta e informa que a semântica salva divergiu. O recibo original não muda em replay; a conciliação do cliente consulta o público atual depois do recibo.

## Atomicidade, CAS e recibos

Cada criação/salvamento/arquivo grava audiência, revisão e recibo na mesma transação. A FK adiada exige que a revisão atual exista ao confirmar; revisões e recibos recusam UPDATE/DELETE. CAS usa versão inteira exata e bloqueio da audiência. Arquivar aumenta a versão e preserva definição/contexto.

O ledger tem chave `(actor,operation_key)` e conserva marca, payload completo, hash e resposta original, inclusive rejeições de negócio confirmadas. `expected_catalog_hash` faz parte do payload. A mesma chave com outra marca ou payload recebe `SEGMENT_OPERATION_MISMATCH`. Outra pessoa não lê o recibo. Replay e consulta são reautenticados; perda de resposta após commit pode ser conciliada sem nova mutação. `404 SEGMENT_OPERATION_UNCONFIRMED` não é prova de rollback e não autoriza reenvio.

Falha depois de uma gravação, expiração do catálogo ou autenticação perdida antes do fim faz o callback lançar e exige rollback integral. Esse caso nunca é convertido em rejeição de negócio que confirmaria uma audiência sem seu recibo.

## Catálogo e contexto semântico

O catálogo é administrado pelo servidor; a API não oferece edição de configuração. Sua validade é de até cinco minutos, sem renovação implícita. A base vem de configuração explícita e é conferida contra a marca/classificador e o opt-in da lista nativa. Não há inferência de base por número ou nome no serviço.

`catalog_hash` usa `canonical-json-sorted-keys-sha256-v1`: chaves de objetos ordenadas, arrays mantidos na ordem, UTF-8 e SHA-256. É o mesmo contrato JS do reviewer; **não** equivale a `jsonb::text` do PostgreSQL. O hash inclui marca/base, estado/opt-in das listas nativas e configuração das fontes; exclui horários de leitura/expiração e a revisão administrativa de refresh. Atualizar só horários sem mudar semântica não invalida a intenção.

Criar, salvar e contar exigem o hash que foi exibido ao operador. Mudança de moeda, fuso, catálogo de produtos, estado da lista ou proveniência de origem resulta em `409 SEGMENT_CATALOG_CHANGED`; em mutações, a rejeição fica no ledger. Além disso, salvar/contar uma revisão existente compara seus pins anteriores com os atuais. Reabrir uma audiência BRL em catálogo USD não autoriza reinterpretá-la, mesmo que o cliente tenha lido o hash USD. Nesta etapa, uma revisão assim permanece consultável e arquivável; migração explícita de contexto não foi implementada.

O contexto privado de cada revisão fixa base/opt-in e apenas as regras utilizadas. Regras Shopify fixam loja, moeda e fuso. Origem fixa uma proveniência revisada. `source_hash` significa **versão/proveniência estável do adaptador e sua semântica**; nunca hash de contagens, pedidos, pessoas, membros ou horários de uma observação. Snapshots de evidência pertencem à revisão/contagem separada. `available=true` permite preparar aquela condição; não declara cobertura de dados, completude ou direito de envio. O catálogo público informa `coverage:'unconfirmed'`.

Frescura e semântica são relidas sob locks depois das esperas, antes da gravação, após a contagem e antes do retorno da transação. As leituras não congelam fontes externas nem eliminam mudanças futuras; toda execução/envio permanece fora deste contrato.

## Contagem e capacidades

Sem `countProvider`, `capabilities.count=false` e contar retorna indisponível. Com o hook confiável `countAudience` de `segment-audience-listmonk.cjs`, regras de listas e registros de abertura/clique usam agregação SQL e rechecagem nativa de base, consentimento e status global. Engajamento exige o hash de fonte específico à marca/campo e considera somente eventos registrados em campanhas de e-mail criadas no painel daquela marca; ausência de registro não prova ausência de interação. Compra, produto e origem ainda não conectados, ou engajamento sem fonte confirmada, são desconhecidos. E/OU preserva a lógica de três valores: a contagem só é confirmada quando a árvore determina todos os assinantes elegíveis; se restar algum desconhecido, retorna `source_confirmed:false` e `eligible_count:null`, nunca zero presumido. O hook também atende definição não salva, portanto não anuncia uma capacidade genérica que funcione apenas para revisões salvas.

`draft` depende da configuração atual e da permissão de servidor; `count` também depende do hook instalado localmente. `send`/`transport_supported` continuam falsos. Não há seleção em campanhas, materialização de lista, alteração de contato, confirmação de consentimento, agendamento ou envio.

## Provas locais e próximos gates

Os testes sintéticos usam PGlite com o helper de autenticação Growth real, o classificador real e tabelas nativas sintéticas. Cobrem ambas as marcas, CAS, arquivo, imutabilidade, rejeições duráveis, replay por chave longa/curta, revogação e expiração durante esperas, hash do catálogo, unidade salva, expiração antes/depois da escrita, timeout, rollback saudável, perda de ACK e reabertura de banco em disco. Também compõem o provider agregado real de listas.

Ainda faltam prova PostgreSQL real com conexões concorrentes/locks, adaptador de pool exclusivo revisado, papel/ACL restritos, CI remoto futuro, instalação revisada, readback e aceite em ambas as marcas. A definição tipada não substitui fonte completa de compras/origem/engajamento, vínculo Shopify→assinante, seletor de campanha ou nova checagem de opt-out no transporte. Nada foi publicado nesta etapa.
