-- cx_agente_dia (18/09): uma linha por marca × agente × dia do fechamento — a fonte da tabela "Por agente".
-- Só fechamentos por pessoa. Separa DESCARTE (fechou sem nenhuma mensagem humana: duplicado, spam, cliente sumiu —
-- 19% dos fechamentos humanos em set/26) de fechamento EFETIVO (≥ 1 mensagem humana). Maduro/resolutivo/voltou só
-- sobre efetivos, 7 dias corridos (55% dos retornos acontecem em 48 h, 80% só em ~106 h — 3 dias subcontaria um terço).
-- CSAT (rating do Gleap 2/6/10 = ruim/neutro/bom) do ticket que a pessoa fechou de forma efetiva — nunca média.
CREATE OR REPLACE VIEW cx_agente_dia AS
SELECT f.marca,
       f.fechado_por_id                                  AS agente_id,
       max(f.fechado_por_nome)                           AS agente_nome,
       f.fechado_dia                                     AS dia,
       count(*)::int                                     AS fechados,
       count(*) FILTER (WHERE f.msgs_humanas = 0)::int   AS descartes,
       count(*) FILTER (WHERE f.msgs_humanas > 0)::int   AS efetivos,
       count(*) FILTER (WHERE f.msgs_humanas > 0 AND f.fechado_em + interval '7 days' <= now())::int                          AS maduros,
       count(*) FILTER (WHERE f.msgs_humanas > 0 AND f.fechado_em + interval '7 days' <= now() AND f.voltou_em IS NULL)::int AS resolutivos,
       count(*) FILTER (WHERE f.msgs_humanas > 0 AND f.fechado_em + interval '7 days' <= now() AND f.voltou_em IS NOT NULL)::int AS voltaram,
       coalesce(sum(f.msgs_humanas) FILTER (WHERE f.msgs_humanas > 0), 0)::int AS msgs_humanas,
       coalesce(sum(f.msgs_cliente) FILTER (WHERE f.msgs_humanas > 0), 0)::int AS msgs_cliente,
       count(DISTINCT f.ticket_id) FILTER (WHERE f.msgs_humanas > 0 AND t.rating IS NOT NULL)::int AS csat_avaliados,
       count(DISTINCT f.ticket_id) FILTER (WHERE f.msgs_humanas > 0 AND t.rating = 10)::int        AS csat_bom,
       count(DISTINCT f.ticket_id) FILTER (WHERE f.msgs_humanas > 0 AND t.rating = 2)::int         AS csat_ruim,
       max(f.checado_em)                                 AS coletado_em
FROM cx_fechamento f
LEFT JOIN cx_ticket t ON t.ticket_id = f.ticket_id
WHERE f.fechado_por_tipo = 'pessoa' AND f.fechado_por_id IS NOT NULL
GROUP BY f.marca, f.fechado_por_id, f.fechado_dia;
