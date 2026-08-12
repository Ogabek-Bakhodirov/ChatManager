-- ==========================================================================
-- Loosend — 0017_manual_wins
--
-- SAVOL (foydalanuvchi): "qo'lda statuslarni o'zgartirdim, node'lar o'chirdim.
-- Endi chatda sync qilsam, AI ularni qaytarib buzmaydimi?"
--
-- Joriy holat 0017 dan OLDIN:
--   · done -> ochiq        — 0013 bloklaydi ✓
--   · o'chirilgan tugun    — 0015 qabr toshi qaytarmaydi ✓
--   · in_progress -> todo  — HECH KIM to'xtatmaydi ✗
--   · blocked   -> todo    — HECH KIM to'xtatmaydi ✗
--   · cancelled -> todo    — HECH KIM to'xtatmaydi ✗
--
-- Ya'ni javob "asosan yo'q, lekin..." edi. "Lekin" — bu mahsulot uchun
-- yaroqsiz javob. Odam qo'l bilan tuzatgan narsa avtomatik tizim tomonidan
-- ORQAGA qaytarilmasligi kerak, nuqta.
--
-- QOIDA: har bir tugun statusining MANBAI yoziladi (`status_source`).
--   'ai'   — extraction qo'ygan. AI yana o'zgartira oladi, erkin.
--   'user' — odam qo'yGAN. AI faqat OLDINGA sura oladi, orqaga — yo'q.
--
-- "Oldinga" darajalari:
--     todo = 1, blocked = 1, in_progress = 2, done = 3, cancelled = 3
-- AI 'user' tugunning darajasini faqat OSHIRA oladi. Teng yoki past —
-- rad etiladi va 'override_blocked' hodisasi yoziladi (jim emas, ko'rinadi).
--
-- Nega butunlay qotirmaymiz: chatda ish rostdan tugasa ("shuni qildim"),
-- daraxt uni done qilishi kerak — odam in_progress qoldirgan bo'lsa ham.
-- Yo'qotish faqat ORQAGA harakatda bo'ladi.
--
-- IDEMPOTENT.
-- ==========================================================================

begin;

-- 1. Manba ustuni
alter table public.nodes
  add column if not exists status_source text not null default 'ai';

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'nodes_status_source_check'
  ) then
    alter table public.nodes
      add constraint nodes_status_source_check
      check (status_source in ('ai', 'user'));
  end if;
end $$;

comment on column public.nodes.status_source is
  'Statusni oxirgi kim qo''ygan: ai (extraction) yoki user (qo''l bilan). '
  '0017 qo''riqchisi user qo''yganini AI orqaga qaytarishiga yo''l qo''ymaydi.';

-- 2. Hodisa turi
alter table public.node_events drop constraint if exists node_events_op_check;
alter table public.node_events
  add constraint node_events_op_check check (op in (
    'add_node', 'set_status', 'rename', 'move', 'delete', 'merge',
    'ghost_expired', 'annotate', 'reopen_blocked', 'confirm', 'override_blocked'
  ));

-- 3. Daraja funksiyasi
create or replace function app.status_rank(s text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case s
    when 'todo' then 1
    when 'blocked' then 1
    when 'in_progress' then 2
    when 'done' then 3
    when 'cancelled' then 3
    else 0
  end;
$$;

-- 4. Qo'riqchi
create or replace function app.guard_manual_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  -- Odam o'zi yozayotgan bo'lsa (node_set_status bayroq qo'yadi) — erkin.
  if current_setting('app.manual', true) = 'on' then
    new.status_source := 'user';
    return new;
  end if;

  -- Bu yerdan pastda: AVTOMATIK yozuv (extraction, dedup, gardener).
  if old.status_source = 'user'
     and app.status_rank(new.status) <= app.status_rank(old.status)
  then
    insert into public.node_events
      (workspace_id, project_id, node_id, op, payload, actor)
    values
      (new.workspace_id, new.project_id, new.id, 'override_blocked',
       jsonb_build_object(
         'seq', new.seq,
         'title', new.title,
         'kept_status', old.status,
         'attempted_status', new.status), 'system');

    new.status  := old.status;
    new.done_at := old.done_at;
    return new;
  end if;

  new.status_source := 'ai';
  return new;
end;
$$;

revoke all on function app.guard_manual_status() from public, anon, authenticated;

-- 'nodes_ac_...' — 0013 ning 'nodes_ab_...' dan KEYIN. 0013 done->ochiq ni
-- allaqachon qaytargan bo'lsa, bu yerda new.status = old.status bo'lib
-- birinchi qatordayoq chiqib ketadi. Ikki qo'riqchi bir-biriga xalaqit
-- qilmaydi.
drop trigger if exists nodes_ac_manual_guard on public.nodes;
create trigger nodes_ac_manual_guard
  before update of status on public.nodes
  for each row execute function app.guard_manual_status();

-- 5. node_set_status endi manba bayrog'ini qo'yadi (0014 ustiga yoziladi)
create or replace function public.node_set_status(
  p_node   uuid,
  p_status text
)
returns table (out_status text, out_reopened boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  t_ws       uuid;
  t_proj     uuid;
  old_status text;
  reopened   boolean := false;
begin
  if p_status not in ('todo', 'in_progress', 'done', 'blocked', 'cancelled') then
    raise exception 'noma''lum status: %', p_status;
  end if;

  select n.workspace_id, n.project_id, n.status
    into t_ws, t_proj, old_status
    from public.nodes n
   where n.id = p_node;

  if t_ws is null then raise exception 'tugun topilmadi'; end if;
  if not app.can_write(t_ws) then raise exception 'ruxsat yo''q'; end if;

  if old_status = p_status then
    -- Status bir xil bo'lsa ham manbani belgilaymiz: odam ko'rdi va tasdiqladi.
    update public.nodes n set status_source = 'user' where n.id = p_node;
    return query select old_status, false;
    return;
  end if;

  if old_status = 'done' and p_status in ('todo', 'in_progress', 'blocked') then
    perform set_config('app.allow_reopen', 'on', true);
    reopened := true;
  end if;
  perform set_config('app.manual', 'on', true);

  update public.nodes n
     set status   = p_status,
         is_ghost = false,
         ghost_strikes = 0
   where n.id = p_node;

  perform set_config('app.manual', '', true);
  if reopened then perform set_config('app.allow_reopen', '', true); end if;

  insert into public.node_events
    (workspace_id, project_id, node_id, op, payload, actor)
  values
    (t_ws, t_proj, p_node, 'set_status',
     jsonb_build_object('status', p_status, 'from', old_status,
                        'manual', true, 'reopen', reopened),
     'user');

  return query select p_status, reopened;
end;
$$;

revoke all on function public.node_set_status(uuid, text) from public, anon;
grant execute on function public.node_set_status(uuid, text) to authenticated;

-- 6. cm_reopen (0013) ham odam yo'li — u ham bayroqni qo'yishi kerak,
--    aks holda o'z qo'riqchimiz uni bloklab qo'yadi.
create or replace function public.cm_reopen(
  p_node   uuid,
  p_status text default 'in_progress'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  t_ws uuid; t_proj uuid;
begin
  if p_status not in ('todo', 'in_progress', 'blocked') then
    raise exception 'cm_reopen: % holatiga ochib bo''lmaydi', p_status;
  end if;

  select n.workspace_id, n.project_id into t_ws, t_proj
    from public.nodes n where n.id = p_node;
  if t_ws is null then return false; end if;

  perform set_config('app.allow_reopen', 'on', true);
  perform set_config('app.manual', 'on', true);
  update public.nodes n set status = p_status where n.id = p_node;
  perform set_config('app.manual', '', true);
  perform set_config('app.allow_reopen', '', true);

  insert into public.node_events
    (workspace_id, project_id, node_id, op, payload, actor)
  values
    (t_ws, t_proj, p_node, 'set_status',
     jsonb_build_object('status', p_status, 'reopen', true), 'user');

  return true;
end;
$$;

revoke all on function public.cm_reopen(uuid, text) from public, anon, authenticated;
grant execute on function public.cm_reopen(uuid, text) to service_role;

commit;

-- ==========================================================================
-- O'Z-O'ZINI TEKSHIRISH
-- ==========================================================================

do $$
declare
  ws uuid; proj uuid; a uuid; b uuid; c uuid; st text; src text; cnt int;
begin
  insert into public.workspaces (name) values ('manual-wins') returning id into ws;
  insert into public.projects (workspace_id, name) values (ws, 'MW') returning id into proj;

  -- A: odam in_progress qo'ygan
  insert into public.nodes (project_id, title, stable_key, status, status_source)
    values (proj, 'odam boshlagan', 'k1', 'in_progress', 'user') returning id into a;
  -- B: AI qo'ygan
  insert into public.nodes (project_id, title, stable_key, status, status_source)
    values (proj, 'ai qo''ygan', 'k2', 'in_progress', 'ai') returning id into b;
  -- C: odam blocked qo'ygan
  insert into public.nodes (project_id, title, stable_key, status, status_source)
    values (proj, 'odam bloklagan', 'k3', 'blocked', 'user') returning id into c;

  -- T1: AI odamning in_progress ini todo ga qaytara olmaydi
  update public.nodes set status = 'todo' where id = a;
  select status into st from public.nodes where id = a;
  if st <> 'in_progress' then raise exception 'T1 yiqildi: %', st; end if;

  -- T2: urinish ko'rinadigan hodisa bo'lib yozildi
  select count(*) into cnt from public.node_events
   where node_id = a and op = 'override_blocked'
     and payload ->> 'attempted_status' = 'todo'
     and payload ->> 'kept_status' = 'in_progress';
  if cnt <> 1 then raise exception 'T2 yiqildi: cnt=%', cnt; end if;

  -- T3: AI ni AI erkin orqaga qaytaradi (himoya faqat odam uchun)
  update public.nodes set status = 'todo' where id = b;
  select status into st from public.nodes where id = b;
  if st <> 'todo' then raise exception 'T3 yiqildi: %', st; end if;

  -- T4: AI odamning ishini OLDINGA sura oladi (in_progress -> done)
  update public.nodes set status = 'done' where id = a;
  select status, status_source into st, src from public.nodes where id = a;
  if st <> 'done' then raise exception 'T4 yiqildi: %', st; end if;
  if src <> 'ai' then raise exception 'T4 yiqildi: manba yangilanmadi (%)', src; end if;

  -- T5: odamning blocked i todo ga tushmaydi (teng daraja ham rad)
  update public.nodes set status = 'todo' where id = c;
  select status into st from public.nodes where id = c;
  if st <> 'blocked' then raise exception 'T5 yiqildi: %', st; end if;

  -- T6: odam yo'li (bayroq bilan) hamma joydan o'tadi va manbani 'user' qiladi
  perform set_config('app.manual', 'on', true);
  perform set_config('app.allow_reopen', 'on', true);
  update public.nodes set status = 'todo' where id = a;
  perform set_config('app.manual', '', true);
  perform set_config('app.allow_reopen', '', true);
  select status, status_source into st, src from public.nodes where id = a;
  if st <> 'todo' then raise exception 'T6 yiqildi: %', st; end if;
  if src <> 'user' then raise exception 'T6 yiqildi: manba % ', src; end if;

  -- T7: bayroq tranzaksiyadan keyin ochiq qolmagan
  update public.nodes set status = 'todo' where id = c;
  select status into st from public.nodes where id = c;
  if st <> 'blocked' then raise exception 'T7 yiqildi: bayroq ochiq qoldi'; end if;

  -- T8: yangi tugunlar sukut bo'yicha 'ai'
  if (select status_source from public.nodes where id = b) <> 'ai' then
    raise exception 'T8 yiqildi';
  end if;

  -- T9: 0013 bilan birga ishlaydi — done, ai manbali, ochilmaydi
  update public.nodes set status = 'done' where id = b;
  update public.nodes set status = 'todo' where id = b;
  select status into st from public.nodes where id = b;
  if st <> 'done' then raise exception 'T9 yiqildi: 0013 buzildi (%)', st; end if;

  delete from public.workspaces where id = ws;
  raise notice '0017: 9/9 tekshiruv o''tdi';
end;
$$;
