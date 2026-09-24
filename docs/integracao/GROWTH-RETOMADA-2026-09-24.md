# Growth — retomada e estado verificado em 24/09/2026

Base conferida: main `aafa7e8`. Esta entrega prioriza Growth. Não houve
alteração na aba CX, nos 35 workflows exclusivos, em tabelas exclusivas de
CX, no login, nos caches compartilhados ou no webhook de entrada WhatsApp.
Orgânico, Influs/TikTok e as duas ações explicitamente bloqueadas continuam
sem intervenção. A coleta de parceiros abaixo é a dependência de dados
Shopify solicitada dentro das pendências de Growth; a interface de Influs
não foi editada.

**Growth ainda não está encerrado.** A tabela distingue publicação de prova
com dados reais e descreve o trabalho que falta.

| Frente | Entregue e verificado | Falta para encerrar |
|---|---|---|
| Silêncio WhatsApp | Bug de descarte do t24 corrigido e publicado nos dois carrinhos às 19h38. Versão ativa e diff conferidos. Consulta real do seletor respondeu corretamente; testes de horário e guardas passaram. | Observar agendamento real na próxima janela 08h–12h; não houve envio forçado. |
| Holdout | Candidato de 5%, conforme preferência por poucos, persistente e com ambos os braços registrados. Preserva e-mails. Regenerado após a correção do silêncio. | Fonte de pedidos pagos com identidade compatível com a coorte, inclusive sem UTM; janela madura e datas do protocolo; validação de concorrência e ativação. Continua desabilitado e não publicado. |
| Shopify financeiro | Migração aditiva e coletor `RAJ2HxVhJFfpTpqO` publicados, ativo às 06h27 BRT. Paginação, reembolsos, revisão da origem e fila testados. HTTP recusa chave ausente/errada; chamada autenticada concluiu lote vazio. | Provar escopos/leitura Shopify e paginação no runtime, rodada agendada e primeiro snapshot de parceiro legítimo. Há zero links/pedidos de parceiros agora. `commission_payable=false`. |
| OpenAI | Inventário por ID da credencial e impacto apurados. Três workflows ativos fora do conjunto exclusivo de CX; nenhum disparo CRM com dependência direta encontrada. Cinco falhas recentes 429/insufficient_quota confirmadas no categorizador SharePoint. | Regularizar cota ou decidir provedor na frente responsável. Não houve compra de crédito, troca de modelo ou alteração desses workflows. |
| Segredos | SQL util mapeado e candidato de migração para credencial n8n revisado/testado; nova coleta usa só referências de cofre. | Rotacionar SQL após troca coordenada dos consumidores TikTok, ferramentas privadas e acesso do dev de CX. Segredos de outras frentes aguardam a prioridade delas. Nenhuma chave viva foi revogada. |
| n8n / 20h | Lote transacional 20h03–20h11 identificado e produtor SharePoint volumoso medido. Serviço saudável na amostra anterior ao pico. Plano PostgreSQL documentado. | Logs/métricas de host durante o pico para concluir causa-raiz e ensaiar a migração. Não foi pedido reinício preventivo nem alterada infraestrutura compartilhada. |
| Env privado | Removidas cinco entradas mortas do arquivo operacional desta tarefa; backup privado e igualdade dos demais valores conferidos. | Pacotes históricos permanecem preservados; não são arquivos operacionais limpos. |

## Evidência de qualidade

- **979 testes de regressão passaram**, sem falhas ou testes pulados.
- Dependências locais: PGlite 0.3.14 e Linkedom 0.18.12, mesmas versões do CI.
  A execução precisa apontar `NODE_PATH`, `CAMPAIGN_PGLITE_MODULE` e
  `ORGANICO_PGLITE_MODULE` para a instalação local; ausência da dependência
  não deve ser confundida com falha de regra de negócio.
- Bundle do runtime de campanhas e arquivos distribuídos dos painéis
  conferidos, sem mudanças nos bundles.
- Revisão independente do silêncio, da coleta/SQL e da migração de
  credencial. Correções de regressão/escopo incorporadas antes de publicar.
- Exports e backups frescos privados antes das escritas; readback ativo e
  igualdade de funções/nós após publicar. Nenhum export privado foi enviado
  ao repositório público.

## Leituras detalhadas

- [Correção publicada do silêncio](../../n8n/growth/whatsapp-cart-silence.README.md)
- [Holdout preparado, ainda desabilitado](../../n8n/growth/whatsapp-cart-holdout.README.md)
- [Coleta financeira e provas pendentes](../../n8n/creators/PARTNER-BASE.md)
- [Credenciais, limpeza do env e impacto OpenAI](GROWTH-CREDENCIAIS-2026-09-24.md)
- [Migração do SQL util sem revogação prematura](../../n8n/growth/SQL-UTILITY-CREDENTIAL-MIGRATION.md)
- [Investigação n8n e plano PostgreSQL](GROWTH-N8N-INCIDENTE-2026-09-24.md)

As próximas mudanças permanecem em Growth. Não usar estas pendências para
autorizar ações TikTok/comentários recusadas, alterar CX ou modificar uma
peça compartilhada sem dependência demonstrada e preservação de CX.
