# Growth: reconciliar a fila com o estado da campanha

CRM-22: a coleta ignorava `draft` e fazia apenas UPSERT. Uma campanha que voltava a
rascunho continuava no snapshot como `agendada`, mesmo com cache recente. O relógio do
painel rotulava a antiga data como atrasada. Isso não comprovava fila real.

O patch puro `campaign-snapshot-queue-patch.cjs` altera somente a consulta do nó
`1 · crm_campanha`, no coletor `RvXBh2GKPX91VfRx`. Exige versão exata do export, a mesma
versão publicada no coletor ativo e SHA da consulta conferida; rejeita fonte diferente
ou reaplicação. Não faz rede ou deploy.
O coletor não pertence ao inventário exclusivo de CX. Nenhum outro nó, credencial,
conexão, agenda, configuração, tabela nativa ou objeto de atribuição muda.

## Comportamento

- Apenas snapshots **Fish/Aristo, e-mail, ainda sem envios** são reconciliados.
- `scheduled` com data, sem início/envios, fica `agendada` com a data nativa atual.
- `draft`, `paused` e `cancelled` sem início/envios ficam `rascunho`, `pausada` e
  `cancelada`, fora da fila e dos resultados de envio. Linhas não são apagadas.
- Nativo ausente, marca incompatível, agenda sem data ou estado que não permita
  confirmar a fila fica `indisponivel`: não conta como agendada nem como métrica zero.
  O painel mostra a quantidade sem estado confirmado, separada das agendas.
- Identidade de marca usa **a mesma expressão** do coletor, inclusive o fallback de
  listas. Ela é extraída da consulta conferida, sem nova inferência por nome.
- Datas históricas são preservadas ao sair da fila. Contagens, UTMs, linhas de receita
  e campanhas nativas não são removidas nem alteradas pela reconciliação.
- Snapshots pendentes não ficam presos ao congelamento de métricas após sete dias:
  um reagendamento ou início real volta a ser coletado normalmente. Histórico enviado
  congelado mantém a regra anterior.

O UPSERT existente e a reconciliação são um único comando `DO` atômico. Isso evita
resultados separados de `BEGIN/INSERT/UPDATE/COMMIT` virarem múltiplos itens no n8n.
O bloco não cria função permanente, tabela ou extensão. Uma falha reverte ambos.
A consulta continua sendo snapshot da coleta; não garante estado ao vivo após ela.
Qualquer ação de campanha continua exigindo as guardas do provedor atual.

## Prova e aplicação

`tests/campaign-snapshot-queue.test.cjs` executa o SQL completo sobre banco isolado:
transições, exclusão nativa, incompatibilidade de marca, fallback de listas,
reagendamento/início depois do congelamento, histórico, atribuição, escopo e rollback.
A fixture `campaign-snapshot-before-crm22.sql` preserva a consulta original sem
credenciais. Os testes do frontend conferem a distinção entre fila, indisponibilidade
sem zero fabricado e resultados, com marca/canal e A/B preservados.

Aplicar somente após PR/CI e revisão: export fresco e backup; construir com a versão
lida; comparar que só aquele parâmetro mudou; publicar o coletor preservando agenda e
configurações; aguardar sua próxima rodada normal e o cache normal. Não enviar,
agendar, disparar coleta por fora ou atualizar cache compartilhado para provar o fix.
No painel, confirmar Aristo sem a agenda fantasma e Fish com suas agendas válidas.
A leitura do banco deve conservar IDs, linhas históricas e nativos intactos.

Rollback do código do coletor usa o export anterior após conferir versão atual. Os
novos estados do snapshot são fatos coletados; não restaurar automaticamente a falsa
agenda. Manter o frontend compatível ou suspender a exibição de fila se um rollback
precisar interromper a confirmação da fonte. Nenhuma recuperação apaga histórico.
