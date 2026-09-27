-- Candidatura pelo site ("Seja um Parceiro"), sem ClickUp (27/09/2026). Aplicar DEPOIS de pilot.sql. Idempotente.
--
-- O formulário da LP manda nome, contato, perfis, números declarados (seguidores, views, preço), até 3 prints
-- e o aceite do termo publicado. O aceite grava versão, hash do texto, data, IP e navegador: é a prova da
-- assinatura por clique. Sem termo publicado para a marca, o formulário não aceita candidatura.
-- Cada candidatura vira um candidato 'novo' (source 'formulario_site') na aba Parceiros; a análise e o
-- vínculo continuam sendo da Marcela. Nada aqui gera link, cupom, comissão ou mensagem.

CREATE TABLE IF NOT EXISTS public.crm_partner_terms_v1(
 marca text NOT NULL REFERENCES public.crm_partner_program_v1(marca),
 versao integer NOT NULL CHECK(versao>0),
 titulo text NOT NULL CHECK(length(titulo) BETWEEN 3 AND 160),
 texto text NOT NULL CHECK(length(texto) BETWEEN 200 AND 60000),
 sha256 text NOT NULL,
 origem text NOT NULL DEFAULT '' CHECK(length(origem)<=200),
 criado_em timestamptz NOT NULL DEFAULT now(),
 publicado_em timestamptz,
 retirado_em timestamptz,
 PRIMARY KEY(marca,versao)
);
-- Texto não muda depois de gravado: versão nova é linha nova.
CREATE OR REPLACE FUNCTION public.crm_partner_terms_imutavel_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.texto IS DISTINCT FROM OLD.texto OR NEW.titulo IS DISTINCT FROM OLD.titulo OR NEW.sha256 IS DISTINCT FROM OLD.sha256 THEN
  RAISE EXCEPTION 'Termo gravado não muda; crie uma versão nova';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS crm_partner_terms_imutavel_v1 ON public.crm_partner_terms_v1;
CREATE TRIGGER crm_partner_terms_imutavel_v1 BEFORE UPDATE ON public.crm_partner_terms_v1 FOR EACH ROW EXECUTE FUNCTION public.crm_partner_terms_imutavel_v1();

CREATE TABLE IF NOT EXISTS public.crm_partner_application_v1(
 id uuid PRIMARY KEY,
 marca text NOT NULL REFERENCES public.crm_partner_program_v1(marca),
 candidate_id uuid NOT NULL REFERENCES public.crm_partner_candidate_v1(id),
 nome text NOT NULL,
 email text NOT NULL,
 whatsapp text NOT NULL,
 instagram text NOT NULL DEFAULT '',
 tiktok text NOT NULL DEFAULT '',
 seguidores integer NOT NULL CHECK(seguidores>=0),
 nicho text NOT NULL DEFAULT '',
 cidade text NOT NULL DEFAULT '',
 uf text NOT NULL DEFAULT '',
 views_stories integer CHECK(views_stories>=0),
 views_reels integer CHECK(views_reels>=0),
 preco_story numeric CHECK(preco_story>=0),
 preco_reels numeric CHECK(preco_reels>=0),
 mensagem text NOT NULL DEFAULT '',
 termo_versao integer NOT NULL,
 termo_sha256 text NOT NULL,
 aceite_em timestamptz NOT NULL,
 ip text NOT NULL DEFAULT '',
 navegador text NOT NULL DEFAULT '',
 origem jsonb NOT NULL DEFAULT '{}'::jsonb,
 criado_em timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(marca,termo_versao) REFERENCES public.crm_partner_terms_v1(marca,versao)
);
CREATE INDEX IF NOT EXISTS crm_partner_application_dup_v1 ON public.crm_partner_application_v1(marca,lower(instagram),lower(email),criado_em);
CREATE INDEX IF NOT EXISTS crm_partner_application_ip_v1 ON public.crm_partner_application_v1(ip,criado_em);
CREATE TABLE IF NOT EXISTS public.crm_partner_application_file_v1(
 id uuid PRIMARY KEY,
 application_id uuid NOT NULL REFERENCES public.crm_partner_application_v1(id),
 ordem integer NOT NULL CHECK(ordem BETWEEN 1 AND 3),
 tipo text NOT NULL CHECK(tipo IN ('stories','reels','outro')),
 mime text NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp')),
 bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 3145728),
 sha256 text NOT NULL,
 conteudo bytea NOT NULL,
 UNIQUE(application_id,ordem)
);
-- Pedidos já respondidos: repetir o mesmo envio devolve o mesmo protocolo, sem gravar de novo.
CREATE TABLE IF NOT EXISTS public.crm_partner_application_request_v1(
 request_id uuid PRIMARY KEY,
 application_id uuid REFERENCES public.crm_partner_application_v1(id),
 resposta jsonb NOT NULL,
 criado_em timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.crm_partner_terms_v1,public.crm_partner_application_v1,public.crm_partner_application_file_v1,public.crm_partner_application_request_v1 FROM PUBLIC;

-- Termo publicado da marca (o que a LP mostra e o candidato aceita).
CREATE OR REPLACE FUNCTION public.crm_partner_termo_vigente_v1(brand text)
RETURNS public.crm_partner_terms_v1 LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT t.* FROM public.crm_partner_terms_v1 t WHERE t.marca=brand AND t.publicado_em IS NOT NULL AND t.publicado_em<=now() AND t.retirado_em IS NULL
 ORDER BY t.versao DESC LIMIT 1
$$;

-- Entrada pública. p: {acao:'termo'|'enviar', marca, request_id, data:{...}, ip, navegador}.
-- ip e navegador vêm do servidor (cabeçalhos da requisição), nunca do corpo que o navegador monta.
CREATE OR REPLACE FUNCTION public.crm_partner_candidatura_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE brand text:=p->>'marca'; d jsonb:=coalesce(p->'data','{}'::jsonb); t public.crm_partner_terms_v1; rid uuid; aid uuid; cid uuid;
 v_nome text; v_email text; v_zap text; ig text; tt text; seg bigint; vs bigint; vr bigint; ps numeric; pr numeric; v_uf text; f jsonb; bin bytea; v_mime text; n int:=0;
 prev public.crm_partner_application_request_v1; dup uuid; v_ip text:=left(coalesce(p->>'ip',''),64); resp jsonb; v_tipo text;
 UFS text[]:=ARRAY['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
BEGIN
 IF brand NOT IN ('aristo','fish') THEN RETURN jsonb_build_object('erro','Marca inválida.'); END IF;
 t:=public.crm_partner_termo_vigente_v1(brand);
 IF p->>'acao'='termo' THEN
  IF t.versao IS NULL THEN RETURN jsonb_build_object('ok',false,'aberto',false,'mensagem','As inscrições abrem em breve.'); END IF;
  RETURN jsonb_build_object('ok',true,'aberto',true,'versao',t.versao,'titulo',t.titulo,'texto',t.texto,'sha256',t.sha256,
   'comissao',(SELECT rate FROM public.crm_partner_program_v1 WHERE marca=brand),'dia_pagamento',(SELECT payment_day FROM public.crm_partner_program_v1 WHERE marca=brand));
 END IF;
 IF p->>'acao' IS DISTINCT FROM 'enviar' THEN RETURN jsonb_build_object('erro','Ação inválida.'); END IF;
 IF coalesce(p->>'request_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN jsonb_build_object('erro','Envio inválido. Recarregue a página.'); END IF;
 rid:=(p->>'request_id')::uuid;
 SELECT * INTO prev FROM public.crm_partner_application_request_v1 WHERE request_id=rid;
 IF FOUND THEN RETURN prev.resposta; END IF;
 IF t.versao IS NULL THEN RETURN jsonb_build_object('erro','As inscrições estão fechadas no momento.'); END IF;
 IF (d->>'termo_versao') IS DISTINCT FROM t.versao::text OR (d->>'termo_sha256') IS DISTINCT FROM t.sha256 THEN
  RETURN jsonb_build_object('erro','O termo foi atualizado. Recarregue a página e leia a versão nova.');
 END IF;
 IF (d->'aceite') IS DISTINCT FROM 'true'::jsonb THEN RETURN jsonb_build_object('erro','Para enviar, marque que leu e aceita o termo.'); END IF;
 -- Limite por origem: até 5 envios por hora do mesmo IP (a LP também tem campo-isca e tempo mínimo).
 IF v_ip<>'' AND (SELECT count(*) FROM public.crm_partner_application_v1 a WHERE a.ip=v_ip AND a.criado_em>now()-interval '1 hour')>=5 THEN
  RETURN jsonb_build_object('erro','Muitos envios em sequência. Tente de novo mais tarde.');
 END IF;
 v_nome:=btrim(regexp_replace(coalesce(d->>'nome',''),'\s+',' ','g'));
 v_email:=lower(btrim(coalesce(d->>'email','')));
 v_zap:=regexp_replace(coalesce(d->>'whatsapp',''),'\D','','g');
 ig:=lower(regexp_replace(btrim(coalesce(d->>'instagram','')),'^@',''));
 tt:=lower(regexp_replace(btrim(coalesce(d->>'tiktok','')),'^@',''));
 v_uf:=upper(btrim(coalesce(d->>'uf','')));
 IF length(v_nome) NOT BETWEEN 2 AND 120 THEN RETURN jsonb_build_object('erro','Informe seu nome.','campo','nome'); END IF;
 IF v_email !~ '^[^@\s]{1,64}@[^@\s]+\.[a-z]{2,}$' OR length(v_email)>160 THEN RETURN jsonb_build_object('erro','E-mail inválido.','campo','email'); END IF;
 IF length(v_zap)=10 OR length(v_zap)=11 THEN v_zap:='55'||v_zap; END IF;
 IF v_zap !~ '^55\d{10,11}$' THEN RETURN jsonb_build_object('erro','WhatsApp inválido. Use DDD + número.','campo','whatsapp'); END IF;
 IF ig='' AND tt='' THEN RETURN jsonb_build_object('erro','Informe seu Instagram ou TikTok.','campo','instagram'); END IF;
 IF (ig<>'' AND ig !~ '^[a-z0-9._]{1,30}$') THEN RETURN jsonb_build_object('erro','Instagram inválido.','campo','instagram'); END IF;
 IF (tt<>'' AND tt !~ '^[a-z0-9._]{2,24}$') THEN RETURN jsonb_build_object('erro','TikTok inválido.','campo','tiktok'); END IF;
 IF coalesce(d->>'seguidores','') !~ '^\d{1,9}$' THEN RETURN jsonb_build_object('erro','Informe quantos seguidores você tem.','campo','seguidores'); END IF;
 seg:=(d->>'seguidores')::bigint;
 vs:=CASE WHEN coalesce(d->>'views_stories','') ~ '^\d{1,9}$' THEN (d->>'views_stories')::bigint END;
 vr:=CASE WHEN coalesce(d->>'views_reels','') ~ '^\d{1,9}$' THEN (d->>'views_reels')::bigint END;
 IF coalesce(vs,0)=0 AND coalesce(vr,0)=0 THEN RETURN jsonb_build_object('erro','Informe a média de views dos stories ou dos reels.','campo','views_stories'); END IF;
 ps:=CASE WHEN coalesce(d->>'preco_story','') ~ '^\d{1,6}([.,]\d{1,2})?$' THEN replace(d->>'preco_story',',','.')::numeric END;
 pr:=CASE WHEN coalesce(d->>'preco_reels','') ~ '^\d{1,6}([.,]\d{1,2})?$' THEN replace(d->>'preco_reels',',','.')::numeric END;
 IF v_uf<>'' AND NOT v_uf=ANY(UFS) THEN RETURN jsonb_build_object('erro','Estado inválido.','campo','uf'); END IF;
 IF jsonb_typeof(d->'prints') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'prints') NOT BETWEEN 1 AND 3 THEN
  RETURN jsonb_build_object('erro','Anexe de 1 a 3 prints das suas views.','campo','prints');
 END IF;
 -- Mesma pessoa na mesma marca em 30 dias: não duplica, devolve o protocolo que já existe.
 SELECT a.id INTO dup FROM public.crm_partner_application_v1 a WHERE a.marca=brand AND a.criado_em>now()-interval '30 days'
  AND ((ig<>'' AND lower(a.instagram)=ig) OR lower(a.email)=v_email) ORDER BY a.criado_em DESC LIMIT 1;
 IF dup IS NOT NULL THEN
  resp:=jsonb_build_object('ok',true,'repetida',true,'protocolo',upper(left(replace(dup::text,'-',''),8)));
  INSERT INTO public.crm_partner_application_request_v1(request_id,application_id,resposta) VALUES(rid,dup,resp) ON CONFLICT DO NOTHING;
  RETURN resp;
 END IF;
 aid:=gen_random_uuid(); cid:=gen_random_uuid();
 INSERT INTO public.crm_partner_candidate_v1(id,marca,name,handle,source,source_reference,state,note,version,actor)
 VALUES(cid,brand,v_nome,CASE WHEN ig<>'' THEN '@'||ig ELSE '@'||tt END,'formulario_site',aid::text,'novo',
  left(concat_ws(' · ',CASE WHEN tt<>'' AND ig<>'' THEN 'TikTok @'||tt END,seg||' seguidores',nullif(btrim(coalesce(d->>'nicho','')),'')),1000),1,'formulario_site');
 INSERT INTO public.crm_partner_application_v1(id,marca,candidate_id,nome,email,whatsapp,instagram,tiktok,seguidores,nicho,cidade,uf,views_stories,views_reels,
  preco_story,preco_reels,mensagem,termo_versao,termo_sha256,aceite_em,ip,navegador,origem)
 VALUES(aid,brand,cid,v_nome,v_email,v_zap,ig,tt,seg::int,left(btrim(coalesce(d->>'nicho','')),80),left(btrim(coalesce(d->>'cidade','')),80),v_uf,vs::int,vr::int,ps,pr,
  left(btrim(coalesce(d->>'mensagem','')),1000),t.versao,t.sha256,now(),v_ip,left(coalesce(p->>'navegador',''),300),
  (SELECT coalesce(jsonb_object_agg(k,left(v,120)),'{}'::jsonb) FROM jsonb_each_text(CASE WHEN jsonb_typeof(d->'origem')='object' THEN d->'origem' ELSE '{}'::jsonb END) e(k,v)
    WHERE k IN ('utm_source','utm_medium','utm_campaign','utm_content','ref','pagina')));
 FOR f IN SELECT * FROM jsonb_array_elements(d->'prints') LOOP
  n:=n+1; v_mime:=f->>'mime'; v_tipo:=coalesce(f->>'tipo','outro');
  IF v_mime NOT IN ('image/jpeg','image/png','image/webp') OR v_tipo NOT IN ('stories','reels','outro') THEN RAISE EXCEPTION 'print_invalido'; END IF;
  bin:=decode(coalesce(f->>'base64',''),'base64');
  IF length(bin) NOT BETWEEN 100 AND 3145728 THEN RAISE EXCEPTION 'print_tamanho'; END IF;
  -- O conteúdo precisa ser mesmo a imagem declarada (assinatura dos primeiros bytes).
  IF NOT ((v_mime='image/jpeg' AND substring(bin from 1 for 3)='\xffd8ff'::bytea)
       OR (v_mime='image/png' AND substring(bin from 1 for 8)='\x89504e470d0a1a0a'::bytea)
       OR (v_mime='image/webp' AND substring(bin from 1 for 4)='RIFF'::bytea AND substring(bin from 9 for 4)='WEBP'::bytea)) THEN
   RAISE EXCEPTION 'print_invalido';
  END IF;
  INSERT INTO public.crm_partner_application_file_v1(id,application_id,ordem,tipo,mime,bytes,sha256,conteudo)
  VALUES(gen_random_uuid(),aid,n,v_tipo,v_mime,length(bin),encode(sha256(bin),'hex'),bin);
 END LOOP;
 resp:=jsonb_build_object('ok',true,'repetida',false,'protocolo',upper(left(replace(aid::text,'-',''),8)));
 INSERT INTO public.crm_partner_application_request_v1(request_id,application_id,resposta) VALUES(rid,aid,resp);
 RETURN resp;
EXCEPTION WHEN raise_exception OR invalid_parameter_value OR data_exception THEN
 IF SQLERRM IN ('print_invalido','print_tamanho') OR SQLSTATE LIKE '22%' THEN
  RETURN jsonb_build_object('erro','Um dos prints não é uma imagem válida (JPG, PNG ou WebP, até 3 MB).','campo','prints');
 END IF;
 RAISE;
END $$;

-- Leitura do painel (chave de Influs). Sem o conteúdo das imagens; cada print é pedido à parte.
CREATE OR REPLACE FUNCTION public.crm_partner_candidatura_painel_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE op jsonb; fl public.crm_partner_application_file_v1;
BEGIN
 op:=public.shrigma_panel_operator_v1(p->>'k','influs');
 IF op IS NULL THEN RETURN jsonb_build_object('erro','Entre com a chave do painel de Influs.'); END IF;
 IF p->>'acao'='ler' THEN
  RETURN jsonb_build_object('ok',true,
   'termos',(SELECT coalesce(jsonb_agg(jsonb_build_object('marca',t.marca,'versao',t.versao,'titulo',t.titulo,'publicado_em',t.publicado_em,'retirado_em',t.retirado_em) ORDER BY t.marca,t.versao DESC),'[]') FROM public.crm_partner_terms_v1 t),
   'candidaturas',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'candidate_id',a.candidate_id,'marca',a.marca,'nome',a.nome,'email',a.email,'whatsapp',a.whatsapp,
     'instagram',a.instagram,'tiktok',a.tiktok,'seguidores',a.seguidores,'nicho',a.nicho,'cidade',a.cidade,'uf',a.uf,'views_stories',a.views_stories,'views_reels',a.views_reels,
     'preco_story',a.preco_story,'preco_reels',a.preco_reels,
     'cpm_story',CASE WHEN a.preco_story IS NOT NULL AND a.views_stories>0 THEN round(a.preco_story/a.views_stories*1000,2) END,
     'cpm_reels',CASE WHEN a.preco_reels IS NOT NULL AND a.views_reels>0 THEN round(a.preco_reels/a.views_reels*1000,2) END,
     'mensagem',a.mensagem,'termo_versao',a.termo_versao,'aceite_em',a.aceite_em,'origem',a.origem,'criado_em',a.criado_em,
     'estado',(SELECT c.state FROM public.crm_partner_candidate_v1 c WHERE c.id=a.candidate_id),
     'prints',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'ordem',f.ordem,'tipo',f.tipo,'mime',f.mime,'bytes',f.bytes) ORDER BY f.ordem),'[]')
       FROM public.crm_partner_application_file_v1 f WHERE f.application_id=a.id)) ORDER BY a.criado_em DESC),'[]')
    FROM (SELECT * FROM public.crm_partner_application_v1 WHERE criado_em>now()-interval '180 days' ORDER BY criado_em DESC LIMIT 300) a));
 END IF;
 IF p->>'acao'='print' THEN
  IF coalesce(p->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN jsonb_build_object('erro','Print inválido.'); END IF;
  SELECT * INTO fl FROM public.crm_partner_application_file_v1 WHERE id=(p->>'id')::uuid;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','Print não encontrado.'); END IF;
  RETURN jsonb_build_object('ok',true,'mime',fl.mime,'base64',replace(encode(fl.conteudo,'base64'),E'\n',''));
 END IF;
 RETURN jsonb_build_object('erro','Ação inválida.');
END $$;

REVOKE ALL ON FUNCTION public.crm_partner_termo_vigente_v1(text),public.crm_partner_candidatura_v1(jsonb),public.crm_partner_candidatura_painel_v1(jsonb) FROM PUBLIC;
