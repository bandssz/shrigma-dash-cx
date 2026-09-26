# Teste de template com destinatário escolhido — v2

**Candidato; não instalado por estes arquivos.** Contrato `crm_email_test_recipient_v2`, política SQL inicialmente OFF. Este recorte atende **templates de e-mail já publicados e validados** de Fish/Aristo. Não implementa teste de campanha em rascunho, “Salvar e testar” nem disparo para uma lista. Conteúdo local não salvo ou revisão ainda não publicada não é elegível.

## Contrato e guardas

O operador usa o acesso de gestor CRM existente, via Bearer. A entrada exige autenticação estrita do painel Growth e `draft`, `validate`, `submit`; o SQL reconfirma a permissão atual. Chaves legadas de templates não habilitam v2. A capability anunciada é `templates.email_test_recipient = 'crm_email_test_recipient_v2'`; a política do servidor continua sendo a autoridade.

- Um endereço normalizado; sem nome de exibição, lista, CC ou BCC. São permitidos os domínios exatos `oaristocrata.com`, `fishermans.com.br`, `shrigma.com.br` ou um testador externo habilitado **para aquela marca** no servidor. O gestor pode cadastrar/revogar; alterações são auditadas. Limite atual: 50 cadastros por marca, validade renovada por 30 dias. Uma revogação explícita também bloqueia endereço interno.
- Destinatário ambíguo, globalmente bloqueado/desativado ou descadastrado em lista da marca é recusado. Não cria nem altera assinante ou vínculo. Sem expressões de assinante, `/tx` usa `external` (identidade efêmera no Listmonk). Com `.Subscriber.*`, exige identidade existente e usa `default`; não inventa nome/UUID.
- Prévia nativa de até cinco minutos, ligada a ator, destinatário, identidade/revisão, publicação, conteúdo, remetente/Reply-To e dados de exemplo. O prefixo final é `[TESTE] `, fixado pelo servidor. A resposta inclui marca, ID/revisão, assunto final, remetente, Reply-To, destinatário e `template_id`. Aqui esse ID é o template transacional publicado, não um wrapper de campanha.
- Confirmação `enviar_teste` e UUID v4 identificam a tentativa. Há uma reserva por **rascunho + revisão + destinatário**, até cinco por revisão e vinte por ator na última hora; reservas incertas também consomem limite. O histórico v1 entra no cálculo v2 e impede repetir a tentativa legada de Felipe.
- Claim, reserva de cota e registro do dispatch são atômicos, sob travas de operação/ator/revisão. Antes do claim são reconferidos permissão, estado do destinatário, allowlist, revisão e conteúdo. Mudança invalida a prévia. A comparação também exige que a renderização nativa corresponda à prévia selada.

Apenas um `/api/tx` sucede o claim confirmado. HTTP sem resposta ou resposta não confirmada produz `outcome_unknown`; não há retry automático. `missing` no recibo não prova que nada ocorreu e não libera outra identidade. A consulta de operação é somente leitura. `http_accepted` não significa entregue: eventos SES conciliados são apresentados separadamente. Dispatches têm `is_test=true` e etiqueta `crm_test=true`; não devem entrar em conversão, CTR/CTOR ou resultados comerciais.

## Rotas aditivas

| Método / ação | Finalidade |
| --- | --- |
| GET `email_teste_capacidades_v2` | Política atual e limites |
| GET `email_teste_testadores_v2` | Cadastros da marca |
| POST `email_teste_testador_v2` | Habilitar/revogar testador com auditoria |
| POST `email_teste_previa_v2` | Preparar e selar prévia, sem envio |
| POST `email_teste_v2` | Confirmar a tentativa exata |
| GET `email_teste_operacao_v2` | Recibo pelo UUID do mesmo ator |

O endereço digitado vai no corpo, nunca na URL. A entrada recusa campos extras; SQL parametrizado recebe os valores. A resposta pública não expõe o snapshot interno. Registros de allowlist/recibos contêm endereços necessários à operação e exigem o controle de acesso existente; não devem ir para logs, commits ou evidência pública.

## Implantação e rollback

1. Revisar SQL aditivo, dependências, grants e backup; aplicar `email-test-recipient.sql` com política OFF. Reaplicação preserva configuração, revogações e recibos. Não apagar tabelas/histórico para “reiniciar” uma tentativa.
2. Gerar o patch puro sobre export fresco, conferindo versão e hashes dos nós. Instalar rotas e o **wrapper de claim legado** antes de habilitar v2. Manter retenção de payload desativada, timeouts, redirects e retries bloqueados. O patch reutiliza credenciais existentes; não grava segredos no código.
3. Só após backend/cliente/provas coerentes, habilitar a política e anunciar a capability. A função de habilitação recusa claims v1 ainda em voo; não contornar essa recusa. Alteração no anúncio compartilhado deve ficar restrita à capability Growth.
4. Para recuar, desativar a política e retirar o anúncio v2, **preservando o wrapper, SQL e recibos**. Revisão com qualquer dispatch v2 permanece bloqueada no caminho v1, inclusive accepted, unknown e claimed, independentemente do destinatário. Consultas antigas continuam disponíveis. Reverter o workflow para antes do wrapper reabriria a brecha e não é rollback seguro.

Durante OFF, outras revisões ainda seguem a política legada v1; não anunciar para elas as cotas novas de vinte/hora. Desativar não cancela um `/tx` já reservado e não torna uma tentativa incerta reenviável. A API nativa seleciona o template por ID: alteração externa posterior ao claim/cache continua sendo limite do transporte existente, não uma garantia de conteúdo congelado até a entrega.

## Evidência e limites

`tests/email-test-recipient.test.cjs` cobre elegibilidade, quotas, uma tentativa por identidade, recibos, migração preservadora e regressão OFF→v1 sem segundo dispatch. Os testes de protocolo/workflow cobrem campos exatos, destino, prévia, ausência de retry e alteração restrita dos nós. O runner `email-test-recipient-concurrency-postgres.cjs` é exclusivamente para PostgreSQL 17 descartável em loopback e cobre locks, quotas e revogação durante espera; sua existência não é evidência de execução ou CI verde.

Essas provas usam dados sintéticos e não enviam e-mails. Não equivalem a instalação, aceite em produção ou autorização para executar um teste real. O contrato de campanhas continua pendente de uma implementação própria e da prova do caminho nativo escolhido.
