# Orgânico: coletores Meta

Os seis workflows "CX — Social · …" alimentam `cx_social_story`, `cx_social_post`, `cx_social_conta_dia`, `cx_social_objetos` e `cx_social_comentarios`. Desde 24/09/2026, toda chamada à Graph sai de um nó HTTP autenticado pela credencial do n8n **"Meta WA — token permanente (Bearer)"**. Essa credencial pertence ao usuário do sistema *App Fishermans*, no BM Fishermans. Nenhum coletor lê token do banco (`crm_credencial`) nem traz token no código.

## Por que mudou

Em 22/09, a troca de senha invalidou o token de usuário (`190/460`) que os coletores liam de `crm_credencial.meta_token` ou traziam escrito no código. Stories, posts, conta, inventário e comentários pararam juntos. Story perdido não volta, porque a API só entrega as últimas 24h. O token de usuário do sistema não expira com troca de senha.

## Credencial por chamada

| Chamada | Credencial |
|---|---|
| IG: stories, insights, perfil, série diária, mídia, comentários | Meta WA — token permanente (Bearer) |
| FB: posts e comentários de página | token **de página** obtido na mesma execução via `/me/accounts` (a Graph recusa o do usuário do sistema com `190/2069032` e `#210`). Ele só existe em memória: inventário e comentários rodam com `saveDataSuccessExecution`/`saveDataErrorExecution = none`. |
| Contas de anúncio e criativos ativos | "Meta Aristocrata" e "Meta Fishermans" (usuários do sistema de anúncios de cada BM) e a credencial acima. A marca vem de `creative.instagram_user_id` (IG) ou da página do `effective_object_story_id` (FB), nunca do nome da conta de anúncio. |

As credenciais de anúncio usam autenticação por query. Por isso o `paging.next` delas traz o token, e o inventário também não salva dados de execução.

## Saúde por conta

`cx_social_coleta_saude(coletor, conta)` recebe uma linha por coletor e conta a cada rodada, com `ok`, `detalhe`, `verificado_em` e `ultimo_ok_em`. Uma conta sem acesso não derruba as outras. O workflow só falha quando nenhuma conta responde. A varredura de comentários pula as contas que o inventário marcou sem acesso. O sentimento registra `coletor='sentimento'`. Se o LLM falhar (ex.: 429), nenhum comentário é marcado como `indefinido`: eles continuam na fila.

O monitor de credenciais (diário) grava em `crm_credencial` apenas linhas de estado, com `segredo` nulo:

- `meta_sistema_fishermans`: usuário do sistema e permissões concedidas;
- `meta_ativos_organico`: contas e páginas ainda sem acesso;
- `openai_sentimento`: estado do LLM do sentimento.

O antigo `meta_token` fica `origem='aposentado'`. O painel lê tudo isso por `crm_credencial_saude`.

## Cobertura em 24/09/2026

- Com acesso: @fishermans.com.br (tudo), @fishermansreserva (mídia, stories e comentários; a série de seguidores retorna `#10`) e a página Fishermans.
- Anúncios ativos: Aristocrata e Fishermans, pelas credenciais de anúncio.
- Sem acesso (`#100/33`): @oaristocrata.br, @oaristocratareserva, @olivasdocampo e as páginas O Aristocrata, O Aristocrata br, Linhas Fishermans e Olivas do Campo.
- Ação para liberar: compartilhar esses ativos do BM de origem com o BM Fishermans e atribuí-los ao usuário do sistema *App Fishermans* com controle total. Nenhuma mudança de código é necessária: a mesma credencial passa a alcançá-los na rodada seguinte.

## Comentários pelo webhook (candidato, não instalado)

O webhook da Meta já grava todo evento em `cx_social_evento`, incluindo os comentários das contas sem acesso via Graph, mas nada lia essa tabela. `webhook-comentarios.sql` define `cx_social_ingere_eventos_v1()`, que faz quatro coisas:

- insere comentários de primeiro nível em objetos conhecidos (`ON CONFLICT DO NOTHING`: a varredura tem prioridade);
- marca como respondidos, pela marca ou por cliente, os pais das respostas;
- aplica remove/hide/unhide/edited;
- deixa pendente o que ainda pode casar (post desconhecido por 7 dias, resposta sem pai por 2 dias).

Não usa token. A função ainda **não foi instalada nem ligada** ao workflow de comentários: isso depende de aprovação. Teste: `tests/organico-webhook-comentarios-postgres.cjs` (PGlite, eventos sintéticos).

## Prévia dos posts (26/09/2026)

O Post a post mostra a miniatura de cada peça. Ela vem de um workflow próprio do Orgânico, **"Orgânico — Prévia dos posts (diário 05:55, Instagram)"**, gerado por `previa-posts.cjs`:

- **Leitura:** lê todas as peças orgânicas do Instagram em `cx_social_objetos` (até 600) e pede à Graph `media_type,media_url,thumbnail_url`. Usa a mesma credencial "Meta WA — token permanente (Bearer)" e não guarda os dados de execução bem-sucedida.
- **Imagem gravada:**
  - vídeo e reels: a capa (`thumbnail_url`);
  - imagem e carrossel: `media_url`;
  - só é aceita URL https da CDN da Meta (`cdninstagram.com`, `fbcdn.net`).
- **Tabela:** `cx_social_post_midia`, uma linha por post. Quando a Meta dá erro, a linha vira `ok=false` e a URL anterior é mantida, mas não é renovada.
- **Painel:** o cache de 10 min (`Orgânico — API cache`) anexa `cx_post_midia` ao payload. O nó é `Prévias dos posts`, com `alwaysOutputData` ligado; se falhar, o cache sai sem prévia. Só entra URL verificada nas últimas 72 h, porque a URL da CDN expira.
- **Quando não há prévia** (leitura ao vivo sem cache, URL expirada ou post removido): a célula mostra "sem prévia" e o link para o post.

O coletor de posts, a API de leitura do CX e `cx_social_coleta_saude` não foram alterados.

**Sentimento:** o sentimento dos comentários (coluna "Negativos" e "comentários negativos" no KPI de quedas) saiu da tela até o `openai_sentimento` funcionar. Ele segue parado pelo 429 da OpenAI. A coleta e a fila de comentários não mudaram.
