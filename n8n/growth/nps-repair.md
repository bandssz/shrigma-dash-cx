# NPS: transporte e voto durável

Correção de 16/09/2026, nas duas marcas ativas.

- `nps-runtime.js` transforma o lembrete em processamento de um contato por vez,
  com intervalo de um segundo, preservando agenda, limite e guardas de elegibilidade.
- `nps-transport-evidence.sql` registra a resposta do transporte em uma transação
  anterior à finalização. Resultado incerto não libera outra reserva.
- `nps-native.sql` prepara o link assinado sem task runner e grava o voto com lock
  do contato, preservando outros atributos e comentários. A configuração de assinatura
  é provisionada privadamente a partir do workflow existente, sem trocar o segredo.
- A resposta ao cliente precede a sincronização ClickUp. Cada voto novo/alterado gera
  um registro durável de sincronização. `nps-vote-sync.js` realiza somente a integração
  externa; a finalização SQL anexa apenas o ID da tarefa, sem substituir a nota.
- Repetição da mesma nota não cria novo job. Alterações respeitam a janela existente
  de sete dias. Um job em andamento ou incerto bloqueia efeitos concorrentes para o
  contato; falhas não provocam repetição automática da criação de tarefas.

## Operação

O caminho de voto é: webhook → PostgreSQL (validar/salvar) → resposta HTTP →
PostgreSQL (claim do job) → ClickUp → PostgreSQL (resultado do job).

`pending`, `in_flight` antigo e `outcome_unknown` em `shrigma_nps_vote_sync` exigem
conciliação operacional. A nota já está salva mesmo quando essa integração falha.
Não há worker automático de repetição nem alerta novo no dashboard para essa tabela.
Não zerar estados para testar: verificar tarefa externa e eventos antes de retomar.

A exceção `LISTMONK_QUEUE_BUSY` aceita somente o erro exato `message push timed out`
com HTTP 500 e contrato NPS de um destinatário. No Listmonk v6.1.0 esse retorno ocorre
antes da entrada na fila interna. Outros erros 500/timeout continuam incertos.
Referências: [PushMessage](https://github.com/knadh/listmonk/blob/v6.1.0/internal/manager/manager.go)
e [envio transacional](https://github.com/knadh/listmonk/blob/v6.1.0/cmd/tx.go).
Logs agregados não bastam para reclassificar uma mensagem histórica individual.

## Validação

Testes Node cobrem encadeamento, serialização e efeitos incertos no ClickUp.
`tests/sql/nps-native.sql` deve rodar dentro de transação revertida, após provisionar
configuração de teste. Testes operacionais privados também compararam os payloads do
signatário JavaScript anterior e executaram o fluxo nativo com transporte simulado.

Não publicar credenciais, snapshots integrais do n8n, configuração privada, respostas
de clientes ou evidências com destinatários no repositório.
