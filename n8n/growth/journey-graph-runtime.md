# Persistência candidata do grafo — desativada

`journey_graph_store_v1` reutiliza o contrato puro `journey_graph_v1`. Guarda definições e catálogos imutáveis, publicação pausada, entradas deduplicadas, transições duráveis e **intenções de e-mail que não autorizam envio**. Só admite `cart.abandoned`, Fish/Aristo e bindings de e-mail. Não há instalação, rota pública, capacidade do painel, scheduler, consumidor, recibo de transporte ou alteração das jornadas existentes.

## Instalação e fronteira de confiança

`journey-graph-store.sql` é uma instalação exclusiva, transacional e de uso único. Qualquer schema `crm_graph_candidate` já existente é recusado, inclusive uma instalação anterior válida; não atualiza nem limpa objetos existentes. Execute o arquivo inteiro fora de outra transação. Após erro, faça rollback da sessão. As tabelas começam com controle global OFF e sem grants para PUBLIC; não há papel de aplicação instalado. FKs conferem marca/revisão publicada e marca da intenção. Revisões, intenções, transições e recibos não podem ser atualizados ou removidos pelos comandos do candidato.

`createGraphRuntime({pool,catalogFor,readSource,clock?})` é uma biblioteca **privada do servidor**, não um controller HTTP. Um futuro serviço deve autenticar, autorizar a marca/ação e fornecer `actor`; nunca repassar o body como identidade. `pool`, catálogo, fonte e relógio também não vêm do operador. O relógio padrão é PostgreSQL; a injeção existe para o ensaio determinístico. O pool deve implementar o contrato de `pg`: `release(error)` destrói a conexão. Se o rollback não for confirmado, o resultado é incerto e a conexão é descartada, impedindo um próximo borrower de confirmar estado parcial. O papel de instalação pode modificar o banco e não representa uma barreira contra um administrador malicioso.

## Comandos

Todos exigem `request_id` UUID durável, `actor` interno e `brand`. A mesma identidade e payload recuperam o recibo original; identidade reutilizada com payload/autoria/marca diferentes é recusada. O recibo é histórico, sempre `authorizes_send:false`.

| Método | Dados adicionais | Efeito |
|---|---|---|
| `create` | `definition` | ID gerado pelo banco; revisão 1 pausada |
| `save` | `journey_id`, `expected_version`, `definition` | Nova revisão; entradas antigas mantêm a versão anterior |
| `publish` | `journey_id`, `expected_version`, `confirm:'publicar'` | Confere catálogo atual; fixa revisão publicada e pausa |
| `pause` | `journey_id`, `expected_version`, `paused`, confirmação `pausar`/`retomar` | Retomar exige controle global ligado e revisão publicada |
| `enroll` | `journey_id`, `expected_version`, `source_ref` UUID opaco | Consulta fonte confiável; deduplica evento por jornada, mesmo após republicar |
| `step` | `entry_id`, `expected_version` | Calcula uma transição no servidor e grava estado/intenção/recibo na mesma transação |
| `due` | `brand`, `limit` entre 1 e 100 | Lista candidatos vencidos; não reserva nem executa |

Não existe comando público para ligar o controle global. A CI altera esse flag somente no banco descartável. `expected_version` e locks impedem que dois workers avancem a mesma revisão. Uma resposta perdida no COMMIT produz `GRAPH_OUTCOME_UNKNOWN`; a retomada usa **o mesmo request_id e payload**, nunca uma nova tentativa cega. Não há garantia de envio exatamente uma vez, pois não há transporte.

## Fonte ainda sintética

`readSource({source_ref,brand,trigger,now,query})` devolve exatamente:

```
{version:'journey_source_v1', source_ref, brand, trigger,
 event_id, subject_id, source_revision, occurred_at, observed_at,
 complete, eligible, consent, suppressed, facts}
```

`subject_id` é UUID interno. `source_revision` é a identidade **imutável do evento de carrinho**, não a revisão dos fatos atuais. Compra/consentimento/fatos podem mudar sem alterar essa identidade. Marca, evento, pessoa, revisão original e instante do evento entram no hash; divergência no mesmo evento é recusada. `observed_at` deve ser UTC com milissegundos, não futuro e no máximo cinco minutos antigo; `occurred_at` não pode ser posterior à observação. A fonte deve atestar elegibilidade atual do carrinho, consentimento e supressão, com prazo de consulta limitado pelo futuro integrador. O adapter não aceita facts/catálogo fornecidos no comando.

`facts` usa o formato do contrato puro (valor tipado, observação, completude). Compra ausente/incompleta/antiga não significa Não: mantém a espera e depois bloqueia no prazo original. A fonte precisa declarar inelegível um carrinho cuja compra posterior invalide a recuperação, inclusive entre condição e intenção; esta semântica só está provada por fixture. O candidato não prova a integração Shopify/CRM nem a origem dos consentimentos reais.

Evento bruto, nome, tags, destinatário e conteúdo não entram nas tabelas de execução/recibo. Armazenam-se referências opacas, hashes, revisão fixada, estado e binding. Os fatos consultados não são persistidos. Um futuro consumidor **precisa revalidar fonte, compra, opt-out, supressão e release** imediatamente antes de qualquer transporte: `waiting_message` apenas aguarda essa integração e não atualiza a fonte. Intenção não é aceite, envio ou entrega.

## Evidência e limites

Os testes locais PGlite cobrem migração exclusiva, integridade, revisão fixada, CAS, fonte divergente, três valores, prazo/retomada, opt-out, atomicidade, rollback e perda de resposta. A CI dedicada executa PostgreSQL 17.10 com sessões independentes, deduplicação concorrente, lock real antes da pausa/OFF, uma intenção e retomada após COMMIT cuja resposta se perdeu. Antes do resultado da CI, concorrência PostgreSQL real é uma prova pendente, não uma alegação concluída.

Os locks serializam todas as entradas da mesma jornada. São limites deliberados deste recorte, sem ensaio de capacidade: timeout de lock 3 s, statement 8 s, scan até 100, nenhum worker contínuo. Callbacks de fonte/catálogo devem ter prazo e cancelamento próprios antes de uso real; timeout SQL não limita promises externas. Permanecem necessários autorização/API, fonte real, scheduler/claim, consumidor/recibos, políticas de envio e editor integrado. O construtor completo continua **não entregue**.
