-- ==========================================================================
-- Loosend — 0019_pending_batches
--
-- MUAMMO: hozir ingest quvuri oxirida app.apply_ops TO'G'RIDAN-TO'G'RI daraxtga
-- yozadi. Odam ko'rmaydi, tanlamaydi — shuning uchun trash (suhbat shovquni)
-- ham tugun bo'lib tushadi.
--
-- YECHIM: yozishdan OLDIN eshik. Topilgan ishlar avval "kutish ro'yxatiga"
-- tushadi (pending_batches / pending_items), daraxtga esa FAQAT foydalanuvchi
-- tasdiqlagach yoziladi.
--
--   app.stage_batch()    — Pass A/B chiqargan op'larni daraxtga emas, kutish
--                          ro'yxatiga yozadi; kursorni suradi (xabar "ko'rildi",
--                          shuning uchun keyingi Stop uni qayta topmaydi).
--   app.list_pending()   — ochiq kutayotgan bandlar (chat/canvas ko'rsatadi).
--   app.confirm_pending()— tanlangan bandlarni app.apply_ops orqali daraxtga
--                          o'tkazadi (barcha eski himoyalar saqlanadi).
--   app.reject_pending() — "yo'q" — bandni rad etadi.
--   app.expire_pending() — jimlik = yo'q: eskirgan bandlar o'z-o'zidan tushadi.
--
-- TAMOYIL: rad etish TEKIN (jimlik ham rad), faqat "ha" harakat talab qiladi.
-- Confirm daraxtga o'zi yozmaydi — app.apply_ops'ni chaqiradi, ya'ni stable_key
-- dublikat himoyasi, ghost, hodisa yozuvi va 0013/0017 qo'riqchilari o'z joyida
-- ishlashda davom etadi.
--
-- v1 CHEGARASI: tanlangan farzand bandning otasi tanlanmagan bo'lsa, farzand
-- ildizga tushadi (ko'rinadi — yo'qolmaydi). Ota-farzand birga tanlansa bog'
-- saqlanadi. Bu ataylab: jim yo'qotishдан ko'ra ko'rinadigan ildiz yaxshiroq.
--
-- FAQAT Claude Code uchun quriladi (Desktop qo'llab-quvvatlanmaydi).
-- IDEMPOTENT (0009+ qoidasi).
-- ==========================================================================

begin;

-- --------------------------------------------------------------- jadvallar --
create table if not exists public.pending_batches (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id)    on delete cascade,
  project_id   uuid not null references public.projects(id)      on delete cascade,
  session_id   uuid not null references public.chat_sessions(id) on delete cascade,
  created_at   timestamptz not null default now(),
  -- jimlik = yo'q: tegilmagan band shu muddatdan keyin eskiradi
  expires_at   timestamptz not null default now() + interval '7 days'
);
create index if not exists pending_batches_project_idx
  on public.pending_batches (project_id, expires_at);

comment on table public.pending_batches is
  '0019: tasdiqlanmagan taklif to''plami. Daraxtga faqat confirm bo''lgach yoziladi.';

create table if not exists public.pending_items (
  id            uuid primary key default gen_random_uuid(),
  batch_id      uuid not null references public.pending_batches(id) on delete cascade,
  -- workspace/project denormallashtirilgan: RLS va list uchun tez, arzon
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  project_id    uuid not null references public.projects(id)   on delete cascade,
  idx           int  not null,               -- to'plam ichidagi tartib = ko'rsatiladigan raqam
  kind          text not null check (kind in ('new','status')),
  title         text not null,               -- ko'rsatish uchun
  -- op — app.apply_ops kutadigan tayyor operatsiya (ref'lar temp_id/parent_temp
  -- yoki mavjud node uuid bilan). Confirm shuni o'zgartirmasdan qayta ishlatadi.
  op            jsonb not null,
  -- ehtimoliy dublikat: "bu #3 ga o'xshaydi" degan ishorani chatда ko'rsatish uchun
  likely_dup_of uuid references public.nodes(id) on delete set null,
  status        text not null default 'open'
                  check (status in ('open','confirmed','rejected','expired')),
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  unique (batch_id, idx)
);
create index if not exists pending_items_open_idx
  on public.pending_items (project_id, status);

comment on table public.pending_items is
  '0019: bitta taklif. status=open — hali qaror qilinmagan; confirm/reject/expire — qaror.';

-- --------------------------------------------------------------------- RLS --
-- Foydalanuvchi (canvas) ochiq bandlarni O'QIY oladi. Yozish faqat quyidagi
-- security-definer funksiyalar orqali (Edge Function, service_role) — huddi
-- nodes/messages kabi.
alter table public.pending_batches enable row level security;
alter table public.pending_items   enable row level security;

drop policy if exists pending_batches_select on public.pending_batches;
create policy pending_batches_select on public.pending_batches
  for select to authenticated using (app.is_member(workspace_id));

drop policy if exists pending_items_select on public.pending_items;
create policy pending_items_select on public.pending_items
  for select to authenticated using (app.is_member(workspace_id));

grant select on public.pending_batches to authenticated;
grant select on public.pending_items   to authenticated;

-- ------------------------------------------------------------- stage_batch --
-- Pass A/B chiqargan op'larni daraxtga EMAS, kutish ro'yxatiga yozadi.
create or replace function app.stage_batch(
  p_session uuid,
  p_ops     jsonb,
  p_cursor  bigint default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  t_project uuid;
  t_ws      uuid;
  b_id      uuid;
begin
  select cs.project_id, cs.workspace_id into t_project, t_ws
    from public.chat_sessions cs where cs.id = p_session;
  if t_project is null then
    raise exception 'session_not_found';
  end if;

  -- Bo'sh taklif — batch yaratmaymiz (bo'm-bo'sh ro'yxat chalg'itadi).
  if coalesce(jsonb_array_length(p_ops), 0) = 0 then
    -- xabarlar baribir "ko'rildi": kursorni surib chiqamiz
    if p_cursor is not null then
      update public.chat_sessions cs
         set cursor_seq = greatest(cs.cursor_seq, p_cursor),
             last_synced_at = now()
       where cs.id = p_session;
    end if;
    return null;
  end if;

  insert into public.pending_batches (workspace_id, project_id, session_id)
       values (t_ws, t_project, p_session)
    returning id into b_id;

  insert into public.pending_items
    (batch_id, workspace_id, project_id, idx, kind, title, op, likely_dup_of)
  select
    b_id, t_ws, t_project,
    (ord)::int,
    case when (o ->> 'op') = 'add_node' then 'new' else 'status' end,
    left(btrim(coalesce(o ->> 'title', '(untitled)')), 500),
    o,
    case
      when (o ->> 'likely_dup_of') ~ '^[0-9a-fA-F-]{36}$'
      then (o ->> 'likely_dup_of')::uuid
      else null
    end
  from jsonb_array_elements(p_ops) with ordinality as t(o, ord);

  -- Xabarlar "ko'rildi" -> kursor oldinga. Shu sabab keyingi Stop hook o'sha
  -- matnni QAYTA topib, ikkinchi kutish ro'yxatini yaratmaydi. Daraxtga esa
  -- hech narsa yozilmadi — faqat kutish ro'yxatiga.
  if p_cursor is not null then
    update public.chat_sessions cs
       set cursor_seq = greatest(cs.cursor_seq, p_cursor),
           last_synced_at = now()
     where cs.id = p_session;
  end if;

  return b_id;
end;
$$;

-- ------------------------------------------------------------- list_pending --
-- Ochiq (hali qaror qilinmagan) bandlar. dup_seq — ehtimoliy dublikat #N.
create or replace function app.list_pending(p_project uuid)
returns table (
  item_id uuid,
  idx     int,
  kind    text,
  title   text,
  dup_seq int
)
language sql
security definer
stable
set search_path = ''
as $$
  select pi.id, pi.idx, pi.kind, pi.title, dn.seq
    from public.pending_items pi
    join public.pending_batches pb on pb.id = pi.batch_id
    left join public.nodes dn on dn.id = pi.likely_dup_of
   where pb.project_id = p_project
     and pi.status = 'open'
     and pb.expires_at > now()
   order by pi.created_at, pi.idx;
$$;

-- ---------------------------------------------------------- confirm_pending --
-- Tanlangan bandlarni app.apply_ops orqali daraxtga o'tkazadi. Confirm o'zi
-- yozmaydi — barcha eski himoyalar (stable_key, ghost, 0013/0017) saqlanadi.
create or replace function app.confirm_pending(
  p_session  uuid,
  p_item_ids uuid[]
)
returns table (applied int, skipped int, ghosts int, expired int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  t_project uuid;
  v_temps   text[];
  v_ops     jsonb;
begin
  select cs.project_id into t_project
    from public.chat_sessions cs where cs.id = p_session;
  if t_project is null then
    raise exception 'session_not_found';
  end if;

  -- Tanlangan bandlar orasidagi temp_id lar — ota-farzand bog'ini tiklash uchun.
  select coalesce(array_agg(pi.op ->> 'temp_id'), '{}')
    into v_temps
    from public.pending_items pi
    join public.pending_batches pb on pb.id = pi.batch_id
   where pi.id = any(p_item_ids)
     and pi.status = 'open'
     and pb.project_id = t_project
     and pi.op ? 'temp_id'
     and pi.op ->> 'temp_id' is not null;

  -- Op massivi. Tanlangan farzandning otasi tanlanmagan bo'lsa — parent_temp/
  -- parent_id olib tashlanadi, band ildizga tushadi (ko'rinadi, yo'qolmaydi).
  -- Tasdiqlangan ish haqiqiy -> confidence 1.0, apply_ops uni ghost qilmaydi.
  select jsonb_agg(x.op2 order by x.idx)
    into v_ops
    from (
      select pi.idx,
        case
          when pi.op ->> 'parent_temp' is not null
               and not (pi.op ->> 'parent_temp' = any(v_temps))
          then (pi.op - 'parent_temp' - 'parent_id') || jsonb_build_object('confidence', 1.0)
          else pi.op || jsonb_build_object('confidence', 1.0)
        end as op2
      from public.pending_items pi
      join public.pending_batches pb on pb.id = pi.batch_id
     where pi.id = any(p_item_ids)
       and pi.status = 'open'
       and pb.project_id = t_project
      order by pi.idx
    ) x;

  if v_ops is null then
    return query select 0, 0, 0, 0;
    return;
  end if;

  -- Daraxtga yozish — umumiy, himoyalangan yo'l orqali. Kursor stage'да
  -- allaqachon surilgan, shuning uchun bu yerда null.
  return query select * from app.apply_ops(p_session, v_ops, null);

  update public.pending_items pi
     set status = 'confirmed', decided_at = now()
   where pi.id = any(p_item_ids) and pi.status = 'open';
end;
$$;

-- ----------------------------------------------------------- reject_pending --
create or replace function app.reject_pending(p_item_ids uuid[])
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  update public.pending_items pi
     set status = 'rejected', decided_at = now()
   where pi.id = any(p_item_ids) and pi.status = 'open';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ----------------------------------------------------------- expire_pending --
-- Jimlik = yo'q: muddati o'tgan ochiq bandlar eskiradi. Edge Function har
-- sync'да arzon chaqiradi. Faqat berilgan loyiha doirasida.
create or replace function app.expire_pending(p_project uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  update public.pending_items pi
     set status = 'expired', decided_at = now()
    from public.pending_batches pb
   where pi.batch_id = pb.id
     and pb.project_id = p_project
     and pi.status = 'open'
     and pb.expires_at < now();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ------------------------------------------------------------------ grants --
-- Bu funksiyalar faqat service_role (Edge Function) uchun — huddi apply_ops.
revoke all on function app.stage_batch(uuid, jsonb, bigint) from public, anon, authenticated;
revoke all on function app.list_pending(uuid)               from public, anon, authenticated;
revoke all on function app.confirm_pending(uuid, uuid[])    from public, anon, authenticated;
revoke all on function app.reject_pending(uuid[])           from public, anon, authenticated;
revoke all on function app.expire_pending(uuid)             from public, anon, authenticated;

commit;

-- ==========================================================================
-- O'Z-O'ZINI TEKSHIRISH
-- ==========================================================================

do $$
declare
  ws uuid; proj uuid; sess uuid; b uuid; existing uuid;
  it_child uuid; it_parent uuid;
  cnt int;
  v_applied int; v_skipped int; v_ghosts int; v_expired int;
  ids uuid[];
begin
  insert into public.workspaces (name) values ('pending-test') returning id into ws;
  insert into public.projects (workspace_id, name) values (ws, 'P') returning id into proj;
  insert into public.chat_sessions (workspace_id, project_id, source, external_id, status)
       values (ws, proj, 'claude_code', '/pending-test', 'linked') returning id into sess;

  -- Status-op sinovi uchun mavjud tugun
  insert into public.nodes (workspace_id, project_id, title, stable_key, status)
       values (ws, proj, 'Existing task', 'existing', 'todo') returning id into existing;

  -- Kutish ro'yxatiga yozamiz: yangi ota, yangi farzand, mavjudga status
  b := app.stage_batch(sess, jsonb_build_array(
        jsonb_build_object('op','add_node','temp_id','t0','title','Parent task','status','todo','confidence',0.9),
        jsonb_build_object('op','add_node','temp_id','t1','parent_temp','t0','title','Child task','status','todo','confidence',0.9),
        jsonb_build_object('op','set_status','node_id',existing::text,'title','Existing task','status','done','confidence',0.9)
      ), 5);

  -- T1: 3 ta band yaratildi
  select count(*) into cnt from public.pending_items where batch_id = b;
  if cnt <> 3 then raise exception 'T1 yiqildi: 3 band kutilgandi, % chiqdi', cnt; end if;

  -- T2: daraxtga HALI hech narsa yozilmagan (faqat mavjud tugun bor)
  select count(*) into cnt from public.nodes where project_id = proj;
  if cnt <> 1 then raise exception 'T2 yiqildi: confirmдан oldin daraxt o''zgardi (% tugun)', cnt; end if;

  -- T3: xabar "ko'rildi" -> kursor 5 ga surildi
  select cursor_seq into cnt from public.chat_sessions where id = sess;
  if cnt <> 5 then raise exception 'T3 yiqildi: kursor surilmadi (%)', cnt; end if;

  -- T4: list_pending 3 ta ochiq band qaytaradi
  select count(*) into cnt from app.list_pending(proj);
  if cnt <> 3 then raise exception 'T4 yiqildi: list_pending % qaytardi', cnt; end if;

  -- Hammasini tanlab tasdiqlaymiz
  select array_agg(id order by idx) into ids from public.pending_items where batch_id = b;
  select c.applied, c.skipped, c.ghosts, c.expired
    into v_applied, v_skipped, v_ghosts, v_expired
    from app.confirm_pending(sess, ids) c;

  -- T5: confirmдан keyin 2 yangi tugun (ota+farzand) -> jami 3
  select count(*) into cnt from public.nodes where project_id = proj;
  if cnt <> 3 then raise exception 'T5 yiqildi: confirmдан keyin 3 tugun kutilgandi, % chiqdi', cnt; end if;

  -- T5b: mavjud tugun status'i done bo'ldi
  if (select status from public.nodes where id = existing) <> 'done' then
    raise exception 'T5b yiqildi: status qo''llanmadi';
  end if;

  -- T6: farzand otasi ostida (ikkovi birga tanlangani uchun bog' saqlandi)
  if not exists (
    select 1 from public.nodes c join public.nodes p on c.parent_id = p.id
     where c.title = 'Child task' and p.title = 'Parent task'
  ) then raise exception 'T6 yiqildi: ota-farzand bog''i yo''qoldi'; end if;

  -- T7: bandlar 'confirmed' bo'ldi
  select count(*) into cnt from public.pending_items where batch_id = b and status = 'confirmed';
  if cnt <> 3 then raise exception 'T7 yiqildi: bandlar confirmed emas (%)', cnt; end if;

  -- T8: qisman tanlash — otasi tanlanmagan farzand ildizga tushadi
  b := app.stage_batch(sess, jsonb_build_array(
        jsonb_build_object('op','add_node','temp_id','t0','title','Lonely parent','status','todo','confidence',0.9),
        jsonb_build_object('op','add_node','temp_id','t1','parent_temp','t0','title','Orphan child','status','todo','confidence',0.9)
      ), 8);
  select id into it_child  from public.pending_items where batch_id = b and title = 'Orphan child';
  select id into it_parent from public.pending_items where batch_id = b and title = 'Lonely parent';

  select c.applied into v_applied from app.confirm_pending(sess, array[it_child]) c;
  if (select parent_id from public.nodes where title = 'Orphan child' and project_id = proj) is not null then
    raise exception 'T8 yiqildi: yetim farzand ildizда bo''lishi kerak edi';
  end if;

  -- T9: qolganini rad etamiz
  if app.reject_pending(array[it_parent]) <> 1 then raise exception 'T9 yiqildi: reject soni'; end if;
  if (select status from public.pending_items where id = it_parent) <> 'rejected' then
    raise exception 'T9b yiqildi: status rejected emas';
  end if;

  -- T10: eskirish — muddatni orqaga surib expire_pending'ni sinaymiz
  b := app.stage_batch(sess, jsonb_build_array(
        jsonb_build_object('op','add_node','temp_id','t0','title','Stale item','status','todo','confidence',0.9)
      ), null);
  update public.pending_batches set expires_at = now() - interval '1 day' where id = b;
  if app.expire_pending(proj) < 1 then raise exception 'T10 yiqildi: expire soni'; end if;
  if (select status from public.pending_items where batch_id = b) <> 'expired' then
    raise exception 'T10b yiqildi: status expired emas';
  end if;

  delete from public.workspaces where id = ws;
  raise notice '0019: 10/10 tekshiruv o''tdi';
end;
$$;
