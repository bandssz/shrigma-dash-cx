-- Query contract only; no production rows, credentials or workflow export.
with prev as (select chave, estado, alertado_em from shrigma_wa_fluxo_saude),
gat as (
  select e.brand, case e.piece when 'pedido-confirmado' then 'pedido-pago' else 'rastreio-criado' end as piece,
         count(distinct e.ref)::int as n_gatilho,
         count(distinct e.ref) filter (where exists (
           select 1 from shrigma_send_log w where w.channel='whatsapp' and w.brand=e.brand and w.flow='transacional' and w.ref=e.ref
             and w.piece = case e.piece when 'pedido-confirmado' then 'pedido-pago' else 'rastreio-criado' end))::int as n_saida
  from shrigma_send_log e
  where e.channel='email' and e.flow='transacional' and e.brand in ('fish','aristo')
    and e.piece in ('pedido-confirmado','pedido-preparando') and e.ref is not null
    and e.sent_at between now() - interval '2 hours' and now() - interval '15 minutes'
  group by 1,2),
ace as (
  select l.brand, count(*)::int as n_aceites,
         count(*) filter (where exists (select 1 from shrigma_wa_status s where s.wamid=l.wamid))::int as n_status,
         count(*) filter (where exists (select 1 from shrigma_wa_status s where s.wamid=l.wamid and s.status='failed'))::int as n_falhas
  from shrigma_send_log l
  where l.channel='whatsapp' and l.brand in ('fish','aristo') and l.wamid is not null
    and l.sent_at between now() - interval '75 minutes' and now() - interval '15 minutes'
  group by 1),
lin as (
  select 'gatilho:'||brand||':'||piece as chave, brand, 'Gatilho → WhatsApp · '||brand||' · '||piece as nome,
         n_gatilho, n_saida, null::int n_aceites, null::int n_status, null::int n_falhas,
         case when n_gatilho >= 5 and n_saida = 0 then 'alerta' else 'ok' end as estado,
         case when n_gatilho >= 5 and n_saida = 0 then n_gatilho||' e-mails de gatilho nas últimas 2h e nenhuma linha WhatsApp correspondente (nem sombra)' end as motivo
  from gat
  union all
  select 'aceite:'||brand, brand, 'Aceite → status Meta · '||brand||' · transacional', null, null, n_aceites, n_status, n_falhas,
         case when n_aceites >= 5 and n_status = 0 then 'alerta'
              when n_aceites >= 10 and n_falhas::numeric / n_aceites > 0.2 then 'alerta' else 'ok' end,
         case when n_aceites >= 5 and n_status = 0 then n_aceites||' aceites (wamid) na última hora e nenhum status recebido da Meta'
              when n_aceites >= 10 and n_falhas::numeric / n_aceites > 0.2 then n_falhas||' falhas em '||n_aceites||' aceites ('||round(100*n_falhas::numeric/n_aceites)||'%)' end
  from ace),
up as (
  insert into shrigma_wa_fluxo_saude as t (chave,brand,nome,verificado_em,n_gatilho,n_saida,n_aceites,n_status,n_falhas,estado,motivo,alerta_desde,alertado_em)
  select chave,brand,nome,now(),n_gatilho,n_saida,n_aceites,n_status,n_falhas,estado,motivo,
         case when estado='alerta' then now() end, null from lin
  on conflict (chave) do update set
    verificado_em=excluded.verificado_em, n_gatilho=excluded.n_gatilho, n_saida=excluded.n_saida, n_aceites=excluded.n_aceites,
    n_status=excluded.n_status, n_falhas=excluded.n_falhas, estado=excluded.estado, motivo=excluded.motivo,
    alerta_desde = case when excluded.estado='alerta' then coalesce(t.alerta_desde, now()) else null end,
    alertado_em  = case when excluded.estado='alerta' then t.alertado_em else null end
  returning t.*)
select u.*, p.estado as estado_antigo, p.alertado_em as alertado_em_antigo from up u left join prev p using (chave) order by u.chave;
