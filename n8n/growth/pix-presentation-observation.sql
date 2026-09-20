-- Additive, nullable presentation observation on the existing charge ledger.
-- No historical backfill; NULL means no observation, never aggregate or zero.
-- Install and verify the exact invoker role before wiring the optional node.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
ALTER TABLE public.shrigma_pix_charge_evidence
 ADD COLUMN IF NOT EXISTS card_variant text,
 ADD COLUMN IF NOT EXISTS card_item_count integer,
 ADD COLUMN IF NOT EXISTS card_version_sha256 text;
DO $migration$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.shrigma_pix_charge_evidence'::regclass AND conname='shrigma_pix_card_observation_v1_ck') THEN
  ALTER TABLE public.shrigma_pix_charge_evidence ADD CONSTRAINT shrigma_pix_card_observation_v1_ck CHECK((
   (card_variant IS NULL AND card_item_count IS NULL AND card_version_sha256 IS NULL) OR
   (card_variant IS NOT NULL AND card_version_sha256 IS NOT NULL AND
    ((card_variant='aggregate' AND card_item_count=1 AND card_version_sha256='1393eb1bfe812568ee74f9d31bc20f6777ec6f352ca1c134d5b20eda3a19f844') OR
     (card_variant='itemized_shape' AND card_item_count BETWEEN 1 AND 30 AND card_version_sha256='65a1dce4a40bf150d3af93043ffb534c60eb5c47eaa7d43910134e030371fcdb') OR
     (card_variant='unknown' AND (card_item_count IS NULL OR card_item_count BETWEEN 1 AND 30) AND card_version_sha256='5adadb7146f2daabca41549de918a4640712a79cf6c52c7c51617af535d1acab')))
  ) IS TRUE);
 END IF;
END $migration$;
CREATE OR REPLACE FUNCTION public.shrigma_pix_observe_presentation_v1(p_log_id bigint,p_variant text,p_item_count integer,p_version_sha256 text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public SET lock_timeout='250ms' AS $fn$
DECLARE n integer; existing public.shrigma_pix_charge_evidence%ROWTYPE;
BEGIN
 IF p_log_id IS NULL OR p_log_id<1 OR p_variant IS NULL OR p_version_sha256 IS NULL OR
    NOT ((p_variant='aggregate' AND p_item_count=1 AND p_version_sha256='1393eb1bfe812568ee74f9d31bc20f6777ec6f352ca1c134d5b20eda3a19f844') OR
    (p_variant='itemized_shape' AND p_item_count BETWEEN 1 AND 30 AND p_version_sha256='65a1dce4a40bf150d3af93043ffb534c60eb5c47eaa7d43910134e030371fcdb') OR
    (p_variant='unknown' AND (p_item_count IS NULL OR p_item_count BETWEEN 1 AND 30) AND p_version_sha256='5adadb7146f2daabca41549de918a4640712a79cf6c52c7c51617af535d1acab')) IS TRUE THEN RETURN false; END IF;
 -- Only the already committed, accepted Fish PIX row. Never reserve/send here.
 SELECT e.* INTO existing FROM public.shrigma_pix_charge_evidence e
 JOIN public.shrigma_send_log l ON l.id=e.log_id
 WHERE e.log_id=p_log_id AND e.brand='fish' AND l.brand=e.brand
 AND e.ref=l.ref AND e.template_id=l.template_ref AND l.channel='whatsapp'
 AND l.piece='pix-15min' AND l.flow<>'teste-motor' AND l.ref ~ '^[0-9]+$'
 AND e.accepted_at IS NOT NULL AND nullif(l.wamid,'') IS NOT NULL
 FOR UPDATE OF e;
 IF NOT FOUND THEN RETURN false; END IF;
 IF existing.card_variant IS NOT NULL THEN
  RETURN existing.card_variant=p_variant AND existing.card_item_count IS NOT DISTINCT FROM p_item_count AND existing.card_version_sha256=p_version_sha256;
 END IF;
 UPDATE public.shrigma_pix_charge_evidence SET card_variant=p_variant,card_item_count=p_item_count,card_version_sha256=p_version_sha256
 WHERE log_id=p_log_id AND card_variant IS NULL AND card_item_count IS NULL AND card_version_sha256 IS NULL;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n=1;
END $fn$;
REVOKE ALL ON FUNCTION public.shrigma_pix_observe_presentation_v1(bigint,text,integer,text) FROM PUBLIC;
-- No blanket grant: the publisher must verify the existing PG node role and
-- grant only EXECUTE if it differs from the migration owner. Table privileges
-- remain the current invoker's, with no SECURITY DEFINER escalation.
COMMIT;
