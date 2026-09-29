# Vínculo público v2 → campanha — candidato local

Contrato `crm-audience-campaign-binding-v1`, capacidade desligada. Não há rota HTTP instalada, anúncio no painel, publicação, alteração de listas/contatos, admissão de fonte, agendamento ou envio. O contrato de campanha legado continua intacto: não recebe um campo de audiência que seu normalizador possa ignorar.

## Wire separado

`createSegmentCampaignBinding({transaction,timeoutMs}).execute({key,request,signal})` retorna `{_http,_body}`. A credencial vem do adaptador de servidor; `request` nunca aceita ator, permissões, SQL, definição/contexto livres ou um comando de envio.

| Ação (`acao`) | Campos além de `brand` |
| --- | --- |
| `campanha_publico_conferir` | `campaign_id`, `audience_id`, `audience_revision` |
| `campanha_publico_vincular` | Os pins de `intent` devolvidos pela conferência e `idempotency_key` |
| `campanha_publico_obter` | `campaign_id` |
| `campanha_publico_operacao` | `idempotency_key` |

`intent` contém `brand`, `campaign_id`, `expected_campaign_version`, `expected_binding_version` (zero quando não há vínculo), `audience_id`, `audience_revision`, `expected_definition_hash`, `expected_context_hash`, `expected_catalog_hash`. Conferir não reserva versão nem grava revisão. Vincular lê tudo novamente; um intent velho não autoriza atualização silenciosa. Não existe desvincular nesta etapa, pois isso liberaria o caminho legado implicitamente.

## Fronteira HTTP e cliente candidatos

`segment-campaign-binding-api.cjs` expõe apenas `createCampaignBindingAPI({store}).handle({method,request:{headers,body/query}}, {signal})`; não cria listener nem workflow. GET aceita obter/operação, POST aceita conferir/vincular. A credencial entra exclusivamente em `Authorization: Bearer`, a origem permitida é a do painel e os campos passam pelo parser exato do serviço. A projeção recusa respostas com dados extras, campos pessoais ou permissões de envio. Falha de projeção de uma mutação permanece incerta, com a mesma chave da operação. O prazo SQL e a transação continuam obrigações do store/host, não do relógio HTTP.

`growth-campaign-audience-client.js` publica `window.GCAC`. O anúncio candidato é `capabilities.campaign_audience={contract_version:'crm-audience-campaign-binding-v1',brands,read,inspect,bind,operation}` e `capabilities.endpoints.campaign_audience` exige HTTPS sem query, fragmento ou credenciais na URL. Ausência de anúncio deixa a capacidade desligada. Os módulos estão no bundle local de Growth; nenhum anúncio público foi alterado.

`create({api,brand,campaignId,key,storage,fetch,locks})` fixa uma campanha. `read(campaignId)`, `inspect(campaignId,{id,version})`, `bind(intent)` e `consult()` devolvem snapshot; `snapshot`, `pending`, `canWrite`, `update` e `capabilities` servem à UI. A inspeção existe apenas em memória e expira; uma recarga exige nova inspeção para uma operação nova. A versão nativa final pode mudar pelo toque seguro: o cliente valida os demais pins e preserva o `campaign_version` do recibo.

O journal local usa o slot marca/campanha, contendo endpoint e fingerprint SHA256 da credencial (campo `actor_hash`); esse hash não identifica nem autentica o ator do servidor. A chave nunca é persistida. Outra credencial ou endpoint não pode esconder um journal existente. WebLocks serializa abas e armazenamento confirmado precede o POST. Uma resposta ausente, malformada ou rejeição direta mantém a tentativa pendente. `consult()` busca o recibo da mesma operação e depois o GET atual antes de encerrar a pendência; um 404 de operação desconhecida não libera nova tentativa. O cliente nunca repete o POST automaticamente. O transporte limita resposta a64KB e usa deadline próprio; esse prazo não comprova cancelamento do banco.

Quando apenas a conferência encontra listas nativas incompatíveis, ela devolve `SEGMENT_BINDING_BASE_REQUIRED` com `base_list:{id,name}`, lida do catálogo da marca e revalidada. O cliente expõe `error.baseList` para a orientação da UI. Não produz intent, não infere base de uma folha e não altera listas. A mutação mantém sua rejeição durável original.

## Seleção no editor candidato

`growth-campaign-audience-ui.js` integra o editor GCE sem mudar o contrato legado de campanha. Só carrega públicos e consulta o vínculo após ação explícita. Exige rascunho salvo sem mudanças, revisão atual do público e conferência válida antes de mostrar a confirmação. Marca, campanha, conteúdo local, journal nativo, chave, endpoints, capacidades e prazo são conferidos novamente ao confirmar. A orientação de base usa o catálogo autenticado do servidor; a interface não troca listas silenciosamente.

Após vínculo confirmado, o editor reabre a campanha para incorporar a versão final, inclusive quando um trigger nativo atualiza `updated_at`. Validar/agendar pelo caminho legado permanece bloqueado para a campanha vinculada; esta UI não autoriza seleção ou envio. Uma tentativa incerta congela campos e troca de contexto até consultar recibo e estado atual, sem novo POST. Importação assíncrona iniciada antes da confirmação não pode substituir o conteúdo durante ela.

Retirada de capacidades/acesso não apaga o registro. O identificador da campanha salvo localmente serve apenas para localizar e bloquear um journal quando o cliente nativo também fica indisponível. Ele nunca substitui a campanha autenticada, autoriza uma gravação ou comprova sucesso. Sem histórico e sem anúncio, o preparo legado mantém o comportamento anterior e nenhum pedido de público é feito.

`tests/growth-campaign-audience-path.test.cjs` compõe editor, clientes, fronteiras HTTP e SQL/guards reais em DOM local com PGlite sintético, cobrindo ambas as marcas, cancelamento, resposta perdida/recarga, alteração de contexto, importação tardia, retirada/restauração de capacidades e atualização da versão nativa. Não automatiza navegador nem chama produção. Instalação/host HTTP, seleção operacional, fontes externas, conciliação A/B e aceite público continuam pendentes.

## O que fica fixado

O head `crm_audience_v2.campaign_binding` tem CAS por campanha e versão de vínculo. `campaign_binding_revision` e `campaign_binding_request` são append-only. Cada versão copia a definição e o contexto originais da revisão imutável de `crm_audience_v2.revision`, seus hashes, UUID/revisão, base original, marca, catálogo semântico e versão nativa da campanha. O head do público precisa estar na revisão escolhida e não arquivado ao vincular. Atualizar o público depois não muda vínculos existentes: é necessária nova conferência e novo vínculo explícito.

Shape exato de `binding` JSON: `contract`, `brand`, `campaign_id`, `campaign_version`, `binding_version`, `audience_id`, `audience_revision`, `definition_hash`, `context_hash`, `base_list_id`, `definition`, `context`, `catalog_hash`, `authorizes_selection:false`, `authorizes_send:false`. Essas identidades também estão em colunas do head. `binding_hash` usa o hash canônico JS do reviewer; a versão nativa `campaign_version` conserva o MD5 do helper de campanha existente. Eles são contratos diferentes, sem equiparação a `jsonb::text` SHA.

Respostas públicas mostram referências/hashes, base, unidade/fuso salvos e se campanha/contexto ainda correspondem. Não entregam contatos, membros ou material do e-mail. O recibo original permanece igual no replay; obter consulta o estado atual.

## Escopo nativo precisa ser exatamente a base

O seletor nativo de Listmonk já intersecta `campaign_lists` com os destinatários. Portanto, o serviço e o guard SQL do vínculo exigem **uma única lista nativa: a base original do público**. Um público `lista101 OU lista102` não pode ser ligado a uma campanha limitada à lista101, pois excluiria membros exclusivos da102. A API responde `SEGMENT_BINDING_BASE_REQUIRED`; não altera essas listas em nome do operador.

Essa exigência prepara uma composição coerente com o predicado v2 futuro; não transforma a base inteira em público aprovado. Enquanto o seletor não existir/for admitido, o bloqueio de execução abaixo continua obrigatório.

## Barreira contra caminhos legados

A instalação local acrescenta `shrigma_audience_campaign_send_guard_v1` em `public.campaigns`. A função é SECURITY DEFINER com `search_path=pg_catalog`, consulta somente o head privado por ID e devolve imediatamente quando a campanha não está vinculada. Para uma vinculada, recusa:

- sair de `draft`, inclusive agendamento, execução e cancelamento que liberaria outro caminho;
- marcar `started_at`, aumentar/alterar `sent` ou trocar o ID;
- mudar tipo/canal, política Growth ou marca;
- deletar a campanha.

Não há flag, GUC, papel ou exceção `shrigma.campaign_writer` que libere essa barreira. Editar conteúdo ou a data ainda como rascunho pode continuar pelo editor autorizado existente; isso muda a versão nativa e deixa o vínculo antigo com `campaign_current:false`. Campanhas não vinculadas, inclusive Olivas, não ganham uma restrição nova por esse trigger.

O serviço faz um `UPDATE updated_at=updated_at` sob o lock da campanha antes de gravar o vínculo. Isso cria uma versão de linha que impede um escritor REPEATABLE READ com snapshot anterior de ignorar a nova tabela de vínculo. O readback rejeita mudança de qualquer valor semântico; um trigger nativo que atualize apenas `updated_at` é aceito, e a nova versão nativa é fixada no vínculo. Não há token de bypass. PGlite demonstra o toque de `xmin`; a prova isolada com PostgreSQL17.10 confirmou que a tentativa de agendamento em uma sessão REPEATABLE READ cujo snapshot antecede o vínculo falha com `40001`. Uma nova sessão READ COMMITTED vê o vínculo e é bloqueada pelo guard.

Essas guardas arbitram escritores de aplicação. Um dono/superusuário que desabilite triggers ou execute transporte fora desses caminhos não é uma fronteira coberta. Nenhuma role recebe grant na instalação candidata; admissão futura precisa revisar proprietário, EXECUTE/ACL, estado dos triggers e escritores reais.

## Atomicidade e autenticação

O host fornece transação exclusiva READ COMMITTED que só resolve após COMMIT confirmado; rollback e descarte em conexão incerta são obrigações explícitas do adaptador. É a mesma fronteira do store v2. Não usar o utilitário SQL compartilhado nem um pool em autocommit. A sessão deve ter `statement_timeout` efetivo positivo ≤30s; somente a própria transação recebe `lock_timeout=500ms` e search path fixo.

Autenticação longa/curta usa o helper Growth mais conferência de identidade única e expiração em `clock_timestamp()`. Vincular exige `draft` e `read_content`; ler/conferir exige `read_content`. Há reautenticação após espera e antes do resultado final. Campanha, suas dependências, catálogo e público ficam bloqueados nas leituras necessárias; catálogo/contexto e TTL são conferidos novamente antes de escrever e depois do recibo.

Vínculo, versão append-only, toque da campanha e recibo ficam na mesma transação. CAS cobre campanha, vínculo, revisão/hash do público e catálogo. Rejeições esperadas anteriores à escrita geram recibo durável. Qualquer erro posterior ao toque/gravação escapa e força rollback, sem converter uma falha parcial em rejeição confirmada. Chave de operação é `(ator,idempotency_key)` e prende payload inteiro/marca. Resposta incerta gera apenas consulta de operação; ausência do recibo não prova rollback nem autoriza retry automático.

## Validação e limites

Os testes locais compõem SQL/helper/provider/guard de campanhas existentes e o store v2 real sobre dados sintéticos. Cobrem Fish/Aristo, histórico e hashes, CAS, marca, head arquivado, catálogo alterado/vencido, credenciais longas/curtas revogadas/vencidas durante espera, rollback e ACK perdido. A chamada real ao provider legado de schedule é recusada para vínculo; o mesmo provider agenda campanha não vinculada, e a linha Olivas mantém seu comportamento anterior. Contatos e relações de listas não são escritos pelo serviço.

Os nove grupos PGlite incluem a divergência concreta `lista101 OU lista102`: a contagem sobre a base inclui o membro exclusivo da102, a campanha restrita à101 o excluiria, e o vínculo recusa essa restrição. O runner `tests/segment-campaign-binding-postgres.cjs` passou em cluster PostgreSQL17.10 privado e descartável, com três conexões retidas e pool: replay concorrente, CAS, os snapshots RR/RC acima, bloqueio do schedule legado nas duas marcas, recibo lido por conexão independente e revogação após espera por lock. O cluster foi parado ao final; nenhum serviço existente foi usado.

Permanece pendente a composição final do seletor count/batch com o mesmo predicado, sua ativação revisada, identidade/cobertura das fontes externas, CI futuro, instalação/readback e aceite operacional das duas marcas. Não ligar capacidade de UI nem interpretar `binding` como autorização de envio.

## Conferência integrada ao runtime

O host em `services/crm-audience` compõe os stores existentes com transação dedicada e contador nativo. O novo POST `campanha_publico_validar` aceita somente `brand`, `campaign_id`, `expected_campaign_version`, `expected_binding_version` e `expected_binding_hash`. Exige `validate` e `read_content`; reautoriza depois da consulta final de relógio. Consulta conteúdo e a revisão efetivamente vinculada, sem substituir por novo head do público. Arquivamento ou mudança nos pins usados bloqueia a conferência.

A resposta `validation` mantém referências do binding, `content`, `audience` (fonte confirmada/quantidade/motivo desconhecido), horários e todas as flags de envio/seleção falsas. Não grava recibo, não reserva destinatários nem permite schedule. O TTL máximo é 60 segundos, limitado também pela validade do catálogo. A UI expira a apresentação automaticamente e limpa a validação ao mudar o acesso/capacidade.

Os novos helpers SQL de leitura/lock e toque estão restritos às campanhas CRM de Fish/Aristo; o toque só alcança rascunhos email regulares ainda não iniciados. Isso evita conceder UPDATE direto em tabelas nativas ao serviço. Configuração/listas/modelo/mídia continuam estabilizados até a transação terminar. O guard de envio continua incondicional. O gate separado de novos vínculos nasce OFF mesmo quando gestão de públicos está ON.
