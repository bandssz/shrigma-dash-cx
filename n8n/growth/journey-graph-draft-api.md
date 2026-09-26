# Ponte candidata de rascunhos — OFF

`journey_graph_draft_api_v1` é um handler privado, sem endpoint instalado ou capacidade anunciada. Reutiliza a persistência `crm_graph_candidate`, sem alterar seu schema. Só lê catálogo/rascunhos/recibos e cria/salva rascunhos. Não expõe publicar, pausar, ativar, participantes, execução, fonte ou transporte.

`createDraftApi({pool,catalogFor}).handle({method,authorization,request})` retorna `{status,headers,body}`. O host futuro deve extrair **um único** header Authorization Bearer, limitar corpo/tempo/conexões e encaminhar somente esses três campos; não aceitar token em query/body. Aqui não há servidor HTTP, CORS, rate limit, logs nem rota n8n.

## Autoria e permissões existentes

Em cada operação, o handler consulta `public.shrigma_panel_operator_v1(token,'growth')`. Usa somente `who` e as permissões **já existentes** `read_content` (leitura) e `draft` (criar/salvar). Não usa o fallback de chave legada `shrigma_crm_operator_auth_v1`. Chave revogada/expirada/inativa ou permissão removida é recusada. O autor nunca vem do body.

O formato Bearer de 8–128 caracteres coincide com a variante vigente de `n8n/access/panel-short-keys.sql`: `chave_hash` e `chave_hash_curta` resolvem o mesmo principal, permissões e recibos. A API não compara hashes nem autentica localmente. As provas extraem somente a função `shrigma_panel_operator_v1` desse arquivo, sem instalar as demais autenticações, e também preservam cobertura da variante longa anterior.

Esse helper concede acesso por **área Growth**, não possui ACL por marca ou por autor da jornada. O candidato não inventa tal ACL: gestores autorizados podem colaborar nos rascunhos Fish/Aristo; toda consulta e escrita exige uma dessas marcas e confere a marca da definição/referência. Os recibos de operação, por sua vez, só são consultados pelo autor original e na marca original. Olivas/todas não são admitidas.

Escritas fazem consulta preliminar e reautorizam dentro da transação, após adquirir o lock da identidade da operação e antes de ler um replay ou alterar dados. O gancho `beforeCommand` é uma dependência confiável opcional do runtime, nunca um campo aceito do operador. Uma operação já autorizada em andamento não é uma promessa de cancelamento imediato após revogação posterior; todas as novas consultas/tentativas são rechecadas.

## Requests privados

Todos possuem `action` e `brand`; campos adicionais são exatos. `request_id` é UUID durável da operação. A integração futura deverá criá-lo/conservá-lo no journal antes de enviar e manter o mesmo payload até conciliar; não é um ID de jornada. O banco gera `journey_id`.

| Método/ação | Campos adicionais | Resultado |
|---|---|---|
| GET `catalog` | nenhum | Catálogo atual injetado, sem inventar disponibilidade |
| GET `list` | `after` UUID ou null, `limit` 1–50 | Resumos da marca e cursor; paginação não congela alterações concorrentes |
| GET `get` | `journey_id` | `server` e `definition` da mesma leitura de revisão; catálogo atual separado |
| GET `operation` | `request_id` | Recibo histórico do autor/marca ou estado não confirmado |
| POST `create` | `request_id`, `definition` | Rascunho pausado; ID/revisão emitidos pelo banco |
| POST `save` | `request_id`, `journey_id`, `expected_version`, `definition` | Nova revisão imutável com CAS; não publica nem ativa |

`actor`, `caps`, `catalog`, identidade de execução, ativação e propriedades extras são recusados. UUIDs de requests/referências são normalizados para minúsculas. Todas as respostas têm `Cache-Control:no-store`, `authorizes_publish:false` e `authorizes_send:false`. Não retornam token, label/autor da sessão, SQL ou erros brutos do provedor.

## Idempotência e resposta perdida

Criar/salvar usam o ledger existente. Mesmo autor/marca/UUID/payload recupera o recibo original; conteúdo ou autor divergente depois de confirmação gera conflito. `expected_version` impede sobreposição de edições. O recibo é histórico: uma consulta posterior pode mostrar um head mais novo e não altera o recibo da tentativa anterior.

COMMIT sem resposta retorna HTTP 202 `state:'unconfirmed'`, `request_id` e `retry_same_request_only:true`. GET `operation` verifica o ledger; quando não encontra resultado, tenta o advisory lock sem bloquear e confere de novo se o obtiver. Ausência continua **não confirmada**, nunca vira prova de falha nem permissão para uma identidade nova. Esse candidato não implementa o journal do cliente; a futura integração deve conservar o rascunho e impedir recriação/reenvio cego.

Não se persiste uma reserva de toda solicitação rejeitada antes de commit. Portanto, após resultado incerto, cabe ao journal conservar o payload exato; a API não promete provar o conteúdo de uma transação que nunca se confirmou. Nenhum efeito externo existe neste recorte.

## Evidência e integração restante

Fixtures PGlite instalam o helper gestor **inalterado** sobre credenciais/linhas sintéticas e o schema isolado. Cobrem caps, token legado, revogação/expiração, reautorização, autoria, duas marcas, CAS, replay, recibo perdido/histórico, catálogo sem fonte, paginação e erros sanitizados. A CI usa um segundo banco descartável PostgreSQL 17.10 para concorrência e revogação enquanto o request aguarda lock; é prova pendente até concluir essa nova revisão da CI. Nenhuma tabela/função de autenticação ou produção foi editada.

O candidato incorporou a main `33dda889` por merge local, sem conflito de assets. Permanecem necessários endpoint/instalação, catálogo e fontes reais, cliente com journal/retomada, publicação pausada e revisão operacional, scheduler, consumidor único com revalidação de compra/opt-out/consentimento/release e recibo de transporte, além da replicação validada entre marcas. O editor isolado e esta API de rascunho não constituem o construtor operacional completo.

Estimativa técnica preliminar **após esta ponte** para o mínimo carrinho + e-mail — criar/salvar/publicar pausado/simular/ativar com guardas e recibo/replicar Fish↔Aristo: **8–16 horas** de implementação e validação ativa, condicionadas a fontes e releases verificáveis e autorização para implantação/piloto. Faixa para integração cliente/API/journal, fonte+catálogo, ciclo operacional/consumidor e testes/aceite; não é promessa de calendário. Outros gatilhos e WhatsApp estão fora dessa estimativa e exigem inventário/contratos próprios.
