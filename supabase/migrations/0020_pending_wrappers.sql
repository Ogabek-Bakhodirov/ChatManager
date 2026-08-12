-- ==========================================================================
-- Loosend — 0020_pending_wrappers
--
-- MUAMMO: 0019 `app.stage_batch / list_pending / confirm_pending /
-- reject_pending / expire_pending` funksiyalarini yaratdi, LEKIN ularning
-- `public.cm_*` o'ramlarini qo'shmadi. PostgREST (REST/RPC) faqat `public`
-- sxemani ochadi va Edge Function har doim `/rpc/cm_<fn>` ni chaqiradi
-- (db.ts: `rpc/cm_${fn}`). O'ram bo'lmagani uchun `cm_stage_batch` 404 qaytardi,
-- xato jim yutildi (ingest uni e'tiborsiz qoldiradi) va kutish ro'yxati bo'sh
-- qoldi — garchi Pass A/B operatsiya yasagan bo'lsa ham (sync_runs.ops_out > 0).
--
-- YECHIM: 0005 dagi naqsh — `public` da yupqa o'ramlar, faqat service_role
-- uchun. `app` sxemasi tashqariga ochilmaydi.
--
-- FAQAT BAZA: edge function kodi allaqachon `cm_` nomlarini chaqiradi, shuning
-- uchun qayta deploy SHART EMAS.
-- IDEMPOTENT.
-- ==========================================================================

drop function if exists public.cm_stage_batch(uuid, jsonb, bigint);
drop function if exists public.cm_list_pending(uuid);
drop function if exists public.cm_confirm_pending(uuid, uuid[]);
drop function if exists public.cm_reject_pending(uuid[]);
drop function if exists public.cm_expire_pending(uuid);

create function public.cm_stage_batch(
  p_session uuid, p_ops jsonb, p_cursor bigint default null)
returns uuid
language sql security definer set search_path = '' as $$
  select app.stage_batch(p_session, p_ops, p_cursor);
$$;

create function public.cm_list_pending(p_project uuid)
returns table (item_id uuid, idx int, kind text, title text, dup_seq int)
language sql security definer set search_path = '' as $$
  select * from app.list_pending(p_project);
$$;

create function public.cm_confirm_pending(p_session uuid, p_item_ids uuid[])
returns table (applied int, skipped int, ghosts int, expired int)
language sql security definer set search_path = '' as $$
  select * from app.confirm_pending(p_session, p_item_ids);
$$;

create function public.cm_reject_pending(p_item_ids uuid[])
returns int
language sql security definer set search_path = '' as $$
  select app.reject_pending(p_item_ids);
$$;

create function public.cm_expire_pending(p_project uuid)
returns int
language sql security definer set search_path = '' as $$
  select app.expire_pending(p_project);
$$;

-- ----------------------------------------------------------------------------
-- Huquqlar: FAQAT service_role. Frontend bularni ko'rmaydi.
-- ----------------------------------------------------------------------------
revoke all on function public.cm_stage_batch(uuid, jsonb, bigint) from public, anon, authenticated;
revoke all on function public.cm_list_pending(uuid)               from public, anon, authenticated;
revoke all on function public.cm_confirm_pending(uuid, uuid[])    from public, anon, authenticated;
revoke all on function public.cm_reject_pending(uuid[])           from public, anon, authenticated;
revoke all on function public.cm_expire_pending(uuid)             from public, anon, authenticated;

grant execute on function public.cm_stage_batch(uuid, jsonb, bigint) to service_role;
grant execute on function public.cm_list_pending(uuid)               to service_role;
grant execute on function public.cm_confirm_pending(uuid, uuid[])    to service_role;
grant execute on function public.cm_reject_pending(uuid[])           to service_role;
grant execute on function public.cm_expire_pending(uuid)             to service_role;

-- ==========================================================================
-- O'Z-O'ZINI TEKSHIRISH — o'ramlar app.* ga to'g'ri o'tkazadimi
-- ==========================================================================

do $$
declare
  ws uuid; proj uuid; sess uuid; b uuid; cnt int;
  ids uuid[]; v_applied int;
begin
  -- T0: 5 ta o'ram mavjud
  select count(*) into cnt
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('cm_stage_batch','cm_list_pending','cm_confirm_pending',
                       'cm_reject_pending','cm_expire_pending');
  if cnt <> 5 then raise exception '0020 T0 yiqildi: 5 o''ram kutilgandi, % topildi', cnt; end if;

  insert into public.workspaces (name) values ('wrap-test') returning id into ws;
  insert into public.projects (workspace_id, name) values (ws, 'W') returning id into proj;
  insert into public.chat_sessions (workspace_id, project_id, source, external_id, status)
       values (ws, proj, 'claude_code', '/wrap', 'linked') returning id into sess;

  -- T1: cm_stage_batch (o'ram orqali) batch yaratadi
  b := public.cm_stage_batch(sess, jsonb_build_array(
        jsonb_build_object('op','add_node','temp_id','t0','title','Wrapper task','status','todo','confidence',0.9)
      ), 3);
  if b is null then raise exception '0020 T1 yiqildi: cm_stage_batch null qaytardi'; end if;

  -- T2: cm_list_pending 1 ta ochiq band qaytaradi
  select count(*) into cnt from public.cm_list_pending(proj);
  if cnt <> 1 then raise exception '0020 T2 yiqildi: cm_list_pending % qaytardi', cnt; end if;

  -- T3: cm_confirm_pending bandni daraxtga yozadi
  select array_agg(item_id) into ids from public.cm_list_pending(proj);
  select applied into v_applied from public.cm_confirm_pending(sess, ids);
  if (select count(*) from public.nodes where project_id = proj and title = 'Wrapper task') <> 1 then
    raise exception '0020 T3 yiqildi: confirm daraxtga yozmadi';
  end if;

  delete from public.workspaces where id = ws;
  raise notice '0020: 4/4 tekshiruv o''tdi';
end;
$$;
