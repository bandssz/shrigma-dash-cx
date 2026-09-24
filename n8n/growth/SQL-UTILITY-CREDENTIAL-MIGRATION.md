# SQL util: migração para credencial do n8n

Estado em 24/09/2026: candidato local testado; **não publicado e chave não rotacionada**.

O utilitário `ygVyBPjJqGqt2V5E` compara `body.k` com uma chave literal no nó
`Chave confere?`. O Growth depende dele para manutenção do banco. A varredura
atual também encontrou a mesma chave no efeito protegido do TikTok
`LCODPC1y6kRPQ6hI` e na sonda inativa `oAg0Fv8K4XY6EylL`. O handoff de CX
informa que o dev recebeu esse acesso. Revogá-lo isoladamente quebraria esses
consumidores; nenhuma alteração foi feita em CX ou TikTok.

`sql-utility-credential-patch.cjs` prepara a substituição por `headerAuth`,
usando uma referência à credencial criptografada do n8n. O patch preserva
caminho, POST, query, argumentos nativos e credencial PostgreSQL; remove a
comparação com a chave literal e desliga retenção dos payloads de execução.
Recusa versão desatualizada, rascunho não publicado, mudança de topologia e
qualquer consumidor ainda pendente. Não publica, não ativa workflow e não
gera credencial sozinho.

## Sequência de troca

1. Reexportar o workflow e conferir `versionId === activeVersionId` e todos
   os consumidores. Incluir scripts privados e o acesso do dev de CX.
2. Criar uma credencial `httpHeaderAuth` de manutenção, com chave nova
   aleatória, armazenada somente no cofre n8n e nos arquivos privados
   operacionais. Nunca inserir o valor no repositório ou relatório.
3. Preparar uma janela coordenada, com consumidores de manutenção sem
   chamadas em voo, para trocar servidor e clientes juntos. Alternativamente,
   preparar clientes compatíveis que enviem temporariamente `body.k` antigo
   e o novo cabeçalho; nesse caso primeiro desabilitar a retenção de payloads
   do utilitário e dos consumidores para não gravar a chave nova no histórico.
   **Não remover `k` antes de trocar o servidor.** O efeito TikTok exige revisão própria; essa troca
   não pode habilitar aprovação manual, alterar suas portas, recibos ou
   reservas. O fluxo permanece bloqueado conforme decisão do usuário.
4. Confirmar com o dev de CX, por intermédio do Felipe, que seu cliente está
   preparado para a troca. Só então marcar as dependências como concluídas e aplicar o
   patch sobre a revisão fresca. Uma lista de booleans é um bloqueio do
   instalador, não evidência de migração: anexar os recibos reais.
5. Conferir por leitura a credencial e a topologia publicadas. Provar recusa
   sem cabeçalho, com chave antiga, com chave errada e com a chave antiga
   apenas no corpo; provar `SELECT 1` e parâmetro nativo com a chave nova.
6. Conferir consumidores reais sem disparos, amostras ou clientes de teste.
   Remover `body.k` e a chave antiga dos clientes compatíveis somente após
   provar que o servidor publicado autentica pelo cabeçalho novo.
   Aposentar a sonda inativa somente dentro da autorização de seu responsável.

Não há manutenção de uma porta legada sem autenticação para facilitar a
troca. Tampouco se presume que revogar o acesso global seja compatível com
o trabalho de CX.

Referência: [autenticação de Webhook no n8n](https://docs.n8n.io/integrations/builtin/credentials/webhook).
O webhook nativo aceita Basic, Header e JWT; `body.k` não é autenticação
nativa por credencial.

Validação local: teste sintético cobre migração incompleta, revisão velha,
topologia divergente, segredo residual e preservação dos parâmetros. O
candidato também foi conferido contra o formato exportado em 24/09, sem
publicação. A prova HTTP após a troca permanece pendente.
