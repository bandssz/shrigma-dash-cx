# Assets e interface dos painéis

CX/CS, CRM, Orgânico e Influs & Afiliados têm entradas próprias. Creators e Afiliados TikTok continuam como abas do mesmo painel. As entradas independentes não mostram outras áreas. A navegação entre áreas pertence somente ao portal mestre autenticado; período, ações e definições financeiras continuam pertencendo à área. Veja `PANEL-SECURITY.md`.

## Alterar e distribuir

Os módulos JavaScript na raiz continuam sendo os fontes. CSS comum: `styles.css`; superfície visual comum: `panel-ui.css`; estilos específicos antes embutidos no HTML: `*-page.css`. Os scripts inline dos HTML permanecem nos mesmos documentos. Nunca editar manualmente `assets/panels/`.

O manifesto `tools/panel-build/manifest.json` preserva a ordem dos scripts clássicos e dos estilos de cada página. Não há conversão para módulos, renomeação de identificadores globais ou nova configuração de acesso. O empacotador usa o esbuild já fixado pelo build do runtime de campanhas; não acrescenta dependência de navegador nem CDN.

```sh
npm ci --prefix tools/campaign-runtime-build --ignore-scripts --no-audit --no-fund
node tools/panel-build/build.cjs
node tools/panel-build/build.cjs --check
```

Versionar os fontes, os quatro HTML de conteúdo, as cinco entradas por área/mestre e todos os arquivos gerados juntos. Cada HTML referencia o hash do conteúdo no endereço do asset; a verificação de CI recusa artefatos desatualizados. Os testes de renderização executam os scripts referenciados pelo HTML, portanto também exercitam os bundles distribuídos. Reverter uma entrega exige reverter o conjunto e publicar pela mesma revisão.

## Medir

```sh
node tools/panel-build/measure.cjs <commit-anterior>
```

A medida soma o HTML e o CSS/JS local, com gzip nível 9 por resposta e cache frio. Não inclui payloads de APIs, imagens, respostas de fontes nem reaproveitamento de cache ao alternar áreas; não representa latência de produção. A rodada inicial comparou com `8462a1e697e946895e392bc7c7df93ea25f3cc0d`. Cada área passa a uma requisição CSS e uma JS; a interface usa a fonte do sistema e elimina a chamada ao Google Fonts que carregava quatro famílias.

Há duplicação de pequenos módulos compartilhados nos bundles por área: a escolha favorece entrada independente e menos requisições. Não alegar ganho no cache quente entre áreas. Extração adicional de módulos só deve ocorrer com medição e testes das dependências globais.

## Aceite de interface

Conferir todas as abas em desktop, tablet e celular, inclusive tabelas largas, gráficos, estados de erro e acesso. Navegação pode rolar horizontalmente dentro da própria faixa; a página não deve transbordar. Alertas de cobertura, indisponibilidade e desconhecido continuam visíveis. Foco de teclado, salto para conteúdo, movimento reduzido e distinção textual dos estados devem ser preservados. A revisão visual não comprova envio, pagamento, gravação de campanhas ou execução livre de grafos.

### Resultado da primeira revisão

| Painel | Antes (gzip, bytes) | Depois (gzip, bytes) | Redução | CSS + JS, antes → depois |
|---|---:|---:|---:|---:|
| CX/CS | 99222 | 71386 | 28.1% | 10 → 2 |
| CRM | 199334 | 157449 | 21% | 38 → 2 |
| Orgânico | 38444 | 30779 | 19.9% | 8 → 2 |
| Influs & Afiliados | 77256 | 64677 | 16.3% | 8 → 2 |
