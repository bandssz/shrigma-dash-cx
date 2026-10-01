# Migração do dashboard · semana de 05 a 09/10/2026

Horário de referência: America/Sao_Paulo. Este é o plano de trabalho para colocar CRM, Orgânico, Influs & Afiliados e o gerencial no Easypanel. A passagem de tráfego real continua condicionada à aprovação explícita do titular e às provas abaixo; não é disparada por este documento ou pelo DNS.

## Ponto de partida em 01/10

- `gerencial`, `crm`, `organico` e `influs` já têm registros A na Hostinger apontando para `31.97.247.19` (TTL 14.400 s). Sem mappings reais no Easypanel, os quatro nomes responderam 404 no teste de rota.
- A PR [#198](https://github.com/bandssz/shrigma-dash-cx/pull/198) usa branch e worktree exclusivos e incorporou o `main` até o PR #206 (`fd7bb4deab26c252663b156fdcc8c194539eb01d`). O checkout original do Mac e a hospedagem Pages não foram alterados.
- O canário `dashboard-image-20260930/web-access-v8` usa a imagem imutável `ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:007e823d0c181e56c6191ac838e44e6426f32e1b9b58adb7558a2a055bb87511`, pacote SHA-256 `2ddef84a871710f2f87aad648646985463d1a064f8bd19190458f1153abd992d`, volume exclusivo `dashboard-access-identity-20261001-v8`, 0,5 CPU/512 MiB, reserva de 0,1 CPU/128 MiB, uma réplica e `capDrop=ALL`. Está em modo sintético sem upstreams, jobs, workers ou escrita comercial. Os quatro hosts `dashboard-v8-{gerencial,crm,organico,influs}.tazdb8.easypanel.host` responderam `/healthz` 200 com HTTPS válido; login anônimo não recebeu sessão. Não confundir saúde com homologação funcional.
- A conta gerencial corporativa foi vinculada somente ao canário v8. A senha e o TOTP serão escolhidos pelo titular no link de bootstrap guardado em arquivo privado local, fora do Git e do chat. O ensaio v8 ainda não comprova login gerencial no navegador após essa ativação.
- A aba Gestores registra e-mail corporativo, painel único, convite de uso único e nível desejado. “Edição geral do painel” permanece pedido pendente; a permissão efetiva é leitura. Nenhuma credencial do serviço de origem é criada automaticamente por esse cadastro.

## Sequência da semana

| Janela | Entrega e prova exigida |
| --- | --- |
| Segunda, 05/10 | Titular ativa senha própria e TOTP no canário v8. Testar cadastro, três convites, login por painel, negativa de acesso cruzado, revogação e persistência após restart. Definir destino externo versionado do backup da identidade e ensaiar restauração em volume separado. |
| Terça, 06/10 | Criar instalação candidata **separada** para leituras reais, com outro volume e chaves individuais recebidas por canal seguro. Conferir identidade, área, capacidades e revogação diretamente em cada backend antes de armazenar chave. Não usar a chave legada `todos`; manter `organico-links` desligado enquanto não houver credencial realmente só de leitura na origem. Comparar dados e navegação de CRM, Orgânico e Influs com a hospedagem atual, inclusive mídia, templates e diagnóstico. |
| Quarta, 07/10 | Corrigir diferenças encontradas; validar em desktop e celular. Homologar operações de edição apenas em dados/integrações de teste, com CSRF, Origin, recibos e idempotência. Auditar o limite de login por IP confiável na borda sem afetar outros serviços; concluir o plano coordenado de rotação das credenciais existentes. Registrar PRs posteriores ao #206, rebuild e novo digest se houver mudanças públicas. |
| Quinta, 08/10, após expediente | Revisar evidências com o titular. **Somente com aprovação explícita do corte**, criar os mappings HTTPS de `gerencial`, `crm`, `organico` e `influs`, verificar certificado, host correto, login, permissões e leituras por nome real. Distribuir convites individuais por canal seguro; manter Pages e serviços atuais ativos. |
| Sexta, 09/10 | Acompanhar o uso do time, erros de login, leituras, ações e disponibilidade. Fazer rollback imediato do roteamento se houver perda de acesso, dados incorretos ou operação indevida. Documentar revisão, digest, volume, backup e resultado final. |

As datas são metas, não autorização automática. Se faltar qualquer prova crítica na quinta-feira, manter o canário e marcar outro horário de corte.

## Critérios de liberação e reversão

Exigir: conta do titular ativada; convites e permissões por área comprovados; credenciais individuais verificadas na origem; paridade das telas e integrações de leitura; funções de escrita homologadas antes de conceder edição; backup externo versionado com restauração ensaiada; limite de login na borda; avaliação e rotação coordenada das credenciais expostas anteriormente; checklist de DNS, TLS e serviços existentes sem regressão. O [plano de corte](DASHBOARD-OPERACIONAL-CORTE-20261001.md) detalha cada prova.

Em falha após o corte, retirar apenas os mappings novos no Easypanel e orientar o time a usar os endereços antigos do GitHub Pages, que permanecem publicados. `crm.shrigma.com.br` voltará a 404 sem seu mapping; não é o endereço da hospedagem antiga. Os novos registros DNS podem permanecer enquanto a rota estiver ausente, ou ser revertidos conforme a decisão de operação, respeitando o TTL de quatro horas. Preservar o volume e os logs da instalação nova para análise. Nenhum rollback de frontend desfaz uma ação comercial já executada.
