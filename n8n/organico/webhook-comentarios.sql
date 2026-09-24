-- Comentarios do webhook da Meta -> cx_social_comentarios.
--
-- O webhook YqTdndMpsqLUAJ3c grava todo evento em cx_social_evento (assinatura
-- conferida por HMAC), mas nada lia essa tabela. Esta funcao transforma os
-- eventos de comentario (IG "comments" e pagina FB "feed" com item=comment) em
-- linhas de cx_social_comentarios. Nao usa token nenhum: e o caminho que segue
-- funcionando para contas cujo ativo ainda nao foi atribuido ao usuario do
-- sistema (a varredura via Graph fica de fora delas).
--
-- Regras:
--  * So entra comentario de objeto conhecido (cx_social_objetos da a marca,
--    a conta e a origem organico/ads). Evento de objeto desconhecido fica
--    pendente por 7 dias, esperando o inventario conhecer o post.
--  * A varredura via Graph tem prioridade: insercao e ON CONFLICT DO NOTHING.
--  * Resposta (parent_id) nao vira linha: marca o pai como respondido e, se o
--    autor for a propria marca, como respondido_pela_marca (mesma regra da
--    varredura). Resposta cujo pai ainda nao existe fica pendente por 2 dias.
--  * remove -> apagado; hide/unhide -> oculto (vale o ultimo evento); edited ->
--    texto novo.
-- Reinstalar e seguro (CREATE OR REPLACE). Rodar de novo nao duplica nada.

CREATE OR REPLACE FUNCTION public.cx_social_ingere_eventos_v1(p_limite integer DEFAULT 3000)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_ids text[];
  v_ins integer := 0; v_rep integer := 0; v_del integer := 0; v_hid integer := 0; v_edit integer := 0; v_proc integer := 0;
BEGIN
  SELECT coalesce(array_agg(evento_id ORDER BY recebido_em), '{}') INTO v_ids FROM (
    SELECT evento_id, recebido_em FROM cx_social_evento
     WHERE processado IS NOT TRUE
       AND ((objeto = 'instagram' AND campo = 'comments')
         OR (objeto = 'page' AND campo = 'feed' AND bruto->'value'->>'item' = 'comment'))
     ORDER BY recebido_em
     LIMIT greatest(p_limite, 1)) s;
  IF cardinality(v_ids) = 0 THEN
    RETURN jsonb_build_object('eventos', 0);
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _cx_ev (
    evento_id text, rede text, cid text, post text, parent text, verb text,
    autor text, texto text, ts timestamptz, recebido_em timestamptz, da_marca boolean) ON COMMIT DROP;
  TRUNCATE _cx_ev;
  INSERT INTO _cx_ev
  SELECT e.evento_id,
         CASE e.objeto WHEN 'instagram' THEN 'instagram' ELSE 'facebook' END,
         CASE e.objeto WHEN 'instagram' THEN v->>'id' ELSE v->>'comment_id' END,
         CASE e.objeto WHEN 'instagram' THEN v->'media'->>'id' ELSE v->>'post_id' END,
         -- no feed da pagina, comentario de primeiro nivel tem parent_id = post_id
         CASE e.objeto WHEN 'instagram' THEN nullif(v->>'parent_id', '') ELSE nullif(nullif(v->>'parent_id', v->>'post_id'), '') END,
         CASE e.objeto WHEN 'instagram' THEN 'add' ELSE coalesce(v->>'verb', 'add') END,
         CASE e.objeto WHEN 'instagram' THEN v->'from'->>'username' ELSE v->'from'->>'name' END,
         btrim(coalesce(CASE e.objeto WHEN 'instagram' THEN v->>'text' ELSE v->>'message' END, '')),
         coalesce(e.ts, e.recebido_em),
         e.recebido_em,
         CASE e.objeto
           WHEN 'instagram' THEN lower(v->'from'->>'username') IN
             ('oaristocrata.br', 'oaristocratareserva', 'fishermans.com.br', 'fishermansreserva', 'olivasdocampo')
           ELSE v->'from'->>'id' IN
             ('749947324865075', '1079081791963057', '103860959414051', '525818034179813', '1280931611767111')
         END
    FROM cx_social_evento e, LATERAL (SELECT e.bruto->'value' AS v) x
   WHERE e.evento_id = ANY (v_ids);

  -- 1) comentario de primeiro nivel de cliente em objeto conhecido
  INSERT INTO cx_social_comentarios
    (id, marca, rede, conta, origem, post_id, ts, autor, texto,
     respondido, respondido_pela_marca, oculto, apagado, visto_em, coletado_em)
  SELECT DISTINCT ON (n.cid) n.cid, o.marca, n.rede, o.conta, o.origem, n.post, n.ts, coalesce(n.autor, ''), n.texto,
         false, false, false, false, now(), now()
    FROM _cx_ev n JOIN cx_social_objetos o ON o.obj_id = n.post
   WHERE n.verb = 'add' AND n.parent IS NULL AND NOT coalesce(n.da_marca, false) AND n.cid IS NOT NULL
   ORDER BY n.cid, n.ts
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_ins = ROW_COUNT;

  -- 2) respostas: marcam o pai
  UPDATE cx_social_comentarios c
     SET respondido = true,
         respondido_pela_marca = coalesce(c.respondido_pela_marca, false) OR r.da_marca,
         respondido_em = CASE WHEN r.da_marca THEN least(coalesce(c.respondido_em, r.ts_marca), r.ts_marca) ELSE c.respondido_em END,
         visto_em = now()
    FROM (SELECT parent, bool_or(coalesce(da_marca, false)) AS da_marca,
                 min(ts) FILTER (WHERE da_marca) AS ts_marca
            FROM _cx_ev WHERE verb = 'add' AND parent IS NOT NULL GROUP BY parent) r
   WHERE c.id = r.parent;
  GET DIAGNOSTICS v_rep = ROW_COUNT;

  -- 3) apagado / oculto / editado
  UPDATE cx_social_comentarios c SET apagado = true, visto_em = now()
   WHERE c.id IN (SELECT cid FROM _cx_ev WHERE verb = 'remove') AND c.apagado IS NOT TRUE;
  GET DIAGNOSTICS v_del = ROW_COUNT;

  UPDATE cx_social_comentarios c SET oculto = (u.verb = 'hide'), visto_em = now()
    FROM (SELECT DISTINCT ON (cid) cid, verb FROM _cx_ev WHERE verb IN ('hide', 'unhide') ORDER BY cid, ts DESC, recebido_em DESC) u
   WHERE c.id = u.cid;
  GET DIAGNOSTICS v_hid = ROW_COUNT;

  UPDATE cx_social_comentarios c SET texto = u.texto, sentimento = NULL, classificado_em = NULL, visto_em = now()
    FROM (SELECT DISTINCT ON (cid) cid, texto FROM _cx_ev WHERE verb = 'edited' AND texto <> '' ORDER BY cid, ts DESC, recebido_em DESC) u
   WHERE c.id = u.cid AND c.texto IS DISTINCT FROM u.texto;
  GET DIAGNOSTICS v_edit = ROW_COUNT;

  -- 4) processado, menos o que ainda pode casar mais tarde
  UPDATE cx_social_evento e SET processado = true
    FROM _cx_ev n
   WHERE e.evento_id = n.evento_id
     AND NOT (n.verb = 'add' AND n.parent IS NULL AND NOT coalesce(n.da_marca, false)
              AND NOT EXISTS (SELECT 1 FROM cx_social_objetos o WHERE o.obj_id = n.post)
              AND n.recebido_em > now() - interval '7 days')
     AND NOT (n.verb = 'add' AND n.parent IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM cx_social_comentarios c WHERE c.id = n.parent)
              AND n.recebido_em > now() - interval '2 days');
  GET DIAGNOSTICS v_proc = ROW_COUNT;

  RETURN jsonb_build_object('eventos', cardinality(v_ids), 'inseridos', v_ins, 'respostas', v_rep,
    'apagados', v_del, 'ocultos', v_hid, 'editados', v_edit, 'processados', v_proc);
END
$fn$;

COMMENT ON FUNCTION public.cx_social_ingere_eventos_v1(integer) IS
  'Webhook da Meta (cx_social_evento) -> cx_social_comentarios. Sem token. Chamado pelo workflow de comentarios a cada rodada.';
