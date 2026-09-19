# Orgânico: projeção Shopify por pedido/modelo

`attribution.sql` cria três views e uma função novas. Não substitui views v2 existentes, ingestão, coletor, de-para, legado `crm_conversao` ou API viva. Aplicação e integração ao payload exigem revisão do runtime atual; este arquivo não é um instalador automático.

## Fonte e contrato

A fonte exclusiva é o ledger Shopify v2. Elegibilidade financeira, receita líquida BRL, dia de compra em Brasília e janela de toque de 30 dias são herdados do contrato existente. O vínculo Appmax–Shopify não é substituído. Cancelados, testes, moeda incompatível e reembolso integral são excluídos pelo classificador v2; reembolso parcial conserva o pagamento líquido.

- `crm_organico_attribution_order_v2`: uma linha por marca/pedido/modelo conhecido, incluindo categoria de conciliação para modelo conhecido sem toque. Uso restrito ao servidor.
- `crm_organico_attribution_daily_v2`: dia, marca, modelo, classificação/regra, rede, superfície e cinco UTMs. Não junta posts/stories nem cria fan-out.
- `crm_organico_attribution_quality_v2`: reutiliza qualidade do ledger e expõe flags de sessão conhecida/desconhecida, separadamente das linhas de UTM para não multiplicar denominadores.
- `crm_organico_attribution_payload_v2(ini, fim)`: objeto para a propriedade `organico_attribution` da API. Intervalo inclusivo por dia de compra, validado; não concede autorização por marca/painel.

Contrato da função:

```text
schema_version: 1
rule_version: organico-utm-20260919-v1
default_model: last_click
window_days: 30
source_system: shopify
currency: BRL
utm_raw_available: false
assistance_available: false
piece_identity_available: false
janela: {ini, fim}
gerado_em: horário de consulta, não horário de coleta
daily: [
  marca, dia, model, source_system, currency,
  classification, rule_version, rule_reason, rede, superficie,
  detail_level,
  utm_source, utm_medium, utm_campaign, utm_content, utm_term,
  utm_raw_available, utm_provenance, piece_status,
  pedidos, receita_liquida, leitura_mais_antiga, coletado_em
]
quality: [
  marca, dia, pedidos_lidos, pagos_elegiveis,
  jornada_pendente, jornada_parcial, receita_elegivel,
  ultima_sessao_conhecida, ultima_sessao_desconhecida,
  origem_nao_direta_desconhecida, leitura_mais_antiga, coletado_em
]
coverage: [marca, dia, checked_at]
```

`model` é `last_click` ou `last_non_direct`. São alternativas: selecionar um antes de somar. `daily` inclui outros canais para conciliar a base conhecida; somente `editorial`, `bio` e `automacao_dm` são recortes identificados da frente, sempre separados. O payload não contém IDs individuais de pedido.

O payload conserva detalhes UTM das classes `editorial`, `bio`, `automacao_dm` e `legado_ambiguo`, com `detail_level=utm`. Mídia paga, CRM e não classificado são resumidos por dia/marca/modelo/classe, com `detail_level=channel_summary`, motivo `resumo_diario_canal`, UTMs/rede/superfície nulos, `utm_provenance=channel_summary` e `piece_status=nao_aplicavel_resumo`. Esses nulos indicam detalhe deliberadamente não transmitido, não ausência na fonte. Os totais continuam exatos e as views retêm todo o detalhe para auditoria. A tabela de UTMs deve filtrar `detail_level=utm`; a conciliação inclui ambos os níveis, sem somar modelos.

`payload-function.sql` contém exatamente a definição da função presente no SQL completo. Após instalar os objetos, usar esse arquivo para substituir apenas a função, preservando as três views e os dados. O teste prova igualdade dos totais por dia/marca/modelo/classe e igualdade de todos os detalhes UTM transmitidos com a view integral, além da identidade entre os dois trechos de função.

## Regras v1

| Evidência | Classificação | Superfície / limite |
|---|---|---|
| `instagram_social/story` | `editorial` | story; controle fornecido, sem prova de peça exata ou incremento causal |
| `instagram_social/linktree` | `bio` | Instagram/bio; nenhuma inferência de post |
| `instagram_social/dm`, `instagram/dm`, `instagram/dm-automation` | `automacao_dm` | dm; aliases documentados preservados |
| Instagram/Linktree/IG/IGShopping/Facebook + `social` | `legado_ambiguo` | sem crédito editorial presumido; paid anterior não é recuperado pelo vencedor |
| Medium explicitamente paid/cpc/ppc/cpm/paid_social/paid-social/paid_search/display/ads ou source explícito de Ads | `midia_paga` | precede regras sociais; fora de editorial |
| `winner.channel=email/whatsapp` | `crm` | preserva origem; não duplica receita CRM |
| Outras combinações ou toque sem UTMs | `nao_classificado` | motivo explícito, sem adivinhar canal |
| Modelo conhecido com winner nulo | `nao_classificado` | `modelo_conhecido_sem_toque`; não declarar desconhecido nem inferir direto |

Winner nulo é esperado em `last_non_direct` quando a jornada está completa e não há toque não direto. Flags `strict_known=false` e `non_direct_known=false` não produzem crédito diário. População sem cobertura também não produz crédito: a view existente exige cobertura do dia. Qualidade/cobertura permanecem visíveis sem inventar porcentagem de completude global.

As UTMs são preservadas exatamente como estão no ledger. O coletor anterior já normaliza capitalização/espaços, portanto não há UTMs brutas originais para recuperação retroativa. A normalização para comparar regras não reescreve os valores retornados.

## Limites e integração

A projeção não calcula assistências. `touches` v2 conserva apenas canais CRM, insuficiente para assistência Orgânico. Assistências legadas são comparação identificada, nunca somadas aos vencedores v2. `piece_identity_available=false` evita prometer post/story identificado pelo nome de campanha ou pela bio.

GMV nativo TikTok, cupom/creator e assistências não são parcelas aditivas desta projeção Shopify. TikTok→Shopify por UTM não é pedido nativo TikTok Shop.

O serviço deve conservar autenticação, recorte de painel/marca e versão do workflow. Antes de integrar, exportar a versão viva, instalar somente objetos novos, incluir o campo na lane Orgânico e comparar marca/modelo com P04/P06. Função SQL instalada não comprova API ou UI integradas.

`api-patch.cjs` contém o patch puro da API compartilhada: `patchWorkflow(exportAtual)` devolve `{workflow,changes}` sem I/O e sem modificar o objeto recebido. Acrescenta `organico_attribution` por **concatenação final de um novo `jsonb_build_object`**, antes de `AS payload`, e à whitelist exclusivamente Orgânico. Não acrescentar pares à chamada central: PostgreSQL limita cada `json[b]_build_object` a 100 argumentos/50 pares. A chamada da projeção só acontece nos escopos `organico`/`todos`, com janela inclusiva BRT hoje−399 até hoje.

O patch é idempotente e recusa campo preexistente fora do fragmento reconhecido, alias não único ou whitelist ambígua. `patchWorkflow(exportAtual,{remove:true})` remove somente seu fragmento e prefixo da whitelist, preservando alterações posteriores de outras frentes; layout rearranjado exige revisão. Usar sempre um GET fresco, revisar o diff, publicar somente a revisão atual e conferir readback. O gerador não exporta credenciais nem contém snapshot de produção; exports brutos permanecem privados.

Teste isolado: `tests/organico-attribution-postgres.cjs`; PGlite por `ORGANICO_PGLITE_MODULE` ou `CAMPAIGN_PGLITE_MODULE`. Usa definições reais de tabelas/views do repo e o classificador financeiro existente. Cobre norma nova, legado ambíguo, paid/CRM, modelos alternativos, reembolso/cancelamento, janela, cobertura ausente, mesma ID em duas marcas, valores armazenados, instalação repetida e ausência de fan-out. Inclui regressão do limite real: 50 pares executam; 51 dentro da mesma chamada falham; concatenação do novo objeto retorna 51 campos preservando os 50 originais; escopo falso não chama a função. `tests/organico-api-patch.test.cjs` confere idempotência, reversão e preservação das demais partes do workflow. Sem credenciais, clientes ou transporte.
