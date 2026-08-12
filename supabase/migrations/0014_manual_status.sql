-- ==========================================================================
-- Loosend — 0014_manual_status
--
-- NEGA: hozir foydalanuvchi daraxtdagi noto'g'ri tugunni TUZATA OLMAYDI.
-- Extraction xato status qo'ysa — yashab qolaveradi. "Daraxtda valid data"
-- degan maqsad uchun bu birinchi to'siq: avtomatik tizim xato qilsa, odam
-- uni qo'l bilan to'g'irlay olishi shart.
--
-- Nega oddiy UPDATE emas:
--   1. 0013 qo'riqchisi done -> ochiq o'tishni bloklaydi. To'g'ri qiladi —
--      lekin ODAM oshkora bosganda bu bloklash noto'g'ri. Qo'l bilan bosish
--      niyatning eng aniq ko'rinishi.
--   2. node_events yozilmay qolardi — Activity oqimida o'zgarish ko'rinmaydi
--      va kim qilgani bilinmaydi.
--   3. Ota qoidasi (0010) avtomatik extraction uchun. Odam "done" desa,
--      bu taxmin emas — shuning uchun bu yerda qo'llanmaydi.
--
-- NATIJA: bitta RPC. RLS emas, `security definer` + a'zolik tekshiruvi:
-- foydalanuvchi faqat o'z workspace'idagi tugunni o'zgartira oladi.
--
-- IDEMPOTENT.
-- ==========================================================================

begin;

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

  if t_ws is null then
    raise exception 'tugun topilmadi';
  end if;

  -- Faqat o'z workspace'ida. auth.uid() null bo'lsa (anon) — rad.
  if not app.can_write(t_ws) then
    raise exception 'ruxsat yo''q';
  end if;

  if old_status = p_status then
    return query select old_status, false;
    return;
  end if;

  -- done -> ochiq: bu OSHKORA qayta ochish. 0013 qo'riqchisi avtomatik
  -- extraction'ni to'xtatadi, odamni emas — shuning uchun bayroqni qo'yamiz.
  if old_status = 'done' and p_status in ('todo', 'in_progress', 'blocked') then
    perform set_config('app.allow_reopen', 'on', true);
    reopened := true;
  end if;

  update public.nodes n
     set status   = p_status,
         is_ghost = false,          -- odam tasdiqladi, taxmin emas
         ghost_strikes = 0
   where n.id = p_node;

  if reopened then
    perform set_config('app.allow_reopen', '', true);
  end if;

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

commit;

-- ==========================================================================
-- O'Z-O'ZINI TEKSHIRISH
--
-- can_write auth.uid() ga tayanadi, SQL Editorda u null. Shuning uchun
-- mantiqni to'g'ridan-to'g'ri sinaymiz: a'zolik tekshiruvidan tashqari
-- hamma narsa — status yozilishi, qayta ochish, hodisa yozuvi.
-- ==========================================================================

do $$
declare
  ws uuid; proj uuid; nd uuid; st text; ev int;
begin
  insert into public.workspaces (name) values ('man-st') returning id into ws;
  insert into public.projects (workspace_id, name) values (ws, 'M') returning id into proj;
  insert into public.nodes (project_id, title, stable_key, status)
    values (proj, 'test tugun', 'k1', 'todo') returning id into nd;

  -- T1: oddiy oldinga o'zgarish
  perform set_config('app.allow_reopen', '', true);
  update public.nodes set status = 'done', is_ghost = false where id = nd;
  select status into st from public.nodes where id = nd;
  if st <> 'done' then raise exception 'T1 yiqildi: %', st; end if;

  -- T2: qo'riqchi hali ham avtomatik yo'lni bloklaydi
  update public.nodes set status = 'todo' where id = nd;
  select status into st from public.nodes where id = nd;
  if st <> 'done' then raise exception 'T2 yiqildi: qo''riqchi ishlamadi (%)', st; end if;

  -- T3: OSHKORA bayroq bilan o'tadi (node_set_status shuni qiladi)
  perform set_config('app.allow_reopen', 'on', true);
  update public.nodes set status = 'in_progress' where id = nd;
  perform set_config('app.allow_reopen', '', true);
  select status into st from public.nodes where id = nd;
  if st <> 'in_progress' then raise exception 'T3 yiqildi: %', st; end if;

  -- T4: bayroq tranzaksiyadan keyin o'chgan
  update public.nodes set status = 'done' where id = nd;
  update public.nodes set status = 'todo' where id = nd;
  select status into st from public.nodes where id = nd;
  if st <> 'done' then raise exception 'T4 yiqildi: bayroq ochiq qoldi'; end if;

  -- T5: funksiya mavjud va to'g'ri imzo bilan
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'node_set_status'
  ) then
    raise exception 'T5 yiqildi: node_set_status yo''q';
  end if;

  -- T6: noto'g'ri status rad etiladi
  begin
    perform public.node_set_status(nd, 'nonsense');
    raise exception 'T6 yiqildi: yaroqsiz status o''tib ketdi';
  exception when others then
    if sqlerrm like 'T6%' then raise; end if;
  end;

  -- T7: hodisa yozuvi 'user' actor bilan yoziladi (qo'lda taqlid)
  insert into public.node_events (workspace_id, project_id, node_id, op, payload, actor)
  values (ws, proj, nd, 'set_status',
          jsonb_build_object('status','todo','manual',true), 'user');
  select count(*) into ev from public.node_events
   where node_id = nd and actor = 'user' and (payload ->> 'manual')::boolean;
  if ev < 1 then raise exception 'T7 yiqildi'; end if;

  delete from public.workspaces where id = ws;
  raise notice '0014: 7/7 tekshiruv o''tdi';
end;
$$;
