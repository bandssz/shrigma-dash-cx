-- SOURCE candidate only. Called inside the separately admitted/CAS transaction.
-- This record expresses an irreversible human disposition, never a transport outcome.
CREATE TABLE crm_audience_v2.regular_delivery_permanent_exclusion (
 dispatch_id uuid PRIMARY KEY REFERENCES public.shrigma_email_dispatch(dispatch_id),
 campaign_id integer NOT NULL CHECK(campaign_id=174),
 binding_version integer NOT NULL CHECK(binding_version>0),
 binding_hash text NOT NULL CHECK(binding_hash~'^[0-9a-f]{64}$'),
 subscriber_id integer NOT NULL CHECK(subscriber_id>0),
 dedupe_key text NOT NULL,
 dispatch_snapshot jsonb NOT NULL CHECK(jsonb_typeof(dispatch_snapshot)='object'),
 operation_id uuid NOT NULL UNIQUE,
 disposition text NOT NULL CHECK(disposition='human_permanent_no_resend'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(dispatch_id='0d8c77b2-18e7-474f-b9b7-bbfc733bac2f'::uuid),
 CHECK(dedupe_key=jsonb_build_array(campaign_id,binding_version,subscriber_id)::text),
 CHECK((dispatch_snapshot->>'dispatch_id'=dispatch_id::text) IS TRUE),
 CHECK((dispatch_snapshot->>'transport_state'='outcome_unknown') IS TRUE),
 UNIQUE(campaign_id,subscriber_id)
);
REVOKE ALL ON crm_audience_v2.regular_delivery_permanent_exclusion FROM PUBLIC;

CREATE FUNCTION crm_audience_v2.regular_delivery_exclusion_immutable() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $exclusion_immutable$
BEGIN
 RAISE EXCEPTION 'REGULAR_PERMANENT_EXCLUSION_IRREVERSIBLE';
END
$exclusion_immutable$;
REVOKE ALL ON FUNCTION crm_audience_v2.regular_delivery_exclusion_immutable() FROM PUBLIC;
CREATE TRIGGER regular_permanent_exclusion_immutable
 BEFORE UPDATE OR DELETE ON crm_audience_v2.regular_delivery_permanent_exclusion
 FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.regular_delivery_exclusion_immutable();
CREATE TRIGGER regular_permanent_exclusion_no_truncate
 BEFORE TRUNCATE ON crm_audience_v2.regular_delivery_permanent_exclusion
 FOR EACH STATEMENT EXECUTE FUNCTION crm_audience_v2.regular_delivery_exclusion_immutable();

CREATE FUNCTION crm_audience_v2.regular_delivery_permanently_excluded(did uuid,cid integer)
 RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $permanently_excluded$
 SELECT EXISTS(
  SELECT 1 FROM crm_audience_v2.regular_delivery_permanent_exclusion x
  JOIN public.shrigma_email_dispatch d ON d.dispatch_id=x.dispatch_id
  JOIN crm_audience_v2.regular_delivery_campaign ctl ON ctl.campaign_id=x.campaign_id
  JOIN crm_audience_v2.campaign_binding_effective(x.campaign_id) b ON true
  JOIN public.campaigns c ON c.id=x.campaign_id
  WHERE cid=174 AND did='0d8c77b2-18e7-474f-b9b7-bbfc733bac2f'::uuid
   AND x.dispatch_id=did AND x.campaign_id=cid
   AND x.disposition='human_permanent_no_resend'
   AND x.binding_version=b.binding_version AND x.binding_hash=b.binding_hash
   AND ctl.binding_version=x.binding_version AND ctl.binding_hash=x.binding_hash
   AND d.flow='campaign' AND d.brand='fish' AND b.brand='fish'
   AND d.piece='audience-regular-v1:174' AND d.transport_state='outcome_unknown'
   AND d.is_test IS FALSE AND d.dedupe_key=x.dedupe_key
   AND x.dedupe_key=jsonb_build_array(cid,x.binding_version,x.subscriber_id)::text
   AND to_jsonb(d)=x.dispatch_snapshot
   AND c.last_subscriber_id>=x.subscriber_id
   AND ctl.acknowledged_subscriber_id=c.last_subscriber_id
   AND ctl.acknowledged_sent=c.sent
 );
$permanently_excluded$;
REVOKE ALL ON FUNCTION crm_audience_v2.regular_delivery_permanently_excluded(uuid,integer) FROM PUBLIC;
