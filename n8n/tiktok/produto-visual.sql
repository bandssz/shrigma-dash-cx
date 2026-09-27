-- Prévia de produto no painel do TikTok (27/09/2026): foto e nome curto do produto pedido em amostra, colab e pedido.
-- A foto vem do catálogo público das lojas (products.json), casada com o anúncio da TikTok por regra de nome.
-- Anúncio que não diz a variação (ex.: "Linha 8 Fios" sem a cor) fica sem foto: não se presume. Idempotente.

CREATE TABLE IF NOT EXISTS public.crm_tts_loja_produto_v1(
 marca text NOT NULL CHECK(marca IN ('aristo','fish')),
 handle text NOT NULL,
 titulo text NOT NULL,
 imagem_url text,
 url text NOT NULL,
 atualizado_em timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(marca,handle)
);
CREATE TABLE IF NOT EXISTS public.crm_tts_produto_v1(
 marca text NOT NULL,
 product_id text NOT NULL,
 titulo text NOT NULL,
 handle text,
 rotulo text NOT NULL,
 quantidade integer,
 fonte text NOT NULL DEFAULT 'regra' CHECK(fonte IN ('regra','manual')),
 atualizado_em timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(marca,product_id)
);
REVOKE ALL ON public.crm_tts_loja_produto_v1,public.crm_tts_produto_v1 FROM PUBLIC;

-- Regra de nome: devolve o produto da loja (handle), o rótulo curto e a quantidade do kit.
CREATE OR REPLACE FUNCTION public.crm_tts_produto_classifica_v1(brand text,titulo text,OUT handle text,OUT rotulo text,OUT quantidade integer)
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE t text:=lower(coalesce(titulo,'')); q text;
BEGIN
 q:=coalesce(substring(t from '(?:kit|kit com)\s*(\d{1,2})'),substring(t from '(\d{1,2})\s*(?:unidades|un\b)'));
 quantidade:=CASE WHEN q IS NOT NULL THEN q::int END;
 IF brand='aristo' THEN
  IF t ~ 'desodorante' AND t ~ 'sabonete' THEN handle:=NULL; rotulo:='Kit desodorante + sabonete';
  ELSIF t ~ 'desodorante' THEN handle:='desodorante-frescor-da-mata'; rotulo:='Desodorante Frescor da Mata';
  ELSIF t ~ 'alma da ro' AND t ~ 'frescor' THEN handle:='kit-misto'; rotulo:='Kit misto Frescor + Alma da Roça';
  ELSIF t ~ 'alma da ro' THEN handle:='alma-da-roca'; rotulo:='Sabonete Alma da Roça';
  ELSIF t ~ 'frescor da mata' THEN handle:='sabonete-frescor-da-mata'; rotulo:='Sabonete Frescor da Mata';
  ELSIF t ~ 'sabonete' THEN handle:=NULL; rotulo:='Sabonete (fragrância não informada no anúncio)';
  ELSE handle:=NULL; rotulo:=left(titulo,48); END IF;
 ELSE
  IF t ~ 'borsari' THEN handle:='edicao-limitada-x16-bruno-borsari'; rotulo:='X16 Borsari';
  ELSIF t ~ 'marfim|16 ?fios|16x|x16' THEN handle:='linha-de-pesca-multifilamento-x16-marfim'; rotulo:='X16 Marfim';
  ELSIF t ~ 'w98' THEN handle:='linha-de-pesca-monofilamento-tungstenio-w98'; rotulo:='W98 Mono';
  ELSIF t ~ 'n90' THEN handle:='linha-de-pesca-monofilamento-nylon-n90'; rotulo:='N90 Mono';
  ELSIF t ~ 'c97' THEN handle:='linha-de-pesca-monofilamento-revestida-c97'; rotulo:='C97 Mono';
  ELSIF t ~ 'n40' THEN handle:='linha-de-pesca-monofilamento-nylon-n40'; rotulo:='N40 Mono';
  ELSIF t ~ 's50' THEN handle:='linha-de-pesca-monofilamento-soft-s50'; rotulo:='S50 Mono';
  ELSIF t ~ '4 ?fios|x4|4x' THEN
   IF t ~ 'oce[aâ]nica' THEN handle:='linha-de-pesca-multifilamento-x4-oceanica'; rotulo:='X4 Oceânica';
   ELSIF t ~ 'amaz[oô]nica' THEN handle:='linha-de-pesca-multifilamento-x4-amazonica'; rotulo:='X4 Amazônica';
   ELSE handle:=NULL; rotulo:='X4 (cor não informada no anúncio)'; END IF;
  ELSIF t ~ '8 ?fios|x8|8x' THEN
   IF t ~ 'oce[aâ]nica' THEN handle:='linha-de-pesca-multifilamento-x8-oceanica'; rotulo:='X8 Oceânica';
   ELSIF t ~ 'amaz[oô]nica' THEN handle:='linha-de-pesca-multifilamento-x8-amazonica'; rotulo:='X8 Amazônica';
   ELSE handle:=NULL; rotulo:='X8 (cor não informada no anúncio)'; END IF;
  ELSE handle:=NULL; rotulo:=left(titulo,48); END IF;
 END IF;
END $$;

-- Catálogo público das lojas: {marca, produtos:[{handle,titulo,imagem_url,url}]}. Só acrescenta ou atualiza.
CREATE OR REPLACE FUNCTION public.crm_tts_loja_produto_upsert_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE n int:=0; x jsonb; brand text:=p->>'marca';
BEGIN
 IF brand NOT IN ('aristo','fish') OR jsonb_typeof(p->'produtos') IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('erro','entrada invalida'); END IF;
 FOR x IN SELECT * FROM jsonb_array_elements(p->'produtos') LOOP
  CONTINUE WHEN coalesce(x->>'handle','') !~ '^[a-z0-9-]{1,120}$' OR coalesce(x->>'url','') !~ '^https://';
  INSERT INTO public.crm_tts_loja_produto_v1(marca,handle,titulo,imagem_url,url,atualizado_em)
  VALUES(brand,x->>'handle',left(coalesce(x->>'titulo',''),200),CASE WHEN x->>'imagem_url' ~ '^https://cdn\.shopify\.com/' THEN left(x->>'imagem_url',500) END,left(x->>'url',300),now())
  ON CONFLICT(marca,handle) DO UPDATE SET titulo=EXCLUDED.titulo,imagem_url=coalesce(EXCLUDED.imagem_url,public.crm_tts_loja_produto_v1.imagem_url),url=EXCLUDED.url,atualizado_em=now();
  n:=n+1;
 END LOOP;
 RETURN jsonb_build_object('ok',true,'marca',brand,'produtos',n);
END $$;

-- Classifica todo produto da TikTok já visto (amostra, colab, pedido). Classificação manual não é sobrescrita.
CREATE OR REPLACE FUNCTION public.crm_tts_produto_sync_v1()
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE n int;
BEGIN
 WITH vistos AS (
  SELECT marca,product_id,max(product_title) AS titulo FROM (
   SELECT marca,product_id,product_title FROM public.crm_tts_amostra WHERE coalesce(product_id,'')<>''
   UNION ALL SELECT marca,product_id,product_title FROM public.crm_tts_colaboracao WHERE coalesce(product_id,'')<>''
  ) x GROUP BY 1,2),
 c AS (SELECT v.marca,v.product_id,coalesce(v.titulo,'') AS titulo,(public.crm_tts_produto_classifica_v1(v.marca,v.titulo)).* FROM vistos v)
 INSERT INTO public.crm_tts_produto_v1(marca,product_id,titulo,handle,rotulo,quantidade,fonte,atualizado_em)
 SELECT marca,product_id,titulo,handle,rotulo,quantidade,'regra',now() FROM c
 ON CONFLICT(marca,product_id) DO UPDATE SET titulo=EXCLUDED.titulo,handle=EXCLUDED.handle,rotulo=EXCLUDED.rotulo,quantidade=EXCLUDED.quantidade,atualizado_em=now()
  WHERE public.crm_tts_produto_v1.fonte='regra';
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN jsonb_build_object('ok',true,'classificados',n);
END $$;

-- Leitura do painel (chave de Influs): produto → rótulo, quantidade, foto e página da loja.
CREATE OR REPLACE FUNCTION public.crm_tts_produto_painel_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
BEGIN
 IF public.shrigma_panel_operator_v1(p->>'k','influs') IS NULL THEN RETURN jsonb_build_object('erro','Entre com a chave do painel de Influs.'); END IF;
 RETURN jsonb_build_object('ok',true,'produtos',(SELECT coalesce(jsonb_agg(jsonb_build_object('marca',t.marca,'product_id',t.product_id,'titulo',t.titulo,'rotulo',t.rotulo,
   'quantidade',t.quantidade,'imagem_url',l.imagem_url,'url',l.url,'fonte',t.fonte)),'[]')
  FROM public.crm_tts_produto_v1 t LEFT JOIN public.crm_tts_loja_produto_v1 l ON l.marca=t.marca AND l.handle=t.handle));
END $$;
REVOKE ALL ON FUNCTION public.crm_tts_produto_classifica_v1(text,text),public.crm_tts_loja_produto_upsert_v1(jsonb),public.crm_tts_produto_sync_v1(),public.crm_tts_produto_painel_v1(jsonb) FROM PUBLIC;

-- Foto direto da TikTok (27/09): a imagem principal do anúncio, lida pela cadeia "Fotos 05:50" do workflow 37W8.
ALTER TABLE public.crm_tts_produto_v1 ADD COLUMN IF NOT EXISTS imagem_tiktok text;
ALTER TABLE public.crm_tts_produto_v1 ADD COLUMN IF NOT EXISTS foto_em timestamptz;
CREATE OR REPLACE FUNCTION public.crm_tts_produto_foto_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE x jsonb; n int:=0;
BEGIN
 IF jsonb_typeof(p->'fotos') IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('erro','entrada invalida'); END IF;
 FOR x IN SELECT * FROM jsonb_array_elements(p->'fotos') LOOP
  UPDATE public.crm_tts_produto_v1 SET foto_em=now(),
   imagem_tiktok=CASE WHEN x->>'imagem' ~ '^https://[a-z0-9.-]+\.(ibyteimg|tiktokcdn|tiktokcdn-us|byteimg|ttwstatic)\.com/' THEN left(x->>'imagem',800) ELSE imagem_tiktok END
  WHERE marca=x->>'marca' AND product_id=x->>'product_id';
  n:=n+CASE WHEN FOUND THEN 1 ELSE 0 END;
 END LOOP;
 RETURN jsonb_build_object('ok',true,'atualizados',n);
END $$;
REVOKE ALL ON FUNCTION public.crm_tts_produto_foto_v1(jsonb) FROM PUBLIC;
-- Leitura do painel: a foto da TikTok é a do próprio anúncio; a da loja fica de reserva.
CREATE OR REPLACE FUNCTION public.crm_tts_produto_painel_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
BEGIN
 IF public.shrigma_panel_operator_v1(p->>'k','influs') IS NULL THEN RETURN jsonb_build_object('erro','Entre com a chave do painel de Influs.'); END IF;
 RETURN jsonb_build_object('ok',true,'produtos',(SELECT coalesce(jsonb_agg(jsonb_build_object('marca',t.marca,'product_id',t.product_id,'titulo',t.titulo,'rotulo',t.rotulo,
   'quantidade',t.quantidade,'imagem_url',coalesce(t.imagem_tiktok,l.imagem_url),'imagem_fonte',CASE WHEN t.imagem_tiktok IS NOT NULL THEN 'tiktok' WHEN l.imagem_url IS NOT NULL THEN 'loja' END,
   'url',l.url,'fonte',t.fonte)),'[]')
  FROM public.crm_tts_produto_v1 t LEFT JOIN public.crm_tts_loja_produto_v1 l ON l.marca=t.marca AND l.handle=t.handle));
END $$;
REVOKE ALL ON FUNCTION public.crm_tts_produto_painel_v1(jsonb) FROM PUBLIC;
