-- PREPARED templates only. Local proposal based on EfC; never executed remotely.
-- Apply this file, campaign-provider.sql, and campaign-write-guard.sql together
-- in one transaction as postgres, in that order, after the existing schema.
-- No template, registry row, campaign, identity, grant or transport is created.
-- This component proves template ownership only. Individual WRITER brand
-- binding is a distinct issuer/gateway requirement; no BFF gate opens here.
DO $ownership_dependencies$
BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'CAMPAIGN_TEMPLATE_OWNERSHIP_OWNER_REQUIRED'; END IF;
 IF to_regclass('public.templates') IS NULL
  OR to_regclass('public.shrigma_template_email_registry') IS NULL
  OR to_regclass('public.campaigns') IS NULL THEN
  RAISE EXCEPTION 'CAMPAIGN_TEMPLATE_OWNERSHIP_DEPENDENCY';
 END IF;
END $ownership_dependencies$;

-- The existing registry is the only source of brand. Missing registration,
-- another brand, a NULL brand, and non-campaign templates all fail closed.
-- Callers performing a write must hold a SHARE table lock on the registry:
-- locking existing rows alone cannot exclude a conflicting registry INSERT.
CREATE FUNCTION public.shrigma_campaign_template_owned_v1(tid integer,b text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $owned$
 SELECT coalesce(tid>0 AND b IN ('fish','aristo')
  AND EXISTS(SELECT 1 FROM public.templates t WHERE t.id=tid AND t.type::text='campaign')
  AND EXISTS(SELECT 1 FROM public.shrigma_template_email_registry r WHERE r.template_id=tid AND r.brand=b)
  AND NOT EXISTS(SELECT 1 FROM public.shrigma_template_email_registry r WHERE r.template_id=tid AND r.brand IS DISTINCT FROM b),false)
$owned$;
REVOKE ALL ON FUNCTION public.shrigma_campaign_template_owned_v1(integer,text) FROM PUBLIC;

-- A campaign dependency freezes template_id -> brand, including while draft.
-- Registry metadata may still change when both mapping fields are unchanged.
-- INSERT/DELETE and moves between templates check both affected template IDs.
-- Registry DML already holds ROW EXCLUSIVE on this table. The provider and the
-- native CREATE guard acquire SHARE before checking ownership, so a conflicting
-- INSERT is serialized with their whole transaction, not just a snapshot read.
CREATE FUNCTION public.shrigma_campaign_template_registry_guard_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='3s' AS $registry$
DECLARE c public.campaigns%ROWTYPE;affected integer[];
BEGIN
 IF TG_OP='TRUNCATE' THEN
  FOR c IN SELECT ca.* FROM public.campaigns ca
   WHERE ca.attribs#>>'{crm,policy}'='crm-campaign-v1'
    AND ca.attribs#>>'{crm,brand}' IN ('fish','aristo')
    AND EXISTS(SELECT 1 FROM public.shrigma_template_email_registry r WHERE r.template_id=ca.template_id)
   ORDER BY ca.id FOR SHARE LOOP
   RAISE EXCEPTION 'CAMPAIGN_DEPENDENCY_IN_USE';
  END LOOP;
  RETURN NULL;
 END IF;
 IF TG_OP='UPDATE' AND NEW.template_id IS NOT DISTINCT FROM OLD.template_id
  AND NEW.brand IS NOT DISTINCT FROM OLD.brand THEN RETURN NEW; END IF;
 affected:=ARRAY[CASE WHEN TG_OP<>'INSERT' THEN OLD.template_id END,
  CASE WHEN TG_OP<>'DELETE' THEN NEW.template_id END];
 FOR c IN SELECT ca.* FROM public.campaigns ca
  WHERE ca.attribs#>>'{crm,policy}'='crm-campaign-v1'
   AND ca.attribs#>>'{crm,brand}' IN ('fish','aristo')
   AND ca.template_id=ANY(affected)
  ORDER BY ca.id FOR SHARE LOOP
  RAISE EXCEPTION 'CAMPAIGN_DEPENDENCY_IN_USE';
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $registry$;
REVOKE ALL ON FUNCTION public.shrigma_campaign_template_registry_guard_v1() FROM PUBLIC;
CREATE TRIGGER shrigma_campaign_template_registry_guard_v1
 BEFORE INSERT OR UPDATE OR DELETE ON public.shrigma_template_email_registry
 FOR EACH ROW EXECUTE FUNCTION public.shrigma_campaign_template_registry_guard_v1();
CREATE TRIGGER shrigma_campaign_template_registry_truncate_guard_v1
 BEFORE TRUNCATE ON public.shrigma_template_email_registry
 FOR EACH STATEMENT EXECUTE FUNCTION public.shrigma_campaign_template_registry_guard_v1();
