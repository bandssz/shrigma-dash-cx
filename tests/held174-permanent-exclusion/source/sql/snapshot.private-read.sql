SELECT jsonb_build_object(
 'serverVersionNum',current_setting('server_version_num')::integer,
 'sessionUser',session_user,'currentUser',current_user,
 'regularRunning',(SELECT coalesce(jsonb_agg(id ORDER BY id),'[]'::jsonb) FROM public.campaigns WHERE type::text='regular' AND status::text='running'),
 'deployment',(SELECT to_jsonb(r) FROM crm_audience_v2.regular_worker_deployment r WHERE singleton),
 'lease',(SELECT to_jsonb(r) FROM crm_audience_v2.regular_worker_lease r WHERE singleton),
 'selectionRuntime',(SELECT to_jsonb(r) FROM crm_audience_v2.selection_runtime r WHERE singleton),
 'controls',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY campaign_id),'[]'::jsonb)
    FROM crm_audience_v2.regular_delivery_campaign r WHERE campaign_id BETWEEN 171 AND 177),
 'campaigns',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]'::jsonb)
    FROM public.campaigns r WHERE id BETWEEN 171 AND 177),
 'bindings',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY campaign_id),'[]'::jsonb)
    FROM crm_audience_v2.campaign_binding r WHERE campaign_id BETWEEN 171 AND 177),
 'bindingHistory',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text COLLATE "C"),'[]'::jsonb)
    FROM crm_audience_v2.campaign_binding_revision r WHERE campaign_id BETWEEN 171 AND 177),
 'dispatch',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.dispatch_id),'[]'::jsonb)
    FROM public.shrigma_email_dispatch r WHERE r.flow='campaign'
      AND r.brand='fish'),
 'abArms',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY campaign_id),'[]'::jsonb)
    FROM public.crm_ab_arm_v2 r WHERE campaign_id BETWEEN 171 AND 177),
 'permanentExclusions',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY dispatch_id),'[]'::jsonb) FROM crm_audience_v2.regular_delivery_permanent_exclusion x),
 'exclusionTableMetadata',(SELECT to_jsonb(c) FROM pg_class c WHERE c.oid='crm_audience_v2.regular_delivery_permanent_exclusion'::regclass),
 'exclusionTriggers',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.oid),'[]'::jsonb) FROM pg_trigger t WHERE t.tgrelid='crm_audience_v2.regular_delivery_permanent_exclusion'::regclass),
 'exclusionObjects',jsonb_build_object('table',to_regclass('crm_audience_v2.regular_delivery_permanent_exclusion')::oid,
  'helper',to_regprocedure('crm_audience_v2.regular_delivery_permanently_excluded(uuid,integer)')::oid,
  'immutable',to_regprocedure('crm_audience_v2.regular_delivery_exclusion_immutable()')::oid),
 'functionMetadata',(SELECT jsonb_object_agg(f.signature,to_jsonb(p) ORDER BY f.signature)
    FROM (VALUES
      ('crm_audience_v2.regular_worker_heartbeat(uuid,text,text)'),
      ('crm_audience_v2.regular_delivery_permanently_excluded(uuid,integer)'),
      ('crm_audience_v2.regular_delivery_exclusion_immutable()'),
      ('crm_audience_v2.regular_worker_require(uuid,text,text)'),
      ('crm_audience_v2.regular_delivery_claim_live(uuid,integer,integer,uuid,text,text,text,text,text,jsonb,text)'),
      ('crm_audience_v2.regular_delivery_claim(integer,integer,uuid,text,text,text,text,text,jsonb)'),
      ('crm_audience_v2.regular_delivery_finish(integer,integer,uuid,uuid,text)'),
      ('crm_audience_v2.regular_delivery_recover(integer,integer,uuid,boolean)'),
      ('crm_audience_v2.regular_delivery_quarantine(integer[])'),
      ('crm_audience_v2.campaign_send_guard()'),
      ('crm_audience_v2.selection_worker_context(integer)'),
      ('crm_audience_v2.regular_delivery_material(integer)'),
      ('public.shrigma_campaign_is_managed(public.campaigns)'),
      ('public.shrigma_campaign_guard()'),('public.crm_ab_campaign_guard_v2()')) f(signature)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(f.signature)),
 'relationMetadata',(SELECT jsonb_object_agg(f.name,jsonb_build_object('oid',c.oid,'kind',c.relkind,
    'owner',c.relowner,'acl',to_jsonb(c.relacl),'options',to_jsonb(c.reloptions),
    'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity) ORDER BY f.name)
    FROM (VALUES ('crm_audience_v2.regular_worker_deployment'),('crm_audience_v2.regular_worker_lease'),
      ('crm_audience_v2.selection_runtime'),('crm_audience_v2.regular_delivery_campaign'),
      ('public.campaigns'),('public.shrigma_email_dispatch'),('public.crm_ab_arm_v2')) f(name)
    LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(f.name)),
 'mutationTriggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('oid',oid,'relation',tgrelid,
    'enabled',tgenabled,'function',tgfoid) ORDER BY oid),'[]'::jsonb)
    FROM pg_catalog.pg_trigger WHERE NOT tgisinternal AND tgrelid IN(
      'crm_audience_v2.regular_worker_deployment'::regclass,
      'crm_audience_v2.regular_worker_lease'::regclass,
      'crm_audience_v2.selection_runtime'::regclass,
      'crm_audience_v2.regular_delivery_campaign'::regclass)),
 'campaignGuard',(SELECT coalesce(jsonb_agg(jsonb_build_object('oid',t.oid,'enabled',t.tgenabled,
    'function',t.tgfoid,'type',t.tgtype,'metadata',to_jsonb(t)) ORDER BY t.oid),'[]'::jsonb) FROM pg_catalog.pg_trigger t
    WHERE NOT tgisinternal AND tgrelid='public.campaigns'::regclass)
);
