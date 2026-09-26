# Prévia dos templates e públicos da marca — 26/09/2026

Escopo: somente o cliente CRM. Nenhuma alteração de workflow, banco, assinante ou envio.

- **CRM-24 · atrapalha:** catálogo e etapas das jornadas não ofereciam prévia direta do template selecionado. Agora consultam ID + marca + canal; e-mails com variáveis usam a prévia nativa já existente. Renderização isolada, com dados fictícios, links e mídia externa bloqueados. A seleção em rascunho é identificada. Não equivale a teste de campanha real, wrapper ou confirmação de remetente.
- **CRM-25 · atrapalha:** Público mostrava apenas regras de jornadas, omitindo os perfis e segmentações reais já disponíveis. Agora mostra perfil da base, relacionamento, próxima compra sugerida e jornadas, com busca, grupo e ordem por tamanho/nome. Cada contagem mantém sua data. Ausência, zero e dados antigos permanecem distintos; públicos sobrepostos não são somados nem tratados como destinatários elegíveis.
- **CRM-26 · cosmético:** identidade do Aristo fraca. Sidebar `#0C3C21`, fundo e cabeçalho `#F7F4EC`, textos e estados de navegação com contraste verificado.

## Evidência

Leitura autenticada de produção em 26/09: os 50 templates WhatsApp do inventário encontraram correspondência exata de ID/key/marca no catálogo. Listagens retornaram 54 WA e 17 e-mails Fish; 67 WA e 22 e-mails Aristo. A base já fornece contagens por perfil, RFM e próxima compra sugerida; nenhuma contagem foi criada no navegador. Respostas privadas preservadas fora do Git.

1.307 testes locais passaram, incluindo prévias nas duas marcas/canais, troca de marca/acesso durante a consulta, resposta ausente/ambígua, fechamento de modal, isolamento de links/pixels, filtros, desconhecidos e contraste. Build determinístico conferido.

Prévia no navegador com dados sintéticos nas duas marcas: busca/ordenação, troca de marca, catálogo e modais. Aceite autenticado do site publicado permanece separado: a aba de produção está na tela de chave, sem sessão. Não marcar estes novos itens encerrados até essa conferência.

## Publicação e retorno

Publicar via PR/CI, sem ativar A/B ou o novo construtor. Retorno: reverter esta PR e publicar o bundle anterior; não há migração nem mudança de dados para desfazer.
