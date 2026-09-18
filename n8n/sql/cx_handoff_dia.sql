-- cx_handoff_dia (18/09): quantos tickets CHEGAM ao humano por marca × canal × dia de criação — o denominador da
-- capacidade do time (chegam/dia × resolutivos/dia = saldo da fila). Chega ao humano = transferido para time/agente
-- (escalado), ou com resposta pública de pessoa, ou com human_handoff_em. E-mail é 100% humano por definição (o Kai
-- não atende e-mail). Sem spam/teste. Olivas fica fora do saldo (base < 30).
CREATE OR REPLACE VIEW cx_handoff_dia AS
SELECT marca, canal, dia,
       count(*)::int AS tickets,
       count(*) FILTER (WHERE escalado OR coalesce(has_agent_reply, false) OR human_handoff_em IS NOT NULL OR canal = 'email')::int AS chegam_humano,
       count(*) FILTER (WHERE tags @> ARRAY['wismo']::text[] OR motivo = 'wismo')::int AS wismo,
       max(atualizado_em) AS coletado_em
FROM cx_ticket
WHERE NOT coalesce(spam, false) AND NOT coalesce(teste, false)
GROUP BY marca, canal, dia;
