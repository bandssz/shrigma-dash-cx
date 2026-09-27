-- Registro de links UTM do Orgânico (26/09/2026). Substitui aos poucos a planilha "Controle de Links
-- Parametrizados" da Júlia: mesmo padrão de montagem (utm_campaign = AAAAMMDD_produto quando há data),
-- montagem feita no servidor, uma linha por link final. Idempotente.
-- Quem grava: chave de painel do Orgânico (ou mestre), conferida aqui pelo hash — a chave não é guardada.

CREATE TABLE IF NOT EXISTS public.organico_link_utm_v1(
 id uuid PRIMARY KEY,
 marca text NOT NULL CHECK(marca IN ('aristo','fish')),
 dia date,
 destino text NOT NULL,
 utm_source text NOT NULL,
 utm_medium text NOT NULL,
 utm_campaign text NOT NULL,
 produto text,
 url text NOT NULL UNIQUE,
 observacao text NOT NULL DEFAULT '',
 origem text NOT NULL DEFAULT 'painel' CHECK(origem IN ('painel','planilha')),
 criado_por text NOT NULL,
 criado_em timestamptz NOT NULL DEFAULT now(),
 arquivado boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS organico_link_utm_campanha_v1 ON public.organico_link_utm_v1(marca,utm_campaign);
REVOKE ALL ON public.organico_link_utm_v1 FROM PUBLIC;

-- Dono do acesso de Orgânico (painel organico ou mestre), ou NULL. Mesmo teste de hash do restante dos painéis.
CREATE OR REPLACE FUNCTION public.organico_operador_v1(k text) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT c.dono FROM public.crm_dash_chave c
 WHERE c.painel IN ('organico','todos') AND c.ativo AND c.revogada_em IS NULL AND (c.expira_em IS NULL OR c.expira_em>now())
  AND c.chave_hash IS NOT NULL AND k ~ '^[a-z0-9-]{8,128}$'
  AND encode(sha256(convert_to(k,'UTF8')),'hex') IN (c.chave_hash,c.chave_hash_curta)
 LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.organico_operador_v1(text) FROM PUBLIC;

-- Montagem igual à fórmula da planilha: destino + ?/& + utm_source, utm_medium, utm_campaign.
CREATE OR REPLACE FUNCTION public.organico_link_utm_monta_v1(destino text,src text,med text,camp text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT destino||CASE WHEN position('?' IN destino)>0 THEN '&' ELSE '?' END||'utm_source='||src||'&utm_medium='||med||'&utm_campaign='||camp
$$;

CREATE OR REPLACE FUNCTION public.organico_link_utm_v1(p jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE quem text; acao text:=p->>'acao'; d jsonb:=p->'data'; brand text; destino text; src text; med text; slug text; dia date;
 camp text; final text; rid uuid; existente public.organico_link_utm_v1; host text;
BEGIN
 quem:=public.organico_operador_v1(p->>'k');
 IF quem IS NULL THEN RETURN jsonb_build_object('erro','Acesso ao Orgânico necessário.'); END IF;
 IF acao='listar' THEN
  RETURN jsonb_build_object('ok',true,'links',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY coalesce(l.dia,l.criado_em::date) DESC,l.criado_em DESC),'[]')
   FROM public.organico_link_utm_v1 l WHERE NOT l.arquivado));
 END IF;
 IF acao='arquivar' THEN
  IF coalesce(d->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN jsonb_build_object('erro','Link inválido.'); END IF;
  UPDATE public.organico_link_utm_v1 SET arquivado=true WHERE id=(d->>'id')::uuid RETURNING * INTO existente;
  IF existente.id IS NULL THEN RETURN jsonb_build_object('erro','Link não encontrado.'); END IF;
  RETURN jsonb_build_object('ok',true,'id',existente.id,'arquivado',true);
 END IF;
 IF acao IS DISTINCT FROM 'salvar' OR jsonb_typeof(d) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('erro','Operação inválida.'); END IF;
 brand:=d->>'marca';destino:=trim(coalesce(d->>'destino',''));src:=d->>'utm_source';med:=d->>'utm_medium';slug:=trim(coalesce(d->>'campanha',''));
 IF brand NOT IN ('aristo','fish') THEN RETURN jsonb_build_object('erro','Escolha a marca.'); END IF;
 host:=substring(destino FROM '^https://([^/?#]+)');
 IF host IS NULL OR length(destino)>400 OR destino ~ '[\s<>"'']' OR destino ~* '[?&]utm_'
  OR (brand='aristo' AND host NOT IN ('oaristocrata.com','www.oaristocrata.com'))
  OR (brand='fish' AND host NOT IN ('fishermans.com.br','www.fishermans.com.br')) THEN
  RETURN jsonb_build_object('erro','Destino precisa ser uma página https do site da marca, sem UTM.');
 END IF;
 IF src NOT IN ('instagram_social','facebook_social','tiktok_social','youtube','whatsapp') THEN RETURN jsonb_build_object('erro','Origem (utm_source) fora da lista.'); END IF;
 IF med NOT IN ('story','linktree','dm','feed','reels','comunidade','direct','grupo') THEN RETURN jsonb_build_object('erro','Superfície (utm_medium) fora da lista.'); END IF;
 IF slug !~ '^[A-Za-z0-9_-]{2,60}$' THEN RETURN jsonb_build_object('erro','Campanha: 2 a 60 letras, números, _ ou -, sem espaço.'); END IF;
 IF coalesce(d->>'dia','')<>'' THEN
  IF d->>'dia' !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN jsonb_build_object('erro','Data inválida.'); END IF;
  dia:=(d->>'dia')::date; camp:=to_char(dia,'YYYYMMDD')||'_'||slug;
 ELSE camp:=slug; END IF;
 final:=public.organico_link_utm_monta_v1(destino,src,med,camp);
 SELECT * INTO existente FROM public.organico_link_utm_v1 WHERE url=final;
 IF existente.id IS NOT NULL THEN
  IF existente.arquivado THEN UPDATE public.organico_link_utm_v1 SET arquivado=false WHERE id=existente.id RETURNING * INTO existente; END IF;
  RETURN jsonb_build_object('ok',true,'repetido',true,'link',to_jsonb(existente));
 END IF;
 rid:=CASE WHEN coalesce(d->>'id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (d->>'id')::uuid ELSE gen_random_uuid() END;
 INSERT INTO public.organico_link_utm_v1(id,marca,dia,destino,utm_source,utm_medium,utm_campaign,produto,url,observacao,origem,criado_por)
 VALUES(rid,brand,dia,destino,src,med,camp,slug,final,left(coalesce(d->>'observacao',''),200),'painel',quem)
 ON CONFLICT(id) DO NOTHING RETURNING * INTO existente;
 IF existente.id IS NULL THEN SELECT * INTO existente FROM public.organico_link_utm_v1 WHERE id=rid; RETURN jsonb_build_object('ok',true,'repetido',true,'link',to_jsonb(existente)); END IF;
 RETURN jsonb_build_object('ok',true,'repetido',false,'link',to_jsonb(existente));
END $$;
REVOKE ALL ON FUNCTION public.organico_link_utm_v1(jsonb) FROM PUBLIC;

-- Links históricos da planilha (auditoria de 20/09/2026), preservados como estavam.
INSERT INTO public.organico_link_utm_v1(id,marca,dia,destino,utm_source,utm_medium,utm_campaign,produto,url,observacao,origem,criado_por) VALUES
 ('7a1f0c10-0000-4000-8000-000000000005','aristo','2026-09-09','https://oaristocrata.com/products/alma-da-roca?variant=47452670427298','instagram_social','story','20260909_FRESCOR_DA_MATA','FRESCOR_DA_MATA',
  'https://oaristocrata.com/products/alma-da-roca?variant=47452670427298&utm_source=instagram_social&utm_medium=story&utm_campaign=20260909_FRESCOR_DA_MATA','produto divergente: destino Alma da Roça × campanha Frescor da Mata; sem crédito definido','planilha','planilha da Júlia'),
 ('7a1f0c10-0000-4000-8000-000000000006','aristo',NULL,'https://oaristocrata.com/','instagram_social','linktree','bioinstagram','bioinstagram',
  'https://oaristocrata.com/?utm_source=instagram_social&utm_medium=linktree&utm_campaign=bioinstagram','link da bio','planilha','planilha da Júlia'),
 ('7a1f0c10-0000-4000-8000-000000000017','aristo','2026-09-19','https://oaristocrata.com/pages/kit-misto','instagram_social','story','20260919_semana_do_cliente','semana_do_cliente',
  'https://oaristocrata.com/pages/kit-misto?utm_source=instagram_social&utm_medium=story&utm_campaign=20260919_semana_do_cliente','','planilha','planilha da Júlia'),
 ('7a1f0c10-0000-4000-8000-000000001005','fish','2026-09-15','https://fishermans.com.br/','instagram_social','dm','replient_euquero','replient_euquero',
  'https://fishermans.com.br/?utm_source=instagram_social&utm_medium=dm&utm_campaign=replient_euquero','automação EU QUERO (Replient)','planilha','planilha da Júlia'),
 ('7a1f0c10-0000-4000-8000-000000001006','fish','2026-09-15','https://fishermans.com.br/','instagram_social','story','semana_do_cliente','semana_do_cliente',
  'https://fishermans.com.br/?utm_source=instagram_social&utm_medium=story&utm_campaign=semana_do_cliente','','planilha','planilha da Júlia'),
 ('7a1f0c10-0000-4000-8000-000000001007','fish','2026-09-16','https://fishermans.com.br/products/kit-pesqueiro-raiz','instagram_social','story','kit_pesqueiro_raiz','kit_pesqueiro_raiz',
  'https://fishermans.com.br/products/kit-pesqueiro-raiz?utm_source=instagram_social&utm_medium=story&utm_campaign=kit_pesqueiro_raiz','','planilha','planilha da Júlia'),
 ('7a1f0c10-0000-4000-8000-000000001008','fish','2026-09-16','https://fishermans.com.br/products/kit-duas-aguas','instagram_social','story','20260916_kit_duas_aguas','kit_duas_aguas',
  'https://fishermans.com.br/products/kit-duas-aguas?utm_source=instagram_social&utm_medium=story&utm_campaign=20260916_kit_duas_aguas','','planilha','planilha da Júlia')
ON CONFLICT DO NOTHING;
