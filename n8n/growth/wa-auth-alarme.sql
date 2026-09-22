-- Alarme de falha de autenticação do WhatsApp. Aditivo; não toca nos monitores existentes.
--
-- POR QUE EXISTE: em 22/09 o token do WhatsApp foi invalidado às 09:48 (erro 190, subcódigo 460).
-- O monitor de saúde vigente tinha verificado às 09:09 e seguiu marcando `ok` nos quatro fluxos por
-- mais de meia hora, porque ele mede volume, não autenticação. Quem sinalizou foi o monitor de fluxo,
-- às 10:14, e ainda assim como `desconhecido` — "sem aceites observados" —, que é o mesmo rótulo de
-- um domingo parado. Erro 190 não é ausência de tráfego: é o transporte recusado na porta, e a
-- diferença entre as duas coisas é justamente o que precisa gritar.
--
-- O alarme é deliberadamente estreito: só falha de credencial, com janela curta e sem média móvel.
-- Uma única ocorrência já basta, porque 190 nunca é ruído estatístico.

CREATE OR REPLACE FUNCTION public.shrigma_wa_auth_alarme_v1(janela_min integer DEFAULT 15)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 WITH falhas AS (
   SELECT brand, channel, piece, sent_at, erro
   FROM public.shrigma_send_log
   WHERE sent_at >= now() - make_interval(mins => greatest(janela_min,1))
     AND erro ~ '^(190|401|403)[^0-9]'
 ), ultimo_ok AS (
   SELECT brand, max(sent_at) AS em
   FROM public.shrigma_send_log
   WHERE channel='whatsapp' AND wamid IS NOT NULL AND sent_at >= now() - interval '24 hours'
   GROUP BY brand
 )
 SELECT jsonb_build_object(
  'verificado_em', now(),
  'janela_min', greatest(janela_min,1),
  'estado', CASE WHEN EXISTS(SELECT 1 FROM falhas) THEN 'falha_auth' ELSE 'ok' END,
  'falhas', (SELECT count(*) FROM falhas),
  'pessoas', (SELECT count(DISTINCT piece) FROM falhas),
  'por_marca', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.brand),'[]') FROM (
     SELECT f.brand, count(*)::integer AS falhas, min(f.sent_at) AS primeira, max(f.sent_at) AS ultima,
            left(max(f.erro),80) AS exemplo, (SELECT em FROM ultimo_ok u WHERE u.brand=f.brand) AS ultimo_envio_ok
     FROM falhas f GROUP BY f.brand) x),
  -- marca que esteve enviando hoje e parou de ter sucesso: silêncio que não é feriado
  'sem_sucesso_recente', (SELECT coalesce(jsonb_agg(to_jsonb(y) ORDER BY y.brand),'[]') FROM (
     SELECT u.brand, u.em AS ultimo_envio_ok,
            round(extract(epoch FROM now()-u.em)/60)::integer AS minutos_sem_sucesso
     FROM ultimo_ok u WHERE u.em < now() - interval '30 minutes') y)
 )
$$;
REVOKE ALL ON FUNCTION public.shrigma_wa_auth_alarme_v1(integer) FROM PUBLIC;
