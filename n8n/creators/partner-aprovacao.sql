-- Aprovação do parceiro do site (28/09/2026). Um clique no painel deixa o parceiro funcionando:
--   1. cupom na Shopify (mesmo padrão dos cupons de influ: % em todos os produtos, sem acumular, sem limite);
--   2. cadastro em crm_influ + crm_cupom: o coletor de cupom passa a atribuir as vendas sozinho;
--   3. link de parceiro ativo (utm_source=parceiro, utm_content=p-xxxxxxxx);
--   4. envio do produto como pendente, até a Marcela marcar enviado.
-- A chamada à Shopify fica no workflow (partner-aprovacao-workflow.cjs). Aqui: preparar (valida e reserva o
-- código), concluir (grava tudo numa transação), envio e leitura. Aplicar DEPOIS de partner-operacao.sql. Idempotente.

-- Desconto do cupom por marca: o mesmo dos cupons de influ que já existem (medido em 28/09: Aristo 6%, Fish 5%).
ALTER TABLE public.crm_partner_program_v1 ADD COLUMN IF NOT EXISTS cupom_desconto numeric;
UPDATE public.crm_partner_program_v1 SET cupom_desconto=CASE marca WHEN 'aristo' THEN 0.06 WHEN 'fish' THEN 0.05 END WHERE cupom_desconto IS NULL;

CREATE TABLE IF NOT EXISTS public.crm_partner_parceiro_v1(
 candidate_id uuid PRIMARY KEY REFERENCES public.crm_partner_candidate_v1(id),
 marca text NOT NULL REFERENCES public.crm_partner_program_v1(marca),
 influ text NOT NULL,
 cupom text NOT NULL CHECK(cupom ~ '^[A-Z0-9]{3,30}$'),
 ref text NOT NULL UNIQUE REFERENCES public.crm_partner_link_v1(ref),
 shopify_node_id text NOT NULL,
 cupom_origem text NOT NULL CHECK(cupom_origem IN ('criado','existente')),
 desconto numeric NOT NULL CHECK(desconto>0 AND desconto<1),
 envio_estado text NOT NULL DEFAULT 'pendente' CHECK(envio_estado IN ('pendente','enviado')),
 envio_rastreio text NOT NULL DEFAULT '' CHECK(length(envio_rastreio)<=80),
 envio_em timestamptz,
 envio_por text NOT NULL DEFAULT '',
 aprovado_em timestamptz NOT NULL DEFAULT now(),
 aprovado_por text NOT NULL,
 atualizado_em timestamptz NOT NULL DEFAULT now(),
 UNIQUE(marca,cupom),UNIQUE(marca,influ)
);
CREATE TABLE IF NOT EXISTS public.crm_partner_aprovacao_req_v1(
 request_id uuid PRIMARY KEY,
 candidate_id uuid NOT NULL REFERENCES public.crm_partner_candidate_v1(id),
 marca text NOT NULL,
 codigo text NOT NULL,
 desconto numeric NOT NULL,
 actor text NOT NULL,
 estado text NOT NULL CHECK(estado IN ('preparado','concluido')),
 resposta jsonb,
 criado_em timestamptz NOT NULL DEFAULT now(),
 atualizado_em timestamptz NOT NULL DEFAULT now()
);
-- Encerrar a parceria (28/09/2026): o link para de contar e a comissão para a partir do dia; o cupom segue
-- ativo e as vendas continuam atribuídas ao creator em Influs (crm_influ_termo com modelo 'encerrado', 0%).
ALTER TABLE public.crm_partner_parceiro_v1 ADD COLUMN IF NOT EXISTS encerrado_em timestamptz;
ALTER TABLE public.crm_partner_parceiro_v1 ADD COLUMN IF NOT EXISTS encerrado_por text NOT NULL DEFAULT '';
REVOKE ALL ON public.crm_partner_parceiro_v1,public.crm_partner_aprovacao_req_v1 FROM PUBLIC;

-- Código sugerido a partir do @: só letras e números, maiúsculo, até 20.
CREATE OR REPLACE FUNCTION public.crm_partner_codigo_sugerido_v1(ig text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT left(upper(regexp_replace(translate(coalesce(ig,''),'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'),'[^A-Za-z0-9]','','g')),20)
$$;

-- p: {k, acao, request_id, data}. acao: ler | preparar | concluir | envio.
CREATE OR REPLACE FUNCTION public.crm_partner_aprovacao_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE op jsonb; quem text; actor_id text; acao text:=p->>'acao'; d jsonb:=coalesce(p->'data','{}'::jsonb); rid uuid; cid uuid;
 c public.crm_partner_candidate_v1; a record; pr public.crm_partner_program_v1; rq public.crm_partner_aprovacao_req_v1;
 cod text; slug text; base_slug text; px public.crm_partner_parceiro_v1; n int:=1; novo_ref text; url text; resp jsonb; v_nicho text; ig text; hoje date:=(now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
 op:=public.shrigma_panel_operator_v1(p->>'k','influs');
 IF op IS NULL THEN RETURN jsonb_build_object('erro','Entre com a chave do painel de Influs.'); END IF;
 actor_id:=coalesce(op->>'who','painel');quem:=left(coalesce(nullif(btrim(op->>'label'),''),'painel'),40);
 IF acao='ler' THEN
  RETURN jsonb_build_object('ok',true,'pode_escrever',coalesce(op->'caps' ? 'creators_edit',false),
   'descontos',(SELECT jsonb_object_agg(marca,cupom_desconto) FROM public.crm_partner_program_v1),
   'parceiros',(SELECT coalesce(jsonb_agg(jsonb_build_object('candidate_id',x.candidate_id,'marca',x.marca,'influ',x.influ,'cupom',x.cupom,'ref',x.ref,
     'url',public.crm_partner_link_url_v1(x.marca,x.ref),'link_estado',l.state,'desconto',x.desconto,'cupom_origem',x.cupom_origem,
     'envio_estado',x.envio_estado,'envio_rastreio',x.envio_rastreio,'envio_em',x.envio_em,'aprovado_em',x.aprovado_em,'aprovado_por',x.aprovado_por,
     'encerrado_em',x.encerrado_em,'encerrado_por',x.encerrado_por)),'[]')
    FROM public.crm_partner_parceiro_v1 x JOIN public.crm_partner_link_v1 l ON l.ref=x.ref));
 END IF;
 IF NOT coalesce(op->'caps' ? 'creators_edit',false) THEN RETURN jsonb_build_object('erro','Esta chave só lê. Aprovar parceiro pede a chave de gestão de Influs.'); END IF;
 IF acao='envio' THEN
  IF coalesce(d->>'candidate_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR coalesce(d->>'estado','') NOT IN ('pendente','enviado') THEN RETURN jsonb_build_object('erro','Envio inválido.'); END IF;
  IF length(coalesce(d->>'rastreio',''))>80 THEN RETURN jsonb_build_object('erro','Rastreio longo demais.'); END IF;
  UPDATE public.crm_partner_parceiro_v1 SET envio_estado=d->>'estado',envio_rastreio=CASE WHEN d->>'estado'='enviado' THEN btrim(coalesce(d->>'rastreio','')) ELSE '' END,
   envio_em=CASE WHEN d->>'estado'='enviado' THEN now() END,envio_por=quem,atualizado_em=now()
  WHERE candidate_id=(d->>'candidate_id')::uuid;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','Parceiro aprovado não encontrado.'); END IF;
  RETURN jsonb_build_object('ok',true,'mensagem',CASE d->>'estado' WHEN 'enviado' THEN 'Envio marcado.' ELSE 'Envio voltou para pendente.' END);
 END IF;
 IF acao='encerrar' THEN
  IF coalesce(d->>'candidate_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN jsonb_build_object('erro','Parceiro inválido.'); END IF;
  cid:=(d->>'candidate_id')::uuid;
  PERFORM pg_advisory_xact_lock(hashtextextended('partner-aprovar:'||cid,0));
  SELECT * INTO px FROM public.crm_partner_parceiro_v1 WHERE candidate_id=cid FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','Parceiro aprovado não encontrado.'); END IF;
  IF px.encerrado_em IS NOT NULL THEN RETURN jsonb_build_object('ok',true,'repetido',true,'mensagem','Parceria já estava encerrada.'); END IF;
  -- Histórico de comissão: termo do início (se faltar) e termo de fim hoje, com 0%. O coletor usa o termo do dia do pedido.
  INSERT INTO public.crm_influ_termo(marca,influ,vigente_desde,modelo,comissao_pct,autor)
   SELECT px.marca,px.influ,(px.aprovado_em AT TIME ZONE 'America/Sao_Paulo')::date,'comissao',pp.rate,quem FROM public.crm_partner_program_v1 pp WHERE pp.marca=px.marca ON CONFLICT DO NOTHING;
  INSERT INTO public.crm_influ_termo(marca,influ,vigente_desde,modelo,comissao_pct,autor) VALUES(px.marca,px.influ,hoje,'encerrado',0,quem)
   ON CONFLICT(marca,influ,vigente_desde) DO UPDATE SET modelo='encerrado',comissao_pct=0,autor=EXCLUDED.autor;
  -- O creator continua ativo: é isso que mantém o cupom atribuindo as vendas em Influs.
  UPDATE public.crm_influ SET modelo='encerrado',obs=left(obs||' Parceria encerrada em '||to_char(hoje,'DD/MM/YYYY')||' por '||quem||'; cupom segue ativo.',2000),atualizado_em=now()
   WHERE marca=px.marca AND influ=px.influ;
  UPDATE public.crm_partner_link_v1 SET state='revogado',version=version+1,actor=actor_id,updated_at=now() WHERE ref=px.ref AND state<>'revogado';
  UPDATE public.crm_partner_candidate_v1 SET state='pausado',version=version+1,actor=actor_id,updated_at=now() WHERE id=cid AND state<>'pausado';
  UPDATE public.crm_partner_parceiro_v1 SET encerrado_em=now(),encerrado_por=quem,atualizado_em=now() WHERE candidate_id=cid;
  RETURN jsonb_build_object('ok',true,'mensagem','Parceria encerrada: link desligado e comissão zerada a partir de hoje. O cupom '||px.cupom||' segue ativo.');
 END IF;
 IF coalesce(p->>'request_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN jsonb_build_object('erro','Operação inválida. Recarregue.'); END IF;
 rid:=(p->>'request_id')::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended('partner-aprovacao:'||rid,0));
 SELECT * INTO rq FROM public.crm_partner_aprovacao_req_v1 WHERE request_id=rid;
 IF acao='preparar' THEN
  IF FOUND THEN
   IF rq.estado='concluido' THEN RETURN rq.resposta||jsonb_build_object('repetido',true); END IF;
   RETURN jsonb_build_object('ok',true,'request_id',rid,'marca',rq.marca,'codigo',rq.codigo,'desconto',rq.desconto,'titulo',rq.codigo);
  END IF;
  IF coalesce(d->>'candidate_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN jsonb_build_object('erro','Candidato inválido.'); END IF;
  cid:=(d->>'candidate_id')::uuid;
  PERFORM pg_advisory_xact_lock(hashtextextended('partner-aprovar:'||cid,0));
  SELECT * INTO c FROM public.crm_partner_candidate_v1 WHERE id=cid;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','Candidato não encontrado.'); END IF;
  IF EXISTS(SELECT 1 FROM public.crm_partner_parceiro_v1 WHERE candidate_id=cid) THEN RETURN jsonb_build_object('erro','Este parceiro já foi aprovado.'); END IF;
  IF c.state NOT IN ('novo','em_analise') THEN RETURN jsonb_build_object('erro','Só candidatura nova ou em análise pode ser aprovada.'); END IF;
  cod:=upper(btrim(coalesce(d->>'codigo','')));
  IF cod !~ '^[A-Z0-9]{3,30}$' THEN RETURN jsonb_build_object('erro','Cupom: de 3 a 30 letras ou números, sem espaço nem acento.','campo','codigo'); END IF;
  IF EXISTS(SELECT 1 FROM public.crm_cupom WHERE marca=c.marca AND codigo=cod) THEN RETURN jsonb_build_object('erro','O cupom '||cod||' já está cadastrado nesta marca. Escolha outro.','campo','codigo'); END IF;
  IF EXISTS(SELECT 1 FROM public.crm_partner_aprovacao_req_v1 r WHERE r.marca=c.marca AND r.codigo=cod AND r.estado='preparado' AND r.candidate_id<>cid) THEN
   RETURN jsonb_build_object('erro','O cupom '||cod||' está reservado para outra aprovação em andamento.','campo','codigo');
  END IF;
  SELECT * INTO pr FROM public.crm_partner_program_v1 WHERE marca=c.marca;
  IF pr.cupom_desconto IS NULL THEN RETURN jsonb_build_object('erro','Desconto do cupom não configurado para a marca.'); END IF;
  INSERT INTO public.crm_partner_aprovacao_req_v1(request_id,candidate_id,marca,codigo,desconto,actor,estado) VALUES(rid,cid,c.marca,cod,pr.cupom_desconto,actor_id,'preparado');
  RETURN jsonb_build_object('ok',true,'request_id',rid,'marca',c.marca,'codigo',cod,'desconto',pr.cupom_desconto,'titulo',cod);
 END IF;
 IF acao='concluir' THEN
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','Aprovação não preparada. Recarregue e tente de novo.'); END IF;
  IF rq.estado='concluido' THEN RETURN rq.resposta||jsonb_build_object('repetido',true); END IF;
  -- Erro da Shopify vem do workflow: devolve como está e a reserva fica para nova tentativa com o mesmo pedido.
  IF d ? 'erro' THEN RETURN jsonb_build_object('erro',left(coalesce(d->>'erro','Não foi possível criar o cupom.'),400),'campo',d->>'campo'); END IF;
  IF coalesce(d->>'node_id','') !~ '^gid://shopify/DiscountCodeNode/[0-9]+$' OR coalesce(d->>'origem','') NOT IN ('criado','existente') THEN RETURN jsonb_build_object('erro','Resposta da Shopify incompleta.'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('partner-aprovar:'||rq.candidate_id,0));
  SELECT * INTO c FROM public.crm_partner_candidate_v1 WHERE id=rq.candidate_id FOR UPDATE;
  IF c.state NOT IN ('novo','em_analise') OR EXISTS(SELECT 1 FROM public.crm_partner_parceiro_v1 WHERE candidate_id=c.id) THEN RETURN jsonb_build_object('erro','O cadastro mudou durante a aprovação. Recarregue.'); END IF;
  IF EXISTS(SELECT 1 FROM public.crm_cupom WHERE marca=rq.marca AND codigo=rq.codigo) THEN RETURN jsonb_build_object('erro','O cupom '||rq.codigo||' foi cadastrado por outra pessoa agora. Recarregue.'); END IF;
  SELECT * INTO a FROM public.crm_partner_application_v1 WHERE candidate_id=c.id ORDER BY criado_em DESC LIMIT 1;
  SELECT * INTO pr FROM public.crm_partner_program_v1 WHERE marca=rq.marca;
  ig:=coalesce(nullif(a.instagram,''),nullif(lower(regexp_replace(btrim(c.handle),'^@','')),''));
  -- slug do creator: o código em minúsculo; se já existir na marca, ganha -2, -3...
  base_slug:=lower(rq.codigo);slug:=base_slug;
  WHILE EXISTS(SELECT 1 FROM public.crm_influ WHERE marca=rq.marca AND influ=slug) LOOP n:=n+1;slug:=base_slug||'-'||n; END LOOP;
  v_nicho:=lower(btrim(regexp_replace(coalesce(a.nicho,''),'\s+',' ','g')));
  IF length(v_nicho) NOT BETWEEN 2 AND 40 THEN v_nicho:=NULL; END IF;
  INSERT INTO public.crm_influ(marca,influ,nome,handle,comissao_pct,ativo,desde,obs,seguidores,modelo,nicho)
  VALUES(rq.marca,slug,left(coalesce(nullif(a.nome,''),c.name),120),CASE WHEN ig IS NOT NULL THEN '@'||ig ELSE '' END,pr.rate,true,hoje,
   'Parceiro do site: candidatura '||upper(left(coalesce(a.id::text,c.id::text),8))||', aprovado por '||quem||' em '||to_char(hoje,'DD/MM/YYYY')||'.',a.seguidores,'comissao',v_nicho);
  -- histórico de comissão por data: o coletor de cupom usa o termo vigente no dia do pedido
  INSERT INTO public.crm_influ_termo(marca,influ,vigente_desde,modelo,comissao_pct,autor) VALUES(rq.marca,slug,hoje,'comissao',pr.rate,quem) ON CONFLICT DO NOTHING;
  INSERT INTO public.crm_cupom(marca,codigo,tipo,influ,desconto_pct,desde,shopify_node_id,obs)
  VALUES(rq.marca,rq.codigo,'influ',slug,rq.desconto,hoje,d->>'node_id','Parceiro do site ('||CASE d->>'origem' WHEN 'criado' THEN 'criado pelo painel' ELSE 'já existia na loja' END||').');
  INSERT INTO public.crm_cupom_log(em,marca,codigo,campo,de,para,autor,origem) VALUES(now(),rq.marca,rq.codigo,'cadastro','',slug,quem,'parceiros-aprovacao');
  LOOP novo_ref:='p-'||substr(md5(random()::text||clock_timestamp()::text),1,8);EXIT WHEN NOT EXISTS(SELECT 1 FROM public.crm_partner_link_v1 WHERE ref=novo_ref); END LOOP;
  UPDATE public.crm_partner_link_v1 SET state='revogado',version=version+1,actor=actor_id,updated_at=now() WHERE candidate_id=c.id AND state<>'revogado';
  INSERT INTO public.crm_partner_link_v1(ref,candidate_id,marca,state,version,actor) VALUES(novo_ref,c.id,rq.marca,'ativo',1,actor_id);
  UPDATE public.crm_partner_candidate_v1 SET state='aprovado_piloto',version=version+1,actor=actor_id,updated_at=now() WHERE id=c.id;
  INSERT INTO public.crm_partner_parceiro_v1(candidate_id,marca,influ,cupom,ref,shopify_node_id,cupom_origem,desconto,aprovado_por)
  VALUES(c.id,rq.marca,slug,rq.codigo,novo_ref,d->>'node_id',d->>'origem',rq.desconto,quem);
  url:=public.crm_partner_link_url_v1(rq.marca,novo_ref);
  resp:=jsonb_build_object('ok',true,'request_id',rid,'candidate_id',c.id,'marca',rq.marca,'influ',slug,'cupom',rq.codigo,'desconto',rq.desconto,'ref',novo_ref,'url',url,
   'cupom_origem',d->>'origem','mensagem','Parceiro aprovado: cupom '||rq.codigo||' e link ativos.');
  UPDATE public.crm_partner_aprovacao_req_v1 SET estado='concluido',resposta=resp,atualizado_em=now() WHERE request_id=rid;
  RETURN resp;
 END IF;
 RETURN jsonb_build_object('erro','Ação inválida.');
END $$;
REVOKE ALL ON FUNCTION public.crm_partner_codigo_sugerido_v1(text),public.crm_partner_aprovacao_v1(jsonb) FROM PUBLIC;
