# Rastreamento e atribuição — convenção comum

## Identidade

| Campo | Regra |
|---|---|
| `brand` | `fish` ou `aristo`; manter o emissor/audiência explícitos em exceções cross-brand. |
| `initiative.key` | Família comercial da edição, por marca. Consultar o mapa existente antes de criar. |
| `utm_source` | `listmonk` em campanha comercial deste emissor. |
| `utm_medium` | `campanha`; não renomear retroativamente para `email`. |
| `utm_campaign` | Alias estável registrado da iniciativa. Não adivinhar só a partir do nome. |
| `utm_content` | Peça + posição: `abertura-hero`, `abertura-cta1`, `abertura-ps`, `abertura-texto`. |
| `utm_term` | Identidade real do disparo/base: `lm-987-l123` ou `lm-987-l123-124`. Depende do ID da campanha no CRM: a peça sai sem ele (pré-voo `--modelo`) e ele é conferido na campanha antes de agendar. |
| Variante | Preservar termo anterior como `a--lm-987-l123`; guardar o experimento também nos metadados. |

IDs do exemplo são fictícios. **Nunca substituir o ID real por um contador inventado.** Listas positivas, únicas e ordenadas deixam a identidade determinística. Copiar uma campanha exige novo ID e revisão de seus identificadores. O preparador remove sufixos antigos `lm-ID-lLISTAS` antes de aplicar o novo; preserva somente o rótulo anterior de variante/segmento. Assim, `a--lm-100-l10` vira `a--lm-200-l20`, sem acumular identidades. Reutilizar a mesma UTM em dois disparos torna a receita individual ambígua; não repartir por regra de três.

## Links e duplicações legítimas

- Aplicar no HTML e no texto; preparar o destino interno de `/discount/CUPOM?redirect=...`, preservando oferta, `variant`, cupom e navegação.
- Manter UTMs dentro da URL que chega à loja, não só no link intermediário do emissor.
- Usar função `{{ TrackLink "https://..." }}` ou sufixo `@TrackLink` conforme renderização validada. O preparador preserva os dois formatos.
- CTA normal e sua alternativa VML representam a **mesma posição** e podem compartilhar `utm_content`/URL. Dois destinos diferentes na mesma posição exigem identificadores diferentes. Repetir exatamente a mesma URL em posições diferentes não é detectável apenas pelo destino: o autor deve nomear as posições.
- Não adicionar UTM a descadastro, políticas, mailto, tel ou assets. Links comerciais de terceiros exigem revisão do destino/redirect e cobertura; o preparador automático cobre somente as lojas das marcas e rotas comerciais reconhecidas.
- Os valores genéricos `link`, `alt-link`, `cupom-auto` mantêm compatibilidade do helper anterior; **novas peças devem receber nomes de posição**. Fallback genérico não equivale a granularidade por posição.
- Não colocar e-mail, telefone, nome, CPF ou identificador de assinante em UTM.

## Histórico e mapeamento

Em 15/09 existem famílias como `semana-do-cliente-2026`, `desodorante-frescor` e `fish-copo`. Consulte quais aliases estão efetivamente associados à marca antes de reutilizá-los. Não rebatizar o histórico ou inventar vínculo entre edições parecidas. A view atual também usa tags legadas; metadados `attribs.crm` sozinhos **não** atualizam o agrupamento.

O cadastro deve verificar colisão do conjunto completo **marca + canal + source + medium + campaign + content + term**, vínculo da iniciativa e período do disparo. A chave antiga `(campaign, content, term)` não basta para cruzar marcas/canais. Sem prova exclusiva, mostrar “compartilhado” ou “sem identificação”.

## Efeito na medição

UTM identifica o toque; não prova que ele causou a compra. O relatório precisa de pedido, janela, sequência temporal, pagamento/reembolso, modelo e cobertura. Last click e last non-direct permanecem separados, com janela de 30 dias no Growth atual. Assistências não se somam à receita final; uma compra tem um único vencedor por modelo. A soma dos disparos com prova individual não pode exceder o total da iniciativa no mesmo recorte.

Links removidos, ausência de clique e jornadas indisponíveis ainda causam perda de identificação. Não prometer rastreamento de 100% das compras.

## Consulta de UTMs no painel

O CRM mostra as UTMs de campanhas e etapas de automação em leitura. Desconhecido não é ausência: sem regra comprovada, não derive `source`, campanha ou conteúdo do nome da marca, canal ou etapa. Variável no link (ex.: `{{ .Tx.Data.order_url }}`) não tem destino certificado. Botão PIX nativo não é link com UTM.
