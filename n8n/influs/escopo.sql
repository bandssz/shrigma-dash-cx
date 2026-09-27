-- Escopo dos creators (27/09/2026, começa em outubro): a Marcela define o mínimo por mês de cada creator e o
-- painel mostra feito × combinado. Reels e posts entram sozinhos: são os conteúdos em que o creator marcou a conta
-- da marca no Instagram (GET /{ig}/tags). Story a Marcela marca à mão (decisão do Felipe). TikTok: marcado à mão
-- por enquanto. Idempotente.

CREATE TABLE IF NOT EXISTS public.crm_influ_escopo_v1(
 marca text NOT NULL,
 influ text NOT NULL,
 vigente_desde date NOT NULL CHECK(extract(day FROM vigente_desde)=1),
 stories integer NOT NULL DEFAULT 0 CHECK(stories BETWEEN 0 AND 200),
 reels integer NOT NULL DEFAULT 0 CHECK(reels BETWEEN 0 AND 100),
 feed integer NOT NULL DEFAULT 0 CHECK(feed BETWEEN 0 AND 100),
 tiktok integer NOT NULL DEFAULT 0 CHECK(tiktok BETWEEN 0 AND 100),
 instagram text NOT NULL DEFAULT '' CHECK(instagram ~ '^([a-z0-9._]{1,30})?$'),
 obs text NOT NULL DEFAULT '' CHECK(length(obs)<=300),
 atualizado_em timestamptz NOT NULL DEFAULT now(),
 atualizado_por text NOT NULL,
 PRIMARY KEY(marca,influ,vigente_desde)
);
CREATE TABLE IF NOT EXISTS public.crm_influ_conteudo_v1(
 id text PRIMARY KEY,
 marca text NOT NULL CHECK(marca IN ('aristo','fish')),
 conta text NOT NULL DEFAULT '',
 username text NOT NULL,
 influ text,
 tipo text NOT NULL CHECK(tipo IN ('story','reels','feed','tiktok')),
 permalink text,
 miniatura text,
 publicado_em timestamptz NOT NULL,
 fonte text NOT NULL CHECK(fonte IN ('ig_tags','manual')),
 ignorado boolean NOT NULL DEFAULT false,
 criado_por text NOT NULL DEFAULT 'coleta',
 criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_influ_conteudo_mes_v1 ON public.crm_influ_conteudo_v1(marca,publicado_em);
CREATE INDEX IF NOT EXISTS crm_influ_conteudo_user_v1 ON public.crm_influ_conteudo_v1(marca,lower(username));
REVOKE ALL ON public.crm_influ_escopo_v1,public.crm_influ_conteudo_v1 FROM PUBLIC;

-- @ do Instagram de cada creator: o do escopo vigente; senão, o handle do cadastro.
CREATE OR REPLACE FUNCTION public.crm_influ_ig_v1(brand text,slug text)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(
  (SELECT nullif(e.instagram,'') FROM public.crm_influ_escopo_v1 e WHERE e.marca=brand AND e.influ=slug ORDER BY e.vigente_desde DESC LIMIT 1),
  (SELECT nullif(lower(regexp_replace(btrim(i.handle),'^@','')),'') FROM public.crm_influ i WHERE i.marca=brand AND i.influ=slug))
$$;

-- Coleta: {marca, conta, midias:[{id,media_product_type,media_type,timestamp,username,permalink,thumbnail_url,media_url}]}
CREATE OR REPLACE FUNCTION public.crm_influ_conteudo_ingest_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE brand text:=p->>'marca'; x jsonb; n int:=0; tp text; u text;
BEGIN
 IF brand NOT IN ('aristo','fish') OR jsonb_typeof(p->'midias') IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('erro','entrada invalida'); END IF;
 FOR x IN SELECT * FROM jsonb_array_elements(p->'midias') LOOP
  CONTINUE WHEN coalesce(x->>'id','') !~ '^\d{5,30}$' OR coalesce(x->>'username','')='' OR coalesce(x->>'timestamp','')='';
  u:=lower(x->>'username');
  tp:=CASE WHEN x->>'media_product_type'='REELS' THEN 'reels' WHEN x->>'media_product_type'='STORY' THEN 'story' ELSE 'feed' END;
  INSERT INTO public.crm_influ_conteudo_v1(id,marca,conta,username,influ,tipo,permalink,miniatura,publicado_em,fonte)
  VALUES('ig:'||(x->>'id'),brand,left(coalesce(p->>'conta',''),60),u,
   (SELECT i.influ FROM public.crm_influ i WHERE i.marca=brand AND public.crm_influ_ig_v1(brand,i.influ)=u ORDER BY i.ativo DESC LIMIT 1),
   tp,CASE WHEN x->>'permalink' ~ '^https://(www\.)?instagram\.com/' THEN left(x->>'permalink',300) END,
   CASE WHEN coalesce(x->>'thumbnail_url',x->>'media_url') ~ '^https://' THEN left(coalesce(x->>'thumbnail_url',x->>'media_url'),900) END,
   (x->>'timestamp')::timestamptz,'ig_tags')
  ON CONFLICT(id) DO UPDATE SET miniatura=coalesce(EXCLUDED.miniatura,public.crm_influ_conteudo_v1.miniatura),
   influ=coalesce(public.crm_influ_conteudo_v1.influ,EXCLUDED.influ);
  n:=n+1;
 END LOOP;
 -- Quem cadastrou o @ depois: casa o que já estava coletado.
 UPDATE public.crm_influ_conteudo_v1 c SET influ=i.influ FROM public.crm_influ i
  WHERE c.influ IS NULL AND c.marca=brand AND i.marca=c.marca AND public.crm_influ_ig_v1(i.marca,i.influ)=c.username;
 RETURN jsonb_build_object('ok',true,'marca',brand,'midias',n);
END $$;

-- Painel (chave de Influs; gravar pede creators_edit). p: {k, acao, mes:'YYYY-MM', data:{...}}
CREATE OR REPLACE FUNCTION public.crm_influ_escopo_painel_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE op jsonb; escreve boolean; quem text; acao text:=p->>'acao'; d jsonb:=coalesce(p->'data','{}'::jsonb); ini date; fim date; ig text; tp text; dia date;
BEGIN
 op:=public.shrigma_panel_operator_v1(p->>'k','influs');
 IF op IS NULL THEN RETURN jsonb_build_object('erro','Entre com a chave do painel de Influs.'); END IF;
 escreve:=coalesce(op->'caps' ? 'creators_edit',false); quem:=left(coalesce(nullif(btrim(op->>'label'),''),'painel'),40);
 IF coalesce(p->>'mes','') !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN ini:=date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date; ELSE ini:=(p->>'mes'||'-01')::date; END IF;
 fim:=(ini+interval '1 month')::date;
 IF acao='ler' THEN
  RETURN jsonb_build_object('ok',true,'pode_escrever',escreve,'mes',to_char(ini,'YYYY-MM'),
   'coleta',(SELECT jsonb_build_object('ultima',max(criado_em) FILTER (WHERE fonte='ig_tags'),'total',count(*) FILTER (WHERE fonte='ig_tags')) FROM public.crm_influ_conteudo_v1),
   'creators',(SELECT coalesce(jsonb_agg(x ORDER BY (x->>'marca'),(x->>'nome')),'[]') FROM (
     SELECT jsonb_build_object('marca',i.marca,'influ',i.influ,'nome',coalesce(nullif(i.nome,''),i.influ),'ativo',i.ativo,'modelo',i.modelo,
      'instagram',public.crm_influ_ig_v1(i.marca,i.influ),
      'escopo',(SELECT to_jsonb(e)-'atualizado_por' FROM public.crm_influ_escopo_v1 e WHERE e.marca=i.marca AND e.influ=i.influ AND e.vigente_desde<=ini ORDER BY e.vigente_desde DESC LIMIT 1),
      'feito',(SELECT jsonb_build_object('story',count(*) FILTER (WHERE tipo='story'),'reels',count(*) FILTER (WHERE tipo='reels'),'feed',count(*) FILTER (WHERE tipo='feed'),'tiktok',count(*) FILTER (WHERE tipo='tiktok'))
        FROM public.crm_influ_conteudo_v1 c WHERE c.marca=i.marca AND c.influ=i.influ AND NOT c.ignorado AND c.publicado_em>=(ini::timestamp AT TIME ZONE 'America/Sao_Paulo') AND c.publicado_em<(fim::timestamp AT TIME ZONE 'America/Sao_Paulo')),
      'conteudos',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'tipo',c.tipo,'permalink',c.permalink,'miniatura',c.miniatura,'publicado_em',c.publicado_em,'fonte',c.fonte,'ignorado',c.ignorado) ORDER BY c.publicado_em DESC),'[]')
        FROM public.crm_influ_conteudo_v1 c WHERE c.marca=i.marca AND c.influ=i.influ AND c.publicado_em>=(ini::timestamp AT TIME ZONE 'America/Sao_Paulo') AND c.publicado_em<(fim::timestamp AT TIME ZONE 'America/Sao_Paulo'))) AS x
     FROM public.crm_influ i WHERE i.ativo OR EXISTS (SELECT 1 FROM public.crm_influ_escopo_v1 e WHERE e.marca=i.marca AND e.influ=i.influ)) q),
   'sem_cadastro',(SELECT coalesce(jsonb_agg(jsonb_build_object('marca',s.marca,'username',s.username,'n',s.n,'ultimo',s.ultimo) ORDER BY s.n DESC),'[]') FROM (
     SELECT marca,username,count(*) n,max(publicado_em) ultimo FROM public.crm_influ_conteudo_v1
     WHERE influ IS NULL AND NOT ignorado AND publicado_em>=(ini::timestamp AT TIME ZONE 'America/Sao_Paulo') AND publicado_em<(fim::timestamp AT TIME ZONE 'America/Sao_Paulo')
     GROUP BY 1,2 ORDER BY 3 DESC LIMIT 60) s));
 END IF;
 IF NOT escreve THEN RETURN jsonb_build_object('erro','Esta chave só lê. Editar escopo pede a chave de gestão de Influs.'); END IF;
 IF d->>'marca' NOT IN ('aristo','fish') OR NOT EXISTS (SELECT 1 FROM public.crm_influ WHERE marca=d->>'marca' AND influ=d->>'influ') THEN RETURN jsonb_build_object('erro','Creator não encontrado.'); END IF;
 IF acao='escopo_salvar' THEN
  ig:=lower(regexp_replace(btrim(coalesce(d->>'instagram','')),'^@',''));
  IF ig !~ '^([a-z0-9._]{1,30})?$' THEN RETURN jsonb_build_object('erro','Instagram inválido.'); END IF;
  IF coalesce(d->>'desde','') !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN RETURN jsonb_build_object('erro','Informe o mês de início.'); END IF;
  IF NOT (coalesce(d->>'stories','0') ~ '^\d{1,3}$' AND coalesce(d->>'reels','0') ~ '^\d{1,3}$' AND coalesce(d->>'feed','0') ~ '^\d{1,3}$' AND coalesce(d->>'tiktok','0') ~ '^\d{1,3}$') THEN
   RETURN jsonb_build_object('erro','Quantidades precisam ser números inteiros.');
  END IF;
  INSERT INTO public.crm_influ_escopo_v1(marca,influ,vigente_desde,stories,reels,feed,tiktok,instagram,obs,atualizado_por)
  VALUES(d->>'marca',d->>'influ',(d->>'desde'||'-01')::date,coalesce(d->>'stories','0')::int,coalesce(d->>'reels','0')::int,coalesce(d->>'feed','0')::int,coalesce(d->>'tiktok','0')::int,ig,left(coalesce(d->>'obs',''),300),quem)
  ON CONFLICT(marca,influ,vigente_desde) DO UPDATE SET stories=EXCLUDED.stories,reels=EXCLUDED.reels,feed=EXCLUDED.feed,tiktok=EXCLUDED.tiktok,
   instagram=EXCLUDED.instagram,obs=EXCLUDED.obs,atualizado_em=now(),atualizado_por=quem;
  UPDATE public.crm_influ_conteudo_v1 SET influ=d->>'influ' WHERE influ IS NULL AND marca=d->>'marca' AND ig<>'' AND username=ig;
  RETURN jsonb_build_object('ok',true,'mensagem','Escopo salvo.');
 END IF;
 IF acao='vincular' THEN
  -- Liga o @ do Instagram ao creator sem mexer nas quantidades: usa o escopo vigente do mês ou cria um zerado.
  ig:=lower(regexp_replace(btrim(coalesce(d->>'instagram','')),'^@',''));
  IF ig !~ '^[a-z0-9._]{1,30}$' THEN RETURN jsonb_build_object('erro','Instagram inválido.'); END IF;
  INSERT INTO public.crm_influ_escopo_v1(marca,influ,vigente_desde,stories,reels,feed,tiktok,instagram,obs,atualizado_por)
  SELECT d->>'marca',d->>'influ',ini,coalesce(e.stories,0),coalesce(e.reels,0),coalesce(e.feed,0),coalesce(e.tiktok,0),ig,coalesce(e.obs,''),quem
  FROM (SELECT 1) one LEFT JOIN LATERAL (SELECT * FROM public.crm_influ_escopo_v1 x WHERE x.marca=d->>'marca' AND x.influ=d->>'influ' AND x.vigente_desde<=ini ORDER BY x.vigente_desde DESC LIMIT 1) e ON true
  ON CONFLICT(marca,influ,vigente_desde) DO UPDATE SET instagram=EXCLUDED.instagram,atualizado_em=now(),atualizado_por=quem;
  UPDATE public.crm_influ_conteudo_v1 SET influ=d->>'influ' WHERE influ IS NULL AND marca=d->>'marca' AND username=ig;
  RETURN jsonb_build_object('ok',true,'mensagem','@'||ig||' ligado ao creator.');
 END IF;
 IF acao='conteudo_marcar' THEN
  tp:=d->>'tipo';
  IF tp NOT IN ('story','reels','feed','tiktok') THEN RETURN jsonb_build_object('erro','Tipo inválido.'); END IF;
  IF coalesce(d->>'dia','') !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN jsonb_build_object('erro','Informe o dia.'); END IF;
  dia:=(d->>'dia')::date;
  IF dia>(now() AT TIME ZONE 'America/Sao_Paulo')::date OR dia<(now() AT TIME ZONE 'America/Sao_Paulo')::date-120 THEN RETURN jsonb_build_object('erro','Dia fora da janela (até 120 dias atrás).'); END IF;
  IF coalesce(d->>'link','')<>'' AND d->>'link' !~ '^https://' THEN RETURN jsonb_build_object('erro','Link precisa começar com https://'); END IF;
  IF coalesce(d->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN jsonb_build_object('erro','Envio inválido. Recarregue.'); END IF;
  INSERT INTO public.crm_influ_conteudo_v1(id,marca,username,influ,tipo,permalink,publicado_em,fonte,criado_por)
  VALUES('manual:'||(d->>'id'),d->>'marca',coalesce(public.crm_influ_ig_v1(d->>'marca',d->>'influ'),d->>'influ'),d->>'influ',tp,nullif(left(d->>'link',300),''),
   ((dia::timestamp+interval '12 hours') AT TIME ZONE 'America/Sao_Paulo'),'manual',quem)
  ON CONFLICT(id) DO NOTHING;
  RETURN jsonb_build_object('ok',true,'mensagem',CASE tp WHEN 'story' THEN 'Story marcado.' ELSE 'Conteúdo marcado.' END);
 END IF;
 IF acao='conteudo_ignorar' THEN
  UPDATE public.crm_influ_conteudo_v1 SET ignorado=coalesce((d->>'ignorar')::boolean,true) WHERE id=d->>'id' AND marca=d->>'marca' AND influ=d->>'influ';
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','Conteúdo não encontrado.'); END IF;
  RETURN jsonb_build_object('ok',true,'mensagem','Atualizado.');
 END IF;
 RETURN jsonb_build_object('erro','Ação inválida.');
END $$;
REVOKE ALL ON FUNCTION public.crm_influ_ig_v1(text,text),public.crm_influ_conteudo_ingest_v1(jsonb),public.crm_influ_escopo_painel_v1(jsonb) FROM PUBLIC;
