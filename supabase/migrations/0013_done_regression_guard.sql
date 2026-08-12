-- ==========================================================================
-- Loosend — 0013_done_regression_guard
--
-- JONLI NOSOZLIK: #4 "F0 baza" va #2 "RLS policylarini yozish" done'dan
-- todo'ga JIMGINA qaytib qoldi. Kvitansiya "nothing left behind" dedi.
--
-- ILDIZ SABAB: suhbat daraxt HAQIDA gapirganda ("#4 [done] F0 baza" degan
-- iqtibos), Pass A buni yangi ish deb ajratadi, Pass B "new" deydi, insert
-- stable_key bo'yicha to'qnashadi va apply_ops'ning dublikat ushlovchisi
-- mavjud tugun statusini kelgan qiymat bilan USTIDAN yozadi. Ingest esa
-- add_node'ga doim `status ?? "todo"` yuboradi — done -> todo tayyor.
--
-- Bu bitta joyning xatosi emas. Statusni orqaga qaytarishga hech qanday
-- to'siq yo'q edi: set_status yo'li ham, dedup yo'li ham, kelajakda
-- yoziladigan har qanday yangi yo'l ham done'ni jimgina ocha olardi.
--
-- ARXITEKTURA QARORI: himoya QATOR darajasida — BEFORE UPDATE trigger.
-- Qaysi kod yo'li kelmasin, qoida bitta:
--
--     done -> ochiq holat FAQAT oshkora ruxsat bilan.
--
-- Ruxsatsiz urinish: status done bo'lib QOLADI, 'reopen_blocked' hodisasi
-- yoziladi (payload'da seq va title — kvitansiya "nima bloklandi"ni aniq
-- aytadi). Jim muvaffaqiyat o'rniga ko'rinadigan rad — loyihaning tamal
-- prinsipi.
--
-- Oshkora yo'l: public.cm_reopen(node, status) — tranzaksiya-lokal bayroq
-- qo'yib o'tkazadi. Haqiqiy "qayta ochamiz" holati uchun.
--
-- IDEMPOTENT: qayta yugurtirsa xato bermaydi.
-- ==========================================================================

begin;

-- 1. Hodisa turi
alter table public.node_events drop constraint if exists node_events_op_check;
alter table public.node_events
  add constraint node_events_op_check check (op in (
    'add_node', 'set_status', 'rename', 'move', 'delete', 'merge',
    'ghost_expired', 'annotate', 'reopen_blocked'
  ));

-- 2. Qo'riqchi trigger
create or replace function app.guard_done_regression()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Faqat xavfli yo'nalish: yopilgan ish ochilmoqda
  if old.status = 'done' and new.status in ('todo', 'in_progress', 'blocked')
  then
    -- Oshkora ruxsat (cm_reopen qo'yadi, tranzaksiya oxirida o'zi o'chadi)
    if current_setting('app.allow_reopen', true) = 'on' then
      return new;
    end if;

    -- Bloklaymiz: qator done bo'lib qoladi, urinish tarixga tushadi.
    insert into public.node_events
      (workspace_id, project_id, node_id, op, payload, actor)
    values
      (new.workspace_id, new.project_id, new.id, 'reopen_blocked',
       jsonb_build_object(
         'seq', new.seq,
         'title', new.title,
         'attempted_status', new.status), 'system');

    new.status  := 'done';
    new.done_at := old.done_at;
  end if;
  return new;
end;
$$;

revoke all on function app.guard_done_regression() from public, anon, authenticated;

-- Nomi 'nodes_ab_...' — bir xil turdagi triggerlar alifbo tartibida ishlaydi,
-- bu qo'riqchi nodes_integrity (done_at mantiqi) dan OLDIN yurishi kerak.
drop trigger if exists nodes_ab_done_guard on public.nodes;
create trigger nodes_ab_done_guard
  before update of status on public.nodes
  for each row execute function app.guard_done_regression();

-- 3. Oshkora qayta ochish yo'li
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

  perform set_config('app.allow_reopen', 'on', true);   -- faqat shu tranzaksiya
  update public.nodes n set status = p_status where n.id = p_node;
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
  ws uuid; proj uuid; nd uuid; ev int; st text;
begin
  insert into public.workspaces (name) values ('guard-test') returning id into ws;
  insert into public.projects (workspace_id, name) values (ws, 'G') returning id into proj;
  insert into public.nodes (project_id, title, stable_key, status)
    values (proj, 'yopilgan ish', 'k1', 'done') returning id into nd;

  -- T1: to'g'ridan-to'g'ri done -> todo bloklanadi (dedup yo'lining aynan o'zi)
  update public.nodes set status = 'todo' where id = nd;
  select status into st from public.nodes where id = nd;
  if st <> 'done' then raise exception 'T1 yiqildi: status=%', st; end if;

  -- T2: urinish tarixga tushdi, seq va title bilan
  select count(*) into ev from public.node_events
   where node_id = nd and op = 'reopen_blocked'
     and payload ->> 'attempted_status' = 'todo'
     and payload ->> 'title' = 'yopilgan ish'
     and (payload ->> 'seq') is not null;
  if ev <> 1 then raise exception 'T2 yiqildi: ev=%', ev; end if;

  -- T3: done -> in_progress va done -> blocked ham bloklanadi
  update public.nodes set status = 'in_progress' where id = nd;
  update public.nodes set status = 'blocked' where id = nd;
  select status into st from public.nodes where id = nd;
  if st <> 'done' then raise exception 'T3 yiqildi: status=%', st; end if;

  -- T4: oldinga yurish erkin (todo -> done)
  insert into public.nodes (project_id, title, stable_key)
    values (proj, 'ochiq ish', 'k2');
  update public.nodes set status = 'done'
   where project_id = proj and stable_key = 'k2';
  select status into st from public.nodes
   where project_id = proj and stable_key = 'k2';
  if st <> 'done' then raise exception 'T4 yiqildi'; end if;

  -- T5: done -> cancelled ham, cancelled -> todo ham qo'riqchiga tegmaydi
  -- (qo'riqchi tor: faqat done -> ochiq. Qolganini bilerak tegmaymiz.)
  update public.nodes set status = 'cancelled'
   where project_id = proj and stable_key = 'k2';
  update public.nodes set status = 'todo'
   where project_id = proj and stable_key = 'k2';
  select status into st from public.nodes
   where project_id = proj and stable_key = 'k2';
  if st <> 'todo' then raise exception 'T5 yiqildi: status=%', st; end if;

  -- T6: oshkora qayta ochish ishlaydi
  if not public.cm_reopen(nd, 'in_progress') then
    raise exception 'T6 yiqildi: cm_reopen false';
  end if;
  select status into st from public.nodes where id = nd;
  if st <> 'in_progress' then raise exception 'T6 yiqildi: status=%', st; end if;

  -- T7: cm_reopen'dan keyin bayroq o'chgan — keyingi urinish yana bloklanadi
  update public.nodes set status = 'done' where id = nd;
  update public.nodes set status = 'todo' where id = nd;
  select status into st from public.nodes where id = nd;
  if st <> 'done' then raise exception 'T7 yiqildi: bayroq ochiq qolgan!'; end if;

  delete from public.workspaces where id = ws;
  raise notice '0013: 7/7 tekshiruv o''tdi';
end;
$$;
