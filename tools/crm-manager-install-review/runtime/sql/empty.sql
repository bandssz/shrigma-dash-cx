-- Exactly four booleans over NEW namespace tables; no business data or count.
SELECT
 NOT EXISTS(SELECT 1 FROM public.shrigma_crm_manager_issuer_v1) AS issuer_empty,
 NOT EXISTS(SELECT 1 FROM public.shrigma_crm_manager_subject_v1) AS subject_empty,
 NOT EXISTS(SELECT 1 FROM public.shrigma_crm_manager_operation_v1) AS operation_empty,
 NOT EXISTS(SELECT 1 FROM public.shrigma_crm_manager_generation_v1) AS generation_empty;
