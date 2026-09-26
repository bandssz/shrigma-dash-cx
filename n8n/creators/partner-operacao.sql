-- Parceiros do site: regras decididas pelo Felipe em 26/09/2026 e o que falta para operar.
-- Aplicar DEPOIS de pilot.sql, partner-link.sql e partner-commission-base.sql. Idempotente.
--
-- 1. Programa: link do Aristo em oaristocrata.com; link e cupom no mesmo pedido comissionam os dois;
--    7% aceito (comissão pagável); pagamento no dia 5 do mês seguinte (já estava).
-- 2. Link só conta pedido de dia em que esteve ativo. Pausado ou revogado deixa de receber crédito;
--    o histórico de estados fica em crm_partner_link_evento_v1 (gatilho), não em updated_at.
-- 3. Fechamento por competência (mês do pedido): comissão, se está fechada, e o prazo de pagamento.
-- 4. Cadastro de pagamento (titular, CPF, Pix) dentro do painel. A leitura só devolve dado mascarado;
--    o número completo só é escrito, nunca lido de volta pela tela.
-- Pagamento em si (marcar pago, comprovante) continua fora do painel: payout_active=false.

-- ---------------------------------------------------------------- 1. programa
ALTER TABLE public.crm_partner_program_v1 ADD COLUMN IF NOT EXISTS link_cupom text NOT NULL DEFAULT 'ambos';
ALTER TABLE public.crm_partner_program_v1 ADD COLUMN IF NOT EXISTS commission_payable boolean NOT NULL DEFAULT false;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='crm_partner_program_link_cupom_ck') THEN
  ALTER TABLE public.crm_partner_program_v1 ADD CONSTRAINT crm_partner_program_link_cupom_ck CHECK(link_cupom IN ('ambos','link','cupom'));
 END IF;
END $$;
UPDATE public.crm_partner_program_v1 SET link_base='https://oaristocrata.com/',version=version+1,updated_at=now()
 WHERE marca='aristo' AND link_base IS DISTINCT FROM 'https://oaristocrata.com/';
UPDATE public.crm_partner_program_v1 SET commission_payable=true,link_cupom='ambos',version=version+1,updated_at=now()
 WHERE rate=0.07 AND payment_day=5 AND (NOT commission_payable OR link_cupom<>'ambos');

-- Colunas que a base de comissão ganhou em produção (partner_ref, detalhes_completos). No-op onde já existem.
ALTER TABLE public.crm_partner_commission_base_v1 ADD COLUMN IF NOT EXISTS detalhes_completos boolean NOT NULL DEFAULT false;
ALTER TABLE public.crm_partner_commission_base_v1 ADD COLUMN IF NOT EXISTS partner_ref text;

-- ---------------------------------------------------------------- 2. estados do link no tempo
CREATE TABLE IF NOT EXISTS public.crm_partner_link_evento_v1(
 id bigserial PRIMARY KEY,
 ref text NOT NULL,
 state text NOT NULL CHECK(state IN ('pausado','ativo','revogado')),
 em timestamptz NOT NULL DEFAULT now(),
 actor text
);
CREATE INDEX IF NOT EXISTS crm_partner_link_evento_ref_v1 ON public.crm_partner_link_evento_v1(ref,em);
REVOKE ALL ON public.crm_partner_link_evento_v1 FROM PUBLIC;
-- links anteriores ao gatilho: um evento com o estado atual na data de criação (aproximação declarada)
INSERT INTO public.crm_partner_link_evento_v1(ref,state,em,actor)
 SELECT l.ref,l.state,l.created_at,'backfill-26-09' FROM public.crm_partner_link_v1 l
 WHERE NOT EXISTS(SELECT 1 FROM public.crm_partner_link_evento_v1 e WHERE e.ref=l.ref);

CREATE OR REPLACE FUNCTION public.crm_partner_link_evento_trg_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state THEN
  INSERT INTO public.crm_partner_link_evento_v1(ref,state,em,actor) VALUES(NEW.ref,NEW.state,now(),NEW.actor);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS crm_partner_link_evento_v1 ON public.crm_partner_link_v1;
CREATE TRIGGER crm_partner_link_evento_v1 AFTER INSERT OR UPDATE OF state ON public.crm_partner_link_v1
 FOR EACH ROW EXECUTE FUNCTION public.crm_partner_link_evento_trg_v1();

-- Link esteve ativo em algum momento do dia (Brasília)? Pedido de dia inteiro pausado/revogado não conta.
CREATE OR REPLACE FUNCTION public.crm_partner_link_ativo_no_dia_v1(r text,d date) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce((SELECT e.state='ativo' FROM public.crm_partner_link_evento_v1 e
    WHERE e.ref=r AND e.em<(d::timestamp AT TIME ZONE 'America/Sao_Paulo') ORDER BY e.em DESC,e.id DESC LIMIT 1),false)
  OR EXISTS(SELECT 1 FROM public.crm_partner_link_evento_v1 e WHERE e.ref=r AND e.state='ativo'
    AND e.em>=(d::timestamp AT TIME ZONE 'America/Sao_Paulo') AND e.em<((d+1)::timestamp AT TIME ZONE 'America/Sao_Paulo'))
$$;

-- ---------------------------------------------------------------- 4. cadastro de pagamento
CREATE TABLE IF NOT EXISTS public.crm_partner_payment_v1(
 candidate_id uuid PRIMARY KEY REFERENCES public.crm_partner_candidate_v1(id),
 marca text NOT NULL,
 titular text NOT NULL,
 cpf text NOT NULL CHECK(cpf ~ '^[0-9]{11}$'),
 pix_tipo text NOT NULL CHECK(pix_tipo IN ('cpf','cnpj','email','telefone','aleatoria')),
 pix_chave text NOT NULL,
 version integer NOT NULL DEFAULT 1,
 actor text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.crm_partner_payment_v1 FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.crm_partner_cpf_ok_v1(c text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE s integer; d1 integer; d2 integer; i integer;
BEGIN
 IF c IS NULL OR c !~ '^[0-9]{11}$' OR c ~ '^(.)\1{10}$' THEN RETURN false; END IF;
 s:=0; FOR i IN 1..9 LOOP s:=s+substr(c,i,1)::integer*(11-i); END LOOP;
 d1:=(s*10)%11; IF d1=10 THEN d1:=0; END IF;
 s:=0; FOR i IN 1..10 LOOP s:=s+substr(c,i,1)::integer*(12-i); END LOOP;
 d2:=(s*10)%11; IF d2=10 THEN d2:=0; END IF;
 RETURN d1=substr(c,10,1)::integer AND d2=substr(c,11,1)::integer;
END $$;

-- Normaliza e valida a chave Pix pelo tipo. Devolve NULL se inválida.
CREATE OR REPLACE FUNCTION public.crm_partner_pix_normaliza_v1(tipo text,chave text) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE v text:=trim(coalesce(chave,'')); dig text:=regexp_replace(coalesce(chave,''),'[^0-9]','','g');
BEGIN
 IF tipo='cpf' THEN RETURN CASE WHEN public.crm_partner_cpf_ok_v1(dig) THEN dig END;
 ELSIF tipo='cnpj' THEN RETURN CASE WHEN dig ~ '^[0-9]{14}$' THEN dig END;
 ELSIF tipo='email' THEN RETURN CASE WHEN length(v)<=77 AND lower(v) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN lower(v) END;
 ELSIF tipo='telefone' THEN
  IF dig ~ '^55[0-9]{10,11}$' THEN RETURN '+'||dig; END IF;
  IF dig ~ '^[0-9]{10,11}$' THEN RETURN '+55'||dig; END IF;
  RETURN NULL;
 ELSIF tipo='aleatoria' THEN RETURN CASE WHEN lower(v) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN lower(v) END;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.crm_partner_cpf_ok_v1(text),public.crm_partner_pix_normaliza_v1(text,text) FROM PUBLIC;

-- ---------------------------------------------------------------- 2+3+4. leitura
CREATE OR REPLACE FUNCTION public.crm_partner_link_read_v1(d1 date,d2 date) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE taxa numeric; pagavel boolean; hoje date:=(now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
 SELECT max(rate),bool_and(commission_payable) INTO taxa,pagavel FROM public.crm_partner_program_v1;
 RETURN jsonb_build_object(
 'links',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.updated_at DESC),'[]') FROM (
  SELECT l.ref,l.candidate_id,l.marca,l.state,l.version,l.created_at,l.updated_at,c.name AS candidate_name,c.state AS candidate_state,
   CASE WHEN l.state='ativo' THEN public.crm_partner_link_url_v1(l.marca,l.ref) END AS url
  FROM public.crm_partner_link_v1 l JOIN public.crm_partner_candidate_v1 c ON c.id=l.candidate_id) x),
 'partner_orders',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.pedidos DESC),'[]') FROM (
  SELECT a.ref,a.marca,
   count(*) FILTER(WHERE a.ativo)::integer AS pedidos,
   sum(a.receita_liquida) FILTER(WHERE a.ativo) AS receita_liquida_com_frete,
   min(a.dia) FILTER(WHERE a.ativo) AS primeiro_dia,max(a.dia) FILTER(WHERE a.ativo) AS ultimo_dia,
   count(*) FILTER(WHERE NOT a.ativo)::integer AS pedidos_link_inativo,
   count(a.b_order) FILTER(WHERE a.ativo)::integer AS pedidos_com_base,
   count(*) FILTER(WHERE a.ativo AND a.b_order IS NULL)::integer AS pedidos_sem_base,
   count(*) FILTER(WHERE a.ativo AND a.b_order IS NOT NULL AND NOT a.completa)::integer AS pedidos_base_estimada,
   count(*) FILTER(WHERE a.ativo AND a.b_order IS NOT NULL AND a.velha)::integer AS pedidos_base_desatualizada,
   count(*) FILTER(WHERE a.ativo AND a.cupom IS NOT NULL)::integer AS pedidos_com_cupom,
   sum(a.base_elegivel) FILTER(WHERE a.ativo) AS base_elegivel,
   CASE WHEN coalesce(bool_and(a.b_order IS NOT NULL AND a.completa AND NOT a.velha) FILTER(WHERE a.ativo),true)
    THEN round(coalesce(sum(a.base_elegivel) FILTER(WHERE a.ativo),0)*max(a.rate),2) END AS comissao,
   coalesce(bool_and(a.b_order IS NOT NULL AND a.completa AND NOT a.velha) FILTER(WHERE a.ativo),true) AS comissao_fechada
  FROM (
   SELECT o.utm_content AS ref,o.marca,o.dia,o.receita_liquida,p.rate,b.order_id AS b_order,b.base_elegivel,
    coalesce(b.base_exata AND b.detalhes_completos,false) AS completa,
    coalesce(b.coletado_em<now()-interval '24 hours',false) AS velha,
    public.crm_partner_link_ativo_no_dia_v1(o.utm_content,o.dia) AS ativo,
    (SELECT i.influ FROM public.crm_influ_pedido i WHERE i.marca=o.marca AND i.via='cupom' AND i.pago
      AND 'gid://shopify/Order/'||i.order_id=o.order_id LIMIT 1) AS cupom
   FROM public.crm_organico_attribution_order_v2 o
   JOIN public.crm_partner_program_v1 p ON p.marca=o.marca
   LEFT JOIN public.crm_partner_commission_base_v1 b ON b.marca=o.marca AND b.order_id=o.order_id
    AND (b.partner_ref IS NULL OR b.partner_ref=o.utm_content)
   WHERE o.utm_source='parceiro' AND o.model='last_click' AND o.dia BETWEEN d1 AND d2
    AND EXISTS(SELECT 1 FROM public.crm_partner_link_v1 l WHERE l.ref=o.utm_content AND l.marca=o.marca)
  ) a GROUP BY a.ref,a.marca) o),
 -- Fechamento por competência (mês do pedido). Só pedidos de dia com link ativo.
 'fechamento',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.competencia DESC,f.ref),'[]') FROM (
  SELECT a.ref,a.marca,to_char(a.mes,'YYYY-MM') AS competencia,count(*)::integer AS pedidos,
   sum(a.base_elegivel) AS base_elegivel,count(*) FILTER(WHERE a.b_order IS NULL)::integer AS pedidos_sem_base,
   CASE WHEN bool_and(a.b_order IS NOT NULL AND a.completa) THEN round(coalesce(sum(a.base_elegivel),0)*max(a.rate),2) END AS comissao,
   bool_and(a.b_order IS NOT NULL AND a.completa) AS base_fechada,
   (a.mes+interval '1 month')::date<=hoje AS mes_encerrado,
   ((a.mes+interval '1 month')::date+(max(a.payment_day)-1))::date AS prazo
  FROM (
   SELECT o.utm_content AS ref,o.marca,date_trunc('month',o.dia)::date AS mes,p.rate,p.payment_day,b.order_id AS b_order,b.base_elegivel,
    coalesce(b.base_exata AND b.detalhes_completos,false) AS completa
   FROM public.crm_organico_attribution_order_v2 o
   JOIN public.crm_partner_program_v1 p ON p.marca=o.marca
   LEFT JOIN public.crm_partner_commission_base_v1 b ON b.marca=o.marca AND b.order_id=o.order_id
    AND (b.partner_ref IS NULL OR b.partner_ref=o.utm_content)
   WHERE o.utm_source='parceiro' AND o.model='last_click' AND o.dia BETWEEN d1 AND d2
    AND EXISTS(SELECT 1 FROM public.crm_partner_link_v1 l WHERE l.ref=o.utm_content AND l.marca=o.marca)
    AND public.crm_partner_link_ativo_no_dia_v1(o.utm_content,o.dia)
  ) a GROUP BY a.ref,a.marca,a.mes) f),
 -- Cadastro de pagamento, sempre mascarado. O número completo não volta para o navegador.
 'pagamentos',(SELECT coalesce(jsonb_agg(jsonb_build_object('candidate_id',x.candidate_id,'marca',x.marca,'titular',x.titular,
   'cpf_mascarado','***.'||substr(x.cpf,4,3)||'.'||substr(x.cpf,7,3)||'-**','pix_tipo',x.pix_tipo,
   'pix_final',right(x.pix_chave,4),'version',x.version,'updated_at',x.updated_at)),'[]') FROM public.crm_partner_payment_v1 x),
 'partner_orders_basis','produtos_apos_descontos_sem_frete_menos_reembolso','commission_rate',taxa,
 'link_cupom',(SELECT max(link_cupom) FROM public.crm_partner_program_v1),
 'commission_payable',coalesce(pagavel,false));
END $$;
REVOKE ALL ON FUNCTION public.crm_partner_link_read_v1(date,date),public.crm_partner_link_ativo_no_dia_v1(text,date) FROM PUBLIC;

-- ---------------------------------------------------------------- 4. escrita (kind='pagamento')
-- A função de escrita completa é gerada por partner-operacao.cjs a partir da definição em produção:
-- o mesmo corpo, mais o ramo 'pagamento' antes de "Tipo de edição inválido". Ver PAGAMENTO_RAMO lá.
