-- Parceiros do site: comissão de 5% (decisão do Felipe em 27/09/2026, antes do primeiro link emitido).
-- Aplicar DEPOIS de partner-operacao.sql. Idempotente.
-- A trava original (rate = 0.07) vira faixa (0 < rate <= 0.30). A taxa não tem histórico por data porque, na
-- mudança, não havia link, pedido nem base de comissão: nenhum valor já calculado muda.
BEGIN;
ALTER TABLE public.crm_partner_program_v1 DROP CONSTRAINT IF EXISTS crm_partner_program_v1_rate_check;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='crm_partner_program_rate_ck') THEN
  ALTER TABLE public.crm_partner_program_v1 ADD CONSTRAINT crm_partner_program_rate_ck CHECK(rate>0 AND rate<=0.30);
 END IF;
 IF EXISTS(SELECT 1 FROM public.crm_partner_commission_base_v1) AND EXISTS(SELECT 1 FROM public.crm_partner_program_v1 WHERE rate<>0.05) THEN
  RAISE EXCEPTION 'Já existe base de comissão: mudar a taxa exige vigência por data';
 END IF;
END $$;
ALTER TABLE public.crm_partner_program_v1 ALTER COLUMN rate SET DEFAULT 0.05;
UPDATE public.crm_partner_program_v1 SET rate=0.05,version=version+1,updated_at=now() WHERE rate<>0.05;
COMMIT;
