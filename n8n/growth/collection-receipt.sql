-- Successful source reads, independent of whether they produced CRM conversions.
CREATE TABLE IF NOT EXISTS public.crm_collection_receipt_v1 (
 source text NOT NULL CHECK(source='legacy_conversion'),
 brand text NOT NULL CHECK(brand IN ('fish','aristo','olivas')),
 checked_at timestamptz NOT NULL, execution_id text NOT NULL,
 pages integer NOT NULL CHECK(pages>0), observed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source,brand)
);
REVOKE ALL ON public.crm_collection_receipt_v1 FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.crm_collection_record_v1(evidence jsonb)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE x jsonb;n int=0;t timestamptz;
BEGIN
 IF jsonb_typeof(evidence) IS DISTINCT FROM 'array' OR jsonb_array_length(evidence)<>3 THEN RAISE EXCEPTION 'COLLECTION_SCOPE_INVALID';END IF;
 IF (SELECT count(DISTINCT v->>'brand') FROM jsonb_array_elements(evidence) v WHERE v->>'brand' IN ('fish','aristo','olivas'))<>3 THEN RAISE EXCEPTION 'COLLECTION_BRANDS_INCOMPLETE';END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(evidence) LOOP
  t=(x->>'checked_at')::timestamptz;
  IF t IS NULL OR t>now()+interval '5 minutes' OR x->>'complete' IS DISTINCT FROM 'true' OR coalesce((x->>'pages')::int,0)<1 OR coalesce(x->>'execution_id','')='' THEN RAISE EXCEPTION 'COLLECTION_NOT_CONFIRMED';END IF;
  INSERT INTO public.crm_collection_receipt_v1(source,brand,checked_at,execution_id,pages)
  VALUES('legacy_conversion',x->>'brand',t,x->>'execution_id',(x->>'pages')::int)
  ON CONFLICT(source,brand) DO UPDATE SET checked_at=EXCLUDED.checked_at,execution_id=EXCLUDED.execution_id,pages=EXCLUDED.pages,observed_at=now()
  WHERE EXCLUDED.checked_at>crm_collection_receipt_v1.checked_at;
  n=n+1;
 END LOOP;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.crm_collection_record_v1(jsonb) FROM PUBLIC;
