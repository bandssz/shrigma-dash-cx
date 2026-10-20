# Qualidade visual e HTML

## Reaproveitar a marca certa

`assets/base-aristocrata.html` preserva a base Aristo fornecida: paleta, componentes, VML, mobile e rodapé. Preencher todos os `__PLACEHOLDER__`. Confirmar razão social/CNPJ, contato, políticas e oferta da marca; não copiar isso para Fishermans. Para Fish, partir do template aprovado existente, não inventar identidade visual.

O formato de componentes é o padrão editorial relatado. Cada dispositivo deve esclarecer a oferta em poucos segundos. Variação criativa é recomendação, não bloqueio técnico nem prova universal de entregabilidade. Exemplos históricos: comparação de custo, barra de duração, ficha do produto, prova social, etapas de uso, kit e prazo real.

## Estrutura adaptável

Preheader; identificação da marca; título/argumento; visual ou fatos relevantes; prova social quando verificável; CTA com destino claro; apoio/condição; assinatura; P.S. quando útil; dados legais e descadastro. A quantidade de blocos segue o objetivo. Evitar excesso de texto e densidade visual.

## Compatibilidade

Tabelas de apresentação, estilos essenciais inline, largura de referência 600px e mobile fluido. CTA com alternativa VML quando precisar de Outlook desktop. UTF-8 é válido; não exigir conversão de todos os acentos em entidades. Sem scripts/formulários; validar imagens, espaços, contraste, links e texto alternativo.

Todo elemento que controla cor precisa de revisão em modo escuro. `@media (prefers-color-scheme: dark)` e seletores `data-ogsc`/`data-ogsb` são técnicas úteis, com suporte variável entre clientes. Não afirmar que toda versão do Gmail respeita a media query. Cobertura de classe no CSS não certifica o resultado visual.

O checker remove comentários CSS e lê múltiplos style/media blocks. Classes puramente estruturais podem ser isentas; `email-bg`, `card` e `cta-a` carregam cor e não devem ser isentas. Ele aponta classes sem cobertura para revisão, e não transforma uma heurística em prova de inbox.

Fonte de suporte testado: [Can I email — prefers-color-scheme](https://www.caniemail.com/features/css-at-media-prefers-color-scheme/).

## Tracking de campanha e preview

Esta seção e o checker tratam do corpo + wrapper de **campanha `crm-campaign-v1`**. Não impõem marcadores a templates gerenciados: **Criar templates** e o teste de template têm validação própria de expressão/contexto. HTML válido pode conter Go legado que não é aceito para rascunho novo ou teste fictício — preservar o conteúdo e os vínculos existentes; ver `crm.md`.

Um `TrackView` no HTML final, somando wrapper e body. **Decisão vigente (15/09/2026): o pixel mora no wrapper e a peça sai sem ele.** O template 1 observado historicamente injetava o pixel depois do `</html>` em toda campanha que o usa — a base Aristo foi ajustada para não duplicar. O modo de falha dessa escolha é wrapper sem pixel (zero abertura medida), e ele é capturado pelo pré-voo: `--template` dá erro quando a soma não é exatamente 1, inclusive quando é 0. Por isso **pré-voo sem `--template` não autoriza agendamento**, e o conteúdo do template real se confere por GET a cada campanha. Reverter é uma linha: devolver o marcador antes do `</body>` da peça e usar wrapper sem pixel — nunca editando um template compartilhado por conta própria. Branches e expressões dinâmicas ainda exigem preview renderizado.

O template 1 do Listmonk é `{{ template "content" . }}` seguido do marcador de pixel, sem `<html>`/`<body>` próprios — nesse formato o pré-voo com `--template` aprova. Se o checker acusar `PIXEL_OUTSIDE_BODY`, o problema é o wrapper (pixel depois do `</body>` de um documento completo), não a peça: leve para quem mantém o template.

Função `TrackLink` ou shorthand nos destinos comerciais, incluindo VML. `utm_content` por posição, com URL igual na alternativa VML/anchor do mesmo botão. Os marcadores devem ser renderizados pelo Listmonk; não considerar a fonte crua como HTML final.

Rodar pré-voo estático e inspecionar preview desktop/mobile. Se houver caminho/autorização de teste real, conferir a mensagem nos clientes relevantes e os headers conforme `teste-controlado.md`; se não houver, declarar a limitação sem bloquear a entrega dos artefatos locais. Um teste local ou teste de template não prova entrega de campanha.
